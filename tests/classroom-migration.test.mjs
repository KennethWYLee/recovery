import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationUrl = new URL("../drizzle/0007_classroom_courses.sql", import.meta.url);

async function classroomDatabase() {
  const migration = await readFile(migrationUrl, "utf8");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
    db.prepare(statement).run();
  }
  return db;
}

test("classroom migration creates the reviewed course boundary", async () => {
  const db = await classroomDatabase();
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'classroom_%' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(tables, [
    "classroom_audit_events",
    "classroom_course_members",
    "classroom_courses",
    "classroom_seed_state",
    "classroom_users",
  ]);
  db.close();
});

test("active course names are unique per teacher and reusable after soft deletion", async () => {
  const db = await classroomDatabase();
  db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'teacher', 'active', ?, ?)")
    .run("teacher-1", "teacher@ntub.edu.tw", "教師", "2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z");
  const insert = db.prepare(`INSERT INTO classroom_courses
    (id, owner_user_id, name, name_key, academic_year, term, status, version, created_at, updated_at, deleted_at)
    VALUES (?, 'teacher-1', ?, '資料庫', 115, '1', 'active', 1, ?, ?, NULL)`);
  insert.run("course-1", "資料庫", "2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z");
  assert.throws(() => insert.run("course-2", "資料庫", "2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z"), /UNIQUE/iu);
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
