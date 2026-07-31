import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const EVIDENCE_ID = "CO-VRF-QA-BLACKBOX-001";
const DEFAULT_OUTPUT = path.resolve(
  process.cwd(),
  "evidence/continuity-ops-independent-blackbox-qa.json",
);

// These cases are intentionally declared before any request is sent. The
// evidence records a digest of this definition so a later report can show
// which expectations were frozen for the run.
const CASE_DEFINITIONS = [
  {
    id: "H-GOOD-01",
    kind: "harness-known-good",
    objective: "The documented health endpoint returns a structured success response.",
    expected: "HTTP 200 with a JSON object.",
  },
  {
    id: "H-BAD-01",
    kind: "harness-known-bad",
    objective: "The harness recognizes a deliberately unknown API resource as a failure response.",
    expected: "HTTP 404 with a structured problem response.",
  },
  {
    id: "QA-PERM-01",
    kind: "identity-and-permission-boundary",
    objective: "A caller-supplied identity header cannot replace the configured local actor.",
    expected: "The spoof is rejected, or it is ignored without changing the established principal.",
  },
  {
    id: "QA-REQUEST-01",
    kind: "mutation-origin-boundary",
    objective: "A state-changing request without Origin is rejected before any write.",
    expected: "HTTP 403.",
  },
  {
    id: "QA-REQUEST-02",
    kind: "content-type-boundary",
    objective: "A mutation with a non-JSON media type is rejected.",
    expected: "HTTP 415.",
  },
  {
    id: "QA-REQUEST-03",
    kind: "request-size-boundary",
    objective: "A JSON request body larger than the documented 32 KiB limit is rejected.",
    expected: "HTTP 413.",
  },
  {
    id: "QA-DATA-01",
    kind: "api-observable-data-consistency",
    objective: "A service has the same identity, version, lifecycle status, and slug in list and detail projections.",
    expected: "The list and detail projections agree on all available invariant fields.",
  },
  {
    id: "QA-VERSION-01",
    kind: "optimistic-version-guard",
    objective: "A service update using a deliberately incorrect expectedVersion is rejected without changing observable state.",
    expected: "HTTP 409, followed by an unchanged service projection.",
  },
  {
    id: "QA-STATE-01",
    kind: "incident-status-projection",
    objective: "Incident list and detail projections expose consistent, documented status values.",
    expected: "Every listed incident has a documented status, and a checked detail reports the same status.",
  },
  {
    id: "QA-CURSOR-01",
    kind: "lifecycle-cursor-integrity",
    objective: "A malformed service-lifecycle cursor is rejected rather than treated as a valid page.",
    expected: "HTTP 400.",
  },
  {
    id: "QA-TIME-01",
    kind: "organization-timezone-projection",
    objective: "The authenticated organization exposes one syntactically valid IANA time zone across public projections.",
    expected: "At least one time-zone field is present, all observed values agree, and Intl accepts the value.",
  },
  {
    id: "QA-NOTFOUND-01",
    kind: "missing-resource-behavior",
    objective: "A syntactically valid but absent incident identifier returns a structured not-found response.",
    expected: "HTTP 404 without exposing a stack trace.",
  },
];

function usage() {
  return [
    "Usage:",
    "  node scripts/run-independent-blackbox-qa.mjs --base-url http://localhost:3001 [options]",
    "",
    "Options:",
    "  --output PATH                    Evidence JSON path.",
    "  --expected-build-sha256 HEX      Optional Worker artifact binding.",
    "  --expected-deployment-version ID Optional deployment-version binding.",
    "  --timeout-ms N                   Per-request timeout (default: 10000).",
    "  --help                           Show this help.",
  ].join("\n");
}

function parseArguments(argv) {
  const args = {
    baseUrl: process.env.CONTINUITY_OPS_BASE_URL ?? "http://localhost:3001",
    output: DEFAULT_OUTPUT,
    expectedBuildSha256: undefined,
    expectedDeploymentVersion: undefined,
    timeoutMs: 10_000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }

    if (option === "--base-url") args.baseUrl = value;
    else if (option === "--output") args.output = path.resolve(value);
    else if (option === "--expected-build-sha256") args.expectedBuildSha256 = value.toLowerCase();
    else if (option === "--expected-deployment-version") args.expectedDeploymentVersion = value;
    else if (option === "--timeout-ms") args.timeoutMs = Number(value);
    else throw new Error(`Unknown option: ${option}`);
    index += 1;
  }

  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1_000 || args.timeoutMs > 60_000) {
    throw new Error("--timeout-ms must be an integer between 1000 and 60000");
  }
  if (args.expectedBuildSha256 && !/^[a-f0-9]{64}$/.test(args.expectedBuildSha256)) {
    throw new Error("--expected-build-sha256 must be a complete 64-character SHA-256 digest");
  }

  const parsedBaseUrl = new URL(args.baseUrl);
  if (!new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(parsedBaseUrl.hostname)) {
    throw new Error(
      "This evidence type is restricted to a loopback Worker. Use a separate status and protocol for remote QA.",
    );
  }
  parsedBaseUrl.pathname = parsedBaseUrl.pathname.replace(/\/$/, "");
  args.baseUrl = parsedBaseUrl.toString().replace(/\/$/, "");
  args.origin = parsedBaseUrl.origin;
  return args;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function walk(value, visit, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  visit(value);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit, seen);
  } else {
    for (const item of Object.values(value)) walk(item, visit, seen);
  }
}

function stringsForKeys(value, keyPattern) {
  const found = [];
  walk(value, (candidate) => {
    if (Array.isArray(candidate)) return;
    for (const [key, item] of Object.entries(candidate)) {
      if (keyPattern.test(key) && typeof item === "string" && item.trim()) found.push(item.trim());
    }
  });
  return [...new Set(found)];
}

function firstCollection(value, preferredKeys) {
  if (Array.isArray(value)) return value;
  let selected;
  walk(value, (candidate) => {
    if (selected || Array.isArray(candidate)) return;
    for (const key of preferredKeys) {
      if (Array.isArray(candidate[key])) {
        selected = candidate[key];
        return;
      }
    }
  });
  return selected ?? [];
}

function firstEntity(value, preferredKeys) {
  if (!value || typeof value !== "object") return undefined;
  if (!Array.isArray(value) && (typeof value.id === "string" || typeof value.version === "number")) return value;
  for (const key of preferredKeys) {
    let selected;
    walk(value, (candidate) => {
      if (selected || Array.isArray(candidate)) return;
      const item = candidate[key];
      if (
        item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (entityId(item) || typeof item.version === "number")
      ) {
        selected = item;
      }
    });
    if (selected) return selected;
  }
  let selected;
  walk(value, (candidate) => {
    if (!selected && !Array.isArray(candidate) && (entityId(candidate) || typeof candidate.version === "number")) {
      selected = candidate;
    }
  });
  return selected;
}

function entityId(entity) {
  if (!entity || typeof entity !== "object") return undefined;
  for (const key of ["id", "serviceId", "incidentId", "userId", "memberId"]) {
    if (typeof entity[key] === "string" && entity[key]) return entity[key];
  }
  return undefined;
}

function requestIdFrom(response) {
  const headerId = response.headers["x-request-id"];
  if (headerId) return headerId;
  return stringsForKeys(response.body, /^requestId$/i)[0];
}

function problemCodeFrom(response) {
  return stringsForKeys(response.body, /^(code|problemCode|reasonCode)$/i)[0];
}

function observedRequest(response) {
  const requestId = requestIdFrom(response);
  return {
    status: response.status,
    contentType: response.headers["content-type"] ?? null,
    problemCode: problemCodeFrom(response) ?? null,
    requestIdSha256: requestId ? sha256(requestId) : null,
    bodyBytes: Buffer.byteLength(response.text, "utf8"),
    jsonParsed: response.body !== undefined,
  };
}

function valuesAgree(left, right, keys) {
  const compared = [];
  const differences = [];
  for (const key of keys) {
    if (!(key in left) || !(key in right)) continue;
    compared.push(key);
    if (canonicalJson(left[key]) !== canonicalJson(right[key])) differences.push(key);
  }
  return { compared, differences };
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/gi, "<URL>").slice(0, 500);
}

function makeIdempotencyKey(caseId) {
  return `blackbox-${caseId.toLowerCase()}-${randomUUID()}`.slice(0, 120);
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const workerArtifactPath = path.resolve(process.cwd(), "dist/server/index.js");
  const observedBuildSha256 = sha256(await readFile(workerArtifactPath));
  if (args.expectedBuildSha256 && args.expectedBuildSha256 !== observedBuildSha256) {
    throw new Error("The current Worker artifact does not match --expected-build-sha256.");
  }
  const generatedAt = new Date().toISOString();
  const runId = `blackbox-${generatedAt.replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const checks = [];
  const cache = {};

  async function http(method, requestPath, options = {}) {
    const headers = { Accept: "application/json", ...(options.headers ?? {}) };
    let body = options.body;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.timeoutMs);
    try {
      const response = await fetch(new URL(requestPath, `${args.baseUrl}/`), {
        method,
        headers,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
      const text = await response.text();
      let parsed;
      if (text.trim()) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      return {
        status: response.status,
        headers: Object.fromEntries([...response.headers.entries()].map(([key, value]) => [key.toLowerCase(), value])),
        body: parsed,
        text,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function runCase(id, execute) {
    const definition = CASE_DEFINITIONS.find((candidate) => candidate.id === id);
    const startedAt = new Date().toISOString();
    const start = performance.now();
    try {
      const outcome = await execute();
      checks.push({
        ...definition,
        result: outcome.passed ? "passed" : "failed",
        startedAt,
        elapsedMs: Math.round(performance.now() - start),
        observed: outcome.observed,
        failure: outcome.passed ? null : outcome.failure ?? "Observed result did not match the frozen expectation.",
      });
    } catch (error) {
      checks.push({
        ...definition,
        result: "failed",
        startedAt,
        elapsedMs: Math.round(performance.now() - start),
        observed: null,
        failure: safeError(error),
      });
    }
  }

  await runCase("H-GOOD-01", async () => {
    const response = await http("GET", "/api/v1/health");
    cache.health = response;
    return {
      passed: response.status === 200 && response.body && typeof response.body === "object",
      observed: observedRequest(response),
    };
  });

  await runCase("H-BAD-01", async () => {
    const response = await http("GET", `/api/v1/__blackbox_absent_${randomUUID()}`);
    const hasProblemShape =
      response.body &&
      typeof response.body === "object" &&
      (typeof response.body.title === "string" ||
        typeof response.body.detail === "string" ||
        Boolean(problemCodeFrom(response)));
    return {
      passed: response.status === 404 && hasProblemShape && !/\bat\s+\S+\s*\([^)]*:\d+:\d+\)/.test(response.text),
      observed: observedRequest(response),
    };
  });

  await runCase("QA-PERM-01", async () => {
    const baseline = await http("GET", "/api/v1/access");
    const spoofEmail = `blackbox-uninvited-${randomUUID()}@example.invalid`;
    const spoofed = await http("GET", "/api/v1/access", {
      headers: { "Cf-Access-Authenticated-User-Email": spoofEmail },
    });
    cache.access = baseline;
    const baselineEmails = stringsForKeys(baseline.body, /email/i).map((email) => email.toLowerCase());
    const spoofedEmails = stringsForKeys(spoofed.body, /email/i).map((email) => email.toLowerCase());
    const rejected = spoofed.status === 401 || spoofed.status === 403;
    const ignored =
      baseline.status === 200 &&
      spoofed.status === 200 &&
      !spoofedEmails.includes(spoofEmail.toLowerCase()) &&
      baselineEmails.every((email) => spoofedEmails.includes(email));
    return {
      passed: rejected || ignored,
      observed: {
        baseline: observedRequest(baseline),
        spoofed: observedRequest(spoofed),
        outcome: rejected ? "spoof_rejected" : ignored ? "spoof_ignored" : "principal_changed_or_unverifiable",
        baselineEmailCount: baselineEmails.length,
        spoofedEmailCount: spoofedEmails.length,
      },
    };
  });

  await runCase("QA-REQUEST-01", async () => {
    const response = await http("POST", "/api/v1/services", {
      headers: { "Idempotency-Key": makeIdempotencyKey("QA-REQUEST-01") },
      json: {},
    });
    return { passed: response.status === 403, observed: observedRequest(response) };
  });

  await runCase("QA-REQUEST-02", async () => {
    const response = await http("POST", "/api/v1/services", {
      headers: {
        Origin: args.origin,
        "Content-Type": "text/plain",
        "Idempotency-Key": makeIdempotencyKey("QA-REQUEST-02"),
      },
      body: "not-json",
    });
    return { passed: response.status === 415, observed: observedRequest(response) };
  });

  await runCase("QA-REQUEST-03", async () => {
    const response = await http("POST", "/api/v1/services", {
      headers: {
        Origin: args.origin,
        "Idempotency-Key": makeIdempotencyKey("QA-REQUEST-03"),
      },
      json: { padding: "x".repeat(33 * 1024) },
    });
    return { passed: response.status === 413, observed: observedRequest(response) };
  });

  await runCase("QA-DATA-01", async () => {
    const listResponse = await http("GET", "/api/v1/services");
    const services = firstCollection(listResponse.body, ["services", "items", "results"]);
    const service = services.find((item) => item && typeof item === "object" && entityId(item));
    if (listResponse.status !== 200 || !service) {
      return {
        passed: false,
        failure: "The service list did not contain a service suitable for a list/detail consistency check.",
        observed: { list: observedRequest(listResponse), serviceCount: services.length },
      };
    }
    const serviceId = entityId(service);
    const detailResponse = await http("GET", `/api/v1/services/${encodeURIComponent(serviceId)}`);
    const detail = firstEntity(detailResponse.body, ["service", "item", "data"]);
    const comparison = detail
      ? valuesAgree(service, detail, ["id", "serviceId", "version", "status", "slug"])
      : { compared: [], differences: ["detail"] };
    cache.service = { service, serviceId, detail, detailResponse };
    return {
      passed:
        detailResponse.status === 200 &&
        detail &&
        entityId(detail) === serviceId &&
        comparison.compared.length >= 3 &&
        comparison.differences.length === 0,
      observed: {
        list: observedRequest(listResponse),
        detail: observedRequest(detailResponse),
        serviceCount: services.length,
        serviceIdSha256: sha256(serviceId),
        comparedFields: comparison.compared,
        differingFields: comparison.differences,
      },
    };
  });

  await runCase("QA-VERSION-01", async () => {
    const target = cache.service;
    if (!target?.detail || !Number.isInteger(target.detail.version)) {
      return {
        passed: false,
        failure: "No versioned service detail was available from QA-DATA-01.",
        observed: null,
      };
    }
    const before = target.detail;
    const patch = { expectedVersion: before.version + 101 };
    for (const key of ["description", "tier", "ownerId", "ownerTeam", "team", "sloTarget", "runbookUrl", "status"]) {
      if (key in before && before[key] !== undefined) {
        patch[key] = before[key];
        break;
      }
    }
    const staleResponse = await http("PATCH", `/api/v1/services/${encodeURIComponent(target.serviceId)}`, {
      headers: {
        Origin: args.origin,
        "Idempotency-Key": makeIdempotencyKey("QA-VERSION-01"),
      },
      json: patch,
    });
    const afterResponse = await http("GET", `/api/v1/services/${encodeURIComponent(target.serviceId)}`);
    const after = firstEntity(afterResponse.body, ["service", "item", "data"]);
    const comparison = after
      ? valuesAgree(before, after, ["id", "serviceId", "version", "status", "slug"])
      : { compared: [], differences: ["detail"] };
    return {
      passed:
        staleResponse.status === 409 &&
        afterResponse.status === 200 &&
        after &&
        comparison.compared.includes("version") &&
        comparison.differences.length === 0,
      observed: {
        rejectedMutation: observedRequest(staleResponse),
        afterRead: observedRequest(afterResponse),
        submittedExpectedVersion: patch.expectedVersion,
        observedVersion: before.version,
        comparedFields: comparison.compared,
        differingFields: comparison.differences,
      },
    };
  });

  await runCase("QA-STATE-01", async () => {
    const allResponse = await http("GET", "/api/v1/incidents");
    const all = firstCollection(allResponse.body, ["incidents", "items", "results"]);
    const documentedStatuses = new Set([
      "declared",
      "triaged",
      "investigating",
      "identified",
      "monitoring",
      "resolved",
      "closed",
      "cancelled",
    ]);
    const statusesValid = all.every((item) => documentedStatuses.has(String(item?.status ?? "").toLowerCase()));
    const openCount = all.filter((item) => !new Set(["closed", "cancelled"]).has(String(item?.status ?? "").toLowerCase())).length;
    const terminalCount = all.length - openCount;
    let detailConsistent = true;
    let detailObservation = null;
    const representative = all[0];
    if (representative && entityId(representative)) {
      const response = await http("GET", `/api/v1/incidents/${encodeURIComponent(entityId(representative))}`);
      const detail = firstEntity(response.body, ["incident", "item", "data"]);
      detailConsistent =
        response.status === 200 &&
        detail &&
        String(detail.status ?? "") === String(representative.status ?? "");
      detailObservation = observedRequest(response);
    }
    return {
      passed:
        allResponse.status === 200 &&
        all.length > 0 &&
        statusesValid &&
        detailConsistent,
      observed: {
        all: observedRequest(allResponse),
        counts: { all: all.length, open: openCount, terminal: terminalCount },
        statusesValid,
        detailConsistent,
        detail: detailObservation,
      },
    };
  });

  await runCase("QA-CURSOR-01", async () => {
    const serviceId = cache.service?.serviceId;
    if (!serviceId) {
      return { passed: false, failure: "No service was available for lifecycle cursor validation.", observed: null };
    }
    const response = await http(
      "GET",
      `/api/v1/services/${encodeURIComponent(serviceId)}/lifecycle-events?cursor=${encodeURIComponent("not-a-valid-signed-cursor")}`,
    );
    return { passed: response.status === 400, observed: observedRequest(response) };
  });

  await runCase("QA-TIME-01", async () => {
    const overview = await http("GET", "/api/v1/overview");
    const access = cache.access ?? (await http("GET", "/api/v1/access"));
    const zones = [
      ...stringsForKeys(access.body, /timeZone|timezone/i),
      ...stringsForKeys(overview.body, /timeZone|timezone/i),
    ];
    const uniqueZones = [...new Set(zones)];
    const validZones = uniqueZones.filter((zone) => {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date("2026-01-15T12:00:00Z"));
        return true;
      } catch {
        return false;
      }
    });
    return {
      passed:
        access.status === 200 &&
        overview.status === 200 &&
        uniqueZones.length === 1 &&
        validZones.length === 1,
      observed: {
        access: observedRequest(access),
        overview: observedRequest(overview),
        observedZoneCount: uniqueZones.length,
        validZoneCount: validZones.length,
        timeZone: validZones[0] ?? null,
      },
    };
  });

  await runCase("QA-NOTFOUND-01", async () => {
    const absentId = `inc-${randomUUID()}`;
    const response = await http("GET", `/api/v1/incidents/${encodeURIComponent(absentId)}`);
    return {
      passed: response.status === 404 && !/\bat\s+\S+\s*\([^)]*:\d+:\d+\)/.test(response.text),
      observed: observedRequest(response),
    };
  });

  const passed = checks.filter((check) => check.result === "passed").length;
  const failed = checks.length - passed;
  const report = {
    schemaVersion: "1.0",
    evidenceId: EVIDENCE_ID,
    product: "Continuity Ops",
    productVersion: "2.2.0",
    generatedAt,
    evidenceStatus: "verified_local_agent_designed",
    verificationType: "independent_agent_designed_blackbox_http_qa",
    result: failed === 0 ? "passed_with_documented_limits" : "failed",
    protocol: {
      runId,
      caseSetVersion: "1.0.1",
      caseSetFrozenBeforeExecution: true,
      caseSetSha256: sha256(canonicalJson(CASE_DEFINITIONS)),
      sourceInspectionConstraint: {
        followed: true,
        consulted: [
          "README.md",
          "docs/assurance/acceptance-contracts.md",
          "docs/assurance/independent-qa-protocol.md",
          "public HTTP responses from the supplied base URL",
        ],
        notConsultedForCaseDesign: [
          "app/",
          "lib/",
          "db/",
          "worker/",
          "tests/",
          "scripts/api-smoke.mjs",
        ],
      },
      executor: "AI agent that did not participate in product feature implementation",
      humanThirdParty: false,
      externalUser: false,
    },
    environment: {
      scope: "loopback_local_worker",
      baseUrl: args.baseUrl,
      origin: args.origin,
      syntheticOrExistingLocalData: true,
      remoteDeployment: false,
      expectedDeploymentVersion: args.expectedDeploymentVersion ?? null,
    },
    buildArtifact: {
      path: "dist/server/index.js",
      sha256: observedBuildSha256,
      expectedSha256: args.expectedBuildSha256 ?? null,
      matchesExpected: args.expectedBuildSha256 ? true : null,
    },
    checkSummary: { total: checks.length, passed, failed },
    checks,
    mutations: {
      successfulMutationsExpected: 0,
      note: "All mutation requests in this holdout are expected to be rejected. Read-after-rejection checks verify observable state where applicable.",
    },
    limitations: [
      "This run is designed and executed by an AI agent that did not implement the product features; it is not an external human, commissioned third party, or formal independent G7 result.",
      "The evidence status verified_local_agent_designed applies only to the supplied loopback Worker, its configured local identity, and the data present during this run.",
      "The holdout checks public HTTP behavior without reading product implementation or the existing API smoke suite, but the agent still operates in the same shared repository and computing environment.",
      "The identity case verifies that a caller-supplied identity header cannot replace the configured local actor; it does not prove a complete production role matrix or hosted identity-edge configuration.",
      "The data-consistency cases observe API projections and rejected-write invariants; they do not inspect D1 directly or prove crash consistency, concurrent-write safety, backup recovery, or remote durability.",
      "The time-zone case checks a consistent valid IANA zone in public projections; it does not exercise a browser/API/D1 round trip for a DST gap or overlap.",
      "The expected deployment version is recorded as operator-supplied context; this runner cannot verify it from public responses and relies on separate request-telemetry analysis for that binding.",
      "No network interruption, D1 outage, load, soak, cross-browser, accessibility, external-user, production, rollback, or destructive security testing is performed.",
      "Passing these cases cannot be promoted to verified_ci, verified_staging, verified_production, independent third-party QA, or external-user evidence.",
    ],
  };

  await mkdir(path.dirname(args.output), { recursive: true });
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output: args.output, result: report.result, ...report.checkSummary })}\n`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});
