import { rankResults, rankingsExcludingOwnGroup, type ClassroomSavedRanking, type ClassroomSessionSnapshot } from "@/lib/classroom-domain";
import type { ClassroomActor } from "./classroom";
import { mapSnapshotParticipant, snapshotParticipantStatement, snapshotQuestionCountsStatement, snapshotQuestionVisibilitySql } from "./classroom-snapshot-queries";

export async function readSnapshotBase<Q>(db: D1Database, actor: ClassroomActor, sessionId: string, questionColumns: string) {
  const [participants, totals, groups, questions] = await db.batch([
    snapshotParticipantStatement(db, actor, sessionId),
    db.prepare("SELECT COUNT(*) AS checked_in, COUNT(group_id) AS grouped FROM classroom_session_participants WHERE session_id = ?").bind(sessionId),
    db.prepare("SELECT id, label, position, representative_user_id FROM classroom_groups WHERE session_id = ? ORDER BY position").bind(sessionId),
    db.prepare(`SELECT ${questionColumns} FROM classroom_questions WHERE session_id = ? ${snapshotQuestionVisibilitySql(actor.isAdmin)} ORDER BY position`).bind(sessionId),
  ]);
  return {
    participants: participants.results.map((row) => mapSnapshotParticipant(row as Parameters<typeof mapSnapshotParticipant>[0], actor.isAdmin)),
    totals: totals.results[0] as { checked_in: number; grouped: number },
    groups: groups.results as Array<{ id: string; label: string; position: number; representative_user_id: string | null }>,
    questions: questions.results as Q[],
  };
}

type ResponseRow = { group_id: string; content: string; status: "draft" | "submitted" | "locked"; version: number; updated_at: string | null };
type RankRow = { user_id: string; display_name: string; email: string; submitted_at: string; group_id: string; own_group_id: string | null; rank: number; is_teacher: number };
type SummaryRow = { id: string; submitted_groups: number; ranked_students: number; teacher_ranked: number };

export async function readSnapshotDetails(db: D1Database, actor: ClassroomActor, sessionId: string, questionId: string | null, showResults: boolean) {
  const id = questionId ?? "";
  const [responses, membership, counts, users, rankings, eligible] = await db.batch([
    db.prepare("SELECT group_id, content, status, version, updated_at FROM classroom_question_responses WHERE question_id = ?").bind(id),
    db.prepare("SELECT group_id, can_rank FROM classroom_question_memberships WHERE question_id = ? AND user_id = ?").bind(id, actor.id),
    snapshotQuestionCountsStatement(db, sessionId, questionId, actor.isAdmin),
    db.prepare(`SELECT DISTINCT s.user_id FROM classroom_question_ranking_submissions s
      JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id
      WHERE s.question_id = ? AND s.is_current = 1 AND s.status = 'valid'`).bind(id),
    db.prepare(`SELECT s.user_id, u.display_name, u.email, s.submitted_at, i.group_id, i.rank,
      m.group_id AS own_group_id, (s.user_id = q.created_by_user_id) AS is_teacher
      FROM classroom_question_ranking_submissions s JOIN classroom_question_ranking_items i ON i.submission_id = s.id
      JOIN classroom_questions q ON q.id = s.question_id JOIN classroom_users u ON u.id = s.user_id
      LEFT JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id
      WHERE s.question_id = ? AND s.is_current = 1 AND s.status = 'valid' ${actor.isAdmin || showResults ? "" : "AND s.user_id = ?"}
      ORDER BY s.submitted_at, u.display_name, i.rank`).bind(...(actor.isAdmin || showResults ? [id] : [id, actor.id])),
    db.prepare("SELECT COUNT(*) AS count FROM classroom_question_memberships WHERE question_id = ? AND can_rank = 1").bind(id),
  ]);
  return { responses: responses.results as ResponseRow[], membership: membership.results[0] as { group_id: string; can_rank: number } | undefined,
    counts: counts.results as SummaryRow[], submittedUsers: new Set((users.results as Array<{ user_id: string }>).map((row) => row.user_id)),
    ranks: rankings.results as RankRow[], eligible: Number((eligible.results[0] as { count: number })?.count ?? 0) };
}

export function snapshotRanks(rows: RankRow[], responses: ResponseRow[], actor: ClassroomActor, showResults: boolean, labels: Array<{ id: string; label: string }>, phase?: string) {
  const saved = (items: RankRow[]): ClassroomSavedRanking | null => items.length ? {
    submittedAt: items[0].submitted_at, orderedGroupIds: [...items].sort((a, b) => a.rank - b.rank).map((row) => row.group_id),
  } : null;
  const currentRanking = saved(rows.filter((row) => row.user_id === actor.id));
  const teacherRanking = showResults ? saved(rows.filter((row) => row.is_teacher === 1)) : null;
  const rawRankings: ClassroomSessionSnapshot["rawRankings"] = [];
  if (actor.isAdmin && ["ranking", "locked", "published", "archived"].includes(phase ?? "")) for (const row of rows.filter((item) => item.own_group_id !== null)) {
    let item = rawRankings.find((item) => item.userId === row.user_id);
    if (!item) { item = { userId: row.user_id, displayName: row.display_name, email: row.email, submittedAt: row.submitted_at, orderedGroupIds: [] }; rawRankings.push(item); }
    item.orderedGroupIds[row.rank - 1] = row.group_id;
  }
  const eligible = new Set(responses.filter((r) => ["submitted", "locked"].includes(r.status) && r.content.trim()).map((r) => r.group_id));
  const results = showResults ? rankResults(labels.filter((group) => eligible.has(group.id)), rankingsExcludingOwnGroup(
    rows.filter((row) => row.own_group_id !== null).map((row) => ({ userId: row.user_id, ownGroupId: row.own_group_id!, groupId: row.group_id, rank: row.rank })),
  )) : [];
  return { currentRanking, teacherRanking, rawRankings, results };
}
