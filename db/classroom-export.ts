import type { ClassroomActor } from "./classroom";
import { ClassroomWorkflowError } from "./classroom-errors";
import { classroomSessionSnapshot } from "./classroom-live";
import { classroomParticipationReport } from "./classroom-participation";

type CsvValue = string | number | boolean | null;

function csvCell(value: CsvValue): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csvLine(row: CsvValue[], length: number): string {
  return [...row, ...Array(Math.max(0, length - row.length)).fill(null)].map(csvCell).join(",");
}

export async function classroomSessionCsv(db: D1Database, actor: ClassroomActor, sessionId: string): Promise<string> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_EXPORT_REQUIRED", "只有系統管理員可匯出課堂原始資料。");
  const session = await db.prepare("SELECT id, title FROM classroom_sessions WHERE id = ?")
    .bind(sessionId).first<{ id: string; title: string }>();
  if (!session) throw new ClassroomWorkflowError(404, "SESSION_NOT_FOUND", "找不到這次課堂。");
  const questions = await db.prepare("SELECT id, question_text, position FROM classroom_questions WHERE session_id = ? ORDER BY position")
    .bind(sessionId).all<{ id: string; question_text: string; position: number }>();
  const header: CsvValue[] = [
    "record_type", "session_id", "session_title", "question_number", "question", "group_label",
    "group_response", "student_name", "student_email", "rank", "score", "average_score", "submitted_at",
    "attendance", "joined_phase", "eligible", "ranking_completed", "representative_submitted",
    "eligible_question_count", "ranking_opportunity_count", "completed_ranking_count", "completion_rate", "checked_in_at",
  ];
  const rows: CsvValue[][] = [header];
  for (const question of questions.results) {
    const snapshot = await classroomSessionSnapshot(db, actor, sessionId, question.id);
    for (const group of snapshot.groups) {
      const result = snapshot.results.find((item) => item.groupId === group.id);
      rows.push(["group_response", session.id, session.title, question.position, question.question_text, group.label, group.response.content, null, null, null, null, result?.averageScore ?? null, group.response.updatedAt]);
    }
    for (const ranking of snapshot.rawRankings) ranking.orderedGroupIds.forEach((groupId, index) => rows.push([
      "individual_ranking", session.id, session.title, question.position, question.question_text,
      snapshot.groups.find((group) => group.id === groupId)?.label ?? groupId, null,
      ranking.displayName, ranking.email, index + 1, ranking.orderedGroupIds.length - index, null, ranking.submittedAt,
    ]));
    snapshot.teacherRanking?.orderedGroupIds.forEach((groupId, index, order) => rows.push([
      "teacher_ranking", session.id, session.title, question.position, question.question_text,
      snapshot.groups.find((group) => group.id === groupId)?.label ?? groupId, null,
      "教師", null, index + 1, order.length - index, null, snapshot.teacherRanking?.submittedAt ?? null,
    ]));
  }
  const participation = await classroomParticipationReport(db, actor, sessionId);
  for (const student of participation.students) {
    const states = participation.questions.length ? student.questions : [{ questionId: "", eligible: false, rankingCompleted: false, representativeSubmitted: false }];
    for (const state of states) {
      const question = participation.questions.find((item) => item.id === state.questionId);
      rows.push([
        question ? "student_participation" : "student_check_in", session.id, session.title,
        question?.position ?? null, question?.text ?? null, student.groupLabel, null, student.displayName,
        student.email, null, null, null, null, student.attendance, student.joinedPhase, state.eligible,
        state.rankingCompleted, state.representativeSubmitted, student.eligibleQuestionCount,
        student.rankingOpportunityCount, student.completedRankingCount,
        student.completionRate === null ? null : Number(student.completionRate.toFixed(4)), student.checkedInAt,
      ]);
    }
  }
  return `\uFEFF${rows.map((row) => csvLine(row, header.length)).join("\r\n")}\r\n`;
}
