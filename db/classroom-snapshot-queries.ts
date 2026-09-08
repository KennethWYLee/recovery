import type { ClassroomParticipant, ClassroomSessionPhase } from "@/lib/classroom-domain";
import type { ClassroomActor } from "./classroom";

export const STUDENT_VISIBLE_QUESTIONS_SQL =
  "phase != 'draft' AND (phase != 'archived' OR published_at IS NOT NULL)";

export function snapshotQuestionVisibilitySql(isAdministrator: boolean): string {
  return isAdministrator ? "" : `AND ${STUDENT_VISIBLE_QUESTIONS_SQL}`;
}

export type SnapshotQuestionCount = {
  id: string;
  submitted_groups: number;
  ranked_students: number;
  teacher_ranked: number;
};

type SnapshotParticipantRow = {
  id: string;
  user_id: string;
  display_name: string;
  email: string;
  group_id: string | null;
  attendance: "on_time" | "late";
  joined_phase: ClassroomSessionPhase;
  can_rank: number;
  checked_in_at: string;
};

export function snapshotParticipantStatement(
  db: D1Database,
  actor: ClassroomActor,
  sessionId: string,
) {
  const query = db.prepare(
    `SELECT p.id, p.user_id, u.display_name, u.email, p.group_id, p.attendance,
            p.joined_phase, p.can_rank, p.checked_in_at
     FROM classroom_session_participants p
     JOIN classroom_users u ON u.id = p.user_id
     WHERE p.session_id = ? ${actor.isAdmin ? "" : "AND p.user_id = ?"}
     ORDER BY p.checked_in_at, u.display_name`,
  );
  return query.bind(...(actor.isAdmin ? [sessionId] : [sessionId, actor.id]));
}

export function mapSnapshotParticipant(row: SnapshotParticipantRow, isAdmin: boolean): ClassroomParticipant {
  return { id: row.id, userId: row.user_id, displayName: row.display_name, email: isAdmin ? row.email : null,
    groupId: row.group_id, attendance: row.attendance, joinedPhase: row.joined_phase,
    canRank: row.can_rank === 1, checkedInAt: row.checked_in_at };
}

export function snapshotQuestionCountsStatement(
  db: D1Database,
  sessionId: string,
  questionId: string | null,
  isAdministrator: boolean,
) {
  return db.prepare(
    `SELECT q.id,
            (SELECT COUNT(*) FROM classroom_question_responses r WHERE r.question_id = q.id AND r.status IN ('submitted','locked')) AS submitted_groups,
            (SELECT COUNT(DISTINCT s.user_id) FROM classroom_question_ranking_submissions s JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id WHERE s.question_id = q.id AND s.is_current = 1 AND s.status = 'valid') AS ranked_students,
            EXISTS (SELECT 1 FROM classroom_question_ranking_submissions s WHERE s.question_id = q.id AND s.user_id = q.created_by_user_id AND s.is_current = 1 AND s.status = 'valid') AS teacher_ranked
     FROM classroom_questions q
     WHERE q.session_id = ? ${isAdministrator ? "" : "AND q.id = ?"}`,
  ).bind(...(isAdministrator ? [sessionId] : [sessionId, questionId ?? ""]));
}
