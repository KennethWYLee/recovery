import { classroomId, classroomNow, type ClassroomActor } from "./classroom";
import { ClassroomWorkflowError, classroomSessionSnapshot, requireSession } from "./classroom-live";

export async function addClassroomGroupForParticipant(
  db: D1Database, actor: ClassroomActor, sessionId: string, participantId: string, expectedGroupId: string | null,
) {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以調整分組。");
  const session = await requireSession(db, actor, sessionId);
  if (session.phase !== "grouping" && session.phase !== "answering") {
    throw new ClassroomWorkflowError(409, "GROUPING_LOCKED", "目前不能調整分組。");
  }
  const participant = await db.prepare("SELECT user_id FROM classroom_session_participants WHERE id = ? AND session_id = ?")
    .bind(participantId, sessionId).first<{ user_id: string }>();
  if (!participant) throw new ClassroomWorkflowError(404, "GROUP_MEMBER_NOT_FOUND", "找不到指定學生。");
  const groupId = classroomId("group");
  const now = classroomNow();
  // The insert, numbering and move share one transaction. A stale selection cannot create an empty group.
  const [created] = await db.batch([
    db.prepare(
      `INSERT INTO classroom_groups (id, session_id, label, position, representative_user_id, created_at, updated_at)
       SELECT ?, s.id, '第 ' || (MAX(g.position) + 1) || ' 組', MAX(g.position) + 1, p.user_id, ?, ?
       FROM classroom_sessions s
       JOIN classroom_courses c ON c.id = s.course_id AND c.status = 'active'
       JOIN classroom_groups g ON g.session_id = s.id
       JOIN classroom_session_participants p ON p.session_id = s.id AND p.id = ?
       WHERE s.id = ? AND s.phase IN ('grouping', 'answering') AND p.group_id IS ?
       GROUP BY s.id, p.user_id HAVING COUNT(g.id) < 20`,
    ).bind(groupId, now, now, participantId, sessionId, expectedGroupId),
    db.prepare(
      `UPDATE classroom_session_participants SET group_id = ?, grouped_at = ?, updated_at = ?
       WHERE id = ? AND session_id = ? AND EXISTS (SELECT 1 FROM classroom_groups WHERE id = ?)`,
    ).bind(groupId, now, now, participantId, sessionId, groupId),
    db.prepare(
      `UPDATE classroom_groups SET representative_user_id = NULL, updated_at = ?
       WHERE session_id = ? AND representative_user_id = ? AND id != ?
         AND EXISTS (SELECT 1 FROM classroom_groups WHERE id = ?)`,
    ).bind(now, sessionId, participant.user_id, groupId, groupId),
    db.prepare(
      `UPDATE classroom_question_memberships SET group_id = ? WHERE user_id = ?
       AND question_id IN (SELECT id FROM classroom_questions WHERE session_id = ? AND phase = 'answering')
       AND EXISTS (SELECT 1 FROM classroom_groups WHERE id = ?)`,
    ).bind(groupId, participant.user_id, sessionId, groupId),
    db.prepare(
      `INSERT INTO classroom_question_responses (id, question_id, group_id)
       SELECT ?, q.id, ? FROM classroom_questions q WHERE q.session_id = ? AND q.phase = 'answering'
       AND EXISTS (SELECT 1 FROM classroom_question_memberships m WHERE m.question_id = q.id AND m.group_id = ?)`,
    ).bind(classroomId("response"), groupId, sessionId, groupId),
    db.prepare(
      `UPDATE classroom_sessions SET group_count = (SELECT COUNT(*) FROM classroom_groups WHERE session_id = ?),
         version = version + 1, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM classroom_groups WHERE id = ?)`,
    ).bind(sessionId, now, sessionId, groupId),
    db.prepare(
      `INSERT INTO classroom_audit_events (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       SELECT ?, ?, 'group.create_and_move', 'classroom_session', ?, ?, ? WHERE EXISTS (SELECT 1 FROM classroom_groups WHERE id = ?)`,
    ).bind(classroomId("class-audit"), actor.id, sessionId,
      JSON.stringify({ participantId, from: expectedGroupId, to: groupId }), now, groupId),
  ]);
  if (created.meta.changes !== 1) {
    throw new ClassroomWorkflowError(409, "GROUP_CREATE_CONFLICT", "學生組別或課堂狀態已更新，或已達 20 組上限。請重新載入後確認。");
  }
  return classroomSessionSnapshot(db, actor, sessionId);
}
