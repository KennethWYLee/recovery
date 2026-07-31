import { ApiProblem, type OperationsRequestContext } from "./_shared";
import {
  canReadIncident,
  organizationRoleCanHoldIncidentRole,
  type IncidentRole,
} from "@/lib/operations-domain";

export type ServiceRow = {
  id: string; name: string; slug: string; description: string; tier: string;
  owner_user_id: string | null; owner_name?: string | null; status: string;
  owner_team: string; slo_target: number; runbook_url: string | null;
  status_change_reason?: string | null; status_changed_at?: string | null;
  status_changed_by_user_id?: string | null; status_changed_by_name?: string | null;
  status_change_request_id?: string | null;
  version: number; created_at: string; updated_at: string;
};

export type ServiceLifecycleEventRow = {
  id: string; service_id: string; from_status: string; to_status: string;
  reason: string; changed_by_user_id: string; changed_by_name?: string | null;
  request_id: string; changed_at: string;
};

export type IncidentRow = {
  id: string; incident_number: string; service_id: string; service_name?: string;
  commander_user_id?: string | null; commander_name?: string | null;
  title: string; summary: string; severity: string; status: string; environment: string;
  impact_summary: string; declared_at: string; acknowledged_at: string | null;
  current_hypothesis: string; current_mitigation: string; verification_criteria: string;
  mitigated_at: string | null; resolved_at: string | null; closed_at: string | null;
  version: number; created_by_user_id: string; updated_by_user_id: string;
  created_at: string; updated_at: string;
};

/**
 * Projects the first qualified, active incident commander for summary views.
 * The incident alias is intentionally fixed to `i` so list, overview, and
 * detail queries cannot drift to a different qualification policy.
 */
export const QUALIFIED_INCIDENT_COMMANDER_PROJECTION_SQL = `
  (SELECT ca.user_id
   FROM ops_incident_assignments ca
   JOIN ops_users cu ON cu.id = ca.user_id
   JOIN ops_memberships cm
     ON cm.organization_id = ca.organization_id AND cm.user_id = ca.user_id
   WHERE ca.incident_id = i.id
     AND ca.organization_id = i.organization_id
     AND ca.incident_role = 'incident_commander'
     AND ca.status = 'active'
     AND cu.status = 'active'
     AND cm.status = 'active'
     AND cm.role IN ('admin', 'commander')
   ORDER BY ca.created_at, ca.id
   LIMIT 1) AS commander_user_id,
  (SELECT cu.display_name
   FROM ops_incident_assignments ca
   JOIN ops_users cu ON cu.id = ca.user_id
   JOIN ops_memberships cm
     ON cm.organization_id = ca.organization_id AND cm.user_id = ca.user_id
   WHERE ca.incident_id = i.id
     AND ca.organization_id = i.organization_id
     AND ca.incident_role = 'incident_commander'
     AND ca.status = 'active'
     AND cu.status = 'active'
     AND cm.status = 'active'
     AND cm.role IN ('admin', 'commander')
   ORDER BY ca.created_at, ca.id
   LIMIT 1) AS commander_name`;

export type AssignmentRow = {
  id: string; incident_id: string; user_id: string; incident_role: IncidentRole;
  status: "active" | "revoked"; display_name: string; email: string; created_at: string;
  ended_at: string | null; ended_by_user_id: string | null;
};

export type TimelineRow = {
  id: string; incident_id: string; event_type: string; actor_user_id: string;
  actor_name?: string; message: string; from_status: string | null; to_status: string | null;
  reference_url: string | null; source_label: string | null;
  observed_from: string | null; observed_to: string | null; sha256_digest: string | null;
  request_id: string; created_at: string;
};

export type TaskRow = {
  id: string; incident_id: string; title: string; description: string; priority: string;
  status: string; assignee_user_id: string | null; assignee_name?: string | null;
  due_at: string | null; completed_at: string | null; evidence_ref: string | null;
  cancellation_reason: string | null; version: number;
  created_by_user_id: string; created_at: string; updated_at: string;
};

export type CommunicationRow = {
  id: string; incident_id: string; audience: "internal" | "stakeholder" | "public";
  status: "draft" | "reviewed" | "published"; message: string; affected_components: string;
  next_update_at: string | null; version: number; created_by_user_id: string;
  updated_by_user_id: string; reviewed_by_user_id: string | null; published_by_user_id: string | null;
  created_at: string; updated_at: string; reviewed_at: string | null; published_at: string | null;
  last_request_id: string;
};

export type ReviewRow = {
  id: string; incident_id: string; summary: string; customer_impact: string; root_cause: string;
  detection_gap: string; lessons_learned: string; follow_up_actions: string; status: string; version: number;
  created_by_user_id: string; updated_by_user_id: string; created_at: string; updated_at: string;
};

export function serviceJson(row: ServiceRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    tier: row.tier,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name ?? null,
    ownerTeam: row.owner_team,
    sloTarget: Number(row.slo_target),
    sloAttainment: null,
    runbookUrl: row.runbook_url,
    status: row.status,
    statusChangeReason: row.status_change_reason ?? null,
    statusChangedAt: row.status_changed_at ?? null,
    statusChangedByUserId: row.status_changed_by_user_id ?? null,
    statusChangedByName: row.status_changed_by_name ?? null,
    statusChangeRequestId: row.status_change_request_id ?? null,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serviceLifecycleEventJson(row: ServiceLifecycleEventRow) {
  return {
    id: row.id,
    serviceId: row.service_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    actor: {
      id: row.changed_by_user_id,
      displayName: row.changed_by_name ?? "Unknown operator",
    },
    requestId: row.request_id,
    changedAt: row.changed_at,
  };
}

export function incidentJson(row: IncidentRow) {
  return {
    id: row.id,
    incidentNumber: row.incident_number,
    serviceId: row.service_id,
    serviceName: row.service_name ?? null,
    commander: row.commander_user_id && row.commander_name
      ? { id: row.commander_user_id, displayName: row.commander_name }
      : null,
    title: row.title,
    summary: row.summary,
    severity: row.severity,
    status: row.status,
    environment: row.environment,
    impactSummary: row.impact_summary,
    currentHypothesis: row.current_hypothesis,
    currentMitigation: row.current_mitigation,
    verificationCriteria: row.verification_criteria,
    declaredAt: row.declared_at,
    acknowledgedAt: row.acknowledged_at,
    mitigatedAt: row.mitigated_at,
    resolvedAt: row.resolved_at,
    closedAt: row.closed_at,
    version: Number(row.version),
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function assignmentJson(row: AssignmentRow) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    userId: row.user_id,
    incidentRole: row.incident_role,
    status: row.status,
    displayName: row.display_name,
    email: row.email,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    endedByUserId: row.ended_by_user_id,
  };
}

export function timelineJson(row: TimelineRow) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id,
    actorName: row.actor_name ?? null,
    message: row.message,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    referenceUrl: row.reference_url,
    sourceLabel: row.source_label,
    observedFrom: row.observed_from,
    observedTo: row.observed_to,
    sha256Digest: row.sha256_digest,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

export function taskJson(row: TaskRow) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    assigneeUserId: row.assignee_user_id,
    assigneeName: row.assignee_name ?? null,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    evidenceRef: row.evidence_ref,
    cancellationReason: row.cancellation_reason,
    version: Number(row.version),
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function communicationJson(row: CommunicationRow) {
  return {
    id: row.id,
    incidentId: row.incident_id,
    audience: row.audience,
    status: row.status,
    message: row.message,
    affectedComponents: parsedStringArray(row.affected_components),
    nextUpdateAt: row.next_update_at,
    version: Number(row.version),
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    reviewedByUserId: row.reviewed_by_user_id,
    publishedByUserId: row.published_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    publishedAt: row.published_at,
  };
}

export function reviewJson(row: ReviewRow | null) {
  if (!row) return null;
  return {
    id: row.id,
    incidentId: row.incident_id,
    summary: row.summary,
    customerImpact: row.customer_impact,
    rootCause: row.root_cause,
    detectionGap: row.detection_gap,
    lessonsLearned: row.lessons_learned,
    followUpActions: row.follow_up_actions,
    status: row.status,
    version: Number(row.version),
    createdByUserId: row.created_by_user_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function incidentWithAccess(
  context: OperationsRequestContext,
  incidentId: string,
): Promise<{ incident: IncidentRow; roles: IncidentRole[] }> {
  const incident = await context.db.prepare(
    `SELECT i.*, s.name AS service_name,
            ${QUALIFIED_INCIDENT_COMMANDER_PROJECTION_SQL}
     FROM ops_incidents i
     JOIN ops_services s ON s.id = i.service_id AND s.organization_id = i.organization_id
     WHERE i.id = ? AND i.organization_id = ?`,
  ).bind(incidentId, context.actor.organizationId).first<IncidentRow>();
  if (!incident) throw new ApiProblem(404, "INCIDENT_NOT_FOUND", "The incident does not exist.", "Not found");
  const assignmentRows = await context.db.prepare(
    `SELECT incident_role FROM ops_incident_assignments
     WHERE incident_id = ? AND user_id = ? AND organization_id = ? AND status = 'active'`,
  ).bind(incidentId, context.actor.id, context.actor.organizationId).all<{ incident_role: IncidentRole }>();
  const roles = assignmentRows.results
    .map((row) => row.incident_role)
    .filter((role) => organizationRoleCanHoldIncidentRole(context.actor.role, role));
  if (!canReadIncident(context.actor.role, roles)) {
    throw new ApiProblem(403, "INCIDENT_ACCESS_DENIED", "You are not assigned to this incident.", "Access denied");
  }
  return { incident, roles };
}

function parsedStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
}
