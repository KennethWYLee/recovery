import {
  OPERATIONS_ORGANIZATION_ID,
  IdempotencyKeyMismatchError,
  auditInsert,
  executeIdempotentBatch,
  operationsDb,
  operationsEnvironment,
  operationsId,
  operationsNow,
  operationsSha256,
  readIdempotentReplay,
} from "@/db/operations";
import {
  canApproveIncidentCommunication,
  canDraftIncidentCommunication,
  canTransitionIncident,
  cleanOperationsText,
  isCommunicationAudience,
  isDurableHttpsUrl,
  isFinalIncidentCommunication,
  isIncidentRole,
  isIncidentSeverity,
  isIncidentStatus,
  isOrganizationRole,
  isTaskStatus,
  isTimelineEventType,
  normalizeEmail,
  normalizeOperationsId,
  normalizeSlug,
  organizationRoleCanReadAllIncidents,
  organizationRoleCanHoldIncidentRole,
  taskStatusHasRequiredEvidence,
  type IncidentRole,
  type OperationsIncidentStatus,
  type OrganizationRole,
} from "@/lib/operations-domain";
import {
  SCHOOL_SELECTABLE_ORGANIZATION_ROLES,
  actorHasPermission,
  actorPermissions,
  isNtubEmail,
  isSchoolSelectableOrganizationRole,
  organizationRoleCanUseRequestMethod,
  rejectedMutationAudit,
} from "@/lib/operations-auth";
import {
  assertServiceLifecycleCursorSecret,
  decodeServiceLifecycleCursor,
  encodeServiceLifecycleCursor,
  type ServiceLifecycleCursor,
} from "@/lib/service-lifecycle-cursor";
import {
  ApiProblem,
  OPERATIONS_API_VERSION,
  authenticatedContext,
  boundedText,
  emitRejectedMutationAuditFailure,
  idempotencyKey,
  optionalText,
  readJsonObject,
  requiredInteger,
  requiredText,
  requirePermission,
  successResponse,
  type OperationsRequestContext,
} from "./_shared";
import {
  QUALIFIED_INCIDENT_COMMANDER_PROJECTION_SQL,
  assignmentJson,
  communicationJson,
  incidentJson,
  incidentWithAccess,
  reviewJson,
  serviceJson,
  serviceLifecycleEventJson,
  taskJson,
  timelineJson,
  type AssignmentRow,
  type CommunicationRow,
  type IncidentRow,
  type ReviewRow,
  type ServiceRow,
  type ServiceLifecycleEventRow,
  type TaskRow,
  type TimelineRow,
} from "./_data";
import { loadObservabilitySnapshot, OBSERVABILITY_WINDOWS, type ObservabilityWindow } from "@/db/operations-telemetry";

const SERVICE_TIERS = ["tier_1", "tier_2", "tier_3", "tier_4"] as const;
const SERVICE_STATUSES = ["active", "deprecated"] as const;
const ENVIRONMENTS = ["production", "staging", "development", "other"] as const;
const PRIORITIES = ["low", "medium", "high", "critical"] as const;
const ACTIVE_ASSIGNMENT_COMPATIBILITY_SQL = `(
  m.role = 'admin'
  OR (m.role = 'commander' AND a.incident_role IN ('incident_commander', 'communications_lead', 'observer'))
  OR (m.role = 'responder' AND a.incident_role IN ('responder', 'communications_lead', 'service_owner', 'observer'))
  OR (m.role IN ('observer', 'auditor') AND a.incident_role = 'observer')
)`;

export async function dispatchOperationsApi(request: Request, path: string[], requestId: string): Promise<Response> {
  if (path.length === 1 && path[0] === "health" && request.method === "GET") return health(requestId);
  const context = await authenticatedContext(request, requestId);
  try {
    if (path.length === 2 && path[0] === "session" && path[1] === "role") {
      return await schoolSessionRole(context);
    }
    if (!organizationRoleCanUseRequestMethod(context.actor.role, request.method)) {
      throw new ApiProblem(
        403,
        "READ_ONLY_ACCESS",
        "This account can view operations data but cannot create, edit, assign, publish, or delete records.",
        "Access denied",
      );
    }
    // Await each handler inside this try block so asynchronous rejections are
    // recorded by the payload-free denied/failure audit path below.
    if (path.length === 1 && path[0] === "access" && request.method === "GET") return await access(context);
    if (path[0] === "access" && path[1] === "members") return await accessMembers(context, path.slice(2));
    if (path.length === 1 && path[0] === "overview" && request.method === "GET") return await overview(context);
    if (path.length === 1 && path[0] === "observability" && request.method === "GET") return await observability(context);
    if (path[0] === "services") return await services(context, path.slice(1));
    if (path[0] === "incidents") return await incidents(context, path.slice(1));
    if (path.length === 1 && path[0] === "audit" && request.method === "GET") return await audit(context);
    throw new ApiProblem(404, "ROUTE_NOT_FOUND", "The requested API route does not exist.", "Not found");
  } catch (error) {
    const problem = normalizeOperationsApiError(error);
    const rejected = rejectedMutationAudit(request.method, path, problem.code);
    if (rejected) {
      try {
        await context.db.batch([auditInsert(context.db, context.actor, {
          requestId: context.requestId,
          action: rejected.action,
          resourceType: rejected.resourceType,
          resourceId: rejected.resourceId,
          outcome: rejected.outcome,
          reasonCode: problem.code,
          occurredAt: operationsNow(),
          details: { method: request.method.toUpperCase(), route: rejected.route },
        })]);
      } catch {
        // Security audit is best-effort after a rejected transaction. The
        // original RFC 7807 response remains authoritative and is never masked.
        try {
          emitRejectedMutationAuditFailure({
            requestId: context.requestId,
            path,
            method: request.method,
            status: problem.status,
            problemCode: problem.code,
          });
        } catch {
          // Console telemetry is also best-effort and must not mask the request.
        }
      }
    }
    throw problem;
  }
}

async function observability(context: OperationsRequestContext): Promise<Response> {
  requirePermission(context, "observability:read");
  const url = new URL(context.request.url);
  const ranges = url.searchParams.getAll("range");
  if (ranges.length > 1) throw new ApiProblem(400, "INVALID_RANGE", "Provide at most one observability range.");
  const requestedRange = ranges[0] ?? "24h";
  if (!OBSERVABILITY_WINDOWS.includes(requestedRange as ObservabilityWindow)) {
    throw new ApiProblem(400, "INVALID_RANGE", "range must be 24h, 7d, or 30d.");
  }
  return successResponse(
    await loadObservabilitySnapshot(context.db, context.actor.organizationId, requestedRange as ObservabilityWindow),
    context.requestId,
  );
}

async function schoolSessionRole(context: OperationsRequestContext): Promise<Response> {
  if (!isNtubEmail(context.actor.email)) {
    if (context.request.method === "GET") {
      return successResponse({
        selectionRequired: false,
        managedRole: true,
        currentRole: context.actor.role,
        membershipVersion: null,
        options: [],
      }, context.requestId);
    }
    throw new ApiProblem(403, "SCHOOL_ROLE_SELECTION_NOT_AVAILABLE", "This account uses an assigned organization role.", "Access denied");
  }

  const membership = await context.db.prepare(
    `SELECT role, status, version
     FROM ops_memberships
     WHERE id = ? AND organization_id = ? AND user_id = ?`,
  ).bind(context.actor.membershipId, context.actor.organizationId, context.actor.id).first<{
    role: string;
    status: string;
    version: number;
  }>();
  if (!membership || membership.status !== "active" || !isOrganizationRole(membership.role)) {
    throw new ApiProblem(403, "ACTIVE_MEMBERSHIP_REQUIRED", "An active membership is required.", "Access denied");
  }

  if (membership.role === "admin") {
    if (context.request.method === "GET") {
      return successResponse({
        selectionRequired: false,
        managedRole: true,
        currentRole: "admin",
        membershipVersion: membership.version,
        options: [],
      }, context.requestId);
    }
    throw new ApiProblem(403, "ADMIN_ROLE_MANAGED", "Administrator access is assigned by the system and cannot be selected.", "Access denied");
  }

  const activeAssignments = await context.db.prepare(
    `SELECT DISTINCT incident_role
     FROM ops_incident_assignments
     WHERE organization_id = ? AND user_id = ? AND status = 'active'
     ORDER BY incident_role`,
  ).bind(context.actor.organizationId, context.actor.id).all<{ incident_role: string }>();
  const activeIncidentRoles = activeAssignments.results
    .map((assignment) => assignment.incident_role)
    .filter(isIncidentRole);
  const options = SCHOOL_SELECTABLE_ORGANIZATION_ROLES.map((role) => ({
    role,
    available: activeIncidentRoles.every((incidentRole) => organizationRoleCanHoldIncidentRole(role, incidentRole)),
  }));

  if (context.request.method === "GET") {
    return successResponse({
      selectionRequired: true,
      managedRole: false,
      currentRole: membership.role,
      membershipVersion: membership.version,
      options,
    }, context.requestId);
  }
  if (context.request.method !== "POST") {
    throw new ApiProblem(405, "METHOD_NOT_ALLOWED", "Use GET or POST for role selection.");
  }

  const body = await readJsonObject(context.request);
  const key = idempotencyKey(context.request, body);
  const role = body.role;
  const expectedVersion = requiredInteger(body, "expectedVersion");
  if (!isSchoolSelectableOrganizationRole(role)) {
    throw new ApiProblem(400, "INVALID_ROLE_SELECTION", "Select commander, responder, observer, or auditor.");
  }
  const actionScope = `session.role.select:${context.actor.membershipId}`;
  const replay = await readIdempotentReplay<{
    selectedRole: OrganizationRole;
    membershipVersion: number;
  }>({
    db: context.db,
    actor: context.actor,
    actionScope,
    idempotencyKey: key,
    requestPayload: body,
    now: operationsNow(),
  });
  if (replay) return successResponse({ ...replay, replayed: true }, context.requestId);
  if (expectedVersion !== membership.version) {
    throw new ApiProblem(409, "VERSION_CONFLICT", "The membership changed. Reload the role selection before continuing.", "Conflict");
  }
  const selectedOption = options.find((option) => option.role === role);
  if (!selectedOption?.available) {
    throw new ApiProblem(
      409,
      "INCIDENT_ROLE_INCOMPATIBLE",
      "Hand off or revoke incompatible active incident responsibilities before selecting this role.",
      "Conflict",
    );
  }

  const now = operationsNow();
  const nextVersion = expectedVersion + 1;
  const guardId = operationsId("guard");
  const result = await executeIdempotentBatch({
    db: context.db,
    actor: context.actor,
    actionScope,
    idempotencyKey: key,
    requestPayload: body,
    responseData: { selectedRole: role, membershipVersion: nextVersion },
    now,
    statements: [
      context.db.prepare(
        `INSERT INTO ops_write_guards (id, passed, created_at)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM ops_memberships
           WHERE id = ? AND organization_id = ? AND user_id = ?
             AND status = 'active' AND role <> 'admin' AND version = ?
         ) THEN 1 ELSE 0 END, ?`,
      ).bind(
        guardId,
        context.actor.membershipId,
        context.actor.organizationId,
        context.actor.id,
        expectedVersion,
        now,
      ),
      context.db.prepare(
        `UPDATE ops_memberships
         SET role = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND organization_id = ? AND user_id = ?
           AND status = 'active' AND role <> 'admin' AND version = ?`,
      ).bind(
        role,
        now,
        context.actor.membershipId,
        context.actor.organizationId,
        context.actor.id,
        expectedVersion,
      ),
      auditInsert(context.db, context.actor, {
        requestId: context.requestId,
        action: "access.self_role.select",
        resourceType: "membership",
        resourceId: context.actor.membershipId,
        occurredAt: now,
        details: { fromRole: membership.role, selectedRole: role, fromVersion: expectedVersion, toVersion: nextVersion },
      }),
      context.db.prepare("DELETE FROM ops_write_guards WHERE id = ?").bind(guardId),
    ],
  });
  return successResponse({ ...result.data, replayed: result.replayed }, context.requestId);
}

async function health(requestId: string): Promise<Response> {
  try {
    const row = await operationsDb().prepare(
      "SELECT id FROM ops_organizations WHERE id = ? AND status = 'active'",
    ).bind(OPERATIONS_ORGANIZATION_ID).first<{ id: string }>();
    if (!row) throw new Error("organization unavailable");
    return successResponse({ status: "ok", database: "ok", version: OPERATIONS_API_VERSION }, requestId);
  } catch {
    throw new ApiProblem(503, "DATABASE_NOT_READY", "The operations database is not ready.", "Service unavailable");
  }
}

function access(context: OperationsRequestContext): Response {
  const schoolIdentity = isNtubEmail(context.actor.email);
  return successResponse({
    actor: {
      id: context.actor.id,
      email: context.actor.email,
      displayName: context.actor.displayName,
      role: context.actor.role,
    },
    organization: { id: context.actor.organizationId, name: context.actor.organizationName, timezone: context.actor.organizationTimeZone },
    permissions: [...actorPermissions(context.actor)],
    policies: [
      {
        id: "verified-identity",
        name: "已驗證身分",
        description: "登入信箱由平台身分邊界提供；用戶端不能自行指定操作者。",
        status: "enforced",
      },
      {
        id: schoolIdentity ? "ntub-role-selection" : "assigned-organization-role",
        name: schoolIdentity ? "校內角色選擇" : "組織角色授權",
        description: schoolIdentity
          ? context.actor.role === "admin"
            ? "系統管理員由系統指派，不列入校內帳號的角色選項。"
            : "本次操作權限依登入時選擇的角色決定；所有操作仍由伺服器驗證。"
          : "本帳號的組織角色由既有會員資格或部署設定決定。",
        status: "enforced",
      },
      {
        id: "server-side-authorization",
        name: "伺服器端授權",
        description: "所有寫入要求都會在伺服器重新檢查身分、角色與資料狀態。",
        status: "enforced",
      },
    ],
  }, context.requestId);
}

async function accessMembers(context: OperationsRequestContext, rest: string[]): Promise<Response> {
  if (rest.length === 0 && context.request.method === "GET") {
    if (!actorHasPermission(context.actor, "access:manage") && !actorHasPermission(context.actor, "incident:assign")) {
      throw new ApiProblem(403, "PERMISSION_DENIED", "The access:manage or incident:assign permission is required.", "Access denied");
    }
    const rows = await context.db.prepare(
      `SELECT m.id, m.user_id, u.email, u.display_name, u.last_seen_at,
              m.role, m.status, m.version, m.created_at, m.updated_at
       FROM ops_memberships m JOIN ops_users u ON u.id = m.user_id
       WHERE m.organization_id = ? ORDER BY u.display_name, u.email`,
    ).bind(context.actor.organizationId).all<Record<string, unknown>>();
    return successResponse({ members: rows.results.map(memberJson) }, context.requestId);
  }
  if (rest.length === 0 && context.request.method === "POST") {
    requirePermission(context, "access:manage");
    const body = await readJsonObject(context.request);
    const key = idempotencyKey(context.request, body);
    const email = normalizeEmail(body.email);
    if (!email) throw new ApiProblem(400, "INVALID_EMAIL", "email must be a valid address.");
    const displayName = boundedText(body.displayName, "displayName", 120) || email;
    if (!isOrganizationRole(body.role)) throw new ApiProblem(400, "INVALID_ROLE", "role is not supported.");
    const now = operationsNow();
    const userId = `usr-${(await operationsSha256(email)).slice(0, 24)}`;
    const membershipId = operationsId("mem");
    const response = {
      member: {
        id: membershipId, userId, email, displayName, role: body.role, status: "active",
        version: 1, lastSeenAt: now, createdAt: now, updatedAt: now,
      },
    };
    const result = await executeIdempotentBatch({
      db: context.db,
      actor: context.actor,
      actionScope: "access.members.create",
      idempotencyKey: key,
      requestPayload: body,
      responseData: response,
      now,
      statements: [
        context.db.prepare(
          `INSERT OR IGNORE INTO ops_users
            (id, email, display_name, identity_source, status, created_at, last_seen_at)
           VALUES (?, ?, ?, 'invited', 'active', ?, ?)`,
        ).bind(userId, email, displayName, now, now),
        context.db.prepare(
          `INSERT INTO ops_memberships
            (id, organization_id, user_id, role, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
        ).bind(membershipId, context.actor.organizationId, userId, body.role, now, now),
        auditInsert(context.db, context.actor, {
          requestId: context.requestId, action: "access.member.create", resourceType: "membership",
          resourceId: membershipId, occurredAt: now, details: { userId, role: body.role },
        }),
      ],
    });
    return successResponse({ ...result.data, replayed: result.replayed }, context.requestId, result.replayed ? 200 : 201);
  }
  if (rest.length === 1 && context.request.method === "PATCH") {
    requirePermission(context, "access:manage");
    const membershipId = normalizeOperationsId(rest[0]);
    if (!membershipId) throw new ApiProblem(400, "INVALID_MEMBERSHIP_ID", "The membership ID is invalid.");
    const body = await readJsonObject(context.request);
    const key = idempotencyKey(context.request, body);
    const expectedVersion = requiredInteger(body, "expectedVersion");
    const actionScope = `access.members.update:${membershipId}`;
    const replay = await readIdempotentReplay<{ member: ReturnType<typeof memberJson> }>({
      db: context.db,
      actor: context.actor,
      actionScope,
      idempotencyKey: key,
      requestPayload: body,
      now: operationsNow(),
    });
    if (replay) return successResponse({ ...replay, replayed: true }, context.requestId);
    const existing = await context.db.prepare(
      `SELECT m.id, m.user_id, u.email, u.display_name, u.last_seen_at,
              m.role, m.status, m.version, m.created_at, m.updated_at
       FROM ops_memberships m JOIN ops_users u ON u.id = m.user_id
       WHERE m.id = ? AND m.organization_id = ?`,
    ).bind(membershipId, context.actor.organizationId).first<Record<string, unknown>>();
    if (!existing) throw new ApiProblem(404, "MEMBERSHIP_NOT_FOUND", "The membership does not exist.", "Not found");
    const role = body.role === undefined ? String(existing.role) : body.role;
    const status = body.status === undefined ? String(existing.status) : body.status;
    if (!isOrganizationRole(role) || !["active", "suspended"].includes(String(status))) {
      throw new ApiProblem(400, "INVALID_MEMBERSHIP_UPDATE", "Provide a supported role and status.");
    }
    if (["admin", "commander"].includes(String(existing.role)) && existing.status === "active"
      && (status !== "active" || !["admin", "commander"].includes(String(role)))) {
      const incidentNeedingHandoff = await context.db.prepare(
        `SELECT a.incident_id FROM ops_incident_assignments a
         JOIN ops_incidents i ON i.id = a.incident_id
         WHERE a.organization_id = ? AND a.user_id = ?
           AND a.incident_role = 'incident_commander' AND a.status = 'active'
           AND i.status NOT IN ('closed', 'cancelled')
           AND NOT EXISTS (
             SELECT 1 FROM ops_incident_assignments other
             JOIN ops_memberships other_m
               ON other_m.organization_id = other.organization_id AND other_m.user_id = other.user_id
             JOIN ops_users other_u ON other_u.id = other.user_id
             WHERE other.incident_id = a.incident_id AND other.id <> a.id
               AND other.incident_role = 'incident_commander' AND other.status = 'active'
               AND other_m.status = 'active' AND other_m.role IN ('admin', 'commander')
               AND other_u.status = 'active'
           )
         LIMIT 1`,
      ).bind(context.actor.organizationId, existing.user_id).first<{ incident_id: string }>();
      if (incidentNeedingHandoff) {
        throw new ApiProblem(
          409,
          "ACTIVE_INCIDENT_HANDOFF_REQUIRED",
          "Transfer command of every active incident before changing this member's access.",
          "Conflict",
        );
      }
    }
    if (existing.role === "admin" && (role !== "admin" || status !== "active")) {
      const count = await context.db.prepare(
        "SELECT COUNT(*) AS count FROM ops_memberships WHERE organization_id = ? AND role = 'admin' AND status = 'active'",
      ).bind(context.actor.organizationId).first<{ count: number }>();
      if (Number(count?.count ?? 0) <= 1) throw new ApiProblem(409, "LAST_ADMIN_REQUIRED", "The final active administrator cannot be removed.");
    }
    const activeAssignments = await context.db.prepare(
      `SELECT incident_role FROM ops_incident_assignments
       WHERE organization_id = ? AND user_id = ? AND status = 'active'`,
    ).bind(context.actor.organizationId, existing.user_id).all<{ incident_role: string }>();
    const hasIncompatibleAssignment = activeAssignments.results.some((assignment) => (
      status !== "active"
      || !isIncidentRole(assignment.incident_role)
      || !organizationRoleCanHoldIncidentRole(role, assignment.incident_role)
    ));
    if (hasIncompatibleAssignment) {
      throw new ApiProblem(
        409,
        "INCIDENT_ROLE_INCOMPATIBLE",
        "Revoke or hand off incompatible active incident assignments before changing this member's access.",
        "Conflict",
      );
    }
    const now = operationsNow();
    const response = {
      member: {
        id: membershipId, userId: existing.user_id, email: existing.email, displayName: existing.display_name,
        role, status, version: expectedVersion + 1, lastSeenAt: existing.last_seen_at,
        createdAt: existing.created_at, updatedAt: now,
      },
    };
    const guardId = operationsId("guard");
    const result = await executeIdempotentBatch({
      db: context.db, actor: context.actor, actionScope,
      idempotencyKey: key, requestPayload: body, responseData: response, now,
      statements: [
        context.db.prepare(
           `INSERT INTO ops_write_guards (id, passed, created_at)
            SELECT ?, CASE WHEN EXISTS (
              SELECT 1 FROM ops_memberships WHERE id = ? AND organization_id = ? AND version = ?
            ) THEN 1 ELSE 0 END, ?`,
        ).bind(guardId, membershipId, context.actor.organizationId, expectedVersion, now),
        context.db.prepare(
          "UPDATE ops_memberships SET role = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ? AND organization_id = ? AND version = ?",
        ).bind(role, status, now, membershipId, context.actor.organizationId, expectedVersion),
        auditInsert(context.db, context.actor, {
          requestId: context.requestId, action: "access.member.update", resourceType: "membership",
          resourceId: membershipId, occurredAt: now,
          details: { role, status, fromVersion: expectedVersion, toVersion: expectedVersion + 1 },
        }),
        context.db.prepare("DELETE FROM ops_write_guards WHERE id = ?").bind(guardId),
      ],
    });
    return successResponse({ ...result.data, replayed: result.replayed }, context.requestId);
  }
  throw new ApiProblem(404, "ROUTE_NOT_FOUND", "The requested access route does not exist.", "Not found");
}

async function overview(context: OperationsRequestContext): Promise<Response> {
  requirePermission(context, "incident:read");
  const unrestricted = organizationRoleCanReadAllIncidents(context.actor.role);
  const accessClause = unrestricted ? "" : "AND EXISTS (SELECT 1 FROM ops_incident_assignments a WHERE a.incident_id = i.id AND a.user_id = ? AND a.status = 'active')";
  const incidentBindings: unknown[] = [context.actor.organizationId];
  if (!unrestricted) incidentBindings.push(context.actor.id);
  const [counts, recent, serviceHealth, overdue] = await Promise.all([
    context.db.prepare(
      `SELECT
         SUM(CASE WHEN i.status NOT IN ('closed','cancelled') THEN 1 ELSE 0 END) AS open_incidents,
         SUM(CASE WHEN i.status NOT IN ('closed','cancelled') AND i.severity = 'sev1' THEN 1 ELSE 0 END) AS critical_incidents,
          SUM(CASE WHEN i.status NOT IN ('closed','cancelled') AND NOT EXISTS (
            SELECT 1 FROM ops_incident_assignments ca
            JOIN ops_memberships cm
              ON cm.organization_id = ca.organization_id AND cm.user_id = ca.user_id
            JOIN ops_users cu ON cu.id = ca.user_id
            WHERE ca.incident_id = i.id
              AND ca.incident_role = 'incident_commander'
              AND ca.status = 'active'
              AND cm.status = 'active'
              AND cm.role IN ('admin', 'commander')
              AND cu.status = 'active'
         ) THEN 1 ELSE 0 END) AS unassigned_incidents,
         ROUND(AVG(CASE
           WHEN i.acknowledged_at IS NOT NULL AND julianday(i.acknowledged_at) >= julianday(i.declared_at)
           THEN (julianday(i.acknowledged_at) - julianday(i.declared_at)) * 1440.0
         END), 1) AS mean_time_to_acknowledge_minutes,
         ROUND(AVG(CASE
           WHEN i.resolved_at IS NOT NULL AND julianday(i.resolved_at) >= julianday(i.declared_at)
           THEN (julianday(i.resolved_at) - julianday(i.declared_at)) * 1440.0
         END), 1) AS mean_time_to_restore_minutes,
         SUM(CASE WHEN i.acknowledged_at IS NOT NULL AND julianday(i.acknowledged_at) >= julianday(i.declared_at) THEN 1 ELSE 0 END) AS acknowledge_sample_size,
         SUM(CASE WHEN i.resolved_at IS NOT NULL AND julianday(i.resolved_at) >= julianday(i.declared_at) THEN 1 ELSE 0 END) AS restore_sample_size
       FROM ops_incidents i WHERE i.organization_id = ? ${accessClause}`,
    ).bind(...incidentBindings).first<{
      open_incidents: number | null;
      critical_incidents: number | null;
      unassigned_incidents: number | null;
      mean_time_to_acknowledge_minutes: number | null;
      mean_time_to_restore_minutes: number | null;
      acknowledge_sample_size: number | null;
      restore_sample_size: number | null;
    }>(),
    context.db.prepare(
      `SELECT i.*, s.name AS service_name,
              ${QUALIFIED_INCIDENT_COMMANDER_PROJECTION_SQL}
       FROM ops_incidents i JOIN ops_services s ON s.id = i.service_id
       WHERE i.organization_id = ? ${accessClause} ORDER BY i.updated_at DESC LIMIT 10`,
    ).bind(...incidentBindings).all<IncidentRow>(),
    context.db.prepare(
      `SELECT s.id, s.name, s.slo_target,
              SUM(CASE WHEN i.status NOT IN ('closed','cancelled') THEN 1 ELSE 0 END) AS active_count,
              MIN(CASE WHEN i.status NOT IN ('closed','cancelled') THEN
                CASE i.severity WHEN 'sev1' THEN 1 WHEN 'sev2' THEN 2 WHEN 'sev3' THEN 3 ELSE 4 END
              ELSE NULL END) AS severity_rank
       FROM ops_services s LEFT JOIN ops_incidents i ON i.service_id = s.id
       WHERE s.organization_id = ? AND s.status = 'active'
       GROUP BY s.id, s.name, s.slo_target ORDER BY severity_rank, s.name`,
    ).bind(context.actor.organizationId).all<{ id: string; name: string; slo_target: number; active_count: number; severity_rank: number | null }>(),
    context.db.prepare(
      `SELECT COUNT(*) AS count FROM ops_incident_tasks t JOIN ops_incidents i ON i.id = t.incident_id
       WHERE t.organization_id = ? AND t.status NOT IN ('completed','cancelled') AND t.due_at IS NOT NULL AND t.due_at < ?
       ${unrestricted ? "" : "AND EXISTS (SELECT 1 FROM ops_incident_assignments a WHERE a.incident_id = i.id AND a.user_id = ? AND a.status = 'active')"}`,
    ).bind(context.actor.organizationId, operationsNow(), ...(!unrestricted ? [context.actor.id] : [])).first<{ count: number }>(),
  ]);
  const serviceCount = await context.db.prepare(
    "SELECT COUNT(*) AS count FROM ops_services WHERE organization_id = ? AND status = 'active'",
  ).bind(context.actor.organizationId).first<{ count: number }>();
  const recentAuditEvents = actorHasPermission(context.actor, "audit:read")
    ? (await context.db.prepare(
      `SELECT a.id, a.actor_user_id, u.display_name AS actor_name, a.actor_role, a.action,
              a.resource_type, a.resource_id, a.outcome, a.reason_code, a.request_id, a.occurred_at
       FROM ops_audit_events a JOIN ops_users u ON u.id = a.actor_user_id
       WHERE a.organization_id = ? ORDER BY a.occurred_at DESC, a.id DESC LIMIT 8`,
    ).bind(context.actor.organizationId).all<Record<string, unknown>>()).results.map((row) => ({
      id: row.id,
      actorUserId: row.actor_user_id,
      actorName: row.actor_name,
      actorRole: row.actor_role,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      outcome: row.outcome,
      reasonCode: row.reason_code,
      requestId: row.request_id,
      occurredAt: row.occurred_at,
    }))
    : [];
  return successResponse({
    counts: {
      openIncidents: Number(counts?.open_incidents ?? 0),
      criticalIncidents: Number(counts?.critical_incidents ?? 0),
      unassignedIncidents: Number(counts?.unassigned_incidents ?? 0),
      services: Number(serviceCount?.count ?? 0),
      overdueTasks: Number(overdue?.count ?? 0),
    },
    reliabilityMetrics: {
      meanTimeToAcknowledgeMinutes: counts?.mean_time_to_acknowledge_minutes == null
        ? null
        : Number(counts.mean_time_to_acknowledge_minutes),
      meanTimeToRestoreMinutes: counts?.mean_time_to_restore_minutes == null
        ? null
        : Number(counts.mean_time_to_restore_minutes),
      acknowledgeSampleSize: Number(counts?.acknowledge_sample_size ?? 0),
      restoreSampleSize: Number(counts?.restore_sample_size ?? 0),
      population: "Incidents visible to the current actor in this organization.",
      exclusions: {
        meanTimeToAcknowledgeMinutes: "Incidents without a valid acknowledgedAt timestamp are excluded.",
        meanTimeToRestoreMinutes: "Unresolved, cancelled, or timestamp-invalid incidents are excluded; resolvedAt is the restoration endpoint.",
      },
    },
    recentIncidents: recent.results.map(incidentJson),
    serviceHealth: serviceHealth.results.map((row) => ({
      serviceId: row.id,
      name: row.name,
      operationalStatus: "unknown",
      telemetryStatus: "unavailable",
      sampleSize: 0,
      activeIncidentCount: Number(row.active_count ?? 0),
      highestSeverity: row.severity_rank ? `sev${row.severity_rank}` : null,
      sloTarget: Number(row.slo_target),
      sloAttainment: null,
    })),
    recentAuditEvents,
  }, context.requestId);
}

async function services(context: OperationsRequestContext, rest: string[]): Promise<Response> {
  requirePermission(context, "service:read");
  if (rest.length === 0 && context.request.method === "GET") {
    const rows = await context.db.prepare(
      `SELECT s.*, u.display_name AS owner_name, status_actor.display_name AS status_changed_by_name
       FROM ops_services s
       LEFT JOIN ops_users u ON u.id = s.owner_user_id
       LEFT JOIN ops_users status_actor ON status_actor.id = s.status_changed_by_user_id
       WHERE s.organization_id = ? ORDER BY s.tier, s.name`,
    ).bind(context.actor.organizationId).all<ServiceRow>();
    return successResponse({ services: rows.results.map(serviceJson) }, context.requestId);
  }
  if (rest.length === 2 && rest[1] === "lifecycle-events" && context.request.method === "GET") {
    const serviceId = normalizeOperationsId(rest[0]);
    const service = await context.db.prepare(
      "SELECT id FROM ops_services WHERE id = ? AND organization_id = ?",
    ).bind(serviceId, context.actor.organizationId).first<{ id: string }>();
    if (!service) throw new ApiProblem(404, "SERVICE_NOT_FOUND", "The service does not exist.", "Not found");

    const limit = 25;
    const cursorContext = { serviceId, organizationId: context.actor.organizationId };
    const cursorSecret = operationsEnvironment().CONTINUITY_OPS_CURSOR_HMAC_SECRET;
    try {
      assertServiceLifecycleCursorSecret(cursorSecret);
    } catch {
      throw new ApiProblem(
        503,
        "CURSOR_SIGNING_UNAVAILABLE",
        "Lifecycle history pagination is temporarily unavailable.",
        "Service unavailable",
      );
    }
    const cursorValues = new URL(context.request.url).searchParams.getAll("cursor");
    if (cursorValues.length > 1) {
      throw new ApiProblem(400, "INVALID_LIFECYCLE_CURSOR", "Provide at most one lifecycle cursor.");
    }
    let cursor: ServiceLifecycleCursor | null = null;
    if (cursorValues.length === 1) {
      try {
        cursor = await decodeServiceLifecycleCursor(cursorValues[0], cursorContext, cursorSecret);
      } catch {
        throw new ApiProblem(400, "INVALID_LIFECYCLE_CURSOR", "The lifecycle cursor is invalid.");
      }
    }
    const rows = await context.db.prepare(
      `SELECT e.*, u.display_name AS changed_by_name
       FROM ops_service_lifecycle_events e
       LEFT JOIN ops_users u ON u.id = e.changed_by_user_id
       WHERE e.service_id = ? AND e.organization_id = ?
         AND (? IS NULL OR e.changed_at < ? OR (e.changed_at = ? AND e.id < ?))
       ORDER BY e.changed_at DESC, e.id DESC
       LIMIT ?`,
    ).bind(
      serviceId,
      context.actor.organizationId,
      cursor?.changedAt ?? null,
      cursor?.changedAt ?? null,
      cursor?.changedAt ?? null,
      cursor?.id ?? null,
      limit + 1,
    ).all<ServiceLifecycleEventRow>();
    const page = rows.results.slice(0, limit);
    const hasMore = rows.results.length > limit;
    const boundary = page.at(-1);
    return successResponse({
      events: page.map(serviceLifecycleEventJson),
      limit,
      hasMore,
      nextCursor: hasMore && boundary
        ? await encodeServiceLifecycleCursor(
          { changedAt: boundary.changed_at, id: boundary.id },
          cursorContext,
          cursorSecret,
        )
        : null,
    }, context.requestId);
  }
  if (rest.length === 1 && context.request.method === "GET") {
    const serviceId = normalizeOperationsId(rest[0]);
    const row = await context.db.prepare(
      `SELECT s.*, u.display_name AS owner_name, status_actor.display_name AS status_changed_by_name
       FROM ops_services s LEFT JOIN ops_users u ON u.id = s.owner_user_id
       LEFT JOIN ops_users status_actor ON status_actor.id = s.status_changed_by_user_id
       WHERE s.id = ? AND s.organization_id = ?`,
    ).bind(serviceId, context.actor.organizationId).first<ServiceRow>();
    if (!row) throw new ApiProblem(404, "SERVICE_NOT_FOUND", "The service does not exist.", "Not found");
    return successResponse({ service: serviceJson(row) }, context.requestId);
  }
  if (rest.length === 1 && context.request.method === "PATCH") {
    requirePermission(context, "service:write");
    const serviceId = normalizeOperationsId(rest[0]);
    if (!serviceId) throw new ApiProblem(400, "INVALID_SERVICE_ID", "The service ID is invalid.");
    const body = await readJsonObject(context.request);
    const key = idempotencyKey(context.request, body);
    const now = operationsNow();
    const actionScope = `services.update:${serviceId}`;
    const replay = await readIdempotentReplay<{ service: ReturnType<typeof serviceJson> }>({
      db: context.db,
      actor: context.actor,
      actionScope,
      idempotencyKey: key,
      requestPayload: body,
      now,
    });
    if (replay) return successResponse({ ...replay, replayed: true }, context.requestId);
    if (body.slug !== undefined) {
      throw new ApiProblem(400, "SERVICE_SLUG_IMMUTABLE", "A service slug cannot be changed after creation.");
    }
    const service = await context.db.prepare(
      `SELECT s.*, u.display_name AS owner_name, status_actor.display_name AS status_changed_by_name
       FROM ops_services s
       LEFT JOIN ops_users u ON u.id = s.owner_user_id
       LEFT JOIN ops_users status_actor ON status_actor.id = s.status_changed_by_user_id
       WHERE s.id = ? AND s.organization_id = ?`,
    ).bind(serviceId, context.actor.organizationId).first<ServiceRow>();
    if (!service) throw new ApiProblem(404, "SERVICE_NOT_FOUND", "The service does not exist.", "Not found");
    const expectedVersion = requiredInteger(body, "expectedVersion");
    if (expectedVersion !== Number(service.version)) {
      throw new ApiProblem(409, "VERSION_CONFLICT", "The service changed. Reload it and retry with the current version.", "Conflict");
    }
    const changed = ["name", "description", "tier", "ownerEmail", "ownerTeam", "sloTarget", "runbookUrl", "status"]
      .filter((field) => body[field] !== undefined);
    if (changed.length === 0 && body.statusChangeReason === undefined) {
      throw new ApiProblem(400, "NO_CHANGES", "Provide at least one service field to update.");
    }
    const name = body.name === undefined ? service.name : requiredText(body, "name", 2, 100);
    if (body.description !== undefined && typeof body.description !== "string") {
      throw new ApiProblem(400, "INVALID_FIELD", "description must be text.");
    }
    const description = body.description === undefined ? service.description : optionalText(body, "description", 600);
    const tier = body.tier === undefined ? service.tier : body.tier;
    if (!SERVICE_TIERS.includes(tier as (typeof SERVICE_TIERS)[number])) {
      throw new ApiProblem(400, "INVALID_TIER", "tier is not supported.");
    }
    let ownerUserId = service.owner_user_id;
    let ownerName = service.owner_name ?? null;
    if (body.ownerEmail !== undefined) {
      if (body.ownerEmail === null) {
        ownerUserId = null;
        ownerName = null;
      } else {
        const ownerEmail = normalizeEmail(body.ownerEmail);
        if (!ownerEmail) throw new ApiProblem(400, "INVALID_EMAIL", "ownerEmail must be a valid address or null.");
        const owner = await context.db.prepare(
          `SELECT u.id, u.display_name FROM ops_users u JOIN ops_memberships m ON m.user_id = u.id
           WHERE u.email = ? AND m.organization_id = ? AND u.status = 'active' AND m.status = 'active'`,
        ).bind(ownerEmail, context.actor.organizationId).first<{ id: string; display_name: string }>();
        if (!owner) throw new ApiProblem(400, "OWNER_NOT_ACTIVE_MEMBER", "ownerEmail must identify an active member.");
        ownerUserId = owner.id;
        ownerName = owner.display_name;
      }
    }
    if (body.ownerTeam !== undefined && typeof body.ownerTeam !== "string") {
      throw new ApiProblem(400, "INVALID_FIELD", "ownerTeam must be text.");
    }
    const ownerTeam = body.ownerTeam === undefined ? service.owner_team : optionalText(body, "ownerTeam", 120);
    const sloTarget = body.sloTarget === undefined ? Number(service.slo_target) : Number(body.sloTarget);
    if (!Number.isFinite(sloTarget) || sloTarget <= 0 || sloTarget > 100) {
      throw new ApiProblem(400, "INVALID_SLO_TARGET", "sloTarget must be greater than 0 and at most 100.");
    }
    const runbookUrl = body.runbookUrl === undefined
      ? service.runbook_url
      : optionalHttpsUrl(body.runbookUrl, "runbookUrl");
    const status = body.status === undefined ? service.status : body.status;
    if (!SERVICE_STATUSES.includes(status as (typeof SERVICE_STATUSES)[number])) {
      throw new ApiProblem(400, "INVALID_SERVICE_STATUS", "status is not supported.");
    }
    const statusChanged = status !== service.status;
    if (!statusChanged && body.statusChangeReason !== undefined) {
      throw new ApiProblem(
        400,
        "SERVICE_STATUS_CHANGE_REASON_NOT_APPLICABLE",
        "statusChangeReason is accepted only when the service lifecycle status changes.",
      );
    }
    if (!statusChanged && body.lifecycleConfirmed !== undefined) {
      throw new ApiProblem(
        400,
        "SERVICE_STATUS_CHANGE_CONFIRMATION_NOT_APPLICABLE",
        "lifecycleConfirmed is accepted only when the service lifecycle status changes.",
      );
    }
    if (statusChanged && body.statusChangeReason === undefined) {
      throw new ApiProblem(
        400,
        "SERVICE_STATUS_CHANGE_REASON_REQUIRED",
        "Explain the operational reason for changing the service lifecycle status.",
      );
    }
    if (statusChanged && body.lifecycleConfirmed !== true) {
      throw new ApiProblem(
        400,
        "SERVICE_STATUS_CHANGE_CONFIRMATION_REQUIRED",
        "Confirm the lifecycle impact before changing the service status.",
      );
    }
    const statusChangeReason = statusChanged
      ? requiredServiceStatusChangeReason(body.statusChangeReason)
      : service.status_change_reason ?? null;
    const statusChangedAt = statusChanged ? now : service.status_changed_at ?? null;
    const statusChangedByUserId = statusChanged ? context.actor.id : service.status_changed_by_user_id ?? null;
    const statusChangedByName = statusChanged ? context.actor.displayName : service.status_changed_by_name ?? null;
    const statusChangeRequestId = statusChanged ? context.requestId : service.status_change_request_id ?? null;
    const updated: ServiceRow = {
      ...service,
      name,
      description,
      tier: String(tier),
      owner_user_id: ownerUserId,
      owner_name: ownerName,
      owner_team: ownerTeam,
      slo_target: sloTarget,
      runbook_url: runbookUrl,
      status: String(status),
      status_change_reason: statusChangeReason,
      status_changed_at: statusChangedAt,
      status_changed_by_user_id: statusChangedByUserId,
      status_changed_by_name: statusChangedByName,
      status_change_request_id: statusChangeRequestId,
      version: expectedVersion + 1,
      updated_at: now,
    };
    const guardId = operationsId("guard");
    const result = await executeIdempotentBatch({
      db: context.db,
      actor: context.actor,
      actionScope,
      idempotencyKey: key,
      requestPayload: body,
      responseData: { service: serviceJson(updated) },
      now,
      statements: [
        context.db.prepare(
          `INSERT INTO ops_write_guards (id, passed, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM ops_services WHERE id = ? AND organization_id = ? AND version = ?
           ) THEN 1 ELSE 0 END, ?`,
        ).bind(guardId, serviceId, context.actor.organizationId, expectedVersion, now),
        context.db.prepare(
          `UPDATE ops_services SET name = ?, description = ?, tier = ?, owner_user_id = ?, owner_team = ?,
             slo_target = ?, runbook_url = ?, status = ?, status_change_reason = ?, status_changed_at = ?,
             status_changed_by_user_id = ?, status_change_request_id = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND organization_id = ? AND version = ?`,
        ).bind(name, description, tier, ownerUserId, ownerTeam, sloTarget, runbookUrl, status,
          statusChangeReason, statusChangedAt, statusChangedByUserId, statusChangeRequestId, now,
          serviceId, context.actor.organizationId, expectedVersion),
        auditInsert(context.db, context.actor, {
          requestId: context.requestId,
          action: "service.update",
          resourceType: "service",
          resourceId: serviceId,
          occurredAt: now,
          details: {
            fields: changed,
            fromVersion: expectedVersion,
            toVersion: expectedVersion + 1,
            ...(statusChanged ? {
              fromStatus: service.status,
              toStatus: status,
              statusChangeReasonRecorded: true,
              lifecycleConfirmationRecorded: true,
            } : {}),
          },
        }),
        context.db.prepare("DELETE FROM ops_write_guards WHERE id = ?").bind(guardId),
      ],
    });
    return successResponse({ ...result.data, replayed: result.replayed }, context.requestId);
  }
  if (rest.length === 0 && context.request.method === "POST") {
    requirePermission(context, "service:write");
    const body = await readJsonObject(context.request);
    const key = idempotencyKey(context.request, body);
    const name = requiredText(body, "name", 2, 100);
    const slug = normalizeSlug(body.slug ?? name);
    if (!slug) throw new ApiProblem(400, "INVALID_SLUG", "slug must contain 3-64 lowercase letters, numbers, or hyphens.");
    const description = optionalText(body, "description", 600);
    const tier = typeof body.tier === "string" ? body.tier : "tier_2";
    if (!SERVICE_TIERS.includes(tier as (typeof SERVICE_TIERS)[number])) throw new ApiProblem(400, "INVALID_TIER", "tier is not supported.");
    const ownerEmail = body.ownerEmail ? normalizeEmail(body.ownerEmail) : "";
    let ownerUserId: string | null = null;
    let ownerName: string | null = null;
    if (ownerEmail) {
      const owner = await context.db.prepare(
        `SELECT u.id, u.display_name FROM ops_users u JOIN ops_memberships m ON m.user_id = u.id
         WHERE u.email = ? AND m.organization_id = ? AND u.status = 'active' AND m.status = 'active'`,
      ).bind(ownerEmail, context.actor.organizationId).first<{ id: string; display_name: string }>();
      if (!owner) throw new ApiProblem(400, "OWNER_NOT_ACTIVE_MEMBER", "ownerEmail must identify an active member.");
      ownerUserId = owner.id;
      ownerName = owner.display_name;
    }
    const ownerTeam = optionalText(body, "ownerTeam", 120);
    const sloTarget = body.sloTarget === undefined ? 99.9 : Number(body.sloTarget);
    if (!Number.isFinite(sloTarget) || sloTarget <= 0 || sloTarget > 100) throw new ApiProblem(400, "INVALID_SLO_TARGET", "sloTarget must be greater than 0 and at most 100.");
    const runbookUrl = optionalHttpsUrl(body.runbookUrl, "runbookUrl");
    const now = operationsNow();
    const serviceId = operationsId("svc");
    const row: ServiceRow = {
      id: serviceId, name, slug, description, tier, owner_user_id: ownerUserId, owner_name: ownerName,
      owner_team: ownerTeam, slo_target: sloTarget, runbook_url: runbookUrl,
      status: "active", status_change_reason: null, status_changed_at: null,
      status_changed_by_user_id: null, status_changed_by_name: null,
      status_change_request_id: null,
      version: 1, created_at: now, updated_at: now,
    };
    const result = await executeIdempotentBatch({
      db: context.db, actor: context.actor, actionScope: "services.create", idempotencyKey: key,
      requestPayload: body, responseData: { service: serviceJson(row) }, now,
      statements: [
        context.db.prepare(
          `INSERT INTO ops_services
            (id, organization_id, name, slug, description, tier, owner_user_id, owner_team,
             slo_target, runbook_url, status, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
        ).bind(serviceId, context.actor.organizationId, name, slug, description, tier, ownerUserId, ownerTeam, sloTarget, runbookUrl, now, now),
        auditInsert(context.db, context.actor, {
          requestId: context.requestId, action: "service.create", resourceType: "service", resourceId: serviceId,
          occurredAt: now, details: { slug, tier, sloTarget },
        }),
      ],
    });
    return successResponse({ ...result.data, replayed: result.replayed }, context.requestId, result.replayed ? 200 : 201);
  }
  throw new ApiProblem(404, "ROUTE_NOT_FOUND", "The requested service route does not exist.", "Not found");
}

async function incidents(context: OperationsRequestContext, rest: string[]): Promise<Response> {
  requirePermission(context, "incident:read");
  if (rest.length === 0 && context.request.method === "GET") return listIncidents(context);
  if (rest.length === 0 && context.request.method === "POST") return createIncident(context);
  const incidentId = normalizeOperationsId(rest[0]);
  if (!incidentId) throw new ApiProblem(400, "INVALID_INCIDENT_ID", "The incident ID is invalid.");
  if (rest.length === 1 && context.request.method === "GET") return incidentDetail(context, incidentId);
  if (rest.length === 1 && context.request.method === "PATCH") return updateIncident(context, incidentId);
  if (rest[1] === "transitions" && rest.length === 2 && context.request.method === "POST") return transitionIncident(context, incidentId);
  if (rest[1] === "timeline") return incidentTimeline(context, incidentId, rest.slice(2));
  if (rest[1] === "communications") return incidentCommunications(context, incidentId, rest.slice(2));
  if (rest[1] === "tasks") return incidentTasks(context, incidentId, rest.slice(2));
  if (rest[1] === "review") return incidentReview(context, incidentId, rest.slice(2));
  if (rest[1] === "assignments") return incidentAssignments(context, incidentId, rest.slice(2));
  throw new ApiProblem(404, "ROUTE_NOT_FOUND", "The requested incident route does not exist.", "Not found");
}

async function listIncidents(context: OperationsRequestContext): Promise<Response> {
  const unrestricted = organizationRoleCanReadAllIncidents(context.actor.role);
  const sql = `SELECT i.*, s.name AS service_name,
                      ${QUALIFIED_INCIDENT_COMMANDER_PROJECTION_SQL}
               FROM ops_incidents i JOIN ops_services s ON s.id = i.service_id
    WHERE i.organization_id = ? ${unrestricted ? "" : "AND EXISTS (SELECT 1 FROM ops_incident_assignments a WHERE a.incident_id = i.id AND a.user_id = ? AND a.status = 'active')"}
    ORDER BY CASE i.status WHEN 'declared' THEN 1 WHEN 'investigating' THEN 2 WHEN 'mitigating' THEN 3 WHEN 'monitoring' THEN 4 ELSE 5 END,
             CASE i.severity WHEN 'sev1' THEN 1 WHEN 'sev2' THEN 2 WHEN 'sev3' THEN 3 ELSE 4 END, i.updated_at DESC LIMIT 200`;
  const rows = await context.db.prepare(sql).bind(context.actor.organizationId, ...(!unrestricted ? [context.actor.id] : [])).all<IncidentRow>();
  return successResponse({ incidents: rows.results.map(incidentJson) }, context.requestId);
}

async function createIncident(context: OperationsRequestContext): Promise<Response> {
  requirePermission(context, "incident:create");
  const body = await readJsonObject(context.request);
  const key = idempotencyKey(context.request, body);
  const title = requiredText(body, "title", 4, 160);
  const summary = requiredText(body, "summary", 10, 2000);
  if (!isIncidentSeverity(body.severity)) throw new ApiProblem(400, "INVALID_SEVERITY", "severity must be sev1, sev2, sev3, or sev4.");
  const serviceId = normalizeOperationsId(body.serviceId);
  if (!serviceId) throw new ApiProblem(400, "INVALID_SERVICE_ID", "serviceId is invalid.");
  const service = await context.db.prepare("SELECT id, name FROM ops_services WHERE id = ? AND organization_id = ? AND status = 'active'")
    .bind(serviceId, context.actor.organizationId).first<{ id: string; name: string }>();
  if (!service) throw new ApiProblem(400, "SERVICE_NOT_ACTIVE", "serviceId must identify an active service.");
  const environment = typeof body.environment === "string" ? body.environment : "production";
  if (!ENVIRONMENTS.includes(environment as (typeof ENVIRONMENTS)[number])) throw new ApiProblem(400, "INVALID_ENVIRONMENT", "environment is not supported.");
  const impactSummary = optionalText(body, "impactSummary", 1200);
  const currentHypothesis = optionalText(body, "currentHypothesis", 1600);
  const currentMitigation = optionalText(body, "currentMitigation", 1600);
  const verificationCriteria = optionalText(body, "verificationCriteria", 1600);
  const now = operationsNow();
  const incidentId = operationsId("inc");
  const incidentNumber = `INC-${now.slice(0, 10).replaceAll("-", "")}-${incidentId.slice(-6).toUpperCase()}`;
  const assignmentId = operationsId("assign");
  const timelineId = operationsId("tl");
  const row: IncidentRow = {
    id: incidentId, incident_number: incidentNumber, service_id: serviceId, service_name: service.name,
    commander_user_id: context.actor.id, commander_name: context.actor.displayName,
    title, summary, severity: body.severity, status: "declared", environment, impact_summary: impactSummary,
    current_hypothesis: currentHypothesis, current_mitigation: currentMitigation, verification_criteria: verificationCriteria,
    declared_at: now, acknowledged_at: null, mitigated_at: null, resolved_at: null, closed_at: null,
    version: 1, created_by_user_id: context.actor.id, updated_by_user_id: context.actor.id, created_at: now, updated_at: now,
  };
  const result = await executeIdempotentBatch({
    db: context.db, actor: context.actor, actionScope: "incidents.create", idempotencyKey: key,
    requestPayload: body, responseData: { incident: incidentJson(row) }, now,
    statements: [
      context.db.prepare(
        `INSERT INTO ops_incidents
          (id, organization_id, incident_number, service_id, title, summary, severity, status, environment,
           impact_summary, current_hypothesis, current_mitigation, verification_criteria,
           declared_at, version, created_by_user_id, updated_by_user_id, last_request_id,
           last_transition_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'declared', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
      ).bind(incidentId, context.actor.organizationId, incidentNumber, serviceId, title, summary, body.severity,
        environment, impactSummary, currentHypothesis, currentMitigation, verificationCriteria, now,
        context.actor.id, context.actor.id, context.requestId, "Incident declared.", now, now),
      context.db.prepare(
        `INSERT INTO ops_incident_assignments
          (id, organization_id, incident_id, user_id, incident_role, assigned_by_user_id, created_at)
         VALUES (?, ?, ?, ?, 'incident_commander', ?, ?)`,
      ).bind(assignmentId, context.actor.organizationId, incidentId, context.actor.id, context.actor.id, now),
      context.db.prepare(
        `INSERT INTO ops_incident_timeline
          (id, organization_id, incident_id, event_type, actor_user_id, message, from_status, to_status, request_id, created_at)
         VALUES (?, ?, ?, 'status_change', ?, ?, NULL, 'declared', ?, ?)`,
      ).bind(timelineId, context.actor.organizationId, incidentId, context.actor.id, "Incident declared.", context.requestId, now),
      auditInsert(context.db, context.actor, {
        requestId: context.requestId, action: "incident.create", resourceType: "incident", resourceId: incidentId,
        occurredAt: now, details: { incidentNumber, serviceId, severity: body.severity },
      }),
    ],
  });
  return successResponse({ ...result.data, replayed: result.replayed }, context.requestId, result.replayed ? 200 : 201);
}

async function incidentDetail(context: OperationsRequestContext, incidentId: string): Promise<Response> {
  const { incident } = await incidentWithAccess(context, incidentId);
  const [service, assignments, tasks, review] = await Promise.all([
    context.db.prepare(`SELECT s.*, u.display_name AS owner_name, status_actor.display_name AS status_changed_by_name
      FROM ops_services s LEFT JOIN ops_users u ON u.id = s.owner_user_id
      LEFT JOIN ops_users status_actor ON status_actor.id = s.status_changed_by_user_id
      WHERE s.id = ? AND s.organization_id = ?`)
      .bind(incident.service_id, context.actor.organizationId).first<ServiceRow>(),
    context.db.prepare(
      `SELECT a.*, u.display_name, u.email FROM ops_incident_assignments a
       JOIN ops_users u ON u.id = a.user_id
       JOIN ops_memberships m ON m.organization_id = a.organization_id AND m.user_id = a.user_id
       WHERE a.incident_id = ? AND a.organization_id = ?
         AND a.status = 'active' AND u.status = 'active' AND m.status = 'active'
         AND ${ACTIVE_ASSIGNMENT_COMPATIBILITY_SQL}
       ORDER BY a.created_at`,
    ).bind(incidentId, context.actor.organizationId).all<AssignmentRow>(),
    context.db.prepare(
      `SELECT t.*, u.display_name AS assignee_name FROM ops_incident_tasks t LEFT JOIN ops_users u ON u.id = t.assignee_user_id
       WHERE t.incident_id = ? AND t.organization_id = ?
       ORDER BY CASE t.status WHEN 'completed' THEN 2 WHEN 'cancelled' THEN 3 ELSE 1 END, t.created_at`,
    ).bind(incidentId, context.actor.organizationId).all<TaskRow>(),
    context.db.prepare(
      "SELECT * FROM ops_post_incident_reviews WHERE incident_id = ? AND organization_id = ?",
    ).bind(incidentId, context.actor.organizationId).first<ReviewRow>(),
  ]);
  return successResponse({
    incident: incidentJson(incident),
    service: service ? serviceJson(service) : null,
    assignments: assignments.results.map(assignmentJson),
    tasks: tasks.results.map(taskJson),
    review: reviewJson(review ?? null),
  }, context.requestId);
}

async function updateIncident(context: OperationsRequestContext, incidentId: string): Promise<Response> {
  requirePermission(context, "incident:respond");
  const { incident, roles } = await incidentWithAccess(context, incidentId);
  assertResponder(context, roles);
  const body = await readJsonObject(context.request);
  const key = idempotencyKey(context.request, body);
  if (["title", "summary", "severity", "impactSummary"].some((field) => body[field] !== undefined)) {
    assertCommander(context, roles);
  }
  const expectedVersion = requiredInteger(body, "expectedVersion");
  const title = body.title === undefined ? incident.title : requiredText(body, "title", 4, 160);
  const summary = body.summary === undefined ? incident.summary : requiredText(body, "summary", 10, 2000);
  const severity = body.severity === undefined ? incident.severity : body.severity;
  if (!isIncidentSeverity(severity)) throw new ApiProblem(400, "INVALID_SEVERITY", "severity is not supported.");
  const impactSummary = body.impactSummary === undefined ? incident.impact_summary : optionalText(body, "impactSummary", 1200);
  const currentHypothesis = body.currentHypothesis === undefined ? incident.current_hypothesis : optionalText(body, "currentHypothesis", 1600);
  const currentMitigation = body.currentMitigation === undefined ? incident.current_mitigation : optionalText(body, "currentMitigation", 1600);
  const verificationCriteria = body.verificationCriteria === undefined ? incident.verification_criteria : optionalText(body, "verificationCriteria", 1600);
  const now = operationsNow();
  const updated: IncidentRow = {
    ...incident, title, summary, severity, impact_summary: impactSummary, current_hypothesis: currentHypothesis,
    current_mitigation: currentMitigation, verification_criteria: verificationCriteria,
    version: expectedVersion + 1, updated_by_user_id: context.actor.id, updated_at: now,
  };
  const guardId = operationsId("guard");
  const timelineId = operationsId("tl");
  const changed = ["title", "summary", "severity", "impactSummary", "currentHypothesis", "currentMitigation", "verificationCriteria"]
    .filter((field) => body[field] !== undefined);
  if (changed.length === 0) throw new ApiProblem(400, "NO_CHANGES", "Provide at least one incident field to update.");
  const result = await executeIdempotentBatch({
    db: context.db, actor: context.actor, actionScope: `incidents.update:${incidentId}`,
    idempotencyKey: key, requestPayload: body, responseData: { incident: incidentJson(updated) }, now,
    statements: [
      incidentGuard(context, guardId, incidentId, expectedVersion, incident.status, now),
      context.db.prepare(
        `UPDATE ops_incidents SET title = ?, summary = ?, severity = ?, impact_summary = ?, current_hypothesis = ?,
           current_mitigation = ?, verification_criteria = ?, version = version + 1,
           updated_by_user_id = ?, last_request_id = ?, updated_at = ?
         WHERE id = ? AND organization_id = ? AND version = ?`,
      ).bind(title, summary, severity, impactSummary, currentHypothesis, currentMitigation, verificationCriteria,
        context.actor.id, context.requestId, now, incidentId, context.actor.organizationId, expectedVersion),
      context.db.prepare(
        `INSERT INTO ops_incident_timeline
          (id, organization_id, incident_id, event_type, actor_user_id, message, request_id, created_at)
         VALUES (?, ?, ?, 'investigation', ?, ?, ?, ?)`,
      ).bind(timelineId, context.actor.organizationId, incidentId, context.actor.id, `Incident record updated: ${changed.join(", ")}.`, context.requestId, now),
      auditInsert(context.db, context.actor, {
        requestId: context.requestId, action: "incident.update", resourceType: "incident", resourceId: incidentId,
        occurredAt: now, details: { fields: changed, fromVersion: expectedVersion, toVersion: expectedVersion + 1 },
      }),
      context.db.prepare("DELETE FROM ops_write_guards WHERE id = ?").bind(guardId),
    ],
  });
  return successResponse({ ...result.data, replayed: result.replayed }, context.requestId);
}

async function transitionIncident(context: OperationsRequestContext, incidentId: string): Promise<Response> {
  requirePermission(context, "incident:respond");
  const { incident, roles } = await incidentWithAccess(context, incidentId);
  const body = await readJsonObject(context.request);
  const key = idempotencyKey(context.request, body);
  const now = operationsNow();
  const actionScope = `incidents.transition:${incidentId}`;
  const replay = await readIdempotentReplay<{
    incident: ReturnType<typeof incidentJson>;
    timelineRequestId: string;
  }>({
    db: context.db,
    actor: context.actor,
    actionScope,
    idempotencyKey: key,
    requestPayload: body,
    now,
  });
  if (replay) {
    const timeline = await transitionTimeline(context, incidentId, replay.timelineRequestId);
    return successResponse({
      incident: replay.incident,
      timelineEvent: timeline ? timelineJson(timeline) : null,
      replayed: true,
    }, context.requestId);
  }
  if (!isIncidentStatus(body.toStatus)) throw new ApiProblem(400, "INVALID_INCIDENT_STATUS", "toStatus is not supported.");
  const from = incident.status as OperationsIncidentStatus;
  if (!canTransitionIncident(context.actor.role, roles, from, body.toStatus)) {
    throw new ApiProblem(403, "TRANSITION_NOT_ALLOWED", `The transition from ${from} to ${body.toStatus} is not allowed for this actor.`, "Access denied");
  }
  const note = requiredText(body, "note", 8, 1000);
  const expectedVersion = requiredInteger(body, "expectedVersion");
  const updated: IncidentRow = {
    ...incident,
    status: body.toStatus,
    acknowledged_at: body.toStatus === "investigating" && !incident.acknowledged_at ? now : incident.acknowledged_at,
    mitigated_at: body.toStatus === "monitoring" ? now : body.toStatus === "investigating" ? null : incident.mitigated_at,
    resolved_at: body.toStatus === "resolved" ? now : body.toStatus === "investigating" ? null : incident.resolved_at,
    closed_at: body.toStatus === "closed" ? now : body.toStatus === "investigating" ? null : incident.closed_at,
    version: expectedVersion + 1,
    updated_by_user_id: context.actor.id,
    updated_at: now,
  };
  const guardId = operationsId("guard");
  const statements: D1PreparedStatement[] = [
    incidentGuard(context, guardId, incidentId, expectedVersion, from, now),
  ];
  if (["resolved", "closed"].includes(from) && body.toStatus === "investigating") {
    const reviewTimelineId = operationsId("tl");
    statements.push(
      context.db.prepare(
        `INSERT INTO ops_incident_timeline
          (id, organization_id, incident_id, event_type, actor_user_id, message, request_id, created_at)
         SELECT ?, ?, ?, 'review', ?, 'Completed post-incident review returned to draft after incident reopening.', ?, ?
         WHERE EXISTS (
           SELECT 1 FROM ops_post_incident_reviews WHERE incident_id = ? AND status = 'completed'
         )`,
      ).bind(reviewTimelineId, context.actor.organizationId, incidentId, context.actor.id,
        context.requestId, now, incidentId),
      context.db.prepare(
        `INSERT INTO ops_audit_events
          (id, organization_id, actor_user_id, actor_role, action, resource_type,
           resource_id, outcome, request_id, details_json, occurred_at)
         SELECT ?, ?, ?, ?, 'incident.review.reopen', 'post_incident_review', r.id,
                'success', ?, json_object('incidentId', ?, 'fromStatus', 'completed', 'toStatus', 'draft'), ?
         FROM ops_post_incident_reviews r
         WHERE r.incident_id = ? AND r.status = 'completed'`,
      ).bind(operationsId("audit"), context.actor.organizationId, context.actor.id, context.actor.role,
        context.requestId, incidentId, now, incidentId),
      context.db.prepare(
        `UPDATE ops_post_incident_reviews
         SET status = 'draft', version = version + 1, updated_by_user_id = ?, updated_at = ?
         WHERE incident_id = ? AND status = 'completed'`,
      ).bind(context.actor.id, now, incidentId),
    );
  }
  statements.push(
    context.db.prepare(
      `UPDATE ops_incidents SET status = ?,
         acknowledged_at = CASE WHEN ? = 'investigating' AND acknowledged_at IS NULL THEN ? ELSE acknowledged_at END,
         mitigated_at = CASE WHEN ? = 'monitoring' THEN ? WHEN ? = 'investigating' THEN NULL ELSE mitigated_at END,
         resolved_at = CASE WHEN ? = 'resolved' THEN ? WHEN ? = 'investigating' THEN NULL ELSE resolved_at END,
         closed_at = CASE WHEN ? = 'closed' THEN ? WHEN ? = 'investigating' THEN NULL ELSE closed_at END,
         version = version + 1, updated_by_user_id = ?, last_request_id = ?, last_transition_note = ?, updated_at = ?
       WHERE id = ? AND organization_id = ? AND version = ? AND status = ?`,
    ).bind(body.toStatus, body.toStatus, now, body.toStatus, now, body.toStatus,
      body.toStatus, now, body.toStatus, body.toStatus, now, body.toStatus,
      context.actor.id, context.requestId, note, now,
      incidentId, context.actor.organizationId, expectedVersion, from),
    context.db.prepare("DELETE FROM ops_write_guards WHERE id = ?").bind(guardId),
  );
  const result = await executeIdempotentBatch({
    db: context.db, actor: context.actor, actionScope,
    idempotencyKey: key, requestPayload: body,
    responseData: { incident: incidentJson(updated), timelineRequestId: context.requestId }, now,
    statements,
  });
  const timeline = await transitionTimeline(context, incidentId, result.data.timelineRequestId);
  return successResponse({ incident: result.data.incident, timelineEvent: timeline ? timelineJson(timeline) : null, replayed: result.replayed }, context.requestId);
}

async function incidentTimeline(context: OperationsRequestContext, incidentId: string, rest: string[]): Promise<Response> {
  const { roles } = await incidentWithAccess(context, incidentId);
  if (rest.length === 0 && context.request.method === "GET") {
    const rows = await context.db.prepare(
      `SELECT t.*, u.display_name AS actor_name FROM ops_incident_timeline t JOIN ops_users u ON u.id = t.actor_user_id
       WHERE t.incident_id = ? ORDER BY t.created_at, t.id LIMIT 500`,
    ).bind(incidentId).all<TimelineRow>();
    return successResponse({ events: rows.results.map(timelineJson) }, context.requestId);
  }
  if (rest.length === 0 && context.request.method === "POST") {
    requirePermission(context, "incident:respond");
    const body = await readJsonObject(context.request);
    const key = idempotencyKey(context.request, body);
    if (!isTimelineEventType(body.eventType)) throw new ApiProblem(400, "INVALID_TIMELINE_EVENT", "eventType is not supported.");
    if (!(body.eventType === "communication" && context.actor.role === "responder" && roles.includes("communications_lead"))) {
      assertResponder(context, roles);
    }
    const message = requiredText(body, "message", 3, 2000);
    const referenceUrl = optionalHttpsUrl(body.referenceUrl, "referenceUrl");
    const sourceLabel = optionalNullableText(body.sourceLabel, "sourceLabel", 120);
    const observedFrom = optionalTimestamp(body.observedFrom, "observedFrom");
    const observedTo = optionalTimestamp(body.observedTo, "observedTo");
    if (observedFrom && observedTo && observedFrom > observedTo) {
      throw new ApiProblem(400, "INVALID_OBSERVATION_WINDOW", "observedFrom must not be later than observedTo.");
    }
    const sha256Digest = optionalSha256Digest(body.sha256Digest);
    const now = operationsNow();
    const timelineId = operationsId("tl");
    const event: TimelineRow = {
      id: timelineId, incident_id: incidentId, event_type: body.eventType, actor_user_id: context.actor.id,
      actor_name: context.actor.displayName, message, from_status: null, to_status: null,
      reference_url: referenceUrl, source_label: sourceLabel, observed_from: observedFrom,
      observed_to: observedTo, sha256_digest: sha256Digest,
      request_id: context.requestId, created_at: now,
    };
    const result = await executeIdempotentBatch({
      db: context.db, actor: context.actor, actionScope: `incidents.timeline.create:${incidentId}`,
      idempotencyKey: key, requestPayload: body, responseData: { event: timelineJson(event) }, now,
      statements: [
        context.db.prepare(
          `INSERT INTO ops_incident_timeline
            (id, organization_id, incident_id, event_type, actor_user_id, message, reference_url,
             source_label, observed_from, observed_to, sha256_digest, request_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(timelineId, context.actor.organizationId, incidentId, body.eventType, context.actor.id,
          message, referenceUrl, sourceLabel, observedFrom, observedTo, sha256Digest, context.requestId, now),
        auditInsert(context.db, context.actor, {
          requestId: context.requestId, action: "incident.timeline.create", resourceType: "incident", resourceId: incidentId,
          occurredAt: now,
          details: {
            eventType: body.eventType,
            timelineId,
            hasReference: referenceUrl !== null,
            hasDigest: sha256Digest !== null,
            hasObservationWindow: observedFrom !== null || observedTo !== null,
          },
        }),
      ],
    });
    return successResponse({ ...result.data, replayed: result.replayed }, context.requestId, result.replayed ? 200 : 201);
  }
  throw new ApiProblem(404, "ROUTE_NOT_FOUND", "The requested timeline route does not exist.", "Not found");
}

async function incidentCommunications(
  context: OperationsRequestContext,
  incidentId: string,
  rest: string[],
): Promise<Response> {
  const { incident, roles } = await incidentWithAccess(context, incidentId);
  if (rest.length === 0 && context.request.method === "GET") {
    const rows = await context.db.prepare(
      `SELECT * FROM ops_incident_communications
       WHERE incident_id = ? AND organization_id = ?
       ORDER BY created_at, id LIMIT 500`,
    ).bind(incidentId, context.actor.organizationId).all<CommunicationRow>();
    return successResponse({ communications: rows.results.map(communicationJson) }, context.requestId);
  }

  if (rest.length === 0 && context.request.method === "POST") {
    assertCommunicationEditor(context, roles);
    const body = await readJsonObject(context.request);
    const key = idempotencyKey(context.request, body);
    const actionScope = `incidents.communications.create:${incidentId}`;
    const replay = await readIdempotentReplay<{ communication: ReturnType<typeof communicationJson> }>({
      db: context.db,
      actor: context.actor,
      actionScope,
      idempotencyKey: key,
      requestPayload: body,
    });
    if (replay) return successResponse({ ...replay, replayed: true }, context.requestId);
    if (!isCommunicationAudience(body.audience)) {
      throw new ApiProblem(400, "INVALID_COMMUNICATION_AUDIENCE", "audience must be internal, stakeholder, or public.");
    }
    const message = requiredText(body, "message", 10, 5000);
    const affectedComponents = communicationComponents(body.affectedComponents);
    const nextUpdateAt = optionalTimestamp(body.nextUpdateAt, "nextUpdateAt");
    const now = operationsNow();
    assertFutureNextUpdate(nextUpdateAt, now);
    const communicationId = operationsId("comm");
    const timelineId = operationsId("tl");
    const row: CommunicationRow = {
      id: communicationId,
      incident_id: incidentId,
      audience: body.audience,
      status: "draft",
      message,
      affected_components: JSON.stringify(affectedComponents),
      next_update_at: nextUpdateAt,
      version: 1,
      created_by_user_id: context.actor.id,
      updated_by_user_id: context.actor.id,
      reviewed_by_user_id: null,
      published_by_user_id: null,
      created_at: now,
      updated_at: now,
      reviewed_at: null,
      published_at: null,
      last_request_id: context.requestId,
    };
    const result = await executeIdempotentBatch({
      db: context.db,
      actor: context.actor,
      actionScope,
      idempotencyKey: key,
      requestPayload: body,
      responseData: { communication: communicationJson(row) },
      now,
      statements: [
        context.db.prepare(
          `INSERT INTO ops_incident_communications
            (id, organization_id, incident_id, audience, status, message, affected_components,
             next_update_at, version, created_by_user_id, updated_by_user_id, created_at, updated_at,
             last_request_id)
           VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        ).bind(
          communicationId,
          context.actor.organizationId,
          incidentId,
          body.audience,
          message,
          row.affected_components,
          nextUpdateAt,
          context.actor.id,
          context.actor.id,
          now,
          now,
          context.requestId,
        ),
        communicationTimelineInsert(
          context,
          timelineId,
          incidentId,
          communicationId,
          `Communication draft created for ${body.audience} audience.`,
          now,
        ),
        auditInsert(context.db, context.actor, {
          requestId: context.requestId,
          action: "incident.communication.create",
          resourceType: "incident_communication",
          resourceId: communicationId,
          occurredAt: now,
          details: {
            incidentId,
            audience: body.audience,
            status: "draft",
            componentCount: affectedComponents.length,
            hasNextUpdate: nextUpdateAt !== null,
            finalMessage: isFinalIncidentCommunication(message),
          },
        }),
      ],
    });
    return successResponse({ ...result.data, replayed: result.replayed }, context.requestId, result.replayed ? 200 : 201);
  }

  if (rest.length === 1 && context.request.method === "PATCH") {
    const communicationId = normalizeOperationsId(rest[0]);
    if (!communicationId) throw new ApiProblem(400, "INVALID_COMMUNICATION_ID", "The communication ID is invalid.");
    const body = await readJsonObject(context.request);
    const key = idempotencyKey(context.request, body);
    const action = communicationAction(body.action);
    if (action) assertCommunicationApprover(context, roles);
    else assertCommunicationEditor(context, roles);
    const now = operationsNow();
    const actionScope = `incidents.communications.patch:${communicationId}`;
    const replay = await readIdempotentReplay<{ communication: ReturnType<typeof communicationJson> }>({
      db: context.db,
      actor: context.actor,
      actionScope,
      idempotencyKey: key,
      requestPayload: body,
      now,
    });
    if (replay) return successResponse({ ...replay, replayed: true }, context.requestId);

    const existing = await context.db.prepare(
      `SELECT * FROM ops_incident_communications
       WHERE id = ? AND incident_id = ? AND organization_id = ?`,
    ).bind(communicationId, incidentId, context.actor.organizationId).first<CommunicationRow>();
    if (!existing) throw new ApiProblem(404, "COMMUNICATION_NOT_FOUND", "The incident communication does not exist.", "Not found");
    const expectedVersion = requiredInteger(body, "expectedVersion");
    let audience = existing.audience;
    let message = existing.message;
    let affectedComponents = communicationComponents(JSON.parse(existing.affected_components));
    let nextUpdateAt = existing.next_update_at;
    let status = existing.status;
    let reviewedByUserId = existing.reviewed_by_user_id;
    let publishedByUserId = existing.published_by_user_id;
    let reviewedAt = existing.reviewed_at;
    let publishedAt = existing.published_at;
    let auditAction: "incident.communication.update" | "incident.communication.review" | "incident.communication.publish";
    let timelineMessage: string;

    if (!action) {
      if (existing.status !== "draft") {
        throw new ApiProblem(409, "COMMUNICATION_STATUS_CONFLICT", "Only a draft communication can be edited.", "Conflict");
      }
      if (!hasCommunicationContentUpdate(body)) {
        throw new ApiProblem(400, "COMMUNICATION_CHANGES_REQUIRED", "Provide at least one draft communication field to update.");
      }
      if (body.audience !== undefined) {
        if (!isCommunicationAudience(body.audience)) {
          throw new ApiProblem(400, "INVALID_COMMUNICATION_AUDIENCE", "audience must be internal, stakeholder, or public.");
        }
        audience = body.audience;
      }
      if (body.message !== undefined) message = requiredText(body, "message", 10, 5000);
      if (body.affectedComponents !== undefined) affectedComponents = communicationComponents(body.affectedComponents);
      if (body.nextUpdateAt !== undefined) nextUpdateAt = optionalTimestamp(body.nextUpdateAt, "nextUpdateAt");
      assertFutureNextUpdate(nextUpdateAt, now);
      auditAction = "incident.communication.update";
      timelineMessage = `Communication draft updated for ${audience} audience.`;
    } else {
      assertCommunicationActionHasNoContent(body);
      if (action === "review") {
        if (existing.status !== "draft") {
          throw new ApiProblem(409, "COMMUNICATION_STATUS_CONFLICT", "Only a draft communication can be reviewed.", "Conflict");
        }
        assertExternalCommunicationSchedule(audience, message, nextUpdateAt, now);
        status = "reviewed";
        reviewedByUserId = context.actor.id;
        reviewedAt = now;
        auditAction = "incident.communication.review";
        timelineMessage = `Communication reviewed for ${audience} audience.`;
      } else {
        if (existing.status !== "reviewed") {
          throw new ApiProblem(409, "COMMUNICATION_STATUS_CONFLICT", "A communication must be reviewed before it can be published.", "Conflict");
        }
        if (["resolved", "closed", "cancelled"].includes(incident.status)) {
          throw new ApiProblem(409, "INCIDENT_COMMUNICATION_PUBLISH_BLOCKED", "Communications cannot be published after the incident is resolved, closed, or cancelled.", "Conflict");
        }
        assertExternalCommunicationSchedule(audience, message, nextUpdateAt, now);
        status = "published";
        publishedByUserId = context.actor.id;
        publishedAt = now;
        auditAction = "incident.communication.publish";
        timelineMessage = `Communication published for ${audience} audience.`;
      }
    }

    const updated: CommunicationRow = {
      ...existing,
      audience,
      status,
      message,
      affected_components: JSON.stringify(affectedComponents),
      next_update_at: nextUpdateAt,
      version: expectedVersion + 1,
      updated_by_user_id: context.actor.id,
      reviewed_by_user_id: reviewedByUserId,
      published_by_user_id: publishedByUserId,
      updated_at: now,
      reviewed_at: reviewedAt,
      published_at: publishedAt,
      last_request_id: context.requestId,
    };
    const guardId = operationsId("guard");
    const timelineId = operationsId("tl");
    const result = await executeIdempotentBatch({
      db: context.db,
      actor: context.actor,
      actionScope,
      idempotencyKey: key,
      requestPayload: body,
      responseData: { communication: communicationJson(updated) },
      now,
      statements: [
        context.db.prepare(
          `INSERT INTO ops_write_guards (id, passed, created_at)
           SELECT ?, CASE WHEN EXISTS (
             SELECT 1 FROM ops_incident_communications
             WHERE id = ? AND incident_id = ? AND organization_id = ? AND version = ? AND status = ?
           ) THEN 1 ELSE 0 END, ?`,
        ).bind(
          guardId,
          communicationId,
          incidentId,
          context.actor.organizationId,
          expectedVersion,
          existing.status,
          now,
        ),
        context.db.prepare(
          `UPDATE ops_incident_communications
           SET audience = ?, status = ?, message = ?, affected_components = ?, next_update_at = ?,
               version = version + 1, updated_by_user_id = ?, reviewed_by_user_id = ?,
               published_by_user_id = ?, updated_at = ?, reviewed_at = ?, published_at = ?, last_request_id = ?
           WHERE id = ? AND incident_id = ? AND organization_id = ? AND version = ? AND status = ?`,
        ).bind(
          audience,
          status,
          message,
          updated.affected_components,
          nextUpdateAt,
          context.actor.id,
          reviewedByUserId,
          publishedByUserId,
          now,
          reviewedAt,
          publishedAt,
          context.requestId,
          communicationId,
          incidentId,
          context.actor.organizationId,
          expectedVersion,
          existing.status,
        ),
        communicationTimelineInsert(context, timelineId, incidentId, communicationId, timelineMessage, now),
        auditInsert(context.db, context.actor, {
          requestId: context.requestId,
          action: auditAction,
          resourceType: "incident_communication",
          resourceId: communicationId,
          occurredAt: now,
          details: {
            incidentId,
            audience,
            status,
            fromVersion: expectedVersion,
            toVersion: expectedVersion + 1,
            componentCount: affectedComponents.length,
            hasNextUpdate: nextUpdateAt !== null,
            finalMessage: isFinalIncidentCommunication(message),
          },
        }),
        context.db.prepare("DELETE FROM ops_write_guards WHERE id = ?").bind(guardId),
      ],
    });
    return successResponse({ ...result.data, replayed: result.replayed }, context.requestId);
  }

  throw new ApiProblem(404, "ROUTE_NOT_FOUND", "The requested communication route does not exist.", "Not found");
}

async function incidentTasks(context: OperationsRequestContext, incidentId: string, rest: string[]): Promise<Response> {
  const { roles } = await incidentWithAccess(context, incidentId);
  if (rest.length === 0 && context.request.method === "GET") {
    const rows = await context.db.prepare(
      `SELECT t.*, u.display_name AS assignee_name FROM ops_incident_tasks t LEFT JOIN ops_users u ON u.id = t.assignee_user_id
       WHERE t.incident_id = ? ORDER BY t.created_at`,
    ).bind(incidentId).all<TaskRow>();
    return successResponse({ tasks: rows.results.map(taskJson) }, context.requestId);
  }
  if (rest.length === 0 && context.request.method === "POST") {
    requirePermission(context, "incident:respond");
    assertResponder(context, roles);
    const body = await readJsonObject(context.request);
    const key = idempotencyKey(context.request, body);
    const title = requiredText(body, "title", 3, 180);
    const description = optionalText(body, "description", 1500);
    const priority = typeof body.priority === "string" ? body.priority : "medium";
    if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) throw new ApiProblem(400, "INVALID_PRIORITY", "priority is not supported.");
    const assigneeUserId = body.assigneeUserId ? normalizeOperationsId(body.assigneeUserId) : null;
    if (assigneeUserId) await requireActiveMember(context, assigneeUserId);
    const dueAt = optionalTimestamp(body.dueAt, "dueAt");
    const evidenceRef = optionalHttpsUrl(body.evidenceRef, "evidenceRef");
    const now = operationsNow();
    const taskId = operationsId("task");
    const timelineId = operationsId("tl");
    const row: TaskRow = {
      id: taskId, incident_id: incidentId, title, description, priority, status: "open",
      assignee_user_id: assigneeUserId, assignee_name: null, due_at: dueAt, completed_at: null,
      evidence_ref: evidenceRef, cancellation_reason: null,
      version: 1, created_by_user_id: context.actor.id, created_at: now, updated_at: now,
    };
    const result = await executeIdempotentBatch({
      db: context.db, actor: context.actor, actionScope: `incidents.tasks.create:${incidentId}`,
      idempotencyKey: key, requestPayload: body, responseData: { task: taskJson(row) }, now,
      statements: [
        context.db.prepare(
          `INSERT INTO ops_incident_tasks
            (id, organization_id, incident_id, title, description, priority, status, assignee_user_id,
             due_at, evidence_ref, version, created_by_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, 1, ?, ?, ?)`,
        ).bind(taskId, context.actor.organizationId, incidentId, title, description, priority,
          assigneeUserId, dueAt, evidenceRef, context.actor.id, now, now),
        context.db.prepare(
          `INSERT INTO ops_incident_timeline
            (id, organization_id, incident_id, event_type, actor_user_id, message, request_id, created_at)
           VALUES (?, ?, ?, 'task', ?, ?, ?, ?)`,
        ).bind(timelineId, context.actor.organizationId, incidentId, context.actor.id, `Task created: ${title}`, context.requestId, now),
        auditInsert(context.db, context.actor, {
          requestId: context.requestId, action: "incident.task.create", resourceType: "task", resourceId: taskId,
          occurredAt: now, details: { incidentId, priority, assigneeUserId, hasEvidence: evidenceRef !== null },
        }),
      ],
    });
    return successResponse({ ...result.data, replayed: result.replayed }, context.requestId, result.replayed ? 200 : 201);
  }
  if (rest.length === 1 && context.request.method === "PATCH") {
    requirePermission(context, "incident:respond");
    assertResponder(context, roles);
    const taskId = normalizeOperationsId(rest[0]);
    const task = await context.db.prepare("SELECT * FROM ops_incident_tasks WHERE id = ? AND incident_id = ? AND organization_id = ?")
      .bind(taskId, incidentId, context.actor.organizationId).first<TaskRow>();
    if (!task) throw new ApiProblem(404, "TASK_NOT_FOUND", "The task does not exist.", "Not found");
    const body = await readJsonObject(context.request);
    const key = idempotencyKey(context.request, body);
    const expectedVersion = requiredInteger(body, "expectedVersion");
    const title = body.title === undefined ? task.title : requiredText(body, "title", 3, 180);
    const description = body.description === undefined ? task.description : optionalText(body, "description", 1500);
    const priority = body.priority === undefined ? task.priority : body.priority;
    if (!PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) throw new ApiProblem(400, "INVALID_PRIORITY", "priority is not supported.");
    const status = body.status === undefined ? task.status : body.status;
    if (!isTaskStatus(status)) throw new ApiProblem(400, "INVALID_TASK_STATUS", "status is not supported.");
    const assigneeUserId = body.assigneeUserId === undefined ? task.assignee_user_id
      : body.assigneeUserId === null ? null : normalizeOperationsId(body.assigneeUserId);
    if (body.assigneeUserId !== undefined && body.assigneeUserId !== null && !assigneeUserId) throw new ApiProblem(400, "INVALID_ASSIGNEE", "assigneeUserId is invalid.");
    if (assigneeUserId) await requireActiveMember(context, assigneeUserId);
    const dueAt = body.dueAt === undefined ? task.due_at : optionalTimestamp(body.dueAt, "dueAt");
    const evidenceRef = body.evidenceRef === undefined
      ? task.evidence_ref
      : optionalHttpsUrl(body.evidenceRef, "evidenceRef");
    let cancellationReason = body.cancellationReason === undefined
      ? task.cancellation_reason
      : optionalNullableText(body.cancellationReason, "cancellationReason", 1000);
    if (status !== "cancelled") cancellationReason = null;
    const cancellationNeedsReason = status === "cancelled"
      && (task.priority === "critical" || priority === "critical");
    if (cancellationNeedsReason && (!cancellationReason || cancellationReason.length < 8)) {
      throw new ApiProblem(
        409,
        "TASK_CANCELLATION_REASON_REQUIRED",
        "Explain why a critical task is being cancelled before it can be removed from the recovery gate.",
        "Conflict",
      );
    }
    if (!taskStatusHasRequiredEvidence(status, evidenceRef)) {
      throw new ApiProblem(
        409,
        "TASK_EVIDENCE_REQUIRED",
        "Attach an HTTPS evidence URL before completing the task.",
        "Conflict",
      );
    }
    const now = operationsNow();
    const completedAt = status === "completed" ? task.completed_at ?? now : null;
    const updated: TaskRow = {
      ...task,
      title,
      description,
      priority: String(priority),
      status,
      assignee_user_id: assigneeUserId,
      due_at: dueAt,
      completed_at: completedAt,
      evidence_ref: evidenceRef,
      cancellation_reason: cancellationReason,
      version: expectedVersion + 1,
      updated_at: now,
    };
    const guardId = operationsId("guard");
    const timelineId = operationsId("tl");
    const result = await executeIdempotentBatch({
      db: context.db, actor: context.actor, actionScope: `incidents.tasks.update:${taskId}`,
      idempotencyKey: key, requestPayload: body, responseData: { task: taskJson(updated) }, now,
      statements: [
        context.db.prepare(
          `INSERT INTO ops_write_guards (id, passed, created_at)
           SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM ops_incident_tasks WHERE id = ? AND incident_id = ? AND version = ?) THEN 1 ELSE 0 END, ?`,
        ).bind(guardId, taskId, incidentId, expectedVersion, now),
        context.db.prepare(
          `UPDATE ops_incident_tasks SET title = ?, description = ?, priority = ?, status = ?, assignee_user_id = ?, due_at = ?,
             completed_at = ?, evidence_ref = ?, cancellation_reason = ?, version = version + 1, updated_at = ?
           WHERE id = ? AND incident_id = ? AND version = ?`,
        ).bind(title, description, priority, status, assigneeUserId, dueAt, completedAt, evidenceRef, cancellationReason,
          now, taskId, incidentId, expectedVersion),
        context.db.prepare(
          `INSERT INTO ops_incident_timeline
            (id, organization_id, incident_id, event_type, actor_user_id, message, request_id, created_at)
           VALUES (?, ?, ?, 'task', ?, ?, ?, ?)`,
        ).bind(timelineId, context.actor.organizationId, incidentId, context.actor.id, `Task updated: ${title} (${status}).`, context.requestId, now),
        auditInsert(context.db, context.actor, {
          requestId: context.requestId, action: "incident.task.update", resourceType: "task", resourceId: taskId,
          occurredAt: now,
          details: {
            incidentId,
            priority,
            status,
            fromVersion: expectedVersion,
             toVersion: expectedVersion + 1,
             hasEvidence: evidenceRef !== null,
             hasCancellationReason: cancellationReason !== null,
           },
        }),
        context.db.prepare("DELETE FROM ops_write_guards WHERE id = ?").bind(guardId),
      ],
    });
    return successResponse({ ...result.data, replayed: result.replayed }, context.requestId);
  }
  throw new ApiProblem(404, "ROUTE_NOT_FOUND", "The requested task route does not exist.", "Not found");
}

async function incidentReview(context: OperationsRequestContext, incidentId: string, rest: string[]): Promise<Response> {
  if (rest.length !== 0) throw new ApiProblem(404, "ROUTE_NOT_FOUND", "The requested review route does not exist.", "Not found");
  const { incident, roles } = await incidentWithAccess(context, incidentId);
  if (context.request.method === "GET") {
    const existing = await context.db.prepare("SELECT * FROM ops_post_incident_reviews WHERE incident_id = ?")
      .bind(incidentId).first<ReviewRow>();
    return successResponse({ review: reviewJson(existing ?? null) }, context.requestId);
  }
  if (context.request.method !== "PUT") throw new ApiProblem(405, "METHOD_NOT_ALLOWED", "Use GET or PUT for a post-incident review.");
  requirePermission(context, "review:write");
  assertCommander(context, roles);
  const body = await readJsonObject(context.request);
  const key = idempotencyKey(context.request, body);
  const now = operationsNow();
  const actionScope = `incidents.review.put:${incidentId}`;
  const replay = await readIdempotentReplay<{ review: ReturnType<typeof reviewJson> }>({
    db: context.db,
    actor: context.actor,
    actionScope,
    idempotencyKey: key,
    requestPayload: body,
    now,
  });
  if (replay) return successResponse({ ...replay, replayed: true }, context.requestId);
  if (body.status !== "draft" && body.status !== "completed") {
    throw new ApiProblem(400, "INVALID_REVIEW_STATUS", "status must be draft or completed.");
  }
  if (!["resolved", "closed"].includes(incident.status)) {
    throw new ApiProblem(409, "INCIDENT_NOT_RESOLVED", "Resolve the incident before saving its post-incident review.");
  }
  const existing = await context.db.prepare("SELECT * FROM ops_post_incident_reviews WHERE incident_id = ?")
    .bind(incidentId).first<ReviewRow>();
  const expectedVersion = body.expectedVersion === undefined
    ? 0
    : requiredInteger(body, "expectedVersion", 0);
  if (!existing && expectedVersion !== 0) {
    throw new ApiProblem(409, "VERSION_CONFLICT", "A new review must use expectedVersion 0.", "Conflict");
  }
  const summary = reviewSection(body, "summary", existing?.summary ?? "", 3000);
  const customerImpact = reviewSection(body, "customerImpact", existing?.customer_impact ?? "", 3000);
  const rootCause = reviewSection(body, "rootCause", existing?.root_cause ?? "", 3000);
  const detectionGap = reviewSection(body, "detectionGap", existing?.detection_gap ?? "", 3000);
  const lessonsLearned = reviewSection(body, "lessonsLearned", existing?.lessons_learned ?? "", 3000);
  const followUpActions = reviewSection(body, "followUpActions", existing?.follow_up_actions ?? "", 3000);
  const status = body.status;
  if (status === "completed") {
    assertCompletedReview({ summary, customerImpact, rootCause, detectionGap, lessonsLearned, followUpActions });
  }
  const reviewId = existing?.id ?? operationsId("review");
  const version = existing ? expectedVersion + 1 : 1;
  const row: ReviewRow = {
    id: reviewId, incident_id: incidentId, summary, customer_impact: customerImpact, root_cause: rootCause,
    detection_gap: detectionGap, lessons_learned: lessonsLearned, follow_up_actions: followUpActions,
    status, version, created_by_user_id: existing?.created_by_user_id ?? context.actor.id,
    updated_by_user_id: context.actor.id, created_at: existing?.created_at ?? now, updated_at: now,
  };
  const guardId = operationsId("guard");
  const timelineId = operationsId("tl");
  const statements: D1PreparedStatement[] = [];
  if (existing) {
    statements.push(
      context.db.prepare(
        `INSERT INTO ops_write_guards (id, passed, created_at)
         SELECT ?, CASE WHEN EXISTS (SELECT 1 FROM ops_post_incident_reviews WHERE id = ? AND version = ?) THEN 1 ELSE 0 END, ?`,
      ).bind(guardId, reviewId, expectedVersion, now),
      context.db.prepare(
        `UPDATE ops_post_incident_reviews SET summary = ?, customer_impact = ?, root_cause = ?, detection_gap = ?,
           lessons_learned = ?, follow_up_actions = ?, status = ?, version = version + 1,
           updated_by_user_id = ?, updated_at = ? WHERE id = ? AND version = ?`,
      ).bind(summary, customerImpact, rootCause, detectionGap, lessonsLearned, followUpActions, status,
        context.actor.id, now, reviewId, expectedVersion),
    );
  } else {
    statements.push(context.db.prepare(
      `INSERT INTO ops_post_incident_reviews
        (id, organization_id, incident_id, summary, customer_impact, root_cause, detection_gap,
         lessons_learned, follow_up_actions, status, version, created_by_user_id, updated_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    ).bind(reviewId, context.actor.organizationId, incidentId, summary, customerImpact, rootCause, detectionGap,
      lessonsLearned, followUpActions, status, context.actor.id, context.actor.id, now, now));
  }
  statements.push(
    context.db.prepare(
      `INSERT INTO ops_incident_timeline
        (id, organization_id, incident_id, event_type, actor_user_id, message, request_id, created_at)
       VALUES (?, ?, ?, 'review', ?, ?, ?, ?)`,
    ).bind(timelineId, context.actor.organizationId, incidentId, context.actor.id, `Post-incident review ${status}.`, context.requestId, now),
    auditInsert(context.db, context.actor, {
      requestId: context.requestId, action: existing ? "incident.review.update" : "incident.review.create",
      resourceType: "post_incident_review", resourceId: reviewId, occurredAt: now,
      details: { incidentId, status, version },
    }),
  );
  if (existing) statements.push(context.db.prepare("DELETE FROM ops_write_guards WHERE id = ?").bind(guardId));
  const result = await executeIdempotentBatch({
    db: context.db, actor: context.actor, actionScope,
    idempotencyKey: key, requestPayload: body, responseData: { review: reviewJson(row) }, now, statements,
  });
  return successResponse({ ...result.data, replayed: result.replayed }, context.requestId, existing || result.replayed ? 200 : 201);
}

async function incidentAssignments(context: OperationsRequestContext, incidentId: string, rest: string[]): Promise<Response> {
  if (rest.length === 0 && context.request.method === "GET") {
    await incidentWithAccess(context, incidentId);
    const rows = await context.db.prepare(
      `SELECT a.*, u.display_name, u.email FROM ops_incident_assignments a
       JOIN ops_users u ON u.id = a.user_id
       JOIN ops_memberships m ON m.organization_id = a.organization_id AND m.user_id = a.user_id
       WHERE a.incident_id = ? AND a.status = 'active' AND u.status = 'active' AND m.status = 'active'
         AND ${ACTIVE_ASSIGNMENT_COMPATIBILITY_SQL}
       ORDER BY a.created_at`,
    ).bind(incidentId).all<AssignmentRow>();
    return successResponse({ assignments: rows.results.map(assignmentJson) }, context.requestId);
  }
  if (rest.length === 0 && context.request.method === "POST") {
    requirePermission(context, "incident:assign");
    const { roles } = await incidentWithAccess(context, incidentId);
    assertCommander(context, roles);
    const body = await readJsonObject(context.request);
    const key = idempotencyKey(context.request, body);
    const now = operationsNow();
    const actionScope = `incidents.assignments.create:${incidentId}`;
    const replay = await readIdempotentReplay<{ assignment: ReturnType<typeof assignmentJson> }>({
      db: context.db, actor: context.actor, actionScope, idempotencyKey: key, requestPayload: body, now,
    });
    if (replay) return successResponse({ ...replay, replayed: true }, context.requestId);
    const userId = normalizeOperationsId(body.userId);
    if (!userId || !isIncidentRole(body.incidentRole)) {
      throw new ApiProblem(400, "INVALID_ASSIGNMENT", "Provide a valid userId and incidentRole.");
    }
    const member = await requireActiveMember(context, userId);
    if (!organizationRoleCanHoldIncidentRole(member.role, body.incidentRole)) {
      throw new ApiProblem(
        400,
        "INCIDENT_ROLE_INCOMPATIBLE",
        "The selected member's organization role is not compatible with the requested incident role.",
      );
    }
    const assignmentId = operationsId("assign");
    const timelineId = operationsId("tl");
    const row: AssignmentRow = {
      id: assignmentId, incident_id: incidentId, user_id: userId, incident_role: body.incidentRole,
      status: "active", display_name: member.display_name, email: member.email, created_at: now,
      ended_at: null, ended_by_user_id: null,
    };
    const result = await executeIdempotentBatch({
      db: context.db, actor: context.actor, actionScope,
      idempotencyKey: key, requestPayload: body, responseData: { assignment: assignmentJson(row) }, now,
      statements: [
        context.db.prepare(
          `INSERT INTO ops_incident_assignments
            (id, organization_id, incident_id, user_id, incident_role, status, assigned_by_user_id, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).bind(assignmentId, context.actor.organizationId, incidentId, userId, body.incidentRole, context.actor.id, now),
        context.db.prepare(
          `INSERT INTO ops_incident_timeline
            (id, organization_id, incident_id, event_type, actor_user_id, message, request_id, created_at)
           VALUES (?, ?, ?, 'assignment', ?, ?, ?, ?)`,
        ).bind(timelineId, context.actor.organizationId, incidentId, context.actor.id,
          `${member.display_name} assigned as ${body.incidentRole}.`, context.requestId, now),
        auditInsert(context.db, context.actor, {
          requestId: context.requestId, action: "incident.assignment.create", resourceType: "incident_assignment",
          resourceId: assignmentId, occurredAt: now, details: { incidentId, userId, incidentRole: body.incidentRole },
        }),
      ],
    });
    return successResponse({ ...result.data, replayed: result.replayed }, context.requestId, result.replayed ? 200 : 201);
  }
  if (rest.length === 1 && context.request.method === "DELETE") {
    requirePermission(context, "incident:assign");
    const assignmentId = normalizeOperationsId(rest[0]);
    if (!assignmentId) throw new ApiProblem(400, "INVALID_ASSIGNMENT_ID", "The assignment ID is invalid.");
    const body = await readJsonObject(context.request);
    const key = idempotencyKey(context.request, body);
    const now = operationsNow();
    const actionScope = `incidents.assignments.revoke:${assignmentId}`;
    type RevokeReceipt = {
      revokedAssignmentId: string;
      replacementAssignment: ReturnType<typeof assignmentJson> | null;
    };
    const replay = await readIdempotentReplay<RevokeReceipt>({
      db: context.db, actor: context.actor, actionScope, idempotencyKey: key, requestPayload: body, now,
    });
    if (replay) return successResponse({ ...replay, replayed: true }, context.requestId);
    const { roles } = await incidentWithAccess(context, incidentId);
    assertCommander(context, roles);
    const assignment = await context.db.prepare(
      `SELECT a.*, u.display_name, u.email FROM ops_incident_assignments a
       JOIN ops_users u ON u.id = a.user_id
       WHERE a.id = ? AND a.incident_id = ? AND a.organization_id = ? AND a.status = 'active'`,
    ).bind(assignmentId, incidentId, context.actor.organizationId).first<AssignmentRow>();
    if (!assignment) throw new ApiProblem(404, "ASSIGNMENT_NOT_FOUND", "The active assignment does not exist.", "Not found");
    const replacementUserId = body.replacementUserId === undefined || body.replacementUserId === null || body.replacementUserId === ""
      ? null
      : normalizeOperationsId(body.replacementUserId);
    if (body.replacementUserId !== undefined && body.replacementUserId !== null && body.replacementUserId !== "" && !replacementUserId) {
      throw new ApiProblem(400, "INVALID_REPLACEMENT", "replacementUserId is invalid.");
    }
    if (replacementUserId && assignment.incident_role !== "incident_commander") {
      throw new ApiProblem(400, "REPLACEMENT_NOT_APPLICABLE", "A replacement is only valid when revoking an incident commander.");
    }
    if (replacementUserId === assignment.user_id) {
      throw new ApiProblem(400, "INVALID_REPLACEMENT", "The replacement must be a different active member.");
    }
    const commanderCount = assignment.incident_role === "incident_commander"
      ? await context.db.prepare(
        `SELECT COUNT(*) AS count FROM ops_incident_assignments
         WHERE incident_id = ? AND incident_role = 'incident_commander' AND status = 'active'`,
      ).bind(incidentId).first<{ count: number }>()
      : null;
    if (assignment.incident_role === "incident_commander" && Number(commanderCount?.count ?? 0) <= 1 && !replacementUserId) {
      throw new ApiProblem(409, "INCIDENT_COMMANDER_REQUIRED", "Assign a qualified replacement before revoking the final incident commander.", "Conflict");
    }

    let replacementRow: AssignmentRow | null = null;
    let replacementNeedsInsert = false;
    if (replacementUserId) {
      const replacement = await requireActiveMember(context, replacementUserId);
      if (!organizationRoleCanHoldIncidentRole(replacement.role, "incident_commander")) {
        throw new ApiProblem(400, "COMMANDER_ROLE_REQUIRED", "The replacement must have the admin or commander organization role.");
      }
      replacementRow = await context.db.prepare(
        `SELECT a.*, u.display_name, u.email FROM ops_incident_assignments a
         JOIN ops_users u ON u.id = a.user_id
         WHERE a.incident_id = ? AND a.user_id = ? AND a.incident_role = 'incident_commander' AND a.status = 'active'`,
      ).bind(incidentId, replacementUserId).first<AssignmentRow>();
      if (!replacementRow) {
        replacementNeedsInsert = true;
        replacementRow = {
          id: operationsId("assign"), incident_id: incidentId, user_id: replacementUserId,
          incident_role: "incident_commander", status: "active", display_name: replacement.display_name,
          email: replacement.email, created_at: now, ended_at: null, ended_by_user_id: null,
        };
      }
    }

    const responseData: RevokeReceipt = {
      revokedAssignmentId: assignmentId,
      replacementAssignment: replacementRow ? assignmentJson(replacementRow) : null,
    };
    const targetGuardId = operationsId("guard");
    const replacementGuardId = replacementUserId ? operationsId("guard") : null;
    const timelineId = operationsId("tl");
    const statements: D1PreparedStatement[] = [
      context.db.prepare(
        `INSERT INTO ops_write_guards (id, passed, created_at)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM ops_incident_assignments
           WHERE id = ? AND incident_id = ? AND organization_id = ? AND status = 'active'
         ) THEN 1 ELSE 0 END, ?`,
      ).bind(targetGuardId, assignmentId, incidentId, context.actor.organizationId, now),
    ];
    if (replacementUserId && replacementGuardId) {
      statements.push(context.db.prepare(
        `INSERT INTO ops_write_guards (id, passed, created_at)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM ops_memberships m JOIN ops_users u ON u.id = m.user_id
           WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'
             AND u.status = 'active' AND m.role IN ('admin', 'commander')
         ) THEN 1 ELSE 0 END, ?`,
      ).bind(replacementGuardId, context.actor.organizationId, replacementUserId, now));
    }
    if (replacementNeedsInsert && replacementRow) {
      statements.push(context.db.prepare(
        `INSERT INTO ops_incident_assignments
          (id, organization_id, incident_id, user_id, incident_role, status, assigned_by_user_id, created_at)
         VALUES (?, ?, ?, ?, 'incident_commander', 'active', ?, ?)`,
      ).bind(replacementRow.id, context.actor.organizationId, incidentId, replacementRow.user_id, context.actor.id, now));
    }
    statements.push(
      context.db.prepare(
        `UPDATE ops_incident_assignments SET status = 'revoked', ended_at = ?, ended_by_user_id = ?
         WHERE id = ? AND incident_id = ? AND organization_id = ? AND status = 'active'`,
      ).bind(now, context.actor.id, assignmentId, incidentId, context.actor.organizationId),
      context.db.prepare(
        `INSERT INTO ops_incident_timeline
          (id, organization_id, incident_id, event_type, actor_user_id, message, request_id, created_at)
         VALUES (?, ?, ?, 'assignment', ?, ?, ?, ?)`,
      ).bind(timelineId, context.actor.organizationId, incidentId, context.actor.id,
        replacementRow
          ? `${assignment.display_name} assignment revoked; incident command transferred to ${replacementRow.display_name}.`
          : `${assignment.display_name} ${assignment.incident_role} assignment revoked.`,
        context.requestId, now),
      auditInsert(context.db, context.actor, {
        requestId: context.requestId,
        action: replacementRow ? "incident.assignment.handoff" : "incident.assignment.revoke",
        resourceType: "incident_assignment",
        resourceId: assignmentId,
        occurredAt: now,
        details: {
          incidentId,
          revokedUserId: assignment.user_id,
          incidentRole: assignment.incident_role,
          replacementUserId,
          replacementAssignmentId: replacementRow?.id ?? null,
        },
      }),
      context.db.prepare("DELETE FROM ops_write_guards WHERE id = ?").bind(targetGuardId),
    );
    if (replacementGuardId) {
      statements.push(context.db.prepare("DELETE FROM ops_write_guards WHERE id = ?").bind(replacementGuardId));
    }
    const result = await executeIdempotentBatch({
      db: context.db, actor: context.actor, actionScope, idempotencyKey: key,
      requestPayload: body, responseData, now, statements,
    });
    return successResponse({ ...result.data, replayed: result.replayed }, context.requestId);
  }
  throw new ApiProblem(405, "METHOD_NOT_ALLOWED", "Use GET, POST, or DELETE for assignments.");
}

async function audit(context: OperationsRequestContext): Promise<Response> {
  requirePermission(context, "audit:read");
  const canViewActorEmail = actorHasPermission(context.actor, "access:manage");
  const url = new URL(context.request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
  const rows = await context.db.prepare(
    `SELECT a.*, u.display_name AS actor_name, u.email AS actor_email
     FROM ops_audit_events a JOIN ops_users u ON u.id = a.actor_user_id
     WHERE a.organization_id = ? ORDER BY a.occurred_at DESC, a.id DESC LIMIT ?`,
  ).bind(context.actor.organizationId, limit).all<Record<string, unknown>>();
  return successResponse({ events: rows.results.map((row) => ({
    id: row.id,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    ...(canViewActorEmail ? { actorEmail: row.actor_email } : {}),
    actorRole: row.actor_role,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    outcome: row.outcome,
    reasonCode: row.reason_code,
    requestId: row.request_id,
    details: parseJson(row.details_json),
    occurredAt: row.occurred_at,
  })) }, context.requestId);
}

function assertResponder(context: OperationsRequestContext, roles: readonly IncidentRole[]): void {
  if (context.actor.role === "admin") return;
  if (context.actor.role === "commander" && roles.includes("incident_commander")) return;
  if (context.actor.role === "responder" && (roles.includes("responder") || roles.includes("service_owner"))) return;
  throw new ApiProblem(403, "INCIDENT_RESPONSE_ACCESS_DENIED", "An assigned incident response role is required.", "Access denied");
}

function assertCommunicationEditor(context: OperationsRequestContext, roles: readonly IncidentRole[]): void {
  if (canDraftIncidentCommunication(context.actor.role, roles)) return;
  throw new ApiProblem(
    403,
    "INCIDENT_COMMUNICATION_ACCESS_DENIED",
    "A compatible active incident response, incident command, or communications lead assignment is required.",
    "Access denied",
  );
}

function assertCommunicationApprover(context: OperationsRequestContext, roles: readonly IncidentRole[]): void {
  if (canApproveIncidentCommunication(context.actor.role, roles)) return;
  throw new ApiProblem(
    403,
    "INCIDENT_COMMUNICATION_ACCESS_DENIED",
    "Admin access, or a compatible active incident commander or communications lead assignment, is required.",
    "Access denied",
  );
}

function communicationAction(value: unknown): "review" | "publish" | null {
  if (value === undefined) return null;
  if (value === "review" || value === "publish") return value;
  throw new ApiProblem(400, "INVALID_COMMUNICATION_ACTION", "action must be review or publish when provided.");
}

function communicationComponents(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30) {
    throw new ApiProblem(400, "INVALID_AFFECTED_COMPONENTS", "affectedComponents must contain at most 30 component names.");
  }
  const components: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const component = boundedText(item, "affectedComponents", 120);
    if (component.length < 1) {
      throw new ApiProblem(400, "INVALID_AFFECTED_COMPONENTS", "Each affected component must contain 1-120 characters.");
    }
    const key = component.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    components.push(component);
  }
  return components;
}

function hasCommunicationContentUpdate(body: Record<string, unknown>): boolean {
  return ["audience", "message", "affectedComponents", "nextUpdateAt"].some((key) => body[key] !== undefined);
}

function assertCommunicationActionHasNoContent(body: Record<string, unknown>): void {
  if (hasCommunicationContentUpdate(body)) {
    throw new ApiProblem(
      400,
      "COMMUNICATION_ACTION_CONTENT_NOT_ALLOWED",
      "Edit and save the draft before submitting a separate review or publish action.",
    );
  }
}

function assertFutureNextUpdate(nextUpdateAt: string | null, now: string): void {
  if (nextUpdateAt && nextUpdateAt <= now) {
    throw new ApiProblem(400, "INVALID_NEXT_UPDATE_AT", "nextUpdateAt must be later than the current time.");
  }
}

function assertExternalCommunicationSchedule(
  audience: CommunicationRow["audience"],
  message: string,
  nextUpdateAt: string | null,
  now: string,
): void {
  if (audience === "internal" || isFinalIncidentCommunication(message)) return;
  if (!nextUpdateAt || nextUpdateAt <= now) {
    throw new ApiProblem(
      409,
      "COMMUNICATION_NEXT_UPDATE_REQUIRED",
      "Stakeholder and public communications require a future nextUpdateAt, unless the message starts with [FINAL].",
      "Conflict",
    );
  }
}

function communicationTimelineInsert(
  context: OperationsRequestContext,
  timelineId: string,
  incidentId: string,
  communicationId: string,
  message: string,
  now: string,
): D1PreparedStatement {
  return context.db.prepare(
    `INSERT INTO ops_incident_timeline
      (id, organization_id, incident_id, event_type, actor_user_id, message, source_label, request_id, created_at)
     VALUES (?, ?, ?, 'communication', ?, ?, ?, ?, ?)`,
  ).bind(
    timelineId,
    context.actor.organizationId,
    incidentId,
    context.actor.id,
    message,
    communicationId,
    context.requestId,
    now,
  );
}

function assertCommander(context: OperationsRequestContext, roles: readonly IncidentRole[]): void {
  if (context.actor.role === "admin") return;
  if (context.actor.role === "commander" && roles.includes("incident_commander")) return;
  throw new ApiProblem(403, "INCIDENT_COMMAND_ACCESS_DENIED", "An assigned incident commander is required.", "Access denied");
}

function incidentGuard(
  context: OperationsRequestContext,
  guardId: string,
  incidentId: string,
  version: number,
  status: string,
  now: string,
): D1PreparedStatement {
  return context.db.prepare(
    `INSERT INTO ops_write_guards (id, passed, created_at)
     SELECT ?, CASE WHEN EXISTS (
       SELECT 1 FROM ops_incidents WHERE id = ? AND organization_id = ? AND version = ? AND status = ?
     ) THEN 1 ELSE 0 END, ?`,
  ).bind(guardId, incidentId, context.actor.organizationId, version, status, now);
}

async function transitionTimeline(
  context: OperationsRequestContext,
  incidentId: string,
  timelineRequestId: string,
): Promise<TimelineRow | null> {
  return context.db.prepare(
    `SELECT t.*, u.display_name AS actor_name FROM ops_incident_timeline t
     JOIN ops_users u ON u.id = t.actor_user_id
     WHERE t.incident_id = ? AND t.request_id = ? AND t.event_type = 'status_change'`,
  ).bind(incidentId, timelineRequestId).first<TimelineRow>();
}

async function requireActiveMember(context: OperationsRequestContext, userId: string): Promise<{ role: OrganizationRole; display_name: string; email: string }> {
  const member = await context.db.prepare(
    `SELECT m.role, u.display_name, u.email FROM ops_memberships m JOIN ops_users u ON u.id = m.user_id
     WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active' AND u.status = 'active'`,
  ).bind(context.actor.organizationId, userId).first<{ role: string; display_name: string; email: string }>();
  if (!member || !isOrganizationRole(member.role)) {
    throw new ApiProblem(400, "MEMBER_NOT_ACTIVE", "The selected user is not an active member.");
  }
  return { ...member, role: member.role };
}

function optionalTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiProblem(400, "INVALID_TIMESTAMP", `${field} must be an ISO 8601 timestamp.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new ApiProblem(400, "INVALID_TIMESTAMP", `${field} must be an ISO 8601 timestamp.`);
  return new Date(parsed).toISOString();
}

function optionalNullableText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ApiProblem(400, "INVALID_FIELD", `${field} must be text or null.`);
  const cleaned = boundedText(value, field, maxLength);
  return cleaned || null;
}

function optionalSha256Digest(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value.trim())) {
    throw new ApiProblem(400, "INVALID_SHA256_DIGEST", "sha256Digest must contain exactly 64 hexadecimal characters.");
  }
  return value.trim().toLowerCase();
}

function reviewSection(
  body: Record<string, unknown>,
  field: string,
  current: string,
  maxLength: number,
): string {
  if (body[field] === undefined) return current;
  if (typeof body[field] !== "string") {
    throw new ApiProblem(400, "INVALID_FIELD", `${field} must be text.`);
  }
  return boundedText(body[field], field, maxLength);
}

function assertCompletedReview(sections: {
  summary: string;
  customerImpact: string;
  rootCause: string;
  detectionGap: string;
  lessonsLearned: string;
  followUpActions: string;
}): void {
  const minimums: Record<keyof typeof sections, number> = {
    summary: 20,
    customerImpact: 10,
    rootCause: 10,
    detectionGap: 10,
    lessonsLearned: 10,
    followUpActions: 10,
  };
  const incomplete = (Object.keys(minimums) as (keyof typeof sections)[])
    .filter((field) => sections[field].length < minimums[field]);
  if (incomplete.length > 0) {
    throw new ApiProblem(
      400,
      "REVIEW_SECTIONS_INCOMPLETE",
      `Complete the required review sections: ${incomplete.join(", ")}.`,
    );
  }
}

function optionalHttpsUrl(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2048) throw new ApiProblem(400, "INVALID_URL", `${field} must be an HTTPS URL.`);
  try {
    const url = new URL(value);
    const normalized = url.toString();
    if (!isDurableHttpsUrl(normalized)) throw new Error("not durable https");
    return normalized;
  } catch {
    throw new ApiProblem(400, "INVALID_URL", `${field} must be an HTTPS URL.`);
  }
}

function requiredServiceStatusChangeReason(value: unknown): string {
  if (typeof value !== "string") {
    throw new ApiProblem(400, "SERVICE_STATUS_CHANGE_REASON_REQUIRED", "Provide an 8–1000 character lifecycle reason.");
  }
  const normalized = cleanOperationsText(value, 1001);
  if (normalized.length < 8 || normalized.length > 1000) {
    throw new ApiProblem(400, "SERVICE_STATUS_CHANGE_REASON_REQUIRED", "Provide an 8–1000 character lifecycle reason.");
  }
  return normalized;
}

function memberJson(row: Record<string, unknown>) {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    version: Number(row.version),
    lastSeenAt: row.last_seen_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || !value) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

export function normalizeOperationsApiError(error: unknown): ApiProblem {
  if (error instanceof ApiProblem) return error;
  if (error instanceof IdempotencyKeyMismatchError) {
    return new ApiProblem(409, "IDEMPOTENCY_KEY_REUSED", "The idempotency key was already used with different content.", "Conflict");
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("OPS_RESOLUTION_CRITERIA_REQUIRED")) {
    return new ApiProblem(409, "RESOLUTION_CRITERIA_REQUIRED", "Define the recovery verification criteria before resolving the incident.", "Conflict");
  }
  if (message.includes("OPS_RESOLUTION_VERIFICATION_REQUIRED")) {
    return new ApiProblem(409, "RESOLUTION_VERIFICATION_REQUIRED", "Record verification evidence after the incident entered monitoring before resolving it.", "Conflict");
  }
  if (message.includes("OPS_RESOLUTION_CRITICAL_TASKS_OPEN")) {
    return new ApiProblem(409, "RESOLUTION_CRITICAL_TASKS_OPEN", "Complete or cancel every critical task before resolving the incident.", "Conflict");
  }
  if (message.includes("OPS_SERVICE_HAS_OPEN_INCIDENTS")) {
    return new ApiProblem(409, "SERVICE_HAS_OPEN_INCIDENTS", "Close or cancel every open incident before deprecating the service.", "Conflict");
  }
  if (message.includes("OPS_SERVICE_STATUS_CHANGE_REASON_REQUIRED")) {
    return new ApiProblem(409, "SERVICE_STATUS_CHANGE_REASON_REQUIRED", "Record an operational reason before changing the service lifecycle status.", "Conflict");
  }
  if (message.includes("OPS_SERVICE_STATUS_CHANGE_ACTOR_INVALID")) {
    return new ApiProblem(409, "SERVICE_STATUS_CHANGE_ACTOR_INVALID", "Only an active service administrator or commander can change the service lifecycle status.", "Conflict");
  }
  if (message.includes("OPS_SERVICE_STATUS_METADATA_IMMUTABLE")) {
    return new ApiProblem(409, "SERVICE_STATUS_METADATA_IMMUTABLE", "Lifecycle evidence can change only as part of a new lifecycle transition.", "Conflict");
  }
  if (message.includes("OPS_TASK_EVIDENCE_REQUIRED") || message.includes("ops_tasks_completed_evidence_check")) {
    return new ApiProblem(409, "TASK_EVIDENCE_REQUIRED", "Attach an HTTPS evidence URL before completing the task.", "Conflict");
  }
  if (message.includes("ops_tasks_critical_cancellation_reason_check")) {
    return new ApiProblem(409, "TASK_CANCELLATION_REASON_REQUIRED", "Explain why a critical task is being cancelled before it can be removed from the recovery gate.", "Conflict");
  }
  if (message.includes("OPS_TASK_CRITICAL_CANCELLATION_REASON_REQUIRED")) {
    return new ApiProblem(409, "TASK_CANCELLATION_REASON_REQUIRED", "Explain why a critical task is being cancelled before it can be removed from the recovery gate.", "Conflict");
  }
  if (message.includes("OPS_TASK_CANCELLATION_REASON_IMMUTABLE")) {
    return new ApiProblem(409, "TASK_CANCELLATION_REASON_IMMUTABLE", "A recorded cancellation reason cannot be changed or removed.", "Conflict");
  }
  if (message.includes("OPS_REVIEW_INCIDENT_NOT_RESOLVED")) {
    return new ApiProblem(409, "INCIDENT_NOT_RESOLVED", "The incident must remain resolved or closed while its post-incident review is saved.", "Conflict");
  }
  if (message.includes("OPS_INCIDENT_COMMANDER_REQUIRED")) {
    return new ApiProblem(409, "INCIDENT_COMMANDER_REQUIRED", "An incident must retain at least one qualified active commander.", "Conflict");
  }
  if (message.includes("OPS_ACTIVE_INCIDENT_HANDOFF_REQUIRED")) {
    return new ApiProblem(409, "ACTIVE_INCIDENT_HANDOFF_REQUIRED", "Transfer command of every active incident before changing this member's access.", "Conflict");
  }
  if (message.includes("OPS_LAST_ADMIN_REQUIRED")) {
    return new ApiProblem(409, "LAST_ADMIN_REQUIRED", "The final active administrator cannot be removed.", "Conflict");
  }
  if (message.includes("OPS_COMMANDER_ROLE_REQUIRED")) {
    return new ApiProblem(409, "COMMANDER_ROLE_REQUIRED", "An incident commander must be an active admin or commander.", "Conflict");
  }
  if (message.includes("OPS_ASSIGNMENT_ROLE_INCOMPATIBLE")) {
    return new ApiProblem(
      409,
      "INCIDENT_ROLE_INCOMPATIBLE",
      "The member's current organization role is not compatible with every active incident assignment.",
      "Conflict",
    );
  }
  if (message.includes("OPS_COMMUNICATION_INCIDENT_TERMINAL")) {
    return new ApiProblem(409, "INCIDENT_COMMUNICATION_PUBLISH_BLOCKED", "Communications cannot be published after the incident is resolved, closed, or cancelled.", "Conflict");
  }
  if (message.includes("OPS_COMMUNICATION_NEXT_UPDATE_REQUIRED")
    || message.includes("ops_communications_external_publish_check")
    || message.includes("ops_communications_external_schedule_check")) {
    return new ApiProblem(409, "COMMUNICATION_NEXT_UPDATE_REQUIRED", "External communications require a future next update unless the message starts with [FINAL].", "Conflict");
  }
  if (message.includes("OPS_COMMUNICATION_INVALID_TRANSITION")
    || message.includes("OPS_COMMUNICATION_MUST_START_DRAFT")
    || message.includes("OPS_COMMUNICATION_REVIEWED_CONTENT_IMMUTABLE")
    || message.includes("OPS_COMMUNICATION_PUBLISHED_IMMUTABLE")
    || message.includes("ops_communications_lifecycle_check")) {
    return new ApiProblem(409, "COMMUNICATION_STATUS_CONFLICT", "The communication is no longer in a state that permits this change.", "Conflict");
  }
  if (message.includes("ops_reviews_completed_content_check") || message.includes("OPS_REVIEW_CONTENT_REQUIRED")) {
    return new ApiProblem(409, "REVIEW_SECTIONS_INCOMPLETE", "Complete every required review section before marking it completed.", "Conflict");
  }
  if (message.includes("ops_write_guards") || message.includes("passed = 1")
    || message.includes("OPS_INCIDENT_VERSION") || message.includes("OPS_TASK_VERSION")
    || message.includes("OPS_SERVICE_VERSION") || message.includes("OPS_REVIEW_VERSION")
    || message.includes("OPS_COMMUNICATION_VERSION") || message.includes("OPS_MEMBERSHIP_VERSION")) {
    return new ApiProblem(409, "VERSION_CONFLICT", "The resource changed. Reload it and retry with the current version.", "Conflict");
  }
  if (message.includes("OPS_INVALID_INCIDENT_TRANSITION")) {
    return new ApiProblem(409, "INVALID_STATUS_TRANSITION", "The requested incident status transition is not valid.", "Conflict");
  }
  if (message.includes("UNIQUE constraint failed")) {
    return new ApiProblem(409, "RESOURCE_ALREADY_EXISTS", "A resource with the same unique value already exists.", "Conflict");
  }
  if (message.includes("FOREIGN KEY constraint failed") || message.includes("OPS_ASSIGNEE")) {
    return new ApiProblem(409, "RESOURCE_RELATION_CONFLICT", "The referenced resource is unavailable or outside the permitted scope.", "Conflict");
  }
  return new ApiProblem(500, "INTERNAL_ERROR", "The operation could not be completed.", "Internal server error");
}
