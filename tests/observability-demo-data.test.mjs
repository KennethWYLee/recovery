import assert from "node:assert/strict";
import test from "node:test";

import { generateObservabilityDemoRows, observabilityDemoSql } from "../scripts/observability-demo-data.mjs";

test("observability demo data is deterministic, varied, and explicitly simulated", () => {
  const options = { seed: 17, hours: 48, anchor: "2026-08-05T12:34:56.000Z" };
  const first = generateObservabilityDemoRows(options);
  const second = generateObservabilityDemoRows(options);
  assert.deepEqual(first, second);
  assert.ok(first.length > 100);
  assert.ok(first.every((row) => row.source === "simulated" && row.schemaVersion === "0005"));
  assert.ok(new Set(first.map((row) => row.route)).size >= 5);
  assert.ok(first.some((row) => row.status >= 400));
  assert.ok(first.some((row) => row.status === 200));
  assert.equal(new Set(first.map((row) => row.requestId)).size, first.length);
});

test("observability demo SQL replaces only simulated telemetry and contains no identities", () => {
  const rows = generateObservabilityDemoRows({ seed: 3, hours: 24, anchor: "2026-08-05T12:00:00.000Z" });
  const sql = observabilityDemoSql(rows.slice(0, 3));
  assert.match(sql, /^DELETE FROM ops_request_telemetry WHERE source = 'simulated';/u);
  assert.doesNotMatch(sql, /DELETE FROM ops_request_telemetry;/u);
  assert.doesNotMatch(sql, /@|password|token/iu);
  assert.equal(sql.match(/INSERT INTO ops_request_telemetry/gu)?.length, 3);
});
