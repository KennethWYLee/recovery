import assert from "node:assert/strict";

function extractJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("WRANGLER_JSON_EMPTY");
  try {
    return JSON.parse(trimmed);
  } catch {
    const firstArray = trimmed.indexOf("[");
    const lastArray = trimmed.lastIndexOf("]");
    if (firstArray >= 0 && lastArray > firstArray) {
      try {
        return JSON.parse(trimmed.slice(firstArray, lastArray + 1));
      } catch {
        // Continue to the bounded failure below.
      }
    }
  }
  throw new Error("WRANGLER_JSON_INVALID");
}

export function parseWranglerQueryResults(stdout) {
  const payload = extractJson(stdout);
  assert.ok(Array.isArray(payload) && payload.length > 0, "WRANGLER_RESULT_ARRAY_REQUIRED");
  const result = payload[0];
  assert.equal(result?.success, true, "WRANGLER_QUERY_NOT_SUCCESSFUL");
  assert.ok(Array.isArray(result.results), "WRANGLER_QUERY_RESULTS_REQUIRED");
  return result.results;
}

function normalizedCounts(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "TABLE_COUNTS_OBJECT_REQUIRED");
  return Object.fromEntries(Object.entries(value)
    .map(([table, count]) => {
      assert.match(table, /^[A-Za-z_][A-Za-z0-9_]*$/u, "TABLE_NAME_INVALID");
      assert.ok(Number.isSafeInteger(count) && count >= 0, `TABLE_COUNT_INVALID:${table}`);
      return [table, count];
    })
    .sort(([left], [right]) => left.localeCompare(right)));
}

function normalizedMigrations(value) {
  assert.ok(Array.isArray(value), "MIGRATION_HISTORY_ARRAY_REQUIRED");
  return value.map((migration) => {
    assert.ok(Number.isSafeInteger(migration.id) && migration.id >= 1, "MIGRATION_ID_INVALID");
    assert.match(migration.name, /^\d{4}_[A-Za-z0-9_.-]+\.sql$/u, "MIGRATION_NAME_INVALID");
    assert.equal(typeof migration.appliedAt, "string", "MIGRATION_APPLIED_AT_INVALID");
    return { id: migration.id, name: migration.name, appliedAt: migration.appliedAt };
  });
}

function normalizeSnapshot(snapshot) {
  assert.ok(snapshot && typeof snapshot === "object", "SNAPSHOT_REQUIRED");
  assert.ok(Array.isArray(snapshot.foreignKeyViolations), "FOREIGN_KEY_RESULTS_REQUIRED");
  assert.ok(Number.isSafeInteger(snapshot.controlledMarkerCount) && snapshot.controlledMarkerCount >= 0, "MARKER_COUNT_INVALID");
  return {
    tableCounts: normalizedCounts(snapshot.tableCounts),
    migrationHistory: normalizedMigrations(snapshot.migrationHistory),
    foreignKeyViolations: snapshot.foreignKeyViolations,
    controlledMarkerCount: snapshot.controlledMarkerCount,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function evaluateRestoreDrill({ source, restored, backup }) {
  const normalizedSource = normalizeSnapshot(source);
  const normalizedRestored = normalizeSnapshot(restored);
  assert.ok(backup && typeof backup === "object", "BACKUP_METADATA_REQUIRED");
  const backupPresent = Number.isSafeInteger(backup.bytes)
    && backup.bytes > 0
    && typeof backup.sha256BeforeRestore === "string"
    && /^[0-9a-f]{64}$/u.test(backup.sha256BeforeRestore)
    && backup.sha256BeforeRestore === backup.sha256AfterRestore;
  const checks = [
    {
      id: "logical_backup_present_and_unchanged",
      passed: backupPresent,
      observed: { bytes: backup.bytes, sha256: backup.sha256BeforeRestore ?? null },
    },
    {
      id: "table_inventory_and_row_counts_match",
      passed: sameJson(normalizedSource.tableCounts, normalizedRestored.tableCounts),
      observed: {
        sourceTableCount: Object.keys(normalizedSource.tableCounts).length,
        restoredTableCount: Object.keys(normalizedRestored.tableCounts).length,
      },
    },
    {
      id: "migration_history_matches",
      passed: sameJson(normalizedSource.migrationHistory, normalizedRestored.migrationHistory),
      observed: {
        sourceMigrationCount: normalizedSource.migrationHistory.length,
        restoredMigrationCount: normalizedRestored.migrationHistory.length,
      },
    },
    {
      id: "source_foreign_keys_clean",
      passed: normalizedSource.foreignKeyViolations.length === 0,
      observed: { violationCount: normalizedSource.foreignKeyViolations.length },
    },
    {
      id: "restored_foreign_keys_clean",
      passed: normalizedRestored.foreignKeyViolations.length === 0,
      observed: { violationCount: normalizedRestored.foreignKeyViolations.length },
    },
    {
      id: "controlled_marker_restored",
      passed: normalizedSource.controlledMarkerCount === 1 && normalizedRestored.controlledMarkerCount === 1,
      observed: {
        sourceCount: normalizedSource.controlledMarkerCount,
        restoredCount: normalizedRestored.controlledMarkerCount,
      },
    },
  ];
  return {
    result: checks.every((check) => check.passed) ? "passed" : "failed",
    checks,
    source: normalizedSource,
    restored: normalizedRestored,
  };
}
