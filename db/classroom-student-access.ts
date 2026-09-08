export async function synchronizeStudentAccess(db: D1Database, userId: string, email: string, now: string): Promise<boolean> {
  const [allowed, roster] = await db.batch([
    db.prepare("SELECT email FROM classroom_access_allowlist WHERE email = ? AND user_id = ? AND status = 'active'").bind(email, userId),
    db.prepare(`SELECT r.course_id, r.imported_by_user_id,
      CASE WHEN m.status = 'active' AND m.role = 'student' THEN 0 ELSE 1 END AS needs_membership,
      EXISTS (SELECT 1 FROM classroom_access_requests a WHERE a.email = ? AND a.status != 'approved') AS needs_review
      FROM classroom_course_roster r JOIN classroom_courses c ON c.id = r.course_id AND c.status = 'active'
      LEFT JOIN classroom_course_members m ON m.course_id = r.course_id AND m.user_id = ?
      WHERE r.status = 'active' AND (r.email = ? OR r.student_id = ?) ORDER BY r.course_id`)
      .bind(email, userId, email, email.slice(0, email.lastIndexOf("@"))),
  ]);
  const matches = roster.results as Array<{ course_id: string; imported_by_user_id: string; needs_membership: number; needs_review: number }>;
  const statements = matches.filter((match) => match.needs_membership).map((match) => db.prepare(
    `INSERT INTO classroom_course_members (id, course_id, user_id, role, status, joined_at, updated_at)
     VALUES (?, ?, ?, 'student', 'active', ?, ?) ON CONFLICT(course_id, user_id) DO UPDATE SET status = 'active', role = 'student', updated_at = excluded.updated_at`,
  ).bind(`course-member-${crypto.randomUUID()}`, match.course_id, userId, now, now));
  if (matches[0]?.needs_review) statements.push(db.prepare(
    `UPDATE classroom_access_requests SET status = 'approved', version = version + 1, reviewed_by_user_id = ?, reviewed_at = ?
     WHERE email = ? AND status != 'approved'`,
  ).bind(matches[0].imported_by_user_id, now, email));
  if (statements.length) await db.batch(statements);
  return allowed.results.length > 0 || matches.length > 0;
}
