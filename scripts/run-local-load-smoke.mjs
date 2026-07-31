import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PRODUCT_NAME = "Continuity Ops";
const PRODUCT_VERSION = "2.2.0";
const EVIDENCE_ID = "CO-VRF-LOAD-001";
const parsedBaseUrl = new URL(process.env.CONTINUITY_OPS_BASE_URL ?? "http://localhost:3001");
assert.ok(
  new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(parsedBaseUrl.hostname),
  "The bounded load smoke is restricted to a loopback Worker.",
);
const baseUrl = parsedBaseUrl.origin;
const requestTimeoutMs = Number(process.env.CONTINUITY_OPS_LOAD_REQUEST_TIMEOUT_MS ?? 10_000);
assert.ok(
  Number.isInteger(requestTimeoutMs) && requestTimeoutMs >= 1_000 && requestTimeoutMs <= 60_000,
  "CONTINUITY_OPS_LOAD_REQUEST_TIMEOUT_MS must be an integer from 1000 through 60000.",
);
const workerPath = resolve("dist/server/index.js");
const outputPath = resolve("evidence/continuity-ops-local-load-smoke.json");
const stages = [
  { concurrency: 1, requests: 40 },
  { concurrency: 5, requests: 100 },
  { concurrency: 20, requests: 200 },
  { concurrency: 50, requests: 250 },
];
const routes = [
  "/api/v1/health",
  "/api/v1/access",
  "/api/v1/overview",
  "/api/v1/services",
  "/api/v1/incidents?status=open",
  "/api/v1/audit",
];

assert.ok(existsSync(workerPath), "Build Continuity Ops before running the local load smoke test.");
const buildSha256 = createHash("sha256").update(readFileSync(workerPath)).digest("hex");

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(latencies) {
  const sorted = [...latencies].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    min: sorted[0] ?? null,
    mean: sorted.length === 0 ? null : Math.round((total / sorted.length) * 100) / 100,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? null,
  };
}

async function measuredRequest(sequence) {
  const route = routes[sequence % routes.length];
  const startedAt = performance.now();
  try {
    const response = await fetch(new URL(route, `${baseUrl}/`), {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const text = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    const requestId = response.headers.get("x-request-id") ?? "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const valid = response.status === 200
      && /^application\/json\b/iu.test(contentType)
      && /^req-[0-9a-f-]{36}$/iu.test(requestId)
      && parsed !== null
      && typeof parsed === "object"
      && !Array.isArray(parsed)
      && "data" in parsed;
    return { route, elapsedMs, status: response.status, valid, problemCode: parsed?.code ?? null };
  } catch (error) {
    return {
      route,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      status: null,
      valid: false,
      problemCode: error instanceof Error ? error.name : "REQUEST_FAILED",
    };
  }
}

async function executeStage(stage, offset) {
  const results = new Array(stage.requests);
  let next = 0;
  const startedAt = performance.now();
  await Promise.all(Array.from({ length: stage.concurrency }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= stage.requests) return;
      results[index] = await measuredRequest(offset + index);
    }
  }));
  const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
  const latencies = results.map((item) => item.elapsedMs);
  const statusCounts = Object.fromEntries(
    [...new Set(results.map((item) => String(item.status ?? "network_error")))]
      .sort()
      .map((status) => [status, results.filter((item) => String(item.status ?? "network_error") === status).length]),
  );
  return {
    concurrency: stage.concurrency,
    requests: stage.requests,
    elapsedMs,
    requestsPerSecond: Math.round((stage.requests / (elapsedMs / 1000)) * 100) / 100,
    validResponses: results.filter((item) => item.valid).length,
    invalidResponses: results.filter((item) => !item.valid).length,
    serverErrors: results.filter((item) => (item.status ?? 0) >= 500).length,
    statusCounts,
    latencyMs: summarize(latencies),
  };
}

const warmup = await Promise.all(Array.from({ length: 20 }, (_, index) => measuredRequest(index)));
assert.equal(warmup.filter((item) => !item.valid).length, 0, "The load-smoke warm-up returned an invalid response.");

const stageResults = [];
let offset = warmup.length;
for (const stage of stages) {
  const result = await executeStage(stage, offset);
  stageResults.push(result);
  offset += stage.requests;
}

const summary = {
  totalRequests: stageResults.reduce((sum, stage) => sum + stage.requests, 0),
  validResponses: stageResults.reduce((sum, stage) => sum + stage.validResponses, 0),
  invalidResponses: stageResults.reduce((sum, stage) => sum + stage.invalidResponses, 0),
  serverErrors: stageResults.reduce((sum, stage) => sum + stage.serverErrors, 0),
  peakConcurrency: Math.max(...stageResults.map((stage) => stage.concurrency)),
};
assert.equal(summary.invalidResponses, 0, "At least one bounded-load response violated the HTTP contract.");
assert.equal(summary.serverErrors, 0, "The bounded local load smoke observed a 5xx response.");

const report = {
  schemaVersion: "1.0",
  evidenceId: EVIDENCE_ID,
  product: PRODUCT_NAME,
  productVersion: PRODUCT_VERSION,
  generatedAt: new Date().toISOString(),
  evidenceStatus: "verified_local_controlled",
  verificationType: "bounded_read_only_local_load_smoke",
  result: "passed_with_documented_limits",
  environment: {
    baseUrl,
    runtime: process.version,
    dataClassification: "synthetic_local",
    requestTimeoutMs,
  },
  buildArtifact: {
    path: "dist/server/index.js",
    sha256: buildSha256,
  },
  workload: {
    warmupRequests: warmup.length,
    routes,
    stages,
    mutationsPerformed: 0,
  },
  stages: stageResults,
  summary,
  conclusions: [
    "Every bounded local read response satisfied the expected status, JSON envelope, content type, and request-ID contract.",
    "Latency and throughput are observations for this local machine and synthetic D1 state, not production objectives or capacity claims.",
  ],
  limitations: [
    "This is a short, read-only local load smoke; it is not a soak, stress, rate-limit, hosted-edge, or production capacity test.",
    "The run does not establish an SLO, RTO, RPO, Cloudflare Worker limit, D1 production throughput, or concurrent mutation safety.",
    "No external services, external users, production identity edge, CDN, or internet network path were exercised.",
  ],
};

mkdirSync(resolve("evidence"), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, evidenceId: EVIDENCE_ID, output: outputPath, summary }, null, 2));
