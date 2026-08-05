import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrls = [
  new URL("../drizzle/0001_classroom_courses.sql", import.meta.url),
  new URL("../drizzle/0002_classroom_access_approval.sql", import.meta.url),
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
    "classroom_courses",
    "classroom_seed_state",
    "classroom_users",
  ]);
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
