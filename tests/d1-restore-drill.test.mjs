import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRestoreDrill, parseWranglerQueryResults } from "../scripts/d1-restore-drill-lib.mjs";

const snapshot = {
  tableCounts: {
    d1_migrations: 4,
    ops_organizations: 1,
    ops_service_lifecycle_events: 0,
    ops_write_guards: 1,
  },
  migrationHistory: [
    { id: 1, name: "0001_continuity_ops_v2.sql", appliedAt: "2026-07-31 00:00:00" },
    { id: 2, name: "0002_continuity_ops_contract_upgrade.sql", appliedAt: "2026-07-31 00:00:01" },
    { id: 3, name: "0003_assignment_role_integrity.sql", appliedAt: "2026-07-31 00:00:02" },
    { id: 4, name: "0004_service_lifecycle_accountability.sql", appliedAt: "2026-07-31 00:00:03" },
  ],
  foreignKeyViolations: [],
  controlledMarkerCount: 1,
};

const backup = {
  bytes: 42_000,
  sha256BeforeRestore: "a".repeat(64),
  sha256AfterRestore: "a".repeat(64),
};

test("Wrangler JSON parser accepts a successful query envelope and rejects malformed or failed envelopes", () => {
  assert.deepEqual(parseWranglerQueryResults(JSON.stringify([{
    results: [{ table_name: "ops_organizations", row_count: 1 }],
    success: true,
    meta: { duration: 1 },
  }])), [{ table_name: "ops_organizations", row_count: 1 }]);
  assert.throws(() => parseWranglerQueryResults("not json"), /WRANGLER_JSON_INVALID/u);
  assert.throws(() => parseWranglerQueryResults(JSON.stringify([{ results: [], success: false }])), /WRANGLER_QUERY_NOT_SUCCESSFUL/u);
});

test("known-good isolated restore evidence passes every comparison", () => {
  const evaluation = evaluateRestoreDrill({ source: snapshot, restored: structuredClone(snapshot), backup });
  assert.equal(evaluation.result, "passed");
  assert.ok(evaluation.checks.every((check) => check.passed));
});

test("known-bad counts, migration history, foreign keys, marker, and backup hash fail closed", () => {
  const restored = structuredClone(snapshot);
  restored.tableCounts.ops_organizations = 0;
  restored.migrationHistory.pop();
  restored.foreignKeyViolations.push({ table: "ops_services", rowid: 1 });
  restored.controlledMarkerCount = 0;
  const evaluation = evaluateRestoreDrill({
    source: snapshot,
    restored,
    backup: { ...backup, sha256AfterRestore: "b".repeat(64) },
  });
  assert.equal(evaluation.result, "failed");
  for (const id of [
    "logical_backup_present_and_unchanged",
    "table_inventory_and_row_counts_match",
    "migration_history_matches",
    "restored_foreign_keys_clean",
    "controlled_marker_restored",
  ]) {
    assert.equal(evaluation.checks.find((check) => check.id === id)?.passed, false, `${id} should fail.`);
  }
});

test("invalid harness input is rejected instead of being interpreted as a successful drill", () => {
  assert.throws(() => evaluateRestoreDrill({
    source: snapshot,
    restored: { ...snapshot, tableCounts: { ops_organizations: -1 } },
    backup,
  }), /TABLE_COUNT_INVALID/u);
});
