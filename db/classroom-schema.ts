import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const classroomUsers = sqliteTable("classroom_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role", { enum: ["teacher", "student"] }).notNull(),
  status: text("status", { enum: ["active", "suspended"] }).notNull().default("active"),
  createdAt: text("created_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
  uniqueIndex("classroom_users_email_unique").on(table.email),
  check("classroom_users_role_check", sql`${table.role} IN ('teacher', 'student')`),
]);

export const classroomCourses = sqliteTable("classroom_courses", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id").notNull().references(() => classroomUsers.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  nameKey: text("name_key").notNull(),
  academicYear: integer("academic_year").notNull(),
  term: text("term", { enum: ["1", "2", "summer"] }).notNull(),
  defaultGroupCapacity: integer("default_group_capacity").notNull().default(5),
  status: text("status", { enum: ["active", "deleted"] }).notNull().default("active"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
}, (table) => [
  index("classroom_courses_owner_status_idx").on(table.ownerUserId, table.status, table.updatedAt),
  check("classroom_courses_version_check", sql`${table.version} >= 1`),
  check("classroom_courses_group_capacity_check", sql`${table.defaultGroupCapacity} BETWEEN 2 AND 20`),
]);

export const classroomCourseMembers = sqliteTable("classroom_course_members", {
  id: text("id").primaryKey(),
  courseId: text("course_id").notNull().references(() => classroomCourses.id, { onDelete: "restrict" }),
  userId: text("user_id").notNull().references(() => classroomUsers.id, { onDelete: "restrict" }),
  role: text("role", { enum: ["teacher", "student"] }).notNull(),
  status: text("status", { enum: ["active", "removed"] }).notNull().default("active"),
  joinedAt: text("joined_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("classroom_course_members_course_user_unique").on(table.courseId, table.userId),
  index("classroom_course_members_user_status_idx").on(table.userId, table.status),
]);

export const classroomSeedState = sqliteTable("classroom_seed_state", {
  userId: text("user_id").primaryKey().references(() => classroomUsers.id, { onDelete: "restrict" }),
  seededAt: text("seeded_at").notNull(),
});

export const classroomAuditEvents = sqliteTable("classroom_audit_events", {
  id: text("id").primaryKey(),
  actorUserId: text("actor_user_id").notNull().references(() => classroomUsers.id, { onDelete: "restrict" }),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  detailsJson: text("details_json").notNull().default("{}"),
  occurredAt: text("occurred_at").notNull(),
}, (table) => [index("classroom_audit_events_actor_time_idx").on(table.actorUserId, table.occurredAt)]);

export const classroomAccessRequests = sqliteTable("classroom_access_requests", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => classroomUsers.id, { onDelete: "restrict" }),
  email: text("email").notNull(),
  displayName: text("display_name").notNull(),
  status: text("status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  version: integer("version").notNull().default(1),
  requestedAt: text("requested_at").notNull(),
  lastRequestedAt: text("last_requested_at").notNull(),
  reviewedByUserId: text("reviewed_by_user_id").references(() => classroomUsers.id, { onDelete: "restrict" }),
  reviewedAt: text("reviewed_at"),
}, (table) => [
  uniqueIndex("classroom_access_requests_user_unique").on(table.userId),
  uniqueIndex("classroom_access_requests_email_unique").on(table.email),
  index("classroom_access_requests_status_time_idx").on(table.status, table.lastRequestedAt),
  check("classroom_access_requests_version_check", sql`${table.version} >= 1`),
]);

export const classroomAccessAllowlist = sqliteTable("classroom_access_allowlist", {
  email: text("email").primaryKey(),
  userId: text("user_id").notNull().references(() => classroomUsers.id, { onDelete: "restrict" }),
  status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
  approvedByUserId: text("approved_by_user_id").notNull().references(() => classroomUsers.id, { onDelete: "restrict" }),
  approvedAt: text("approved_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("classroom_access_allowlist_user_unique").on(table.userId),
  index("classroom_access_allowlist_status_time_idx").on(table.status, table.approvedAt),
]);

export const classroomSessions = sqliteTable("classroom_sessions", {
  id: text("id").primaryKey(),
  courseId: text("course_id").notNull().references(() => classroomCourses.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  question: text("question").notNull(),
  rankingCriteria: text("ranking_criteria").notNull(),
  joinCode: text("join_code").notNull(),
  phase: text("phase", { enum: ["check_in", "grouping", "answering", "presenting", "ranking", "results", "archived"] }).notNull().default("check_in"),
  groupCapacity: integer("group_capacity").notNull(),
  effectiveGroupCapacity: integer("effective_group_capacity").notNull(),
  anonymousGroups: integer("anonymous_groups", { mode: "boolean" }).notNull().default(true),
  allowRankingEdits: integer("allow_ranking_edits", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull().references(() => classroomUsers.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("classroom_sessions_join_code_unique").on(table.joinCode),
  uniqueIndex("classroom_sessions_course_active_unique").on(table.courseId).where(sql`${table.phase} != 'archived'`),
  index("classroom_sessions_course_created_idx").on(table.courseId, table.createdAt),
  check("classroom_sessions_capacity_check", sql`${table.groupCapacity} BETWEEN 2 AND 20 AND ${table.effectiveGroupCapacity} BETWEEN ${table.groupCapacity} AND 50`),
  check("classroom_sessions_version_check", sql`${table.version} >= 1`),
]);

export const classroomGroups = sqliteTable("classroom_groups", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => classroomSessions.id, { onDelete: "restrict" }),
  label: text("label").notNull(),
  position: integer("position").notNull(),
  representativeUserId: text("representative_user_id").references(() => classroomUsers.id, { onDelete: "restrict" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("classroom_groups_session_label_unique").on(table.sessionId, table.label),
  uniqueIndex("classroom_groups_session_position_unique").on(table.sessionId, table.position),
]);

export const classroomSessionParticipants = sqliteTable("classroom_session_participants", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => classroomSessions.id, { onDelete: "restrict" }),
  userId: text("user_id").notNull().references(() => classroomUsers.id, { onDelete: "restrict" }),
  groupId: text("group_id").references(() => classroomGroups.id, { onDelete: "restrict" }),
  attendance: text("attendance", { enum: ["on_time", "late"] }).notNull(),
  joinedPhase: text("joined_phase").notNull(),
  canRank: integer("can_rank", { mode: "boolean" }).notNull().default(true),
  checkedInAt: text("checked_in_at").notNull(),
  groupedAt: text("grouped_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("classroom_session_participants_session_user_unique").on(table.sessionId, table.userId),
  index("classroom_session_participants_group_idx").on(table.groupId, table.checkedInAt),
]);

export const classroomGroupResponses = sqliteTable("classroom_group_responses", {
  groupId: text("group_id").primaryKey().references(() => classroomGroups.id, { onDelete: "restrict" }),
  content: text("content").notNull().default(""),
  status: text("status", { enum: ["draft", "submitted", "locked"] }).notNull().default("draft"),
  version: integer("version").notNull().default(1),
  updatedByUserId: text("updated_by_user_id").references(() => classroomUsers.id, { onDelete: "restrict" }),
  submittedAt: text("submitted_at"),
  updatedAt: text("updated_at"),
}, (table) => [check("classroom_group_responses_version_check", sql`${table.version} >= 1`)]);

export const classroomRankingSubmissions = sqliteTable("classroom_ranking_submissions", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => classroomSessions.id, { onDelete: "restrict" }),
  userId: text("user_id").notNull().references(() => classroomUsers.id, { onDelete: "restrict" }),
  version: integer("version").notNull(),
  isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(true),
  status: text("status", { enum: ["valid", "invalid"] }).notNull().default("valid"),
  invalidReason: text("invalid_reason"),
  submittedAt: text("submitted_at").notNull(),
}, (table) => [
  uniqueIndex("classroom_ranking_submissions_user_version_unique").on(table.sessionId, table.userId, table.version),
  uniqueIndex("classroom_ranking_submissions_current_unique").on(table.sessionId, table.userId).where(sql`${table.isCurrent} = 1`),
  index("classroom_ranking_submissions_session_status_idx").on(table.sessionId, table.isCurrent, table.status),
]);

export const classroomRankingItems = sqliteTable("classroom_ranking_items", {
  id: text("id").primaryKey(),
  submissionId: text("submission_id").notNull().references(() => classroomRankingSubmissions.id, { onDelete: "restrict" }),
  groupId: text("group_id").notNull().references(() => classroomGroups.id, { onDelete: "restrict" }),
  rank: integer("rank").notNull(),
  isOwnGroup: integer("is_own_group", { mode: "boolean" }).notNull().default(false),
}, (table) => [
  uniqueIndex("classroom_ranking_items_submission_group_unique").on(table.submissionId, table.groupId),
  uniqueIndex("classroom_ranking_items_submission_rank_unique").on(table.submissionId, table.rank),
  index("classroom_ranking_items_group_rank_idx").on(table.groupId, table.rank),
  check("classroom_ranking_items_rank_check", sql`${table.rank} >= 1`),
]);

export const classroomRateLimits = sqliteTable("classroom_rate_limits", {
  scopeKey: text("scope_key").primaryKey(),
  windowStartedAt: integer("window_started_at").notNull(),
  requestCount: integer("request_count").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [check("classroom_rate_limits_count_check", sql`${table.requestCount} >= 1`)]);
