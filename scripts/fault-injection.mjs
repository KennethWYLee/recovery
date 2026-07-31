import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PRODUCT_NAME = "Continuity Ops";
const PRODUCT_VERSION = "2.2.0";
const EVIDENCE_ID = "CO-VRF-FAULT-001";
const root = process.cwd();
const node = process.execPath;
const evidencePath = resolve(root, "evidence/continuity-ops-fault-injection.json");
const sourcePaths = [
  "lib/operations-domain.ts",
  "lib/operations-auth.ts",
  "lib/operations-input.ts",
  "lib/operations-time.ts",
  "lib/service-lifecycle-cursor.ts",
];
const testPaths = [
  "tests/operations-domain.test.ts",
  "tests/operations-authorization.test.ts",
  "tests/operations-input.test.ts",
  "tests/operations-time.test.ts",
  "tests/service-lifecycle-cursor.test.ts",
];
const baselineArgs = ["--experimental-strip-types", "--test", ...testPaths];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function commandOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function sanitizedOutput(value, temporaryDirectory) {
  return value
    .replaceAll(root, "<PROJECT_ROOT>")
    .replaceAll(root.replaceAll("\\", "/"), "<PROJECT_ROOT>")
    .replaceAll(temporaryDirectory, "<TEMP_DIR>")
    .replaceAll(temporaryDirectory.replaceAll("\\", "/"), "<TEMP_DIR>")
    .slice(0, 3000);
}

function occurrences(value, search) {
  return value.split(search).length - 1;
}

const sources = new Map(sourcePaths.map((path) => {
  const content = readFileSync(resolve(root, path), "utf8");
  return [path, { content, sha256Before: sha256(content) }];
}));
const baseline = spawnSync(node, baselineArgs, { cwd: root, encoding: "utf8" });
assert.equal(
  baseline.status,
  0,
  `The five baseline unit suites must pass before fault injection.\n${commandOutput(baseline)}`,
);

const mutants = [
  {
    id: "resolved-transition-authorization",
    source: "lib/operations-domain.ts",
    target: "incident transition authorization",
    original: 'if (["resolved", "closed"].includes(from) || ["resolved", "closed", "cancelled"].includes(to)) {',
    replacement: 'if (["resolved", "closed"].includes(from) || ["closed", "cancelled"].includes(to)) {',
    change: "Allow a responder assigned to an incident to move monitoring directly to resolved.",
    expectedFailure: /incident transitions require both an organization role and an incident assignment/,
  },
  {
    id: "observer-assignment-escalation",
    source: "lib/operations-domain.ts",
    target: "organization and incident role compatibility",
    original: '  observer: ["observer"],',
    replacement: '  observer: ["observer", "responder"],',
    change: "Allow an organization observer to hold a responder incident assignment.",
    expectedFailure: /organization roles can hold only compatible incident responsibilities/,
  },
  {
    id: "http-evidence-accepted",
    source: "lib/operations-domain.ts",
    target: "durable task evidence URL",
    original: '    return url.protocol === "https:"',
    replacement: '    return ["https:", "http:"].includes(url.protocol)',
    change: "Accept an insecure HTTP URL as completion evidence.",
    expectedFailure: /completed tasks require an HTTPS evidence reference/,
  },
  {
    id: "cancelled-incident-shown-as-open",
    source: "lib/operations-domain.ts",
    target: "open incident filtering",
    original: '  if (filter === "open") return status !== "closed" && status !== "cancelled";',
    replacement: '  if (filter === "open") return status !== "closed";',
    change: "Treat a cancelled incident as open.",
    expectedFailure: /incident filters and service lifecycle agree with new-incident eligibility/,
  },
  {
    id: "deprecated-service-accepts-incidents",
    source: "lib/operations-domain.ts",
    target: "service lifecycle eligibility",
    original: '  return status === "active";',
    replacement: "  return true;",
    change: "Allow a deprecated service to accept a new incident.",
    expectedFailure: /incident filters and service lifecycle agree with new-incident eligibility/,
  },
  {
    id: "local-identity-crosses-host-boundary",
    source: "lib/operations-auth.ts",
    target: "local development identity boundary",
    original: "  if (development && localRequest) {",
    replacement: "  if (development) {",
    change: "Allow local environment identity configuration on a non-local host.",
    expectedFailure: /localhost identity is accepted only from explicit environment configuration/,
  },
  {
    id: "any-verified-identity-bootstraps-admin",
    source: "lib/operations-auth.ts",
    target: "bootstrap administrator identity matching",
    original: '  return bootstrapEmail && bootstrapEmail === normalizeEmail(identity.email) ? "admin" : null;',
    replacement: '  return bootstrapEmail ? "admin" : null;',
    change: "Grant administrator provisioning to any verified identity when a bootstrap email exists.",
    expectedFailure: /verified identity alone does not authorize account provisioning/,
  },
  {
    id: "cross-origin-mutation-accepted",
    source: "lib/operations-auth.ts",
    target: "same-origin mutation protection",
    original: "    return new URL(origin).origin === new URL(request.url).origin;",
    replacement: "    return Boolean(new URL(origin).origin && new URL(request.url).origin);",
    change: "Accept a mutation whenever both request and Origin headers contain syntactically valid origins.",
    expectedFailure: /state-changing browser requests must be same-origin/,
  },
  {
    id: "read-request-recorded-as-trusted-mutation",
    source: "lib/operations-auth.ts",
    target: "rejected mutation audit method boundary",
    original: '  if (!["POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) return null;',
    replacement: '  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(normalizedMethod)) return null;',
    change: "Treat a GET rejection as an auditable state-changing request.",
    expectedFailure: /only verified-member mutation failures are eligible for payload-free security audit/,
  },
  {
    id: "declared-body-limit-reversed",
    source: "lib/operations-input.ts",
    target: "declared request body limit",
    original: "    && declaredLength > maxBytes;",
    replacement: "    && declaredLength < maxBytes;",
    change: "Reverse the Content-Length comparison so an oversized declared body is accepted.",
    expectedFailure: /bounded JSON reader drains a declared oversize without retaining its body/,
  },
  {
    id: "malformed-utf8-not-fatal",
    source: "lib/operations-input.ts",
    target: "UTF-8 input validation",
    original: '    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);',
    replacement: '    raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);',
    change: "Replace strict UTF-8 decoding with replacement-character decoding.",
    expectedFailure: /bounded JSON reader clearly distinguishes malformed UTF-8 and JSON/,
  },
  {
    id: "json-array-accepted-as-object",
    source: "lib/operations-input.ts",
    target: "JSON object shape validation",
    original: '  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {',
    replacement: '  if (!parsed || typeof parsed !== "object") {',
    change: "Accept a JSON array where an object is required.",
    expectedFailure: /bounded JSON reader clearly distinguishes malformed UTF-8 and JSON/,
  },
  {
    id: "bounded-text-silently-truncated",
    source: "lib/operations-input.ts",
    target: "over-limit text detection",
    original: "  const normalized = cleanOperationsText(value, maxLength + 1);",
    replacement: "  const normalized = cleanOperationsText(value, maxLength);",
    change: "Truncate at the limit before the caller can detect an over-limit value.",
    expectedFailure: /bounded text normalizes NFKC and controls without truncating silently/,
  },
  {
    id: "invalid-timezone-fails-open",
    source: "lib/operations-time.ts",
    target: "organization timezone fallback",
    original: '    return "UTC";',
    replacement: "    return candidate;",
    change: "Return an invalid timezone identifier instead of failing closed to UTC.",
    expectedFailure: /organization timezone resolution fails closed to UTC/,
  },
  {
    id: "ambiguous-dst-time-accepted",
    source: "lib/operations-time.ts",
    target: "ambiguous local-time rejection",
    original: "  if (matchingInstants.size !== 1) return null;",
    replacement: "  if (matchingInstants.size === 0) return null;",
    change: "Accept one of multiple UTC instants for an ambiguous daylight-saving local time.",
    expectedFailure: /nonexistent and repeated daylight-saving local times are rejected/,
  },
  {
    id: "cursor-signature-verification-bypassed",
    source: "lib/service-lifecycle-cursor.ts",
    target: "cursor HMAC verification",
    original: '    if (!verified) throw new Error("invalid signature");',
    replacement: '    if (false && !verified) throw new Error("invalid signature");',
    change: "Continue decoding a cursor after HMAC verification fails.",
    expectedFailure: /service lifecycle cursor rejects payload and signature tampering/,
  },
  {
    id: "cursor-organization-binding-removed",
    source: "lib/service-lifecycle-cursor.ts",
    target: "cursor organization scope binding",
    original: "      || payload.organizationId !== expectedContext.organizationId",
    replacement: "      || false",
    change: "Allow a signed cursor to be replayed across organizations.",
    expectedFailure: /service lifecycle cursor is bound to its service and organization/,
  },
  {
    id: "short-cursor-secret-accepted",
    source: "lib/service-lifecycle-cursor.ts",
    target: "cursor HMAC secret length",
    original: '  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) throw invalidCursor();',
    replacement: '  if (typeof secret !== "string" || secret.length < 1) throw invalidCursor();',
    change: "Accept a cursor signing secret shorter than the required minimum.",
    expectedFailure: /service lifecycle cursor fails closed when its signing secret is absent or too short/,
  },
];
for (const mutant of mutants) {
  const source = sources.get(mutant.source)?.content;
  assert.ok(source, `Unknown mutant source: ${mutant.source}`);
  assert.equal(
    occurrences(source, mutant.original),
    1,
    `The ${mutant.id} source fragment must occur exactly once in ${mutant.source}.`,
  );
}

const temporaryDirectory = mkdtempSync(join(tmpdir(), "continuity-ops-mutant-"));

try {
  mkdirSync(join(temporaryDirectory, "lib"), { recursive: true });
  mkdirSync(join(temporaryDirectory, "tests"), { recursive: true });
  for (const [path, source] of sources) {
    writeFileSync(join(temporaryDirectory, path), source.content, "utf8");
  }
  for (const path of testPaths) {
    writeFileSync(join(temporaryDirectory, path), readFileSync(resolve(root, path), "utf8"), "utf8");
  }

  const injectedFaults = [];
  for (const mutant of mutants) {
    const source = sources.get(mutant.source);
    assert.ok(source);
    const temporarySourcePath = join(temporaryDirectory, mutant.source);
    writeFileSync(
      temporarySourcePath,
      source.content.replace(mutant.original, mutant.replacement),
      "utf8",
    );

    const mutationRun = spawnSync(
      node,
      baselineArgs,
      { cwd: temporaryDirectory, encoding: "utf8" },
    );
    const mutationOutput = commandOutput(mutationRun);
    writeFileSync(temporarySourcePath, source.content, "utf8");
    assert.notEqual(
      mutationRun.status,
      0,
      `The unit suites passed after injecting ${mutant.id}.`,
    );
    assert.match(
      mutationOutput,
      mutant.expectedFailure,
      `The ${mutant.id} defect failed for an unexpected reason.`,
    );
    injectedFaults.push({
      id: mutant.id,
      source: mutant.source,
      target: mutant.target,
      change: mutant.change,
      repositorySourceModified: false,
      expectedResult: "The existing unit suites reject the weakened rule.",
      observedResult: "failed_as_expected",
      exitCode: mutationRun.status,
      outputExcerpt: sanitizedOutput(mutationOutput, temporaryDirectory),
    });
  }

  const sourceIntegrity = sourcePaths.map((path) => {
    const source = sources.get(path);
    assert.ok(source);
    const sha256After = sha256(readFileSync(resolve(root, path), "utf8"));
    assert.equal(sha256After, source.sha256Before, `Fault injection changed ${path}.`);
    return {
      path,
      sha256Before: source.sha256Before,
      sha256After,
      unchanged: true,
    };
  });
  const report = {
    schemaVersion: "1.0",
    evidenceId: EVIDENCE_ID,
    product: PRODUCT_NAME,
    productVersion: PRODUCT_VERSION,
    generatedAt: new Date().toISOString(),
    evidenceStatus: "verified_local",
    verificationType: "risk_oriented_targeted_fault_injection",
    result: "passed",
    baseline: {
      command: `node ${baselineArgs.join(" ")}`,
      suites: testPaths,
      result: "passed",
    },
    injectedFaults,
    summary: { total: injectedFaults.length, detected: injectedFaults.length, survived: 0 },
    sourceIntegrity,
    limitations: [
      "This check covers a selected risk-oriented set across five library modules; it is not a complete mutation-testing campaign.",
      "The selected mutants are hand-designed and are not a mutation score or a claim that every operator and branch was mutated.",
      "The result applies only to the source and tests present when this report was generated.",
    ],
  };

  mkdirSync(resolve(root, "evidence"), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ok: true, evidenceId: EVIDENCE_ID, output: evidencePath }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
