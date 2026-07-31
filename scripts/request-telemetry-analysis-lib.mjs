import { createHash } from "node:crypto";

export const REQUEST_EVENT = "continuity_ops.api_request";

export function decodeTelemetryInput(input) {
  if (typeof input === "string") return input;
  const bytes = Buffer.from(input);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    for (let index = 0; index + 1 < swapped.length; index += 2) {
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
    }
    return swapped.toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  return bytes.toString("utf8");
}

const ALLOWED_FIELDS = new Set([
  "event",
  "requestId",
  "route",
  "method",
  "status",
  "problemCode",
  "latencyMs",
  "apiVersion",
  "deploymentVersion",
  "schemaVersion",
]);

const REQUIRED_FIELDS = [...ALLOWED_FIELDS];
const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const SAFE_ROUTES = new Set([
  "/api/v1/:route",
  "/api/v1/access",
  "/api/v1/access/members",
  "/api/v1/access/members/:membershipId",
  "/api/v1/audit",
  "/api/v1/health",
  "/api/v1/incidents",
  "/api/v1/incidents/:incidentId",
  "/api/v1/incidents/:incidentId/assignments",
  "/api/v1/incidents/:incidentId/assignments/:assignmentId",
  "/api/v1/incidents/:incidentId/communications",
  "/api/v1/incidents/:incidentId/communications/:communicationId",
  "/api/v1/incidents/:incidentId/review",
  "/api/v1/incidents/:incidentId/tasks",
  "/api/v1/incidents/:incidentId/tasks/:taskId",
  "/api/v1/incidents/:incidentId/timeline",
  "/api/v1/incidents/:incidentId/transitions",
  "/api/v1/overview",
  "/api/v1/services",
  "/api/v1/services/:serviceId",
  "/api/v1/services/:serviceId/lifecycle-events",
]);
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const PROBLEM_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,79}$/u;
const REQUEST_ID_PATTERN = /^req-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|token|secret|password|requestbody|body|payload|headers?|email|actor|userid|resourceid|idempotencykey|rawurl)/iu;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function requestIdFingerprint(requestId) {
  return `sha256:${sha256(requestId).slice(0, 16)}`;
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function ratio(numerator, denominator) {
  return {
    numerator,
    denominator,
    percentage: denominator === 0 ? null : round((numerator / denominator) * 100),
  };
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null;
  const rank = Math.max(1, Math.ceil(percentileValue * sortedValues.length));
  return sortedValues[rank - 1];
}

function sortedCounts(values, keyName) {
  const counts = new Map();
  for (const value of values) counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => ({ [keyName]: keyName === "status" ? Number(value) : value, count }));
}

function parseJsonValue(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return { parsed: false, value: null };
  try {
    return { parsed: true, value: JSON.parse(trimmed) };
  } catch {
    const firstObject = trimmed.indexOf("{");
    const lastObject = trimmed.lastIndexOf("}");
    if (firstObject >= 0 && lastObject > firstObject) {
      try {
        return { parsed: true, value: JSON.parse(trimmed.slice(firstObject, lastObject + 1)) };
      } catch {
        // The caller records a bounded parse failure without retaining raw input.
      }
    }
    return { parsed: false, value: null };
  }
}

function telemetryFromParsedValue(value, lineNumber, records) {
  if (Array.isArray(value)) {
    for (const item of value) telemetryFromParsedValue(item, lineNumber, records);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.event === REQUEST_EVENT) {
    records.push({ lineNumber, value });
    return;
  }
  if (!Array.isArray(value.logs)) return;
  for (const log of value.logs) {
    if (!log || typeof log !== "object" || !Array.isArray(log.message)) continue;
    for (const messagePart of log.message) {
      if (messagePart && typeof messagePart === "object") {
        telemetryFromParsedValue(messagePart, lineNumber, records);
        continue;
      }
      if (typeof messagePart !== "string") continue;
      const nested = parseJsonValue(messagePart);
      if (nested.parsed) telemetryFromParsedValue(nested.value, lineNumber, records);
    }
  }
}

export function parseTelemetryInput(input) {
  const lines = input.split(/\r?\n/u);
  const records = [];
  const unparseableCandidateLines = [];
  let blankLineCount = 0;
  let parsedJsonLineCount = 0;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line.trim()) {
      blankLineCount += 1;
      return;
    }
    const parsed = parseJsonValue(line);
    if (parsed.parsed) {
      parsedJsonLineCount += 1;
      telemetryFromParsedValue(parsed.value, lineNumber, records);
    } else if (line.includes(REQUEST_EVENT)) {
      unparseableCandidateLines.push(lineNumber);
    }
  });

  const nonBlankLineCount = lines.length - blankLineCount;
  return {
    records,
    unparseableCandidateLines,
    lineSummary: {
      totalInputLines: lines.length,
      nonBlankLineCount,
      blankLineCount,
      parsedJsonLineCount,
      nonJsonLineCount: nonBlankLineCount - parsedJsonLineCount,
    },
  };
}

function validationViolations(record, recordIndex) {
  const value = record.value;
  const violations = [];
  const fingerprint = typeof value.requestId === "string" && REQUEST_ID_PATTERN.test(value.requestId)
    ? requestIdFingerprint(value.requestId)
    : null;
  const add = (code, field = null) => violations.push({
    recordIndex,
    lineNumber: record.lineNumber,
    requestFingerprint: fingerprint,
    code,
    ...(field ? { field } : {}),
  });

  for (const field of REQUIRED_FIELDS) {
    if (!Object.hasOwn(value, field)) add("REQUIRED_FIELD_MISSING", field);
  }
  for (const field of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(field)) {
      add(SENSITIVE_KEY_PATTERN.test(field) ? "SENSITIVE_FIELD_FORBIDDEN" : "FIELD_NOT_ALLOWED", "redacted_unknown_field");
    }
  }
  if (value.event !== REQUEST_EVENT) add("EVENT_NAME_INVALID", "event");
  if (typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId)) add("REQUEST_ID_INVALID", "requestId");
  if (typeof value.route !== "string" || !SAFE_ROUTES.has(value.route)) {
    add("ROUTE_TEMPLATE_INVALID", "route");
  }
  if (typeof value.method !== "string" || !ALLOWED_METHODS.has(value.method)) add("METHOD_INVALID", "method");
  if (!Number.isInteger(value.status) || value.status < 100 || value.status > 599) add("STATUS_INVALID", "status");
  if (!Number.isInteger(value.latencyMs) || value.latencyMs < 0 || !Number.isSafeInteger(value.latencyMs)) {
    add("LATENCY_INVALID", "latencyMs");
  }
  for (const field of ["apiVersion", "deploymentVersion", "schemaVersion"]) {
    if (typeof value[field] !== "string" || !VERSION_PATTERN.test(value[field])) add("VERSION_FIELD_INVALID", field);
  }
  if (Number.isInteger(value.status)) {
    if (value.status >= 400 && (typeof value.problemCode !== "string" || !PROBLEM_CODE_PATTERN.test(value.problemCode))) {
      add("ERROR_PROBLEM_CODE_REQUIRED", "problemCode");
    }
    if (value.status < 400 && value.problemCode !== null) add("SUCCESS_PROBLEM_CODE_MUST_BE_NULL", "problemCode");
  }
  return violations;
}

function collectRequestIds(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectRequestIds(item, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value)) {
    if (key === "requestId" && typeof item === "string" && REQUEST_ID_PATTERN.test(item)) output.add(item);
    else collectRequestIds(item, output);
  }
  return output;
}

function correlationSummary(smokeEvidence, telemetryRecords) {
  if (!smokeEvidence) return null;
  const smokeIds = collectRequestIds(smokeEvidence);
  const telemetryIds = new Set(telemetryRecords.map((record) => record.value.requestId));
  const matched = [...smokeIds].filter((requestId) => telemetryIds.has(requestId));
  const missing = [...smokeIds].filter((requestId) => !telemetryIds.has(requestId));
  const telemetryOnly = [...telemetryIds].filter((requestId) => !smokeIds.has(requestId));
  return {
    method: "exact_request_id_match_with_digest_only_output",
    smokeEvidenceRequestIds: smokeIds.size,
    validTelemetryRequestIds: telemetryIds.size,
    coverage: ratio(matched.length, smokeIds.size),
    matchedRequestCount: matched.length,
    missingRequestCount: missing.length,
    telemetryOnlyRequestCount: telemetryOnly.length,
    missingRequestFingerprints: missing.map(requestIdFingerprint).sort(),
    rawRequestIdsIncluded: false,
  };
}

export function analyzeRequestTelemetry(input, options = {}) {
  const parsed = parseTelemetryInput(input);
  const violations = parsed.unparseableCandidateLines.map((lineNumber, index) => ({
    recordIndex: `unparseable-${index + 1}`,
    lineNumber,
    requestFingerprint: null,
    code: "TELEMETRY_JSON_INVALID",
  }));
  const invalidIndexes = new Set();
  const seenRequestIds = new Map();

  parsed.records.forEach((record, index) => {
    const current = validationViolations(record, index + 1);
    if (current.length > 0) invalidIndexes.add(index);
    violations.push(...current);
    const requestId = record.value.requestId;
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return;
    if (seenRequestIds.has(requestId)) {
      invalidIndexes.add(index);
      invalidIndexes.add(seenRequestIds.get(requestId));
      violations.push({
        recordIndex: index + 1,
        lineNumber: record.lineNumber,
        requestFingerprint: requestIdFingerprint(requestId),
        code: "REQUEST_ID_DUPLICATED",
        field: "requestId",
      });
    } else {
      seenRequestIds.set(requestId, index);
    }
  });

  const validRecords = parsed.records.filter((_, index) => !invalidIndexes.has(index));
  const values = validRecords.map((record) => record.value);
  const candidateCount = parsed.records.length + parsed.unparseableCandidateLines.length;
  const successCount = values.filter((value) => value.status < 400).length;
  const errorRecords = values.filter((value) => value.status >= 400);
  const clientErrorCount = values.filter((value) => value.status >= 400 && value.status < 500).length;
  const serverErrorCount = values.filter((value) => value.status >= 500).length;
  const latencies = values.map((value) => value.latencyMs).sort((left, right) => left - right);
  const latencySum = latencies.reduce((sum, latency) => sum + latency, 0);
  const expectedDeploymentVersion = options.expectedDeploymentVersion ?? null;
  const expectedApiVersion = options.expectedApiVersion ?? null;
  const expectedSchemaVersion = options.expectedSchemaVersion ?? null;
  const unversionedCount = values.filter((value) => value.deploymentVersion === "unversioned").length;
  const deploymentMismatchCount = expectedDeploymentVersion === null
    ? 0
    : values.filter((value) => value.deploymentVersion !== expectedDeploymentVersion).length;
  const apiMismatchCount = expectedApiVersion === null
    ? 0
    : values.filter((value) => value.apiVersion !== expectedApiVersion).length;
  const schemaMismatchCount = expectedSchemaVersion === null
    ? 0
    : values.filter((value) => value.schemaVersion !== expectedSchemaVersion).length;
  const hasValidationFailure = candidateCount === 0 || violations.length > 0 || validRecords.length === 0;
  const releaseBlockerCount = unversionedCount + deploymentMismatchCount + apiMismatchCount + schemaMismatchCount;

  return {
    schemaVersion: "1.0",
    evidenceId: "CO-VRF-TELEMETRY-001",
    product: "Continuity Ops",
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    evidenceStatus: "verified_local_controlled",
    verificationType: "local_controlled_wrangler_request_telemetry_analysis",
    sourceClassification: {
      environment: "local",
      data: "controlled_test_telemetry",
      productionOrStagingEvidence: false,
    },
    result: hasValidationFailure
      ? "failed"
      : releaseBlockerCount > 0
        ? "passed_with_release_blockers"
        : "passed",
    input: {
      ...parsed.lineSummary,
      telemetryRecordCount: parsed.records.length,
      unparseableTelemetryCandidateCount: parsed.unparseableCandidateLines.length,
      telemetryCandidateCount: candidateCount,
    },
    validation: {
      validRecords: ratio(validRecords.length, candidateCount),
      violationCount: violations.length,
      violations,
      allowedFields: [...ALLOWED_FIELDS],
      sensitiveValuesRetained: false,
      rawRequestIdsIncluded: false,
    },
    requestOutcomes: {
      allValidRecords: values.length,
      successful: ratio(successCount, values.length),
      errors: ratio(errorRecords.length, values.length),
      clientErrors: ratio(clientErrorCount, values.length),
      serverErrors: ratio(serverErrorCount, values.length),
      byStatus: sortedCounts(values.map((value) => value.status), "status").map((entry) => ({
        ...entry,
        denominator: values.length,
        percentage: values.length === 0 ? null : round((entry.count / values.length) * 100),
      })),
      byMethod: sortedCounts(values.map((value) => value.method), "method").map((entry) => ({
        ...entry,
        denominator: values.length,
        percentage: values.length === 0 ? null : round((entry.count / values.length) * 100),
      })),
    },
    problemCodes: {
      denominator: errorRecords.length,
      records: sortedCounts(errorRecords.map((value) => value.problemCode), "problemCode").map((entry) => ({
        ...entry,
        denominator: errorRecords.length,
        percentage: errorRecords.length === 0 ? null : round((entry.count / errorRecords.length) * 100),
      })),
    },
    latencyMs: {
      sampleCount: latencies.length,
      denominator: values.length,
      percentileMethod: "nearest_rank",
      minimum: latencies[0] ?? null,
      maximum: latencies.at(-1) ?? null,
      mean: latencies.length === 0 ? null : round(latencySum / latencies.length),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    versions: {
      api: sortedCounts(values.map((value) => value.apiVersion), "version"),
      schema: sortedCounts(values.map((value) => value.schemaVersion), "version"),
      deployment: sortedCounts(values.map((value) => value.deploymentVersion), "version"),
      expectedApiVersion,
      expectedSchemaVersion,
      expectedDeploymentVersion,
      apiMismatch: ratio(apiMismatchCount, values.length),
      schemaMismatch: ratio(schemaMismatchCount, values.length),
      deploymentMismatch: ratio(deploymentMismatchCount, values.length),
      unversioned: ratio(unversionedCount, values.length),
      releaseBlockerCount,
    },
    smokeCorrelation: correlationSummary(options.smokeEvidence ?? null, validRecords),
    limitations: [
      "This report analyzes controlled local Wrangler output only; it is not staging or production observability evidence.",
      "Latency describes only the requests present in the supplied file and does not establish an SLO or load-test result.",
      "Smoke correlation covers only request IDs retained by the smoke evidence document; raw request IDs are never written to this report.",
      "The report does not prove telemetry ingestion, retention, alert delivery, sampling behavior, or incident response in a hosted environment.",
    ],
  };
}
