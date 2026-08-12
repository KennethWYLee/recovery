const DEMO_SESSION_ID = "session-demo-classroom";
const DEMO_TEACHER_ORDERS = [
  [1, 4, 2, 3, 5, 6],
  [5, 1, 3, 2, 6, 4],
] as const;

export async function ensureDemoTeacherRankings(db: D1Database): Promise<void> {
  const session = await db.prepare("SELECT created_by_user_id FROM classroom_sessions WHERE id = ?")
    .bind(DEMO_SESSION_ID).first<{ created_by_user_id: string }>();
  if (!session) return;
  const submittedAt = new Date().toISOString();
  for (let questionIndex = 0; questionIndex < DEMO_TEACHER_ORDERS.length; questionIndex += 1) {
    const questionNumber = questionIndex + 1;
    const submissionId = `qranking-demo-teacher-${questionNumber}`;
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO classroom_question_ranking_submissions
          (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
         SELECT ?, id, ?, 1, 1, 'valid', NULL, ? FROM classroom_questions WHERE id = ?`,
      ).bind(submissionId, session.created_by_user_id, submittedAt, `question-demo-${questionNumber}`),
      ...DEMO_TEACHER_ORDERS[questionIndex].map((groupNumber, rank) => db.prepare(
        `INSERT OR IGNORE INTO classroom_question_ranking_items
          (id, submission_id, group_id, rank) VALUES (?, ?, ?, ?)`,
      ).bind(`qrank-item-demo-teacher-${questionNumber}-${rank + 1}`, submissionId, `group-demo-${groupNumber}`, rank + 1)),
    ]);
  }
}
