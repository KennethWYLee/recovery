import assert from "node:assert/strict";
import test from "node:test";

import { normalizeObservabilitySnapshot } from "../lib/observability-client.ts";

const validSnapshot = {
  window: "24h",
  from: "2026-08-04T12:00:00.000Z",
  to: "2026-08-05T12:00:00.000Z",
  bucketUnit: "hour",
  summary: { totalRequests: 4, successfulRequests: 2, clientErrors: 1, serverErrors: 1, deniedRequests: 1, errorRatePercent: 25, averageLatencyMs: 125, p50LatencyMs: 80, p95LatencyMs: 320, lastObservedAt: "2026-08-05T11:59:00.000Z" },
  coverage: { runtimeEvents: 3, simulatedEvents: 1, hasSimulatedData: true },
  timeSeries: [{ bucket: "2026-08-05T11:00:00Z", requests: 4, clientErrors: 1, serverErrors: 1, averageLatencyMs: 125 }],
  statusClasses: [{ statusClass: "2xx", count: 2 }, { statusClass: "4xx", count: 1 }, { statusClass: "5xx", count: 1 }],
  routes: [{ route: "/api/v1/overview", requests: 4, clientErrors: 1, serverErrors: 1, averageLatencyMs: 125 }],
  problemCodes: [{ code: "INTERNAL_ERROR", count: 1 }],
  recentErrors: [{ requestId: "req-example-0001", occurredAt: "2026-08-05T11:59:00.000Z", route: "/api/v1/overview", method: "GET", status: 500, problemCode: "INTERNAL_ERROR", latencyMs: 320, deploymentVersion: "build-1", source: "runtime" }],
};

test("observability response normalization preserves chart and investigation fields", () => {
  const snapshot = normalizeObservabilitySnapshot(validSnapshot);
  assert.equal(snapshot.summary.p95LatencyMs, 320);
  assert.equal(snapshot.coverage.hasSimulatedData, true);
  assert.equal(snapshot.recentErrors[0].requestId, "req-example-0001");
  assert.equal(snapshot.statusClasses[2].statusClass, "5xx");
});

test("observability response normalization rejects unsupported windows and invalid numbers", () => {
  assert.throws(() => normalizeObservabilitySnapshot({ ...validSnapshot, window: "1h" }), /不受支援/u);
  assert.throws(() => normalizeObservabilitySnapshot({ ...validSnapshot, summary: { ...validSnapshot.summary, totalRequests: "not-a-number" } }), /不是有效數值/u);
});
