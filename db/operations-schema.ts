import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const opsOrganizations = sqliteTable("ops_organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  timezone: text("timezone").notNull().default("UTC"),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const opsUsers = sqliteTable("ops_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  identitySource: text("identity_source", { enum: ["forwarded_identity", "local_environment", "invited"] }).notNull(),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [uniqueIndex("ops_users_email_unique").on(table.email)]);

export const opsMemberships = sqliteTable("ops_memberships", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  userId: text("user_id").notNull().references(() => opsUsers.id),
  role: text("role", { enum: ["admin", "commander", "responder", "observer", "auditor"] }).notNull(),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("ops_memberships_org_user_unique").on(table.organizationId, table.userId),
  index("ops_memberships_role_idx").on(table.organizationId, table.role, table.status),
  check("ops_memberships_version_check", sql`${table.version} >= 1`),
]);

export const opsServices = sqliteTable("ops_services", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description").notNull().default(""),
  tier: text("tier", { enum: ["tier_1", "tier_2", "tier_3", "tier_4"] }).notNull().default("tier_2"),
  ownerUserId: text("owner_user_id").references(() => opsUsers.id),
  ownerTeam: text("owner_team").notNull().default(""),
  sloTarget: real("slo_target").notNull().default(99.9),
  runbookUrl: text("runbook_url"),
  status: text("status", { enum: ["active", "deprecated"] }).notNull().default("active"),
  statusChangeReason: text("status_change_reason"),
  statusChangedAt: text("status_changed_at"),
  statusChangedByUserId: text("status_changed_by_user_id").references(() => opsUsers.id),
  statusChangeRequestId: text("status_change_request_id"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("ops_services_id_org_unique").on(table.id, table.organizationId),
  uniqueIndex("ops_services_org_slug_unique").on(table.organizationId, table.slug),
  index("ops_services_status_idx").on(table.organizationId, table.status, table.tier),
  check("ops_services_version_check", sql`${table.version} >= 1`),
  check("ops_services_slo_target_check", sql`${table.sloTarget} > 0 AND ${table.sloTarget} <= 100`),
]);

export const opsServiceLifecycleEvents = sqliteTable("ops_service_lifecycle_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  serviceId: text("service_id").notNull(),
  fromStatus: text("from_status", { enum: ["active", "deprecated"] }).notNull(),
  toStatus: text("to_status", { enum: ["active", "deprecated"] }).notNull(),
  reason: text("reason").notNull(),
  changedByUserId: text("changed_by_user_id").notNull().references(() => opsUsers.id),
  requestId: text("request_id").notNull(),
  changedAt: text("changed_at").notNull(),
}, (table) => [
  foreignKey({
    columns: [table.serviceId, table.organizationId],
    foreignColumns: [opsServices.id, opsServices.organizationId],
    name: "ops_service_lifecycle_events_service_org_fk",
  }).onDelete("restrict"),
  uniqueIndex("ops_service_lifecycle_events_service_request_unique").on(table.serviceId, table.requestId),
  index("ops_service_lifecycle_events_service_time_idx").on(table.organizationId, table.serviceId, table.changedAt),
  check("ops_service_lifecycle_events_status_change_check", sql`${table.fromStatus} <> ${table.toStatus}`),
  check(
    "ops_service_lifecycle_events_reason_check",
    sql`length(trim(replace(replace(replace(replace(replace(replace(
      ${table.reason}, char(10), ' '), char(13), ' '), char(9), ' '), char(11), ' '), char(12), ' '), char(160), ' '))) BETWEEN 8 AND 1000`,
  ),
]);

export const opsIncidents = sqliteTable("ops_incidents", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  incidentNumber: text("incident_number").notNull(),
  serviceId: text("service_id").notNull().references(() => opsServices.id),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  severity: text("severity", { enum: ["sev1", "sev2", "sev3", "sev4"] }).notNull(),
  status: text("status", { enum: ["declared", "investigating", "mitigating", "monitoring", "resolved", "closed", "cancelled"] }).notNull().default("declared"),
  environment: text("environment", { enum: ["production", "staging", "development", "other"] }).notNull().default("production"),
  impactSummary: text("impact_summary").notNull().default(""),
  currentHypothesis: text("current_hypothesis").notNull().default(""),
  currentMitigation: text("current_mitigation").notNull().default(""),
  verificationCriteria: text("verification_criteria").notNull().default(""),
  declaredAt: text("declared_at").notNull(),
  acknowledgedAt: text("acknowledged_at"),
  mitigatedAt: text("mitigated_at"),
  resolvedAt: text("resolved_at"),
  closedAt: text("closed_at"),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull().references(() => opsUsers.id),
  updatedByUserId: text("updated_by_user_id").notNull().references(() => opsUsers.id),
  lastRequestId: text("last_request_id").notNull(),
  lastTransitionNote: text("last_transition_note").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("ops_incidents_org_number_unique").on(table.organizationId, table.incidentNumber),
  index("ops_incidents_active_idx").on(table.organizationId, table.status, table.severity, table.updatedAt),
  index("ops_incidents_service_idx").on(table.serviceId, table.updatedAt),
  check("ops_incidents_version_check", sql`${table.version} >= 1`),
]);

export const opsIncidentAssignments = sqliteTable("ops_incident_assignments", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  incidentId: text("incident_id").notNull().references(() => opsIncidents.id),
  userId: text("user_id").notNull().references(() => opsUsers.id),
  incidentRole: text("incident_role", { enum: ["incident_commander", "responder", "communications_lead", "service_owner", "observer"] }).notNull(),
  status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
  assignedByUserId: text("assigned_by_user_id").notNull().references(() => opsUsers.id),
  createdAt: text("created_at").notNull(),
  endedAt: text("ended_at"),
  endedByUserId: text("ended_by_user_id").references(() => opsUsers.id),
}, (table) => [
  uniqueIndex("ops_assignments_active_incident_user_role_unique")
    .on(table.incidentId, table.userId, table.incidentRole)
    .where(sql`${table.status} = 'active'`),
  index("ops_assignments_user_idx").on(table.organizationId, table.userId, table.incidentId),
  index("ops_assignments_incident_status_idx").on(table.incidentId, table.status, table.incidentRole),
]);

export const opsIncidentTimeline = sqliteTable("ops_incident_timeline", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  incidentId: text("incident_id").notNull().references(() => opsIncidents.id),
  eventType: text("event_type", { enum: ["status_change", "note", "investigation", "mitigation", "verification", "communication", "task", "assignment", "review"] }).notNull(),
  actorUserId: text("actor_user_id").notNull().references(() => opsUsers.id),
  message: text("message").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  referenceUrl: text("reference_url"),
  sourceLabel: text("source_label"),
  observedFrom: text("observed_from"),
  observedTo: text("observed_to"),
  sha256Digest: text("sha256_digest"),
  requestId: text("request_id").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("ops_timeline_incident_idx").on(table.incidentId, table.createdAt, table.id),
  uniqueIndex("ops_timeline_request_unique").on(table.incidentId, table.requestId, table.eventType),
]);

export const opsIncidentTasks = sqliteTable("ops_incident_tasks", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  incidentId: text("incident_id").notNull().references(() => opsIncidents.id),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  priority: text("priority", { enum: ["low", "medium", "high", "critical"] }).notNull().default("medium"),
  status: text("status", { enum: ["open", "in_progress", "blocked", "completed", "cancelled"] }).notNull().default("open"),
  assigneeUserId: text("assignee_user_id").references(() => opsUsers.id),
  dueAt: text("due_at"),
  completedAt: text("completed_at"),
  evidenceRef: text("evidence_ref"),
  cancellationReason: text("cancellation_reason"),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull().references(() => opsUsers.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("ops_tasks_incident_idx").on(table.incidentId, table.status, table.dueAt),
  index("ops_tasks_assignee_idx").on(table.organizationId, table.assigneeUserId, table.status),
  check("ops_tasks_version_check", sql`${table.version} >= 1`),
  check(
    "ops_tasks_completed_evidence_check",
    sql`${table.status} <> 'completed' OR (
      ${table.evidenceRef} IS NOT NULL
      AND ${table.evidenceRef} = trim(${table.evidenceRef})
      AND length(${table.evidenceRef}) BETWEEN 9 AND 2048
      AND substr(${table.evidenceRef}, 1, 8) = 'https://'
      AND (
        (instr(substr(${table.evidenceRef}, 9), '/') = 0 AND length(substr(${table.evidenceRef}, 9)) BETWEEN 1 AND 253)
        OR instr(substr(${table.evidenceRef}, 9), '/') BETWEEN 2 AND 254
      )
      AND substr(substr(${table.evidenceRef}, 9), 1, 1) GLOB '[a-z0-9]'
      AND substr(substr(${table.evidenceRef}, 9), CASE WHEN instr(substr(${table.evidenceRef}, 9), '/') = 0
        THEN length(substr(${table.evidenceRef}, 9)) ELSE instr(substr(${table.evidenceRef}, 9), '/') - 1 END, 1) GLOB '[a-z0-9]'
      AND substr(substr(${table.evidenceRef}, 9), 1, CASE WHEN instr(substr(${table.evidenceRef}, 9), '/') = 0
        THEN length(substr(${table.evidenceRef}, 9)) ELSE instr(substr(${table.evidenceRef}, 9), '/') - 1 END) NOT GLOB '*[^a-z0-9.-]*'
      AND instr(substr(substr(${table.evidenceRef}, 9), 1, CASE WHEN instr(substr(${table.evidenceRef}, 9), '/') = 0
        THEN length(substr(${table.evidenceRef}, 9)) ELSE instr(substr(${table.evidenceRef}, 9), '/') - 1 END), '..') = 0
      AND instr(substr(substr(${table.evidenceRef}, 9), 1, CASE WHEN instr(substr(${table.evidenceRef}, 9), '/') = 0
        THEN length(substr(${table.evidenceRef}, 9)) ELSE instr(substr(${table.evidenceRef}, 9), '/') - 1 END), '.-') = 0
      AND instr(substr(substr(${table.evidenceRef}, 9), 1, CASE WHEN instr(substr(${table.evidenceRef}, 9), '/') = 0
        THEN length(substr(${table.evidenceRef}, 9)) ELSE instr(substr(${table.evidenceRef}, 9), '/') - 1 END), '-.') = 0
      AND instr(${table.evidenceRef}, ' ') = 0
      AND instr(${table.evidenceRef}, char(9)) = 0
      AND instr(${table.evidenceRef}, char(10)) = 0
      AND instr(${table.evidenceRef}, char(13)) = 0
    )`,
  ),
  check(
    "ops_tasks_critical_cancellation_reason_check",
    sql`${table.status} <> 'cancelled' OR ${table.priority} <> 'critical' OR (
      ${table.cancellationReason} IS NOT NULL
      AND ${table.cancellationReason} = trim(${table.cancellationReason})
      AND length(${table.cancellationReason}) BETWEEN 8 AND 1000
    )`,
  ),
  check(
    "ops_tasks_cancellation_reason_lifecycle_check",
    sql`${table.status} = 'cancelled' OR ${table.cancellationReason} IS NULL`,
  ),
]);

export const opsIncidentCommunications = sqliteTable("ops_incident_communications", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  incidentId: text("incident_id").notNull().references(() => opsIncidents.id),
  audience: text("audience", { enum: ["internal", "stakeholder", "public"] }).notNull(),
  status: text("status", { enum: ["draft", "reviewed", "published"] }).notNull().default("draft"),
  message: text("message").notNull(),
  affectedComponents: text("affected_components").notNull().default("[]"),
  nextUpdateAt: text("next_update_at"),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull().references(() => opsUsers.id),
  updatedByUserId: text("updated_by_user_id").notNull().references(() => opsUsers.id),
  reviewedByUserId: text("reviewed_by_user_id").references(() => opsUsers.id),
  publishedByUserId: text("published_by_user_id").references(() => opsUsers.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  reviewedAt: text("reviewed_at"),
  publishedAt: text("published_at"),
  lastRequestId: text("last_request_id").notNull(),
}, (table) => [
  uniqueIndex("ops_communications_incident_id_unique").on(table.incidentId, table.id),
  index("ops_communications_incident_idx").on(table.incidentId, table.createdAt, table.id),
  index("ops_communications_status_idx").on(table.organizationId, table.status, table.audience, table.updatedAt),
  index("ops_communications_next_update_idx")
    .on(table.organizationId, table.nextUpdateAt, table.incidentId)
    .where(sql`${table.status} = 'published' AND ${table.nextUpdateAt} IS NOT NULL`),
  check("ops_communications_version_check", sql`${table.version} >= 1`),
  check("ops_communications_message_check", sql`length(trim(${table.message})) BETWEEN 10 AND 5000`),
  check(
    "ops_communications_components_check",
    sql`json_valid(${table.affectedComponents}) AND json_type(${table.affectedComponents}) = 'array' AND length(${table.affectedComponents}) <= 8192`,
  ),
  check(
    "ops_communications_lifecycle_check",
    sql`(
      ${table.status} = 'draft' AND ${table.reviewedByUserId} IS NULL AND ${table.reviewedAt} IS NULL
        AND ${table.publishedByUserId} IS NULL AND ${table.publishedAt} IS NULL
    ) OR (
      ${table.status} = 'reviewed' AND ${table.reviewedByUserId} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL
        AND ${table.publishedByUserId} IS NULL AND ${table.publishedAt} IS NULL
    ) OR (
      ${table.status} = 'published' AND ${table.reviewedByUserId} IS NOT NULL AND ${table.reviewedAt} IS NOT NULL
        AND ${table.publishedByUserId} IS NOT NULL AND ${table.publishedAt} IS NOT NULL
    )`,
  ),
  check(
    "ops_communications_external_schedule_check",
    sql`${table.status} = 'draft' OR ${table.audience} = 'internal'
      OR (lower(substr(${table.message}, 1, 7)) = '[final]'
        AND (length(${table.message}) = 7 OR substr(${table.message}, 8, 1) IN (' ', char(9), char(10), char(13))))
      OR (${table.nextUpdateAt} IS NOT NULL AND julianday(${table.nextUpdateAt}) IS NOT NULL AND (
        (${table.status} = 'reviewed' AND julianday(${table.nextUpdateAt}) > julianday(${table.reviewedAt}))
        OR (${table.status} = 'published' AND julianday(${table.nextUpdateAt}) > julianday(${table.publishedAt}))
      ))`,
  ),
  check(
    "ops_communications_timestamp_order_check",
    sql`julianday(${table.createdAt}) IS NOT NULL
      AND julianday(${table.updatedAt}) IS NOT NULL
      AND julianday(${table.updatedAt}) >= julianday(${table.createdAt})
      AND (${table.reviewedAt} IS NULL OR (julianday(${table.reviewedAt}) IS NOT NULL
        AND julianday(${table.reviewedAt}) >= julianday(${table.createdAt})
        AND julianday(${table.reviewedAt}) <= julianday(${table.updatedAt})))
      AND (${table.publishedAt} IS NULL OR (${table.reviewedAt} IS NOT NULL
        AND julianday(${table.publishedAt}) IS NOT NULL
        AND julianday(${table.publishedAt}) >= julianday(${table.reviewedAt})
        AND julianday(${table.publishedAt}) <= julianday(${table.updatedAt})))`,
  ),
]);

export const opsPostIncidentReviews = sqliteTable("ops_post_incident_reviews", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  incidentId: text("incident_id").notNull().references(() => opsIncidents.id),
  summary: text("summary").notNull().default(""),
  customerImpact: text("customer_impact").notNull().default(""),
  rootCause: text("root_cause").notNull().default(""),
  detectionGap: text("detection_gap").notNull().default(""),
  lessonsLearned: text("lessons_learned").notNull().default(""),
  followUpActions: text("follow_up_actions").notNull().default(""),
  status: text("status", { enum: ["draft", "completed"] }).notNull().default("draft"),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull().references(() => opsUsers.id),
  updatedByUserId: text("updated_by_user_id").notNull().references(() => opsUsers.id),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("ops_reviews_incident_unique").on(table.incidentId),
  check("ops_reviews_version_check", sql`${table.version} >= 1`),
  check(
    "ops_reviews_completed_content_check",
    sql`${table.status} = 'draft' OR (
      length(trim(${table.summary})) >= 20 AND
      length(trim(${table.customerImpact})) >= 10 AND
      length(trim(${table.rootCause})) >= 10 AND
      length(trim(${table.detectionGap})) >= 10 AND
      length(trim(${table.lessonsLearned})) >= 10 AND
      length(trim(${table.followUpActions})) >= 10
    )`,
  ),
]);

export const opsAuditEvents = sqliteTable("ops_audit_events", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  actorUserId: text("actor_user_id").notNull().references(() => opsUsers.id),
  actorRole: text("actor_role").notNull(),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  outcome: text("outcome", { enum: ["success", "denied", "failure"] }).notNull(),
  reasonCode: text("reason_code"),
  requestId: text("request_id").notNull(),
  detailsJson: text("details_json"),
  occurredAt: text("occurred_at").notNull(),
}, (table) => [
  index("ops_audit_time_idx").on(table.organizationId, table.occurredAt, table.id),
  index("ops_audit_resource_idx").on(table.resourceType, table.resourceId, table.occurredAt),
  index("ops_audit_actor_idx").on(table.actorUserId, table.occurredAt),
]);

export const opsRequestTelemetry = sqliteTable("ops_request_telemetry", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  requestId: text("request_id").notNull().unique(),
  routeTemplate: text("route_template").notNull(),
  method: text("method", { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] }).notNull(),
  statusCode: integer("status_code").notNull(),
  problemCode: text("problem_code"),
  latencyMs: integer("latency_ms").notNull(),
  apiVersion: text("api_version").notNull(),
  schemaVersion: text("schema_version").notNull(),
  deploymentVersion: text("deployment_version").notNull(),
  environment: text("environment", { enum: ["development", "staging", "production", "unknown"] }).notNull(),
  source: text("source", { enum: ["runtime", "simulated"] }).notNull(),
  occurredAt: text("occurred_at").notNull(),
}, (table) => [
  index("ops_request_telemetry_time_idx").on(table.organizationId, table.occurredAt),
  index("ops_request_telemetry_status_time_idx").on(table.organizationId, table.statusCode, table.occurredAt),
  check("ops_request_telemetry_status_check", sql`${table.statusCode} BETWEEN 100 AND 599`),
  check("ops_request_telemetry_latency_check", sql`${table.latencyMs} BETWEEN 0 AND 3600000`),
  check("ops_request_telemetry_route_check", sql`${table.routeTemplate} LIKE '/api/v1/%' AND length(${table.routeTemplate}) BETWEEN 9 AND 160`),
]);

export const opsIdempotencyReceipts = sqliteTable("ops_idempotency_receipts", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => opsOrganizations.id),
  actorUserId: text("actor_user_id").notNull().references(() => opsUsers.id),
  actionScope: text("action_scope").notNull(),
  idempotencyKeyHash: text("idempotency_key_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  responseJson: text("response_json").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
}, (table) => [
  uniqueIndex("ops_receipts_scope_unique").on(table.organizationId, table.actorUserId, table.actionScope, table.idempotencyKeyHash),
  index("ops_receipts_expiry_idx").on(table.expiresAt),
]);

export const opsWriteGuards = sqliteTable("ops_write_guards", {
  id: text("id").primaryKey(),
  passed: integer("passed").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [check("ops_write_guards_passed_check", sql`${table.passed} = 1`)]);
