import { classroomId, classroomNow, type ClassroomActor } from "./classroom";
import { ClassroomWorkflowError } from "./classroom-errors";
import { classroomSessionSnapshot } from "./classroom-live";

export async function reopenClassroomRanking(
  db: D1Database, actor: ClassroomActor, sessionId: string, questionId: string, expectedVersion: number,
) {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以重新開放排序。");
  const snapshot = await classroomSessionSnapshot(db, actor, sessionId, questionId);
  if (snapshot.question?.id !== questionId || snapshot.question.phase !== "locked" || snapshot.session.phase === "archived") {
    throw new ClassroomWorkflowError(409, "RANKING_REOPEN_NOT_ALLOWED", "只有已鎖定、尚未公布的問題可以重新開放排序。");
  }
  const now = classroomNow();
  const [updated] = await db.batch([
    db.prepare(`UPDATE classroom_questions SET phase = 'ranking', ranking_locked_at = NULL,
      version = version + 1, updated_at = ?
      WHERE id = ? AND session_id = ? AND phase = 'locked' AND published_at IS NULL AND version = ?
        AND EXISTS (SELECT 1 FROM classroom_sessions WHERE id = ? AND phase != 'archived')`)
      .bind(now, questionId, sessionId, expectedVersion, sessionId),
    db.prepare(`INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
      SELECT ?, ?, 'question.reopen_ranking', 'classroom_question', ?, ?, ? WHERE changes() = 1`)
      .bind(classroomId("class-audit"), actor.id, questionId, JSON.stringify({ from: "locked", to: "ranking" }), now),
  ]);
  if (updated.meta.changes !== 1) throw new ClassroomWorkflowError(409, "QUESTION_VERSION_CONFLICT", "問題狀態已更新，請更新畫面後再試。");
  return classroomSessionSnapshot(db, actor, sessionId, questionId);
}
