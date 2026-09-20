const DEMO_SESSION_ID = "session-demo-classroom";
const DEMO_TEACHER_ORDERS = [
  [1, 4, 2, 3, 5, 6],
  [5, 1, 3, 2, 6, 4],
] as const;

export async function ensureDemoTeacherRankings(db: D1Database): Promise<boolean> {
  const session = await db.prepare(`SELECT created_by_user_id,
    (SELECT COUNT(*) FROM classroom_question_ranking_submissions
      WHERE id IN ('qranking-demo-teacher-1', 'qranking-demo-teacher-2')) AS submissions,
    (SELECT COUNT(*) FROM classroom_question_ranking_items
      WHERE submission_id IN ('qranking-demo-teacher-1', 'qranking-demo-teacher-2')
        AND id GLOB 'qrank-item-demo-teacher-[12]-[1-6]') AS items
    FROM classroom_sessions WHERE id = ?`)
    .bind(DEMO_SESSION_ID).first<{ created_by_user_id: string; submissions: number; items: number }>();
  if (!session) return false;
  if (session.submissions === 2 && session.items === 12) return true;
  const submittedAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (let questionIndex = 0; questionIndex < DEMO_TEACHER_ORDERS.length; questionIndex += 1) {
    const questionNumber = questionIndex + 1;
    const submissionId = `qranking-demo-teacher-${questionNumber}`;
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO classroom_question_ranking_submissions
          (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
         SELECT ?, id, ?, 1, 1, 'valid', NULL, ? FROM classroom_questions WHERE id = ?`,
      ).bind(submissionId, session.created_by_user_id, submittedAt, `question-demo-${questionNumber}`),
      ...DEMO_TEACHER_ORDERS[questionIndex].map((groupNumber, rank) => db.prepare(
        `INSERT OR IGNORE INTO classroom_question_ranking_items
          (id, submission_id, group_id, rank) VALUES (?, ?, ?, ?)`,
      ).bind(`qrank-item-demo-teacher-${questionNumber}-${rank + 1}`, submissionId, `group-demo-${groupNumber}`, rank + 1)),
    );
  }
  await db.batch(statements);
  return true;
}
