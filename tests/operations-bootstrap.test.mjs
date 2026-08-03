import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  OPERATIONS_BOOTSTRAP_GUARD_TABLE,
  OPERATIONS_BOOTSTRAP_STATE_TABLE,
  OPERATIONS_FINAL_SCHEMA_FINGERPRINT,
  OPERATIONS_WRANGLER_MIGRATIONS,
  canonicalizeOperationsSchemaSql,
  createCachedOperationsSchemaEnsurer,
  createFreshOperationsSchemaPlan,
  ensureOperationsSchemaCore,
  operationsSchemaPlanDigest,
} from "../db/operations-bootstrap-core.ts";

const MIGRATION_URLS = OPERATIONS_WRANGLER_MIGRATIONS.map((name) => new URL(`../db/migrations/${name}`, import.meta.url));
const BOOTSTRAP_EMAIL = "bootstrap@example.com";
const AUTHORIZED_CALLER = { verified: true, email: "Bootstrap@Example.com" };

function splitMigration(sql) {
  return sql.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
}

async function migrationSources() {
  return Promise.all(MIGRATION_URLS.map((url) => readFile(url, "utf8")));
}

async function bootstrapPlan() {
  const [migration0001, , migration0003, migration0004] = await migrationSources();
  const plan = createFreshOperationsSchemaPlan(migration0001, migration0003, migration0004);
  return { plan, digest: await operationsSchemaPlanDigest(plan) };
}

class SqliteD1PreparedStatement {
  constructor(owner, sql, bindings = []) {
    this.owner = owner;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new SqliteD1PreparedStatement(this.owner, this.sql, bindings);
  }

  execute() {
    if (this.owner.failurePattern?.test(this.sql)) throw new Error("INJECTED_BOOTSTRAP_FAILURE");
    const statement = this.owner.sqlite.prepare(this.sql);
    if (/^\s*(?:SELECT|PRAGMA|WITH)\b/iu.test(this.sql)) {
      const results = statement.all(...this.bindings);
      return { success: true, results, meta: { changes: 0 } };
    }
    const result = statement.run(...this.bindings);
    return { success: true, results: [], meta: { changes: Number(result.changes ?? 0) } };
  }

  async run() {
    return this.execute();
  }

  async first(column) {
    const row = this.owner.sqlite.prepare(this.sql).get(...this.bindings) ?? null;
    if (row === null || column === undefined) return row;
    return row[column] ?? null;
  }

  async all() {
    return { success: true, results: this.owner.sqlite.prepare(this.sql).all(...this.bindings), meta: { changes: 0 } };
  }
}

class SqliteD1Database {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
    this.failurePattern = null;
    this.batchCalls = 0;
  }

  prepare(sql) {
    return new SqliteD1PreparedStatement(this, sql);
  }

  async batch(statements) {
    this.batchCalls += 1;
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement) => statement.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {
        // The injected or SQLite failure remains authoritative.
      }
      throw error;
    }
  }

  close() {
    this.sqlite.close();
  }
}

function productSchemaRows(sqlite) {
  return sqlite.prepare(
    `SELECT type, name, sql FROM sqlite_schema
     WHERE type IN ('table', 'index', 'trigger') AND name LIKE 'ops_%'
       AND name NOT IN (?, ?) AND sql IS NOT NULL
     ORDER BY type, name`,
  ).all(OPERATIONS_BOOTSTRAP_STATE_TABLE, OPERATIONS_BOOTSTRAP_GUARD_TABLE);
}

function schemaFingerprint(sqlite) {
  const canonical = productSchemaRows(sqlite)
    .map((row) => `${row.type}:${row.name}:${canonicalizeOperationsSchemaSql(row.sql)}`)
    .sort()
    .join("\n");
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
}

function schemaInventory(sqlite) {
  const rows = productSchemaRows(sqlite);
  return {
    tables: rows.filter((row) => row.type === "table").map((row) => row.name).sort(),
    indexes: rows.filter((row) => row.type === "index").map((row) => row.name).sort(),
    triggers: rows.filter((row) => row.type === "trigger").map((row) => row.name).sort(),
  };
}

function canonicalSchema(sqlite) {
  return productSchemaRows(sqlite).map((row) => ({
    type: row.type,
    name: row.name,
    sql: canonicalizeOperationsSchemaSql(row.sql),
  }));
}

async function applyMigrationChain(sqlite, withHistory = false) {
  const migrations = await migrationSources();
  if (withHistory) {
    sqlite.exec(`CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`);
  }
  for (const [index, migration] of migrations.entries()) {
    sqlite.exec("BEGIN");
    try {
      for (const statement of splitMigration(migration)) sqlite.prepare(statement).run();
      if (withHistory) sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(OPERATIONS_WRANGLER_MIGRATIONS[index]);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

async function ensure(db, plan, digest, caller = AUTHORIZED_CALLER) {
  return ensureOperationsSchemaCore({
    db,
    plan,
    planDigest: digest,
    caller,
    configuredBootstrapEmail: BOOTSTRAP_EMAIL,
    now: "2026-07-31T12:00:00.000Z",
  });
}

test("fresh bootstrap plan has three bounded phases and the complete 0004 inventory", async () => {
  const { plan, digest } = await bootstrapPlan();
  assert.equal(digest, "f1bd7d9267db8475f85b17336b125c77f08d9337e51832af4728daa0f08125a3");
  assert.deepEqual(plan.phases.map((phase) => phase.length), [29, 33, 23]);
  assert.ok(plan.phases.every((phase) => phase.length + 3 < 40));
  assert.equal(plan.finalInventory.tables.length, 14);
  assert.equal(plan.finalInventory.indexes.length, 20);
  assert.equal(plan.finalInventory.triggers.length, 46);
});

test("schema plan digest is identical for LF and CRLF migration sources", async () => {
  const [migration0001, , migration0003, migration0004] = await migrationSources();
  const lfSources = [migration0001, migration0003, migration0004]
    .map((source) => source.replace(/\r\n?/gu, "\n"));
  const crlfSources = lfSources.map((source) => source.replace(/\n/gu, "\r\n"));
  const lfPlan = createFreshOperationsSchemaPlan(...lfSources);
  const crlfPlan = createFreshOperationsSchemaPlan(...crlfSources);

  assert.equal(await operationsSchemaPlanDigest(crlfPlan), await operationsSchemaPlanDigest(lfPlan));
});

test("fresh plan produces the same canonical sqlite_schema as migrations 0001 through 0004", async () => {
  const { plan } = await bootstrapPlan();
  const migrated = new DatabaseSync(":memory:");
  const bootstrapped = new DatabaseSync(":memory:");
  migrated.exec("PRAGMA foreign_keys = ON");
  bootstrapped.exec("PRAGMA foreign_keys = ON");
  try {
    await applyMigrationChain(migrated);
    for (const phase of plan.phases) {
      bootstrapped.exec("BEGIN");
      try {
        for (const statement of phase) bootstrapped.prepare(statement).run();
        bootstrapped.exec("COMMIT");
      } catch (error) {
        bootstrapped.exec("ROLLBACK");
        throw error;
      }
    }
    assert.deepEqual(canonicalSchema(bootstrapped), canonicalSchema(migrated));
    assert.equal(await schemaFingerprint(bootstrapped), OPERATIONS_FINAL_SCHEMA_FINGERPRINT);
    assert.deepEqual(bootstrapped.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(bootstrapped.prepare("SELECT COUNT(*) AS count FROM ops_organizations WHERE id = 'ops-singleton'").get().count, 1);
  } finally {
    migrated.close();
    bootstrapped.close();
  }
});

test("only the verified configured bootstrap administrator can initialize a fresh database", async () => {
  const { plan, digest } = await bootstrapPlan();
  const db = new SqliteD1Database();
  try {
    const unverified = await ensure(db, plan, digest, { verified: false, email: BOOTSTRAP_EMAIL });
    assert.equal(unverified.status, "unauthorized");
    assert.equal(unverified.queryCount, 1);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = ?").get(OPERATIONS_BOOTSTRAP_STATE_TABLE).count, 0);

    const wrongEmail = await ensure(db, plan, digest, { verified: true, email: "other@example.com" });
    assert.equal(wrongEmail.status, "unauthorized");

    const phase1 = await ensure(db, plan, digest);
    const phase2 = await ensure(db, plan, digest);
    const phase3 = await ensure(db, plan, digest);
    assert.deepEqual([phase1.phase, phase2.phase, phase3.phase], [1, 2, 3]);
    assert.deepEqual([phase1.status, phase2.status, phase3.status], ["initializing", "initializing", "ready"]);
    assert.ok([phase1, phase2, phase3].every((result) => result.queryCount < 40));
    assert.ok([phase1, phase2, phase3].every((result) => result.planDigest === digest));
    assert.deepEqual(schemaInventory(db.sqlite), plan.finalInventory);
    assert.equal(await schemaFingerprint(db.sqlite), OPERATIONS_FINAL_SCHEMA_FINGERPRINT);

    const batchesBefore = db.batchCalls;
    const repeated = await ensure(db, plan, digest, null);
    assert.equal(repeated.status, "ready");
    assert.equal(repeated.phase, 3);
    assert.equal(db.batchCalls, batchesBefore);
  } finally {
    db.close();
  }
});

test("same-isolate in-flight work is coalesced and a fully verified ready database uses zero-query cache", async () => {
  const { plan, digest } = await bootstrapPlan();
  const db = new SqliteD1Database();
  const cachedEnsure = createCachedOperationsSchemaEnsurer(plan, Promise.resolve(digest));
  const options = {
    db,
    caller: AUTHORIZED_CALLER,
    configuredBootstrapEmail: BOOTSTRAP_EMAIL,
    now: "2026-07-31T12:00:00.000Z",
  };
  try {
    const firstRound = await Promise.all(Array.from({ length: 4 }, () => cachedEnsure(options)));
    assert.equal(firstRound.filter((result) => result.queryCount > 0).length, 1);
    assert.ok(firstRound.every((result) => result.phase === 1));
    assert.equal((await cachedEnsure(options)).phase, 2);
    const completed = await cachedEnsure(options);
    assert.equal(completed.status, "ready");
    assert.ok(completed.queryCount > 0);

    const batchesBefore = db.batchCalls;
    const cached = await cachedEnsure({ ...options, caller: null });
    assert.equal(cached.status, "ready");
    assert.equal(cached.queryCount, 0);
    assert.equal(cached.planDigest, digest);
    assert.equal(db.batchCalls, batchesBefore);
  } finally {
    db.close();
  }
});

test("an exact Wrangler 0001-0004 database is adopted atomically, but bad history is rejected", async () => {
  const { plan, digest } = await bootstrapPlan();
  const valid = new SqliteD1Database();
  const invalid = new SqliteD1Database();
  try {
    await applyMigrationChain(valid.sqlite, true);
    const adopted = await ensure(valid, plan, digest);
    assert.equal(adopted.status, "ready");
    assert.equal(adopted.phase, 3);
    assert.equal(valid.sqlite.prepare(`SELECT status FROM ${OPERATIONS_BOOTSTRAP_STATE_TABLE} WHERE singleton = 1`).get().status, "ready");

    await applyMigrationChain(invalid.sqlite, true);
    invalid.sqlite.prepare("UPDATE d1_migrations SET name = 'wrong.sql' WHERE id = 4").run();
    const rejected = await ensure(invalid, plan, digest);
    assert.equal(rejected.status, "mismatch");
    assert.equal(rejected.reason, "untracked_schema_objects");
    assert.equal(invalid.sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = ?").get(OPERATIONS_BOOTSTRAP_STATE_TABLE).count, 0);
  } finally {
    valid.close();
    invalid.close();
  }
});

test("a failed phase rolls back every statement and can be retried without partial initialization", async () => {
  const { plan, digest } = await bootstrapPlan();
  const db = new SqliteD1Database();
  try {
    const phase1 = await ensure(db, plan, digest);
    assert.equal(phase1.phase, 1);
    const before = schemaInventory(db.sqlite);
    db.failurePattern = /CREATE\s+TRIGGER\s+ops_membership_version_guard/iu;
    const failed = await ensure(db, plan, digest);
    assert.equal(failed.status, "phase_failed");
    assert.equal(failed.phase, 1);
    assert.deepEqual(schemaInventory(db.sqlite), before);
    assert.equal(db.sqlite.prepare(`SELECT phase FROM ${OPERATIONS_BOOTSTRAP_STATE_TABLE} WHERE singleton = 1`).get().phase, 1);
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${OPERATIONS_BOOTSTRAP_GUARD_TABLE}`).get().count, 0);

    db.failurePattern = null;
    assert.equal((await ensure(db, plan, digest)).phase, 2);
    assert.equal((await ensure(db, plan, digest)).status, "ready");
  } finally {
    db.close();
  }
});

test("untracked partial schema and durable digest mismatch fail closed", async () => {
  const { plan, digest } = await bootstrapPlan();
  const partial = new SqliteD1Database();
  const mismatched = new SqliteD1Database();
  try {
    partial.sqlite.exec("CREATE TABLE ops_organizations (id TEXT PRIMARY KEY)");
    const partialResult = await ensure(partial, plan, digest);
    assert.equal(partialResult.status, "mismatch");
    assert.equal(partialResult.reason, "untracked_schema_objects");
    assert.equal(partial.sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = ?").get(OPERATIONS_BOOTSTRAP_STATE_TABLE).count, 0);

    assert.equal((await ensure(mismatched, plan, digest)).phase, 1);
    mismatched.sqlite.prepare(`UPDATE ${OPERATIONS_BOOTSTRAP_STATE_TABLE} SET schema_digest = 'bad-digest' WHERE singleton = 1`).run();
    const mismatchResult = await ensure(mismatched, plan, digest);
    assert.equal(mismatchResult.status, "mismatch");
    assert.equal(mismatchResult.reason, "state_mismatch");
    assert.equal(mismatchResult.planDigest, digest);
  } finally {
    partial.close();
    mismatched.close();
  }
});

test("concurrent bootstrap attempts re-read durable state and converge without duplicate objects", async () => {
  const { plan, digest } = await bootstrapPlan();
  const db = new SqliteD1Database();
  try {
    for (let round = 0; round < 4; round += 1) {
      const results = await Promise.all(Array.from({ length: 4 }, () => ensure(db, plan, digest)));
      assert.ok(results.every((result) => ["initializing", "ready"].includes(result.status)));
      if (results.some((result) => result.ready)) break;
    }
    const final = await ensure(db, plan, digest, null);
    assert.equal(final.status, "ready");
    assert.deepEqual(schemaInventory(db.sqlite), plan.finalInventory);
    assert.equal(new Set(productSchemaRows(db.sqlite).map((row) => `${row.type}:${row.name}`)).size, 80);
  } finally {
    db.close();
  }
});
