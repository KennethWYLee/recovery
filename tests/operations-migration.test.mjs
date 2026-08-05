import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const MIGRATION_STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const migrationStatementCounts = new Map([
  ["../db/migrations/0001_continuity_ops_v2.sql", 71],
  ["../db/migrations/0002_continuity_ops_contract_upgrade.sql", 125],
  ["../db/migrations/0003_assignment_role_integrity.sql", 5],
  ["../db/migrations/0004_service_lifecycle_accountability.sql", 13],
  ["../db/migrations/0005_request_observability.sql", 3],
]);

function countTopLevelSqlStatements(migration) {
  let count = 0;
  let inStatement = false;
  let inTrigger = false;

  for (const rawLine of migration.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("--")) {
      continue;
    }

    if (!inStatement) {
      inStatement = true;
      inTrigger = /^CREATE\s+TRIGGER\b/iu.test(line);
    }

    const statementEnded = inTrigger
      ? rawLine === rawLine.trimStart() && /^END;$/iu.test(line)
      : line.endsWith(";");

    if (statementEnded) {
      count += 1;
      inStatement = false;
      inTrigger = false;
    }
  }

  assert.equal(inStatement, false, "Migration ended with incomplete SQL");
  return count;
}

test("each recorded migration boundary contains one complete SQL statement", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");

  for (const [file, expectedStatementCount] of migrationStatementCounts) {
    const migration = await readFile(new URL(file, import.meta.url), "utf8");
    const statements = migration
      .split(MIGRATION_STATEMENT_BREAKPOINT)
      .map((statement) => statement.trim())
      .filter(Boolean);

    assert.equal(
      statements.length,
      countTopLevelSqlStatements(migration),
      `${file} must place a statement breakpoint between every top-level SQL statement`,
    );
    assert.equal(
      statements.length,
      expectedStatementCount,
      `${file} statement inventory changed; verify every new boundary before updating this contract`,
    );

    db.exec("BEGIN");
    try {
      for (const [index, statement] of statements.entries()) {
        try {
          db.prepare(statement).run();
        } catch (cause) {
          throw new Error(`${file} statement ${index + 1} cannot run independently`, { cause });
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // SQLite may already have closed the transaction after an error.
      }
      throw error;
    }
  }

  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("Sites packages the exact reviewed 0005 forward migration", async () => {
  const [canonical, packaged] = await Promise.all([
    readFile(new URL("../db/migrations/0005_request_observability.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0005_request_observability.sql", import.meta.url), "utf8"),
  ]);
  assert.equal(packaged.replace(/\r\n?/gu, "\n"), canonical.replace(/\r\n?/gu, "\n"));
});

test("Sites 0006 advances only the verified 0004 ready-state marker after observability exists", async () => {
  const db = await migratedDatabase();
  const migration = await readFile(new URL("../drizzle/0006_adopt_observability_state.sql", import.meta.url), "utf8");
  db.exec(`CREATE TABLE ops_runtime_schema_state (
    singleton INTEGER PRIMARY KEY NOT NULL,
    schema_version TEXT NOT NULL,
    schema_digest TEXT NOT NULL,
    phase INTEGER NOT NULL,
    status TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )`);
  const insertState = db.prepare(`INSERT INTO ops_runtime_schema_state
    (singleton, schema_version, schema_digest, phase, status, updated_at, completed_at)
    VALUES (1, ?, ?, 3, 'ready', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`);
  try {
    insertState.run("0004", "f1bd7d9267db8475f85b17336b125c77f08d9337e51832af4728daa0f08125a3");
    assert.equal(db.prepare(migration).run().changes, 1);
    const adopted = db.prepare(
      "SELECT schema_version, schema_digest, phase, status FROM ops_runtime_schema_state WHERE singleton = 1",
    ).get();
    assert.equal(adopted.schema_version, "0005");
    assert.equal(adopted.schema_digest, "d375830a0de59dec1d0a29a4ec5b0356e636b72e458ffb0bb888de57225059a3");
    assert.equal(adopted.phase, 3);
    assert.equal(adopted.status, "ready");

    db.exec("DELETE FROM ops_runtime_schema_state");
    insertState.run("0004", "unexpected-digest");
    assert.equal(db.prepare(migration).run().changes, 0);
  } finally {
    db.close();
  }
});

async function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "../db/migrations/0001_continuity_ops_v2.sql",
    "../db/migrations/0002_continuity_ops_contract_upgrade.sql",
    "../db/migrations/0003_assignment_role_integrity.sql",
    "../db/migrations/0004_service_lifecycle_accountability.sql",
    "../db/migrations/0005_request_observability.sql",
  ]) {
    const migration = await readFile(new URL(file, import.meta.url), "utf8");
    db.exec(`BEGIN;\n${migration}\nCOMMIT;`);
  }
  return db;
}

async function databaseThrough0002() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of [
    "../db/migrations/0001_continuity_ops_v2.sql",
    "../db/migrations/0002_continuity_ops_contract_upgrade.sql",
  ]) {
    const migration = await readFile(new URL(file, import.meta.url), "utf8");
    db.exec(`BEGIN;\n${migration}\nCOMMIT;`);
  }
  return db;
}

test("0005 stores bounded request telemetry and rejects unsafe values", async () => {
  const db = await migratedDatabase();
  const insert = db.prepare(`INSERT INTO ops_request_telemetry (
    id, organization_id, request_id, route_template, method, status_code, problem_code,
    latency_ms, api_version, schema_version, deployment_version, environment, source, occurred_at
  ) VALUES (?, 'ops-singleton', ?, ?, ?, ?, ?, ?, '2.2.0', '0005', 'test-build', 'development', ?, ?)`);
  try {
    insert.run("telemetry-runtime", "req-runtime-0001", "/api/v1/incidents/:incidentId", "GET", 200, null, 42, "runtime", "2026-08-05T12:00:00.000Z");
    insert.run("telemetry-simulated", "req-simulated-0001", "/api/v1/overview", "GET", 503, "OPERATIONS_DATABASE_UNAVAILABLE", 1750, "simulated", "2026-08-05T12:01:00.000Z");
    assert.deepEqual(
      db.prepare("SELECT source, status_code, problem_code FROM ops_request_telemetry ORDER BY id").all().map((row) => ({ ...row })),
      [
        { source: "runtime", status_code: 200, problem_code: null },
        { source: "simulated", status_code: 503, problem_code: "OPERATIONS_DATABASE_UNAVAILABLE" },
      ],
    );
    assert.throws(() => insert.run("bad-route", "req-invalid-0001", "/users/secret@example.com", "GET", 200, null, 10, "runtime", "2026-08-05T12:02:00.000Z"));
    assert.throws(() => insert.run("bad-source", "req-invalid-0002", "/api/v1/overview", "GET", 200, null, 10, "external", "2026-08-05T12:02:00.000Z"));
    assert.throws(() => insert.run("bad-latency", "req-invalid-0003", "/api/v1/overview", "GET", 200, null, -1, "runtime", "2026-08-05T12:02:00.000Z"));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

function legacyDatabaseForUpgrade() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE ops_organizations (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ops_users (
      id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, display_name TEXT NOT NULL,
      identity_source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
    );
    CREATE TABLE ops_memberships (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES ops_organizations(id),
      user_id TEXT NOT NULL REFERENCES ops_users(id), role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (organization_id, user_id)
    );
    CREATE TABLE ops_services (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES ops_organizations(id),
      name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', tier TEXT NOT NULL,
      owner_user_id TEXT REFERENCES ops_users(id), owner_team TEXT NOT NULL DEFAULT '', slo_target REAL NOT NULL,
      runbook_url TEXT, status TEXT NOT NULL DEFAULT 'active', version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (id, organization_id)
    );
    CREATE TABLE ops_incidents (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES ops_organizations(id),
      incident_number TEXT NOT NULL, service_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL,
      severity TEXT NOT NULL, status TEXT NOT NULL, environment TEXT NOT NULL, impact_summary TEXT NOT NULL DEFAULT '',
      current_hypothesis TEXT NOT NULL DEFAULT '', current_mitigation TEXT NOT NULL DEFAULT '',
      verification_criteria TEXT NOT NULL DEFAULT '', declared_at TEXT NOT NULL, acknowledged_at TEXT,
      mitigated_at TEXT, resolved_at TEXT, closed_at TEXT, version INTEGER NOT NULL DEFAULT 1,
      created_by_user_id TEXT NOT NULL REFERENCES ops_users(id), updated_by_user_id TEXT NOT NULL REFERENCES ops_users(id),
      last_request_id TEXT NOT NULL, last_transition_note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, UNIQUE (id, organization_id),
      FOREIGN KEY (service_id, organization_id) REFERENCES ops_services(id, organization_id)
    );
    CREATE TABLE ops_incident_assignments (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES ops_organizations(id),
      incident_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES ops_users(id), incident_role TEXT NOT NULL,
      assigned_by_user_id TEXT NOT NULL REFERENCES ops_users(id), created_at TEXT NOT NULL,
      UNIQUE (incident_id, user_id, incident_role),
      FOREIGN KEY (incident_id, organization_id) REFERENCES ops_incidents(id, organization_id) ON DELETE CASCADE
    );
    CREATE TABLE ops_incident_timeline (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES ops_organizations(id),
      incident_id TEXT NOT NULL, event_type TEXT NOT NULL, actor_user_id TEXT NOT NULL REFERENCES ops_users(id),
      message TEXT NOT NULL, from_status TEXT, to_status TEXT, request_id TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY (incident_id, organization_id) REFERENCES ops_incidents(id, organization_id) ON DELETE CASCADE
    );
    CREATE TABLE ops_incident_tasks (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES ops_organizations(id),
      incident_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL,
      status TEXT NOT NULL, assignee_user_id TEXT REFERENCES ops_users(id), due_at TEXT, completed_at TEXT,
      version INTEGER NOT NULL DEFAULT 1, created_by_user_id TEXT NOT NULL REFERENCES ops_users(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (id, incident_id),
      FOREIGN KEY (incident_id, organization_id) REFERENCES ops_incidents(id, organization_id) ON DELETE CASCADE
    );
    CREATE TABLE ops_post_incident_reviews (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES ops_organizations(id),
      incident_id TEXT NOT NULL UNIQUE, summary TEXT NOT NULL, customer_impact TEXT NOT NULL,
      root_cause TEXT NOT NULL, detection_gap TEXT NOT NULL, lessons_learned TEXT NOT NULL,
      follow_up_actions TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'completed', version INTEGER NOT NULL DEFAULT 1,
      created_by_user_id TEXT NOT NULL REFERENCES ops_users(id), updated_by_user_id TEXT NOT NULL REFERENCES ops_users(id),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY (incident_id, organization_id) REFERENCES ops_incidents(id, organization_id) ON DELETE CASCADE
    );
    CREATE TABLE ops_audit_events (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES ops_organizations(id),
      actor_user_id TEXT NOT NULL REFERENCES ops_users(id), actor_role TEXT NOT NULL, action TEXT NOT NULL,
      resource_type TEXT NOT NULL, resource_id TEXT NOT NULL, outcome TEXT NOT NULL, reason_code TEXT,
      request_id TEXT NOT NULL, details_json TEXT, occurred_at TEXT NOT NULL
    );
    CREATE TABLE ops_idempotency_receipts (
      id TEXT PRIMARY KEY NOT NULL, organization_id TEXT NOT NULL REFERENCES ops_organizations(id),
      actor_user_id TEXT NOT NULL REFERENCES ops_users(id), action_scope TEXT NOT NULL,
      idempotency_key_hash TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      UNIQUE (organization_id, actor_user_id, action_scope, idempotency_key_hash)
    );
    CREATE TABLE ops_write_guards (
      id TEXT PRIMARY KEY NOT NULL, passed INTEGER NOT NULL CHECK (passed = 1), created_at TEXT NOT NULL
    );
  `);
  return db;
}

function addMember(db, id, role = "commander") {
  const now = "2026-07-31T10:00:00.000Z";
  db.prepare(
    `INSERT INTO ops_users (id, email, display_name, identity_source, status, created_at, last_seen_at)
     VALUES (?, ?, ?, 'invited', 'active', ?, ?)`,
  ).run(id, `${id}@example.com`, id, now, now);
  db.prepare(
    `INSERT INTO ops_memberships (id, organization_id, user_id, role, status, created_at, updated_at)
     VALUES (?, 'ops-singleton', ?, ?, 'active', ?, ?)`,
  ).run(`mem-${id}`, id, role, now, now);
}

function addService(db, id = "svc-1") {
  const now = "2026-07-31T10:00:00.000Z";
  db.prepare(
    `INSERT INTO ops_services
      (id, organization_id, name, slug, description, tier, owner_team, slo_target,
       runbook_url, status, version, created_at, updated_at)
     VALUES (?, 'ops-singleton', ?, ?, '', 'tier_1', 'Platform', 99.95,
             'https://runbooks.example.com/service', 'active', 1, ?, ?)`,
  ).run(id, id, id, now, now);
}

function addIncident(db, values = {}) {
  const now = "2026-07-31T10:00:00.000Z";
  const id = values.id ?? "inc-1";
  const status = values.status ?? "declared";
  const criteria = values.criteria ?? "";
  const mitigatedAt = values.mitigatedAt ?? null;
  db.prepare(
    `INSERT INTO ops_incidents
      (id, organization_id, incident_number, service_id, title, summary, severity, status, environment,
       impact_summary, current_hypothesis, current_mitigation, verification_criteria, declared_at,
       mitigated_at, version, created_by_user_id, updated_by_user_id, last_request_id,
       last_transition_note, created_at, updated_at)
     VALUES (?, 'ops-singleton', ?, ?, 'Incident', 'Incident summary', 'sev1', ?, 'production',
             'Customer impact', '', '', ?, ?, ?, 1, ?, ?, ?, 'Seeded incident.', ?, ?)`,
  ).run(
    id,
    `INC-${id}`,
    values.serviceId ?? "svc-1",
    status,
    criteria,
    now,
    mitigatedAt,
    values.actorId ?? "usr-1",
    values.actorId ?? "usr-1",
    `req-${id}`,
    now,
    now,
  );
}

function addCommanderAssignment(db, incidentId, userId, id = `assign-${incidentId}-${userId}`) {
  const now = "2026-07-31T10:00:00.000Z";
  db.prepare(
    `INSERT INTO ops_incident_assignments
      (id, organization_id, incident_id, user_id, incident_role, status, assigned_by_user_id, created_at)
     VALUES (?, 'ops-singleton', ?, ?, 'incident_commander', 'active', ?, ?)`,
  ).run(id, incidentId, userId, userId, now);
}

function addIncidentAssignment(db, incidentId, userId, incidentRole, id) {
  const now = "2026-07-31T10:00:00.000Z";
  db.prepare(
    `INSERT INTO ops_incident_assignments
      (id, organization_id, incident_id, user_id, incident_role, status, assigned_by_user_id, created_at)
     VALUES (?, 'ops-singleton', ?, ?, ?, 'active', ?, ?)`,
  ).run(id, incidentId, userId, incidentRole, userId, now);
}

function addCommunication(db, values = {}) {
  const now = values.createdAt ?? "2026-07-31T10:00:00.000Z";
  db.prepare(
    `INSERT INTO ops_incident_communications
      (id, organization_id, incident_id, audience, status, message, affected_components,
       next_update_at, version, created_by_user_id, updated_by_user_id, created_at, updated_at,
       last_request_id)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    values.id ?? "comm-1",
    values.organizationId ?? "ops-singleton",
    values.incidentId ?? "inc-1",
    values.audience ?? "internal",
    values.message ?? "Internal incident update.",
    JSON.stringify(values.affectedComponents ?? []),
    values.nextUpdateAt ?? null,
    values.actorId ?? "usr-1",
    values.actorId ?? "usr-1",
    now,
    now,
    values.requestId ?? `req-${values.id ?? "comm-1"}`,
  );
}

function reviewCommunication(db, id, values = {}) {
  const now = values.reviewedAt ?? "2026-07-31T10:10:00.000Z";
  db.prepare(
    `UPDATE ops_incident_communications
     SET status = 'reviewed', version = version + 1, updated_by_user_id = ?,
         reviewed_by_user_id = ?, reviewed_at = ?, updated_at = ?, last_request_id = ?
     WHERE id = ?`,
  ).run(
    values.actorId ?? "usr-1",
    values.actorId ?? "usr-1",
    now,
    now,
    values.requestId ?? `req-review-${id}`,
    id,
  );
}

test("the complete v2.2 migration chain installs on an empty database with durable append-only history", async () => {
  const db = await migratedDatabase();

  const tables = db.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'ops_%' ORDER BY name",
  ).all().map((row) => row.name);
  assert.deepEqual(tables, [
    "ops_audit_events",
    "ops_idempotency_receipts",
    "ops_incident_assignments",
    "ops_incident_communications",
    "ops_incident_tasks",
    "ops_incident_timeline",
    "ops_incidents",
    "ops_memberships",
    "ops_organizations",
    "ops_post_incident_reviews",
    "ops_request_telemetry",
    "ops_service_lifecycle_events",
    "ops_services",
    "ops_users",
    "ops_write_guards",
  ]);
  assert.equal(db.prepare("SELECT name FROM ops_organizations WHERE id = 'ops-singleton'").get()?.name, "Continuity Ops");
  assert.equal(db.prepare("SELECT timezone FROM ops_organizations WHERE id = 'ops-singleton'").get()?.timezone, "UTC");

  const now = "2026-07-31T10:00:00.000Z";
  db.prepare(
    `INSERT INTO ops_users (id, email, display_name, identity_source, status, created_at, last_seen_at)
     VALUES ('usr-1', 'commander@example.com', 'Commander', 'invited', 'active', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO ops_memberships (id, organization_id, user_id, role, status, created_at, updated_at)
     VALUES ('mem-1', 'ops-singleton', 'usr-1', 'commander', 'active', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO ops_services
      (id, organization_id, name, slug, description, tier, owner_user_id, owner_team, slo_target,
       runbook_url, status, version, created_at, updated_at)
     VALUES ('svc-1', 'ops-singleton', 'Identity API', 'identity-api', '', 'tier_1', 'usr-1',
             'Identity Platform', 99.95, 'https://runbooks.example.com/identity', 'active', 1, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO ops_incidents
      (id, organization_id, incident_number, service_id, title, summary, severity, status, environment,
       impact_summary, current_hypothesis, current_mitigation, verification_criteria, declared_at,
       version, created_by_user_id, updated_by_user_id, last_request_id, last_transition_note, created_at, updated_at)
     VALUES ('inc-1', 'ops-singleton', 'INC-20260731-000001', 'svc-1', 'Login failures',
             'Authentication requests are failing.', 'sev1', 'declared', 'production', 'Users cannot sign in.',
             '', '', 'Three successful regional probes.', ?, 1, 'usr-1', 'usr-1', 'req-create',
             'Incident declared.', ?, ?)`,
  ).run(now, now, now);

  db.prepare(
    `UPDATE ops_incidents SET status = 'investigating', acknowledged_at = ?, version = version + 1,
       updated_by_user_id = 'usr-1', last_request_id = 'req-transition-1',
       last_transition_note = 'Investigation started after alert validation.', updated_at = ?
     WHERE id = 'inc-1' AND version = 1`,
  ).run(now, now);
  const timeline = db.prepare("SELECT * FROM ops_incident_timeline WHERE incident_id = 'inc-1'").all();
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].from_status, "declared");
  assert.equal(timeline[0].to_status, "investigating");
  assert.equal(timeline[0].request_id, "req-transition-1");
  const audit = db.prepare("SELECT * FROM ops_audit_events WHERE resource_id = 'inc-1'").all();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "incident.transition");
  assert.match(String(audit[0].details_json), /"fromStatus":"declared"/);

  db.prepare(
    `INSERT INTO ops_audit_events
      (id, organization_id, actor_user_id, actor_role, action, resource_type, resource_id,
       outcome, reason_code, request_id, details_json, occurred_at)
     VALUES ('audit-denied', 'ops-singleton', 'usr-1', 'commander', 'incident.transition',
             'incident', 'inc-1', 'denied', 'TRANSITION_NOT_ALLOWED', 'req-denied',
             '{"method":"POST","route":"/api/v1/incidents/:incidentId/transitions"}', ?)`,
  ).run(now);
  const deniedAudit = db.prepare("SELECT outcome, reason_code, details_json FROM ops_audit_events WHERE id = 'audit-denied'").get();
  assert.equal(deniedAudit?.outcome, "denied");
  assert.equal(deniedAudit?.reason_code, "TRANSITION_NOT_ALLOWED");
  assert.doesNotMatch(String(deniedAudit?.details_json), /payload|requestBody|token/i);

  assert.throws(
    () => db.prepare("UPDATE ops_audit_events SET action = 'changed'").run(),
    /OPS_AUDIT_APPEND_ONLY/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM ops_incident_timeline").run(),
    /OPS_TIMELINE_APPEND_ONLY/,
  );
  assert.throws(
    () => db.prepare("UPDATE ops_incidents SET version = version + 2, updated_at = ? WHERE id = 'inc-1'").run(now),
    /OPS_INCIDENT_VERSION_MUST_INCREMENT/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incidents SET status = 'closed', version = version + 1,
       last_request_id = 'req-invalid', last_transition_note = 'invalid jump', updated_at = ? WHERE id = 'inc-1'`,
    ).run(now),
    /OPS_INVALID_INCIDENT_TRANSITION/,
  );
  db.close();
});

test("resolution requires current monitoring-cycle evidence and no open critical work", async () => {
  const db = await migratedDatabase();
  addMember(db, "usr-1", "commander");
  addService(db);
  const monitoringAt = "2026-07-31T10:05:00.000Z";

  addIncident(db, { id: "inc-criteria", status: "monitoring", mitigatedAt: monitoringAt });
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incidents SET status = 'resolved', resolved_at = ?, version = version + 1,
       last_request_id = 'req-resolve-criteria', last_transition_note = 'Resolve.', updated_at = ?
       WHERE id = 'inc-criteria'`,
    ).run(monitoringAt, monitoringAt),
    /OPS_RESOLUTION_CRITERIA_REQUIRED/,
  );

  addIncident(db, { id: "inc-old-evidence", status: "monitoring", criteria: "Three healthy probes.", mitigatedAt: monitoringAt });
  db.prepare(
    `INSERT INTO ops_incident_timeline
      (id, organization_id, incident_id, event_type, actor_user_id, message, request_id, created_at)
     VALUES ('tl-old', 'ops-singleton', 'inc-old-evidence', 'verification', 'usr-1',
             'Evidence from the prior cycle.', 'req-old', '2026-07-31T10:04:59.000Z')`,
  ).run();
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incidents SET status = 'resolved', resolved_at = ?, version = version + 1,
       last_request_id = 'req-resolve-old', last_transition_note = 'Resolve.', updated_at = ?
       WHERE id = 'inc-old-evidence'`,
    ).run(monitoringAt, monitoringAt),
    /OPS_RESOLUTION_VERIFICATION_REQUIRED/,
  );

  addIncident(db, { id: "inc-critical", status: "monitoring", criteria: "Three healthy probes.", mitigatedAt: monitoringAt });
  db.prepare(
    `INSERT INTO ops_incident_timeline
      (id, organization_id, incident_id, event_type, actor_user_id, message, request_id, created_at)
     VALUES ('tl-current', 'ops-singleton', 'inc-critical', 'verification', 'usr-1',
             'Current-cycle probes are healthy.', 'req-current', '2026-07-31T10:06:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO ops_incident_tasks
      (id, organization_id, incident_id, title, priority, status, version, created_by_user_id, created_at, updated_at)
     VALUES ('task-critical', 'ops-singleton', 'inc-critical', 'Validate data integrity',
             'critical', 'open', 1, 'usr-1', ?, ?)`,
  ).run(monitoringAt, monitoringAt);
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incidents SET status = 'resolved', resolved_at = ?, version = version + 1,
       last_request_id = 'req-resolve-critical', last_transition_note = 'Resolve.', updated_at = ?
       WHERE id = 'inc-critical'`,
    ).run(monitoringAt, monitoringAt),
    /OPS_RESOLUTION_CRITICAL_TASKS_OPEN/,
  );
  db.prepare(
    `UPDATE ops_incident_tasks SET status = 'completed', completed_at = ?,
     evidence_ref = 'https://evidence.example.com/tasks/critical-data-integrity',
     version = version + 1, updated_at = ?
     WHERE id = 'task-critical'`,
  ).run(monitoringAt, monitoringAt);
  db.prepare(
    `UPDATE ops_incidents SET status = 'resolved', resolved_at = ?, version = version + 1,
     last_request_id = 'req-resolve-success', last_transition_note = 'Current-cycle checks passed.', updated_at = ?
     WHERE id = 'inc-critical'`,
  ).run(monitoringAt, monitoringAt);
  assert.equal(db.prepare("SELECT status FROM ops_incidents WHERE id = 'inc-critical'").get()?.status, "resolved");
  db.close();
});

test("draft reviews are partial, completed reviews are complete, versioned, and bound to resolved incidents", async () => {
  const db = await migratedDatabase();
  addMember(db, "usr-1", "commander");
  addService(db);
  addIncident(db, { id: "inc-resolved", status: "resolved" });
  const now = "2026-07-31T10:10:00.000Z";
  db.prepare(
    `INSERT INTO ops_post_incident_reviews
      (id, organization_id, incident_id, summary, status, version,
       created_by_user_id, updated_by_user_id, created_at, updated_at)
     VALUES ('review-1', 'ops-singleton', 'inc-resolved', 'Initial notes', 'draft', 1,
             'usr-1', 'usr-1', ?, ?)`,
  ).run(now, now);
  const draft = db.prepare("SELECT * FROM ops_post_incident_reviews WHERE id = 'review-1'").get();
  assert.equal(draft?.status, "draft");
  assert.equal(draft?.root_cause, "");
  assert.throws(
    () => db.prepare(
      `UPDATE ops_post_incident_reviews SET status = 'completed', version = version + 1, updated_at = ?
       WHERE id = 'review-1'`,
    ).run(now),
    /CHECK constraint failed/,
  );
  db.prepare(
    `UPDATE ops_post_incident_reviews
     SET summary = 'A sufficiently complete incident summary.',
         customer_impact = 'Customers could not sign in.',
         root_cause = 'Expired signing key caused failures.',
         detection_gap = 'Alerting missed regional failures.',
         lessons_learned = 'Key rotation needs staged verification.',
         follow_up_actions = 'Automate rotation probes and ownership.',
         status = 'completed', version = version + 1, updated_at = ?
     WHERE id = 'review-1'`,
  ).run(now);
  assert.equal(db.prepare("SELECT status, version FROM ops_post_incident_reviews WHERE id = 'review-1'").get()?.version, 2);

  addIncident(db, { id: "inc-monitoring", status: "monitoring", mitigatedAt: now });
  assert.throws(
    () => db.prepare(
      `INSERT INTO ops_post_incident_reviews
        (id, organization_id, incident_id, status, version, created_by_user_id, updated_by_user_id, created_at, updated_at)
       VALUES ('review-2', 'ops-singleton', 'inc-monitoring', 'draft', 1, 'usr-1', 'usr-1', ?, ?)`,
    ).run(now, now),
    /OPS_REVIEW_INCIDENT_NOT_RESOLVED/,
  );
  assert.throws(
    () => db.prepare("UPDATE ops_post_incident_reviews SET status = 'complete', version = version + 1 WHERE id = 'review-1'").run(),
    /CHECK constraint failed/,
  );
  db.close();
});

test("structured incident communications require review, safe external timing, and immutable publication", async () => {
  const db = await migratedDatabase();
  addMember(db, "usr-1", "admin");
  addService(db);
  addIncident(db, { id: "inc-communications" });
  const createdAt = "2026-07-31T10:00:00.000Z";
  const reviewedAt = "2026-07-31T10:10:00.000Z";
  const publishedAt = "2026-07-31T10:20:00.000Z";

  assert.throws(
    () => db.prepare(
      `INSERT INTO ops_incident_communications
        (id, organization_id, incident_id, audience, status, message, affected_components,
         version, created_by_user_id, updated_by_user_id, reviewed_by_user_id,
         created_at, updated_at, reviewed_at, last_request_id)
       VALUES ('comm-not-draft', 'ops-singleton', 'inc-communications', 'internal', 'reviewed',
               'This record improperly skips the draft state.', '[]', 1, 'usr-1', 'usr-1',
               'usr-1', ?, ?, ?, 'req-not-draft')`,
    ).run(createdAt, reviewedAt, reviewedAt),
    /OPS_COMMUNICATION_MUST_START_DRAFT/,
  );

  addCommunication(db, {
    id: "comm-final",
    incidentId: "inc-communications",
    audience: "public",
    message: "[fInAl] Authentication service is fully restored.",
    affectedComponents: ["Identity API", "Session Gateway"],
  });
  const draft = db.prepare(
    "SELECT status, version, affected_components FROM ops_incident_communications WHERE id = 'comm-final'",
  ).get();
  assert.equal(draft?.status, "draft");
  assert.equal(draft?.version, 1);
  assert.deepEqual(JSON.parse(String(draft?.affected_components)), ["Identity API", "Session Gateway"]);
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_communications SET message = 'A different draft message.', version = version + 2,
       updated_at = ?, last_request_id = 'req-version-skip' WHERE id = 'comm-final'`,
    ).run(reviewedAt),
    /OPS_COMMUNICATION_VERSION_MUST_INCREMENT/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_communications
       SET status = 'published', version = version + 1, reviewed_by_user_id = 'usr-1',
           published_by_user_id = 'usr-1', reviewed_at = ?, published_at = ?, updated_at = ?,
           last_request_id = 'req-skip-review' WHERE id = 'comm-final'`,
    ).run(reviewedAt, publishedAt, publishedAt),
    /OPS_COMMUNICATION_INVALID_TRANSITION/,
  );
  reviewCommunication(db, "comm-final", { reviewedAt });
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_communications
       SET status = 'published', message = '[FINAL] Unreviewed replacement text.',
           version = version + 1, updated_by_user_id = 'usr-1', published_by_user_id = 'usr-1',
           published_at = ?, updated_at = ?, last_request_id = 'req-content-change'
       WHERE id = 'comm-final'`,
    ).run(publishedAt, publishedAt),
    /OPS_COMMUNICATION_REVIEWED_CONTENT_IMMUTABLE/,
  );
  db.prepare(
    `UPDATE ops_incident_communications
     SET status = 'published', version = version + 1, updated_by_user_id = 'usr-1',
         published_by_user_id = 'usr-1', published_at = ?, updated_at = ?, last_request_id = 'req-publish-final'
     WHERE id = 'comm-final'`,
  ).run(publishedAt, publishedAt);
  const published = db.prepare(
    `SELECT status, version, reviewed_by_user_id, published_by_user_id, reviewed_at, published_at
     FROM ops_incident_communications WHERE id = 'comm-final'`,
  ).get();
  assert.equal(published?.status, "published");
  assert.equal(published?.version, 3);
  assert.equal(published?.reviewed_by_user_id, "usr-1");
  assert.equal(published?.published_by_user_id, "usr-1");
  assert.equal(published?.reviewed_at, reviewedAt);
  assert.equal(published?.published_at, publishedAt);
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_communications SET version = version + 1, updated_at = ?,
       last_request_id = 'req-after-publish' WHERE id = 'comm-final'`,
    ).run("2026-07-31T10:21:00.000Z"),
    /OPS_COMMUNICATION_PUBLISHED_IMMUTABLE/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM ops_incident_communications WHERE id = 'comm-final'").run(),
    /OPS_COMMUNICATION_PUBLISHED_IMMUTABLE/,
  );

  addCommunication(db, {
    id: "comm-no-next-update",
    incidentId: "inc-communications",
    audience: "stakeholder",
    message: "Authentication recovery is still being verified.",
  });
  assert.throws(
    () => reviewCommunication(db, "comm-no-next-update", { reviewedAt }),
    /OPS_COMMUNICATION_NEXT_UPDATE_REQUIRED/,
  );
  assert.deepEqual(
    { ...db.prepare("SELECT status, version FROM ops_incident_communications WHERE id = 'comm-no-next-update'").get() },
    { status: "draft", version: 1 },
  );

  addCommunication(db, {
    id: "comm-attached-final-marker",
    incidentId: "inc-communications",
    audience: "public",
    message: "[FINAL]This is not a standalone final marker.",
  });
  assert.throws(
    () => reviewCommunication(db, "comm-attached-final-marker", { reviewedAt }),
    /OPS_COMMUNICATION_NEXT_UPDATE_REQUIRED/,
  );

  addCommunication(db, {
    id: "comm-leading-space-final",
    incidentId: "inc-communications",
    audience: "public",
    message: "   [FINAL] This marker does not start at character one.",
  });
  assert.throws(
    () => reviewCommunication(db, "comm-leading-space-final", { reviewedAt }),
    /OPS_COMMUNICATION_NEXT_UPDATE_REQUIRED/,
  );

  addCommunication(db, {
    id: "comm-invalid-timestamp",
    incidentId: "inc-communications",
    audience: "public",
    message: "Recovery verification remains in progress.",
    nextUpdateAt: "zzzz",
  });
  assert.throws(
    () => reviewCommunication(db, "comm-invalid-timestamp", { reviewedAt }),
    /OPS_COMMUNICATION_NEXT_UPDATE_REQUIRED|CHECK constraint failed/,
  );

  addCommunication(db, {
    id: "comm-scheduled",
    incidentId: "inc-communications",
    audience: "stakeholder",
    message: "Recovery is stable while verification continues.",
    nextUpdateAt: "2026-07-31T10:30:00.000Z",
  });
  reviewCommunication(db, "comm-scheduled", { reviewedAt });
  db.prepare(
    `UPDATE ops_incident_communications
     SET status = 'published', version = version + 1, updated_by_user_id = 'usr-1',
         published_by_user_id = 'usr-1', published_at = ?, updated_at = ?,
         last_request_id = 'req-publish-scheduled' WHERE id = 'comm-scheduled'`,
  ).run(publishedAt, publishedAt);
  assert.equal(
    db.prepare("SELECT status FROM ops_incident_communications WHERE id = 'comm-scheduled'").get()?.status,
    "published",
  );

  addIncident(db, { id: "inc-resolved-communication", status: "resolved" });
  addCommunication(db, { id: "comm-terminal", incidentId: "inc-resolved-communication" });
  reviewCommunication(db, "comm-terminal", { reviewedAt });
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_communications
       SET status = 'published', version = version + 1, updated_by_user_id = 'usr-1',
           published_by_user_id = 'usr-1', published_at = ?, updated_at = ?,
           last_request_id = 'req-terminal-publish' WHERE id = 'comm-terminal'`,
    ).run(publishedAt, publishedAt),
    /OPS_COMMUNICATION_INCIDENT_TERMINAL/,
  );

  db.prepare("INSERT INTO ops_organizations (id, name, status) VALUES ('ops-other', 'Other Org', 'active')").run();
  assert.throws(
    () => addCommunication(db, {
      id: "comm-cross-org",
      incidentId: "inc-communications",
      organizationId: "ops-other",
    }),
    /FOREIGN KEY constraint failed/,
  );
  db.close();
});

test("completed tasks require durable HTTPS evidence", async () => {
  const db = await migratedDatabase();
  addMember(db, "usr-1", "commander");
  addService(db);
  addIncident(db, { id: "inc-task-evidence" });
  const createdAt = "2026-07-31T10:00:00.000Z";
  const completedAt = "2026-07-31T10:20:00.000Z";

  db.prepare(
    `INSERT INTO ops_incident_tasks
      (id, organization_id, incident_id, title, description, priority, status, evidence_ref,
       version, created_by_user_id, created_at, updated_at)
     VALUES ('task-evidence', 'ops-singleton', 'inc-task-evidence', 'Verify recovery', '',
             'high', 'open', NULL, 1, 'usr-1', ?, ?)`,
  ).run(createdAt, createdAt);

  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_tasks
       SET status = 'completed', completed_at = ?, version = version + 1, updated_at = ?
       WHERE id = 'task-evidence'`,
    ).run(completedAt, completedAt),
    /ops_tasks_completed_evidence_check/,
  );
  for (const invalidUrl of ["https://@", "https://:", "https://[", "https://%"] ) {
    assert.throws(
      () => db.prepare(
        `UPDATE ops_incident_tasks
         SET status = 'completed', completed_at = ?, evidence_ref = ?,
             version = version + 1, updated_at = ?
         WHERE id = 'task-evidence'`,
      ).run(completedAt, invalidUrl, completedAt),
      /ops_tasks_completed_evidence_check/,
    );
  }
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_tasks
       SET status = 'completed', completed_at = ?, evidence_ref = 'http://evidence.example.com/task/1',
           version = version + 1, updated_at = ?
       WHERE id = 'task-evidence'`,
    ).run(completedAt, completedAt),
    /ops_tasks_completed_evidence_check/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_tasks
       SET status = 'completed', completed_at = ?, evidence_ref = 'https://',
           version = version + 1, updated_at = ?
       WHERE id = 'task-evidence'`,
    ).run(completedAt, completedAt),
    /ops_tasks_completed_evidence_check/,
  );

  db.prepare(
    `UPDATE ops_incident_tasks
     SET status = 'completed', completed_at = ?, evidence_ref = 'https://evidence.example.com',
         version = version + 1, updated_at = ?
     WHERE id = 'task-evidence'`,
  ).run(completedAt, completedAt);
  const completed = db.prepare(
    "SELECT status, evidence_ref, version FROM ops_incident_tasks WHERE id = 'task-evidence'",
  ).get();
  assert.deepEqual({ ...completed }, {
    status: "completed",
    evidence_ref: "https://evidence.example.com",
    version: 2,
  });

  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_tasks
       SET evidence_ref = NULL, version = version + 1, updated_at = ?
       WHERE id = 'task-evidence'`,
    ).run("2026-07-31T10:21:00.000Z"),
    /ops_tasks_completed_evidence_check/,
  );
  assert.throws(
    () => db.prepare(
      `INSERT INTO ops_incident_tasks
        (id, organization_id, incident_id, title, description, priority, status, completed_at,
         evidence_ref, version, created_by_user_id, created_at, updated_at)
       VALUES ('task-completed-without-evidence', 'ops-singleton', 'inc-task-evidence',
               'Invalid completed task', '', 'medium', 'completed', ?, NULL, 1, 'usr-1', ?, ?)`,
    ).run(completedAt, createdAt, completedAt),
    /ops_tasks_completed_evidence_check/,
  );
  db.close();
});

test("critical task cancellation requires a durable reason", async () => {
  const db = await migratedDatabase();
  addMember(db, "usr-1", "commander");
  addService(db);
  addIncident(db, { id: "inc-critical-cancel" });
  const now = "2026-07-31T10:00:00.000Z";
  db.prepare(
    `INSERT INTO ops_incident_tasks
      (id, organization_id, incident_id, title, priority, status, version,
       created_by_user_id, created_at, updated_at)
     VALUES ('task-critical-cancel', 'ops-singleton', 'inc-critical-cancel',
             'Validate customer data integrity', 'critical', 'open', 1, 'usr-1', ?, ?)`,
  ).run(now, now);
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_tasks SET status = 'cancelled', version = version + 1, updated_at = ?
       WHERE id = 'task-critical-cancel'`,
    ).run(now),
    /OPS_TASK_CRITICAL_CANCELLATION_REASON_REQUIRED/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_tasks
       SET status = 'cancelled', cancellation_reason = 'short', version = version + 1, updated_at = ?
       WHERE id = 'task-critical-cancel'`,
    ).run(now),
    /OPS_TASK_CRITICAL_CANCELLATION_REASON_REQUIRED/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_tasks
       SET priority = 'high', status = 'cancelled', cancellation_reason = NULL,
           version = version + 1, updated_at = ?
       WHERE id = 'task-critical-cancel'`,
    ).run(now),
    /OPS_TASK_CRITICAL_CANCELLATION_REASON_REQUIRED/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_tasks
       SET status = 'cancelled', cancellation_reason = ?, version = version + 1, updated_at = ?
       WHERE id = 'task-critical-cancel'`,
    ).run(`${" ".repeat(20_000)}Documented`, now),
    /OPS_TASK_CRITICAL_CANCELLATION_REASON_REQUIRED/,
  );
  db.prepare(
    `UPDATE ops_incident_tasks
     SET status = 'cancelled', cancellation_reason = 'Duplicate recovery work verified by the incident commander.',
         version = version + 1, updated_at = ? WHERE id = 'task-critical-cancel'`,
  ).run(now);
  assert.deepEqual(
    { ...db.prepare(
      "SELECT status, cancellation_reason, version FROM ops_incident_tasks WHERE id = 'task-critical-cancel'",
    ).get() },
    {
      status: "cancelled",
      cancellation_reason: "Duplicate recovery work verified by the incident commander.",
      version: 2,
    },
  );
  db.prepare(
    `UPDATE ops_incident_tasks
     SET priority = 'high', version = version + 1, updated_at = ?
     WHERE id = 'task-critical-cancel'`,
  ).run(now);
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_tasks
       SET cancellation_reason = NULL, version = version + 1, updated_at = ?
       WHERE id = 'task-critical-cancel'`,
    ).run(now),
    /OPS_TASK_CANCELLATION_REASON_IMMUTABLE/,
  );
  assert.deepEqual(
    { ...db.prepare(
      "SELECT priority, status, cancellation_reason, version FROM ops_incident_tasks WHERE id = 'task-critical-cancel'",
    ).get() },
    {
      priority: "high",
      status: "cancelled",
      cancellation_reason: "Duplicate recovery work verified by the incident commander.",
      version: 3,
    },
  );
  db.close();
});

test("service lifecycle and service version are enforced in the database", async () => {
  const db = await migratedDatabase();
  addMember(db, "usr-1", "commander");
  addService(db);
  assert.throws(
    () => db.prepare(
      `INSERT INTO ops_service_lifecycle_events
        (id, organization_id, service_id, from_status, to_status, reason,
         changed_by_user_id, request_id, changed_at)
       VALUES ('svc-1:lifecycle:00000000000000000001', 'ops-singleton', 'svc-1',
               'deprecated', 'active', 'Forged initial lifecycle evidence.', 'usr-1',
               'req-service-forged-initial', '2026-07-31T10:00:00.000Z')`,
    ).run(),
    /OPS_SERVICE_LIFECYCLE_EVENT_NOT_DERIVED/,
  );
  assert.throws(
    () => db.prepare(
      `INSERT INTO ops_services
        (id, organization_id, name, slug, description, tier, owner_team, slo_target,
         runbook_url, status, version, created_at, updated_at)
       VALUES ('svc-invalid-initial-status', 'ops-singleton', 'Invalid initial status',
               'invalid-initial-status', '', 'tier_2', 'Platform', 99.9,
               'https://runbooks.example.com/invalid', 'deprecated', 1, ?, ?)`,
    ).run("2026-07-31T10:00:00.000Z", "2026-07-31T10:00:00.000Z"),
    /OPS_SERVICE_MUST_START_ACTIVE/,
  );
  addIncident(db, { id: "inc-open" });
  const now = "2026-07-31T10:10:00.000Z";
  assert.throws(
    () => db.prepare(
      `UPDATE ops_services SET status = 'deprecated', status_change_reason = ?, status_changed_at = ?,
         status_changed_by_user_id = 'usr-1', status_change_request_id = 'req-service-open-deprecate',
         version = version + 1, updated_at = ? WHERE id = 'svc-1'`,
    ).run("The service has been replaced and its remaining operational risk is accepted.", now, now),
    /OPS_SERVICE_HAS_OPEN_INCIDENTS/,
  );
  db.prepare(
    `UPDATE ops_incidents SET status = 'cancelled', version = version + 1,
     last_request_id = 'req-cancel', last_transition_note = 'False positive.', updated_at = ? WHERE id = 'inc-open'`,
  ).run(now);
  assert.throws(
    () => db.prepare(
      "UPDATE ops_services SET status = 'deprecated', version = version + 1, updated_at = ? WHERE id = 'svc-1'",
    ).run(now),
    /OPS_SERVICE_STATUS_CHANGE_REASON_REQUIRED/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ops_services SET status = 'deprecated', status_change_reason = ?, status_changed_at = ?,
         status_changed_by_user_id = 'usr-1', status_change_request_id = 'req-service-blank-reason',
         version = version + 1, updated_at = ? WHERE id = 'svc-1'`,
    ).run(" \n\t\r ", now, now),
    /OPS_SERVICE_STATUS_CHANGE_REASON_REQUIRED/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ops_services SET status = 'deprecated', status_change_reason = ?, status_changed_at = ?,
         status_changed_by_user_id = 'usr-1', status_change_request_id = 'req-service-control-reason',
         version = version + 1, updated_at = ? WHERE id = 'svc-1'`,
    ).run(`${String.fromCharCode(11).repeat(4)}${String.fromCharCode(12).repeat(4)}\u00A0`, now, now),
    /OPS_SERVICE_STATUS_CHANGE_REASON_REQUIRED/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ops_services SET status = 'deprecated', status_change_reason = ?, status_changed_at = ?,
         status_changed_by_user_id = 'usr-1', status_change_request_id = 'req-service-invalid-time',
         version = version + 1, updated_at = ? WHERE id = 'svc-1'`,
    ).run("The replacement service is ready for this controlled lifecycle change.", "2026-99-99T99:99:99.999Z", "2026-99-99T99:99:99.999Z"),
    /OPS_SERVICE_STATUS_CHANGE_REASON_REQUIRED/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ops_services SET status = 'deprecated', status_change_reason = ?, status_changed_at = ?,
         status_changed_by_user_id = 'usr-1', status_change_request_id = 'req-service-oversized-reason',
         version = version + 1, updated_at = ? WHERE id = 'svc-1'`,
    ).run("A".repeat(1001), now, now),
    /OPS_SERVICE_STATUS_CHANGE_REASON_REQUIRED/,
  );
  addMember(db, "usr-observer", "observer");
  assert.throws(
    () => db.prepare(
      `UPDATE ops_services SET status = 'deprecated', status_change_reason = ?, status_changed_at = ?,
         status_changed_by_user_id = 'usr-observer', status_change_request_id = 'req-service-observer-deprecate',
         version = version + 1, updated_at = ? WHERE id = 'svc-1'`,
    ).run("The service has been replaced and the change is ready for review.", now, now),
    /OPS_SERVICE_STATUS_CHANGE_ACTOR_INVALID/,
  );
  const deprecationReason = "The replacement service is verified and this service no longer accepts new traffic.";
  db.prepare(
    `UPDATE ops_services SET status = 'deprecated', status_change_reason = ?, status_changed_at = ?,
       status_changed_by_user_id = 'usr-1', status_change_request_id = 'req-service-valid-deprecate',
       version = version + 1, updated_at = ? WHERE id = 'svc-1'`,
  ).run(deprecationReason, now, now);
  assert.deepEqual(
    { ...db.prepare(
      "SELECT status, status_change_reason, status_changed_at, status_changed_by_user_id, status_change_request_id, version FROM ops_services WHERE id = 'svc-1'",
    ).get() },
    {
      status: "deprecated",
      status_change_reason: deprecationReason,
      status_changed_at: now,
      status_changed_by_user_id: "usr-1",
      status_change_request_id: "req-service-valid-deprecate",
      version: 2,
    },
  );
  assert.deepEqual(
    db.prepare(
      `SELECT id, from_status, to_status, reason, changed_by_user_id, request_id, changed_at
       FROM ops_service_lifecycle_events WHERE service_id = 'svc-1' ORDER BY changed_at, id`,
    ).all().map((row) => ({ ...row })),
    [{
      id: "svc-1:lifecycle:00000000000000000002",
      from_status: "active",
      to_status: "deprecated",
      reason: deprecationReason,
      changed_by_user_id: "usr-1",
      request_id: "req-service-valid-deprecate",
      changed_at: now,
    }],
  );
  assert.throws(
    () => db.prepare(
      `INSERT INTO ops_service_lifecycle_events
        (id, organization_id, service_id, from_status, to_status, reason,
         changed_by_user_id, request_id, changed_at)
       VALUES ('svc-1:lifecycle:forged', 'ops-singleton', 'svc-1', 'active', 'deprecated',
               ?, 'usr-1', 'req-service-valid-deprecate', ?)`,
    ).run(deprecationReason, now),
    /OPS_SERVICE_LIFECYCLE_EVENT_NOT_DERIVED/,
  );
  assert.throws(
    () => db.prepare(
      `INSERT INTO ops_service_lifecycle_events
        (id, organization_id, service_id, from_status, to_status, reason,
         changed_by_user_id, request_id, changed_at)
       VALUES ('svc-1:lifecycle:00000000000000000002', 'ops-singleton', 'svc-1',
               'active', 'deprecated', ?, 'usr-1', 'req-service-valid-deprecate', ?)`,
    ).run(deprecationReason, now),
    /UNIQUE constraint failed: ops_service_lifecycle_events/,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM ops_service_lifecycle_events WHERE service_id = 'svc-1'").get()?.count,
    1,
  );
  assert.throws(
    () => db.prepare(
      "UPDATE ops_service_lifecycle_events SET reason = 'Rewritten history.' WHERE service_id = 'svc-1'",
    ).run(),
    /OPS_SERVICE_LIFECYCLE_EVENT_IMMUTABLE/,
  );
  assert.throws(
    () => db.prepare("DELETE FROM ops_service_lifecycle_events WHERE service_id = 'svc-1'").run(),
    /OPS_SERVICE_LIFECYCLE_EVENT_IMMUTABLE/,
  );
  assert.throws(
    () => db.prepare(
      `UPDATE ops_services SET status = 'active', status_change_reason = ?, status_changed_at = ?,
         status_changed_by_user_id = 'usr-1', status_change_request_id = 'req-service-valid-deprecate',
         version = version + 1, updated_at = ? WHERE id = 'svc-1'`,
    ).run("A second lifecycle transition cannot reuse the prior request identifier.", "2026-07-31T10:15:00.000Z", "2026-07-31T10:15:00.000Z"),
    /UNIQUE constraint failed: ops_service_lifecycle_events.service_id, ops_service_lifecycle_events.request_id/,
  );
  assert.deepEqual(
    { ...db.prepare("SELECT status, version FROM ops_services WHERE id = 'svc-1'").get() },
    { status: "deprecated", version: 2 },
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM ops_service_lifecycle_events WHERE service_id = 'svc-1'").get()?.count,
    1,
  );
  assert.throws(
    () => db.prepare(
      "UPDATE ops_services SET status_change_reason = 'Rewritten evidence.', version = version + 1, updated_at = ? WHERE id = 'svc-1'",
    ).run(now),
    /OPS_SERVICE_STATUS_METADATA_IMMUTABLE/,
  );
  const reactivationAt = "2026-07-31T10:20:00.000Z";
  const reactivationReason = "Ownership, SLO, and the current runbook were verified before reactivation.";
  db.prepare(
    `UPDATE ops_services SET status = 'active', status_change_reason = ?, status_changed_at = ?,
       status_changed_by_user_id = 'usr-1', status_change_request_id = 'req-service-valid-reactivate',
       version = version + 1, updated_at = ? WHERE id = 'svc-1'`,
  ).run(reactivationReason, reactivationAt, reactivationAt);
  assert.deepEqual(
    { ...db.prepare(
      "SELECT status, status_change_request_id, version FROM ops_services WHERE id = 'svc-1'",
    ).get() },
    { status: "active", status_change_request_id: "req-service-valid-reactivate", version: 3 },
  );
  assert.deepEqual(
    db.prepare(
      `SELECT id, from_status, to_status, reason, changed_by_user_id, request_id, changed_at
       FROM ops_service_lifecycle_events WHERE service_id = 'svc-1' ORDER BY changed_at, id`,
    ).all().map((row) => ({ ...row })),
    [
      {
        id: "svc-1:lifecycle:00000000000000000002",
        from_status: "active",
        to_status: "deprecated",
        reason: deprecationReason,
        changed_by_user_id: "usr-1",
        request_id: "req-service-valid-deprecate",
        changed_at: now,
      },
      {
        id: "svc-1:lifecycle:00000000000000000003",
        from_status: "deprecated",
        to_status: "active",
        reason: reactivationReason,
        changed_by_user_id: "usr-1",
        request_id: "req-service-valid-reactivate",
        changed_at: reactivationAt,
      },
    ],
  );
  assert.throws(
    () => db.prepare("UPDATE ops_services SET version = version + 2, updated_at = ? WHERE id = 'svc-1'").run(now),
    /OPS_SERVICE_VERSION_MUST_INCREMENT/,
  );
  db.close();
});

test("0003 stops when existing active assignments violate the role matrix", async () => {
  const db = await databaseThrough0002();
  addMember(db, "usr-1", "observer");
  addService(db);
  addIncident(db, { id: "inc-incompatible-upgrade" });
  addIncidentAssignment(
    db,
    "inc-incompatible-upgrade",
    "usr-1",
    "communications_lead",
    "assign-incompatible-upgrade",
  );
  const migration = await readFile(
    new URL("../db/migrations/0003_assignment_role_integrity.sql", import.meta.url),
    "utf8",
  );
  assert.throws(
    () => db.exec(`BEGIN;\n${migration}\nCOMMIT;`),
    /OPS_ASSIGNMENT_ROLE_INCOMPATIBLE/,
  );
  try {
    db.exec("ROLLBACK");
  } catch {
    // SQLite may already have closed the transaction after a migration error.
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM ops_incident_assignments WHERE status = 'active'").get()?.count,
    1,
  );
  db.close();
});

test("0004 preserves legacy lifecycle history without inventing a missing reason", async () => {
  const db = await databaseThrough0002();
  const assignmentMigration = await readFile(
    new URL("../db/migrations/0003_assignment_role_integrity.sql", import.meta.url),
    "utf8",
  );
  db.exec(`BEGIN;\n${assignmentMigration}\nCOMMIT;`);
  addMember(db, "usr-1", "commander");
  addService(db);
  const legacyAt = "2026-07-31T10:05:00.000Z";
  db.prepare(
    "UPDATE ops_services SET status = 'deprecated', version = version + 1, updated_at = ? WHERE id = 'svc-1'",
  ).run(legacyAt);
  const lifecycleMigration = await readFile(
    new URL("../db/migrations/0004_service_lifecycle_accountability.sql", import.meta.url),
    "utf8",
  );
  db.exec(`BEGIN;\n${lifecycleMigration}\nCOMMIT;`);
  assert.deepEqual(
    { ...db.prepare(
      "SELECT status, status_change_reason, status_changed_at, status_changed_by_user_id FROM ops_services WHERE id = 'svc-1'",
    ).get() },
    {
      status: "deprecated",
      status_change_reason: null,
      status_changed_at: null,
      status_changed_by_user_id: null,
    },
  );
  db.prepare(
    "UPDATE ops_services SET name = 'Legacy Service', version = version + 1, updated_at = ? WHERE id = 'svc-1'",
  ).run("2026-07-31T10:06:00.000Z");
  assert.throws(
    () => db.prepare(
      "UPDATE ops_services SET status = 'active', version = version + 1, updated_at = ? WHERE id = 'svc-1'",
    ).run("2026-07-31T10:07:00.000Z"),
    /OPS_SERVICE_STATUS_CHANGE_REASON_REQUIRED/,
  );
  const reactivatedAt = "2026-07-31T10:08:00.000Z";
  const reactivationReason = "The current owner, SLO, and runbook were verified before reactivation.";
  db.prepare(
    `UPDATE ops_services SET status = 'active', status_change_reason = ?, status_changed_at = ?,
       status_changed_by_user_id = 'usr-1', status_change_request_id = 'req-legacy-reactivation',
       version = version + 1, updated_at = ? WHERE id = 'svc-1'`,
  ).run(reactivationReason, reactivatedAt, reactivatedAt);
  assert.deepEqual(
    db.prepare(
      `SELECT id, from_status, to_status, reason, changed_by_user_id, request_id, changed_at
       FROM ops_service_lifecycle_events WHERE service_id = 'svc-1'`,
    ).all().map((row) => ({ ...row })),
    [{
      id: "svc-1:lifecycle:00000000000000000004",
      from_status: "deprecated",
      to_status: "active",
      reason: reactivationReason,
      changed_by_user_id: "usr-1",
      request_id: "req-legacy-reactivation",
      changed_at: reactivatedAt,
    }],
  );
  db.close();
});

test("incident assignments enforce organization-role compatibility and preserve read-only boundaries", async () => {
  const db = await migratedDatabase();
  addMember(db, "usr-1", "admin");
  addMember(db, "cmd-1", "commander");
  addMember(db, "rsp-1", "responder");
  addMember(db, "obs-1", "observer");
  addMember(db, "aud-1", "auditor");
  addService(db);
  addIncident(db, { id: "inc-role-matrix" });

  addIncidentAssignment(db, "inc-role-matrix", "usr-1", "responder", "assign-admin-responder");
  addIncidentAssignment(db, "inc-role-matrix", "cmd-1", "incident_commander", "assign-cmd-command");
  addIncidentAssignment(db, "inc-role-matrix", "cmd-1", "communications_lead", "assign-cmd-comms");
  addIncidentAssignment(db, "inc-role-matrix", "rsp-1", "responder", "assign-rsp-response");
  addIncidentAssignment(db, "inc-role-matrix", "rsp-1", "service_owner", "assign-rsp-owner");
  addIncidentAssignment(db, "inc-role-matrix", "rsp-1", "communications_lead", "assign-rsp-comms");
  addIncidentAssignment(db, "inc-role-matrix", "obs-1", "observer", "assign-obs-read");
  addIncidentAssignment(db, "inc-role-matrix", "aud-1", "observer", "assign-aud-read");

  assert.throws(
    () => addIncidentAssignment(db, "inc-role-matrix", "obs-1", "communications_lead", "assign-obs-comms"),
    /OPS_ASSIGNMENT_ROLE_INCOMPATIBLE/,
  );
  assert.throws(
    () => addIncidentAssignment(db, "inc-role-matrix", "aud-1", "responder", "assign-aud-response"),
    /OPS_ASSIGNMENT_ROLE_INCOMPATIBLE/,
  );
  assert.throws(
    () => addIncidentAssignment(db, "inc-role-matrix", "cmd-1", "service_owner", "assign-cmd-owner"),
    /OPS_ASSIGNMENT_ROLE_INCOMPATIBLE/,
  );
  assert.throws(
    () => addIncidentAssignment(db, "inc-role-matrix", "rsp-1", "incident_commander", "assign-rsp-command"),
    /OPS_ASSIGNMENT_ROLE_INCOMPATIBLE|OPS_COMMANDER_ROLE_REQUIRED/,
  );

  assert.throws(
    () => db.prepare(
      "UPDATE ops_memberships SET role = 'observer', version = version + 1 WHERE id = 'mem-rsp-1'",
    ).run(),
    /OPS_ASSIGNMENT_ROLE_INCOMPATIBLE/,
  );
  db.prepare(
    `UPDATE ops_incident_assignments
     SET status = 'revoked', ended_at = '2026-07-31T11:00:00.000Z', ended_by_user_id = 'usr-1'
     WHERE user_id = 'rsp-1' AND status = 'active'`,
  ).run();
  db.prepare(
    "UPDATE ops_memberships SET role = 'observer', version = version + 1 WHERE id = 'mem-rsp-1'",
  ).run();
  assert.equal(db.prepare("SELECT role FROM ops_memberships WHERE id = 'mem-rsp-1'").get()?.role, "observer");

  db.prepare(
    "UPDATE ops_memberships SET role = 'auditor', version = version + 1 WHERE id = 'mem-obs-1'",
  ).run();
  assert.equal(db.prepare("SELECT role FROM ops_memberships WHERE id = 'mem-obs-1'").get()?.role, "auditor");
  assert.throws(
    () => db.prepare(
      "UPDATE ops_memberships SET status = 'suspended', version = version + 1 WHERE id = 'mem-obs-1'",
    ).run(),
    /OPS_ASSIGNMENT_ROLE_INCOMPATIBLE/,
  );
  db.close();
});

test("assignment revocation preserves history, requires a commander, and permits later reassignment", async () => {
  const db = await migratedDatabase();
  addMember(db, "usr-1", "commander");
  addMember(db, "usr-2", "commander");
  addService(db);
  addIncident(db, { id: "inc-command" });
  addCommanderAssignment(db, "inc-command", "usr-1", "assign-1");
  const ended = "2026-07-31T10:20:00.000Z";
  assert.throws(
    () => db.prepare(
      `UPDATE ops_incident_assignments SET status = 'revoked', ended_at = ?, ended_by_user_id = 'usr-1'
       WHERE id = 'assign-1'`,
    ).run(ended),
    /OPS_INCIDENT_COMMANDER_REQUIRED/,
  );
  addCommanderAssignment(db, "inc-command", "usr-2", "assign-2");
  db.prepare(
    `UPDATE ops_incident_assignments SET status = 'revoked', ended_at = ?, ended_by_user_id = 'usr-2'
     WHERE id = 'assign-1'`,
  ).run(ended);
  addCommanderAssignment(db, "inc-command", "usr-1", "assign-3");
  const history = db.prepare(
    "SELECT id, status FROM ops_incident_assignments WHERE incident_id = 'inc-command' AND user_id = 'usr-1' ORDER BY id",
  ).all().map((row) => ({ id: row.id, status: row.status }));
  assert.deepEqual(history, [
    { id: "assign-1", status: "revoked" },
    { id: "assign-3", status: "active" },
  ]);
  assert.throws(
    () => db.prepare("UPDATE ops_incident_assignments SET ended_at = ? WHERE id = 'assign-1'").run(ended),
    /OPS_ASSIGNMENT_REVOKED_IMMUTABLE/,
  );
  db.close();
});

test("membership guards prevent concurrent loss of the last admin and active incident commander", async () => {
  const db = await migratedDatabase();
  addMember(db, "admin-1", "admin");
  addMember(db, "admin-2", "admin");
  assert.throws(
    () => db.prepare("UPDATE ops_memberships SET role = 'observer' WHERE id = 'mem-admin-1'").run(),
    /OPS_MEMBERSHIP_VERSION_MUST_INCREMENT/,
  );
  db.prepare("UPDATE ops_memberships SET role = 'observer', version = version + 1 WHERE id = 'mem-admin-1'").run();
  assert.throws(
    () => db.prepare("UPDATE ops_memberships SET role = 'observer', version = version + 1 WHERE id = 'mem-admin-2'").run(),
    /OPS_LAST_ADMIN_REQUIRED/,
  );
  db.close();

  const incidentDb = await migratedDatabase();
  addMember(incidentDb, "usr-1", "commander");
  addMember(incidentDb, "usr-2", "commander");
  addService(incidentDb);
  addIncident(incidentDb, { id: "inc-handoff" });
  addCommanderAssignment(incidentDb, "inc-handoff", "usr-1", "assign-handoff-1");
  assert.throws(
    () => incidentDb.prepare("UPDATE ops_memberships SET role = 'responder', version = version + 1 WHERE id = 'mem-usr-1'").run(),
    /OPS_ACTIVE_INCIDENT_HANDOFF_REQUIRED|OPS_ASSIGNMENT_ROLE_INCOMPATIBLE/,
  );
  addCommanderAssignment(incidentDb, "inc-handoff", "usr-2", "assign-handoff-2");
  assert.throws(
    () => incidentDb.prepare("UPDATE ops_memberships SET role = 'responder', version = version + 1 WHERE id = 'mem-usr-1'").run(),
    /OPS_ASSIGNMENT_ROLE_INCOMPATIBLE/,
  );
  incidentDb.prepare(
    `UPDATE ops_incident_assignments SET status = 'revoked', ended_at = '2026-07-31T10:20:00.000Z',
     ended_by_user_id = 'usr-2' WHERE id = 'assign-handoff-1'`,
  ).run();
  incidentDb.prepare("UPDATE ops_memberships SET role = 'responder', version = version + 1 WHERE id = 'mem-usr-1'").run();
  assert.equal(incidentDb.prepare("SELECT role FROM ops_memberships WHERE id = 'mem-usr-1'").get()?.role, "responder");
  incidentDb.close();
});

test("evidence metadata round-trips and expired idempotency receipts can be atomically replaced", async () => {
  const db = await migratedDatabase();
  addMember(db, "usr-1", "admin");
  addService(db);
  addIncident(db, { id: "inc-evidence" });
  const digest = "a".repeat(64);
  db.prepare(
    `INSERT INTO ops_incident_timeline
      (id, organization_id, incident_id, event_type, actor_user_id, message, reference_url,
       source_label, observed_from, observed_to, sha256_digest, request_id, created_at)
     VALUES ('tl-evidence', 'ops-singleton', 'inc-evidence', 'verification', 'usr-1', 'Probe passed.',
             'https://observability.example.com/probe/1', 'Regional synthetic probe',
             '2026-07-31T10:00:00.000Z', '2026-07-31T10:05:00.000Z', ?, 'req-evidence',
             '2026-07-31T10:05:00.000Z')`,
  ).run(digest);
  db.prepare(
    `INSERT INTO ops_incident_tasks
      (id, organization_id, incident_id, title, evidence_ref, version, created_by_user_id, created_at, updated_at)
     VALUES ('task-evidence', 'ops-singleton', 'inc-evidence', 'Validate recovery',
             'https://observability.example.com/evidence/1', 1, 'usr-1',
             '2026-07-31T10:00:00.000Z', '2026-07-31T10:00:00.000Z')`,
  ).run();
  const evidence = db.prepare("SELECT reference_url, source_label, sha256_digest FROM ops_incident_timeline WHERE id = 'tl-evidence'").get();
  assert.equal(evidence?.reference_url, "https://observability.example.com/probe/1");
  assert.equal(evidence?.source_label, "Regional synthetic probe");
  assert.equal(evidence?.sha256_digest, digest);
  assert.equal(db.prepare("SELECT evidence_ref FROM ops_incident_tasks WHERE id = 'task-evidence'").get()?.evidence_ref,
    "https://observability.example.com/evidence/1");

  db.prepare(
    `INSERT INTO ops_idempotency_receipts
      (id, organization_id, actor_user_id, action_scope, idempotency_key_hash, request_hash,
       response_json, created_at, expires_at)
     VALUES ('receipt-expired', 'ops-singleton', 'usr-1', 'scope-1', 'key-hash', 'old-request',
             '{"old":true}', '2026-07-30T00:00:00.000Z', '2026-07-30T01:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO ops_idempotency_receipts
      (id, organization_id, actor_user_id, action_scope, idempotency_key_hash, request_hash,
       response_json, created_at, expires_at)
     VALUES ('receipt-valid', 'ops-singleton', 'usr-1', 'scope-valid', 'valid-key', 'valid-request',
             '{"valid":true}', '2026-07-31T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  ).run();
  db.exec("BEGIN IMMEDIATE");
  db.prepare(
    `DELETE FROM ops_idempotency_receipts
     WHERE id IN (
       SELECT id FROM ops_idempotency_receipts
       WHERE organization_id = 'ops-singleton' AND expires_at <= '2026-07-31T00:00:00.000Z'
       ORDER BY expires_at, id LIMIT 100
     )`,
  ).run();
  db.prepare(
    `DELETE FROM ops_idempotency_receipts
     WHERE organization_id = 'ops-singleton' AND actor_user_id = 'usr-1'
       AND action_scope = 'scope-1' AND idempotency_key_hash = 'key-hash'
       AND expires_at <= '2026-07-31T00:00:00.000Z'`,
  ).run();
  db.prepare(
    `INSERT INTO ops_idempotency_receipts
      (id, organization_id, actor_user_id, action_scope, idempotency_key_hash, request_hash,
       response_json, created_at, expires_at)
     VALUES ('receipt-current', 'ops-singleton', 'usr-1', 'scope-1', 'key-hash', 'new-request',
             '{"current":true}', '2026-07-31T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
  ).run();
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT id FROM ops_idempotency_receipts WHERE action_scope = 'scope-1'").get()?.id, "receipt-current");
  assert.equal(db.prepare("SELECT id FROM ops_idempotency_receipts WHERE id = 'receipt-valid'").get()?.id, "receipt-valid");
  assert.throws(
    () => db.prepare(
      `INSERT INTO ops_idempotency_receipts
        (id, organization_id, actor_user_id, action_scope, idempotency_key_hash, request_hash,
         response_json, created_at, expires_at)
       VALUES ('receipt-racer', 'ops-singleton', 'usr-1', 'scope-1', 'key-hash', 'new-request',
               '{}', '2026-07-31T00:00:00.000Z', '2026-08-01T00:00:00.000Z')`,
    ).run(),
    /UNIQUE constraint failed/,
  );
  assert.equal(db.prepare("SELECT response_json FROM ops_idempotency_receipts WHERE id = 'receipt-current'").get()?.response_json,
    '{"current":true}');
  db.close();
});

test("0002 upgrades the recorded legacy 0001 contract without inventing evidence or cancellation reasons", async () => {
  const db = legacyDatabaseForUpgrade();
  const now = "2026-07-31T10:00:00.000Z";
  db.exec(`
    INSERT INTO ops_organizations (id, name, status, created_at)
    VALUES ('ops-singleton', 'Continuity Ops', 'active', '${now}');
    INSERT INTO ops_users (id, email, display_name, identity_source, status, created_at, last_seen_at)
    VALUES ('usr-1', 'owner@example.com', 'Owner', 'local_environment', 'active', '${now}', '${now}');
    INSERT INTO ops_memberships (id, organization_id, user_id, role, status, created_at, updated_at)
    VALUES ('mem-1', 'ops-singleton', 'usr-1', 'admin', 'active', '${now}', '${now}');
    INSERT INTO ops_services
      (id, organization_id, name, slug, description, tier, owner_team, slo_target,
       status, version, created_at, updated_at)
    VALUES ('svc-1', 'ops-singleton', 'Service', 'service', '', 'tier_1', 'Ops', 99.9,
            'active', 1, '${now}', '${now}');
    INSERT INTO ops_incidents
      (id, organization_id, incident_number, service_id, title, summary, severity, status,
       environment, created_by_user_id, updated_by_user_id, last_request_id,
       created_at, updated_at, declared_at)
    VALUES ('inc-1', 'ops-singleton', 'INC-LEGACY-1', 'svc-1', 'Legacy incident',
            'Legacy incident summary', 'sev2', 'resolved', 'production', 'usr-1', 'usr-1',
            'req-legacy', '${now}', '${now}', '${now}');
    INSERT INTO ops_incident_assignments
      (id, organization_id, incident_id, user_id, incident_role, assigned_by_user_id, created_at)
    VALUES ('assign-1', 'ops-singleton', 'inc-1', 'usr-1', 'incident_commander', 'usr-1', '${now}');
    INSERT INTO ops_incident_timeline
      (id, organization_id, incident_id, event_type, actor_user_id, message, request_id, created_at)
    VALUES ('tl-1', 'ops-singleton', 'inc-1', 'verification', 'usr-1', 'Legacy verification.',
            'req-tl-1', '${now}');
    INSERT INTO ops_incident_tasks
      (id, organization_id, incident_id, title, priority, status, completed_at, version,
       created_by_user_id, created_at, updated_at)
    VALUES
      ('task-completed', 'ops-singleton', 'inc-1', 'Legacy completed task', 'high', 'completed',
       '${now}', 1, 'usr-1', '${now}', '${now}'),
      ('task-cancelled', 'ops-singleton', 'inc-1', 'Legacy cancelled gate', 'critical', 'cancelled',
       NULL, 1, 'usr-1', '${now}', '${now}');
    INSERT INTO ops_post_incident_reviews
      (id, organization_id, incident_id, summary, customer_impact, root_cause, detection_gap,
       lessons_learned, follow_up_actions, status, version, created_by_user_id, updated_by_user_id,
       created_at, updated_at)
    VALUES ('review-1', 'ops-singleton', 'inc-1', 'Short', '', '', '', '', '', 'completed', 1,
            'usr-1', 'usr-1', '${now}', '${now}');
  `);
  const migration = await readFile(
    new URL("../db/migrations/0002_continuity_ops_contract_upgrade.sql", import.meta.url),
    "utf8",
  );
  db.exec(`BEGIN;\n${migration}\nCOMMIT;`);

  assert.equal(db.prepare("SELECT timezone FROM ops_organizations WHERE id = 'ops-singleton'").get()?.timezone, "UTC");
  assert.equal(db.prepare("SELECT version FROM ops_memberships WHERE id = 'mem-1'").get()?.version, 1);
  assert.deepEqual(
    { ...db.prepare("SELECT status, ended_at, ended_by_user_id FROM ops_incident_assignments WHERE id = 'assign-1'").get() },
    { status: "active", ended_at: null, ended_by_user_id: null },
  );
  assert.deepEqual(
    { ...db.prepare("SELECT reference_url, source_label, observed_from, observed_to, sha256_digest FROM ops_incident_timeline WHERE id = 'tl-1'").get() },
    { reference_url: null, source_label: null, observed_from: null, observed_to: null, sha256_digest: null },
  );
  assert.deepEqual(
    db.prepare("SELECT id, status, completed_at, evidence_ref, cancellation_reason FROM ops_incident_tasks ORDER BY id").all()
      .map((row) => ({ ...row })),
    [
      { id: "task-cancelled", status: "blocked", completed_at: null, evidence_ref: null, cancellation_reason: null },
      { id: "task-completed", status: "blocked", completed_at: null, evidence_ref: null, cancellation_reason: null },
    ],
  );
  assert.equal(db.prepare("SELECT status FROM ops_post_incident_reviews WHERE id = 'review-1'").get()?.status, "draft");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ops_incident_timeline WHERE request_id LIKE 'migration-0002-%'").get()?.count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ops_audit_events WHERE action LIKE 'migration.%'").get()?.count, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'trigger' AND name LIKE 'ops_communication_%'").get()?.count, 9);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("stateful retries inspect receipts before validations changed by the first request", async () => {
  const [handlers, operations] = await Promise.all([
    readFile(new URL("../app/api/v1/_handlers.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/operations.ts", import.meta.url), "utf8"),
  ]);
  const transition = handlers.slice(
    handlers.indexOf("async function transitionIncident"),
    handlers.indexOf("async function incidentTimeline"),
  );
  assert.ok(transition.indexOf("readIdempotentReplay") < transition.indexOf("canTransitionIncident"));
  const review = handlers.slice(
    handlers.indexOf("async function incidentReview"),
    handlers.indexOf("async function incidentAssignments"),
  );
  const reviewPut = review.slice(review.indexOf("if (context.request.method !== \"PUT\")"));
  assert.ok(reviewPut.indexOf("readIdempotentReplay") < reviewPut.indexOf("SELECT * FROM ops_post_incident_reviews"));
  const communications = handlers.slice(
    handlers.indexOf("async function incidentCommunications"),
    handlers.indexOf("async function incidentTasks"),
  );
  const communicationCreate = communications.slice(
    communications.indexOf("if (rest.length === 0 && context.request.method === \"POST\")"),
    communications.indexOf("if (rest.length === 1 && context.request.method === \"PATCH\")"),
  );
  assert.ok(
    communicationCreate.indexOf("readIdempotentReplay")
      < communicationCreate.indexOf("isCommunicationAudience"),
  );
  const communicationPatch = communications.slice(communications.indexOf("if (rest.length === 1"));
  assert.ok(
    communicationPatch.indexOf("readIdempotentReplay")
      < communicationPatch.indexOf("SELECT * FROM ops_incident_communications"),
  );
  assert.match(
    operations,
    /batch\(\[boundedExpiredReceiptCleanup, expiredReceiptDelete, receiptStatement, \.\.\.options\.statements\]\)/,
  );
  assert.ok(
    operations.indexOf("if (!existingMembership && !bootstrapRole) return null")
      < operations.indexOf("const statements: D1PreparedStatement[]"),
  );
});
