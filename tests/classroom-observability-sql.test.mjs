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

async function observabilityDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migrationUrl of migrationUrls) {
    const migration = await readFile(migrationUrl, "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      db.prepare(statement).run();
    }
  }
  const now = "2026-08-08T00:00:00.000Z";
  db.prepare(`INSERT INTO classroom_users
    (id, email, display_name, role, status, created_at, last_seen_at)
    VALUES ('teacher-observability', 'observability@ntub.edu.tw', '系統管理員', 'teacher', 'active', ?, ?)`).run(now, now);
  return db;
}

function insertOperationLog(db, requestId, occurredAt) {
  db.prepare(`INSERT INTO classroom_operation_logs
    (id, request_id, actor_user_id, actor_kind, method, route, scope_type, scope_id, outcome, status_code,
     error_code, duration_ms, capture_kind, test_mode, environment, security_relevant, release, occurred_at)
    VALUES (?, ?, 'teacher-observability', 'administrator', 'GET', '/api/classroom/courses', 'system', NULL,
      'success', 200, NULL, 25, 'sample', 0, 'production', 0, 'release-1', ?)`).run(`oplog-${requestId}`, requestId, occurredAt);
}

test("retention removes expired unreferenced logs but preserves both incident request links", async () => {
  const source = await readFile(new URL("../db/classroom-observability.ts", import.meta.url), "utf8");
  const functionStart = source.indexOf("async function pruneOperationLogsIfNeeded");
  const functionEnd = source.indexOf("\n}\n", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart, "retention implementation is missing");
  const implementation = source.slice(functionStart, functionEnd + 3);
  assert.match(implementation, /classroom_incidents/u, "retention must account for incident references");
  assert.match(implementation, /source_request_id/u, "the source request of an incident must be retained");
  assert.match(implementation, /verification_request_id/u, "the verification request of an incident must be retained");

  const sqlMatch = implementation.match(/db\.prepare\(\s*(?:`([^`]*)`|"([^"]*)")\s*,?\s*\)\.bind\(cutoff\)\.run\(\)/u);
  assert.ok(sqlMatch, "retention SQL must remain an inspectable prepared statement bound to cutoff");
  const retentionSql = sqlMatch[1] ?? sqlMatch[2];

  const db = await observabilityDatabase();
  const expired = "2026-01-01T00:00:00.000Z";
  const current = "2026-08-08T00:00:00.000Z";
  const sourceRequestId = "req-00000000-0000-4000-8000-000000000001";
  const verificationRequestId = "req-00000000-0000-4000-8000-000000000002";
  const expiredUnreferencedId = "req-00000000-0000-4000-8000-000000000003";
  const currentId = "req-00000000-0000-4000-8000-000000000004";
  insertOperationLog(db, sourceRequestId, expired);
  insertOperationLog(db, verificationRequestId, expired);
  insertOperationLog(db, expiredUnreferencedId, expired);
  insertOperationLog(db, currentId, current);
  db.prepare(`INSERT INTO classroom_incidents
    (id, title, severity, status, source_request_id, verification_request_id, symptom, root_cause, resolution,
     fix_release, regression_check, regression_command, regression_evidence, verification_result,
     created_by_user_id, updated_by_user_id, version, detected_at, resolved_at, verified_at, created_at, updated_at)
    VALUES ('incident-retention', '資料庫結構版本不一致', 'high', 'resolved', ?, ?, '課堂資料無法載入',
      '正式資料庫遷移落後', '執行遷移並重新發布', 'release-1', '再次取得課堂資料', 'npm run gate:ci',
      '驗證請求回傳 200', 'passed', 'teacher-observability', 'teacher-observability', 1, ?, ?, ?, ?, ?)`)
    .run(sourceRequestId, verificationRequestId, expired, current, current, expired, current);

  db.prepare(retentionSql).run("2026-05-10T00:00:00.000Z");
  const remaining = db.prepare("SELECT request_id FROM classroom_operation_logs ORDER BY request_id").all().map((row) => row.request_id);
  assert.deepEqual(remaining, [sourceRequestId, verificationRequestId, currentId].sort());
  const incident = db.prepare(`SELECT source_request_id, verification_request_id
    FROM classroom_incidents WHERE id = 'incident-retention'`).get();
  assert.equal(incident.source_request_id, sourceRequestId);
  assert.equal(incident.verification_request_id, verificationRequestId);
  db.close();
});

test("observability storage has no columns for request bodies, tokens, emails, or classroom answers", async () => {
  const db = await observabilityDatabase();
  const columns = db.prepare("PRAGMA table_info(classroom_operation_logs)").all().map((row) => row.name);
  for (const forbidden of ["request_body", "response_body", "token", "email", "join_code", "answer", "ranking"]) {
    assert.equal(columns.includes(forbidden), false, `${forbidden} must not be stored in operation logs`);
  }
  db.close();
});

test("incident update and audit are atomic and a version conflict leaves no audit event", async () => {
  const source = await readFile(new URL("../db/classroom-observability.ts", import.meta.url), "utf8");
  assert.match(source, /SELECT outcome, release, occurred_at FROM classroom_operation_logs/u);
  assert.match(source, /const \[result\] = await db\.batch\(\[update, audit\]\)/u);
  const auditSql = source.match(/const audit = db\.prepare\(\s*`([^`]*)`/u)?.[1];
  assert.ok(auditSql, "conditional incident audit SQL is missing");
  assert.match(auditSql, /WHERE changes\(\) = 1/u);

  const db = await observabilityDatabase();
  const now = "2026-08-08T02:00:00.000Z";
  db.prepare(`INSERT INTO classroom_incidents
    (id, title, severity, status, symptom, created_by_user_id, updated_by_user_id,
     version, detected_at, created_at, updated_at)
    VALUES ('incident-atomic-audit', '課程資料取得失敗', 'high', 'investigating', '教師無法載入本次課程資料',
      'teacher-observability', 'teacher-observability', 1, ?, ?, ?)`).run(now, now, now);

  const update = db.prepare(`UPDATE classroom_incidents
    SET title = ?, version = version + 1, updated_at = ?
    WHERE id = ? AND version = ?`);
  const audit = db.prepare(auditSql);
  update.run("課程資料取得失敗（已定位）", "2026-08-08T02:01:00.000Z", "incident-atomic-audit", 1);
  audit.run("audit-success", "teacher-observability", "incident-atomic-audit", "{}", "2026-08-08T02:01:00.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_audit_events WHERE resource_id = 'incident-atomic-audit'").get().count, 1);

  update.run("不應寫入", "2026-08-08T02:02:00.000Z", "incident-atomic-audit", 1);
  audit.run("audit-conflict", "teacher-observability", "incident-atomic-audit", "{}", "2026-08-08T02:02:00.000Z");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_audit_events WHERE resource_id = 'incident-atomic-audit'").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM classroom_audit_events WHERE id = 'audit-conflict'").get().count, 0);
  db.close();
});

test("verification marker endpoint is traced and restricted to system administrators", async () => {
  const route = await readFile(new URL("../app/api/classroom/observability/verification/route.ts", import.meta.url), "utf8");
  assert.match(route, /withClassroomApi\(request/u);
  assert.match(route, /classroomApiContext\(request, true\)/u);
  assert.match(route, /normalizeClassroomRelease\(classroomEnvironment\(\)\.CLASSROOM_RELEASE\)/u);
  assert.match(route, /RELEASE_ID_NOT_CONFIGURED/u);
});
