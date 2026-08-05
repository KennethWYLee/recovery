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
  status: text("status", { enum: ["active", "deleted"] }).notNull().default("active"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  deletedAt: text("deleted_at"),
}, (table) => [
  index("classroom_courses_owner_status_idx").on(table.ownerUserId, table.status, table.updatedAt),
  check("classroom_courses_version_check", sql`${table.version} >= 1`),
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
