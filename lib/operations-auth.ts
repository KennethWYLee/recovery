import {
  isOrganizationRole,
  normalizeEmail,
  normalizeOperationsId,
  permissionsForRole,
  roleHasPermission,
  type OperationsPermission,
  type OrganizationRole,
} from "./operations-domain.ts";

export type OperationsEnvironment = {
  CONTINUITY_OPS_ENVIRONMENT?: string;
  CONTINUITY_OPS_DEPLOYMENT_VERSION?: string;
  CONTINUITY_OPS_CURSOR_HMAC_SECRET?: string;
  CONTINUITY_OPS_ORGANIZATION_NAME?: string;
  CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_ID?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_NAME?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_ROLE?: string;
};

export type ExternalOperationsIdentity = {
  externalId: string;
  email: string;
  displayName: string;
  source: "forwarded_identity" | "local_environment";
  localRole?: OrganizationRole;
  isLocal: boolean;
};

export type OperationsActor = {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationTimeZone: string;
  membershipId: string;
  email: string;
  displayName: string;
  role: OrganizationRole;
};

export type RejectedMutationAudit = {
  outcome: "denied" | "failure";
  action: string;
  resourceType: string;
  resourceId: string;
  route: string;
};

const DENIED_MUTATION_CODES = new Set([
  "PERMISSION_DENIED",
  "READ_ONLY_ACCESS",
  "INCIDENT_ACCESS_DENIED",
  "INCIDENT_RESPONSE_ACCESS_DENIED",
  "INCIDENT_COMMAND_ACCESS_DENIED",
  "INCIDENT_COMMUNICATION_ACCESS_DENIED",
  "TRANSITION_NOT_ALLOWED",
  "COMMANDER_ROLE_REQUIRED",
  "INCIDENT_ROLE_INCOMPATIBLE",
  "SERVICE_STATUS_CHANGE_ACTOR_INVALID",
  "LAST_ADMIN_REQUIRED",
  "ACTIVE_INCIDENT_HANDOFF_REQUIRED",
  "ADMIN_ROLE_MANAGED",
  "SCHOOL_ROLE_SELECTION_NOT_AVAILABLE",
]);

const FAILED_MUTATION_CODES = new Set([
  "VERSION_CONFLICT",
  "INVALID_STATUS_TRANSITION",
  "INVALID_INCIDENT_STATUS",
  "IDEMPOTENCY_KEY_REUSED",
  "RESOURCE_RELATION_CONFLICT",
  "INCIDENT_NOT_RESOLVED",
  "RESOLUTION_CRITERIA_REQUIRED",
  "RESOLUTION_VERIFICATION_REQUIRED",
  "RESOLUTION_CRITICAL_TASKS_OPEN",
  "INCIDENT_COMMANDER_REQUIRED",
  "SERVICE_HAS_OPEN_INCIDENTS",
  "SERVICE_SLUG_IMMUTABLE",
  "SERVICE_STATUS_CHANGE_REASON_REQUIRED",
  "SERVICE_STATUS_CHANGE_REASON_NOT_APPLICABLE",
  "SERVICE_STATUS_CHANGE_CONFIRMATION_REQUIRED",
  "SERVICE_STATUS_CHANGE_CONFIRMATION_NOT_APPLICABLE",
  "SERVICE_STATUS_METADATA_IMMUTABLE",
  "TASK_EVIDENCE_REQUIRED",
  "REVIEW_SECTIONS_INCOMPLETE",
  "COMMUNICATION_STATUS_CONFLICT",
  "INCIDENT_COMMUNICATION_PUBLISH_BLOCKED",
  "COMMUNICATION_NEXT_UPDATE_REQUIRED",
  "INVALID_ROLE_SELECTION",
]);

const EMAIL_HEADER = "oai-authenticated-user-email";
const NAME_HEADER = "oai-authenticated-user-full-name";
const NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
export const NTUB_EMAIL_DOMAIN = "ntub.edu.tw";
export const READ_ONLY_ORGANIZATION_ROLES = ["observer", "auditor"] as const;
export type ReadOnlyOrganizationRole = (typeof READ_ONLY_ORGANIZATION_ROLES)[number];
export const SCHOOL_SELECTABLE_ORGANIZATION_ROLES = ["commander", "responder", "observer", "auditor"] as const;
export type SchoolSelectableOrganizationRole = (typeof SCHOOL_SELECTABLE_ORGANIZATION_ROLES)[number];

const MUTATING_HTTP_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isLocalOperationsRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function resolveExternalOperationsIdentity(
  request: Request,
  environment: OperationsEnvironment,
): ExternalOperationsIdentity | null {
  const configuredEnvironment = environment.CONTINUITY_OPS_ENVIRONMENT?.trim().toLowerCase();
  const localRequest = isLocalOperationsRequest(request);
  const development = configuredEnvironment === "development" || (!configuredEnvironment && localRequest);

  if (development && localRequest) {
    const email = normalizeEmail(environment.CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL);
    const externalId = environment.CONTINUITY_OPS_LOCAL_OPERATOR_ID?.trim() ?? "";
    const displayName = environment.CONTINUITY_OPS_LOCAL_OPERATOR_NAME?.trim() ?? "";
    const configuredRole = environment.CONTINUITY_OPS_LOCAL_OPERATOR_ROLE?.trim();
    if (!email || externalId.length < 3 || displayName.length < 2 || !isOrganizationRole(configuredRole)) return null;
    return {
      externalId,
      email,
      displayName: displayName.slice(0, 120),
      source: "local_environment",
      localRole: configuredRole,
      isLocal: true,
    };
  }

  const email = normalizeEmail(request.headers.get(EMAIL_HEADER));
  if (!email) return null;
  const encodedName = request.headers.get(NAME_HEADER) ?? "";
  const displayName = request.headers.get(NAME_ENCODING_HEADER) === "percent-encoded-utf-8"
    ? safeDecode(encodedName)
    : encodedName;
  return {
    externalId: email,
    email,
    displayName: (displayName?.trim() || email).slice(0, 120),
    source: "forwarded_identity",
    isLocal: false,
  };
}

export function requestIsSameOrigin(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function provisioningRoleForIdentity(
  identity: ExternalOperationsIdentity,
  configuredBootstrapEmail: unknown,
  chooseReadOnlyRole: () => ReadOnlyOrganizationRole = randomReadOnlyOrganizationRole,
): OrganizationRole | null {
  if (identity.isLocal && identity.localRole) return identity.localRole;
  const bootstrapEmail = normalizeEmail(configuredBootstrapEmail);
  if (bootstrapEmail && bootstrapEmail === normalizeEmail(identity.email)) return "admin";
  if (identity.source === "forwarded_identity" && isNtubEmail(identity.email)) return chooseReadOnlyRole();
  return null;
}

export function isNtubEmail(value: unknown): boolean {
  const email = normalizeEmail(value);
  if (!email) return false;
  return email.slice(email.lastIndexOf("@") + 1) === NTUB_EMAIL_DOMAIN;
}

export function randomReadOnlyOrganizationRole(randomValue?: number): ReadOnlyOrganizationRole {
  const value = randomValue ?? crypto.getRandomValues(new Uint32Array(1))[0];
  return (Math.trunc(value) & 1) === 0 ? "observer" : "auditor";
}

export function randomSchoolViewerDisplayName(randomToken = crypto.randomUUID()): string {
  const code = randomToken.replace(/[^A-Za-z0-9]/gu, "").slice(0, 8).toUpperCase().padEnd(8, "0");
  return `校內訪客 ${code.slice(0, 4)}-${code.slice(4, 8)}`;
}

export function isReadOnlyOrganizationRole(role: OrganizationRole | null | undefined): role is ReadOnlyOrganizationRole {
  return role === "observer" || role === "auditor";
}

export function isSchoolSelectableOrganizationRole(value: unknown): value is SchoolSelectableOrganizationRole {
  return typeof value === "string" && SCHOOL_SELECTABLE_ORGANIZATION_ROLES.includes(
    value as SchoolSelectableOrganizationRole,
  );
}

export function organizationRoleCanUseRequestMethod(role: OrganizationRole, method: string): boolean {
  return !MUTATING_HTTP_METHODS.has(method.toUpperCase()) || !isReadOnlyOrganizationRole(role);
}

export function actorHasPermission(actor: Pick<OperationsActor, "role">, permission: OperationsPermission): boolean {
  return roleHasPermission(actor.role, permission);
}

export function actorPermissions(actor: Pick<OperationsActor, "role">): readonly OperationsPermission[] {
  return permissionsForRole(actor.role);
}

/**
 * Returns a payload-free audit descriptor only after the caller has established
 * a verified identity and active membership. Authentication and origin failures
 * deliberately return null so untrusted client identity headers are never used.
 */
export function rejectedMutationAudit(
  method: string,
  path: readonly string[],
  reasonCode: string,
): RejectedMutationAudit | null {
  const normalizedMethod = method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) return null;
  const outcome = DENIED_MUTATION_CODES.has(reasonCode)
    ? "denied"
    : FAILED_MUTATION_CODES.has(reasonCode)
      ? "failure"
      : null;
  if (!outcome) return null;

  if (path.length === 2 && path[0] === "session" && path[1] === "role") {
    return {
      outcome,
      action: "access.self_role.select",
      resourceType: "membership",
      resourceId: "self",
      route: "/api/v1/session/role",
    };
  }

  if (path[0] === "incidents") {
    const incidentId = normalizeOperationsId(path[1]) || "unresolved";
    if (!path[1]) return { outcome, action: "incident.create", resourceType: "incident", resourceId: "pending", route: "/api/v1/incidents" };
    if (path[2] === "transitions") return { outcome, action: "incident.transition", resourceType: "incident", resourceId: incidentId, route: "/api/v1/incidents/:incidentId/transitions" };
    if (path[2] === "timeline") return { outcome, action: "incident.timeline.create", resourceType: "incident", resourceId: incidentId, route: "/api/v1/incidents/:incidentId/timeline" };
    if (path[2] === "communications") {
      const communicationId = normalizeOperationsId(path[3]);
      return normalizedMethod === "POST"
        ? { outcome, action: "incident.communication.create", resourceType: "incident_communication", resourceId: "pending", route: "/api/v1/incidents/:incidentId/communications" }
        : { outcome, action: "incident.communication.update", resourceType: "incident_communication", resourceId: communicationId || "unresolved", route: "/api/v1/incidents/:incidentId/communications/:communicationId" };
    }
    if (path[2] === "tasks") {
      const taskId = normalizeOperationsId(path[3]);
      return taskId
        ? { outcome, action: "incident.task.update", resourceType: "task", resourceId: taskId, route: "/api/v1/incidents/:incidentId/tasks/:taskId" }
        : { outcome, action: "incident.task.create", resourceType: "incident", resourceId: incidentId, route: "/api/v1/incidents/:incidentId/tasks" };
    }
    if (path[2] === "review") return { outcome, action: "incident.review.update", resourceType: "incident", resourceId: incidentId, route: "/api/v1/incidents/:incidentId/review" };
    if (path[2] === "assignments") {
      const assignmentId = normalizeOperationsId(path[3]);
      return assignmentId
        ? { outcome, action: "incident.assignment.revoke", resourceType: "incident_assignment", resourceId: assignmentId, route: "/api/v1/incidents/:incidentId/assignments/:assignmentId" }
        : { outcome, action: "incident.assignment.create", resourceType: "incident", resourceId: incidentId, route: "/api/v1/incidents/:incidentId/assignments" };
    }
    return { outcome, action: "incident.update", resourceType: "incident", resourceId: incidentId, route: "/api/v1/incidents/:incidentId" };
  }
  if (path[0] === "services") {
    return { outcome, action: path[1] ? "service.update" : "service.create", resourceType: "service", resourceId: normalizeOperationsId(path[1]) || "pending", route: path[1] ? "/api/v1/services/:serviceId" : "/api/v1/services" };
  }
  if (path[0] === "access" && path[1] === "members") {
    return { outcome, action: path[2] ? "access.member.update" : "access.member.create", resourceType: "membership", resourceId: normalizeOperationsId(path[2]) || "pending", route: path[2] ? "/api/v1/access/members/:membershipId" : "/api/v1/access/members" };
  }
  return { outcome, action: "api.mutation", resourceType: "api_route", resourceId: "unresolved", route: "/api/v1/:route" };
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
