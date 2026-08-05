import migration0007 from "@/drizzle/0007_classroom_courses.sql?raw";
import { env } from "cloudflare:workers";
import {
  CLASSROOM_DEFAULT_COURSES,
  courseNameKey,
  currentAcademicTerm,
  normalizeCourseName,
  type ClassroomCourse,
  type ClassroomRole,
} from "@/lib/classroom-domain";
import {
  isNtubEmail,
  resolveExternalOperationsIdentity,
  type ExternalOperationsIdentity,
  type OperationsEnvironment,
} from "@/lib/operations-auth";
import { normalizeEmail } from "@/lib/operations-domain";

export type ClassroomEnvironment = OperationsEnvironment & {
  CLASSROOM_TEACHER_EMAILS?: string;
};

export type ClassroomActor = {
  id: string;
  email: string;
  displayName: string;
  role: ClassroomRole;
};

const DEFAULT_TEACHER_EMAILS = ["wy.lee@ntub.edu.tw"] as const;
const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
let schemaReady: Promise<void> | null = null;

export function classroomEnvironment(): CloudflareEnv & ClassroomEnvironment {
  return env as unknown as CloudflareEnv & ClassroomEnvironment;
}

export function classroomDb(): D1Database {
  const db = classroomEnvironment().DB;
  if (!db) throw new Error("Cloudflare D1 binding DB is unavailable.");
  return db;
}

export function classroomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function classroomNow(): string {
  return new Date().toISOString();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function migrationStatements(): string[] {
  return migration0007
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function ensureClassroomSchema(db = classroomDb()): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.batch(migrationStatements().map((statement) => db.prepare(statement)));
      const tables = await db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('classroom_users', 'classroom_courses', 'classroom_course_members', 'classroom_seed_state', 'classroom_audit_events') ORDER BY name",
      ).all<{ name: string }>();
      if (tables.results.length !== 5) throw new Error("The classroom database schema is incomplete.");
      await db.prepare("PRAGMA optimize").run();
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

function configuredTeacherEmails(environment: ClassroomEnvironment): Set<string> {
  const configured = environment.CLASSROOM_TEACHER_EMAILS?.split(",") ?? [];
  const bootstrap = environment.CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL
    ? [environment.CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL]
    : [];
  return new Set([...DEFAULT_TEACHER_EMAILS, ...configured, ...bootstrap]
    .map((email) => normalizeEmail(email))
    .filter((email): email is string => Boolean(email)));
}

function classroomRoleForIdentity(identity: ExternalOperationsIdentity, environment: ClassroomEnvironment): ClassroomRole | null {
  const email = normalizeEmail(identity.email);
  if (!email) return null;
  if (configuredTeacherEmails(environment).has(email)) return "teacher";
  if (identity.isLocal && identity.localRole === "admin") return "teacher";
  return isNtubEmail(email) ? "student" : null;
}

export async function loadOrProvisionClassroomActor(request: Request): Promise<ClassroomActor | null> {
  const environment = classroomEnvironment();
  const identity = resolveExternalOperationsIdentity(request, environment);
  if (!identity) return null;
  const email = normalizeEmail(identity.email);
  const provisionedRole = classroomRoleForIdentity(identity, environment);
  if (!email || !provisionedRole) return null;

  const db = classroomDb();
  await ensureClassroomSchema(db);
  const id = `class-user-${(await sha256(email)).slice(0, 24)}`;
  const now = classroomNow();
  const displayName = (identity.displayName.trim() || email).slice(0, 120);
  await db.prepare(
    `INSERT INTO classroom_users (id, email, display_name, role, status, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       display_name = excluded.display_name,
       role = CASE WHEN classroom_users.role = 'teacher' THEN 'teacher' ELSE excluded.role END,
       last_seen_at = excluded.last_seen_at`,
  ).bind(id, email, displayName, provisionedRole, now, now).run();

  const actor = await db.prepare(
    "SELECT id, email, display_name, role FROM classroom_users WHERE email = ? AND status = 'active'",
  ).bind(email).first<{ id: string; email: string; display_name: string; role: string }>();
  if (!actor || (actor.role !== "teacher" && actor.role !== "student")) return null;
  const result: ClassroomActor = {
    id: actor.id,
    email: actor.email,
    displayName: actor.display_name,
    role: actor.role,
  };
  if (result.role === "teacher") await seedTeacherCourses(db, result);
  return result;
}

async function seedTeacherCourses(db: D1Database, actor: ClassroomActor): Promise<void> {
  const seeded = await db.prepare("SELECT user_id FROM classroom_seed_state WHERE user_id = ?")
    .bind(actor.id)
    .first<{ user_id: string }>();
  if (seeded) return;
  const now = classroomNow();
  const { academicYear, term } = currentAcademicTerm(new Date(now));
  const statements: D1PreparedStatement[] = [];
  for (const name of CLASSROOM_DEFAULT_COURSES) {
    const key = courseNameKey(name);
    const courseId = `course-${(await sha256(`${actor.id}|${academicYear}|${term}|${key}`)).slice(0, 24)}`;
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO classroom_courses
          (id, owner_user_id, name, name_key, academic_year, term, status, version, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL)`,
      ).bind(courseId, actor.id, name, key, academicYear, term, now, now),
      db.prepare(
        `INSERT OR IGNORE INTO classroom_course_members
          (id, course_id, user_id, role, status, joined_at, updated_at)
         VALUES (?, ?, ?, 'teacher', 'active', ?, ?)`,
      ).bind(`course-member-${(await sha256(`${courseId}|${actor.id}`)).slice(0, 24)}`, courseId, actor.id, now, now),
    );
  }
  statements.push(
    db.prepare("INSERT OR IGNORE INTO classroom_seed_state (user_id, seeded_at) VALUES (?, ?)").bind(actor.id, now),
  );
  await db.batch(statements);
}

function mapCourse(row: {
  id: string;
  name: string;
  academic_year: number;
  term: string;
  version: number;
  created_at: string;
  updated_at: string;
}): ClassroomCourse {
  if (row.term !== "1" && row.term !== "2" && row.term !== "summer") {
    throw new Error("A course has an unsupported academic term.");
  }
  return {
    id: row.id,
    name: row.name,
    academicYear: row.academic_year,
    term: row.term,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COURSE_SELECT = `SELECT c.id, c.name, c.academic_year, c.term, c.version, c.created_at, c.updated_at
  FROM classroom_courses c
  JOIN classroom_course_members m ON m.course_id = c.id
  WHERE m.user_id = ? AND m.status = 'active' AND c.status = 'active'`;

export async function listClassroomCourses(db: D1Database, actor: ClassroomActor): Promise<ClassroomCourse[]> {
  const rows = await db.prepare(`${COURSE_SELECT} ORDER BY c.updated_at DESC, c.name_key`)
    .bind(actor.id)
    .all<Parameters<typeof mapCourse>[0]>();
  return rows.results.map(mapCourse);
}

export async function getClassroomCourse(db: D1Database, actor: ClassroomActor, courseId: string): Promise<ClassroomCourse | null> {
  const row = await db.prepare(`${COURSE_SELECT} AND c.id = ? LIMIT 1`)
    .bind(actor.id, courseId)
    .first<Parameters<typeof mapCourse>[0]>();
  return row ? mapCourse(row) : null;
}

export async function createClassroomCourse(db: D1Database, actor: ClassroomActor, nameValue: unknown): Promise<ClassroomCourse> {
  const name = normalizeCourseName(nameValue);
  const nameKey = courseNameKey(name);
  const now = classroomNow();
  const { academicYear, term } = currentAcademicTerm(new Date(now));
  const courseId = classroomId("course");
  const memberId = classroomId("course-member");
  const auditId = classroomId("class-audit");
  await db.batch([
    db.prepare(
      `INSERT INTO classroom_courses
        (id, owner_user_id, name, name_key, academic_year, term, status, version, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL)`,
    ).bind(courseId, actor.id, name, nameKey, academicYear, term, now, now),
    db.prepare(
      `INSERT INTO classroom_course_members
        (id, course_id, user_id, role, status, joined_at, updated_at)
       VALUES (?, ?, ?, 'teacher', 'active', ?, ?)`,
    ).bind(memberId, courseId, actor.id, now, now),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'course.create', 'course', ?, ?, ?)`,
    ).bind(auditId, actor.id, courseId, JSON.stringify({ name }), now),
  ]);
  const course = await getClassroomCourse(db, actor, courseId);
  if (!course) throw new Error("The created course could not be read.");
  return course;
}

export async function renameClassroomCourse(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  nameValue: unknown,
  expectedVersion: number,
): Promise<ClassroomCourse | null> {
  const current = await getClassroomCourse(db, actor, courseId);
  if (!current) return null;
  const name = normalizeCourseName(nameValue);
  const now = classroomNow();
  const result = await db.prepare(
    `UPDATE classroom_courses
     SET name = ?, name_key = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND owner_user_id = ? AND status = 'active' AND version = ?`,
  ).bind(name, courseNameKey(name), now, courseId, actor.id, expectedVersion).run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  await db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'course.rename', 'course', ?, ?, ?)`,
  ).bind(classroomId("class-audit"), actor.id, courseId, JSON.stringify({ from: current.name, to: name }), now).run();
  return getClassroomCourse(db, actor, courseId);
}

export async function deleteClassroomCourse(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  expectedVersion: number,
): Promise<boolean> {
  const current = await getClassroomCourse(db, actor, courseId);
  if (!current) return false;
  const now = classroomNow();
  const result = await db.prepare(
    `UPDATE classroom_courses
     SET status = 'deleted', deleted_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND owner_user_id = ? AND status = 'active' AND version = ?`,
  ).bind(now, now, courseId, actor.id, expectedVersion).run();
  if ((result.meta.changes ?? 0) !== 1) return false;
  await db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'course.delete', 'course', ?, ?, ?)`,
  ).bind(classroomId("class-audit"), actor.id, courseId, JSON.stringify({ name: current.name }), now).run();
  return true;
}
