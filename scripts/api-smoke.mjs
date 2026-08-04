import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PRODUCT_NAME = "Continuity Ops";
const PRODUCT_VERSION = "2.2.0";
const API_EVIDENCE_ID = "CO-VRF-API-001";
const SECURITY_EVIDENCE_ID = "CO-VRF-SEC-001";
const configuredBaseUrl = process.env.CONTINUITY_OPS_BASE_URL ?? "http://localhost:3001";
const parsedBaseUrl = new URL(configuredBaseUrl);
assert.ok(["http:", "https:"].includes(parsedBaseUrl.protocol), "CONTINUITY_OPS_BASE_URL must use HTTP or HTTPS.");
assert.equal(parsedBaseUrl.username, "", "CONTINUITY_OPS_BASE_URL must not contain credentials.");
assert.equal(parsedBaseUrl.password, "", "CONTINUITY_OPS_BASE_URL must not contain credentials.");
const baseUrl = parsedBaseUrl.origin;
const runId = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
const evidenceDirectory = resolve("evidence");
const workerArtifactPath = resolve("dist/server/index.js");
assert.ok(existsSync(workerArtifactPath), "Build Continuity Ops before running the API smoke test.");
const workerArtifactSha256 = createHash("sha256").update(readFileSync(workerArtifactPath)).digest("hex");
const observedRequestIds = [];
const observedResponseStatuses = [];
const positiveChecks = [];
const negativeChecks = [];

function idempotencyKey(label) {
  return `co-smoke-${runId}-${label}`.slice(0, 128);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function markPassed(name, details = undefined) {
  positiveChecks.push({ name, result: "passed", ...(details ? { details } : {}) });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function lifecycleEventIsStrictlyOlder(event, boundary) {
  return event.changedAt < boundary.changedAt
    || (event.changedAt === boundary.changedAt && event.id < boundary.id);
}

function assertLifecycleEventsStrictlyDescending(events) {
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(
      lifecycleEventIsStrictlyOlder(events[index], events[index - 1]),
      `Lifecycle events are not in a strict newest-first order at index ${index}.`,
    );
  }
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, `${baseUrl}/`), {
    redirect: "follow",
    ...options,
  });
  observedResponseStatuses.push(response.status);
  const text = await response.text();
  let body = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { response, body, text };
}

function verifySecurityHeaders(response, expectNoStore = false) {
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-permitted-cross-domain-policies"), "none");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(
    response.headers.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  const contentSecurityPolicy = response.headers.get("content-security-policy") ?? "";
  for (const directive of [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src-attr 'none'",
  ]) {
    assert.ok(contentSecurityPolicy.includes(directive), `The CSP is missing ${directive}.`);
  }
  if (expectNoStore) assert.equal(response.headers.get("cache-control"), "no-store");
  if (parsedBaseUrl.protocol === "https:") {
    assert.match(response.headers.get("strict-transport-security") ?? "", /^max-age=31536000$/);
  } else {
    assert.equal(response.headers.get("strict-transport-security"), null);
  }
}

function verifyApiEnvelope(result) {
  assert.equal(typeof result.body, "object", `Expected a JSON API response, received: ${result.text.slice(0, 500)}`);
  assert.ok(result.body !== null && !Array.isArray(result.body), "The API response must be a JSON object.");
  const responseRequestId = result.response.headers.get("x-request-id");
  assert.match(responseRequestId ?? "", /^req-[0-9a-f-]{36}$/i, "The API response is missing a valid request ID.");
  verifySecurityHeaders(result.response, true);
  observedRequestIds.push(responseRequestId);
  return responseRequestId;
}

function expectSuccess(result, expectedStatus) {
  assert.equal(result.response.status, expectedStatus, result.text);
  assert.match(result.response.headers.get("content-type") ?? "", /^application\/json\b/i);
  const responseRequestId = verifyApiEnvelope(result);
  assert.ok("data" in result.body, "A successful response must contain data.");
  assert.equal(result.body.meta?.requestId, responseRequestId, "The response metadata and header request IDs differ.");
  return result.body.data;
}

function expectProblem(result, expectedStatus, expectedCode, name) {
  assert.equal(result.response.status, expectedStatus, result.text);
  assert.match(result.response.headers.get("content-type") ?? "", /^application\/problem\+json\b/i);
  const responseRequestId = verifyApiEnvelope(result);
  assert.equal(result.body.status, expectedStatus);
  assert.equal(result.body.code, expectedCode);
  assert.equal(result.body.requestId, responseRequestId);
  assert.match(result.body.type, /^https:\/\/continuity-ops\.invalid\/problems\//);
  negativeChecks.push({ name, expectedStatus, expectedCode, requestId: responseRequestId, result: "passed" });
  return result.body;
}

function mutationOptions(method, body, key, overrides = {}) {
  return {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      origin: baseUrl,
      ...overrides.headers,
    },
    body: JSON.stringify(body),
    ...overrides,
  };
}

async function mutate(path, method, body, label, overrides = {}) {
  return request(path, mutationOptions(method, body, idempotencyKey(label), overrides));
}

async function transition(incident, toStatus, note, label) {
  const transitioned = expectSuccess(await mutate(
    `/api/v1/incidents/${incident.id}/transitions`,
    "POST",
    { expectedVersion: incident.version, toStatus, note },
    label,
  ), 200);
  assert.equal(transitioned.incident.status, toStatus);
  assert.equal(transitioned.incident.version, incident.version + 1);
  assert.equal(transitioned.timelineEvent?.toStatus, toStatus);
  return transitioned;
}

// Product surface and baseline security response headers.
const rootPage = await request("/");
assert.equal(rootPage.response.status, 200, rootPage.text.slice(0, 1000));
assert.equal(new URL(rootPage.response.url).pathname, "/operations");
assert.match(rootPage.text, /Continuity Ops/);
verifySecurityHeaders(rootPage.response, true);
const operationsPage = await request("/operations");
assert.equal(operationsPage.response.status, 200, operationsPage.text.slice(0, 1000));
assert.match(operationsPage.text, /Continuity Ops/);
assert.match(operationsPage.text, /\/og\.png/);
assert.doesNotMatch(operationsPage.text, /Recovery Lab|classroom beta|trust-competence-draft|FACILITATOR_KEY/i);
verifySecurityHeaders(operationsPage.response, true);
const socialPreviewResponse = await fetch(new URL("/og.png", `${baseUrl}/`));
observedResponseStatuses.push(socialPreviewResponse.status);
assert.equal(socialPreviewResponse.status, 200);
assert.match(socialPreviewResponse.headers.get("content-type") ?? "", /^image\/png\b/i);
assert.ok((await socialPreviewResponse.arrayBuffer()).byteLength > 100_000);

const healthResponse = await request("/api/v1/health");
const health = expectSuccess(healthResponse, 200);
assert.deepEqual(health, { status: "ok", database: "ok", version: PRODUCT_VERSION });
markPassed("professional root and operations surfaces, social preview, and root/API security headers");
const access = expectSuccess(await request("/api/v1/access"), 200);
assert.equal(access.actor.role, "admin", "The primary smoke sequence requires a local administrative operator.");
assert.match(access.actor.email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
assert.equal(access.organization.id, "ops-singleton");
assert.equal(typeof access.organization.timezone, "string");
assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: access.organization.timezone }));
assert.ok(access.permissions.includes("access:manage"));
assert.ok(access.permissions.includes("incident:command"));
assert.ok(access.permissions.includes("audit:read"));
assert.ok(access.permissions.includes("observability:read"));
const observability = expectSuccess(await request("/api/v1/observability?range=24h"), 200);
assert.equal(observability.window, "24h");
assert.equal(observability.bucketUnit, "hour");
assert.ok(Number.isInteger(observability.summary.totalRequests));
assert.ok(Array.isArray(observability.timeSeries));
assert.ok(Array.isArray(observability.routes));
assert.ok(Array.isArray(observability.recentErrors));
expectProblem(await request("/api/v1/observability?range=1h"), 400, "INVALID_RANGE", "unsupported observability range");
markPassed("health and authenticated administrative access");

// Request-boundary negatives are intentionally not persisted because no actor is established.
const missingOrigin = await request("/api/v1/services", {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": idempotencyKey("missing-origin") },
  body: "{}",
});
expectProblem(missingOrigin, 403, "CROSS_ORIGIN_REQUEST_REJECTED", "state-changing request without Origin");
const invalidContentType = await request("/api/v1/services", {
  method: "POST",
  headers: {
    "content-type": "text/plain",
    "idempotency-key": idempotencyKey("content-type"),
    origin: baseUrl,
  },
  body: "not-json",
});
expectProblem(invalidContentType, 415, "JSON_CONTENT_TYPE_REQUIRED", "non-JSON mutation content type");
const misleadingContentType = await request("/api/v1/services", {
  method: "POST",
  headers: {
    "content-type": "text/plain; note=application/json",
    "idempotency-key": idempotencyKey("misleading-content-type"),
    origin: baseUrl,
  },
});
expectProblem(
  misleadingContentType,
  415,
  "JSON_CONTENT_TYPE_REQUIRED",
  "JSON token embedded in a non-JSON media type",
);
const oversizedRequestBody = await request("/api/v1/services", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey("oversized-request-body"),
    origin: baseUrl,
  },
  body: JSON.stringify({ padding: "x".repeat(32_768) }),
});
expectProblem(oversizedRequestBody, 413, "REQUEST_TOO_LARGE", "request body over 32 KiB");

for (const [label, rawBody, name] of [
  ["scalar-json", JSON.stringify("not-an-object"), "scalar JSON mutation body"],
  ["array-json", JSON.stringify([{ name: "not-an-object" }]), "array JSON mutation body"],
  ["null-json", "null", "null JSON mutation body"],
]) {
  const nonObjectJson = await request("/api/v1/services", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey(label),
      origin: baseUrl,
    },
    body: rawBody,
  });
  expectProblem(nonObjectJson, 400, "INVALID_JSON", name);
}
const malformedUtf8Json = await request("/api/v1/services", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey("malformed-utf8"),
    origin: baseUrl,
  },
  body: new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]),
});
expectProblem(malformedUtf8Json, 400, "INVALID_UTF8", "malformed UTF-8 JSON mutation body");

// Organization membership and last-admin invariant.
const responderMember = expectSuccess(await mutate(
  "/api/v1/access/members",
  "POST",
  { email: `responder.${runId}@example.invalid`, displayName: "Smoke Responder", role: "responder" },
  "member-responder",
), 201).member;
const observerMember = expectSuccess(await mutate(
  "/api/v1/access/members",
  "POST",
  { email: `observer.${runId}@example.invalid`, displayName: "Smoke Observer", role: "observer" },
  "member-observer",
), 201).member;
const replacementCommanderMember = expectSuccess(await mutate(
  "/api/v1/access/members",
  "POST",
  { email: `commander.${runId}@example.invalid`, displayName: "Smoke Commander", role: "commander" },
  "member-commander",
), 201).member;
const members = expectSuccess(await request("/api/v1/access/members"), 200).members;
const operatorMembership = members.find((member) => member.userId === access.actor.id);
assert.ok(operatorMembership, "The current operator membership was not returned by the access API.");
const lastAdmin = await mutate(
  `/api/v1/access/members/${operatorMembership.id}`,
  "PATCH",
  { status: "suspended", expectedVersion: operatorMembership.version },
  "last-admin",
);
expectProblem(lastAdmin, 409, "LAST_ADMIN_REQUIRED", "suspending the final active administrator");
markPassed("member provisioning and active-administrator invariant");

// Concurrent duplicate delivery must create one business row and replay the other response.
const concurrentCreateBody = {
  name: `Concurrent Delivery Service ${runId}`,
  slug: `concurrent-delivery-${runId}`,
  description: "Synthetic service used only to verify simultaneous idempotent delivery.",
  tier: "tier_3",
  ownerEmail: access.actor.email,
  ownerTeam: "Concurrency Verification",
  sloTarget: 99.5,
  runbookUrl: "https://runbooks.example.invalid/concurrent-delivery",
};
const concurrentCreateKey = idempotencyKey("concurrent-service-create");
const concurrentCreateResponses = await Promise.all([
  request("/api/v1/services", mutationOptions("POST", concurrentCreateBody, concurrentCreateKey)),
  request("/api/v1/services", mutationOptions("POST", concurrentCreateBody, concurrentCreateKey)),
]);
assert.deepEqual(
  concurrentCreateResponses.map((result) => result.response.status).sort((left, right) => left - right),
  [200, 201],
  "Two simultaneously dispatched copies must produce one create and one replay response.",
);
const concurrentCreated = expectSuccess(
  concurrentCreateResponses.find((result) => result.response.status === 201),
  201,
);
const concurrentReplayed = expectSuccess(
  concurrentCreateResponses.find((result) => result.response.status === 200),
  200,
);
assert.equal(concurrentCreated.replayed, false);
assert.equal(concurrentReplayed.replayed, true);
assert.equal(concurrentReplayed.service.id, concurrentCreated.service.id);
const concurrentCreateService = concurrentCreated.service;
const concurrentCreateRows = expectSuccess(await request("/api/v1/services"), 200).services
  .filter((item) => item.slug === concurrentCreateBody.slug);
assert.equal(concurrentCreateRows.length, 1);
assert.equal(concurrentCreateRows[0].id, concurrentCreateService.id);
markPassed("simultaneous identical idempotent delivery creates one service and replays one response", {
  concurrentRequests: 2,
  createdResponses: 1,
  replayedResponses: 1,
  distinctBusinessRecords: 1,
});

// Two different requests that race on the same optimistic version must not overwrite each other.
const versionRaceService = expectSuccess(await mutate(
  "/api/v1/services",
  "POST",
  {
    name: `Concurrent Version Service ${runId}`,
    slug: `concurrent-version-${runId}`,
    description: "Synthetic service used only to verify optimistic concurrency.",
    tier: "tier_3",
    ownerEmail: access.actor.email,
    ownerTeam: "Concurrency Verification",
    sloTarget: 99.5,
    runbookUrl: "https://runbooks.example.invalid/concurrent-version",
  },
  "concurrent-version-service-create",
), 201).service;
const competingServiceUpdates = [
  { expectedVersion: versionRaceService.version, description: `Concurrent candidate A ${runId}` },
  { expectedVersion: versionRaceService.version, description: `Concurrent candidate B ${runId}` },
];
const competingServiceResponses = await Promise.all(competingServiceUpdates.map((body, index) => request(
  `/api/v1/services/${versionRaceService.id}`,
  mutationOptions("PATCH", body, idempotencyKey(`concurrent-version-update-${index + 1}`)),
)));
assert.deepEqual(
  competingServiceResponses.map((result) => result.response.status).sort((left, right) => left - right),
  [200, 409],
  "Two different updates using one version must produce one success and one version conflict.",
);
const successfulConcurrentUpdate = competingServiceResponses.find((result) => result.response.status === 200);
const rejectedConcurrentUpdate = competingServiceResponses.find((result) => result.response.status === 409);
const concurrentUpdateData = expectSuccess(successfulConcurrentUpdate, 200);
expectProblem(
  rejectedConcurrentUpdate,
  409,
  "VERSION_CONFLICT",
  "simultaneous service updates using the same expected version",
);
assert.equal(concurrentUpdateData.replayed, false);
assert.equal(concurrentUpdateData.service.version, versionRaceService.version + 1);
assert.ok(
  competingServiceUpdates.some((body) => body.description === concurrentUpdateData.service.description),
  "The successful response must contain exactly one of the competing descriptions.",
);
const versionRaceServiceDetail = expectSuccess(
  await request(`/api/v1/services/${versionRaceService.id}`),
  200,
).service;
assert.equal(versionRaceServiceDetail.version, versionRaceService.version + 1);
assert.equal(versionRaceServiceDetail.description, concurrentUpdateData.service.description);
markPassed("simultaneous optimistic updates preserve one winner and reject one stale write", {
  concurrentRequests: 2,
  successfulUpdates: 1,
  versionConflicts: 1,
  finalVersion: versionRaceServiceDetail.version,
});

// SQL metacharacters and an XSS-shaped string must remain bounded plain JSON data.
const storedXssText = `<script>globalThis.__continuityOpsXss = "${runId}"</script>`;
const sqlMetacharacterText = `SRE'); DROP TABLE ops_services; -- ${runId}`;
const rawAdversarialDescription = `  ${storedXssText}\u0000${sqlMetacharacterText}\r\nplain text only  `;
const normalizedAdversarialDescription = `${storedXssText} ${sqlMetacharacterText}\nplain text only`;
const adversarialServiceBody = {
  name: `Adversarial Text Service ${runId}`,
  slug: `adversarial-text-${runId}`,
  description: rawAdversarialDescription,
  tier: "tier_4",
  ownerEmail: access.actor.email,
  ownerTeam: sqlMetacharacterText,
  sloTarget: 99,
  runbookUrl: "https://runbooks.example.invalid/adversarial-text",
};
const adversarialCreateResult = await mutate(
  "/api/v1/services",
  "POST",
  adversarialServiceBody,
  "adversarial-service-create",
);
let adversarialService = expectSuccess(adversarialCreateResult, 201).service;
assert.equal(adversarialService.description, normalizedAdversarialDescription);
assert.equal(adversarialService.ownerTeam, sqlMetacharacterText);
const adversarialServiceDetail = expectSuccess(
  await request(`/api/v1/services/${adversarialService.id}`),
  200,
).service;
assert.equal(adversarialServiceDetail.description, normalizedAdversarialDescription);
assert.equal(adversarialServiceDetail.ownerTeam, sqlMetacharacterText);
const adversarialListRows = expectSuccess(await request("/api/v1/services"), 200).services
  .filter((item) => item.slug === adversarialServiceBody.slug);
assert.equal(adversarialListRows.length, 1);
assert.equal(adversarialListRows[0].description, normalizedAdversarialDescription);
assert.equal(adversarialListRows[0].ownerTeam, sqlMetacharacterText);
markPassed("SQL metacharacters and an XSS-shaped value round-trip only as normalized JSON text", {
  storedRows: 1,
  responseMediaType: adversarialCreateResult.response.headers.get("content-type"),
});

const maximumDescription = "b".repeat(600);
adversarialService = expectSuccess(await mutate(
  `/api/v1/services/${adversarialService.id}`,
  "PATCH",
  { expectedVersion: adversarialService.version, description: maximumDescription },
  "service-description-maximum",
), 200).service;
assert.equal(adversarialService.description, maximumDescription);
assert.equal(adversarialService.description.length, 600);
assert.equal(
  expectSuccess(await request(`/api/v1/services/${adversarialService.id}`), 200).service.description,
  maximumDescription,
);
markPassed("control characters are normalized and the exact 600-character description boundary is accepted", {
  normalizedControlCharacters: true,
  acceptedDescriptionLength: adversarialService.description.length,
});

// Service creation, response round-trip, idempotency, update, stale write, and immutable slug.
const serviceBody = {
  name: `Continuity Verification Service ${runId}`,
  slug: `verification-${runId}`,
  description: "Isolated service record used to verify the Continuity Ops local API contract.",
  tier: "tier_1",
  ownerEmail: access.actor.email,
  ownerTeam: "Service Reliability",
  sloTarget: 99.95,
  runbookUrl: "https://runbooks.example.invalid/continuity-verification",
};
const serviceKey = idempotencyKey("service-create");
const createdService = expectSuccess(await request(
  "/api/v1/services",
  mutationOptions("POST", serviceBody, serviceKey),
), 201);
assert.equal(createdService.replayed, false);
let service = createdService.service;
assert.equal(service.version, 1);
assert.equal(service.ownerUserId, access.actor.id);
assert.equal(service.runbookUrl, serviceBody.runbookUrl);
const replayedService = expectSuccess(await request(
  "/api/v1/services",
  mutationOptions("POST", serviceBody, serviceKey),
), 200);
assert.equal(replayedService.replayed, true);
assert.equal(replayedService.service.id, service.id);
const reusedServiceKey = await request(
  "/api/v1/services",
  mutationOptions("POST", { ...serviceBody, description: "Changed content using the same key." }, serviceKey),
);
expectProblem(reusedServiceKey, 409, "IDEMPOTENCY_KEY_REUSED", "idempotency key reused with different service content");
const duplicateService = await mutate(
  "/api/v1/services",
  "POST",
  { ...serviceBody, name: `${serviceBody.name} duplicate` },
  "duplicate-service",
);
expectProblem(duplicateService, 409, "RESOURCE_ALREADY_EXISTS", "duplicate service slug");
const oversizedServiceDescription = await mutate(
  `/api/v1/services/${service.id}`,
  "PATCH",
  { expectedVersion: service.version, description: "x".repeat(601) },
  "service-description-oversized",
);
expectProblem(
  oversizedServiceDescription,
  400,
  "INVALID_FIELD",
  "oversized service description rejected instead of truncated",
);

const servicePatchBody = {
  expectedVersion: service.version,
  description: "Service record updated through the versioned maintenance contract.",
  ownerTeam: "Identity Reliability",
  sloTarget: 99.97,
  runbookUrl: "https://runbooks.example.invalid/continuity-verification/v2",
};
const servicePatchKey = idempotencyKey("service-patch");
const patchedService = expectSuccess(await request(
  `/api/v1/services/${service.id}`,
  mutationOptions("PATCH", servicePatchBody, servicePatchKey),
), 200);
service = patchedService.service;
assert.equal(service.version, 2);
assert.equal(service.ownerTeam, "Identity Reliability");
assert.equal(service.sloTarget, 99.97);
assert.equal(service.runbookUrl, servicePatchBody.runbookUrl);
const replayedServicePatch = expectSuccess(await request(
  `/api/v1/services/${service.id}`,
  mutationOptions("PATCH", servicePatchBody, servicePatchKey),
), 200);
assert.equal(replayedServicePatch.replayed, true);
assert.equal(replayedServicePatch.service.version, 2);
const staleServicePatch = await mutate(
  `/api/v1/services/${service.id}`,
  "PATCH",
  { expectedVersion: 1, description: "A stale update must not be applied." },
  "service-stale",
);
expectProblem(staleServicePatch, 409, "VERSION_CONFLICT", "stale service version");
const immutableSlug = await mutate(
  `/api/v1/services/${service.id}`,
  "PATCH",
  { expectedVersion: service.version, slug: `${service.slug}-changed` },
  "service-slug-immutable",
);
expectProblem(immutableSlug, 400, "SERVICE_SLUG_IMMUTABLE", "attempt to change immutable service slug");
const serviceDetail = expectSuccess(await request(`/api/v1/services/${service.id}`), 200).service;
assert.equal(serviceDetail.runbookUrl, servicePatchBody.runbookUrl);
markPassed("service create, replay, versioned PATCH, stale-write guard, and runbook round-trip");

// Incident starts without recovery criteria so every resolution gate can be demonstrated independently.
const incidentBody = {
  title: `Authorization latency verification ${runId}`,
  summary: "Authorization latency exceeded the service objective during an isolated local verification run.",
  severity: "sev2",
  serviceId: service.id,
  environment: "production",
  impactSummary: "Requests are delayed while the verification incident remains isolated from production traffic.",
  currentHypothesis: "Connection demand may be exceeding the configured pool capacity.",
  currentMitigation: "The run is recording investigation steps without executing production changes.",
};
const incidentKey = idempotencyKey("incident-create");
const createdIncident = expectSuccess(await request(
  "/api/v1/incidents",
  mutationOptions("POST", incidentBody, incidentKey),
), 201);
let incident = createdIncident.incident;
assert.equal(incident.status, "declared");
assert.equal(incident.version, 1);
assert.equal(incident.verificationCriteria, "");
assert.deepEqual(incident.commander, { id: access.actor.id, displayName: access.actor.displayName });
const replayedIncident = expectSuccess(await request(
  "/api/v1/incidents",
  mutationOptions("POST", incidentBody, incidentKey),
), 200);
assert.equal(replayedIncident.replayed, true);
assert.equal(replayedIncident.incident.id, incident.id);
markPassed("incident creation and idempotent replay");

const serviceWithOpenIncident = await mutate(
  `/api/v1/services/${service.id}`,
  "PATCH",
  {
    expectedVersion: service.version,
    status: "deprecated",
    statusChangeReason: "The replacement is ready, but this open incident must be closed before deprecation.",
    lifecycleConfirmed: true,
  },
  "service-open-incident",
);
expectProblem(
  serviceWithOpenIncident,
  409,
  "SERVICE_HAS_OPEN_INCIDENTS",
  "deprecating a service with an open incident",
);

const earlyReview = await mutate(
  `/api/v1/incidents/${incident.id}/review`,
  "PUT",
  { expectedVersion: 0, status: "draft", summary: "Premature review notes." },
  "early-review",
);
expectProblem(earlyReview, 409, "INCIDENT_NOT_RESOLVED", "review before incident resolution");
const unknownReviewStatus = await mutate(
  `/api/v1/incidents/${incident.id}/review`,
  "PUT",
  { expectedVersion: 0, status: "complete" },
  "unknown-review-status",
);
expectProblem(unknownReviewStatus, 400, "INVALID_REVIEW_STATUS", "unknown post-incident review status");
const invalidTransition = await mutate(
  `/api/v1/incidents/${incident.id}/transitions`,
  "POST",
  { expectedVersion: incident.version, toStatus: "resolved", note: "Direct resolution must be rejected." },
  "invalid-transition",
);
expectProblem(invalidTransition, 403, "TRANSITION_NOT_ALLOWED", "invalid declared-to-resolved transition");

// Incident assignments and role relationship guard.
const invalidCommanderAssignment = await mutate(
  `/api/v1/incidents/${incident.id}/assignments`,
  "POST",
  { userId: observerMember.userId, incidentRole: "incident_commander" },
  "invalid-commander-assignment",
);
expectProblem(invalidCommanderAssignment, 400, "INCIDENT_ROLE_INCOMPATIBLE", "observer assigned as incident commander");
const responderAssignment = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/assignments`,
  "POST",
  { userId: responderMember.userId, incidentRole: "responder" },
  "assign-responder",
), 201).assignment;
let observerAssignment = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/assignments`,
  "POST",
  { userId: observerMember.userId, incidentRole: "observer" },
  "assign-observer",
), 201).assignment;
assert.equal(responderAssignment.status, "active");
assert.equal(observerAssignment.status, "active");
const initialIncidentDetail = expectSuccess(await request(`/api/v1/incidents/${incident.id}`), 200);
const originalCommanderAssignment = initialIncidentDetail.assignments.find(
  (assignment) => assignment.userId === access.actor.id && assignment.incidentRole === "incident_commander",
);
assert.ok(originalCommanderAssignment, "The incident creator must have an active incident commander assignment.");
assert.deepEqual(initialIncidentDetail.incident.commander, { id: access.actor.id, displayName: access.actor.displayName });
const initialIncidentListItem = expectSuccess(await request("/api/v1/incidents"), 200).incidents.find((item) => item.id === incident.id);
const initialOverviewItem = expectSuccess(await request("/api/v1/overview"), 200).recentIncidents.find((item) => item.id === incident.id);
assert.deepEqual(initialIncidentListItem?.commander, initialIncidentDetail.incident.commander);
assert.deepEqual(initialOverviewItem?.commander, initialIncidentDetail.incident.commander);
markPassed("qualified commander assignment and consistent detail, list, and overview projection");

// Incident update and task evidence round-trip.
incident = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}`,
  "PATCH",
  {
    expectedVersion: incident.version,
    currentHypothesis: "Database connection saturation is the leading hypothesis for the isolated incident.",
  },
  "incident-update",
), 200).incident;
assert.equal(incident.version, 2);
const taskEvidenceUrl = "https://observability.example.invalid/tasks/critical-recovery";
let criticalTask = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/tasks`,
  "POST",
  {
    title: "Validate critical recovery path",
    description: "Verify the customer path and data integrity before resolution.",
    priority: "critical",
    assigneeUserId: responderMember.userId,
    evidenceRef: taskEvidenceUrl,
  },
  "task-critical-create",
), 201).task;
assert.equal(criticalTask.status, "open");
assert.equal(criticalTask.evidenceRef, taskEvidenceUrl);
const taskList = expectSuccess(await request(`/api/v1/incidents/${incident.id}/tasks`), 200).tasks;
assert.equal(taskList.find((task) => task.id === criticalTask.id)?.evidenceRef, taskEvidenceUrl);
markPassed("critical task creation and HTTPS evidenceRef round-trip");

let evidenceRequiredTask = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/tasks`,
  "POST",
  {
    title: "Record operator handoff verification",
    description: "Capture durable evidence for the completed operational handoff.",
    priority: "medium",
    assigneeUserId: responderMember.userId,
  },
  "task-evidence-required-create",
), 201).task;
const completionWithoutEvidence = await mutate(
  `/api/v1/incidents/${incident.id}/tasks/${evidenceRequiredTask.id}`,
  "PATCH",
  { expectedVersion: evidenceRequiredTask.version, status: "completed" },
  "task-complete-without-evidence",
);
expectProblem(
  completionWithoutEvidence,
  409,
  "TASK_EVIDENCE_REQUIRED",
  "task completion without HTTPS evidence",
);
const taskAfterRejectedCompletion = expectSuccess(
  await request(`/api/v1/incidents/${incident.id}/tasks`),
  200,
).tasks.find((task) => task.id === evidenceRequiredTask.id);
assert.equal(taskAfterRejectedCompletion?.status, "open");
assert.equal(taskAfterRejectedCompletion?.version, evidenceRequiredTask.version);
assert.equal(taskAfterRejectedCompletion?.evidenceRef, null);
const completionWithNonHttpsEvidence = await mutate(
  `/api/v1/incidents/${incident.id}/tasks/${evidenceRequiredTask.id}`,
  "PATCH",
  {
    expectedVersion: evidenceRequiredTask.version,
    status: "completed",
    evidenceRef: "http://observability.example.invalid/tasks/operator-handoff/completed",
  },
  "task-complete-with-non-https-evidence",
);
expectProblem(
  completionWithNonHttpsEvidence,
  400,
  "INVALID_URL",
  "task completion with non-HTTPS evidence",
);
const handoffEvidenceUrl = "https://observability.example.invalid/tasks/operator-handoff/completed";
evidenceRequiredTask = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/tasks/${evidenceRequiredTask.id}`,
  "PATCH",
  {
    expectedVersion: evidenceRequiredTask.version,
    status: "completed",
    evidenceRef: handoffEvidenceUrl,
  },
  "task-complete-with-evidence",
), 200).task;
assert.equal(evidenceRequiredTask.status, "completed");
assert.equal(evidenceRequiredTask.evidenceRef, handoffEvidenceUrl);
assert.equal(evidenceRequiredTask.version, 2);
markPassed("task completion requires and persists HTTPS evidence");

// First lifecycle reaches monitoring; monitoring transition is replayed after it changed incident state.
incident = (await transition(incident, "investigating", "Investigation ownership and scope are confirmed.", "transition-investigating-1")).incident;

// Structured communications use a draft -> reviewed -> published workflow.
const communicationPath = `/api/v1/incidents/${incident.id}/communications`;
let scheduledCommunication = expectSuccess(await mutate(
  communicationPath,
  "POST",
  {
    audience: "stakeholder",
    message: "Recovery is progressing, but verification is not yet complete.",
    affectedComponents: ["Authorization API"],
  },
  "communication-missing-schedule-create",
), 201).communication;
const publishUnreviewedCommunication = await mutate(
  `${communicationPath}/${scheduledCommunication.id}`,
  "PATCH",
  { expectedVersion: scheduledCommunication.version, action: "publish" },
  "communication-publish-unreviewed",
);
expectProblem(
  publishUnreviewedCommunication,
  409,
  "COMMUNICATION_STATUS_CONFLICT",
  "publishing an unreviewed communication",
);
const reviewWithoutSchedule = await mutate(
  `${communicationPath}/${scheduledCommunication.id}`,
  "PATCH",
  { expectedVersion: scheduledCommunication.version, action: "review" },
  "communication-missing-schedule-review",
);
expectProblem(
  reviewWithoutSchedule,
  409,
  "COMMUNICATION_NEXT_UPDATE_REQUIRED",
  "reviewing an external communication without a future next update or explicit final marker",
);
const communicationAfterRejectedReview = expectSuccess(await request(communicationPath), 200).communications
  .find((item) => item.id === scheduledCommunication.id);
assert.equal(communicationAfterRejectedReview?.status, "draft");
assert.equal(communicationAfterRejectedReview?.version, scheduledCommunication.version);
const scheduledNextUpdateAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
scheduledCommunication = expectSuccess(await mutate(
  `${communicationPath}/${scheduledCommunication.id}`,
  "PATCH",
  { expectedVersion: scheduledCommunication.version, nextUpdateAt: scheduledNextUpdateAt },
  "communication-schedule-update",
), 200).communication;
scheduledCommunication = expectSuccess(await mutate(
  `${communicationPath}/${scheduledCommunication.id}`,
  "PATCH",
  { expectedVersion: scheduledCommunication.version, action: "review" },
  "communication-scheduled-review",
), 200).communication;
scheduledCommunication = expectSuccess(await mutate(
  `${communicationPath}/${scheduledCommunication.id}`,
  "PATCH",
  { expectedVersion: scheduledCommunication.version, action: "publish" },
  "communication-scheduled-publish",
), 200).communication;
assert.equal(scheduledCommunication.status, "published");
assert.equal(scheduledCommunication.nextUpdateAt, scheduledNextUpdateAt);

const finalCommunicationToken = `communication-body-${runId}`;
const finalCommunicationBody = {
  audience: "public",
  message: `[FINAL] Recovery verification is complete (${finalCommunicationToken}).`,
  affectedComponents: ["Authorization API", "Session Gateway"],
};
const finalCommunicationKey = idempotencyKey("communication-final-create");
let finalCommunication = expectSuccess(await request(
  communicationPath,
  mutationOptions("POST", finalCommunicationBody, finalCommunicationKey),
), 201).communication;
const replayedFinalCommunicationCreate = expectSuccess(await request(
  communicationPath,
  mutationOptions("POST", finalCommunicationBody, finalCommunicationKey),
), 200);
assert.equal(replayedFinalCommunicationCreate.replayed, true);
assert.equal(replayedFinalCommunicationCreate.communication.id, finalCommunication.id);

const finalDraftUpdateBody = {
  expectedVersion: finalCommunication.version,
  affectedComponents: ["Authorization API", "Session Gateway", "Regional Edge"],
};
const finalDraftUpdateKey = idempotencyKey("communication-final-update");
finalCommunication = expectSuccess(await request(
  `${communicationPath}/${finalCommunication.id}`,
  mutationOptions("PATCH", finalDraftUpdateBody, finalDraftUpdateKey),
), 200).communication;
assert.equal(finalCommunication.version, 2);
assert.deepEqual(finalCommunication.affectedComponents, ["Authorization API", "Session Gateway", "Regional Edge"]);
const replayedFinalDraftUpdate = expectSuccess(await request(
  `${communicationPath}/${finalCommunication.id}`,
  mutationOptions("PATCH", finalDraftUpdateBody, finalDraftUpdateKey),
), 200);
assert.equal(replayedFinalDraftUpdate.replayed, true);
assert.equal(replayedFinalDraftUpdate.communication.version, finalCommunication.version);
const staleCommunicationUpdate = await mutate(
  `${communicationPath}/${finalCommunication.id}`,
  "PATCH",
  { expectedVersion: 1, message: `[FINAL] Stale replacement (${finalCommunicationToken}).` },
  "communication-final-stale-update",
);
expectProblem(staleCommunicationUpdate, 409, "VERSION_CONFLICT", "stale communication draft update");

const finalReviewBody = { expectedVersion: finalCommunication.version, action: "review" };
const finalReviewKey = idempotencyKey("communication-final-review");
finalCommunication = expectSuccess(await request(
  `${communicationPath}/${finalCommunication.id}`,
  mutationOptions("PATCH", finalReviewBody, finalReviewKey),
), 200).communication;
assert.equal(finalCommunication.status, "reviewed");
assert.equal(finalCommunication.version, 3);
const replayedFinalReview = expectSuccess(await request(
  `${communicationPath}/${finalCommunication.id}`,
  mutationOptions("PATCH", finalReviewBody, finalReviewKey),
), 200);
assert.equal(replayedFinalReview.replayed, true);
assert.equal(replayedFinalReview.communication.reviewedAt, finalCommunication.reviewedAt);

const finalPublishBody = { expectedVersion: finalCommunication.version, action: "publish" };
const finalPublishKey = idempotencyKey("communication-final-publish");
finalCommunication = expectSuccess(await request(
  `${communicationPath}/${finalCommunication.id}`,
  mutationOptions("PATCH", finalPublishBody, finalPublishKey),
), 200).communication;
assert.equal(finalCommunication.status, "published");
assert.equal(finalCommunication.version, 4);
assert.equal(finalCommunication.nextUpdateAt, null);
const replayedFinalPublish = expectSuccess(await request(
  `${communicationPath}/${finalCommunication.id}`,
  mutationOptions("PATCH", finalPublishBody, finalPublishKey),
), 200);
assert.equal(replayedFinalPublish.replayed, true);
assert.equal(replayedFinalPublish.communication.publishedAt, finalCommunication.publishedAt);

let terminalCommunication = expectSuccess(await mutate(
  communicationPath,
  "POST",
  {
    audience: "internal",
    message: "This reviewed internal update is reserved for the terminal-state publication guard.",
    affectedComponents: ["Authorization API"],
  },
  "communication-terminal-create",
), 201).communication;
terminalCommunication = expectSuccess(await mutate(
  `${communicationPath}/${terminalCommunication.id}`,
  "PATCH",
  { expectedVersion: terminalCommunication.version, action: "review" },
  "communication-terminal-review",
), 200).communication;
const communicationList = expectSuccess(await request(communicationPath), 200).communications;
assert.equal(communicationList.length, 3);
assert.equal(communicationList.find((item) => item.id === finalCommunication.id)?.status, "published");
markPassed("structured communication review prerequisites, scheduled/final publication, replay, and version guards");

incident = (await transition(incident, "mitigating", "The mitigation plan is approved and tracked.", "transition-mitigating-1")).incident;
const monitoringBody = {
  expectedVersion: incident.version,
  toStatus: "monitoring",
  note: "The mitigation is complete and current-cycle verification has started.",
};
const monitoringKey = idempotencyKey("transition-monitoring-1");
const monitoringTransition = expectSuccess(await request(
  `/api/v1/incidents/${incident.id}/transitions`,
  mutationOptions("POST", monitoringBody, monitoringKey),
), 200);
incident = monitoringTransition.incident;
assert.equal(incident.status, "monitoring");
assert.equal(monitoringTransition.replayed, false);
const replayedMonitoringTransition = expectSuccess(await request(
  `/api/v1/incidents/${incident.id}/transitions`,
  mutationOptions("POST", monitoringBody, monitoringKey),
), 200);
assert.equal(replayedMonitoringTransition.replayed, true);
assert.equal(replayedMonitoringTransition.incident.version, incident.version);
assert.equal(replayedMonitoringTransition.timelineEvent.id, monitoringTransition.timelineEvent.id);
markPassed("state-changing transition early replay");

// Resolution gate 1: criteria must be present.
const missingCriteria = await mutate(
  `/api/v1/incidents/${incident.id}/transitions`,
  "POST",
  { expectedVersion: incident.version, toStatus: "resolved", note: "Attempt without recovery criteria." },
  "resolve-missing-criteria",
);
expectProblem(missingCriteria, 409, "RESOLUTION_CRITERIA_REQUIRED", "resolution without verification criteria");
incident = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}`,
  "PATCH",
  {
    expectedVersion: incident.version,
    verificationCriteria: "Three regional probes remain healthy and the customer sign-in path succeeds without data errors.",
  },
  "incident-criteria",
), 200).incident;

// Resolution gate 2: evidence must be recorded after this monitoring cycle began.
const missingVerification = await mutate(
  `/api/v1/incidents/${incident.id}/transitions`,
  "POST",
  { expectedVersion: incident.version, toStatus: "resolved", note: "Attempt before recording current evidence." },
  "resolve-missing-verification-1",
);
expectProblem(
  missingVerification,
  409,
  "RESOLUTION_VERIFICATION_REQUIRED",
  "resolution without current monitoring-cycle verification evidence",
);

// Evidence metadata validation negatives.
const invalidEvidenceUrl = await mutate(
  `/api/v1/incidents/${incident.id}/timeline`,
  "POST",
  { eventType: "verification", message: "Invalid reference URL.", referenceUrl: "http://untrusted.invalid/evidence" },
  "timeline-invalid-url",
);
expectProblem(invalidEvidenceUrl, 400, "INVALID_URL", "non-HTTPS timeline evidence URL");
const invalidObservationWindow = await mutate(
  `/api/v1/incidents/${incident.id}/timeline`,
  "POST",
  {
    eventType: "verification",
    message: "Invalid observation window.",
    observedFrom: "2026-07-31T10:10:00.000Z",
    observedTo: "2026-07-31T10:00:00.000Z",
  },
  "timeline-invalid-window",
);
expectProblem(invalidObservationWindow, 400, "INVALID_OBSERVATION_WINDOW", "reversed evidence observation window");
const invalidDigest = await mutate(
  `/api/v1/incidents/${incident.id}/timeline`,
  "POST",
  { eventType: "verification", message: "Invalid digest.", sha256Digest: "not-a-sha256" },
  "timeline-invalid-digest",
);
expectProblem(invalidDigest, 400, "INVALID_SHA256_DIGEST", "invalid evidence SHA-256 digest");

const firstEvidenceDigest = sha256(`continuity-ops-${runId}-cycle-1`);
const firstVerification = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/timeline`,
  "POST",
  {
    eventType: "verification",
    message: "Regional synthetic probes and the customer sign-in path remained healthy.",
    referenceUrl: "https://observability.example.invalid/evidence/cycle-1",
    sourceLabel: "Regional synthetic probes",
    observedFrom: "2026-07-31T10:00:00.000Z",
    observedTo: "2026-07-31T10:05:00.000Z",
    sha256Digest: firstEvidenceDigest,
  },
  "timeline-verification-1",
), 201).event;
assert.equal(firstVerification.referenceUrl, "https://observability.example.invalid/evidence/cycle-1");
assert.equal(firstVerification.sourceLabel, "Regional synthetic probes");
assert.equal(firstVerification.observedFrom, "2026-07-31T10:00:00.000Z");
assert.equal(firstVerification.observedTo, "2026-07-31T10:05:00.000Z");
assert.equal(firstVerification.sha256Digest, firstEvidenceDigest);
const firstTimeline = expectSuccess(await request(`/api/v1/incidents/${incident.id}/timeline`), 200).events;
const persistedFirstVerification = firstTimeline.find((event) => event.id === firstVerification.id);
assert.deepEqual(
  {
    referenceUrl: persistedFirstVerification?.referenceUrl,
    sourceLabel: persistedFirstVerification?.sourceLabel,
    observedFrom: persistedFirstVerification?.observedFrom,
    observedTo: persistedFirstVerification?.observedTo,
    sha256Digest: persistedFirstVerification?.sha256Digest,
  },
  {
    referenceUrl: firstVerification.referenceUrl,
    sourceLabel: firstVerification.sourceLabel,
    observedFrom: firstVerification.observedFrom,
    observedTo: firstVerification.observedTo,
    sha256Digest: firstVerification.sha256Digest,
  },
);
markPassed("verification metadata validation and persistence round-trip");

// Resolution gate 3: open critical work blocks resolution.
const openCriticalTask = await mutate(
  `/api/v1/incidents/${incident.id}/transitions`,
  "POST",
  { expectedVersion: incident.version, toStatus: "resolved", note: "Attempt while critical work remains open." },
  "resolve-open-critical",
);
expectProblem(openCriticalTask, 409, "RESOLUTION_CRITICAL_TASKS_OPEN", "resolution with an open critical task");
const undocumentedCriticalCancellation = await mutate(
  `/api/v1/incidents/${incident.id}/tasks/${criticalTask.id}`,
  "PATCH",
  { expectedVersion: criticalTask.version, status: "cancelled" },
  "task-critical-cancel-without-reason",
);
expectProblem(
  undocumentedCriticalCancellation,
  409,
  "TASK_CANCELLATION_REASON_REQUIRED",
  "critical task cancellation without a reason",
);
const downgradedCriticalCancellation = await mutate(
  `/api/v1/incidents/${incident.id}/tasks/${criticalTask.id}`,
  "PATCH",
  { expectedVersion: criticalTask.version, priority: "high", status: "cancelled" },
  "task-critical-downgrade-and-cancel-without-reason",
);
expectProblem(
  downgradedCriticalCancellation,
  409,
  "TASK_CANCELLATION_REASON_REQUIRED",
  "critical task downgrade and cancellation without a reason",
);
markPassed("critical task cancellation requires a durable reason, including same-request priority downgrade");
criticalTask = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/tasks/${criticalTask.id}`,
  "PATCH",
  {
    expectedVersion: criticalTask.version,
    status: "completed",
    evidenceRef: "https://observability.example.invalid/tasks/critical-recovery/completed",
  },
  "task-critical-complete",
), 200).task;
assert.equal(criticalTask.status, "completed");
assert.equal(criticalTask.evidenceRef, "https://observability.example.invalid/tasks/critical-recovery/completed");
incident = (await transition(
  incident,
  "resolved",
  "Current-cycle verification passed and every critical task is complete.",
  "transition-resolved-1",
)).incident;
markPassed("all three atomic resolution-readiness gates and successful resolution");

// PIR: partial draft, early replay after creation changed state, strict status/content, completion, and replay.
const draftReviewBody = { expectedVersion: 0, status: "draft", summary: "Initial review notes." };
const draftReviewKey = idempotencyKey("review-draft-create");
const createdDraftReview = expectSuccess(await request(
  `/api/v1/incidents/${incident.id}/review`,
  mutationOptions("PUT", draftReviewBody, draftReviewKey),
), 201);
let review = createdDraftReview.review;
assert.equal(review.status, "draft");
assert.equal(review.version, 1);
assert.equal(review.rootCause, "");
const replayedDraftReview = expectSuccess(await request(
  `/api/v1/incidents/${incident.id}/review`,
  mutationOptions("PUT", draftReviewBody, draftReviewKey),
), 200);
assert.equal(replayedDraftReview.replayed, true);
assert.equal(replayedDraftReview.review.version, 1);
const incompleteCompletedReview = await mutate(
  `/api/v1/incidents/${incident.id}/review`,
  "PUT",
  { expectedVersion: review.version, status: "completed" },
  "review-incomplete-completed",
);
expectProblem(
  incompleteCompletedReview,
  400,
  "REVIEW_SECTIONS_INCOMPLETE",
  "completed review with incomplete sections",
);
review = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/review`,
  "PUT",
  {
    expectedVersion: review.version,
    status: "draft",
    rootCause: "Connection demand exceeded the represented capacity.",
    detectionGap: "Signals did not distinguish saturation quickly enough.",
  },
  "review-draft-update",
), 200).review;
assert.equal(review.version, 2);
const completedReviewBody = {
  expectedVersion: review.version,
  status: "completed",
  summary: "The isolated incident was contained and the defined service-health criteria were restored.",
  customerImpact: "No external customer traffic was used; the scenario models delayed authorization responses.",
  rootCause: "Connection demand exceeded the configured capacity represented by the verification scenario.",
  detectionGap: "The initial signal did not distinguish queue saturation from downstream latency quickly enough.",
  lessonsLearned: "Capacity and dependency indicators should be reviewed together during investigation.",
  followUpActions: "Add saturation alerts and validate the alert route in a controlled staging exercise.",
};
const completedReviewKey = idempotencyKey("review-complete-1");
const completedReview = expectSuccess(await request(
  `/api/v1/incidents/${incident.id}/review`,
  mutationOptions("PUT", completedReviewBody, completedReviewKey),
), 200);
review = completedReview.review;
assert.equal(review.status, "completed");
assert.equal(review.version, 3);
const replayedCompletedReview = expectSuccess(await request(
  `/api/v1/incidents/${incident.id}/review`,
  mutationOptions("PUT", completedReviewBody, completedReviewKey),
), 200);
assert.equal(replayedCompletedReview.replayed, true);
assert.equal(replayedCompletedReview.review.version, 3);
markPassed("partial PIR draft, strict completion, and stateful replay");

// Reopening atomically invalidates the completed PIR and resets the monitoring-cycle timestamp.
incident = (await transition(
  incident,
  "investigating",
  "New evidence requires the incident to be reopened for another recovery cycle.",
  "transition-reopen",
)).incident;
assert.equal(incident.mitigatedAt, null);
let reopenedDetail = expectSuccess(await request(`/api/v1/incidents/${incident.id}`), 200);
review = reopenedDetail.review;
assert.equal(review.status, "draft");
assert.equal(review.version, 4);
const reopenedTimeline = expectSuccess(await request(`/api/v1/incidents/${incident.id}/timeline`), 200).events;
assert.ok(reopenedTimeline.some(
  (event) => event.eventType === "review" && /returned to draft/i.test(event.message),
));
markPassed("atomic incident reopen resets mitigatedAt and returns completed PIR to draft");

// A prior-cycle verification event must not authorize the second resolution.
incident = (await transition(incident, "mitigating", "The revised mitigation is approved and tracked.", "transition-mitigating-2")).incident;
await delay(10);
incident = (await transition(incident, "monitoring", "The revised mitigation is complete; a new observation cycle begins.", "transition-monitoring-2")).incident;
const priorCycleEvidence = await mutate(
  `/api/v1/incidents/${incident.id}/transitions`,
  "POST",
  { expectedVersion: incident.version, toStatus: "resolved", note: "Old-cycle evidence must not satisfy this resolution." },
  "resolve-old-cycle-evidence",
);
expectProblem(
  priorCycleEvidence,
  409,
  "RESOLUTION_VERIFICATION_REQUIRED",
  "resolution using only prior monitoring-cycle verification evidence",
);
const secondEvidenceDigest = sha256(`continuity-ops-${runId}-cycle-2`);
const secondVerification = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/timeline`,
  "POST",
  {
    eventType: "verification",
    message: "Second-cycle probes and the sign-in path remained healthy after the revised mitigation.",
    referenceUrl: "https://observability.example.invalid/evidence/cycle-2",
    sourceLabel: "Second-cycle recovery probes",
    sha256Digest: secondEvidenceDigest,
  },
  "timeline-verification-2",
), 201).event;
assert.equal(secondVerification.sha256Digest, secondEvidenceDigest);
incident = (await transition(
  incident,
  "resolved",
  "Second-cycle verification passed after the revised monitoring window began.",
  "transition-resolved-2",
)).incident;
review = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/review`,
  "PUT",
  { ...completedReviewBody, expectedVersion: review.version, status: "completed" },
  "review-complete-2",
), 200).review;
assert.equal(review.status, "completed");
assert.equal(review.version, 5);
incident = (await transition(
  incident,
  "closed",
  "The incident record, review, and follow-up ownership are complete.",
  "transition-closed",
)).incident;
const terminalCommunicationPublish = await mutate(
  `${communicationPath}/${terminalCommunication.id}`,
  "PATCH",
  { expectedVersion: terminalCommunication.version, action: "publish" },
  "communication-terminal-publish",
);
expectProblem(
  terminalCommunicationPublish,
  409,
  "INCIDENT_COMMUNICATION_PUBLISH_BLOCKED",
  "publishing a communication after incident closure",
);
markPassed("second monitoring cycle rejects old evidence and accepts new verification");

// Soft revoke keeps history and permits reassignment of the same role.
const revokedObserver = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/assignments/${observerAssignment.id}`,
  "DELETE",
  {},
  "revoke-observer",
), 200);
assert.equal(revokedObserver.revokedAssignmentId, observerAssignment.id);
assert.equal(revokedObserver.replacementAssignment, null);
let assignmentDetail = expectSuccess(await request(`/api/v1/incidents/${incident.id}`), 200);
assert.ok(!assignmentDetail.assignments.some((assignment) => assignment.id === observerAssignment.id));
observerAssignment = expectSuccess(await mutate(
  `/api/v1/incidents/${incident.id}/assignments`,
  "POST",
  { userId: observerMember.userId, incidentRole: "observer" },
  "reassign-observer",
), 201).assignment;
assert.notEqual(observerAssignment.id, revokedObserver.revokedAssignmentId);
markPassed("assignment soft revoke, active-only detail, and same-role reassignment");

// The final commander cannot be revoked without an atomic qualified handoff.
const missingCommanderReplacement = await mutate(
  `/api/v1/incidents/${incident.id}/assignments/${originalCommanderAssignment.id}`,
  "DELETE",
  {},
  "revoke-final-commander",
);
expectProblem(
  missingCommanderReplacement,
  409,
  "INCIDENT_COMMANDER_REQUIRED",
  "revoking the final commander without replacement",
);
const commanderHandoffBody = { replacementUserId: replacementCommanderMember.userId };
const commanderHandoffKey = idempotencyKey("commander-handoff");
const commanderHandoff = expectSuccess(await request(
  `/api/v1/incidents/${incident.id}/assignments/${originalCommanderAssignment.id}`,
  mutationOptions("DELETE", commanderHandoffBody, commanderHandoffKey),
), 200);
assert.equal(commanderHandoff.replayed, false);
assert.equal(commanderHandoff.revokedAssignmentId, originalCommanderAssignment.id);
assert.equal(commanderHandoff.replacementAssignment.userId, replacementCommanderMember.userId);
assert.equal(commanderHandoff.replacementAssignment.incidentRole, "incident_commander");
const replayedCommanderHandoff = expectSuccess(await request(
  `/api/v1/incidents/${incident.id}/assignments/${originalCommanderAssignment.id}`,
  mutationOptions("DELETE", commanderHandoffBody, commanderHandoffKey),
), 200);
assert.equal(replayedCommanderHandoff.replayed, true);
assert.equal(replayedCommanderHandoff.replacementAssignment.id, commanderHandoff.replacementAssignment.id);
assignmentDetail = expectSuccess(await request(`/api/v1/incidents/${incident.id}`), 200);
const activeCommanders = assignmentDetail.assignments.filter((assignment) => assignment.incidentRole === "incident_commander");
assert.equal(activeCommanders.length, 1);
assert.equal(activeCommanders[0].userId, replacementCommanderMember.userId);
assert.deepEqual(assignmentDetail.incident.commander, {
  id: replacementCommanderMember.userId,
  displayName: replacementCommanderMember.displayName,
});
const handoffListItem = expectSuccess(await request("/api/v1/incidents"), 200).incidents.find((item) => item.id === incident.id);
const handoffOverviewItem = expectSuccess(await request("/api/v1/overview"), 200).recentIncidents.find((item) => item.id === incident.id);
assert.deepEqual(handoffListItem?.commander, assignmentDetail.incident.commander);
assert.deepEqual(handoffOverviewItem?.commander, assignmentDetail.incident.commander);
markPassed("atomic commander handoff, active-only assignment state, replay, and summary consistency");

// No monitoring integration exists in this local run, so health must remain explicitly unknown.
const overview = expectSuccess(await request("/api/v1/overview"), 200);
const serviceHealth = overview.serviceHealth.find((item) => item.serviceId === service.id);
assert.ok(serviceHealth, "The active service is missing from overview health output.");
assert.equal(serviceHealth.operationalStatus, "unknown");
assert.equal(serviceHealth.telemetryStatus, "unavailable");
assert.equal(serviceHealth.sampleSize, 0);
assert.equal(serviceHealth.sloAttainment, null);
assert.equal(serviceHealth.activeIncidentCount, 0);
markPassed("unknown external telemetry and null SLO attainment are distinct from incident impact");

// A service may be deprecated only after every incident is closed/cancelled.
const missingServiceStatusReason = await mutate(
  `/api/v1/services/${service.id}`,
  "PATCH",
  { expectedVersion: service.version, status: "deprecated" },
  "service-deprecate-without-reason",
);
expectProblem(
  missingServiceStatusReason,
  400,
  "SERVICE_STATUS_CHANGE_REASON_REQUIRED",
  "service lifecycle change without an operational reason",
);
const serviceDeprecationReason = "The replacement service and runbook were verified; this service no longer accepts new traffic.";
const missingServiceStatusConfirmation = await mutate(
  `/api/v1/services/${service.id}`,
  "PATCH",
  {
    expectedVersion: service.version,
    status: "deprecated",
    statusChangeReason: serviceDeprecationReason,
  },
  "service-deprecate-without-confirmation",
);
expectProblem(
  missingServiceStatusConfirmation,
  400,
  "SERVICE_STATUS_CHANGE_CONFIRMATION_REQUIRED",
  "service lifecycle change without explicit impact confirmation",
);
const oversizedServiceStatusReason = await mutate(
  `/api/v1/services/${service.id}`,
  "PATCH",
  {
    expectedVersion: service.version,
    status: "deprecated",
    statusChangeReason: "A".repeat(1001),
    lifecycleConfirmed: true,
  },
  "service-deprecate-with-oversized-reason",
);
expectProblem(
  oversizedServiceStatusReason,
  400,
  "SERVICE_STATUS_CHANGE_REASON_REQUIRED",
  "service lifecycle change with an oversized reason",
);
const deprecatedService = expectSuccess(await mutate(
  `/api/v1/services/${service.id}`,
  "PATCH",
  {
    expectedVersion: service.version,
    status: "deprecated",
    statusChangeReason: serviceDeprecationReason,
    lifecycleConfirmed: true,
  },
  "service-deprecate",
), 200).service;
service = deprecatedService;
assert.equal(service.status, "deprecated");
assert.equal(service.version, 3);
const incidentForDeprecatedService = await mutate(
  "/api/v1/incidents",
  "POST",
  {
    ...incidentBody,
    title: `Deprecated service rejection ${runId}`,
    summary: "This otherwise valid incident must be rejected because the selected service is deprecated.",
  },
  "incident-deprecated-service",
);
expectProblem(
  incidentForDeprecatedService,
  400,
  "SERVICE_NOT_ACTIVE",
  "incident declaration for a deprecated service",
);
assert.equal(service.runbookUrl, servicePatchBody.runbookUrl);
assert.equal(service.statusChangeReason, serviceDeprecationReason);
assert.equal(service.statusChangedByUserId, access.actor.id);
assert.equal(service.statusChangedByName, access.actor.displayName);
assert.match(service.statusChangedAt, /^\d{4}-\d{2}-\d{2}T/);
const replayedServiceDeprecation = expectSuccess(await mutate(
  `/api/v1/services/${service.id}`,
  "PATCH",
  {
    expectedVersion: 2,
    status: "deprecated",
    statusChangeReason: serviceDeprecationReason,
    lifecycleConfirmed: true,
  },
  "service-deprecate",
), 200);
assert.equal(replayedServiceDeprecation.replayed, true);
assert.equal(replayedServiceDeprecation.service.version, service.version);
const staleLifecycleChange = await mutate(
  `/api/v1/services/${service.id}`,
  "PATCH",
  {
    expectedVersion: 2,
    status: "deprecated",
    statusChangeReason: "This stale request must be rejected before current-state field validation.",
    lifecycleConfirmed: true,
  },
  "service-deprecate-stale-version",
);
expectProblem(
  staleLifecycleChange,
  409,
  "VERSION_CONFLICT",
  "stale service lifecycle request before state-dependent validation",
);
const deprecatedServiceDetail = expectSuccess(await request(`/api/v1/services/${service.id}`), 200).service;
assert.deepEqual(
  {
    status: deprecatedServiceDetail.status,
    reason: deprecatedServiceDetail.statusChangeReason,
    actor: deprecatedServiceDetail.statusChangedByUserId,
    changedAt: deprecatedServiceDetail.statusChangedAt,
  },
  {
    status: service.status,
    reason: service.statusChangeReason,
    actor: service.statusChangedByUserId,
    changedAt: service.statusChangedAt,
  },
);
const initialLifecycleHistory = expectSuccess(await request(
  `/api/v1/services/${service.id}/lifecycle-events`,
), 200);
assert.equal(initialLifecycleHistory.limit, 25);
assert.equal(initialLifecycleHistory.events.length, 1);
assert.equal(initialLifecycleHistory.hasMore, false);
assert.equal(initialLifecycleHistory.nextCursor, null);
assert.equal(initialLifecycleHistory.events[0].requestId, service.statusChangeRequestId);
assert.equal(initialLifecycleHistory.events[0].reason, serviceDeprecationReason);

const malformedLifecycleCursor = await request(
  `/api/v1/services/${service.id}/lifecycle-events?cursor=not%2Bbase64`,
);
expectProblem(
  malformedLifecycleCursor,
  400,
  "INVALID_LIFECYCLE_CURSOR",
  "malformed service lifecycle cursor",
);
const duplicateLifecycleCursor = await request(
  `/api/v1/services/${service.id}/lifecycle-events?cursor=a&cursor=b`,
);
expectProblem(
  duplicateLifecycleCursor,
  400,
  "INVALID_LIFECYCLE_CURSOR",
  "duplicate service lifecycle cursor parameters",
);

// Create enough append-only transitions to exercise the black-box pagination boundary.
for (let index = 1; index <= 26; index += 1) {
  const nextStatus = service.status === "active" ? "deprecated" : "active";
  const lifecycleReason = nextStatus === "active"
    ? `Controlled lifecycle verification ${index}: ownership, SLO, and runbook readiness were confirmed.`
    : `Controlled lifecycle verification ${index}: replacement readiness and retirement risk were confirmed.`;
  service = expectSuccess(await mutate(
    `/api/v1/services/${service.id}`,
    "PATCH",
    {
      expectedVersion: service.version,
      status: nextStatus,
      statusChangeReason: lifecycleReason,
      lifecycleConfirmed: true,
    },
    `service-lifecycle-pagination-${index}`,
  ), 200).service;
}

const lifecyclePageOne = expectSuccess(await request(
  `/api/v1/services/${service.id}/lifecycle-events`,
), 200);
assert.equal(lifecyclePageOne.limit, 25);
assert.equal(lifecyclePageOne.events.length, 25);
assert.equal(lifecyclePageOne.hasMore, true);
assert.equal(typeof lifecyclePageOne.nextCursor, "string");
assertLifecycleEventsStrictlyDescending(lifecyclePageOne.events);
assert.equal(new Set(lifecyclePageOne.events.map((event) => event.id)).size, lifecyclePageOne.events.length);

const lifecyclePageTwo = expectSuccess(await request(
  `/api/v1/services/${service.id}/lifecycle-events?cursor=${encodeURIComponent(lifecyclePageOne.nextCursor)}`,
), 200);
assert.equal(lifecyclePageTwo.limit, 25);
assert.equal(lifecyclePageTwo.events.length, 2);
assert.equal(lifecyclePageTwo.hasMore, false);
assert.equal(lifecyclePageTwo.nextCursor, null);
assertLifecycleEventsStrictlyDescending(lifecyclePageTwo.events);
const pageOneIds = new Set(lifecyclePageOne.events.map((event) => event.id));
assert.ok(lifecyclePageTwo.events.every((event) => !pageOneIds.has(event.id)));
const pageOneBoundary = lifecyclePageOne.events.at(-1);
assert.ok(lifecyclePageTwo.events.every((event) => lifecycleEventIsStrictlyOlder(event, pageOneBoundary)));
assert.equal(lifecyclePageOne.events.length + lifecyclePageTwo.events.length, 27);
assert.equal(lifecyclePageOne.events[0].requestId, service.statusChangeRequestId);

const finalServiceList = expectSuccess(await request("/api/v1/services"), 200).services;
const finalServiceSummary = finalServiceList.find((item) => item.id === service.id);
assert.equal(finalServiceSummary?.statusChangeRequestId, service.statusChangeRequestId);
assert.equal(finalServiceSummary?.statusChangeReason, service.statusChangeReason);
markPassed("service lifecycle confirmation, exact replay, append-only evidence, cursor pagination, and list/detail round-trip");

// Final retrieval and audit assertions.
const finalIncidentDetail = expectSuccess(await request(`/api/v1/incidents/${incident.id}`), 200);
assert.equal(finalIncidentDetail.incident.status, "closed");
assert.equal(finalIncidentDetail.incident.version, 12);
assert.equal(finalIncidentDetail.review.status, "completed");
assert.equal(finalIncidentDetail.review.version, 5);
assert.equal(finalIncidentDetail.tasks.find((task) => task.id === criticalTask.id)?.evidenceRef, criticalTask.evidenceRef);
const finalCommunications = expectSuccess(await request(communicationPath), 200).communications;
const publishedCommunication = finalCommunications.find((item) => item.id === finalCommunication.id);
assert.equal(publishedCommunication?.status, "published");
assert.equal(publishedCommunication?.message, finalCommunication.message);
assert.deepEqual(publishedCommunication?.affectedComponents, finalCommunication.affectedComponents);
assert.equal(publishedCommunication?.version, 4);
const timeline = expectSuccess(await request(`/api/v1/incidents/${incident.id}/timeline`), 200).events;
assert.ok(timeline.some((event) => event.id === firstVerification.id));
assert.ok(timeline.some((event) => event.id === secondVerification.id));
const communicationTimeline = timeline.filter((event) => event.eventType === "communication");
assert.equal(communicationTimeline.filter((event) => event.sourceLabel === scheduledCommunication.id).length, 4);
assert.equal(communicationTimeline.filter((event) => event.sourceLabel === finalCommunication.id).length, 4);
assert.equal(communicationTimeline.filter((event) => event.sourceLabel === terminalCommunication.id).length, 2);
for (const event of communicationTimeline) {
  assert.doesNotMatch(event.message, new RegExp(finalCommunicationToken, "i"));
  assert.doesNotMatch(event.message, /Regional Edge|Session Gateway/i);
}
const incidents = expectSuccess(await request("/api/v1/incidents"), 200).incidents;
assert.ok(incidents.some((item) => item.id === incident.id && item.status === "closed"));
markPassed("final incident, PIR, task, communication, timeline, and list consistency");

const auditEvents = expectSuccess(await request("/api/v1/audit?limit=200"), 200).events;
for (const action of [
  "access.member.create",
  "service.create",
  "service.update",
  "incident.create",
  "incident.assignment.create",
  "incident.assignment.revoke",
  "incident.assignment.handoff",
  "incident.update",
  "incident.timeline.create",
  "incident.communication.create",
  "incident.communication.update",
  "incident.communication.review",
  "incident.communication.publish",
  "incident.task.create",
  "incident.task.update",
  "incident.transition",
  "incident.review.create",
  "incident.review.update",
  "incident.review.reopen",
]) {
  assert.ok(auditEvents.some((event) => event.action === action), `The audit log is missing ${action}.`);
}
assert.ok(auditEvents.every((event) => typeof event.requestId === "string" && event.requestId.startsWith("req-")));
assert.equal(
  auditEvents.filter((event) => (
    event.outcome === "success"
    && event.action === "service.create"
    && event.resourceId === concurrentCreateService.id
  )).length,
  1,
  "Concurrent duplicate delivery must create exactly one successful service audit row.",
);
assert.equal(
  auditEvents.filter((event) => (
    event.outcome === "success"
    && event.action === "service.update"
    && event.resourceId === versionRaceService.id
  )).length,
  1,
  "Competing optimistic updates must create exactly one successful service update audit row.",
);
const successfulCommunicationAudits = auditEvents.filter(
  (event) => event.outcome === "success" && event.resourceType === "incident_communication",
);
assert.equal(successfulCommunicationAudits.filter((event) => event.resourceId === scheduledCommunication.id).length, 4);
assert.equal(successfulCommunicationAudits.filter((event) => event.resourceId === finalCommunication.id).length, 4);
assert.equal(successfulCommunicationAudits.filter((event) => event.resourceId === terminalCommunication.id).length, 2);
for (const event of successfulCommunicationAudits) {
  const details = JSON.stringify(event.details ?? {});
  assert.doesNotMatch(details, new RegExp(finalCommunicationToken, "i"));
  assert.doesNotMatch(details, /Regional Edge|Session Gateway|"affectedComponents"\s*:|"message"\s*:|"requestBody"\s*:|"payload"\s*:/i);
}
const expectedRejectedAudits = [
  ["LAST_ADMIN_REQUIRED", "denied"],
  ["IDEMPOTENCY_KEY_REUSED", "failure"],
  ["VERSION_CONFLICT", "failure"],
  ["SERVICE_HAS_OPEN_INCIDENTS", "failure"],
  ["INCIDENT_NOT_RESOLVED", "failure"],
  ["TRANSITION_NOT_ALLOWED", "denied"],
  ["INCIDENT_ROLE_INCOMPATIBLE", "denied"],
  ["RESOLUTION_CRITERIA_REQUIRED", "failure"],
  ["RESOLUTION_VERIFICATION_REQUIRED", "failure"],
  ["RESOLUTION_CRITICAL_TASKS_OPEN", "failure"],
  ["TASK_EVIDENCE_REQUIRED", "failure"],
  ["REVIEW_SECTIONS_INCOMPLETE", "failure"],
  ["INCIDENT_COMMANDER_REQUIRED", "failure"],
  ["COMMUNICATION_STATUS_CONFLICT", "failure"],
  ["COMMUNICATION_NEXT_UPDATE_REQUIRED", "failure"],
  ["INCIDENT_COMMUNICATION_PUBLISH_BLOCKED", "failure"],
];
for (const [reasonCode, outcome] of expectedRejectedAudits) {
  const matchingEvent = auditEvents.find((event) => event.reasonCode === reasonCode && event.outcome === outcome);
  assert.ok(matchingEvent, `The audit log is missing the ${outcome} ${reasonCode} event.`);
  assert.deepEqual(
    Object.keys(matchingEvent.details ?? {}).sort(),
    ["method", "route"],
    `The ${reasonCode} audit event must not retain the rejected request payload.`,
  );
}
markPassed("append-only success audit and payload-free denied/failure audit records");

const unexpectedServerErrorCount = observedResponseStatuses.filter((status) => status >= 500).length;
assert.equal(unexpectedServerErrorCount, 0, "The local smoke run returned an unexpected 5xx response.");
markPassed("all observed HTTP requests completed without an unexpected 5xx response", {
  observedResponseCount: observedResponseStatuses.length,
  unexpectedServerErrorCount,
});

const generatedAt = new Date().toISOString();
const commonLimitations = [
  "The run uses a local Worker preview and isolated local D1 state; it does not verify hosted identity integration or production deployment.",
  "The primary API sequence runs as the configured local administrator. Separate unit and authorization tests cover the organization-role permission matrix.",
  "Request telemetry is emitted by the local Worker process, but this report does not assert ingestion, retention, alerting, or production observability delivery.",
  "The test data is synthetic and does not represent external professional-user evidence.",
  "Authentication and Origin failures are not persisted as application audit rows because no verified active actor has been established for those requests.",
  "The local preview verifies that a mutation without Origin is rejected. A foreign-Origin request is covered by the authorization unit suite because Wrangler 4.114.0 terminates its local proxy before forwarding that request to the Worker.",
  "Concurrent requests are dispatched from one local Node.js process against one Wrangler and D1 instance; this verifies observed local race handling, not distributed production capacity or a load-test result.",
  "No backup restoration, rollback exercise, independent security review, accessibility conformance review, or load test is implied.",
];
const totalCheckCount = positiveChecks.length + negativeChecks.length;
const apiReport = {
  schemaVersion: "1.1",
  evidenceId: API_EVIDENCE_ID,
  product: PRODUCT_NAME,
  productVersion: PRODUCT_VERSION,
  generatedAt,
  evidenceStatus: "verified_local",
  verificationType: "isolated_local_worker_d1_api_smoke",
  environment: {
    baseUrl,
    runtime: "Cloudflare Worker local build preview",
    database: "isolated local D1",
    identitySource: "local_environment",
  },
  buildArtifact: { path: "dist/server/index.js", sha256: workerArtifactSha256 },
  result: "passed",
  checkSummary: {
    positive: positiveChecks.length,
    negative: negativeChecks.length,
    total: totalCheckCount,
  },
  checks: positiveChecks,
  scope: [
    "professional root and operations surfaces, social preview, and root/API HTTP security headers",
    "authenticated access and active-administrator protection",
    "simultaneous same-key create replay and same-version optimistic update conflict with single-row and audit consistency",
    "non-object and malformed UTF-8 JSON rejection, normalized control characters, exact text boundary, and SQL/XSS-shaped text round-trip as JSON data",
    "service create, versioned update, replay, open-incident deprecation guard, and runbook round-trip",
    "incident lifecycle, current monitoring-cycle resolution gates, transition replay, reopen, and closure",
    "timeline verification metadata validation and durable round-trip",
    "structured incident communication review prerequisites, publication, replay, external-update, and terminal-state controls",
    "task completion rejection without evidence and HTTPS evidence persistence",
    "partial and completed post-incident reviews with stateful replay and reopen invalidation",
    "assignment soft revoke, same-role reassignment, and atomic final-commander handoff",
    "unknown external telemetry semantics and append-only audit retrieval",
  ],
  observed: {
    runId,
    serviceId: service.id,
    serviceVersion: service.version,
    incidentId: incident.id,
    incidentNumber: incident.incidentNumber,
    finalIncidentStatus: incident.status,
    finalIncidentVersion: incident.version,
    finalReviewVersion: review.version,
    criticalTaskId: criticalTask.id,
    finalCriticalTaskVersion: criticalTask.version,
    evidenceRequiredTaskId: evidenceRequiredTask.id,
    publishedCommunicationId: finalCommunication.id,
    publishedCommunicationVersion: finalCommunication.version,
    communicationTimelineEventCount: communicationTimeline.length,
    firstVerificationEventId: firstVerification.id,
    secondVerificationEventId: secondVerification.id,
    finalCommanderUserId: replacementCommanderMember.userId,
    timelineEventCount: timeline.length,
    auditEventCountReturned: auditEvents.length,
    distinctResponseRequestIds: new Set(observedRequestIds).size,
    observedResponseCount: observedResponseStatuses.length,
    unexpectedServerErrorCount,
    concurrentIdenticalCreate: { requests: 2, created: 1, replayed: 1, businessRows: 1, successAuditRows: 1 },
    concurrentVersionUpdate: { requests: 2, succeeded: 1, conflicted: 1, successAuditRows: 1 },
  },
  limitations: commonLimitations,
};

const securityReport = {
  schemaVersion: "1.1",
  evidenceId: SECURITY_EVIDENCE_ID,
  product: PRODUCT_NAME,
  productVersion: PRODUCT_VERSION,
  generatedAt,
  evidenceStatus: "verified_local",
  verificationType: "local_api_security_and_invariant_negative_checks",
  result: "passed_with_documented_limits",
  buildArtifact: { path: "dist/server/index.js", sha256: workerArtifactSha256 },
  checkSummary: { negative: negativeChecks.length },
  checks: negativeChecks,
  controlsObserved: [
    "root and API cache, framing, MIME, referrer, permissions, opener/resource isolation, CSP, and protocol-appropriate HSTS response headers",
    "same-origin, JSON content-type, object-body, valid UTF-8, and request-size enforcement",
    "final active administrator protection",
    "idempotency-key request-content binding, early stateful replay, and simultaneous duplicate-delivery replay",
    "optimistic service and incident version guards, including simultaneous competing service updates",
    "bounded text normalization and JSON-only round-trip of SQL and XSS-shaped input",
    "service deprecation blocked while incidents remain open",
    "incident commander organization-role and final-commander invariants",
    "current monitoring-cycle resolution criteria, verification, and critical-task gates",
    "completed-task HTTPS evidence requirement enforced before persistence",
    "strict PIR status and completed-section validation",
    "structured communication review-before-publish, external scheduling, optimistic-version, and terminal-incident controls",
    "HTTPS task-completion evidence, timeline evidence URL, observation-window, and SHA-256 validation",
    "payload-free denied and failure audit records after verified-member mutations",
  ],
  rejectedAudit: {
    verifiedReasonCodes: expectedRejectedAudits.map(([reasonCode]) => reasonCode),
    retainedDetailFields: ["method", "route"],
    requestPayloadRetained: false,
  },
  limitations: commonLimitations,
};

mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(
  resolve(evidenceDirectory, "continuity-ops-api-smoke.json"),
  `${JSON.stringify(apiReport, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  resolve(evidenceDirectory, "continuity-ops-security-negative-tests.json"),
  `${JSON.stringify(securityReport, null, 2)}\n`,
  "utf8",
);

console.log(JSON.stringify({
  ok: true,
  runId,
  serviceId: service.id,
  incidentId: incident.id,
  finalIncidentStatus: incident.status,
  positiveCheckCount: positiveChecks.length,
  negativeCheckCount: negativeChecks.length,
  totalCheckCount,
  evidenceIds: [API_EVIDENCE_ID, SECURITY_EVIDENCE_ID],
}, null, 2));
