import { classroomId, classroomNow, getClassroomCourse, type ClassroomActor } from "./classroom";
import type { ClassroomQuestionBankDraft } from "../lib/classroom-question-bank";
import type { ClassroomQuestionBankItem } from "../lib/classroom-domain";

type QuestionBankRow = {
  id: string;
  course_id: string;
  title: string;
  category: string;
  question_text: string;
  ranking_criteria: string;
  status: "draft" | "ready";
  usage_count: number;
  last_used_at: string | null;
  used_in_current_session: number;
  version: number;
  created_at: string;
  updated_at: string;
};

function mapQuestionBankItem(row: QuestionBankRow): ClassroomQuestionBankItem {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    category: row.category,
    questionText: row.question_text,
    rankingCriteria: row.ranking_criteria,
    status: row.status,
    usageCount: row.usage_count,
    lastUsedAt: row.last_used_at,
    usedInCurrentSession: row.used_in_current_session === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function requireManagedCourse(db: D1Database, actor: ClassroomActor, courseId: string): Promise<void> {
  if (!actor.isAdmin || !(await getClassroomCourse(db, actor, courseId))) {
    throw new Error("COURSE_QUESTION_BANK_MANAGEMENT_REQUIRED");
  }
}

const QUESTION_BANK_COLUMNS = `id, course_id, title, category, question_text, ranking_criteria,
  status, usage_count, last_used_at, version, created_at, updated_at`;

export async function listClassroomQuestionBank(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  options: { readyOnly?: boolean; sessionId?: string } = {},
): Promise<ClassroomQuestionBankItem[]> {
  await requireManagedCourse(db, actor, courseId);
  const sessionId = options.sessionId ?? "";
  const rows = await db.prepare(
    `SELECT ${QUESTION_BANK_COLUMNS},
       CASE WHEN EXISTS (
         SELECT 1 FROM classroom_questions q
         JOIN classroom_sessions s ON s.id = q.session_id
         WHERE q.session_id = ? AND s.course_id = classroom_course_question_bank.course_id
           AND q.source_question_bank_id = classroom_course_question_bank.id
       ) THEN 1 ELSE 0 END AS used_in_current_session
     FROM classroom_course_question_bank
     WHERE course_id = ? AND status != 'archived'${options.readyOnly ? " AND status = 'ready'" : ""}
     ORDER BY updated_at DESC, title`,
  ).bind(sessionId, courseId).all<QuestionBankRow>();
  return rows.results.map(mapQuestionBankItem);
}

export async function createClassroomQuestionBankItem(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  draft: ClassroomQuestionBankDraft,
): Promise<ClassroomQuestionBankItem> {
  await requireManagedCourse(db, actor, courseId);
  const id = classroomId("question-bank");
  const now = classroomNow();
  await db.batch([
    db.prepare(
      `INSERT INTO classroom_course_question_bank
        (id, course_id, title, category, question_text, ranking_criteria, status, usage_count,
         last_used_at, version, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, ?, ?, ?)`,
    ).bind(id, courseId, draft.title, draft.category, draft.questionText, draft.rankingCriteria, draft.status, actor.id, now, now),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'course.question_bank.create', 'course_question_bank', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, id, JSON.stringify({ courseId }), now),
  ]);
  const item = await db.prepare(
    `SELECT ${QUESTION_BANK_COLUMNS}, 0 AS used_in_current_session FROM classroom_course_question_bank WHERE id = ?`,
  ).bind(id).first<QuestionBankRow>();
  if (!item) throw new Error("QUESTION_BANK_CREATE_FAILED");
  return mapQuestionBankItem(item);
}

export async function updateClassroomQuestionBankItem(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  itemId: string,
  expectedVersion: number,
  draft: ClassroomQuestionBankDraft,
): Promise<ClassroomQuestionBankItem | "not_found" | "conflict"> {
  await requireManagedCourse(db, actor, courseId);
  const now = classroomNow();
  const result = await db.prepare(
    `UPDATE classroom_course_question_bank
     SET title = ?, category = ?, question_text = ?, ranking_criteria = ?, status = ?,
       version = version + 1, updated_at = ?
     WHERE id = ? AND course_id = ? AND status != 'archived' AND version = ?`,
  ).bind(draft.title, draft.category, draft.questionText, draft.rankingCriteria, draft.status,
    now, itemId, courseId, expectedVersion).run();
  if (result.meta.changes !== 1) {
    const exists = await db.prepare(
      "SELECT version FROM classroom_course_question_bank WHERE id = ? AND course_id = ? AND status != 'archived'",
    ).bind(itemId, courseId).first<{ version: number }>();
    return exists ? "conflict" : "not_found";
  }
  await db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'course.question_bank.update', 'course_question_bank', ?, ?, ?)`,
  ).bind(classroomId("class-audit"), actor.id, itemId, JSON.stringify({ courseId, expectedVersion }), now).run();
  const item = await db.prepare(
    `SELECT ${QUESTION_BANK_COLUMNS}, 0 AS used_in_current_session FROM classroom_course_question_bank WHERE id = ?`,
  ).bind(itemId).first<QuestionBankRow>();
  if (!item) return "not_found";
  return mapQuestionBankItem(item);
}

export async function archiveClassroomQuestionBankItem(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  itemId: string,
  expectedVersion: number,
): Promise<"archived" | "not_found" | "conflict"> {
  await requireManagedCourse(db, actor, courseId);
  const now = classroomNow();
  const result = await db.prepare(
    `UPDATE classroom_course_question_bank
     SET status = 'archived', version = version + 1, updated_at = ?
     WHERE id = ? AND course_id = ? AND status != 'archived' AND version = ?`,
  ).bind(now, itemId, courseId, expectedVersion).run();
  if (result.meta.changes !== 1) {
    const exists = await db.prepare(
      "SELECT version FROM classroom_course_question_bank WHERE id = ? AND course_id = ? AND status != 'archived'",
    ).bind(itemId, courseId).first<{ version: number }>();
    return exists ? "conflict" : "not_found";
  }
  await db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'course.question_bank.archive', 'course_question_bank', ?, ?, ?)`,
  ).bind(classroomId("class-audit"), actor.id, itemId, JSON.stringify({ courseId, expectedVersion }), now).run();
  return "archived";
}
