const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export const OPERATIONS_BOOTSTRAP_SCHEMA_VERSION = "0004";
export const OPERATIONS_BOOTSTRAP_STATE_TABLE = "ops_runtime_schema_state";
export const OPERATIONS_BOOTSTRAP_GUARD_TABLE = "ops_runtime_schema_phase_guards";
export const OPERATIONS_FINAL_SCHEMA_FINGERPRINT = "415323881a3ddc7d27764c2b51b5ce6101bde9ef6b6b5460383e37453635bfc9";
export const OPERATIONS_WRANGLER_MIGRATIONS = [
  "0001_continuity_ops_v2.sql",
  "0002_continuity_ops_contract_upgrade.sql",
  "0003_assignment_role_integrity.sql",
  "0004_service_lifecycle_accountability.sql",
] as const;

export type OperationsSchemaObjectType = "table" | "index" | "trigger";

export type OperationsSchemaInventory = {
  tables: readonly string[];
  indexes: readonly string[];
  triggers: readonly string[];
};

export type OperationsSchemaBootstrapPlan = {
  schemaVersion: string;
  phases: readonly (readonly string[])[];
  inventoryByPhase: readonly OperationsSchemaInventory[];
  finalInventory: OperationsSchemaInventory;
};

export type OperationsSchemaBootstrapCaller = {
  verified: boolean;
  email: string | null | undefined;
};

export type OperationsSchemaBootstrapResult = {
  ready: boolean;
  status: "ready" | "initializing" | "unauthorized" | "mismatch" | "phase_failed";
  phase: number;
  schemaVersion: string;
  schemaDigest: string;
  planDigest: string;
  /** Number of D1 prepared statements submitted by this ensure call. */
  queryCount: number;
  reason?: "bootstrap_identity_required" | "untracked_schema_objects" | "state_missing" | "state_mismatch" | "inventory_mismatch" | "phase_execution_failed";
};

type RuntimeSchemaStateRow = {
  schema_version: string;
  schema_digest: string;
  phase: number;
  status: string;
};

type SchemaObjectRow = {
  type: OperationsSchemaObjectType;
  name: string;
  sql: string;
};

type QueryCounter = { count: number };

const CREATE_STATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${OPERATIONS_BOOTSTRAP_STATE_TABLE} (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  schema_version TEXT NOT NULL,
  schema_digest TEXT NOT NULL,
  phase INTEGER NOT NULL CHECK (phase BETWEEN 0 AND 3),
  status TEXT NOT NULL CHECK (status IN ('initializing', 'ready')),
  updated_at TEXT NOT NULL,
  completed_at TEXT
)`;

const CREATE_GUARD_TABLE_SQL = `CREATE TABLE IF NOT EXISTS ${OPERATIONS_BOOTSTRAP_GUARD_TABLE} (
  token TEXT PRIMARY KEY NOT NULL,
  passed INTEGER NOT NULL CHECK (passed = 1)
)`;

function splitMigrationStatements(sql: string): string[] {
  return sql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function statementSqlStart(statement: string): string {
  return statement.replace(/^(?:\s*--[^\r\n]*(?:\r?\n|$))+/u, "").trimStart();
}

function isTriggerStatement(statement: string): boolean {
  return /^CREATE\s+TRIGGER\b/iu.test(statementSqlStart(statement));
}

function isIndexStatement(statement: string): boolean {
  return /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/iu.test(statementSqlStart(statement));
}

function schemaObject(statement: string): { type: OperationsSchemaObjectType; name: string } | null {
  const match = /^CREATE\s+(?:(UNIQUE)\s+)?(TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([A-Za-z0-9_]+)/iu.exec(statementSqlStart(statement));
  if (!match) return null;
  const rawType = match[2].toLowerCase();
  if (rawType !== "table" && rawType !== "index" && rawType !== "trigger") return null;
  return { type: rawType, name: match[3] };
}

function inventoryFromStatements(statements: readonly string[]): OperationsSchemaInventory {
  const tables = new Set<string>();
  const indexes = new Set<string>();
  const triggers = new Set<string>();
  for (const statement of statements) {
    const object = schemaObject(statement);
    if (!object) continue;
    if (object.type === "table") tables.add(object.name);
    if (object.type === "index") indexes.add(object.name);
    if (object.type === "trigger") triggers.add(object.name);
  }
  return {
    tables: [...tables].sort(),
    indexes: [...indexes].sort(),
    triggers: [...triggers].sort(),
  };
}

function assertInventory(inventory: OperationsSchemaInventory, expected: { tables: number; indexes: number; triggers: number }): void {
  if (inventory.tables.length !== expected.tables || inventory.indexes.length !== expected.indexes || inventory.triggers.length !== expected.triggers) {
    throw new Error(
      `Operations bootstrap inventory changed: expected ${expected.tables}/${expected.indexes}/${expected.triggers}, received ${inventory.tables.length}/${inventory.indexes.length}/${inventory.triggers.length}.`,
    );
  }
}

/**
 * Builds a fresh-database-only schema plan. Migration 0002 is intentionally not
 * accepted: it is a legacy data rebuild, while current 0001 already describes
 * the final pre-0003 contract. Runtime bootstrap must never upgrade live data.
 */
export function createFreshOperationsSchemaPlan(
  migration0001: string,
  migration0003: string,
  migration0004: string,
): OperationsSchemaBootstrapPlan {
  const statements0001 = splitMigrationStatements(migration0001).filter((statement) => !/^PRAGMA\b/iu.test(statementSqlStart(statement)));
  const statements0003 = splitMigrationStatements(migration0003).filter(isTriggerStatement);
  const statements0004 = splitMigrationStatements(migration0004);

  const triggers = [
    ...statements0001.filter(isTriggerStatement),
    ...statements0003,
    ...statements0004.filter(isTriggerStatement),
  ];
  const nonTriggers = [
    ...statements0001.filter((statement) => !isTriggerStatement(statement)),
    ...statements0004.filter((statement) => !isTriggerStatement(statement)),
  ];
  const indexes = nonTriggers.filter(isIndexStatement);
  const structuralStatements = nonTriggers.filter((statement) => !isIndexStatement(statement));

  const allStatements = [...nonTriggers, ...triggers];
  const finalInventory = inventoryFromStatements(allStatements);
  assertInventory(finalInventory, { tables: 14, indexes: 20, triggers: 46 });
  if (structuralStatements.length !== 19 || indexes.length !== 20 || triggers.length !== 46) {
    throw new Error(
      `Operations bootstrap statement inventory changed: structures=${structuralStatements.length}, indexes=${indexes.length}, triggers=${triggers.length}.`,
    );
  }

  const phases = [
    [...structuralStatements, ...indexes.slice(0, 10)],
    [...indexes.slice(10), ...triggers.slice(0, 23)],
    triggers.slice(23),
  ] as const;
  for (const [index, phase] of phases.entries()) {
    // Each runtime phase adds one guard, one state update, and one guard delete.
    if (phase.length + 3 >= 40) {
      throw new Error(`Operations bootstrap phase ${index + 1} exceeds the 39-statement safety budget.`);
    }
  }

  const inventoryByPhase: OperationsSchemaInventory[] = [{ tables: [], indexes: [], triggers: [] }];
  const completed: string[] = [];
  for (const phase of phases) {
    completed.push(...phase);
    inventoryByPhase.push(inventoryFromStatements(completed));
  }

  return {
    schemaVersion: OPERATIONS_BOOTSTRAP_SCHEMA_VERSION,
    phases,
    inventoryByPhase,
    finalInventory,
  };
}

export async function operationsSchemaPlanDigest(plan: OperationsSchemaBootstrapPlan): Promise<string> {
  const canonical = plan.phases
    .map((phase, index) => `phase:${index + 1}\n${phase
      .map((statement) => statement.trim().replace(/\r\n?/gu, "\n"))
      .join("\n-- statement --\n")}`)
    .join("\n-- phase --\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized) ? normalized : "";
}

export function isOperationsSchemaBootstrapAuthorized(
  caller: OperationsSchemaBootstrapCaller | null | undefined,
  configuredBootstrapEmail: unknown,
): boolean {
  if (!caller?.verified) return false;
  const callerEmail = normalizeEmail(caller.email);
  const configuredEmail = normalizeEmail(configuredBootstrapEmail);
  return Boolean(callerEmail && configuredEmail && callerEmail === configuredEmail);
}

function inventoryEquals(actual: OperationsSchemaInventory, expected: OperationsSchemaInventory): boolean {
  return actual.tables.join("\n") === expected.tables.join("\n")
    && actual.indexes.join("\n") === expected.indexes.join("\n")
    && actual.triggers.join("\n") === expected.triggers.join("\n");
}

async function stateTableExists(db: D1Database, counter: QueryCounter): Promise<boolean> {
  counter.count += 1;
  const row = await db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?",
  ).bind(OPERATIONS_BOOTSTRAP_STATE_TABLE).first<{ name: string }>();
  return row?.name === OPERATIONS_BOOTSTRAP_STATE_TABLE;
}

async function readState(db: D1Database, counter: QueryCounter): Promise<RuntimeSchemaStateRow | null> {
  counter.count += 1;
  return db.prepare(
    `SELECT schema_version, schema_digest, phase, status FROM ${OPERATIONS_BOOTSTRAP_STATE_TABLE} WHERE singleton = 1`,
  ).first<RuntimeSchemaStateRow>();
}

async function readSchemaSnapshot(db: D1Database, counter: QueryCounter): Promise<{
  inventory: OperationsSchemaInventory;
  fingerprint: string;
}> {
  counter.count += 1;
  const result = await db.prepare(
    `SELECT type, name, sql FROM sqlite_schema
     WHERE type IN ('table', 'index', 'trigger')
       AND name LIKE 'ops_%'
       AND name NOT IN (?, ?)
       AND sql IS NOT NULL
     ORDER BY type, name`,
  ).bind(OPERATIONS_BOOTSTRAP_STATE_TABLE, OPERATIONS_BOOTSTRAP_GUARD_TABLE).all<SchemaObjectRow>();
  const inventory = {
    tables: result.results.filter((row) => row.type === "table").map((row) => row.name).sort(),
    indexes: result.results.filter((row) => row.type === "index").map((row) => row.name).sort(),
    triggers: result.results.filter((row) => row.type === "trigger").map((row) => row.name).sort(),
  };
  const canonical = result.results
    .map((row) => `${row.type}:${row.name}:${canonicalizeOperationsSchemaSql(row.sql)}`)
    .sort()
    .join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { inventory, fingerprint };
}

async function hasExactWranglerMigrationHistory(db: D1Database, counter: QueryCounter): Promise<boolean> {
  counter.count += 1;
  const migrationTable = await db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'",
  ).first<{ name: string }>();
  if (!migrationTable) return false;
  counter.count += 1;
  const result = await db.prepare("SELECT id, name FROM d1_migrations ORDER BY id").all<{ id: number; name: string }>();
  return result.results.length === OPERATIONS_WRANGLER_MIGRATIONS.length
    && result.results.every((row, index) => row.id === index + 1 && row.name === OPERATIONS_WRANGLER_MIGRATIONS[index]);
}

function resultFromState(state: RuntimeSchemaStateRow, expectedDigest: string, queryCount: number): OperationsSchemaBootstrapResult {
  if (state.schema_version !== OPERATIONS_BOOTSTRAP_SCHEMA_VERSION || state.schema_digest !== expectedDigest) {
    return {
      ready: false,
      status: "mismatch",
      phase: state.phase,
      schemaVersion: state.schema_version,
      schemaDigest: state.schema_digest,
      planDigest: expectedDigest,
      queryCount,
      reason: "state_mismatch",
    };
  }
  const ready = state.status === "ready" && state.phase === 3;
  return {
    ready,
    status: ready ? "ready" : "initializing",
    phase: state.phase,
    schemaVersion: state.schema_version,
    schemaDigest: state.schema_digest,
    planDigest: expectedDigest,
    queryCount,
  };
}

async function initializeState(db: D1Database, digest: string, now: string, counter: QueryCounter, ready = false): Promise<void> {
  const statements = [
    db.prepare(CREATE_STATE_TABLE_SQL),
    db.prepare(CREATE_GUARD_TABLE_SQL),
    db.prepare(
      `INSERT OR IGNORE INTO ${OPERATIONS_BOOTSTRAP_STATE_TABLE}
        (singleton, schema_version, schema_digest, phase, status, updated_at, completed_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      OPERATIONS_BOOTSTRAP_SCHEMA_VERSION,
      digest,
      ready ? 3 : 0,
      ready ? "ready" : "initializing",
      now,
      ready ? now : null,
    ),
  ];
  counter.count += statements.length;
  await db.batch(statements);
}

async function executePhase(
  db: D1Database,
  plan: OperationsSchemaBootstrapPlan,
  digest: string,
  phase: number,
  now: string,
  counter: QueryCounter,
): Promise<void> {
  const nextPhase = phase + 1;
  const guardToken = `schema-${crypto.randomUUID()}`;
  const statements = [
    db.prepare(
      `INSERT INTO ${OPERATIONS_BOOTSTRAP_GUARD_TABLE} (token, passed)
       SELECT ?, CASE WHEN EXISTS (
         SELECT 1 FROM ${OPERATIONS_BOOTSTRAP_STATE_TABLE}
         WHERE singleton = 1 AND schema_version = ? AND schema_digest = ?
           AND phase = ? AND status = 'initializing'
       ) THEN 1 ELSE 0 END`,
    ).bind(guardToken, plan.schemaVersion, digest, phase),
    ...plan.phases[phase].map((statement) => db.prepare(statement)),
    db.prepare(
      `UPDATE ${OPERATIONS_BOOTSTRAP_STATE_TABLE}
       SET phase = ?, status = ?, updated_at = ?, completed_at = ?
       WHERE singleton = 1 AND schema_version = ? AND schema_digest = ?
         AND phase = ? AND status = 'initializing'`,
    ).bind(
      nextPhase,
      "initializing",
      now,
      null,
      plan.schemaVersion,
      digest,
      phase,
    ),
    db.prepare(`DELETE FROM ${OPERATIONS_BOOTSTRAP_GUARD_TABLE} WHERE token = ?`).bind(guardToken),
  ];
  counter.count += statements.length;
  await db.batch(statements);
}

async function finalizeReadyState(
  db: D1Database,
  plan: OperationsSchemaBootstrapPlan,
  digest: string,
  now: string,
  counter: QueryCounter,
): Promise<void> {
  const guardToken = `schema-ready-${crypto.randomUUID()}`;
  const statements = [
    db.prepare(
      `INSERT INTO ${OPERATIONS_BOOTSTRAP_GUARD_TABLE} (token, passed)
       SELECT ?, CASE WHEN EXISTS (
         SELECT 1 FROM ${OPERATIONS_BOOTSTRAP_STATE_TABLE}
         WHERE singleton = 1 AND schema_version = ? AND schema_digest = ?
           AND phase = ? AND status = 'initializing'
       ) THEN 1 ELSE 0 END`,
    ).bind(guardToken, plan.schemaVersion, digest, plan.phases.length),
    db.prepare(
      `UPDATE ${OPERATIONS_BOOTSTRAP_STATE_TABLE}
       SET status = 'ready', updated_at = ?, completed_at = ?
       WHERE singleton = 1 AND schema_version = ? AND schema_digest = ?
         AND phase = ? AND status = 'initializing'`,
    ).bind(now, now, plan.schemaVersion, digest, plan.phases.length),
    db.prepare(`DELETE FROM ${OPERATIONS_BOOTSTRAP_GUARD_TABLE} WHERE token = ?`).bind(guardToken),
  ];
  counter.count += statements.length;
  await db.batch(statements);
}

export async function ensureOperationsSchemaCore(options: {
  db: D1Database;
  plan: OperationsSchemaBootstrapPlan;
  planDigest: string;
  caller: OperationsSchemaBootstrapCaller | null | undefined;
  configuredBootstrapEmail: unknown;
  now?: string;
}): Promise<OperationsSchemaBootstrapResult> {
  const { db, plan, planDigest } = options;
  const now = options.now ?? new Date().toISOString();
  const counter: QueryCounter = { count: 0 };
  const authorized = isOperationsSchemaBootstrapAuthorized(options.caller, options.configuredBootstrapEmail);
  const hasStateTable = await stateTableExists(db, counter);

  if (!hasStateTable) {
    if (!authorized) {
      return {
        ready: false,
        status: "unauthorized",
        phase: 0,
        schemaVersion: plan.schemaVersion,
        schemaDigest: planDigest,
        planDigest,
        queryCount: counter.count,
        reason: "bootstrap_identity_required",
      };
    }
    const existingSnapshot = await readSchemaSnapshot(db, counter);
    if (inventoryEquals(existingSnapshot.inventory, plan.finalInventory)
      && existingSnapshot.fingerprint === OPERATIONS_FINAL_SCHEMA_FINGERPRINT
      && await hasExactWranglerMigrationHistory(db, counter)) {
      // A database prepared by the checked-in Wrangler migration chain can be
      // adopted without replaying DDL. The ready marker is written atomically.
      await initializeState(db, planDigest, now, counter, true);
      const adoptedState = await readState(db, counter);
      if (adoptedState) return resultFromState(adoptedState, planDigest, counter.count);
      return {
        ready: false,
        status: "mismatch",
        phase: 0,
        schemaVersion: plan.schemaVersion,
        schemaDigest: planDigest,
        planDigest,
        queryCount: counter.count,
        reason: "state_missing",
      };
    }
    if (!inventoryEquals(existingSnapshot.inventory, plan.inventoryByPhase[0])) {
      return {
        ready: false,
        status: "mismatch",
        phase: 0,
        schemaVersion: plan.schemaVersion,
        schemaDigest: planDigest,
        planDigest,
        queryCount: counter.count,
        reason: "untracked_schema_objects",
      };
    }
    await initializeState(db, planDigest, now, counter);
  }

  let state = await readState(db, counter);
  if (!state) {
    return {
      ready: false,
      status: "mismatch",
      phase: 0,
      schemaVersion: plan.schemaVersion,
      schemaDigest: planDigest,
      planDigest,
      queryCount: counter.count,
      reason: "state_missing",
    };
  }
  let stateResult = resultFromState(state, planDigest, counter.count);
  if (stateResult.status === "mismatch") return stateResult;
  if (!Number.isInteger(state.phase) || state.phase < 0 || state.phase > plan.phases.length) {
    return { ...stateResult, ready: false, status: "mismatch", reason: "state_mismatch" };
  }

  const actualSnapshot = await readSchemaSnapshot(db, counter);
  stateResult = resultFromState(state, planDigest, counter.count);
  const expectedInventory = plan.inventoryByPhase[state.phase];
  if (!expectedInventory || !inventoryEquals(actualSnapshot.inventory, expectedInventory)) {
    return { ...stateResult, ready: false, status: "mismatch", reason: "inventory_mismatch" };
  }
  if (state.phase === plan.phases.length && actualSnapshot.fingerprint !== OPERATIONS_FINAL_SCHEMA_FINGERPRINT) {
    return { ...stateResult, ready: false, status: "mismatch", reason: "inventory_mismatch" };
  }
  if (stateResult.ready) return stateResult;
  if (!authorized) {
    return { ...stateResult, ready: false, status: "unauthorized", reason: "bootstrap_identity_required" };
  }

  if (state.phase === plan.phases.length) {
    try {
      await finalizeReadyState(db, plan, planDigest, now, counter);
      return {
        ready: true,
        status: "ready",
        phase: plan.phases.length,
        schemaVersion: plan.schemaVersion,
        schemaDigest: planDigest,
        planDigest,
        queryCount: counter.count,
      };
    } catch (error) {
      state = await readState(db, counter);
      if (state) {
        const concurrentResult = resultFromState(state, planDigest, counter.count);
        if (concurrentResult.ready) return concurrentResult;
      }
      void error;
      return { ...stateResult, ready: false, status: "phase_failed", queryCount: counter.count, reason: "phase_execution_failed" };
    }
  }

  try {
    await executePhase(db, plan, planDigest, state.phase, now, counter);
  } catch (error) {
    // A competing isolate may have committed this phase first. D1 serializes
    // batch transactions, so re-read the durable marker before classifying it.
    state = await readState(db, counter);
    if (state) {
      let concurrentResult = resultFromState(state, planDigest, counter.count);
      if (concurrentResult.status !== "mismatch" && (state.phase > stateResult.phase || concurrentResult.ready)) {
        const concurrentSnapshot = await readSchemaSnapshot(db, counter);
        concurrentResult = resultFromState(state, planDigest, counter.count);
        const expectedConcurrentInventory = plan.inventoryByPhase[state.phase];
        const fingerprintMatches = state.phase !== plan.phases.length
          || concurrentSnapshot.fingerprint === OPERATIONS_FINAL_SCHEMA_FINGERPRINT;
        if (expectedConcurrentInventory && inventoryEquals(concurrentSnapshot.inventory, expectedConcurrentInventory) && fingerprintMatches) {
          return concurrentResult;
        }
      }
    }
    void error;
    return {
      ...stateResult,
      ready: false,
      status: "phase_failed",
      queryCount: counter.count,
      reason: "phase_execution_failed",
    };
  }

  const nextPhase = state.phase + 1;
  if (nextPhase === plan.phases.length) {
    const finalSnapshot = await readSchemaSnapshot(db, counter);
    if (!inventoryEquals(finalSnapshot.inventory, plan.finalInventory)
      || finalSnapshot.fingerprint !== OPERATIONS_FINAL_SCHEMA_FINGERPRINT) {
      return {
        ...stateResult,
        ready: false,
        status: "mismatch",
        phase: nextPhase,
        queryCount: counter.count,
        reason: "inventory_mismatch",
      };
    }
    try {
      await finalizeReadyState(db, plan, planDigest, now, counter);
    } catch (error) {
      state = await readState(db, counter);
      if (state) {
        const concurrentResult = resultFromState(state, planDigest, counter.count);
        if (concurrentResult.ready) return concurrentResult;
      }
      void error;
      return {
        ...stateResult,
        ready: false,
        status: "phase_failed",
        phase: nextPhase,
        queryCount: counter.count,
        reason: "phase_execution_failed",
      };
    }
  }

  return {
    ready: nextPhase === plan.phases.length,
    status: nextPhase === plan.phases.length ? "ready" : "initializing",
    phase: nextPhase,
    schemaVersion: plan.schemaVersion,
    schemaDigest: planDigest,
    planDigest,
    queryCount: counter.count,
  };
}

export function createCachedOperationsSchemaEnsurer(
  plan: OperationsSchemaBootstrapPlan,
  planDigestPromise: Promise<string>,
): (options: {
  db: D1Database;
  caller: OperationsSchemaBootstrapCaller | null | undefined;
  configuredBootstrapEmail: unknown;
  now?: string;
}) => Promise<OperationsSchemaBootstrapResult> {
  const readyByDatabase = new WeakMap<D1Database, OperationsSchemaBootstrapResult>();
  const inFlightByDatabase = new WeakMap<D1Database, Promise<OperationsSchemaBootstrapResult>>();

  return async (options) => {
    const cached = readyByDatabase.get(options.db);
    if (cached) return { ...cached, queryCount: 0 };

    const existing = inFlightByDatabase.get(options.db);
    if (existing) return { ...(await existing), queryCount: 0 };

    const current = (async () => ensureOperationsSchemaCore({
      ...options,
      plan,
      planDigest: await planDigestPromise,
    }))();
    inFlightByDatabase.set(options.db, current);
    try {
      const result = await current;
      if (result.ready && result.status === "ready") readyByDatabase.set(options.db, result);
      return result;
    } finally {
      if (inFlightByDatabase.get(options.db) === current) inFlightByDatabase.delete(options.db);
    }
  };
}

export function canonicalizeOperationsSchemaSql(sql: string): string {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/giu, "")
    .replace(/["`]/gu, "")
    .replace(/\s+/gu, "")
    .toLowerCase();
}
