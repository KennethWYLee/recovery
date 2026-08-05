import type { ClassroomActor } from "./classroom";
import { validDemoStudentId } from "@/lib/classroom-domain";

type DemoStudentRow = {
  id: string;
  email: string;
  display_name: string;
  role: "student";
};

const DEMO_SESSION_ID = "session-demo-classroom";
const DEMO_QUESTION_ID = "question-demo-3";

function mapDemoStudent(row: DemoStudentRow): ClassroomActor {
  return { id: row.id, email: row.email, displayName: row.display_name, role: "student", isAdmin: false };
}

export async function demoStudentActorForCourse(
  db: D1Database,
  viewer: ClassroomActor,
  courseId: string,
  value: unknown,
): Promise<ClassroomActor | null> {
  if (!viewer.isAdmin || !validDemoStudentId(value)) return null;
  const userId = value.trim();
  const row = await db.prepare(
    `SELECT u.id, u.email, u.display_name, u.role
     FROM classroom_users u
     JOIN classroom_course_members m ON m.user_id = u.id
     JOIN classroom_courses c ON c.id = m.course_id
     WHERE c.id = ? AND c.is_demo = 1 AND c.status = 'active'
       AND m.status = 'active' AND m.role = 'student'
       AND u.id = ? AND u.role = 'student' AND u.status = 'active'
       AND u.email LIKE '%@example.invalid'`,
  ).bind(courseId, userId).first<DemoStudentRow>();
  return row ? mapDemoStudent(row) : null;
}

export async function demoStudentActorForSession(
  db: D1Database,
  viewer: ClassroomActor,
  sessionId: string,
  value: unknown,
): Promise<ClassroomActor | null> {
  if (!viewer.isAdmin || !validDemoStudentId(value)) return null;
  const userId = value.trim();
  const row = await db.prepare(
    `SELECT u.id, u.email, u.display_name, u.role
     FROM classroom_users u
     JOIN classroom_session_participants p ON p.user_id = u.id
     JOIN classroom_sessions s ON s.id = p.session_id
     JOIN classroom_courses c ON c.id = s.course_id
     WHERE s.id = ? AND c.is_demo = 1 AND c.status = 'active'
       AND u.id = ? AND u.role = 'student' AND u.status = 'active'
       AND u.email LIKE '%@example.invalid'`,
  ).bind(sessionId, userId).first<DemoStudentRow>();
  return row ? mapDemoStudent(row) : null;
}

export async function resetDemoClassroom(
  db: D1Database,
  viewer: ClassroomActor,
  courseId: string,
): Promise<void> {
  if (!viewer.isAdmin) throw new Error("Only an administrator can reset sample classroom data.");
  if (courseId !== "course-demo-classroom") throw new Error("The sample course was not found.");
  const demo = await db.prepare(
    `SELECT c.id, COUNT(r.id) AS response_count
     FROM classroom_courses c
     JOIN classroom_sessions s ON s.course_id = c.id
     JOIN classroom_questions q ON q.session_id = s.id
     LEFT JOIN classroom_question_responses r ON r.question_id = q.id
     WHERE c.id = ? AND c.is_demo = 1 AND c.status = 'active'
       AND s.id = ? AND q.id = ? GROUP BY c.id`,
  ).bind(courseId, DEMO_SESSION_ID, DEMO_QUESTION_ID).first<{ id: string; response_count: number }>();
  if (!demo || demo.response_count !== 6) throw new Error("The sample classroom data is incomplete and cannot be reset safely.");

  const answers = [
    "先暫停受影響商品的結帳，保留價格異動與操作者紀錄，再確認影響訂單範圍。修正後以抽樣訂單和回歸測試確認金額。",
    "立即把價格改回去，之後再看是否有人反映。",
    "先關閉價格更新入口並查核異動 Log、部署紀錄與資料庫更新來源；建立受影響清單後分批修正並保留稽核紀錄。",
    "先刪除錯誤訂單，避免報表看到異常資料。",
    "草擬中：比較異常前後價格、找出受影響交易，再設計修正與通知流程。",
    "草擬中：停止新交易、保留證據、確認影響範圍。",
  ];
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE classroom_questions SET phase = 'archived', version = version + 1, updated_at = ?
       WHERE session_id = ? AND id != ? AND phase IN ('answering','presenting','ranking','locked')`,
    ).bind(now, DEMO_SESSION_ID, DEMO_QUESTION_ID),
    db.prepare(
      `DELETE FROM classroom_question_ranking_items
       WHERE submission_id IN (SELECT id FROM classroom_question_ranking_submissions WHERE question_id = ?)`,
    ).bind(DEMO_QUESTION_ID),
    db.prepare("DELETE FROM classroom_question_ranking_submissions WHERE question_id = ?").bind(DEMO_QUESTION_ID),
    db.prepare(
      `UPDATE classroom_questions SET phase = 'answering', version = version + 1,
         responses_locked_at = NULL, ranking_locked_at = NULL, published_at = NULL, updated_at = ?
       WHERE id = ? AND session_id = ?`,
    ).bind(now, DEMO_QUESTION_ID, DEMO_SESSION_ID),
    db.prepare(
      `UPDATE classroom_sessions SET phase = 'answering', admission_open = 0,
         version = version + 1, updated_at = ? WHERE id = ? AND course_id = ?`,
    ).bind(now, DEMO_SESSION_ID, courseId),
  ];
  answers.forEach((content, index) => {
    const groupNumber = index + 1;
    const submitted = groupNumber <= 3;
    statements.push(db.prepare(
      `UPDATE classroom_question_responses SET content = ?, status = ?, version = version + 1,
         updated_by_user_id = ?, submitted_at = ?, updated_at = ?
       WHERE question_id = ? AND group_id = ?`,
    ).bind(
      content,
      submitted ? "submitted" : "draft",
      `demo-user-${index * 4 + 1}`,
      submitted ? now : null,
      now,
      DEMO_QUESTION_ID,
      `group-demo-${groupNumber}`,
    ));
  });
  statements.push(db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'demo.reset', 'classroom_session', ?, ?, ?)`,
  ).bind(`class-audit-${crypto.randomUUID()}`, viewer.id, DEMO_SESSION_ID, JSON.stringify({ synthetic: true }), now));
  const results = await db.batch(statements);
  if ((results[3]?.meta.changes ?? 0) !== 1 || (results[4]?.meta.changes ?? 0) !== 1
    || results.slice(5, 11).some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new Error("The sample classroom data is incomplete and could not be reset safely.");
  }
}
