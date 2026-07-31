import assert from "node:assert/strict";
import test from "node:test";

import { analyzeRequestTelemetry, decodeTelemetryInput } from "../scripts/request-telemetry-analysis-lib.mjs";

const requestIdOne = "req-11111111-1111-4111-8111-111111111111";
const requestIdTwo = "req-22222222-2222-4222-8222-222222222222";
const requestIdThree = "req-33333333-3333-4333-8333-333333333333";

function telemetry(overrides = {}) {
  return {
    event: "continuity_ops.api_request",
    requestId: requestIdOne,
    route: "/api/v1/health",
    method: "GET",
    status: 200,
    problemCode: null,
    latencyMs: 4,
    apiVersion: "2.2.0",
    deploymentVersion: "local-test-build",
    schemaVersion: "0004",
    ...overrides,
  };
}

test("telemetry input decoding supports UTF-8 and PowerShell UTF-16 logs", () => {
  const source = `${JSON.stringify(telemetry())}\r\n`;
  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source, "utf8")]);
  const utf16Le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(source, "utf16le")]);
  const utf16BeBody = Buffer.from(source, "utf16le");
  for (let index = 0; index + 1 < utf16BeBody.length; index += 2) {
    [utf16BeBody[index], utf16BeBody[index + 1]] = [utf16BeBody[index + 1], utf16BeBody[index]];
  }
  const utf16Be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16BeBody]);

  assert.equal(decodeTelemetryInput(Buffer.from(source, "utf8")), source);
  assert.equal(decodeTelemetryInput(utf8Bom), source);
  assert.equal(decodeTelemetryInput(utf16Le), source);
  assert.equal(decodeTelemetryInput(utf16Be), source);
});

test("known-good raw and Wrangler-tail telemetry produce explicit denominators and private correlation", () => {
  const wrapped = {
    outcome: "ok",
    logs: [{
      level: "log",
      message: [JSON.stringify(telemetry({
        requestId: requestIdTwo,
        route: "/api/v1/services/:serviceId",
        method: "PATCH",
        status: 409,
        problemCode: "VERSION_CONFLICT",
        latencyMs: 20,
      }))],
    }],
  };
  const input = [
    "wrangler startup information",
    JSON.stringify(telemetry()),
    JSON.stringify(wrapped),
    JSON.stringify(telemetry({
      requestId: requestIdThree,
      route: "/api/v1/services/:serviceId/lifecycle-events",
      method: "GET",
      status: 200,
      latencyMs: 10,
    })),
  ].join("\n");
  const report = analyzeRequestTelemetry(input, {
    generatedAt: "2026-07-31T00:00:00.000Z",
    expectedApiVersion: "2.2.0",
    expectedSchemaVersion: "0004",
    expectedDeploymentVersion: "local-test-build",
    smokeEvidence: { checks: [{ requestId: requestIdTwo }, { requestId: requestIdThree }] },
  });

  assert.equal(report.result, "passed");
  assert.deepEqual(report.validation.validRecords, { numerator: 3, denominator: 3, percentage: 100 });
  assert.deepEqual(report.requestOutcomes.successful, { numerator: 2, denominator: 3, percentage: 66.67 });
  assert.deepEqual(report.requestOutcomes.errors, { numerator: 1, denominator: 3, percentage: 33.33 });
  assert.equal(report.problemCodes.denominator, 1);
  assert.deepEqual(report.problemCodes.records, [{ problemCode: "VERSION_CONFLICT", count: 1, denominator: 1, percentage: 100 }]);
  assert.deepEqual(report.latencyMs, {
    sampleCount: 3,
    denominator: 3,
    percentileMethod: "nearest_rank",
    minimum: 4,
    maximum: 20,
    mean: 11.33,
    p50: 10,
    p95: 20,
    p99: 20,
  });
  assert.deepEqual(report.smokeCorrelation.coverage, { numerator: 2, denominator: 2, percentage: 100 });
  assert.deepEqual(report.versions.apiMismatch, { numerator: 0, denominator: 3, percentage: 0 });
  assert.deepEqual(report.versions.schemaMismatch, { numerator: 0, denominator: 3, percentage: 0 });
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(requestIdOne));
  assert.doesNotMatch(serialized, new RegExp(requestIdTwo));
  assert.doesNotMatch(serialized, new RegExp(requestIdThree));
});

test("known-bad telemetry fails closed without copying a forbidden value into evidence", () => {
  const secret = "Bearer controlled-do-not-retain";
  const secretFieldName = "authorization-Bearer-controlled-key-secret";
  const invalid = telemetry({
    route: "/api/v1/incidents/inc-secret-record",
    status: 500,
    problemCode: null,
    latencyMs: -1,
    authorization: secret,
    [secretFieldName]: "also-not-retained",
  });
  const report = analyzeRequestTelemetry(`${JSON.stringify(invalid)}\n{\"event\":\"continuity_ops.api_request\"`, {
    generatedAt: "2026-07-31T00:00:00.000Z",
  });

  assert.equal(report.result, "failed");
  assert.deepEqual(report.validation.validRecords, { numerator: 0, denominator: 2, percentage: 0 });
  assert.ok(report.validation.violations.some((item) => item.code === "SENSITIVE_FIELD_FORBIDDEN"));
  assert.ok(report.validation.violations.some((item) => item.code === "ROUTE_TEMPLATE_INVALID"));
  assert.ok(report.validation.violations.some((item) => item.code === "ERROR_PROBLEM_CODE_REQUIRED"));
  assert.ok(report.validation.violations.some((item) => item.code === "LATENCY_INVALID"));
  assert.ok(report.validation.violations.some((item) => item.code === "TELEMETRY_JSON_INVALID"));
  assert.doesNotMatch(JSON.stringify(report), /controlled-do-not-retain/u);
  assert.doesNotMatch(JSON.stringify(report), /controlled-key-secret/u);
});

test("duplicate request IDs are rejected instead of inflating denominators", () => {
  const input = [JSON.stringify(telemetry()), JSON.stringify(telemetry({ latencyMs: 9 }))].join("\n");
  const report = analyzeRequestTelemetry(input, { generatedAt: "2026-07-31T00:00:00.000Z" });
  assert.equal(report.result, "failed");
  assert.deepEqual(report.validation.validRecords, { numerator: 0, denominator: 2, percentage: 0 });
  assert.ok(report.validation.violations.some((item) => item.code === "REQUEST_ID_DUPLICATED"));
});

test("a telemetry file from an older API or schema is retained as evidence but blocks release readiness", () => {
  const report = analyzeRequestTelemetry(JSON.stringify(telemetry({ apiVersion: "2.0.0", schemaVersion: "0002" })), {
    generatedAt: "2026-07-31T00:00:00.000Z",
    expectedApiVersion: "2.2.0",
    expectedSchemaVersion: "0004",
  });
  assert.equal(report.result, "passed_with_release_blockers");
  assert.deepEqual(report.versions.apiMismatch, { numerator: 1, denominator: 1, percentage: 100 });
  assert.deepEqual(report.versions.schemaMismatch, { numerator: 1, denominator: 1, percentage: 100 });
});
