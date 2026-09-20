import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(resolve(root, "drizzle")).filter((name) => name.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(resolve(root, "drizzle", name), "utf8"));
  }
  const events = [];
  function prepare(sql, values = []) {
    const read = () => ({ success: true, results: sqlite.prepare(sql).all(...values) });
    const write = () => ({ success: true, meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } });
    return {
      sql, read, write, bind: (...args) => prepare(sql, args),
      async first() { events.push({ reads: 1, writes: 0 }); return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { events.push({ reads: 1, writes: 0 }); return read(); },
      async run() { events.push({ reads: 0, writes: 1 }); return write(); },
    };
  }
  const db = { prepare, async batch(statements) {
    const isRead = (statement) => /^\s*(SELECT|PRAGMA)\b/i.test(statement.sql);
    const reads = statements.filter(isRead).length;
    events.push({ reads, writes: statements.length - reads });
    sqlite.exec("BEGIN");
    try {
      const rows = statements.map((statement) => isRead(statement) ? statement.read() : statement.write());
      sqlite.exec("COMMIT");
      return rows;
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
  return { db, sqlite, events };
}

function modules(db) {
  const cache = new Map();
  const environment = { DB: db, CLASSROOM_ADMIN_EMAILS: "startup-admin@ntub.edu.tw",
    CLASSROOM_ENVIRONMENT: "development", CLASSROOM_LOCAL_USER_ID: "startup-admin",
    CLASSROOM_LOCAL_USER_EMAIL: "startup-admin@ntub.edu.tw", CLASSROOM_LOCAL_USER_NAME: "合成管理員" };
  function load(relative) {
    const filename = resolve(root, relative);
    if (cache.has(filename)) return cache.get(filename).exports;
    const loadedModule = { exports: {} };
    cache.set(filename, loadedModule);
    const require = (name) => {
      if (name === "cloudflare:workers") return { env: environment };
      let target = name.startsWith("@/") ? resolve(root, name.slice(2)) : resolve(dirname(filename), name);
      if (!/\.tsx?$/.test(target)) target += ".ts";
      return load(target);
    };
    const source = ts.transpileModule(readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, { module: loadedModule, exports: loadedModule.exports, require, crypto, TextEncoder, Date, console, URL, Error });
    return loadedModule.exports;
  }
  return { load, environment };
}

async function courses(api, db) {
  const actor = await api.loadOrProvisionClassroomActor(new Request("http://127.0.0.1/api/classroom/courses"));
  assert.ok(actor);
  return api.listClassroomCourses(db, actor);
}

test("existing classroom cold reads use at most six database calls and do not rewrite demo rankings", async (t) => {
  const h = database(t);
  const seeded = await courses(modules(h.db).load("db/classroom.ts"), h.db);
  assert.equal(seeded.length, 7);
  h.events.length = 0;
  const api = modules(h.db).load("db/classroom.ts");
  const cold = await courses(api, h.db);
  assert.equal(cold.length, seeded.length);
  assert.ok(h.events.length <= 6, `${h.events.length} database calls`);
  assert.equal(h.events.reduce((sum, row) => sum + row.writes, 0), 0);
  h.events.length = 0;
  await courses(api, h.db);
  assert.ok(h.events.length <= 2);
  assert.equal(h.events.reduce((sum, row) => sum + row.writes, 0), 0);
});

test("concurrent first reads initialize one complete classroom without duplicate records", async (t) => {
  const h = database(t);
  const api = modules(h.db).load("db/classroom.ts");
  // Provision the actor before exercising concurrent schema/default initialization.
  const email = "startup-admin@ntub.edu.tw";
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email))).toString("hex");
  const now = new Date().toISOString();
  h.sqlite.prepare("INSERT INTO classroom_users VALUES (?, ?, '合成管理員', 'teacher', 'active', ?, ?)")
    .run(`class-user-${digest.slice(0, 24)}`, email, now, now);
  const results = await Promise.all([courses(api, h.db), courses(api, h.db)]);
  assert.deepEqual(results.map((rows) => rows.length), [7, 7]);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM classroom_sessions WHERE id = 'session-demo-classroom'").get().n, 1);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM classroom_question_ranking_items WHERE submission_id LIKE 'qranking-demo-teacher-%'").get().n, 12);
});

for (const kind of ["table", "version", "column", "index"]) {
  test(`schema validation still rejects missing ${kind} and retries after repair`, async (t) => {
    const h = database(t);
    const api = modules(h.db).load("db/classroom.ts");
    let repair;
    if (kind === "table") {
      repair = h.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name = 'classroom_incidents'").get().sql;
      h.sqlite.exec("DROP TABLE classroom_incidents");
    } else if (kind === "version") {
      repair = "UPDATE classroom_schema_state SET schema_version = 9";
      h.sqlite.exec("UPDATE classroom_schema_state SET schema_version = 8");
    } else if (kind === "column") {
      repair = "ALTER TABLE classroom_questions RENAME COLUMN hidden_source TO source_question_bank_id";
      h.sqlite.exec("ALTER TABLE classroom_questions RENAME COLUMN source_question_bank_id TO hidden_source");
    } else {
      repair = h.sqlite.prepare("SELECT sql FROM sqlite_schema WHERE name = 'classroom_question_rankings_current_unique'").get().sql;
      h.sqlite.exec("DROP INDEX classroom_question_rankings_current_unique");
    }
    await assert.rejects(api.ensureClassroomSchema(h.db), /CLASSROOM_SCHEMA_MISMATCH/);
    h.sqlite.exec(repair);
    await api.ensureClassroomSchema(h.db);
  });
}

test("demo initialization repairs missing ranking data without replacing saved content or reviving deleted courses", async (t) => {
  const h = database(t);
  const loaded = modules(h.db);
  await courses(loaded.load("db/classroom.ts"), h.db);
  const { ensureDemoTeacherRankings } = loaded.load("db/classroom-demo-ranking.ts");
  const saved = h.sqlite.prepare("SELECT * FROM classroom_question_ranking_submissions WHERE id = 'qranking-demo-teacher-1'").get();
  h.sqlite.exec("DELETE FROM classroom_question_ranking_items WHERE id = 'qrank-item-demo-teacher-1-3'");
  h.sqlite.exec("DELETE FROM classroom_question_ranking_items WHERE submission_id = 'qranking-demo-teacher-2'");
  h.sqlite.exec("DELETE FROM classroom_question_ranking_submissions WHERE id = 'qranking-demo-teacher-2'");
  h.events.length = 0;
  assert.equal(await ensureDemoTeacherRankings(h.db), true);
  assert.equal(h.events.length, 2);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM classroom_question_ranking_items WHERE submission_id LIKE 'qranking-demo-teacher-%'").get().n, 12);
  assert.deepEqual(h.sqlite.prepare("SELECT * FROM classroom_question_ranking_submissions WHERE id = 'qranking-demo-teacher-1'").get(), saved);
  h.sqlite.exec("UPDATE classroom_courses SET status = 'deleted', deleted_at = '2026-09-20T00:00:00.000Z' WHERE id = 'course-demo-classroom'");
  const current = await courses(modules(h.db).load("db/classroom.ts"), h.db);
  assert.equal(current.some((course) => course.id === "course-demo-classroom"), false);
});
