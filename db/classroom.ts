import migration0001 from "@/drizzle/0001_classroom_courses.sql?raw";
import migration0002 from "@/drizzle/0002_classroom_access_approval.sql?raw";
import { env } from "cloudflare:workers";
import { classroomIdentityKind, normalizeClassroomEmail } from "@/lib/classroom-access";
import { resolveClassroomIdentity, type ClassroomEnvironment } from "@/lib/classroom-auth";
import {
  CLASSROOM_DEFAULT_COURSES,
  courseNameKey,
  currentAcademicTerm,
  normalizeCourseName,
  type ClassroomCourse,
  type ClassroomRole,
} from "@/lib/classroom-domain";

export type ClassroomActor = {
  id: string;
  email: string;
  displayName: string;
  role: ClassroomRole;
  isAdmin: boolean;
};

export type ClassroomAccessStatus = "pending" | "approved" | "rejected";

export type ClassroomAccessRequest = {
  id: string;
  email: string;
  displayName: string;
  status: ClassroomAccessStatus;
  version: number;
  requestedAt: string;
  lastRequestedAt: string;
  reviewedAt: string | null;
  reviewedByEmail: string | null;
};

export type ClassroomAllowlistEntry = {
  email: string;
  displayName: string;
  approvedAt: string;
  approvedByEmail: string;
};

export type ClassroomAccessFailureReason = "domain_not_allowed" | "approval_pending" | "approval_rejected";

export class ClassroomAccessError extends Error {
  readonly reason: ClassroomAccessFailureReason;

  constructor(reason: ClassroomAccessFailureReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = "ClassroomAccessError";
  }
}

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
  return [migration0001, migration0002]
    .join(`\n${STATEMENT_BREAKPOINT}\n`)
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function ensureClassroomSchema(db = classroomDb()): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.batch(migrationStatements().map((statement) => db.prepare(statement)));
      const tables = await db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('classroom_users', 'classroom_courses', 'classroom_course_members', 'classroom_seed_state', 'classroom_audit_events', 'classroom_access_requests', 'classroom_access_allowlist') ORDER BY name",
      ).all<{ name: string }>();
      if (tables.results.length !== 7) throw new Error("The classroom database schema is incomplete.");
      await db.prepare("PRAGMA optimize").run();
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export async function loadOrProvisionClassroomActor(request: Request): Promise<ClassroomActor | null> {
  const environment = classroomEnvironment();
  const identity = resolveClassroomIdentity(request, environment);
  if (!identity) return null;
  const email = normalizeClassroomEmail(identity.email);
  if (!email) return null;
  const identityKind = classroomIdentityKind(email, environment.CLASSROOM_ADMIN_EMAILS);
  if (identityKind === "ineligible") {
    throw new ClassroomAccessError("domain_not_allowed", "僅開放 @ntub.edu.tw 帳號登入。");
  }
  const isAdmin = identityKind === "administrator";
  const provisionedRole: ClassroomRole = isAdmin ? "teacher" : "student";

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
    isAdmin,
  };
  if (!isAdmin) {
    const allowlisted = await db.prepare(
      "SELECT email FROM classroom_access_allowlist WHERE email = ? AND user_id = ? AND status = 'active'",
    ).bind(email, result.id).first<{ email: string }>();
    if (!allowlisted) {
      const request = await recordClassroomAccessRequest(db, result);
      if (request.status === "rejected") {
        throw new ClassroomAccessError("approval_rejected", "此帳號的使用申請尚未獲准，請洽系統管理員。");
      }
      throw new ClassroomAccessError("approval_pending", "申請已送出，系統管理員核准後即可使用。");
    }
  }
  if (isAdmin) await seedTeacherCourses(db, result);
  return result;
}

async function recordClassroomAccessRequest(db: D1Database, actor: ClassroomActor): Promise<{ status: ClassroomAccessStatus }> {
  const now = classroomNow();
  await db.prepare(
    `INSERT INTO classroom_access_requests
      (id, user_id, email, display_name, status, version, requested_at, last_requested_at, reviewed_by_user_id, reviewed_at)
     VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, NULL, NULL)
     ON CONFLICT(email) DO UPDATE SET
       display_name = excluded.display_name,
       last_requested_at = excluded.last_requested_at`,
  ).bind(classroomId("access-request"), actor.id, actor.email, actor.displayName, now, now).run();
  const request = await db.prepare(
    "SELECT status FROM classroom_access_requests WHERE email = ?",
  ).bind(actor.email).first<{ status: ClassroomAccessStatus }>();
  if (!request) throw new Error("The access request could not be read.");
  return request;
}

async function seedTeacherCourses(db: D1Database, actor: ClassroomActor): Promise<void> {
  const seeded = await db.prepare("SELECT user_id FROM classroom_seed_state LIMIT 1")
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

const MEMBER_COURSE_SELECT = `SELECT c.id, c.name, c.academic_year, c.term, c.version, c.created_at, c.updated_at
  FROM classroom_courses c
  JOIN classroom_course_members m ON m.course_id = c.id
  WHERE m.user_id = ? AND m.status = 'active' AND c.status = 'active'`;

const ADMIN_COURSE_SELECT = `SELECT c.id, c.name, c.academic_year, c.term, c.version, c.created_at, c.updated_at
  FROM classroom_courses c
  WHERE c.status = 'active'`;

export async function listClassroomCourses(db: D1Database, actor: ClassroomActor): Promise<ClassroomCourse[]> {
  const statement = actor.isAdmin
    ? db.prepare(`${ADMIN_COURSE_SELECT} ORDER BY c.updated_at DESC, c.name_key`)
    : db.prepare(`${MEMBER_COURSE_SELECT} ORDER BY c.updated_at DESC, c.name_key`).bind(actor.id);
  const rows = await statement
    .all<Parameters<typeof mapCourse>[0]>();
  return rows.results.map(mapCourse);
}

export async function getClassroomCourse(db: D1Database, actor: ClassroomActor, courseId: string): Promise<ClassroomCourse | null> {
  const statement = actor.isAdmin
    ? db.prepare(`${ADMIN_COURSE_SELECT} AND c.id = ? LIMIT 1`).bind(courseId)
    : db.prepare(`${MEMBER_COURSE_SELECT} AND c.id = ? LIMIT 1`).bind(actor.id, courseId);
  const row = await statement
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
     WHERE id = ? AND status = 'active' AND version = ?`,
  ).bind(name, courseNameKey(name), now, courseId, expectedVersion).run();
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
     WHERE id = ? AND status = 'active' AND version = ?`,
  ).bind(now, now, courseId, expectedVersion).run();
  if ((result.meta.changes ?? 0) !== 1) return false;
  await db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'course.delete', 'course', ?, ?, ?)`,
  ).bind(classroomId("class-audit"), actor.id, courseId, JSON.stringify({ name: current.name }), now).run();
  return true;
}

export async function listClassroomAccessRequests(
  db: D1Database,
  actor: ClassroomActor,
): Promise<{ requests: ClassroomAccessRequest[]; allowlist: ClassroomAllowlistEntry[] }> {
  if (!actor.isAdmin) throw new ClassroomAccessError("domain_not_allowed", "只有系統管理員可以審核登入申請。");
  const [requestRows, allowlistRows] = await Promise.all([
    db.prepare(
      `SELECT r.id, r.email, r.display_name, r.status, r.version, r.requested_at,
              r.last_requested_at, r.reviewed_at, reviewer.email AS reviewed_by_email
       FROM classroom_access_requests r
       LEFT JOIN classroom_users reviewer ON reviewer.id = r.reviewed_by_user_id
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                r.last_requested_at DESC`,
    ).all<{
      id: string; email: string; display_name: string; status: ClassroomAccessStatus; version: number;
      requested_at: string; last_requested_at: string; reviewed_at: string | null; reviewed_by_email: string | null;
    }>(),
    db.prepare(
      `SELECT a.email, u.display_name, a.approved_at, approver.email AS approved_by_email
       FROM classroom_access_allowlist a
       JOIN classroom_users u ON u.id = a.user_id
       JOIN classroom_users approver ON approver.id = a.approved_by_user_id
       WHERE a.status = 'active'
       ORDER BY a.approved_at DESC`,
    ).all<{ email: string; display_name: string; approved_at: string; approved_by_email: string }>(),
  ]);
  return {
    requests: requestRows.results.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      status: row.status,
      version: row.version,
      requestedAt: row.requested_at,
      lastRequestedAt: row.last_requested_at,
      reviewedAt: row.reviewed_at,
      reviewedByEmail: row.reviewed_by_email,
    })),
    allowlist: allowlistRows.results.map((row) => ({
      email: row.email,
      displayName: row.display_name,
      approvedAt: row.approved_at,
      approvedByEmail: row.approved_by_email,
    })),
  };
}

export async function reviewClassroomAccessRequest(
  db: D1Database,
  actor: ClassroomActor,
  requestId: string,
  action: "approve" | "reject",
  expectedVersion: number,
): Promise<ClassroomAccessRequest | null> {
  if (!actor.isAdmin) throw new ClassroomAccessError("domain_not_allowed", "只有系統管理員可以審核登入申請。");
  const current = await db.prepare(
    `SELECT id, user_id, email, display_name, status, version, requested_at, last_requested_at
     FROM classroom_access_requests WHERE id = ?`,
  ).bind(requestId).first<{
    id: string; user_id: string; email: string; display_name: string; status: ClassroomAccessStatus;
    version: number; requested_at: string; last_requested_at: string;
  }>();
  if (!current || current.version !== expectedVersion) return null;

  const status: ClassroomAccessStatus = action === "approve" ? "approved" : "rejected";
  const now = classroomNow();
  const nextVersion = expectedVersion + 1;
  const updated = await db.prepare(
    `UPDATE classroom_access_requests
     SET status = ?, version = version + 1, reviewed_by_user_id = ?, reviewed_at = ?
     WHERE id = ? AND version = ?`,
  ).bind(status, actor.id, now, requestId, expectedVersion).run();
  if ((updated.meta.changes ?? 0) !== 1) return null;

  const auditId = `class-audit-access-${requestId}-${nextVersion}`;
  const followUp: D1PreparedStatement[] = action === "approve"
    ? [
        db.prepare(
          `INSERT INTO classroom_access_allowlist
            (email, user_id, status, approved_by_user_id, approved_at, updated_at)
           VALUES (?, ?, 'active', ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             user_id = excluded.user_id,
             status = 'active',
             approved_by_user_id = excluded.approved_by_user_id,
             approved_at = excluded.approved_at,
             updated_at = excluded.updated_at`,
        ).bind(current.email, current.user_id, actor.id, now, now),
      ]
    : [
        db.prepare("DELETE FROM classroom_access_allowlist WHERE email = ?").bind(current.email),
      ];
  followUp.push(
    db.prepare(
      `INSERT OR IGNORE INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, ?, 'access_request', ?, ?, ?)`,
    ).bind(auditId, actor.id, `access.${action}`, requestId, JSON.stringify({ email: current.email }), now),
  );
  await db.batch(followUp);

  const result = await db.prepare(
    `SELECT r.id, r.email, r.display_name, r.status, r.version, r.requested_at,
            r.last_requested_at, r.reviewed_at, reviewer.email AS reviewed_by_email
     FROM classroom_access_requests r
     LEFT JOIN classroom_users reviewer ON reviewer.id = r.reviewed_by_user_id
     WHERE r.id = ?`,
  ).bind(requestId).first<{
    id: string; email: string; display_name: string; status: ClassroomAccessStatus; version: number;
    requested_at: string; last_requested_at: string; reviewed_at: string | null; reviewed_by_email: string | null;
  }>();
  return result ? {
    id: result.id,
    email: result.email,
    displayName: result.display_name,
    status: result.status,
    version: result.version,
    requestedAt: result.requested_at,
    lastRequestedAt: result.last_requested_at,
    reviewedAt: result.reviewed_at,
    reviewedByEmail: result.reviewed_by_email,
  } : null;
}
