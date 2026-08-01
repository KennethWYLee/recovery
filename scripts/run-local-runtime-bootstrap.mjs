import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  OPERATIONS_BOOTSTRAP_GUARD_TABLE,
  OPERATIONS_BOOTSTRAP_STATE_TABLE,
  OPERATIONS_FINAL_SCHEMA_FINGERPRINT,
  canonicalizeOperationsSchemaSql,
} from "../db/operations-bootstrap-core.ts";

const PRODUCT_NAME = "Continuity Ops";
const PRODUCT_VERSION = "2.2.0";
const EVIDENCE_ID = "CO-VRF-RUNTIME-BOOTSTRAP-001";
const root = process.cwd();
const outputPath = resolve("evidence/continuity-ops-local-runtime-bootstrap.json");
const workerPath = resolve("dist/server/index.js");
const stateRoot = resolve(".wrangler");
const stateDirectoryPrefix = "continuity-ops-runtime-bootstrap-";
const statePrefix = join(stateRoot, stateDirectoryPrefix);
const authorizedEmail = "runtime-bootstrap@example.invalid";
const unauthorizedEmail = "not-bootstrap@example.invalid";
const schoolViewerEmail = "runtime-viewer@ntub.edu.tw";
const nonMemberEmail = "runtime-outsider@example.invalid";
const node = process.execPath;
let server;
let serverOutput = "";

mkdirSync(stateRoot, { recursive: true });
for (const entry of readdirSync(stateRoot, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith(stateDirectoryPrefix)) continue;
  const stalePath = join(stateRoot, entry.name);
  try {
    rmSync(stalePath, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    // A prior Windows workerd may still be releasing SQLite handles. Every run
    // uses a new random directory, so a locked stale directory is never reused.
  }
}
const statePath = mkdtempSync(statePrefix);

assert.ok(existsSync(workerPath), "Build Continuity Ops before running the runtime-bootstrap check.");
const buildSha256 = createHash("sha256").update(readFileSync(workerPath)).digest("hex");

function safeOutput(value) {
  return String(value ?? "")
    .replaceAll(root, "<PROJECT_ROOT>")
    .replaceAll(root.replaceAll("\\", "/"), "<PROJECT_ROOT>")
    .replaceAll(statePath, "<ISOLATED_STATE>")
    .replaceAll(statePath.replaceAll("\\", "/"), "<ISOLATED_STATE>")
    .slice(-10_000);
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

function startWorker(port, operatorEmail) {
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
    "CONTINUITY_OPS_ORGANIZATION_NAME:Continuity Ops Runtime Bootstrap",
    "--var",
    "CONTINUITY_OPS_ORGANIZATION_TIMEZONE:Asia/Taipei",
    "--var",
    `CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL:${authorizedEmail}`,
    "--var",
    "CONTINUITY_OPS_DEPLOYMENT_VERSION:local-runtime-bootstrap-220",
    "--var",
    "CONTINUITY_OPS_CURSOR_HMAC_SECRET:runtime-bootstrap-test-only-secret-000000000",
    "--var",
    `CONTINUITY_OPS_LOCAL_OPERATOR_ID:${operatorEmail === authorizedEmail ? "runtime-bootstrap-owner" : "runtime-bootstrap-outsider"}`,
    "--var",
    `CONTINUITY_OPS_LOCAL_OPERATOR_NAME:${operatorEmail === authorizedEmail ? "Runtime Bootstrap Owner" : "Runtime Bootstrap Outsider"}`,
    "--var",
    `CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL:${operatorEmail}`,
    "--var",
    "CONTINUITY_OPS_LOCAL_OPERATOR_ROLE:admin",
  ], {
    cwd: root,
    env: { ...process.env, WRANGLER_LOG_PATH: resolve(statePath, "wrangler.log") },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-250_000); });
  child.stderr.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-250_000); });
  return child;
}

function startForwardedIdentityWorker(port) {
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
    "CONTINUITY_OPS_ENVIRONMENT:production",
    "--var",
    "CONTINUITY_OPS_ORGANIZATION_NAME:Continuity Ops Runtime Bootstrap",
    "--var",
    "CONTINUITY_OPS_ORGANIZATION_TIMEZONE:Asia/Taipei",
    "--var",
    `CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL:${authorizedEmail}`,
    "--var",
    "CONTINUITY_OPS_DEPLOYMENT_VERSION:local-runtime-bootstrap-220",
    "--var",
    "CONTINUITY_OPS_CURSOR_HMAC_SECRET:runtime-bootstrap-test-only-secret-000000000",
  ], {
    cwd: root,
    env: { ...process.env, WRANGLER_LOG_PATH: resolve(statePath, "wrangler-forwarded.log") },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-250_000); });
  child.stderr.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-250_000); });
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
    if (child.exitCode === null) {
      if (process.platform === "win32" && child.pid) {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    }
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

async function request(url, acceptedStatuses, options = {}, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not started";
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error(`Worker exited early. ${safeOutput(serverOutput)}`);
    try {
      const response = await fetch(url, {
        ...options,
        cache: "no-store",
        signal: AbortSignal.timeout(3_000),
      });
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

function parseProblem(result, expectedCode, expectedStatus = 503) {
  assert.match(result.response.headers.get("content-type") ?? "", /^application\/problem\+json\b/iu);
  assert.match(result.response.headers.get("x-request-id") ?? "", /^req-[0-9a-f-]{36}$/iu);
  const problem = JSON.parse(result.text);
  assert.equal(problem.status, expectedStatus);
  assert.equal(problem.code, expectedCode);
  assert.equal(problem.requestId, result.response.headers.get("x-request-id"));
  return problem;
}

function forwardedIdentityHeaders(email, displayName) {
  return {
    "oai-authenticated-user-email": email,
    "oai-authenticated-user-full-name": encodeURIComponent(displayName),
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  };
}

function schemaFingerprint(rows) {
  const canonical = rows
    .map((row) => `${row.type}:${row.name}:${canonicalizeOperationsSchemaSql(row.sql)}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function d1Query(sql) {
  const result = spawnSync(node, [
    "node_modules/wrangler/bin/wrangler.js",
    "d1",
    "execute",
    "DB",
    "--local",
    "--config",
    "dist/server/wrangler.json",
    "--persist-to",
    statePath,
    "--command",
    sql,
    "--json",
  ], { cwd: root, env: { ...process.env, WRANGLER_LOG_PATH: resolve(statePath, "wrangler-query.log") }, encoding: "utf8", windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, safeOutput(`${result.stdout ?? ""}\n${result.stderr ?? ""}`));
  const payload = JSON.parse(result.stdout);
  const execution = Array.isArray(payload) ? payload[0] : payload;
  assert.equal(execution.success, true, "The isolated D1 verification query failed.");
  return execution.results ?? [];
}

function parseBootstrapEvents(output) {
  const events = [];
  for (const line of output.split(/\r?\n/u)) {
    const start = line.indexOf('{"event":"continuity_ops.schema_bootstrap"');
    if (start < 0) continue;
    try {
      events.push(JSON.parse(line.slice(start)));
    } catch {
      // Wrangler may append terminal decoration; the durable D1 state remains authoritative.
    }
  }
  return events;
}

const startedAt = performance.now();
let report;

try {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  server = startWorker(port, unauthorizedEmail);
  const unavailableHealth = await request(`${baseUrl}/api/v1/health`, [503]);
  parseProblem(unavailableHealth, "DATABASE_NOT_READY");
  const unauthorized = await request(`${baseUrl}/api/v1/access`, [503]);
  parseProblem(unauthorized, "DATABASE_NOT_READY");
  await stopWorker();

  server = startWorker(port, authorizedEmail);
  const phase1 = await request(`${baseUrl}/api/v1/access`, [503]);
  parseProblem(phase1, "DATABASE_INITIALIZING");
  assert.equal(phase1.response.headers.get("retry-after"), "1");
  const phase2 = await request(`${baseUrl}/api/v1/access`, [503]);
  parseProblem(phase2, "DATABASE_INITIALIZING");
  assert.equal(phase2.response.headers.get("retry-after"), "1");
  const phase3 = await request(`${baseUrl}/api/v1/access`, [200]);
  const accessBody = JSON.parse(phase3.text);
  assert.equal(accessBody.data.actor.role, "admin");

  const health = await request(`${baseUrl}/api/v1/health`, [200]);
  const healthBody = JSON.parse(health.text);
  assert.equal(healthBody.data.status, "ok");
  assert.equal(healthBody.data.database, "ok");
  const overview = await request(`${baseUrl}/api/v1/overview`, [200]);
  assert.ok(JSON.parse(overview.text).data);

  const bootstrapEvents = parseBootstrapEvents(serverOutput)
    .filter((event) => [1, 2, 3].includes(event.phase) && event.queryCount > 0);
  assert.deepEqual(bootstrapEvents.map((event) => event.status), ["initializing", "initializing", "ready"]);
  assert.deepEqual(bootstrapEvents.map((event) => event.phase), [1, 2, 3]);
  assert.ok(bootstrapEvents.every((event) => Number.isInteger(event.queryCount) && event.queryCount < 40));
  assert.ok(bootstrapEvents.every((event) => /^[a-f0-9]{64}$/u.test(event.planDigest)));
  await stopWorker();

  server = startForwardedIdentityWorker(port);
  const schoolHeaders = forwardedIdentityHeaders(schoolViewerEmail, "Runtime School Viewer");
  const schoolAccessOptions = { headers: schoolHeaders };
  const [schoolAccessFirst, schoolAccessSecond] = await Promise.all([
    request(`${baseUrl}/api/v1/access`, [200], schoolAccessOptions),
    request(`${baseUrl}/api/v1/access`, [200], schoolAccessOptions),
  ]);
  const schoolAccessBodies = [schoolAccessFirst, schoolAccessSecond].map((result) => JSON.parse(result.text).data);
  const schoolRole = schoolAccessBodies[0].actor.role;
  const schoolDisplayName = schoolAccessBodies[0].actor.displayName;
  assert.ok(["observer", "auditor"].includes(schoolRole));
  assert.equal(schoolAccessBodies[1].actor.role, schoolRole);
  assert.equal(schoolAccessBodies[1].actor.displayName, schoolDisplayName);
  assert.match(schoolDisplayName, /^校內訪客 [A-Z0-9]{4}-[A-Z0-9]{4}$/u);
  assert.deepEqual(
    schoolAccessBodies[0].permissions,
    ["access:read", "service:read", "incident:read", "audit:read"],
  );
  assert.ok(schoolAccessBodies[0].policies.some((policy) => policy.id === "ntub-role-selection" && policy.status === "enforced"));

  const forwardedAdmin = await request(`${baseUrl}/api/v1/access`, [200], {
    headers: forwardedIdentityHeaders(authorizedEmail, "Runtime Bootstrap Owner"),
  });
  assert.equal(JSON.parse(forwardedAdmin.text).data.actor.role, "admin");
  const adminRoleSession = await request(`${baseUrl}/api/v1/session/role`, [200], {
    headers: forwardedIdentityHeaders(authorizedEmail, "Runtime Bootstrap Owner"),
  });
  const adminRoleSessionBody = JSON.parse(adminRoleSession.text).data;
  assert.equal(adminRoleSessionBody.managedRole, true);
  assert.equal(adminRoleSessionBody.selectionRequired, false);
  assert.equal(adminRoleSessionBody.currentRole, "admin");
  assert.deepEqual(adminRoleSessionBody.options, []);
  const adminRoleMutation = await request(`${baseUrl}/api/v1/session/role`, [403], {
    method: "POST",
    headers: {
      ...forwardedIdentityHeaders(authorizedEmail, "Runtime Bootstrap Owner"),
      "content-type": "application/json",
      "idempotency-key": "runtime-admin-role-change",
      origin: baseUrl,
    },
    body: JSON.stringify({ role: "observer", expectedVersion: adminRoleSessionBody.membershipVersion }),
  });
  parseProblem(adminRoleMutation, "SCHOOL_ROLE_SELECTION_NOT_AVAILABLE", 403);

  const nonMember = await request(`${baseUrl}/api/v1/access`, [403], {
    headers: forwardedIdentityHeaders(nonMemberEmail, "Runtime Outsider"),
  });
  parseProblem(nonMember, "ACTIVE_MEMBERSHIP_REQUIRED", 403);

  const schoolReadPaths = ["access", "overview", "incidents", "services", "audit"];
  const schoolReadResults = [];
  for (const path of schoolReadPaths) {
    schoolReadResults.push(await request(`${baseUrl}/api/v1/${path}`, [200], schoolAccessOptions));
  }
  const schoolAuditBody = JSON.parse(schoolReadResults.at(-1).text).data;
  assert.ok(schoolAuditBody.events.some((event) => event.action === "access.member.auto_provision"));
  assert.ok(schoolAuditBody.events.every((event) => !("actorEmail" in event)));

  const memberDirectory = await request(`${baseUrl}/api/v1/access/members`, [403], schoolAccessOptions);
  parseProblem(memberDirectory, "PERMISSION_DENIED", 403);

  const schoolMutationCases = [
    { method: "POST", path: "services", key: "runtime-readonly-post", body: { name: "Blocked" } },
    { method: "PUT", path: "incidents/inc-runtime/review", key: "runtime-readonly-put", body: { status: "draft" } },
    { method: "PATCH", path: "incidents/inc-runtime", key: "runtime-readonly-patch", body: { title: "Blocked" } },
    { method: "DELETE", path: "incidents/inc-runtime/assignments/assign-runtime", key: "runtime-readonly-delete", body: {} },
  ];
  const schoolMutationStatuses = [];
  for (const mutation of schoolMutationCases) {
    const result = await request(`${baseUrl}/api/v1/${mutation.path}`, [403], {
      method: mutation.method,
      headers: {
        ...schoolHeaders,
        "content-type": "application/json",
        "idempotency-key": mutation.key,
        origin: baseUrl,
      },
      body: JSON.stringify(mutation.body),
    });
    parseProblem(result, "READ_ONLY_ACCESS", 403);
    schoolMutationStatuses.push(result.response.status);
  }

  const schoolRoleSession = await request(`${baseUrl}/api/v1/session/role`, [200], schoolAccessOptions);
  const schoolRoleSessionBody = JSON.parse(schoolRoleSession.text).data;
  assert.equal(schoolRoleSessionBody.selectionRequired, true);
  assert.equal(schoolRoleSessionBody.managedRole, false);
  assert.equal(schoolRoleSessionBody.currentRole, schoolRole);
  assert.deepEqual(
    schoolRoleSessionBody.options.map((option) => option.role),
    ["commander", "responder", "observer", "auditor"],
  );
  assert.ok(schoolRoleSessionBody.options.every((option) => option.available));
  assert.ok(!schoolRoleSessionBody.options.some((option) => option.role === "admin"));

  const rejectedAdminSelection = await request(`${baseUrl}/api/v1/session/role`, [400], {
    method: "POST",
    headers: {
      ...schoolHeaders,
      "content-type": "application/json",
      "idempotency-key": "runtime-school-admin-role",
      origin: baseUrl,
    },
    body: JSON.stringify({ role: "admin", expectedVersion: schoolRoleSessionBody.membershipVersion }),
  });
  parseProblem(rejectedAdminSelection, "INVALID_ROLE_SELECTION", 400);

  const commanderSelection = await request(`${baseUrl}/api/v1/session/role`, [200], {
    method: "POST",
    headers: {
      ...schoolHeaders,
      "content-type": "application/json",
      "idempotency-key": "runtime-school-role-commander",
      origin: baseUrl,
    },
    body: JSON.stringify({ role: "commander", expectedVersion: schoolRoleSessionBody.membershipVersion }),
  });
  const commanderSelectionBody = JSON.parse(commanderSelection.text).data;
  assert.equal(commanderSelectionBody.selectedRole, "commander");
  const commanderAccess = await request(`${baseUrl}/api/v1/access`, [200], schoolAccessOptions);
  const commanderAccessBody = JSON.parse(commanderAccess.text).data;
  assert.equal(commanderAccessBody.actor.role, "commander");
  assert.ok(commanderAccessBody.permissions.includes("incident:command"));

  const refreshedRoleSession = await request(`${baseUrl}/api/v1/session/role`, [200], schoolAccessOptions);
  const refreshedRoleSessionBody = JSON.parse(refreshedRoleSession.text).data;
  assert.equal(refreshedRoleSessionBody.currentRole, "commander");
  assert.equal(refreshedRoleSessionBody.membershipVersion, commanderSelectionBody.membershipVersion);
  const observerSelection = await request(`${baseUrl}/api/v1/session/role`, [200], {
    method: "POST",
    headers: {
      ...schoolHeaders,
      "content-type": "application/json",
      "idempotency-key": "runtime-school-role-observer",
      origin: baseUrl,
    },
    body: JSON.stringify({ role: "observer", expectedVersion: refreshedRoleSessionBody.membershipVersion }),
  });
  const observerSelectionBody = JSON.parse(observerSelection.text).data;
  assert.equal(observerSelectionBody.selectedRole, "observer");
  const observerAccess = await request(`${baseUrl}/api/v1/access`, [200], schoolAccessOptions);
  assert.equal(JSON.parse(observerAccess.text).data.actor.role, "observer");
  await stopWorker();

  const [schoolMembership] = d1Query(
    `SELECT u.id AS user_id, u.display_name, m.id AS membership_id, m.role, m.status
     FROM ops_users u JOIN ops_memberships m ON m.user_id = u.id
     WHERE u.email = '${schoolViewerEmail}' AND m.organization_id = 'ops-singleton'`,
  );
  assert.ok(schoolMembership);
  assert.equal(schoolMembership.role, "observer");
  assert.equal(schoolMembership.status, "active");
  assert.equal(schoolMembership.display_name, schoolDisplayName);
  assert.equal(d1Query(`SELECT COUNT(*) AS count FROM ops_users WHERE email = '${schoolViewerEmail}'`)[0].count, 1);
  assert.equal(d1Query(`SELECT COUNT(*) AS count FROM ops_memberships WHERE user_id = '${schoolMembership.user_id}'`)[0].count, 1);
  const schoolAutoProvisionAuditCount = d1Query(
    `SELECT COUNT(*) AS count FROM ops_audit_events
     WHERE actor_user_id = '${schoolMembership.user_id}' AND action = 'access.member.auto_provision'`,
  )[0].count;
  assert.equal(schoolAutoProvisionAuditCount, 1);

  d1Query(
    `UPDATE ops_memberships SET status = 'suspended', version = version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = '${schoolMembership.membership_id}'`,
  );
  server = startForwardedIdentityWorker(port);
  const suspendedSchoolAccess = await request(`${baseUrl}/api/v1/access`, [403], schoolAccessOptions);
  parseProblem(suspendedSchoolAccess, "ACTIVE_MEMBERSHIP_REQUIRED", 403);
  await stopWorker();

  let state;
  let inventory;
  let fingerprint;
  [state] = d1Query(
    `SELECT schema_version, schema_digest, phase, status, completed_at
     FROM ${OPERATIONS_BOOTSTRAP_STATE_TABLE} WHERE singleton = 1`,
  );
  assert.equal(state.schema_version, "0004");
  assert.match(state.schema_digest, /^[a-f0-9]{64}$/u);
  assert.equal(state.phase, 3);
  assert.equal(state.status, "ready");
  assert.ok(state.completed_at);
  assert.equal(d1Query(`SELECT COUNT(*) AS count FROM ${OPERATIONS_BOOTSTRAP_GUARD_TABLE}`)[0].count, 0);

  const rows = d1Query(
    `SELECT type, name, sql FROM sqlite_schema
     WHERE type IN ('table', 'index', 'trigger') AND name LIKE 'ops_%'
       AND name NOT IN ('${OPERATIONS_BOOTSTRAP_STATE_TABLE}', '${OPERATIONS_BOOTSTRAP_GUARD_TABLE}') AND sql IS NOT NULL
     ORDER BY type, name`,
  );
  inventory = {
    tables: rows.filter((row) => row.type === "table").length,
    indexes: rows.filter((row) => row.type === "index").length,
    triggers: rows.filter((row) => row.type === "trigger").length,
  };
  assert.deepEqual(inventory, { tables: 14, indexes: 20, triggers: 46 });
  fingerprint = schemaFingerprint(rows);
  assert.equal(fingerprint, OPERATIONS_FINAL_SCHEMA_FINGERPRINT);
  assert.deepEqual(d1Query("PRAGMA foreign_key_check"), []);
  assert.equal(d1Query("SELECT COUNT(*) AS count FROM ops_organizations WHERE id = 'ops-singleton'")[0].count, 1);
  assert.equal(d1Query("SELECT COUNT(*) AS count FROM ops_memberships WHERE role = 'admin' AND status = 'active'")[0].count, 1);
  assert.equal(d1Query("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'")[0].count, 0);

  report = {
    schemaVersion: "1.0",
    evidenceId: EVIDENCE_ID,
    product: PRODUCT_NAME,
    productVersion: PRODUCT_VERSION,
    generatedAt: new Date().toISOString(),
    evidenceStatus: "verified_local_controlled",
    verificationType: "authenticated_fresh_d1_runtime_bootstrap_and_domain_role_selection",
    result: "passed_with_documented_limits",
    buildArtifact: { path: "dist/server/index.js", sha256: buildSha256 },
    environment: { runtime: process.version, platform: process.platform, database: "isolated synthetic local D1" },
    unauthorizedIdentity: {
      healthStatus: unavailableHealth.response.status,
      accessStatus: unauthorized.response.status,
      problemCode: "DATABASE_NOT_READY",
      schemaMutationAllowed: false,
    },
    phases: bootstrapEvents.map((event) => ({
      phase: event.phase,
      status: event.status,
      queryCount: event.queryCount,
      planDigest: event.planDigest,
    })),
    finalState: {
      schemaVersion: state.schema_version,
      phase: state.phase,
      status: state.status,
      schemaDigest: state.schema_digest,
      inventory,
      fingerprint,
      foreignKeyViolations: 0,
      activeAdministratorCount: 1,
      wranglerMigrationTablePresent: false,
    },
    readyChecks: {
      accessStatus: phase3.response.status,
      healthStatus: health.response.status,
      overviewStatus: overview.response.status,
      checksPassed: 3,
    },
    schoolRoleSelection: {
      exactEmailDomain: "ntub.edu.tw",
      initialProvisioningRole: schoolRole,
      selectableRoles: ["commander", "responder", "observer", "auditor"],
      administratorSelectable: false,
      selectedRolesVerified: ["commander", "observer"],
      serverPermissionChangedWithSelection: true,
      administratorRoleManaged: true,
      randomizedDisplayNameFormat: "校內訪客 XXXX-XXXX",
      concurrentFirstAccessResponses: schoolAccessBodies.length,
      uniqueUserCount: 1,
      uniqueMembershipCount: 1,
      autoProvisionAuditCount: schoolAutoProvisionAuditCount,
      readableApiModules: schoolReadPaths,
      readChecksPassed: schoolReadResults.length,
      stateChangingMethodsRejected: schoolMutationCases.map((item, index) => ({
        method: item.method,
        status: schoolMutationStatuses[index],
        problemCode: "READ_ONLY_ACCESS",
      })),
      memberDirectoryStatus: memberDirectory.response.status,
      auditActorEmailRedacted: true,
      existingAdministratorRolePreserved: true,
      administratorSelectionAttemptStatus: adminRoleMutation.response.status,
      schoolAdministratorSelectionAttemptStatus: rejectedAdminSelection.response.status,
      nonMemberOtherDomainStatus: nonMember.response.status,
      suspendedMembershipStatus: suspendedSchoolAccess.response.status,
    },
    totalDurationMs: Math.round(performance.now() - startedAt),
    temporaryStateCleanup: "scheduled_after_runner_exit",
    limitations: [
      "This is a local Wrangler and synthetic D1 exercise; it is not evidence that Sites production identity forwarding or hosted D1 initialization succeeded.",
      "The exercise covers one configured administrator, one exact-domain school member selecting two roles, one other-domain non-member, and one suspended school membership; it is not a complete identity-provider or access-policy audit.",
      "Forwarded identity headers are supplied directly to the local Worker. This does not prove that the hosted edge strips spoofed headers or forwards only verified identities.",
      "The per-request query counts cover bootstrap statements only; Cloudflare plan enforcement and production capacity were not measured.",
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
    verificationType: "authenticated_fresh_d1_runtime_bootstrap_and_domain_role_selection",
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
    statePath.startsWith(statePrefix) && basename(statePath).startsWith(stateDirectoryPrefix),
    "Refusing to remove an unexpected isolated D1 path.",
  );
  scheduleStateCleanup();
}

mkdirSync(resolve("evidence"), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  evidenceId: EVIDENCE_ID,
  output: outputPath,
  phases: report.phases.map(({ phase, status, queryCount }) => ({ phase, status, queryCount })),
  finalState: report.finalState,
}, null, 2));
