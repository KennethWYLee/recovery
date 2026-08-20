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

export async function snapshotParticipants(
  db: D1Database,
  actor: ClassroomActor,
  sessionId: string,
): Promise<ClassroomParticipant[]> {
  const query = db.prepare(
    `SELECT p.id, p.user_id, u.display_name, u.email, p.group_id, p.attendance,
            p.joined_phase, p.can_rank, p.checked_in_at
     FROM classroom_session_participants p
     JOIN classroom_users u ON u.id = p.user_id
     WHERE p.session_id = ? ${actor.isAdmin ? "" : "AND p.user_id = ?"}
     ORDER BY p.checked_in_at, u.display_name`,
  );
  const rows = await query.bind(...(actor.isAdmin ? [sessionId] : [sessionId, actor.id]))
    .all<SnapshotParticipantRow>();
  return rows.results.map((row) => ({
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    email: actor.isAdmin ? row.email : null,
    groupId: row.group_id,
    attendance: row.attendance,
    joinedPhase: row.joined_phase,
    canRank: row.can_rank === 1,
    checkedInAt: row.checked_in_at,
  }));
}

export async function snapshotParticipantTotals(
  db: D1Database,
  sessionId: string,
  participants: readonly ClassroomParticipant[],
  isAdministrator: boolean,
): Promise<{ checked_in: number; grouped: number }> {
  if (isAdministrator) {
    return {
      checked_in: participants.length,
      grouped: participants.filter((participant) => participant.groupId).length,
    };
  }
  return await db.prepare(
    `SELECT COUNT(*) AS checked_in,
            COUNT(CASE WHEN group_id IS NOT NULL THEN 1 END) AS grouped
     FROM classroom_session_participants WHERE session_id = ?`,
  ).bind(sessionId).first<{ checked_in: number; grouped: number }>()
    ?? { checked_in: 0, grouped: 0 };
}

export async function snapshotQuestionCounts(
  db: D1Database,
  sessionId: string,
  questionId: string | null,
  isAdministrator: boolean,
): Promise<SnapshotQuestionCount[]> {
  const rows = await db.prepare(
    `SELECT q.id,
            COUNT(DISTINCT CASE WHEN r.status IN ('submitted','locked') THEN r.id END) AS submitted_groups,
            COUNT(DISTINCT CASE WHEN s.is_current = 1 AND s.status = 'valid' AND m.user_id IS NOT NULL THEN s.user_id END) AS ranked_students,
            MAX(CASE WHEN s.is_current = 1 AND s.status = 'valid' AND s.user_id = q.created_by_user_id THEN 1 ELSE 0 END) AS teacher_ranked
     FROM classroom_questions q
     LEFT JOIN classroom_question_responses r ON r.question_id = q.id
     LEFT JOIN classroom_question_ranking_submissions s ON s.question_id = q.id
     LEFT JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id
     WHERE q.session_id = ? ${isAdministrator ? "" : "AND q.id = ?"}
     GROUP BY q.id`,
  ).bind(...(isAdministrator ? [sessionId] : [sessionId, questionId ?? ""])).all<SnapshotQuestionCount>();
  return rows.results;
}
