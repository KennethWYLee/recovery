import type { ClassroomActor } from "./classroom";

export async function classroomWorkspaceRevision(db: D1Database, actor: ClassroomActor, courseId: string, questionId: string | null) {
  const row = await db.prepare(`SELECT c.version AS course_version, c.updated_at AS course_updated, s.id, s.version AS session_version,
    (SELECT group_concat(id || ':' || version || ':' || phase) FROM (SELECT id, version, phase FROM classroom_questions WHERE session_id = s.id ORDER BY id)) AS questions,
    (SELECT group_concat(id || ':' || updated_at || ':' || COALESCE(representative_user_id,'')) FROM (SELECT * FROM classroom_groups WHERE session_id = s.id ORDER BY id)) AS groups,
    (SELECT group_concat(id || ':' || updated_at || ':' || COALESCE(group_id,'')) FROM (SELECT * FROM classroom_session_participants WHERE session_id = s.id ORDER BY id)) AS participants,
    (SELECT group_concat(m.question_id || ':' || m.user_id || ':' || m.group_id || ':' || m.can_rank) FROM classroom_question_memberships m JOIN classroom_questions q ON q.id = m.question_id WHERE q.session_id = s.id) AS memberships,
    (SELECT group_concat(r.id || ':' || r.version || ':' || r.status) FROM classroom_question_responses r JOIN classroom_questions q ON q.id = r.question_id WHERE q.session_id = s.id) AS responses,
    (SELECT group_concat(r.id || ':' || r.version || ':' || r.status) FROM classroom_question_ranking_submissions r JOIN classroom_questions q ON q.id = r.question_id WHERE q.session_id = s.id AND r.is_current = 1) AS rankings,
    (SELECT group_concat(u.id || ':' || u.display_name) FROM classroom_users u JOIN classroom_session_participants p ON p.user_id = u.id WHERE p.session_id = s.id) AS names,
    (SELECT COUNT(*) FROM classroom_course_members m WHERE m.course_id = c.id AND m.role = 'student' AND m.status = 'active') AS student_count,
    (SELECT COUNT(*) FROM classroom_course_roster r WHERE r.course_id = c.id AND r.status = 'active') AS roster_count,
    (SELECT COUNT(*) FROM classroom_course_question_bank b WHERE b.course_id = c.id AND b.status != 'archived') AS question_bank_count,
    (SELECT COUNT(*) FROM classroom_sessions cs WHERE cs.course_id = c.id) AS session_count
    FROM classroom_courses c LEFT JOIN classroom_sessions s ON s.course_id = c.id AND s.phase != 'archived'
    WHERE c.id = ? AND c.status = 'active' AND (? = 1 OR EXISTS (SELECT 1 FROM classroom_course_members m WHERE m.course_id = c.id AND m.user_id = ? AND m.status = 'active'))`)
    .bind(courseId, actor.isAdmin ? 1 : 0, actor.id).first();
  if (!row) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([actor.id, actor.displayName, actor.isAdmin, questionId, row])));
  return `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}
