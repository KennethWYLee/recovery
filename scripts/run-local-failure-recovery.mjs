import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const PRODUCT_NAME = "Continuity Ops";
const PRODUCT_VERSION = "2.2.0";
const EVIDENCE_ID = "CO-VRF-FAILURE-RECOVERY-001";
const root = process.cwd();
const outputPath = resolve("evidence/continuity-ops-local-failure-recovery.json");
const workerPath = resolve("dist/server/index.js");
const stateRoot = resolve(".wrangler");
mkdirSync(stateRoot, { recursive: true });
const stateDirectoryPrefix = "continuity-ops-unmigrated-d1-";
const statePrefix = join(stateRoot, stateDirectoryPrefix);
for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith(stateDirectoryPrefix)) continue;
  const stalePath = join(stateRoot, entry.name);
  rmSync(stalePath, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
const statePath = mkdtempSync(statePrefix);
const node = process.execPath;
let server;
let serverOutput = "";

assert.ok(existsSync(workerPath), "Build Continuity Ops before running the local failure-recovery check.");
const buildSha256 = createHash("sha256").update(readFileSync(workerPath)).digest("hex");

function safeOutput(value) {
  return String(value ?? "")
    .replaceAll(root, "<PROJECT_ROOT>")
    .replaceAll(root.replaceAll("\\", "/"), "<PROJECT_ROOT>")
    .replaceAll(statePath, "<ISOLATED_STATE>")
    .replaceAll(statePath.replaceAll("\\", "/"), "<ISOLATED_STATE>")
    .slice(-4000);
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      assert.ok(address && typeof address === "object");
      probe.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function startWorker(port) {
  serverOutput = "";
  const child = spawn(node, [
    "node_modules/wrangler/bin/wrangler.js",
    "dev",
    "--config",
    "dist/server/wrangler.json",
    "--local",
    "--persist-to",
    statePath,
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--show-interactive-dev-session=false",
    "--var",
    "CONTINUITY_OPS_ENVIRONMENT:development",
    "--var",
    "CONTINUITY_OPS_ORGANIZATION_NAME:Continuity Ops Failure Recovery",
    "--var",
    "CONTINUITY_OPS_ORGANIZATION_TIMEZONE:Asia/Taipei",
    "--var",
    "CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL:failure-recovery@example.invalid",
    "--var",
    "CONTINUITY_OPS_DEPLOYMENT_VERSION:local-failure-recovery-220",
    "--var",
    "CONTINUITY_OPS_CURSOR_HMAC_SECRET:failure-recovery-test-only-secret-000000000000",
    "--var",
    "CONTINUITY_OPS_LOCAL_OPERATOR_ID:failure-recovery-operator",
    "--var",
    "CONTINUITY_OPS_LOCAL_OPERATOR_NAME:Failure Recovery Operator",
    "--var",
    "CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL:failure-recovery@example.invalid",
    "--var",
    "CONTINUITY_OPS_LOCAL_OPERATOR_ROLE:admin",
  ], {
    cwd: root,
    env: { ...process.env, WRANGLER_LOG_PATH: resolve(statePath, "wrangler.log") },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-100_000); });
  child.stderr.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-100_000); });
  return child;
}

async function stopWorker() {
  const child = server;
  if (!child) return;
  server = undefined;
  if (child.exitCode !== null && child.stdout.destroyed && child.stderr.destroyed) return;

  await new Promise((resolveExit) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      resolveExit();
    };
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5_000);
    child.once("close", finish);
    child.once("error", finish);
    if (child.exitCode === null) child.kill("SIGTERM");
  });
}

function scheduleStateCleanup() {
  const cleanupProgram = [
    "const { basename } = require('node:path');",
    "const { rmSync } = require('node:fs');",
    "const target = process.argv[1];",
    "const prefix = process.argv[2];",
    `if (!target.startsWith(prefix) || !basename(target).startsWith(${JSON.stringify(stateDirectoryPrefix)})) process.exit(2);`,
    "setTimeout(() => {",
    "  try { rmSync(target, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 }); } catch { process.exitCode = 1; }",
    "}, 500);",
  ].join("\n");
  const cleanup = spawn(node, ["-e", cleanupProgram, statePath, statePrefix], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  cleanup.unref();
}

async function waitForResponse(url, acceptedStatuses, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error(`Worker exited early. ${safeOutput(serverOutput)}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const text = await response.text();
      if (acceptedStatuses.includes(response.status)) return { response, text };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}. ${safeOutput(serverOutput)}`);
}

function expectRequestId(response) {
  assert.match(response.headers.get("x-request-id") ?? "", /^req-[0-9a-f-]{36}$/iu);
}

const startedAt = performance.now();
let report;

try {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  server = startWorker(port);

  const failedHealth = await waitForResponse(`${baseUrl}/api/v1/health`, [503]);
  expectRequestId(failedHealth.response);
  assert.match(failedHealth.response.headers.get("content-type") ?? "", /^application\/problem\+json\b/iu);
  const failedProblem = JSON.parse(failedHealth.text);
  assert.equal(failedProblem.status, 503);
  assert.equal(failedProblem.code, "DATABASE_NOT_READY");
  assert.equal(failedProblem.requestId, failedHealth.response.headers.get("x-request-id"));
  await stopWorker();

  const migrationStartedAt = performance.now();
  const migration = spawnSync(node, [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--config",
    "wrangler.local.jsonc",
    "--persist-to",
    statePath,
  ], { cwd: root, env: { ...process.env, CI: "true" }, encoding: "utf8", windowsHide: true });
  assert.equal(migration.error, undefined, migration.error?.message);
  assert.equal(migration.status, 0, safeOutput(`${migration.stdout ?? ""}\n${migration.stderr ?? ""}`));
  const migrationDurationMs = Math.round(performance.now() - migrationStartedAt);

  server = startWorker(port);
  const recoveredHealth = await waitForResponse(`${baseUrl}/api/v1/health`, [200]);
  expectRequestId(recoveredHealth.response);
  const recoveredHealthBody = JSON.parse(recoveredHealth.text);
  assert.equal(recoveredHealthBody.data.status, "ok");
  assert.equal(recoveredHealthBody.data.database, "ok");

  const access = await waitForResponse(`${baseUrl}/api/v1/access`, [200]);
  expectRequestId(access.response);
  const accessBody = JSON.parse(access.text);
  assert.equal(accessBody.data.actor.role, "admin");

  const overview = await waitForResponse(`${baseUrl}/api/v1/overview`, [200]);
  expectRequestId(overview.response);
  const overviewBody = JSON.parse(overview.text);
  assert.ok(overviewBody.data && typeof overviewBody.data === "object");
  await stopWorker();

  report = {
    schemaVersion: "1.0",
    evidenceId: EVIDENCE_ID,
    product: PRODUCT_NAME,
    productVersion: PRODUCT_VERSION,
    generatedAt: new Date().toISOString(),
    evidenceStatus: "verified_local_controlled",
    verificationType: "unmigrated_database_failure_and_recovery",
    result: "passed_with_documented_limits",
    buildArtifact: { path: "dist/server/index.js", sha256: buildSha256 },
    environment: { runtime: process.version, platform: process.platform, database: "isolated synthetic local D1" },
    temporaryStateCleanup: "scheduled_after_runner_exit",
    failureObservation: {
      expectedStatus: 503,
      observedStatus: failedHealth.response.status,
      expectedProblemCode: "DATABASE_NOT_READY",
      observedProblemCode: failedProblem.code,
      requestIdPresent: true,
    },
    recovery: {
      action: "Apply migrations 0001 through 0004 to the same isolated state and restart the same Worker artifact.",
      migrationDurationMs,
      healthStatus: recoveredHealth.response.status,
      accessStatus: access.response.status,
      overviewStatus: overview.response.status,
      coreReadChecksPassed: 3,
    },
    totalDurationMs: Math.round(performance.now() - startedAt),
    limitations: [
      "This exercise verifies a local unmigrated-D1 failure and recovery; it does not simulate an in-flight network partition, partial remote D1 outage, or third-party service failure.",
      "The result is not a production RTO or RPO and does not verify Cloudflare D1 Time Travel, hosted permissions, concurrent writes, application rollback, or migration rollback.",
      "The browser error presentation and alert delivery were not exercised by this script.",
    ],
  };
} catch (error) {
  await stopWorker();
  report = {
    schemaVersion: "1.0",
    evidenceId: EVIDENCE_ID,
    product: PRODUCT_NAME,
    productVersion: PRODUCT_VERSION,
    generatedAt: new Date().toISOString(),
    evidenceStatus: "failed_local_controlled",
    verificationType: "unmigrated_database_failure_and_recovery",
    result: "failed",
    buildArtifact: { path: "dist/server/index.js", sha256: buildSha256 },
    failure: error instanceof Error ? error.message : String(error),
    workerOutputExcerpt: safeOutput(serverOutput),
    totalDurationMs: Math.round(performance.now() - startedAt),
  };
  mkdirSync(resolve("evidence"), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  throw error;
} finally {
  await stopWorker();
  assert.ok(
    statePath.startsWith(statePrefix) && basename(statePath).startsWith("continuity-ops-unmigrated-d1-"),
    "Refusing to remove an unexpected isolated D1 path.",
  );
  scheduleStateCleanup();
}

mkdirSync(resolve("evidence"), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, evidenceId: EVIDENCE_ID, output: outputPath, recovery: report.recovery }, null, 2));
