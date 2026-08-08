import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedDurationMilliseconds,
  classroomLogCaptureKind,
  classroomLogScope,
  classroomLogWindowStart,
  classroomOperationOutcome,
  classroomRecordedSuccessShare,
  classroomResolvedIncidentEvidenceIsValid,
  classroomSecurityRelevant,
  normalizeClassroomErrorCode,
  normalizeClassroomIncidentDraft,
  normalizeClassroomLogWindow,
  normalizeClassroomRelease,
  normalizeClassroomRoute,
  percentile95,
} from "../lib/classroom-observability.ts";

test("log windows accept only the supported periods and calculate exact UTC boundaries", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");
  assert.equal(normalizeClassroomLogWindow("24h"), "24h");
  assert.equal(normalizeClassroomLogWindow("30d"), "30d");
  assert.equal(normalizeClassroomLogWindow("forever"), "7d");
  assert.equal(classroomLogWindowStart("24h", now), "2026-08-07T12:00:00.000Z");
  assert.equal(classroomLogWindowStart("7d", now), "2026-08-01T12:00:00.000Z");
  assert.equal(classroomLogWindowStart("30d", now), "2026-07-09T12:00:00.000Z");
});

test("operation routes remove query strings, join codes, and database identifiers", () => {
  const raw = "https://example.test/api/classroom/courses/course-12345678/sessions/session-abcdefgh/questions/question-123456/rankings?email=student%40ntub.edu.tw";
  assert.equal(
    normalizeClassroomRoute(raw),
    "/api/classroom/courses/:id/sessions/:id/questions/:id/rankings",
  );
  assert.equal(
    normalizeClassroomRoute("/api/classroom/join/ABC234?student=11256001"),
    "/api/classroom/join/:joinCode",
  );
  assert.equal(normalizeClassroomRoute("/api/classroom/join/ABC234/extra"), "/api/classroom/join/ABC234/extra");
  assert.equal(normalizeClassroomRoute("/api/other/private?token=secret"), "/unknown");
  assert.equal(normalizeClassroomRoute("not a valid URL"), "/unknown");
});

test("operation scope selects the most specific question, session, or course identifier", () => {
  assert.deepEqual(
    classroomLogScope("/api/classroom/courses/course-12345678/sessions/session-abcdefgh/questions/question-123456"),
    { type: "question", id: "question-123456" },
  );
  assert.deepEqual(
    classroomLogScope("/api/classroom/courses/course-12345678/sessions/session-abcdefgh"),
    { type: "session", id: "session-abcdefgh" },
  );
  assert.deepEqual(
    classroomLogScope("/api/classroom/courses/course-12345678"),
    { type: "course", id: "course-12345678" },
  );
  assert.deepEqual(classroomLogScope("/api/classroom/courses"), { type: "system", id: null });
  assert.deepEqual(classroomLogScope("http://[invalid"), { type: "system", id: null });
});

test("error and security classification uses bounded machine-readable values", () => {
  assert.equal(normalizeClassroomErrorCode(" access_denied "), "ACCESS_DENIED");
  assert.equal(normalizeClassroomErrorCode("contains space"), null);
  assert.equal(normalizeClassroomErrorCode("a"), null);
  assert.equal(normalizeClassroomErrorCode(null), null);

  assert.equal(classroomOperationOutcome(204), "success");
  assert.equal(classroomOperationOutcome(399), "success");
  assert.equal(classroomOperationOutcome(400), "client_error");
  assert.equal(classroomOperationOutcome(422), "client_error");
  assert.equal(classroomOperationOutcome(499), "client_error");
  assert.equal(classroomOperationOutcome(500), "server_error");
  assert.equal(classroomOperationOutcome(503), "server_error");
  assert.equal(classroomSecurityRelevant(401, null), true);
  assert.equal(classroomSecurityRelevant(403, null), true);
  assert.equal(classroomSecurityRelevant(429, null), true);
  assert.equal(classroomSecurityRelevant(400, "ORIGIN_NOT_ALLOWED"), true);
  assert.equal(classroomSecurityRelevant(400, "REQUEST_TOO_LARGE"), true);
  assert.equal(classroomSecurityRelevant(400, "QUESTION_REQUIRED"), false);
  assert.equal(classroomSecurityRelevant(500, "DATABASE_UNAVAILABLE"), false);
});

test("log capture retains all failures, mutations, slow reads, and only deterministic samples of normal reads", () => {
  assert.equal(classroomLogCaptureKind("req-any", "GET", 404, 20), "error");
  assert.equal(classroomLogCaptureKind("req-any", "POST", 201, 20), "mutation");
  assert.equal(classroomLogCaptureKind("req-any", "HEAD", 201, 20), null);
  assert.equal(classroomLogCaptureKind("req-any", "OPTIONS", 201, 20), null);
  assert.equal(classroomLogCaptureKind("req-any", "GET", 200, 1_000), "slow");
  assert.equal(classroomLogCaptureKind("req-00000000-0000-4000-8000-00000000000a", "GET", 200, 20), "sample");
  assert.equal(classroomLogCaptureKind("req-00000000-0000-4000-8000-00000000000b", "GET", 200, 20), null);
});

test("duration and p95 calculations are deterministic and bounded", () => {
  assert.equal(boundedDurationMilliseconds(Number.NaN), 0);
  assert.equal(boundedDurationMilliseconds(-4), 0);
  assert.equal(boundedDurationMilliseconds(0), 0);
  assert.equal(boundedDurationMilliseconds(2.6), 3);
  assert.equal(boundedDurationMilliseconds(999_999), 120_000);
  assert.equal(percentile95([]), 0);
  assert.equal(percentile95(Array.from({ length: 20 }, (_, index) => index + 1)), 19);
  assert.equal(percentile95([20, 1, 19, 2, 18, 3, 17, 4, 16, 5, 15, 6, 14, 7, 13, 8, 12, 9, 11, 10]), 19);
});

test("release identifiers and recorded success shares do not invent evidence", () => {
  assert.equal(normalizeClassroomRelease("release-20260808.1"), "release-20260808.1");
  assert.equal(normalizeClassroomRelease("release with spaces"), "classroom-0.3.0-unverified");
  assert.equal(normalizeClassroomRelease(undefined), "classroom-0.3.0-unverified");
  assert.equal(classroomRecordedSuccessShare(0, 0), null);
  assert.equal(classroomRecordedSuccessShare(-1, 0), null);
  assert.equal(classroomRecordedSuccessShare(10, 8), 80);
  assert.equal(classroomRecordedSuccessShare(3, 2), 66.7);
  assert.equal(classroomRecordedSuccessShare(3, 9), 100);
  assert.equal(classroomRecordedSuccessShare(3, Number.NaN), 0);
});

const resolvedIncident = {
  title: "資料庫結構版本不一致",
  severity: "high",
  status: "resolved",
  sourceRequestId: "req-00000000-0000-4000-8000-000000000001",
  verificationRequestId: "req-00000000-0000-4000-8000-000000000002",
  symptom: "課堂資料載入時回傳結構版本不一致。",
  rootCause: "正式資料庫尚未執行最新遷移。",
  resolution: "套用遷移並重新發布相同版本。",
  fixRelease: "release-20260808.1",
  regressionCheck: "確認資料載入與寫入皆成功。",
  regressionCommand: "npm run gate:ci",
  regressionEvidence: "所有自動檢查通過，驗證請求回傳 200。",
  verificationResult: "passed",
} as const;

test("an open incident can record an observed symptom before its cause is known", () => {
  const draft = normalizeClassroomIncidentDraft({
    ...resolvedIncident,
    status: "open",
    rootCause: "",
    resolution: "",
    fixRelease: "",
    regressionCheck: "",
    regressionCommand: "",
    regressionEvidence: "",
    verificationResult: "not_run",
  });
  assert.ok(draft);
  assert.equal(draft.status, "open");
  assert.equal(draft.rootCause, "");
});

test("a resolved incident requires a cause, fix, release, regression evidence, and a passed verification", () => {
  assert.deepEqual(normalizeClassroomIncidentDraft(resolvedIncident), {
    ...resolvedIncident,
    regressionEvidence: "所有自動檢查通過,驗證請求回傳 200。",
  });
  for (const field of [
    "rootCause",
    "resolution",
    "fixRelease",
    "regressionCheck",
    "regressionCommand",
    "regressionEvidence",
  ] as const) {
    assert.equal(
      normalizeClassroomIncidentDraft({ ...resolvedIncident, [field]: "" }),
      null,
      `${field} must be present before resolution`,
    );
  }
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, verificationResult: "failed" }), null);
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, sourceRequestId: null }), null);
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, verificationRequestId: resolvedIncident.sourceRequestId }), null);
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, fixRelease: "release with spaces" }), null);
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, fixRelease: "classroom-0.3.0-unverified" }), null);
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, sourceRequestId: "raw-email@example.test" }), null);
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, verificationRequestId: "request 2" }), null);
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, sourceRequestId: `prefix-${resolvedIncident.sourceRequestId}` }), null);
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, verificationRequestId: `${resolvedIncident.verificationRequestId}-suffix` }), null);
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, verificationRequestId: null }), null);
});

test("resolved incident evidence comes from a later successful request on the exact fix release", () => {
  const draft = normalizeClassroomIncidentDraft(resolvedIncident);
  assert.ok(draft);
  const source = { outcome: "server_error", release: "release-before-fix", occurredAt: "2026-08-08T01:00:00.000Z" };
  const verification = { outcome: "success", release: resolvedIncident.fixRelease, occurredAt: "2026-08-08T01:00:01.000Z" };
  assert.equal(classroomResolvedIncidentEvidenceIsValid(draft, source, verification), true);
  assert.equal(classroomResolvedIncidentEvidenceIsValid(draft, null, verification), false);
  assert.equal(classroomResolvedIncidentEvidenceIsValid(draft, source, null), false);
  assert.equal(classroomResolvedIncidentEvidenceIsValid(draft, source, { ...verification, outcome: "client_error" }), false);
  assert.equal(classroomResolvedIncidentEvidenceIsValid(draft, source, { ...verification, release: "release-other" }), false);
  assert.equal(classroomResolvedIncidentEvidenceIsValid(
    { ...draft, fixRelease: "classroom-0.3.0-unverified" },
    source,
    { ...verification, release: "classroom-0.3.0-unverified" },
  ), false);
  assert.equal(classroomResolvedIncidentEvidenceIsValid(draft, source, { ...verification, occurredAt: source.occurredAt }), false);
  assert.equal(classroomResolvedIncidentEvidenceIsValid(draft, source, { ...verification, occurredAt: "2026-08-08T00:59:59.000Z" }), false);
  assert.equal(classroomResolvedIncidentEvidenceIsValid(draft, { ...source, occurredAt: "invalid" }, verification), false);

  const investigating = normalizeClassroomIncidentDraft({ ...resolvedIncident, status: "investigating" });
  assert.ok(investigating);
  assert.equal(classroomResolvedIncidentEvidenceIsValid(investigating, null, null), true);
});

test("incident input validates every enum, shape, and minimum boundary", () => {
  for (const invalid of [null, undefined, [], "incident", 42]) {
    assert.equal(normalizeClassroomIncidentDraft(invalid), null);
  }
  for (const severity of ["low", "medium", "high", "critical"] as const) {
    assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, severity })?.severity, severity);
  }
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, severity: "urgent" }), null);
  for (const status of ["open", "investigating"] as const) {
    assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, status })?.status, status);
  }
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, status: "closed" }), null);
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, verificationResult: "unknown" }), null);
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, title: "abc" }), null);
  assert.ok(normalizeClassroomIncidentDraft({ ...resolvedIncident, title: "abcd" }));
  assert.equal(normalizeClassroomIncidentDraft({ ...resolvedIncident, symptom: "1234567" }), null);
  assert.ok(normalizeClassroomIncidentDraft({ ...resolvedIncident, symptom: "12345678" }));

  assert.ok(normalizeClassroomIncidentDraft({
    ...resolvedIncident,
    rootCause: "12345678",
    resolution: "12345678",
    fixRelease: "v123",
    regressionCheck: "test",
    regressionCommand: "run",
    regressionEvidence: "12345678",
  }));
});

test("incident text strips control characters and stays within storage limits", () => {
  const draft = normalizeClassroomIncidentDraft({
    ...resolvedIncident,
    title: `  資料庫\u0000結構版本不一致  ${"字".repeat(200)}`,
    symptom: `第一行\r\n第二行\u0007${"症".repeat(2_100)}`,
  });
  assert.ok(draft);
  assert.equal(draft.title.includes("\u0000"), false);
  assert.equal(draft.title.length, 120);
  assert.equal(draft.symptom.includes("\r"), false);
  assert.equal(draft.symptom.includes("\u0007"), false);
  assert.equal(draft.symptom.length, 2_000);
});
