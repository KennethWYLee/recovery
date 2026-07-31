import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { evaluateRestoreDrill, parseWranglerQueryResults } from "./d1-restore-drill-lib.mjs";

const root = process.cwd();
const wranglerBin = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const wranglerPackage = JSON.parse(readFileSync(resolve("node_modules/wrangler/package.json"), "utf8"));
const productPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

function usage() {
  return [
    "Usage:",
    "  node scripts/run-local-d1-restore-drill.mjs",
    "    [--config wrangler.local.jsonc] [--database DB]",
    "    [--work-root .wrangler/backup-restore-drills]",
    "    [--output evidence/continuity-ops-local-d1-restore-drill.json]",
    "    [--run-id local-restore-unique-id]",
    "",
    "Safety: the drill always creates two new isolated local states and never accepts --remote.",
  ].join("\n");
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--help" || current === "-h") return { help: true };
    assert.match(current, /^--(?:config|database|work-root|output|run-id)$/u, `Unknown argument: ${current}`);
    const value = argv[index + 1];
    assert.ok(value && !value.startsWith("--"), `${current} requires a value.`);
    result[current.slice(2)] = value;
    index += 1;
  }
  return result;
}

function isWithin(parent, child) {
  const pathFromParent = relative(parent, child);
  return pathFromParent !== "" && !pathFromParent.startsWith("..") && !isAbsolute(pathFromParent);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function displayPath(path) {
  const fromRoot = relative(root, path);
  return fromRoot && !fromRoot.startsWith("..") && !isAbsolute(fromRoot)
    ? fromRoot.replaceAll("\\", "/")
    : basename(path);
}

class DrillCommandError extends Error {
  constructor(stage, status) {
    super(`WRANGLER_COMMAND_FAILED:${stage}`);
    this.name = "DrillCommandError";
    this.stage = stage;
    this.status = status;
  }
}

const args = parseArguments(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const configPath = resolve(args.config ?? "wrangler.local.jsonc");
const database = args.database ?? "DB";
const allowedWorkParent = resolve(".wrangler");
const workRoot = resolve(args["work-root"] ?? ".wrangler/backup-restore-drills");
const evidenceRoot = resolve("evidence");
const outputPath = resolve(args.output ?? "evidence/continuity-ops-local-d1-restore-drill.json");
const runId = args["run-id"] ?? `local-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;

assert.ok(existsSync(configPath) && statSync(configPath).isFile(), "The local Wrangler configuration does not exist.");
assert.ok(isWithin(root, configPath), "--config must stay within the project directory.");
assert.match(database, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u, "--database must be a safe local D1 binding or database name.");
assert.ok(isWithin(allowedWorkParent, workRoot), "--work-root must be a child of the project .wrangler directory.");
assert.ok(outputPath === join(evidenceRoot, basename(outputPath)) && isWithin(root, outputPath), "--output must be a direct child of the project evidence directory.");
assert.match(runId, /^[a-z0-9][a-z0-9-]{7,63}$/u, "--run-id must contain 8-64 lowercase letters, digits, or hyphens.");

const runRoot = join(workRoot, runId);
const sourceWorkspace = join(runRoot, "source");
const restoreWorkspace = join(runRoot, "restored");
const sourceState = join(sourceWorkspace, ".wrangler", "state");
const restoreState = join(restoreWorkspace, ".wrangler", "state");
const sourceDrillConfig = join(sourceWorkspace, "wrangler.restore-drill.json");
const restoreDrillConfig = join(restoreWorkspace, "wrangler.restore-drill.json");
const backupPath = join(runRoot, "continuity-ops-local-logical-backup.sql");
const commandLogPath = join(runRoot, "wrangler-command-events.jsonl");
assert.equal(existsSync(runRoot), false, `The drill run already exists and will not be overwritten: ${displayPath(runRoot)}`);
mkdirSync(sourceWorkspace, { recursive: true });
mkdirSync(restoreWorkspace, { recursive: true });
let migrationsDirectoryForEvidence = null;

function parseJsonc(path) {
  const withoutCommentLines = readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gmu, "");
  return JSON.parse(withoutCommentLines.replace(/,\s*([}\]])/gu, "$1"));
}

function isolatedConfig(targetPath, label) {
  const base = parseJsonc(configPath);
  const databaseConfig = base.d1_databases?.find((entry) => entry.binding === database || entry.database_name === database);
  assert.ok(databaseConfig, `The configured local D1 binding or database was not found: ${database}`);
  const migrationsDirectory = resolve(dirname(configPath), databaseConfig.migrations_dir ?? base.migrations_dir ?? "migrations");
  assert.ok(existsSync(migrationsDirectory) && statSync(migrationsDirectory).isDirectory(), "The configured migrations directory does not exist.");
  migrationsDirectoryForEvidence = migrationsDirectory;
  const config = {
    name: `continuity-ops-${label}-${runId}`.slice(0, 63),
    main: resolve(dirname(configPath), base.main),
    compatibility_date: base.compatibility_date,
    ...(base.compatibility_flags ? { compatibility_flags: base.compatibility_flags } : {}),
    d1_databases: [{
      binding: databaseConfig.binding,
      database_name: databaseConfig.database_name,
      database_id: databaseConfig.database_id,
      migrations_dir: migrationsDirectory,
    }],
  };
  writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

isolatedConfig(sourceDrillConfig, "source");
isolatedConfig(restoreDrillConfig, "restored");

const timings = {};
let currentStage = "initialize";
const totalStartedAt = performance.now();

function runWrangler(stage, commandArgs, cwd) {
  currentStage = stage;
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [wranglerBin, ...commandArgs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      CI: "true",
      WRANGLER_LOG_PATH: commandLogPath,
    },
  });
  timings[stage] = Math.round(performance.now() - startedAt);
  if (result.status !== 0) throw new DrillCommandError(stage, result.status);
  return result.stdout;
}

function localExecute(stage, statePath, cwd, drillConfigPath, queryOrFile) {
  const commandArgs = ["d1", "execute", database, "--local", "--config", drillConfigPath, "--persist-to", statePath, "--yes"];
  if (queryOrFile.command) commandArgs.push("--command", queryOrFile.command, "--json");
  else commandArgs.push("--file", queryOrFile.file);
  return runWrangler(stage, commandArgs, cwd);
}

function query(stage, statePath, cwd, drillConfigPath, statement) {
  return parseWranglerQueryResults(localExecute(stage, statePath, cwd, drillConfigPath, { command: statement }));
}

function tableCounts(stagePrefix, statePath, cwd, drillConfigPath) {
  const tables = query(
    `${stagePrefix}_table_inventory`,
    statePath,
    cwd,
    drillConfigPath,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;",
  ).map((row) => row.name);
  for (const table of tables) assert.match(table, /^[A-Za-z_][A-Za-z0-9_]*$/u, "Unexpected table name in isolated D1 state.");
  if (tables.length === 0) return {};
  const jsonArguments = tables
    .flatMap((table) => [`'${table}'`, `(SELECT COUNT(*) FROM \"${table}\")`])
    .join(", ");
  const rows = query(
    `${stagePrefix}_table_counts`,
    statePath,
    cwd,
    drillConfigPath,
    `SELECT json_object(${jsonArguments}) AS counts_json;`,
  );
  const counts = JSON.parse(rows[0]?.counts_json ?? "{}");
  return Object.fromEntries(Object.entries(counts).map(([table, rawCount]) => {
    const count = Number(rawCount);
    assert.ok(Number.isSafeInteger(count) && count >= 0, `Invalid row count for ${table}.`);
    return [table, count];
  }));
}

function snapshot(stagePrefix, statePath, cwd, drillConfigPath, markerId) {
  const counts = tableCounts(stagePrefix, statePath, cwd, drillConfigPath);
  const migrationHistory = query(
    `${stagePrefix}_migration_history`,
    statePath,
    cwd,
    drillConfigPath,
    "SELECT id, name, applied_at AS appliedAt FROM d1_migrations ORDER BY id;",
  ).map((row) => ({ id: Number(row.id), name: row.name, appliedAt: String(row.appliedAt) }));
  const foreignKeyViolations = query(`${stagePrefix}_foreign_keys`, statePath, cwd, drillConfigPath, "PRAGMA foreign_key_check;");
  const markerRows = query(
    `${stagePrefix}_controlled_marker`,
    statePath,
    cwd,
    drillConfigPath,
    `SELECT COUNT(*) AS row_count FROM ops_write_guards WHERE id = '${markerId}' AND passed = 1;`,
  );
  return {
    tableCounts: counts,
    migrationHistory,
    foreignKeyViolations,
    controlledMarkerCount: Number(markerRows[0]?.row_count ?? -1),
  };
}

function writeReport(report) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

const markerId = `restore-drill-${runId}`;

try {
  runWrangler("source_migrations", [
    "d1", "migrations", "apply", database, "--local", "--config", sourceDrillConfig, "--persist-to", sourceState,
  ], sourceWorkspace);
  localExecute("source_controlled_seed", sourceState, sourceWorkspace, sourceDrillConfig, {
    command: `INSERT INTO ops_write_guards (id, passed, created_at) VALUES ('${markerId}', 1, '2026-07-31T00:00:00.000Z');`,
  });
  const source = snapshot("source", sourceState, sourceWorkspace, sourceDrillConfig, markerId);

  runWrangler("logical_export", [
    "d1", "export", database, "--local", "--config", sourceDrillConfig, "--cwd", sourceWorkspace,
    "--output", backupPath, "--skip-confirmation",
  ], sourceWorkspace);
  assert.ok(existsSync(backupPath) && statSync(backupPath).isFile(), "The local logical backup was not created.");
  const backupSha256BeforeRestore = sha256File(backupPath);

  localExecute("isolated_restore", restoreState, restoreWorkspace, restoreDrillConfig, { file: backupPath });
  const restored = snapshot("restored", restoreState, restoreWorkspace, restoreDrillConfig, markerId);
  const backupSha256AfterRestore = sha256File(backupPath);
  const evaluation = evaluateRestoreDrill({
    source,
    restored,
    backup: {
      bytes: statSync(backupPath).size,
      sha256BeforeRestore: backupSha256BeforeRestore,
      sha256AfterRestore: backupSha256AfterRestore,
    },
  });
  const migrationArtifacts = evaluation.restored.migrationHistory.map((migration) => {
    const path = resolve(migrationsDirectoryForEvidence, migration.name);
    assert.ok(isWithin(migrationsDirectoryForEvidence, path) && existsSync(path) && statSync(path).isFile(), `Migration artifact is unavailable: ${migration.name}`);
    return { name: migration.name, sha256: sha256File(path) };
  });
  const migrationSetSha256 = createHash("sha256")
    .update(migrationArtifacts.map((migration) => `${migration.name}:${migration.sha256}`).join("\n"))
    .digest("hex");
  timings.total = Math.round(performance.now() - totalStartedAt);
  const report = {
    schemaVersion: "1.0",
    evidenceId: "CO-VRF-D1-RESTORE-001",
    product: "Continuity Ops",
    productVersion: productPackage.version,
    generatedAt: new Date().toISOString(),
    evidenceStatus: "verified_local_controlled",
    verificationType: "isolated_local_d1_logical_export_restore_drill",
    environment: {
      scope: "local_only",
      dataClassification: "synthetic_controlled",
      sourceState: "new_isolated_state",
      restoreState: "new_isolated_state",
      remoteCommandsUsed: false,
      stagingOrProductionEvidence: false,
    },
    result: evaluation.result,
    tooling: {
      wranglerVersion: wranglerPackage.version,
      commands: ["d1 migrations apply --local", "d1 execute --local", "d1 export --local"],
    },
    run: {
      runId,
      retainedStateDirectory: displayPath(runRoot),
      statesRetainedForInspection: true,
      preExistingStateReadOrChanged: false,
    },
    backup: {
      method: "Wrangler local logical SQL export",
      format: "sql",
      path: displayPath(backupPath),
      bytes: statSync(backupPath).size,
      sha256: backupSha256BeforeRestore,
      unchangedAfterRestore: backupSha256BeforeRestore === backupSha256AfterRestore,
    },
    artifactBinding: {
      applicationArtifact: null,
      schemaMigrations: migrationArtifacts,
      migrationSetSha256,
      note: "The drill is bound to the exact migration-file hashes and backup hash, not to a built Worker artifact.",
    },
    checks: evaluation.checks,
    source: evaluation.source,
    restored: evaluation.restored,
    elapsedMs: timings,
    limitations: [
      "This is a controlled local D1 drill with synthetic migration data; it is not a staging or production backup test.",
      "The measured elapsed time is not an RTO. No recovery point, concurrent write, network, dataset-size, or operational approval requirement was tested.",
      "The drill verifies a Wrangler logical SQL export and isolated import; it does not verify D1 Time Travel, hosted backup retention, or remote restore permissions.",
      "Wrangler D1 local execute rejects PRAGMA integrity_check with SQLITE_AUTH, so this drill uses supported row-count, migration-history, controlled-marker, and foreign_key_check verification instead.",
      "The isolated states and logical backup are retained under the git-ignored .wrangler directory for inspection; this script never deletes prior data.",
    ],
  };
  writeReport(report);
  console.log(JSON.stringify({
    ok: report.result === "passed",
    evidenceId: report.evidenceId,
    result: report.result,
    output: displayPath(outputPath),
    tableCount: Object.keys(report.restored.tableCounts).length,
    migrationCount: report.restored.migrationHistory.length,
    backupSha256: report.backup.sha256,
    totalElapsedMs: report.elapsedMs.total,
  }, null, 2));
  if (report.result !== "passed") process.exitCode = 1;
} catch (error) {
  timings.total = Math.round(performance.now() - totalStartedAt);
  const failedReport = {
    schemaVersion: "1.0",
    evidenceId: "CO-VRF-D1-RESTORE-001",
    product: "Continuity Ops",
    productVersion: productPackage.version,
    generatedAt: new Date().toISOString(),
    evidenceStatus: "failed_local_controlled",
    verificationType: "isolated_local_d1_logical_export_restore_drill",
    environment: {
      scope: "local_only",
      dataClassification: "synthetic_controlled",
      remoteCommandsUsed: false,
      stagingOrProductionEvidence: false,
    },
    result: "failed",
    failure: {
      stage: error instanceof DrillCommandError ? error.stage : currentStage,
      code: error instanceof DrillCommandError ? "WRANGLER_COMMAND_FAILED" : "DRILL_ASSERTION_FAILED",
      commandExitStatus: error instanceof DrillCommandError ? error.status : null,
      rawCommandOutputRetained: false,
    },
    run: {
      runId,
      retainedStateDirectory: displayPath(runRoot),
      statesRetainedForInspection: true,
      preExistingStateReadOrChanged: false,
    },
    elapsedMs: timings,
    limitations: [
      "The local controlled restore drill did not complete; no staging or production conclusion can be drawn.",
      "Partial isolated state is retained for diagnosis and no pre-existing state was deleted or changed.",
    ],
  };
  writeReport(failedReport);
  console.error(JSON.stringify({
    ok: false,
    evidenceId: failedReport.evidenceId,
    result: failedReport.result,
    failedStage: failedReport.failure.stage,
    output: displayPath(outputPath),
  }, null, 2));
  process.exitCode = 1;
}
