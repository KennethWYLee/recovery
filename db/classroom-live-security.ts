import type { ClassroomQuestionPhase } from "@/lib/classroom-domain";

export type ClassroomLiveGuardFailure = {
  status: number;
  code: string;
  message: string;
};

export async function questionAdvanceEvidenceFailure(
  db: D1Database,
  phase: ClassroomQuestionPhase,
  questionId: string,
): Promise<ClassroomLiveGuardFailure | null> {
  if (phase !== "ranking" && phase !== "locked") return null;
  const valid = await db.prepare(
    `SELECT COUNT(DISTINCT s.user_id) AS count
     FROM classroom_question_ranking_submissions s
     JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id
     WHERE s.question_id = ? AND s.is_current = 1 AND s.status = 'valid'`,
  ).bind(questionId).first<{ count: number }>();
  const count = valid?.count ?? 0;
  if (count === 0) {
    return { status: 409, code: "NO_RANKINGS", message: "尚未收到任何完整排序。" };
  }
  if (phase === "ranking" || phase === "locked") {
    const teacher = await db.prepare(
      `SELECT 1 AS present FROM classroom_question_ranking_submissions s
       JOIN classroom_questions q ON q.id = s.question_id AND q.created_by_user_id = s.user_id
       WHERE s.question_id = ? AND s.is_current = 1 AND s.status = 'valid' LIMIT 1`,
    ).bind(questionId).first<{ present: number }>();
    if (!teacher) {
      return { status: 409, code: "TEACHER_RANKING_REQUIRED", message: "教師尚未完成本題排序，暫時不能結束排序或公布結果。" };
    }
  }
  return null;
}

type ResponseWriteInput = {
  sessionId: string;
  questionId: string;
  groupId: string;
  actorId: string;
  content: string;
  expectedVersion: number;
  submit: boolean;
  now: string;
  auditId: string;
};

export async function guardedClassroomResponseWrite(
  db: D1Database,
  input: ResponseWriteInput,
): Promise<ClassroomLiveGuardFailure | null> {
  const write = db.prepare(
    `UPDATE classroom_question_responses SET content = ?, status = ?, version = version + 1,
       updated_by_user_id = ?, submitted_at = CASE WHEN ? = 1 THEN ? ELSE NULL END, updated_at = ?
     WHERE question_id = ? AND group_id = ? AND version = ? AND status = 'draft'
       AND EXISTS (
         SELECT 1 FROM classroom_questions q
         WHERE q.id = classroom_question_responses.question_id AND q.session_id = ?
           AND q.phase = 'answering' AND q.answer_deadline_at > ?
       )
       AND EXISTS (
         SELECT 1 FROM classroom_question_memberships m
         JOIN classroom_groups g ON g.id = m.group_id
         WHERE m.question_id = classroom_question_responses.question_id
           AND m.group_id = classroom_question_responses.group_id
           AND m.user_id = ? AND g.representative_user_id = ?
       )`,
  ).bind(
    input.content, input.submit ? "submitted" : "draft", input.actorId, input.submit ? 1 : 0,
    input.now, input.now, input.questionId, input.groupId, input.expectedVersion,
    input.sessionId, input.now, input.actorId, input.actorId,
  );
  const audit = db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     SELECT ?, ?, ?, 'classroom_question', ?, ?, ? WHERE changes() = 1`,
  ).bind(
    input.auditId, input.actorId, input.submit ? "response.submit" : "response.save", input.questionId,
    JSON.stringify({ groupId: input.groupId, version: input.expectedVersion + 1 }), input.now,
  );
  const [result] = await db.batch([write, audit]);
  if ((result.meta.changes ?? 0) === 1) return null;

  const [question, response] = await Promise.all([
    db.prepare("SELECT phase, answer_deadline_at FROM classroom_questions WHERE id = ? AND session_id = ?")
      .bind(input.questionId, input.sessionId)
      .first<{ phase: ClassroomQuestionPhase; answer_deadline_at: string | null }>(),
    db.prepare("SELECT version, status FROM classroom_question_responses WHERE question_id = ? AND group_id = ?")
      .bind(input.questionId, input.groupId)
      .first<{ version: number; status: "draft" | "submitted" | "locked" }>(),
  ]);
  if (!question || question.phase !== "answering") {
    return { status: 409, code: "ANSWERING_CLOSED", message: "目前不是小組作答階段。" };
  }
  if (!question.answer_deadline_at || input.now >= question.answer_deadline_at) {
    return { status: 409, code: "ANSWER_DEADLINE_PASSED", message: "作答時間已結束，回答已停止接受修改。" };
  }
  if (!response || response.version !== input.expectedVersion || response.status !== "draft") {
    return { status: 409, code: "RESPONSE_VERSION_CONFLICT", message: "回答已在其他裝置更新，請重新載入。" };
  }
  return { status: 403, code: "REPRESENTATIVE_REQUIRED", message: "只有本組目前的指定代表可以編輯回答。" };
}

export async function guardedClassroomRankingBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
  sessionId: string,
  questionId: string,
): Promise<ClassroomLiveGuardFailure | null> {
  try {
    await db.batch(statements);
    return null;
  } catch {
    const question = await db.prepare("SELECT phase FROM classroom_questions WHERE id = ? AND session_id = ?")
      .bind(questionId, sessionId).first<{ phase: ClassroomQuestionPhase }>();
    return question?.phase === "ranking"
      ? { status: 409, code: "RANKING_VERSION_CONFLICT", message: "排序已在其他裝置更新，請重新載入後再試。" }
      : { status: 409, code: "RANKING_CLOSED", message: "個人排序已由教師鎖定，這次送出未被保存。" };
  }
}
