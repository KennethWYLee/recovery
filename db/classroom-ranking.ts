import {
  rankResults,
  rankingsExcludingOwnGroup,
  type ClassroomRankingResult,
  type ClassroomSavedRanking,
  type ClassroomSessionSnapshot,
} from "@/lib/classroom-domain";

export async function classroomRankingResults(
  db: D1Database,
  questionId: string,
  groups: Array<{ id: string; label: string }>,
): Promise<ClassroomRankingResult[]> {
  const eligibleRows = await db.prepare(
    `SELECT group_id FROM classroom_question_responses
     WHERE question_id = ? AND status IN ('submitted','locked') AND length(trim(content)) > 0`,
  ).bind(questionId).all<{ group_id: string }>();
  const eligible = new Set(eligibleRows.results.map((row) => row.group_id));
  const rows = await db.prepare(
    `SELECT s.user_id, m.group_id AS own_group_id, i.group_id, i.rank
     FROM classroom_question_ranking_items i
     JOIN classroom_question_ranking_submissions s ON s.id = i.submission_id
     JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id
     WHERE s.question_id = ? AND s.is_current = 1 AND s.status = 'valid'`,
  ).bind(questionId).all<{ user_id: string; own_group_id: string; group_id: string; rank: number }>();
  const effective = rankingsExcludingOwnGroup(rows.results.map((row) => ({
    userId: row.user_id, ownGroupId: row.own_group_id, groupId: row.group_id, rank: row.rank,
  })));
  return rankResults(groups.filter((group) => eligible.has(group.id)), effective);
}

export async function classroomCurrentRanking(
  db: D1Database,
  questionId: string,
  userId: string,
): Promise<ClassroomSavedRanking | null> {
  const rows = await db.prepare(
    `SELECT s.submitted_at, i.group_id, i.rank
     FROM classroom_question_ranking_submissions s
     JOIN classroom_question_ranking_items i ON i.submission_id = s.id
     WHERE s.question_id = ? AND s.user_id = ? AND s.is_current = 1 AND s.status = 'valid'
     ORDER BY i.rank`,
  ).bind(questionId, userId).all<{ submitted_at: string; group_id: string; rank: number }>();
  if (rows.results.length === 0) return null;
  return { submittedAt: rows.results[0].submitted_at, orderedGroupIds: rows.results.map((row) => row.group_id) };
}

export async function classroomTeacherRanking(
  db: D1Database,
  questionId: string,
): Promise<ClassroomSavedRanking | null> {
  const owner = await db.prepare("SELECT created_by_user_id FROM classroom_questions WHERE id = ?")
    .bind(questionId).first<{ created_by_user_id: string }>();
  return owner ? classroomCurrentRanking(db, questionId, owner.created_by_user_id) : null;
}

export async function classroomStudentSubmissionUserIds(db: D1Database, questionId: string): Promise<Set<string>> {
  const rows = await db.prepare(
    `SELECT DISTINCT s.user_id FROM classroom_question_ranking_submissions s
     JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id
     WHERE s.question_id = ? AND s.is_current = 1 AND s.status = 'valid'`,
  ).bind(questionId).all<{ user_id: string }>();
  return new Set(rows.results.map((row) => row.user_id));
}

export async function classroomRawStudentRankings(
  db: D1Database,
  questionId: string,
): Promise<ClassroomSessionSnapshot["rawRankings"]> {
  const rows = await db.prepare(
    `SELECT s.user_id, u.display_name, u.email, s.submitted_at, i.group_id, i.rank
     FROM classroom_question_ranking_submissions s
     JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id
     JOIN classroom_users u ON u.id = s.user_id
     JOIN classroom_question_ranking_items i ON i.submission_id = s.id
     WHERE s.question_id = ? AND s.is_current = 1 AND s.status = 'valid'
     ORDER BY s.submitted_at, u.display_name, i.rank`,
  ).bind(questionId).all<{
    user_id: string; display_name: string; email: string; submitted_at: string; group_id: string; rank: number;
  }>();
  const rankings: ClassroomSessionSnapshot["rawRankings"] = [];
  for (const row of rows.results) {
    let ranking = rankings.find((item) => item.userId === row.user_id);
    if (!ranking) {
      ranking = { userId: row.user_id, displayName: row.display_name, email: row.email, submittedAt: row.submitted_at, orderedGroupIds: [] };
      rankings.push(ranking);
    }
    ranking.orderedGroupIds[row.rank - 1] = row.group_id;
  }
  return rankings;
}
