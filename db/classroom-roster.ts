import { classroomId, classroomNow, getClassroomCourse, type ClassroomActor } from "./classroom";
import type { ClassroomRosterDraft } from "../lib/classroom-roster";

export type ClassroomRosterEntry = ClassroomRosterDraft & {
  id: string;
  sourceFileName: string;
  importedAt: string;
};

export type ClassroomRosterPreview = {
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
};

type RosterRow = {
  id: string;
  student_id: string;
  email: string;
  display_name: string;
  source_file_name: string;
  imported_at: string;
};

function mapRosterEntry(row: RosterRow): ClassroomRosterEntry {
  return {
    id: row.id,
    studentId: row.student_id,
    email: row.email,
    displayName: row.display_name,
    sourceFileName: row.source_file_name,
    importedAt: row.imported_at,
  };
}

async function requireManagedCourse(db: D1Database, actor: ClassroomActor, courseId: string): Promise<void> {
  if (!actor.isAdmin || !(await getClassroomCourse(db, actor, courseId))) {
    throw new Error("COURSE_ROSTER_MANAGEMENT_REQUIRED");
  }
}

export async function listClassroomCourseRoster(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
): Promise<ClassroomRosterEntry[]> {
  await requireManagedCourse(db, actor, courseId);
  const rows = await db.prepare(
    `SELECT id, student_id, email, display_name, source_file_name, imported_at
     FROM classroom_course_roster
     WHERE course_id = ? AND status = 'active'
     ORDER BY student_id`,
  ).bind(courseId).all<RosterRow>();
  return rows.results.map(mapRosterEntry);
}

export async function previewClassroomCourseRoster(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  entries: ClassroomRosterDraft[],
): Promise<ClassroomRosterPreview> {
  const current = await listClassroomCourseRoster(db, actor, courseId);
  const currentById = new Map(current.map((entry) => [entry.studentId, entry]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const entry of entries) {
    const previous = currentById.get(entry.studentId);
    if (!previous) added += 1;
    else if (previous.email !== entry.email || previous.displayName !== entry.displayName) updated += 1;
    else unchanged += 1;
  }
  const incomingIds = new Set(entries.map((entry) => entry.studentId));
  return {
    total: entries.length,
    added,
    updated,
    unchanged,
    removed: current.filter((entry) => !incomingIds.has(entry.studentId)).length,
  };
}

export async function replaceClassroomCourseRoster(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  entries: ClassroomRosterDraft[],
  sourceFileName: string,
): Promise<{ roster: ClassroomRosterEntry[]; preview: ClassroomRosterPreview }> {
  await requireManagedCourse(db, actor, courseId);
  const preview = await previewClassroomCourseRoster(db, actor, courseId, entries);
  const now = classroomNow();
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE classroom_course_roster SET status = 'removed', updated_at = ? WHERE course_id = ? AND status = 'active'")
      .bind(now, courseId),
  ];
  for (let offset = 0; offset < entries.length; offset += 10) {
    const chunk = entries.slice(offset, offset + 10);
    const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)").join(", ");
    const values = chunk.flatMap((entry) => [
      classroomId("roster"), courseId, entry.studentId, entry.email, entry.displayName,
      sourceFileName, actor.id, now, now,
    ]);
    statements.push(db.prepare(
      `INSERT INTO classroom_course_roster
        (id, course_id, student_id, email, display_name, status, source_file_name, imported_by_user_id, imported_at, updated_at)
       VALUES ${placeholders}
       ON CONFLICT(course_id, student_id) DO UPDATE SET
         email = excluded.email,
         display_name = excluded.display_name,
         status = 'active',
         source_file_name = excluded.source_file_name,
         imported_by_user_id = excluded.imported_by_user_id,
         imported_at = excluded.imported_at,
         updated_at = excluded.updated_at`,
    ).bind(...values));
  }
  statements.push(db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'course.roster.replace', 'course', ?, ?, ?)`,
  ).bind(classroomId("class-audit"), actor.id, courseId, JSON.stringify({ ...preview, sourceFileName }), now));
  await db.batch(statements);
  return { roster: await listClassroomCourseRoster(db, actor, courseId), preview };
}
