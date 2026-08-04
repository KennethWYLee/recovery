export const ORGANIZATION_ROLES = ["admin", "commander", "responder", "observer", "auditor"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const INCIDENT_ROLES = [
  "incident_commander",
  "responder",
  "communications_lead",
  "service_owner",
  "observer",
] as const;
export type IncidentRole = (typeof INCIDENT_ROLES)[number];

export const INCIDENT_STATUSES = [
  "declared",
  "investigating",
  "mitigating",
  "monitoring",
  "resolved",
  "closed",
  "cancelled",
] as const;
export type OperationsIncidentStatus = (typeof INCIDENT_STATUSES)[number];
export type IncidentStatusFilter = OperationsIncidentStatus | "open" | "all";
export type ServiceLifecycleStatus = "active" | "deprecated";

export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const TIMELINE_EVENT_TYPES = [
  "note",
  "investigation",
  "mitigation",
  "verification",
  "communication",
] as const;
export type TimelineEventType = (typeof TIMELINE_EVENT_TYPES)[number];

export const TASK_STATUSES = ["open", "in_progress", "blocked", "completed", "cancelled"] as const;
export type OperationsTaskStatus = (typeof TASK_STATUSES)[number];

export const COMMUNICATION_AUDIENCES = ["internal", "stakeholder", "public"] as const;
export type IncidentCommunicationAudience = (typeof COMMUNICATION_AUDIENCES)[number];

export const COMMUNICATION_STATUSES = ["draft", "reviewed", "published"] as const;
export type IncidentCommunicationStatus = (typeof COMMUNICATION_STATUSES)[number];

export const PERMISSIONS = [
  "access:read",
  "access:manage",
  "service:read",
  "service:write",
  "incident:read",
  "incident:create",
  "incident:assign",
  "incident:respond",
  "incident:command",
  "review:write",
  "audit:read",
  "observability:read",
] as const;
export type OperationsPermission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<OrganizationRole, readonly OperationsPermission[]> = {
  admin: PERMISSIONS,
  commander: [
    "access:read",
    "service:read",
    "service:write",
    "incident:read",
    "incident:create",
    "incident:assign",
    "incident:respond",
    "incident:command",
    "review:write",
    "observability:read",
  ],
  responder: ["service:read", "incident:read", "incident:respond", "observability:read"],
  observer: ["access:read", "service:read", "incident:read", "audit:read", "observability:read"],
  auditor: ["access:read", "service:read", "incident:read", "audit:read", "observability:read"],
};

/**
 * Incident roles describe responsibility within one incident; they never
 * expand the holder's organization permissions. Keeping this matrix in one
 * place prevents an assignment from becoming an unintended privilege grant.
 */
const INCIDENT_ROLE_COMPATIBILITY: Record<OrganizationRole, readonly IncidentRole[]> = {
  admin: INCIDENT_ROLES,
  commander: ["incident_commander", "communications_lead", "observer"],
  responder: ["responder", "communications_lead", "service_owner", "observer"],
  observer: ["observer"],
  auditor: ["observer"],
};

const TRANSITIONS: Record<OperationsIncidentStatus, readonly OperationsIncidentStatus[]> = {
  declared: ["investigating", "cancelled"],
  investigating: ["mitigating", "cancelled"],
  mitigating: ["monitoring", "investigating", "cancelled"],
  monitoring: ["resolved", "investigating", "cancelled"],
  resolved: ["closed", "investigating"],
  closed: ["investigating"],
  cancelled: [],
};

export function isOrganizationRole(value: unknown): value is OrganizationRole {
  return typeof value === "string" && ORGANIZATION_ROLES.includes(value as OrganizationRole);
}

export function isIncidentRole(value: unknown): value is IncidentRole {
  return typeof value === "string" && INCIDENT_ROLES.includes(value as IncidentRole);
}

export function isIncidentStatus(value: unknown): value is OperationsIncidentStatus {
  return typeof value === "string" && INCIDENT_STATUSES.includes(value as OperationsIncidentStatus);
}

export function incidentStatusMatchesFilter(
  status: OperationsIncidentStatus,
  filter: IncidentStatusFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "open") return status !== "closed" && status !== "cancelled";
  return status === filter;
}

export function serviceCanAcceptNewIncidents(status: ServiceLifecycleStatus): boolean {
  return status === "active";
}

export function isIncidentSeverity(value: unknown): value is IncidentSeverity {
  return typeof value === "string" && INCIDENT_SEVERITIES.includes(value as IncidentSeverity);
}

export function isTimelineEventType(value: unknown): value is TimelineEventType {
  return typeof value === "string" && TIMELINE_EVENT_TYPES.includes(value as TimelineEventType);
}

export function isTaskStatus(value: unknown): value is OperationsTaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value as OperationsTaskStatus);
}

export function taskStatusHasRequiredEvidence(
  status: OperationsTaskStatus,
  evidenceRef: string | null,
): boolean {
  if (status !== "completed") return true;
  return Boolean(evidenceRef && isDurableHttpsUrl(evidenceRef));
}

export function isDurableHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const hostnamePattern = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
    return url.protocol === "https:"
      && !url.username
      && !url.password
      && !url.port
      && hostnamePattern.test(hostname)
      && !hostname.includes("..")
      && !hostname.includes(".-")
      && !hostname.includes("-.");
  } catch {
    return false;
  }
}

export function isCommunicationAudience(value: unknown): value is IncidentCommunicationAudience {
  return typeof value === "string" && COMMUNICATION_AUDIENCES.includes(value as IncidentCommunicationAudience);
}

export function isCommunicationStatus(value: unknown): value is IncidentCommunicationStatus {
  return typeof value === "string" && COMMUNICATION_STATUSES.includes(value as IncidentCommunicationStatus);
}

export function permissionsForRole(role: OrganizationRole): readonly OperationsPermission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHasPermission(role: OrganizationRole, permission: OperationsPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function organizationRoleCanHoldIncidentRole(
  organizationRole: OrganizationRole,
  incidentRole: IncidentRole,
): boolean {
  return INCIDENT_ROLE_COMPATIBILITY[organizationRole].includes(incidentRole);
}

export function allowedIncidentTransitions(status: OperationsIncidentStatus): readonly OperationsIncidentStatus[] {
  return TRANSITIONS[status];
}

export function canTransitionIncident(
  organizationRole: OrganizationRole,
  incidentRoles: readonly IncidentRole[],
  from: OperationsIncidentStatus,
  to: OperationsIncidentStatus,
): boolean {
  if (!TRANSITIONS[from].includes(to)) return false;
  if (organizationRole === "admin") return true;
  if (organizationRole === "auditor" || organizationRole === "observer") return false;

  const commandsIncident = organizationRole === "commander" && incidentRoles.includes("incident_commander");
  if (["resolved", "closed"].includes(from) || ["resolved", "closed", "cancelled"].includes(to)) {
    return commandsIncident;
  }

  if (commandsIncident) return true;
  return organizationRole === "responder" &&
    (incidentRoles.includes("responder") || incidentRoles.includes("service_owner"));
}

export function canReadIncident(role: OrganizationRole, incidentRoles: readonly IncidentRole[]): boolean {
  if (organizationRoleCanReadAllIncidents(role)) return true;
  return incidentRoles.length > 0;
}

export function organizationRoleCanReadAllIncidents(role: OrganizationRole): boolean {
  return role === "admin" || role === "commander" || role === "observer" || role === "auditor";
}

export function canDraftIncidentCommunication(
  organizationRole: OrganizationRole,
  incidentRoles: readonly IncidentRole[],
): boolean {
  if (organizationRole === "admin") return true;
  if (organizationRole === "commander") {
    return incidentRoles.includes("incident_commander") || incidentRoles.includes("communications_lead");
  }
  return organizationRole === "responder" && incidentRoles.some(
    (role) => role === "responder" || role === "service_owner" || role === "communications_lead",
  );
}

export function canApproveIncidentCommunication(
  organizationRole: OrganizationRole,
  incidentRoles: readonly IncidentRole[],
): boolean {
  if (organizationRole === "admin") return true;
  if (organizationRole === "commander") {
    return incidentRoles.includes("incident_commander") || incidentRoles.includes("communications_lead");
  }
  return organizationRole === "responder" && incidentRoles.includes("communications_lead");
}

/**
 * External communications may omit a next-update time only when the operator
 * deliberately marks the message final. Natural-language inference is avoided.
 */
export function isFinalIncidentCommunication(message: string): boolean {
  return /^\[final\](?:[ \t\r\n]|$)/i.test(message);
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return "";
  return normalized;
}

export function normalizeOperationsId(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,95}$/.test(normalized) ? normalized : "";
}

export function normalizeSlug(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(normalized) ? normalized : "";
}

export function cleanOperationsText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength);
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function incidentTimestampUpdates(to: OperationsIncidentStatus, now: string): Record<string, string | null> {
  if (to === "investigating") return { acknowledgedAt: now };
  if (to === "monitoring") return { mitigatedAt: now };
  if (to === "resolved") return { resolvedAt: now };
  if (to === "closed") return { closedAt: now };
  return {};
}

/** Returns a bounded route template without logging user-controlled identifiers. */
export function operationsRouteTemplate(path: readonly string[]): string {
  if (path.length === 2 && path[0] === "session" && path[1] === "role") {
    return "/api/v1/session/role";
  }
  if (path.length === 1 && ["health", "access", "overview", "observability", "services", "incidents", "audit"].includes(path[0])) {
    return `/api/v1/${path[0]}`;
  }
  if (path[0] === "access" && path[1] === "members") {
    return path.length === 2 ? "/api/v1/access/members" : "/api/v1/access/members/:membershipId";
  }
  if (path[0] === "services") {
    if (path.length === 1) return "/api/v1/services";
    if (path.length === 3 && path[2] === "lifecycle-events") {
      return "/api/v1/services/:serviceId/lifecycle-events";
    }
    return "/api/v1/services/:serviceId";
  }
  if (path[0] === "incidents") {
    if (path.length === 1) return "/api/v1/incidents";
    if (path.length === 2) return "/api/v1/incidents/:incidentId";
    if (["transitions", "timeline", "review"].includes(path[2]) && path.length === 3) {
      return `/api/v1/incidents/:incidentId/${path[2]}`;
    }
    if (path[2] === "tasks") {
      return path.length === 3
        ? "/api/v1/incidents/:incidentId/tasks"
        : "/api/v1/incidents/:incidentId/tasks/:taskId";
    }
    if (path[2] === "assignments") {
      return path.length === 3
        ? "/api/v1/incidents/:incidentId/assignments"
        : "/api/v1/incidents/:incidentId/assignments/:assignmentId";
    }
    if (path[2] === "communications") {
      return path.length === 3
        ? "/api/v1/incidents/:incidentId/communications"
        : "/api/v1/incidents/:incidentId/communications/:communicationId";
    }
  }
  return "/api/v1/:route";
}
