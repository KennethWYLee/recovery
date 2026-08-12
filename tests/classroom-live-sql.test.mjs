import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrls = [
  "0001_classroom_courses.sql",
  "0002_classroom_access_approval.sql",
  "0003_classroom_live_sessions.sql",
  "0004_multi_question_classrooms.sql",
  "0005_course_roster.sql",
  "0006_course_question_bank.sql",
  "0007_student_live_flow.sql",
  "0008_classroom_schema_state.sql",
  "0009_classroom_observability.sql",
].map((name) => new URL(`../drizzle/${name}`, import.meta.url));

const NOW = "2026-08-07T08:00:00.000Z";

async function liveDatabase({ phase = "ranking", studentCount = 2 } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migrationUrl of migrationUrls) {
    const migration = await readFile(migrationUrl, "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      db.prepare(statement).run();
    }
  }
  db.prepare("INSERT INTO classroom_users VALUES ('teacher-1', 'teacher@ntub.edu.tw', '教師', 'teacher', 'active', ?, ?)").run(NOW, NOW);
  for (let index = 1; index <= studentCount; index += 1) {
    db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'student', 'active', ?, ?)")
      .run(`student-${index}`, `student-${index}@ntub.edu.tw`, `學生 ${index}`, NOW, NOW);
  }
  db.prepare(`INSERT INTO classroom_courses
    (id, owner_user_id, name, name_key, academic_year, term, default_group_capacity,
     default_group_count, is_demo, status, version, created_at, updated_at, deleted_at)
    VALUES ('course-1', 'teacher-1', '資料庫', '資料庫', 115, '1', 10, 6, 0, 'active', 1, ?, ?, NULL)`).run(NOW, NOW);
  db.prepare(`INSERT INTO classroom_sessions
    (id, course_id, title, question, ranking_criteria, join_code, phase, group_capacity,
     effective_group_capacity, anonymous_groups, allow_ranking_edits, group_count,
     admission_open, qr_enabled, version, created_by_user_id, created_at, updated_at)
    VALUES ('session-1', 'course-1', '第一週課堂', '請比較六組回答。', '請依正確性與理由排序。',
      'ABC234', 'answering', 10, 10, 1, 0, 6, 1, 1, 1, 'teacher-1', ?, ?)`).run(NOW, NOW);
  for (let index = 1; index <= 6; index += 1) {
    db.prepare(`INSERT INTO classroom_groups
      (id, session_id, label, position, representative_user_id, created_at, updated_at)
      VALUES (?, 'session-1', ?, ?, NULL, ?, ?)`).run(`group-${index}`, `第 ${index} 組`, index, NOW, NOW);
  }
  db.prepare(`INSERT INTO classroom_questions
    (id, session_id, question_text, ranking_criteria, source_question_bank_id, phase,
     answer_duration_seconds, answer_deadline_at, position, version, opened_at,
     responses_locked_at, ranking_locked_at, published_at, created_by_user_id, created_at, updated_at)
    VALUES ('question-1', 'session-1', '哪一個資料模型最能支持需求？', '請依正確性與理由排序。', NULL, ?,
      300, '2026-08-07T07:59:00.000Z', 1, 1, ?, NULL, NULL, NULL, 'teacher-1', ?, ?)`).run(phase, NOW, NOW, NOW);
  for (let index = 1; index <= 6; index += 1) {
    db.prepare(`INSERT INTO classroom_question_responses
      (id, question_id, group_id, content, status, version, updated_by_user_id, submitted_at, updated_at)
      VALUES (?, 'question-1', ?, ?, 'locked', 1, NULL, ?, ?)`).run(`response-${index}`, `group-${index}`, `回答 ${index}`, NOW, NOW);
  }
  return db;
}

test("Given a student submitted all answers, the saved order including their own group can be restored", async () => {
  const db = await liveDatabase();
  db.prepare(`INSERT INTO classroom_question_memberships
    (id, question_id, user_id, group_id, can_rank, captured_at)
    VALUES ('membership-1', 'question-1', 'student-1', 'group-1', 1, ?)`).run(NOW);
  db.prepare(`INSERT INTO classroom_question_ranking_submissions
    (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
    VALUES ('ranking-1', 'question-1', 'student-1', 1, 1, 'valid', NULL, ?)`).run(NOW);
  const order = ["group-3", "group-1", "group-2", "group-6", "group-4", "group-5"];
  order.forEach((groupId, index) => db.prepare(`INSERT INTO classroom_question_ranking_items
    (id, submission_id, group_id, rank) VALUES (?, 'ranking-1', ?, ?)`).run(`item-${index + 1}`, groupId, index + 1));

  const restored = db.prepare(`SELECT i.group_id
    FROM classroom_question_ranking_submissions s
    JOIN classroom_question_ranking_items i ON i.submission_id = s.id
    WHERE s.question_id = 'question-1' AND s.user_id = 'student-1'
      AND s.is_current = 1 AND s.status = 'valid' ORDER BY i.rank`).all().map((row) => row.group_id);
  assert.deepEqual(restored, order);
  assert.ok(restored.includes("group-1"), "the original ranking must retain the student's own group");
  db.close();
});

test("Given a student joined after a question started, they remain an observer for that question", async () => {
  const db = await liveDatabase({ phase: "answering" });
  db.prepare(`INSERT INTO classroom_session_participants
    (id, session_id, user_id, group_id, attendance, joined_phase, can_rank, checked_in_at, grouped_at, updated_at)
    VALUES ('participant-late', 'session-1', 'student-2', 'group-2', 'late', 'answering', 1, ?, ?, ?)`).run(NOW, NOW, NOW);
  const membership = db.prepare(`SELECT m.can_rank FROM classroom_question_memberships m
    WHERE m.question_id = 'question-1' AND m.user_id = 'student-2'`).get();
  assert.equal(membership, undefined);
  db.prepare(`INSERT INTO classroom_questions
    (id, session_id, question_text, ranking_criteria, source_question_bank_id, phase,
     answer_duration_seconds, answer_deadline_at, position, version, opened_at,
     responses_locked_at, ranking_locked_at, published_at, created_by_user_id, created_at, updated_at)
    VALUES ('question-2', 'session-1', '下一題', '請完整排序。', NULL, 'draft', 300, NULL, 2, 1,
      NULL, NULL, NULL, NULL, 'teacher-1', ?, ?)`).run(NOW, NOW);
  db.prepare(`INSERT INTO classroom_question_memberships
    (id, question_id, user_id, group_id, can_rank, captured_at)
    SELECT 'membership-next-' || user_id, 'question-2', user_id, group_id, can_rank, ?
    FROM classroom_session_participants WHERE session_id = 'session-1' AND group_id IS NOT NULL`).run(NOW);
  assert.equal(db.prepare(`SELECT group_id FROM classroom_question_memberships
    WHERE question_id = 'question-2' AND user_id = 'student-2'`).get().group_id, "group-2");
  db.close();
});

test("Given the answer deadline passed, only non-empty responses are locked", async () => {
  const db = await liveDatabase({ phase: "answering" });
  db.prepare("UPDATE classroom_question_responses SET content = '', status = 'draft' WHERE group_id = 'group-6'").run();
  const questionUpdate = db.prepare(`UPDATE classroom_questions
    SET phase = 'presenting', version = version + 1, responses_locked_at = ?, updated_at = ?
    WHERE id = 'question-1' AND phase = 'answering' AND answer_deadline_at <= ?`).run(NOW, NOW, NOW);
  assert.equal(questionUpdate.changes, 1);
  db.prepare(`UPDATE classroom_question_responses SET status = 'locked', version = version + 1, updated_at = ?
    WHERE question_id = 'question-1' AND length(trim(content)) > 0`).run(NOW);
  assert.equal(db.prepare("SELECT status FROM classroom_question_responses WHERE group_id = 'group-1'").get().status, "locked");
  assert.equal(db.prepare("SELECT status FROM classroom_question_responses WHERE group_id = 'group-6'").get().status, "draft");
  db.close();
});

test("Given incomplete groups, a teacher force-close preserves available answers without inventing submissions", async () => {
  const db = await liveDatabase({ phase: "answering" });
  db.prepare("UPDATE classroom_question_responses SET content = '', status = 'draft' WHERE group_id = 'group-6'").run();
  const incomplete = db.prepare(`SELECT COUNT(*) AS count FROM classroom_question_responses
    WHERE question_id = 'question-1' AND (status != 'submitted' OR length(trim(content)) = 0)`).get().count;
  assert.ok(incomplete > 0);
  db.prepare(`UPDATE classroom_question_responses
    SET status = CASE WHEN length(trim(content)) > 0 THEN 'locked' ELSE 'draft' END,
        version = version + 1, updated_at = ? WHERE question_id = 'question-1'`).run(NOW);
  assert.equal(db.prepare("SELECT status FROM classroom_question_responses WHERE group_id = 'group-1'").get().status, "locked");
  assert.equal(db.prepare("SELECT status FROM classroom_question_responses WHERE group_id = 'group-6'").get().status, "draft");
  db.close();
});

test("Given two devices save the same draft version, the stale write is rejected", async () => {
  const db = await liveDatabase({ phase: "answering" });
  db.prepare("UPDATE classroom_question_responses SET status = 'draft', version = 1 WHERE group_id = 'group-1'").run();
  const save = db.prepare(`UPDATE classroom_question_responses
    SET content = ?, version = version + 1, updated_at = ?
    WHERE question_id = 'question-1' AND group_id = 'group-1' AND version = 1 AND status = 'draft'`);
  assert.equal(save.run("第一台裝置的內容", NOW).changes, 1);
  assert.equal(save.run("第二台裝置的舊內容", NOW).changes, 0);
  assert.equal(db.prepare("SELECT content FROM classroom_question_responses WHERE group_id = 'group-1'").get().content, "第一台裝置的內容");
  db.close();
});

test("response writes and audits share the database answer-window guard", async () => {
  const db = await liveDatabase({ phase: "answering" });
  db.prepare("UPDATE classroom_questions SET answer_deadline_at = '2026-08-07T08:05:00.000Z' WHERE id = 'question-1'").run();
  db.prepare("UPDATE classroom_groups SET representative_user_id = 'student-1' WHERE id = 'group-1'").run();
  db.prepare(`INSERT INTO classroom_question_memberships
    (id, question_id, user_id, group_id, can_rank, captured_at)
    VALUES ('membership-1', 'question-1', 'student-1', 'group-1', 1, ?)`).run(NOW);
  db.prepare("UPDATE classroom_question_responses SET status = 'draft', version = 1 WHERE group_id = 'group-1'").run();
  const save = db.prepare(`UPDATE classroom_question_responses
    SET content = ?, version = version + 1, updated_by_user_id = 'student-1', updated_at = ?
    WHERE question_id = 'question-1' AND group_id = 'group-1' AND version = ? AND status = 'draft'
      AND EXISTS (SELECT 1 FROM classroom_questions q
        WHERE q.id = classroom_question_responses.question_id AND q.session_id = 'session-1'
          AND q.phase = 'answering' AND q.answer_deadline_at > ?)
      AND EXISTS (SELECT 1 FROM classroom_question_memberships m
        JOIN classroom_groups g ON g.id = m.group_id
        WHERE m.question_id = classroom_question_responses.question_id
          AND m.group_id = classroom_question_responses.group_id
          AND m.user_id = 'student-1' AND g.representative_user_id = 'student-1')`);
  const audit = db.prepare(`INSERT INTO classroom_audit_events
    (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
    SELECT ?, 'student-1', 'response.save', 'classroom_question', 'question-1', '{}', ? WHERE changes() = 1`);

  db.exec("BEGIN");
  const first = save.run("有效內容", NOW, 1, NOW);
  audit.run("audit-response-1", NOW);
  db.exec("COMMIT");
  assert.equal(first.changes, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_audit_events WHERE action = 'response.save'").get().count, 1);

  db.exec("BEGIN");
  const stale = save.run("過期版本", NOW, 1, NOW);
  audit.run("audit-response-stale", NOW);
  db.exec("COMMIT");
  assert.equal(stale.changes, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_audit_events WHERE action = 'response.save'").get().count, 1);

  db.prepare("UPDATE classroom_questions SET phase = 'presenting' WHERE id = 'question-1'").run();
  db.exec("BEGIN");
  const closed = save.run("不應保存", NOW, 2, NOW);
  audit.run("audit-response-closed", NOW);
  db.exec("COMMIT");
  assert.equal(closed.changes, 0);
  assert.equal(db.prepare("SELECT content FROM classroom_question_responses WHERE group_id = 'group-1'").get().content, "有效內容");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_audit_events WHERE action = 'response.save'").get().count, 1);
  db.close();
});

test("a ranking batch rolls back when the teacher locks the question before insert", async () => {
  const db = await liveDatabase({ phase: "ranking" });
  db.prepare(`INSERT INTO classroom_question_memberships
    (id, question_id, user_id, group_id, can_rank, captured_at)
    VALUES ('membership-1', 'question-1', 'student-1', 'group-1', 1, ?)`).run(NOW);
  db.prepare(`INSERT INTO classroom_question_ranking_submissions
    (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
    VALUES ('ranking-old', 'question-1', 'student-1', 1, 1, 'valid', NULL, ?)`).run(NOW);
  db.prepare("UPDATE classroom_questions SET phase = 'locked' WHERE id = 'question-1'").run();

  assert.throws(() => {
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE classroom_question_ranking_submissions SET is_current = 0 WHERE id = 'ranking-old'").run();
      db.prepare(`INSERT INTO classroom_question_ranking_submissions
        (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
        VALUES ('ranking-new', (
          SELECT id FROM classroom_questions WHERE id = 'question-1' AND session_id = 'session-1' AND phase = 'ranking'
        ), 'student-1', 2, 1, 'valid', NULL, ?)`).run(NOW);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }, /NOT NULL constraint/iu);
  assert.equal(db.prepare("SELECT is_current FROM classroom_question_ranking_submissions WHERE id = 'ranking-old'").get().is_current, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_question_ranking_submissions WHERE id = 'ranking-new'").get().count, 0);
  db.close();
});

test("publishing counts three students and requires a separate teacher ranking", async () => {
  const db = await liveDatabase({ phase: "locked", studentCount: 3 });
  for (let index = 1; index <= 3; index += 1) {
    db.prepare(`INSERT INTO classroom_question_memberships
      (id, question_id, user_id, group_id, can_rank, captured_at)
      VALUES (?, 'question-1', ?, ?, 1, ?)`).run(`membership-${index}`, `student-${index}`, `group-${index}`, NOW);
    db.prepare(`INSERT INTO classroom_question_ranking_submissions
      (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
      VALUES (?, 'question-1', ?, 1, 1, 'valid', NULL, ?)`).run(`ranking-${index}`, `student-${index}`, NOW);
    const count = db.prepare(`SELECT COUNT(DISTINCT s.user_id) AS count
      FROM classroom_question_ranking_submissions s
      JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id
      WHERE s.question_id = 'question-1' AND s.is_current = 1 AND s.status = 'valid'`).get().count;
    assert.equal(count >= 3, index >= 3);
  }
  db.prepare(`INSERT INTO classroom_question_ranking_submissions
    (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
    VALUES ('ranking-teacher', 'question-1', 'teacher-1', 1, 1, 'valid', NULL, ?)`).run(NOW);
  const teacher = db.prepare(`SELECT 1 AS present FROM classroom_question_ranking_submissions s
    JOIN classroom_questions q ON q.id = s.question_id AND q.created_by_user_id = s.user_id
    WHERE s.question_id = 'question-1' AND s.is_current = 1 AND s.status = 'valid'`).get();
  assert.equal(teacher.present, 1);
  db.close();
});

test("Given 50 valid rankings, the summary query counts students once despite six ranking items each", async () => {
  const db = await liveDatabase({ studentCount: 50 });
  for (let student = 1; student <= 50; student += 1) {
    const group = ((student - 1) % 6) + 1;
    db.prepare(`INSERT INTO classroom_question_memberships
      (id, question_id, user_id, group_id, can_rank, captured_at) VALUES (?, 'question-1', ?, ?, 1, ?)`)
      .run(`membership-${student}`, `student-${student}`, `group-${group}`, NOW);
    db.prepare(`INSERT INTO classroom_question_ranking_submissions
      (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
      VALUES (?, 'question-1', ?, 1, 1, 'valid', NULL, ?)`).run(`ranking-${student}`, `student-${student}`, NOW);
    for (let rank = 1; rank <= 6; rank += 1) {
      db.prepare(`INSERT INTO classroom_question_ranking_items
        (id, submission_id, group_id, rank) VALUES (?, ?, ?, ?)`)
        .run(`item-${student}-${rank}`, `ranking-${student}`, `group-${rank}`, rank);
    }
  }
  db.prepare(`INSERT INTO classroom_question_ranking_submissions
    (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
    VALUES ('ranking-teacher', 'question-1', 'teacher-1', 1, 1, 'valid', NULL, ?)`).run(NOW);
  const summary = db.prepare(`SELECT q.id,
      COUNT(DISTINCT CASE WHEN r.status IN ('submitted','locked') THEN r.id END) AS submitted_groups,
      COUNT(DISTINCT CASE WHEN s.is_current = 1 AND s.status = 'valid' AND m.user_id IS NOT NULL THEN s.user_id END) AS ranked_students,
      MAX(CASE WHEN s.is_current = 1 AND s.status = 'valid' AND s.user_id = q.created_by_user_id THEN 1 ELSE 0 END) AS teacher_ranked
    FROM classroom_questions q
    LEFT JOIN classroom_question_responses r ON r.question_id = q.id
    LEFT JOIN classroom_question_ranking_submissions s ON s.question_id = q.id
    LEFT JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id
    WHERE q.session_id = 'session-1' GROUP BY q.id`).get();
  assert.equal(summary.submitted_groups, 6);
  assert.equal(summary.ranked_students, 50);
  assert.equal(summary.teacher_ranked, 1);
  db.close();
});

test("stale access review versions cannot change the allowlist or create an audit", async () => {
  const db = await liveDatabase();
  db.prepare(`INSERT INTO classroom_access_requests
    (id, user_id, email, display_name, status, version, requested_at, last_requested_at, reviewed_by_user_id, reviewed_at)
    VALUES ('access-request-1', 'student-1', 'student-1@ntub.edu.tw', '學生 1', 'pending', 2, ?, ?, NULL, NULL)`).run(NOW, NOW);
  const review = (expectedVersion, nextVersion) => {
    db.exec("BEGIN");
    try {
      db.prepare(`INSERT INTO classroom_access_allowlist
        (email, user_id, status, approved_by_user_id, approved_at, updated_at)
        SELECT email, user_id, 'active', 'teacher-1', ?, ? FROM classroom_access_requests
        WHERE id = 'access-request-1' AND version = ?
        ON CONFLICT(email) DO UPDATE SET status = 'active', updated_at = excluded.updated_at`)
        .run(NOW, NOW, expectedVersion);
      db.prepare(`INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
        SELECT ?, 'teacher-1', 'access.approve', 'access_request', 'access-request-1', '{}', ?
        FROM classroom_access_requests WHERE id = 'access-request-1' AND version = ?`)
        .run(`audit-access-${nextVersion}`, NOW, expectedVersion);
      const updated = db.prepare(`UPDATE classroom_access_requests
        SET status = 'approved', version = version + 1, reviewed_by_user_id = 'teacher-1', reviewed_at = ?
        WHERE id = 'access-request-1' AND version = ?`).run(NOW, expectedVersion);
      db.exec("COMMIT");
      return updated.changes;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  assert.equal(review(1, 2), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_access_allowlist").get().count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_audit_events WHERE action = 'access.approve'").get().count, 0);
  assert.equal(review(2, 3), 1);
  assert.equal(db.prepare("SELECT status FROM classroom_access_allowlist WHERE email = 'student-1@ntub.edu.tw'").get().status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_audit_events WHERE action = 'access.approve'").get().count, 1);

  db.exec("BEGIN");
  db.prepare(`UPDATE classroom_access_allowlist SET status = 'revoked', updated_at = ?
    WHERE email = 'student-1@ntub.edu.tw' AND EXISTS (
      SELECT 1 FROM classroom_access_requests WHERE id = 'access-request-1' AND version = 2
    )`).run(NOW);
  db.prepare(`INSERT INTO classroom_audit_events
    (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
    SELECT 'audit-access-stale-reject', 'teacher-1', 'access.reject', 'access_request', 'access-request-1', '{}', ?
    FROM classroom_access_requests WHERE id = 'access-request-1' AND version = 2`).run(NOW);
  const staleReject = db.prepare(`UPDATE classroom_access_requests
    SET status = 'rejected', version = version + 1, reviewed_by_user_id = 'teacher-1', reviewed_at = ?
    WHERE id = 'access-request-1' AND version = 2`).run(NOW);
  db.exec("COMMIT");
  assert.equal(staleReject.changes, 0);
  assert.equal(db.prepare("SELECT status FROM classroom_access_allowlist WHERE email = 'student-1@ntub.edu.tw'").get().status, "active");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_audit_events WHERE action = 'access.reject'").get().count, 0);
  db.close();
});

test("an access-request database bucket permits only the first six attempts per minute", async () => {
  const db = await liveDatabase();
  const scope = `access-request:${"a".repeat(64)}`;
  const attempts = [];
  for (let index = 0; index < 7; index += 1) {
    const row = db.prepare(`INSERT INTO classroom_rate_limits
      (scope_key, window_started_at, request_count, updated_at) VALUES (?, 1000, 1, ?)
      ON CONFLICT(scope_key) DO UPDATE SET request_count = classroom_rate_limits.request_count + 1,
        updated_at = excluded.updated_at RETURNING request_count`).get(scope, NOW);
    attempts.push(row.request_count <= 6);
  }
  assert.deepEqual(attempts, [true, true, true, true, true, true, false]);
  db.close();
});
