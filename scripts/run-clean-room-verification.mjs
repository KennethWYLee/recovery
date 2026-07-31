import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const PRODUCT_NAME = "Continuity Ops";
const PRODUCT_VERSION = "2.2.0";
const EVIDENCE_ID = "CO-VRF-CLEAN-ROOM-001";
const projectRoot = process.cwd();
const outputPath = resolve(projectRoot, "evidence/continuity-ops-clean-room-verification.json");
const sourceInputs = [
  ".dev.vars.example",
  ".env.example",
  ".github",
  ".gitignore",
  ".openai",
  "PROJECT.md",
  "README.md",
  "cloudflare-env.d.ts",
  "eslint.config.mjs",
  "features",
  "next.config.ts",
  "package.json",
  "package-lock.json",
  "postcss.config.mjs",
  "tsconfig.json",
  "vite.config.ts",
  "wrangler.local.jsonc",
  "app",
  "build",
  "db",
  "docs",
  "lib",
  "public",
  "scripts",
  "tests",
  "worker",
];
const temporaryPrefix = join(tmpdir(), "continuity-ops-clean-room-");
const cleanRoot = mkdtempSync(temporaryPrefix);
const node = process.execPath;
const npmCli = process.env.npm_execpath;
const commandResults = [];
let server;
const serverStdoutPath = resolve(cleanRoot, ".wrangler/clean-room-worker.stdout.log");
const serverStderrPath = resolve(cleanRoot, ".wrangler/clean-room-worker.stderr.log");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function collectFiles(path) {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => collectFiles(join(path, entry.name)));
}

function snapshotDigest(root, inputs) {
  const records = inputs.flatMap((entry) => collectFiles(resolve(root, entry)))
    .sort((left, right) => relative(root, left).localeCompare(relative(root, right)))
    .map((path) => `${relative(root, path).replaceAll("\\", "/")}:${sha256File(path)}`);
  return { fileCount: records.length, sha256: sha256(records.join("\n")) };
}

function sanitizeOutput(value) {
  return String(value ?? "")
    .replaceAll(projectRoot, "<PROJECT_ROOT>")
    .replaceAll(projectRoot.replaceAll("\\", "/"), "<PROJECT_ROOT>")
    .replaceAll(cleanRoot, "<CLEAN_ROOM>")
    .replaceAll(cleanRoot.replaceAll("\\", "/"), "<CLEAN_ROOM>")
    .slice(-4000);
}

function currentServerOutput() {
  return [serverStdoutPath, serverStderrPath]
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
}

function run(label, executable, args, environment) {
  const startedAt = performance.now();
  const result = spawnSync(executable, args, {
    cwd: cleanRoot,
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
  const durationMs = Math.round(performance.now() - startedAt);
  const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  commandResults.push({ label, exitCode: result.status, durationMs });
  assert.equal(result.error, undefined, `${label} could not start: ${result.error?.message ?? "unknown error"}`);
  assert.equal(result.status, 0, `${label} failed.\n${sanitizeOutput(combinedOutput)}`);
}

function runNpm(label, args, environment) {
  if (npmCli && existsSync(npmCli)) {
    run(label, node, [npmCli, ...args], environment);
    return;
  }
  run(label, "npm", args, environment);
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      assert.ok(address && typeof address === "object");
      const { port } = address;
      probe.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) {
      throw new Error(`Clean-room Worker exited early. ${sanitizeOutput(currentServerOutput())}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.status === 200) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Clean-room Worker did not become healthy: ${lastError}. ${sanitizeOutput(currentServerOutput())}`);
}

async function stopServer() {
  const child = server;
  if (!child) return;
  server = undefined;
  if (child.exitCode !== null) return;
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
    child.kill("SIGTERM");
  });
}

const startedAt = performance.now();
let report;

try {
  for (const entry of sourceInputs) {
    const source = resolve(projectRoot, entry);
    assert.ok(existsSync(source), `Required clean-room input is missing: ${entry}`);
    const destination = resolve(cleanRoot, entry);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    cpSync(source, destination, { recursive: true, errorOnExist: true });
  }

  const sourceSnapshot = snapshotDigest(projectRoot, sourceInputs);
  const copiedSnapshot = snapshotDigest(cleanRoot, sourceInputs);
  assert.deepEqual(copiedSnapshot, sourceSnapshot, "The clean-room copy differs from the selected source snapshot.");

  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    CI: "true",
    CONTINUITY_OPS_ENVIRONMENT: "development",
    CONTINUITY_OPS_ORGANIZATION_NAME: "Continuity Ops Clean Room",
    CONTINUITY_OPS_ORGANIZATION_TIMEZONE: "Asia/Taipei",
    CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL: "clean-room-operator@example.invalid",
    CONTINUITY_OPS_DEPLOYMENT_VERSION: "local-clean-room-220",
    CONTINUITY_OPS_CURSOR_HMAC_SECRET: "clean-room-test-only-cursor-secret-000000000000",
    CONTINUITY_OPS_LOCAL_OPERATOR_ID: "clean-room-operator",
    CONTINUITY_OPS_LOCAL_OPERATOR_NAME: "Clean Room Operator",
    CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL: "clean-room-operator@example.invalid",
    CONTINUITY_OPS_LOCAL_OPERATOR_ROLE: "admin",
    WRANGLER_LOG_PATH: resolve(cleanRoot, ".wrangler/wrangler.log"),
  };

  run("temporary Git inventory initialization", "git", ["init", "--quiet"], environment);
  run("temporary Git source inventory", "git", ["add", "--all"], environment);
  runNpm("locked dependency installation", ["ci", "--no-audit", "--fund=false"], environment);
  runNpm("production dependency audit", ["run", "audit:production"], environment);
  runNpm("supply-chain gate", ["run", "gate:supply-chain"], environment);
  runNpm("static gate", ["run", "gate:static"], environment);
  runNpm("unit tests", ["run", "test:unit"], environment);
  runNpm("quality metrics", ["run", "test:quality"], environment);
  runNpm("migration tests", ["run", "test:migration"], environment);
  runNpm("fault injection", ["run", "test:fault-injection"], environment);
  run(
    "operational evidence tool tests",
    node,
    ["--test", "tests/request-telemetry-analysis.test.mjs", "tests/d1-restore-drill.test.mjs"],
    environment,
  );
  runNpm(
    "executable Gherkin acceptance",
    ["run", "test:gherkin"],
    environment,
  );
  runNpm(
    "Gherkin fault injection",
    ["run", "test:gherkin:fault-injection"],
    environment,
  );
  runNpm("production build", ["run", "build"], environment);
  runNpm("build integration", ["run", "test:integration"], environment);
  runNpm("fresh hosted-schema runtime bootstrap", ["run", "test:runtime-bootstrap:local"], environment);
  runNpm("fresh local D1 migrations", ["run", "db:migrate:local"], environment);

  const artifactPath = resolve(cleanRoot, "dist/server/index.js");
  assert.ok(existsSync(artifactPath), "The clean-room Worker artifact is missing.");
  const artifactSha256 = sha256File(artifactPath);

  mkdirSync(resolve(cleanRoot, ".wrangler"), { recursive: true });
  const serverStdout = openSync(serverStdoutPath, "a");
  const serverStderr = openSync(serverStderrPath, "a");
  server = spawn(node, [
    resolve(cleanRoot, "node_modules/wrangler/bin/wrangler.js"),
    "dev",
    "--config",
    "dist/server/wrangler.json",
    "--local",
    "--persist-to",
    ".wrangler/state",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--show-interactive-dev-session=false",
    "--var",
    `CONTINUITY_OPS_ENVIRONMENT:${environment.CONTINUITY_OPS_ENVIRONMENT}`,
    "--var",
    `CONTINUITY_OPS_ORGANIZATION_NAME:${environment.CONTINUITY_OPS_ORGANIZATION_NAME}`,
    "--var",
    `CONTINUITY_OPS_ORGANIZATION_TIMEZONE:${environment.CONTINUITY_OPS_ORGANIZATION_TIMEZONE}`,
    "--var",
    `CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL:${environment.CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL}`,
    "--var",
    `CONTINUITY_OPS_DEPLOYMENT_VERSION:${environment.CONTINUITY_OPS_DEPLOYMENT_VERSION}`,
    "--var",
    `CONTINUITY_OPS_CURSOR_HMAC_SECRET:${environment.CONTINUITY_OPS_CURSOR_HMAC_SECRET}`,
    "--var",
    `CONTINUITY_OPS_LOCAL_OPERATOR_ID:${environment.CONTINUITY_OPS_LOCAL_OPERATOR_ID}`,
    "--var",
    `CONTINUITY_OPS_LOCAL_OPERATOR_NAME:${environment.CONTINUITY_OPS_LOCAL_OPERATOR_NAME}`,
    "--var",
    `CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL:${environment.CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL}`,
    "--var",
    `CONTINUITY_OPS_LOCAL_OPERATOR_ROLE:${environment.CONTINUITY_OPS_LOCAL_OPERATOR_ROLE}`,
  ], {
    cwd: cleanRoot,
    env: environment,
    stdio: ["ignore", serverStdout, serverStderr],
    windowsHide: true,
  });
  closeSync(serverStdout);
  closeSync(serverStderr);
  await waitForHealth(baseUrl);

  run(
    "clean-room API smoke",
    node,
    ["scripts/api-smoke.mjs"],
    { ...environment, CONTINUITY_OPS_BASE_URL: baseUrl },
  );
  const apiEvidence = JSON.parse(readFileSync(resolve(cleanRoot, "evidence/continuity-ops-api-smoke.json"), "utf8"));
  assert.equal(apiEvidence.result, "passed");
  assert.equal(apiEvidence.buildArtifact?.sha256, artifactSha256);

  await stopServer();
  report = {
    schemaVersion: "1.0",
    evidenceId: EVIDENCE_ID,
    product: PRODUCT_NAME,
    productVersion: PRODUCT_VERSION,
    generatedAt: new Date().toISOString(),
    evidenceStatus: "verified_local_controlled",
    verificationType: "isolated_snapshot_install_build_migrate_and_smoke",
    result: "passed_with_documented_limits",
    sourceSnapshot,
    cleanRoom: {
      copiedFileCount: copiedSnapshot.fileCount,
      copiedSnapshotSha256: copiedSnapshot.sha256,
      dependencyInstall: "npm ci",
      node: process.version,
      platform: process.platform,
      temporaryDirectoryRetained: false,
    },
    buildArtifact: {
      path: "dist/server/index.js",
      sha256: artifactSha256,
    },
    commands: commandResults,
    apiSmoke: {
      evidenceId: apiEvidence.evidenceId,
      result: apiEvidence.result,
      checkSummary: apiEvidence.checkSummary,
      buildArtifactSha256: apiEvidence.buildArtifact?.sha256,
    },
    totalDurationMs: Math.round(performance.now() - startedAt),
    limitations: [
      "The clean room used a copied snapshot of the current uncommitted working tree; this is not a clean Git checkout, CI run, or commit-bound release.",
      "The isolated build may have a different digest because vinext generates nondeterministic build inputs; this run verifies behavior and traceability, not bit-for-bit reproducibility.",
      "The run used a local synthetic D1 database and local identity variables; it does not verify staging, production, hosted identity, external services, or external users.",
      "The test executor is automated and internal; this is not independent human QA or third-party verification.",
    ],
  };
} catch (error) {
  await stopServer();
  report = {
    schemaVersion: "1.0",
    evidenceId: EVIDENCE_ID,
    product: PRODUCT_NAME,
    productVersion: PRODUCT_VERSION,
    generatedAt: new Date().toISOString(),
    evidenceStatus: "failed_local_controlled",
    verificationType: "isolated_snapshot_install_build_migrate_and_smoke",
    result: "failed",
    commands: commandResults,
    failure: error instanceof Error ? error.message : String(error),
    workerOutputExcerpt: sanitizeOutput(currentServerOutput()),
    totalDurationMs: Math.round(performance.now() - startedAt),
  };
  mkdirSync(resolve(projectRoot, "evidence"), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  throw error;
} finally {
  await stopServer();
  assert.ok(
    cleanRoot.startsWith(temporaryPrefix) && basename(cleanRoot).startsWith("continuity-ops-clean-room-"),
    "Refusing to remove an unexpected clean-room path.",
  );
  rmSync(cleanRoot, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
}

mkdirSync(resolve(projectRoot, "evidence"), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  evidenceId: EVIDENCE_ID,
  output: outputPath,
  sourceFiles: report.sourceSnapshot.fileCount,
  apiChecks: report.apiSmoke.checkSummary,
  totalDurationMs: report.totalDurationMs,
}, null, 2));
