import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrls = [
  new URL("../drizzle/0001_classroom_courses.sql", import.meta.url),
  new URL("../drizzle/0002_classroom_access_approval.sql", import.meta.url),
  new URL("../drizzle/0003_classroom_live_sessions.sql", import.meta.url),
  new URL("../drizzle/0004_multi_question_classrooms.sql", import.meta.url),
  new URL("../drizzle/0005_course_roster.sql", import.meta.url),
  new URL("../drizzle/0006_course_question_bank.sql", import.meta.url),
  new URL("../drizzle/0007_student_live_flow.sql", import.meta.url),
  new URL("../drizzle/0008_classroom_schema_state.sql", import.meta.url),
  new URL("../drizzle/0009_classroom_observability.sql", import.meta.url),
];

async function classroomDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migrationUrl of migrationUrls) {
    const migration = await readFile(migrationUrl, "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      db.prepare(statement).run();
    }
  }
  return db;
}

test("classroom migration creates the reviewed course boundary", async () => {
  const db = await classroomDatabase();
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'classroom_%' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, [
    "classroom_access_allowlist",
    "classroom_access_requests",
    "classroom_audit_events",
    "classroom_course_members",
    "classroom_course_question_bank",
    "classroom_course_roster",
    "classroom_courses",
    "classroom_group_responses",
    "classroom_groups",
    "classroom_incidents",
    "classroom_operation_logs",
    "classroom_question_memberships",
    "classroom_question_ranking_items",
    "classroom_question_ranking_submissions",
    "classroom_question_responses",
    "classroom_questions",
    "classroom_ranking_items",
    "classroom_ranking_submissions",
    "classroom_rate_limits",
    "classroom_schema_state",
    "classroom_seed_state",
    "classroom_session_participants",
    "classroom_sessions",
    "classroom_users",
  ]);
  db.close();
});

test("schema state identifies the exact application contract", async () => {
  const db = await classroomDatabase();
  const state = db.prepare("SELECT schema_version, schema_fingerprint FROM classroom_schema_state WHERE singleton_id = 1").get();
  assert.equal(state.schema_version, 9);
  assert.equal(state.schema_fingerprint, "classroom-schema-v9-20260808");
  db.close();
});

test("observability schema stores bounded operation evidence and verifiable incidents", async () => {
  const db = await classroomDatabase();
  const operationColumns = db.prepare("PRAGMA table_info(classroom_operation_logs)").all().map((row) => row.name);
  assert.deepEqual(operationColumns, [
    "id", "request_id", "actor_user_id", "actor_kind", "method", "route", "scope_type", "scope_id",
    "outcome", "status_code", "error_code", "duration_ms", "capture_kind", "test_mode", "environment",
    "security_relevant", "release", "occurred_at",
  ]);
  const incidentColumns = db.prepare("PRAGMA table_info(classroom_incidents)").all().map((row) => row.name);
  assert.deepEqual(incidentColumns, [
    "id", "title", "severity", "status", "source_request_id", "verification_request_id", "symptom",
    "root_cause", "resolution", "fix_release", "regression_check", "regression_command", "regression_evidence",
    "verification_result", "created_by_user_id", "updated_by_user_id", "version", "detected_at", "resolved_at",
    "verified_at", "created_at", "updated_at",
  ]);

  const indexes = db.prepare(`SELECT name FROM sqlite_schema
    WHERE type = 'index' AND name LIKE 'classroom_%' AND tbl_name IN ('classroom_operation_logs', 'classroom_incidents')
    ORDER BY name`).all().map((row) => row.name);
  assert.deepEqual(indexes, [
    "classroom_incidents_severity_time_idx",
    "classroom_incidents_source_request_idx",
    "classroom_incidents_status_time_idx",
    "classroom_incidents_verification_request_idx",
    "classroom_operation_logs_outcome_time_idx",
    "classroom_operation_logs_request_unique",
    "classroom_operation_logs_route_time_idx",
    "classroom_operation_logs_scope_time_idx",
    "classroom_operation_logs_security_time_idx",
    "classroom_operation_logs_time_idx",
  ]);

  const now = "2026-08-08T00:00:00.000Z";
  db.prepare(`INSERT INTO classroom_users
    (id, email, display_name, role, status, created_at, last_seen_at)
    VALUES ('teacher-observability', 'observability@ntub.edu.tw', '系統管理員', 'teacher', 'active', ?, ?)`).run(now, now);
  const insertLog = db.prepare(`INSERT INTO classroom_operation_logs
    (id, request_id, actor_user_id, actor_kind, method, route, scope_type, scope_id, outcome, status_code,
     error_code, duration_ms, capture_kind, test_mode, environment, security_relevant, release, occurred_at)
    VALUES (?, ?, 'teacher-observability', ?, 'GET', '/api/classroom/courses', ?, NULL, ?, ?, NULL, ?, ?, 0,
      'production', 0, 'release-1', ?)`);
  insertLog.run("oplog-valid", "req-00000000-0000-4000-8000-000000000001", "administrator", "system", "success", 200, 25, "sample", now);
  assert.throws(
    () => insertLog.run("oplog-bad-status", "req-00000000-0000-4000-8000-000000000002", "administrator", "system", "success", 700, 25, "sample", now),
    /CHECK constraint/iu,
  );
  assert.throws(
    () => insertLog.run("oplog-bad-duration", "req-00000000-0000-4000-8000-000000000003", "administrator", "system", "success", 200, 120001, "sample", now),
    /CHECK constraint/iu,
  );
  assert.throws(
    () => insertLog.run("oplog-bad-capture", "req-00000000-0000-4000-8000-000000000004", "administrator", "system", "success", 200, 25, "body", now),
    /CHECK constraint/iu,
  );
  assert.throws(
    () => insertLog.run("oplog-duplicate", "req-00000000-0000-4000-8000-000000000001", "administrator", "system", "success", 200, 25, "sample", now),
    /UNIQUE/iu,
  );
  const verificationTime = "2026-08-08T00:00:01.000Z";
  insertLog.run("oplog-verification", "req-00000000-0000-4000-8000-000000000005", "administrator", "system", "success", 200, 25, "mutation", verificationTime);

  const insertResolvedIncident = db.prepare(`INSERT INTO classroom_incidents
    (id, title, severity, status, source_request_id, verification_request_id, symptom, root_cause, resolution,
     fix_release, regression_check, regression_command, regression_evidence, verification_result,
     created_by_user_id, updated_by_user_id, version, detected_at, resolved_at, verified_at, created_at, updated_at)
    VALUES (?, '資料庫結構不一致', 'high', 'resolved', ?, ?, '課堂資料無法取得', ?, ?, ?, ?, ?, ?, ?,
      'teacher-observability', 'teacher-observability', 1, ?, ?, ?, ?, ?)`);
  const validResolved = [
    "req-00000000-0000-4000-8000-000000000001",
    "req-00000000-0000-4000-8000-000000000005",
    "資料庫 migration 未隨應用程式部署",
    "完成 migration 後重新部署並驗證",
    "release-1",
    "重新取得課程資料",
    "npm run test:integration",
    "整合測試與正式請求均成功",
    "passed",
    now,
    verificationTime,
    verificationTime,
    now,
    verificationTime,
  ];
  insertResolvedIncident.run("incident-resolved-valid", ...validResolved);
  const invalidResolvedCases = [
    ["missing-source", 0, null],
    ["missing-verification", 1, null],
    ["same-request", 1, validResolved[0]],
    ["missing-root-cause", 2, ""],
    ["missing-resolution", 3, ""],
    ["missing-release", 4, ""],
    ["unverified-release", 4, "classroom-0.3.0-unverified"],
    ["missing-regression-check", 5, ""],
    ["missing-regression-command", 6, ""],
    ["missing-regression-evidence", 7, ""],
    ["verification-not-passed", 8, "failed"],
    ["missing-resolved-at", 10, null],
    ["missing-verified-at", 11, null],
  ];
  for (const [label, index, replacement] of invalidResolvedCases) {
    const values = [...validResolved];
    values[index] = replacement;
    assert.throws(
      () => insertResolvedIncident.run(`incident-resolved-${label}`, ...values),
      /CHECK constraint/iu,
      `resolved incident accepted invalid evidence: ${label}`,
    );
  }

  const insertIncident = db.prepare(`INSERT INTO classroom_incidents
    (id, title, severity, status, source_request_id, verification_request_id, symptom, root_cause, resolution,
     fix_release, regression_check, regression_command, regression_evidence, verification_result,
     created_by_user_id, updated_by_user_id, version, detected_at, resolved_at, verified_at, created_at, updated_at)
    VALUES (?, '資料庫結構不一致', ?, ?, 'req-00000000-0000-4000-8000-000000000001', NULL,
      '課堂資料無法取得', '', '', '', '', '', '', ?, 'teacher-observability', 'teacher-observability', ?, ?, NULL, NULL, ?, ?)`);
  insertIncident.run("incident-valid", "high", "investigating", "not_run", 1, now, now, now);
  assert.throws(
    () => insertIncident.run("incident-bad-severity", "urgent", "investigating", "not_run", 1, now, now, now),
    /CHECK constraint/iu,
  );
  assert.throws(
    () => insertIncident.run("incident-bad-result", "high", "resolved", "unknown", 1, now, now, now),
    /CHECK constraint/iu,
  );
  assert.throws(
    () => insertIncident.run("incident-bad-version", "high", "open", "not_run", 0, now, now, now),
    /CHECK constraint/iu,
  );
  db.close();
});

test("questions persist the answer window used by the student live flow", async () => {
  const db = await classroomDatabase();
  const columns = db.prepare("PRAGMA table_info(classroom_questions)").all().map((row) => row.name);
  assert.ok(columns.includes("answer_duration_seconds"));
  assert.ok(columns.includes("answer_deadline_at"));
  db.close();
});

test("a course has only one active session and each student can check in once", async () => {
  const db = await classroomDatabase();
  const now = "2026-08-05T00:00:00.000Z";
  db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'teacher', 'active', ?, ?)").run("teacher-1", "teacher@ntub.edu.tw", "教師", now, now);
  db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'student', 'active', ?, ?)").run("student-1", "student@ntub.edu.tw", "學生", now, now);
  db.prepare(`INSERT INTO classroom_courses
    (id, owner_user_id, name, name_key, academic_year, term, status, version, created_at, updated_at, deleted_at)
    VALUES ('course-1', 'teacher-1', '資料庫', '資料庫', 115, '1', 'active', 1, ?, ?, NULL)`).run(now, now);
  const insertSession = db.prepare(`INSERT INTO classroom_sessions
    (id, course_id, title, question, ranking_criteria, join_code, phase, group_capacity,
     effective_group_capacity, anonymous_groups, allow_ranking_edits, version, created_by_user_id, created_at, updated_at)
    VALUES (?, 'course-1', '課堂活動', '如何設計資料庫？', '請依正確性與理由排序。', ?, 'check_in', 6, 6, 1, 1, 1, 'teacher-1', ?, ?)`);
  insertSession.run("session-1", "ABC234", now, now);
  assert.throws(() => insertSession.run("session-2", "ABC235", now, now), /UNIQUE/iu);
  const insertParticipant = db.prepare(`INSERT INTO classroom_session_participants
    (id, session_id, user_id, group_id, attendance, joined_phase, can_rank, checked_in_at, grouped_at, updated_at)
    VALUES (?, 'session-1', 'student-1', NULL, 'on_time', 'check_in', 1, ?, NULL, ?)`);
  insertParticipant.run("participant-1", now, now);
  assert.throws(() => insertParticipant.run("participant-2", now, now), /UNIQUE/iu);
  db.close();
});

test("only reviewed requests can become active allowlist entries", async () => {
  const db = await classroomDatabase();
  const now = "2026-08-05T00:00:00.000Z";
  db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'teacher', 'active', ?, ?)")
    .run("admin-1", "wy.lee@ntub.edu.tw", "系統管理員", now, now);
  db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'student', 'active', ?, ?)")
    .run("student-1", "student@ntub.edu.tw", "申請人", now, now);
  db.prepare(`INSERT INTO classroom_access_requests
    (id, user_id, email, display_name, status, version, requested_at, last_requested_at, reviewed_by_user_id, reviewed_at)
    VALUES ('request-1', 'student-1', 'student@ntub.edu.tw', '申請人', 'pending', 1, ?, ?, NULL, NULL)`).run(now, now);
  assert.throws(() => db.prepare(`UPDATE classroom_access_requests
    SET status = 'approved' WHERE id = 'request-1'`).run(), /CHECK constraint/iu);
  db.prepare(`UPDATE classroom_access_requests
    SET status = 'approved', reviewed_by_user_id = 'admin-1', reviewed_at = ?, version = 2
    WHERE id = 'request-1'`).run(now);
  db.prepare(`INSERT INTO classroom_access_allowlist
    (email, user_id, status, approved_by_user_id, approved_at, updated_at)
    VALUES ('student@ntub.edu.tw', 'student-1', 'active', 'admin-1', ?, ?)`).run(now, now);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_access_allowlist WHERE status = 'active'").get().count, 1);
  db.prepare("UPDATE classroom_access_allowlist SET status = 'revoked', updated_at = ? WHERE email = 'student@ntub.edu.tw'").run(now);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_access_allowlist WHERE status = 'active'").get().count, 0);
  assert.equal(db.prepare("SELECT status FROM classroom_access_allowlist WHERE email = 'student@ntub.edu.tw'").get().status, "revoked");
  db.close();
});

test("active course names are unique for the shared term and reusable after soft deletion", async () => {
  const db = await classroomDatabase();
  db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'teacher', 'active', ?, ?)")
    .run("teacher-1", "teacher@ntub.edu.tw", "教師", "2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z");
  db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'teacher', 'active', ?, ?)")
    .run("teacher-2", "teacher2@ntub.edu.tw", "第二位教師", "2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z");
  const insert = db.prepare(`INSERT INTO classroom_courses
    (id, owner_user_id, name, name_key, academic_year, term, status, version, created_at, updated_at, deleted_at)
    VALUES (?, 'teacher-1', ?, '資料庫', 115, '1', 'active', 1, ?, ?, NULL)`);
  insert.run("course-1", "資料庫", "2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z");
  assert.throws(() => insert.run("course-2", "資料庫", "2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z"), /UNIQUE/iu);
  assert.throws(() => db.prepare(`INSERT INTO classroom_courses
    (id, owner_user_id, name, name_key, academic_year, term, status, version, created_at, updated_at, deleted_at)
    VALUES ('course-3', 'teacher-2', '資料庫', '資料庫', 115, '1', 'active', 1, ?, ?, NULL)`)
    .run("2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z"), /UNIQUE/iu);
  db.prepare("UPDATE classroom_courses SET status = 'deleted', deleted_at = ?, version = version + 1 WHERE id = 'course-1'")
    .run("2026-08-05T01:00:00.000Z");
  insert.run("course-2", "資料庫", "2026-08-05T01:01:00.000Z", "2026-08-05T01:01:00.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_courses WHERE status = 'active'").get().count, 1);
  db.close();
});

test("course memberships cannot reference missing users or courses", async () => {
  const db = await classroomDatabase();
  assert.throws(() => db.prepare(`INSERT INTO classroom_course_members
    (id, course_id, user_id, role, status, joined_at, updated_at)
    VALUES ('member-1', 'missing-course', 'missing-user', 'student', 'active', ?, ?)`)
    .run("2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z"), /FOREIGN KEY/iu);
  db.close();
});

test("a course roster keeps one active identity per student number", async () => {
  const db = await classroomDatabase();
  const now = "2026-08-06T00:00:00.000Z";
  db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'teacher', 'active', ?, ?)")
    .run("teacher-1", "teacher@ntub.edu.tw", "教師", now, now);
  db.prepare(`INSERT INTO classroom_courses
    (id, owner_user_id, name, name_key, academic_year, term, status, version, created_at, updated_at, deleted_at)
    VALUES ('course-1', 'teacher-1', '資料庫', '資料庫', 115, '1', 'active', 1, ?, ?, NULL)`).run(now, now);
  const insert = db.prepare(`INSERT INTO classroom_course_roster
    (id, course_id, student_id, email, display_name, status, source_file_name, imported_by_user_id, imported_at, updated_at)
    VALUES (?, 'course-1', '11256001', ?, '王小明', 'active', 'roster.xlsx', 'teacher-1', ?, ?)`);
  insert.run("roster-1", "11256001@ntub.edu.tw", now, now);
  assert.throws(() => insert.run("roster-2", "alternate@ntub.edu.tw", now, now), /UNIQUE/iu);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_course_roster WHERE status = 'active'").get().count, 1);
  db.close();
});

test("a reusable question belongs to one course and enforces usage counters", async () => {
  const db = await classroomDatabase();
  const now = "2026-08-06T00:00:00.000Z";
  db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'teacher', 'active', ?, ?)")
    .run("teacher-1", "teacher@ntub.edu.tw", "教師", now, now);
  db.prepare(`INSERT INTO classroom_courses
    (id, owner_user_id, name, name_key, academic_year, term, status, version, created_at, updated_at, deleted_at)
    VALUES ('course-1', 'teacher-1', '資料庫', '資料庫', 115, '1', 'active', 1, ?, ?, NULL)`).run(now, now);
  const insert = db.prepare(`INSERT INTO classroom_course_question_bank
    (id, course_id, title, question_text, ranking_criteria, status, usage_count, last_used_at,
     version, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, '正規化判斷', '請判斷是否符合第三正規化。', '請依正確性與理由排序。', 'ready', ?, NULL, 1, 'teacher-1', ?, ?)`);
  insert.run("question-bank-1", "course-1", 0, now, now);
  assert.throws(() => insert.run("question-bank-2", "course-1", -1, now, now), /CHECK constraint/iu);
  assert.throws(() => insert.run("question-bank-3", "missing-course", 0, now, now), /FOREIGN KEY/iu);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_course_question_bank WHERE status = 'ready'").get().count, 1);
  db.close();
});
