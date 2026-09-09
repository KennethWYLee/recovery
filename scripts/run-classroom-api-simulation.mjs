import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Miniflare } from "miniflare";
import { verifyClassroomGrouping } from "./verify-classroom-grouping.mjs";
import { verifyClassroomPublication } from "./verify-classroom-publication.mjs";
import { verifyParticipationManagement } from "./verify-participation-management.mjs";
import { verifyConditionalWorkspaceRead } from "./verify-classroom-refresh.mjs";

const root = process.cwd();
const workerEntry = resolve(root, "dist/server/index.js");
const workerRoot = resolve(root, "dist/server");
const reportPath = resolve(root, "evidence/api-simulation/latest.json");
const migrationFiles = Array.from({ length: 9 }, (_, index) => resolve(
  root,
  "drizzle",
  `000${index + 1}_${[
    "classroom_courses", "classroom_access_approval", "classroom_live_sessions",
    "multi_question_classrooms", "course_roster", "course_question_bank",
    "student_live_flow", "classroom_schema_state", "classroom_observability",
  ][index]}.sql`,
));
const DEMO_COURSE_ID = "course-demo-classroom";
const DEMO_SESSION_ID = "session-demo-classroom";
const DEMO_QUESTION_ID = "question-demo-3";
const studentIds = Array.from({ length: 24 }, (_, index) => `demo-user-${index + 1}`);
const rankingStudentIds = studentIds.slice(0, 21);
const lateStudentIds = studentIds.slice(21);

function percentile(values, proportion) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1)];
}

function rotatedOrder(groupIds, index) {
  const offset = index % groupIds.length;
  return [...groupIds.slice(offset), ...groupIds.slice(0, offset)];
}

async function applyMigrations(db) {
  for (const migrationFile of migrationFiles) {
    const migration = await readFile(migrationFile, "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}

async function collectWorkerModulePaths(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await collectWorkerModulePaths(path));
    else if (entry.isFile() && /[.]m?js$/u.test(entry.name)) paths.push(path);
  }
  return paths;
}

async function workerModules() {
  const paths = await collectWorkerModulePaths(workerRoot);
  const entrypoint = paths.find((path) => path === workerEntry);
  assert.ok(entrypoint, "Built Worker entrypoint was not found in the module graph.");
  return [entrypoint, ...paths.filter((path) => path !== entrypoint)]
    .map((path) => ({ type: "ESModule", path }));
}

function createMeasuredClient(baseUrl, dispatchFetch) {
  const records = [];
  const request = async (path, options = {}, acceptedStatuses = [200]) => {
    const method = options.method ?? "GET";
    const maximumAttempts = method === "GET" ? 4 : 1;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      const startedAt = performance.now();
      let response;
      try {
        response = await dispatchFetch(`${baseUrl}${path}`, {
          ...options,
          signal: options.signal ?? AbortSignal.timeout(10_000),
          headers: {
            accept: "application/json",
            ...(options.body ? { "content-type": "application/json", origin: baseUrl } : {}),
            ...options.headers,
          },
        });
      } catch (error) {
        const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        const retryable = /network connection lost|fetch failed|other side closed/iu.test(detail);
        records.push({ method, path: path.replace(/[?].*$/u, ""), status: 0,
          durationMs: performance.now() - startedAt, errorCode: "LOCAL_RUNTIME_CONNECTION_LOST", transient: retryable });
        if (retryable && attempt < maximumAttempts) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 200));
          continue;
        }
        throw new Error(`${method} ${path} did not complete: ${detail}`);
      }
      const durationMs = performance.now() - startedAt;
      const responseText = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(responseText);
      } catch {
        payload = null;
      }
      const localRuntimeDisconnect = response.status === 500 && /network connection lost/iu.test(responseText);
      records.push({
        method,
        path: path.replace(/[?].*$/u, ""),
        status: response.status,
        durationMs,
        errorCode: localRuntimeDisconnect ? "LOCAL_RUNTIME_CONNECTION_LOST" : payload?.error?.code ?? null,
        transient: localRuntimeDisconnect,
      });
      if (localRuntimeDisconnect && attempt < maximumAttempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 200));
        continue;
      }
      if (!acceptedStatuses.includes(response.status)) {
        throw new Error(`${method} ${path} returned ${response.status}: ${payload?.error?.code ?? "UNKNOWN"}\n${responseText.slice(0, 2_000)}`);
      }
      return { response, payload };
    }
    throw new Error(`${method} ${path} exhausted its local-runtime retry allowance.`);
  };
  return { records, request };
}

async function resetAndLoadClassroom(client) {
  await client.request(`/api/classroom/courses/${DEMO_COURSE_ID}/test-mode`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  const { payload } = await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}`);
  assert.equal(payload.data.actor.isAdmin, true);
  assert.equal(payload.data.snapshot.question.id, DEMO_QUESTION_ID);
  assert.equal(payload.data.snapshot.question.phase, "answering");
  assert.ok(Date.parse(payload.data.snapshot.question.answerDeadlineAt) > Date.now());
  return payload.data.snapshot;
}

async function loadStudentViews(client, phase) {
  const views = await Promise.all(studentIds.map(async (studentId) => {
    const { payload } = await client.request(
      `/api/classroom/courses/${DEMO_COURSE_ID}/session?questionId=${DEMO_QUESTION_ID}&testStudentId=${studentId}`,
    );
    const snapshot = payload.data.snapshot;
    assert.equal(payload.data.actor.id, studentId);
    assert.equal(snapshot.question.phase, phase);
    assert.deepEqual(snapshot.participants, []);
    assert.ok(snapshot.groups.every((group) => group.members.length === 0 && group.representativeUserId === null));
    assert.ok(snapshot.groups.every((group) => /^回答 [A-Z]+$/u.test(group.label)));
    return { studentId, snapshot };
  }));
  return views;
}

async function submitRemainingResponses(client) {
  const representativeIds = ["demo-user-1", "demo-user-5", "demo-user-9", "demo-user-13", "demo-user-17", "demo-user-21"];
  const liveResponses = await Promise.all(representativeIds.map(async (studentId) => {
    const { payload } = await client.request(
      `/api/classroom/sessions/${DEMO_SESSION_ID}/response?questionId=${DEMO_QUESTION_ID}&testStudentId=${studentId}`,
    );
    assert.equal(payload.data.live.isRepresentative, true);
    return { studentId, live: payload.data.live };
  }));
  const drafts = liveResponses.filter(({ live }) => live.response.status === "draft");
  assert.equal(drafts.length, 3);
  await Promise.all(drafts.map(({ studentId, live }) => client.request(
    `/api/classroom/sessions/${DEMO_SESSION_ID}/response`,
    {
      method: "PUT",
      body: JSON.stringify({
        testStudentId: studentId,
        questionId: DEMO_QUESTION_ID,
        expectedVersion: live.response.version,
        content: live.response.content,
        submit: true,
      }),
    },
  )));
}

async function verifyResponseRolesAndConflict(client) {
  const representativeId = "demo-user-13";
  const memberId = "demo-user-14";
  const { payload: representativePayload } = await client.request(
    `/api/classroom/sessions/${DEMO_SESSION_ID}/response?questionId=${DEMO_QUESTION_ID}&testStudentId=${representativeId}`,
  );
  const live = representativePayload.data.live;
  assert.equal(live.isRepresentative, true);

  const { payload: memberPayload } = await client.request(
    `/api/classroom/sessions/${DEMO_SESSION_ID}/response?questionId=${DEMO_QUESTION_ID}&testStudentId=${memberId}`,
  );
  assert.equal(memberPayload.data.live.isRepresentative, false);
  assert.equal(memberPayload.data.live.response.content, live.response.content);

  const rejected = await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}/response`, {
    method: "PUT",
    body: JSON.stringify({
      testStudentId: memberId,
      questionId: DEMO_QUESTION_ID,
      expectedVersion: live.response.version,
      content: "一般組員不應能修改本組回答。",
      submit: false,
    }),
  }, [403]);
  assert.equal(rejected.payload.error.code, "REPRESENTATIVE_REQUIRED");

  const drafts = ["先保存證據，再確認影響範圍。", "先確認影響範圍，再保存必要證據。"];
  const edits = await Promise.all(drafts.map((content) => client.request(
    `/api/classroom/sessions/${DEMO_SESSION_ID}/response`,
    {
      method: "PUT",
      body: JSON.stringify({
        testStudentId: representativeId,
        questionId: DEMO_QUESTION_ID,
        expectedVersion: live.response.version,
        content,
        submit: false,
      }),
    },
    [200, 409],
  )));
  assert.equal(edits.filter(({ response }) => response.status === 200).length, 1);
  assert.equal(edits.filter(({ payload }) => payload?.error?.code === "RESPONSE_VERSION_CONFLICT").length, 1);

  const { payload: refreshed } = await client.request(
    `/api/classroom/sessions/${DEMO_SESSION_ID}/response?questionId=${DEMO_QUESTION_ID}&testStudentId=${representativeId}`,
  );
  assert.equal(refreshed.data.live.response.version, live.response.version + 1);
  assert.ok(drafts.includes(refreshed.data.live.response.content));
}

async function advanceQuestion(client, snapshot, expectedPhase) {
  const { payload } = await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}`, {
    method: "PATCH",
    body: JSON.stringify({
      action: "question_advance",
      questionId: DEMO_QUESTION_ID,
      expectedQuestionVersion: snapshot.question.version,
    }),
  });
  assert.equal(payload.data.snapshot.question.phase, expectedPhase);
  return payload.data.snapshot;
}

async function submitStudentRankings(client, views) {
  await Promise.all(views.filter(({ studentId }) => rankingStudentIds.includes(studentId)).map(({ studentId, snapshot }, index) => {
    const order = rotatedOrder(snapshot.groups.map((group) => group.id), index);
    return client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}/ranking`, {
      method: "PUT",
      body: JSON.stringify({ testStudentId: studentId, questionId: DEMO_QUESTION_ID, orderedGroupIds: order }),
    });
  }));
  const lateAttempts = await Promise.all(lateStudentIds.map((studentId) => client.request(
    `/api/classroom/sessions/${DEMO_SESSION_ID}/ranking`,
    {
      method: "PUT",
      body: JSON.stringify({ testStudentId: studentId, questionId: DEMO_QUESTION_ID, orderedGroupIds: views[0].snapshot.groups.map((group) => group.id) }),
    },
    [403],
  )));
  assert.ok(lateAttempts.every(({ payload }) => payload.error.code === "RANKING_NOT_ALLOWED"));
}

async function submitTeacherAndConcurrentEdit(client, groupIds) {
  await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}/ranking`, {
    method: "PUT",
    body: JSON.stringify({ questionId: DEMO_QUESTION_ID, orderedGroupIds: [...groupIds].reverse() }),
  });
  const editBody = JSON.stringify({
    testStudentId: "demo-user-1",
    questionId: DEMO_QUESTION_ID,
    orderedGroupIds: [...groupIds].reverse(),
  });
  const edits = await Promise.all([
    client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}/ranking`, { method: "PUT", body: editBody }, [200, 409]),
    client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}/ranking`, { method: "PUT", body: editBody }, [200, 409]),
  ]);
  assert.ok(edits.some(({ response }) => response.status === 200));
  assert.ok(edits.every(({ response }) => response.status === 200 || response.status === 409));
}

async function verifyRankingInputBoundaries(client, groupIds) {
  const incomplete = await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}/ranking`, {
    method: "PUT",
    body: JSON.stringify({
      testStudentId: "demo-user-1",
      questionId: DEMO_QUESTION_ID,
      orderedGroupIds: groupIds.slice(0, -1),
    }),
  }, [400]);
  assert.equal(incomplete.payload.error.code, "INCOMPLETE_RANKING");

  const crossOrigin = await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}/ranking`, {
    method: "PUT",
    headers: { origin: "https://outside.example" },
    body: JSON.stringify({ questionId: DEMO_QUESTION_ID, orderedGroupIds: groupIds }),
  }, [403]);
  assert.equal(crossOrigin.payload.error.code, "CROSS_ORIGIN_REQUEST_REJECTED");

  const malformed = await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}/ranking`, {
    method: "PUT", body: "{",
  }, [400]);
  assert.equal(malformed.payload.error.code, "INVALID_JSON");

  const oversized = await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}/ranking`, {
    method: "PUT", body: JSON.stringify({ padding: "x".repeat(9_000) }),
  }, [413]);
  assert.equal(oversized.payload.error.code, "REQUEST_TOO_LARGE");
}

async function verifyFiftyRequestReadBurst(client) {
  const snapshots = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
    const studentId = studentIds[index % studentIds.length];
    return client.request(
      `/api/classroom/courses/${DEMO_COURSE_ID}/session?questionId=${DEMO_QUESTION_ID}&testStudentId=${studentId}`,
    );
  }));
  assert.equal(snapshots.length, 50);
  assert.ok(snapshots.every(({ payload }) => payload.data.snapshot.question.phase === "ranking"));
  assert.ok(snapshots.every(({ payload }) => payload.data.snapshot.participants.length === 0));
}

async function verifyCancelledReadRecovery(client, dispatchFetch, baseUrl) {
  const response = await dispatchFetch(
    `${baseUrl}/api/classroom/courses/${DEMO_COURSE_ID}/session?questionId=${DEMO_QUESTION_ID}&testStudentId=demo-user-1`,
    { headers: { accept: "application/json" } },
  );
  assert.equal(response.status, 200);
  await response.body?.cancel();
  const { payload } = await client.request(
    `/api/classroom/courses/${DEMO_COURSE_ID}/session?questionId=${DEMO_QUESTION_ID}&testStudentId=demo-user-1`,
  );
  assert.equal(payload.data.snapshot.question.id, DEMO_QUESTION_ID);
}

async function verifyPublishedResults(client) {
  const views = await loadStudentViews(client, "published");
  for (const { studentId, snapshot } of views) {
    assert.equal(snapshot.completion.rankedStudents, 21);
    assert.ok(snapshot.results.length === 6);
    assert.ok(snapshot.teacherRanking?.orderedGroupIds.length === 6);
    if (rankingStudentIds.includes(studentId)) {
      assert.equal(snapshot.currentUser.hasSubmittedRanking, true);
      assert.equal(snapshot.currentUser.orderedGroupIds.length, 6);
    } else {
      assert.equal(snapshot.currentUser.participatesInQuestion, false);
      assert.equal(snapshot.currentUser.canRank, false);
    }
  }
}

async function verifyHistoricalVisibility(client) {
  const visible = await client.request(
    `/api/classroom/courses/${DEMO_COURSE_ID}/session?questionId=question-demo-1&testStudentId=demo-user-1`,
  );
  assert.equal(visible.payload.data.snapshot.question.id, "question-demo-1");
  assert.ok(visible.payload.data.snapshot.results.length === 6);

  const hidden = await client.request(
    `/api/classroom/courses/${DEMO_COURSE_ID}/session?questionId=question-demo-2&testStudentId=demo-user-1`,
  );
  assert.notEqual(hidden.payload.data.snapshot.question.id, "question-demo-2");
  assert.ok(hidden.payload.data.snapshot.questions.every((question) => question.id !== "question-demo-2"));
}

async function verifyMutationRateLimit(client) {
  let limited = null;
  for (let attempt = 0; attempt < 130 && !limited; attempt += 1) {
    const result = await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}/ranking`, {
      method: "PUT",
      body: JSON.stringify({ questionId: DEMO_QUESTION_ID, orderedGroupIds: [] }),
    }, [409, 429]);
    if (result.response.status === 429) limited = result;
  }
  assert.equal(limited?.payload?.error?.code, "RATE_LIMITED");
  assert.equal(limited?.response.headers.get("retry-after"), "60");
}

function simulationReport(records, elapsedMs) {
  const durations = records.map((record) => record.durationMs);
  const expectedErrors = new Set([
    "CROSS_ORIGIN_REQUEST_REJECTED", "INCOMPLETE_RANKING", "INVALID_JSON", "RANKING_CLOSED",
    "RANKING_NOT_ALLOWED", "RANKING_VERSION_CONFLICT", "RATE_LIMITED", "REPRESENTATIVE_REQUIRED",
    "REQUEST_TOO_LARGE", "RESPONSE_VERSION_CONFLICT", "NOT_ENOUGH_PARTICIPANTS", "SESSION_VERSION_CONFLICT",
    "NO_RANKINGS", "TEACHER_RANKING_REQUIRED", "QUESTION_VERSION_CONFLICT", "RANKING_REOPEN_NOT_ALLOWED",
    "REPRESENTATIVE_NOT_IN_GROUP", "GROUP_CREATE_CONFLICT", "GROUPING_LOCKED", "EMPTY_GROUP_RESPONSE",
  ]);
  const unexpected = records.filter((record) => !record.transient && record.status >= 400 && !expectedErrors.has(record.errorCode));
  return {
    generatedAt: new Date().toISOString(),
    synthetic: true,
    scenario: {
      teachers: 1,
      students: 24,
      eligibleStudents: 21,
      lateObservers: 3,
      groups: 6,
      questions: 1,
      groupingCases: [{ students: 2, groups: 2 }, { students: 7, groups: 6 }, { students: 41, groups: 2 }],
    },
    requests: {
      total: records.length,
      successful: records.filter((record) => record.status >= 200 && record.status < 400).length,
      expectedRejected: records.filter((record) => record.status >= 400 && expectedErrors.has(record.errorCode)).length,
      localRuntimeReconnects: records.filter((record) => record.transient).length,
      unexpectedFailures: unexpected.length,
      elapsedMs: Math.round(elapsedMs),
      requestsPerSecond: Number((records.length / Math.max(elapsedMs / 1_000, 0.001)).toFixed(2)),
      latencyMs: {
        p50: Math.round(percentile(durations, 0.5)),
        p95: Math.round(percentile(durations, 0.95)),
        maximum: Math.round(Math.max(...durations)),
      },
    },
    checks: {
      newlyCreatedSessionGrouping: "passed",
      publicationWithOneOrTwoStudentRankings: "passed",
      reopenUnpublishedRankingsWithoutDataLoss: "passed",
      participationReflectsActualSubmissions: "passed",
      participationGroupAndRepresentativeManagement: "passed",
      publishedMembershipsPreservedAfterGroupMove: "passed",
      anonymousStudentPayloads: "passed",
      representativeOnlyResponses: "passed",
      responseVersionConflict: "passed",
      concurrentRankingEdits: "passed",
      fiftyRequestReadBurst: "passed",
      conditionalWorkspaceReads: "passed",
      cancelledReadRecovery: "passed",
      invalidInputBoundaries: "passed",
      lateStudentBoundary: "passed",
      teacherRankingSeparated: "passed",
      publishedConsensus: "passed",
      historicalVisibility: "passed",
      mutationRateLimit: "passed",
    },
  };
}

async function runScenario(baseUrl, dispatchFetch, db) {
  const startedAt = performance.now();
  const client = createMeasuredClient(baseUrl, dispatchFetch);
  console.log("[1/8] 重設示範課堂並讀取教師快照");
  let snapshot = await resetAndLoadClassroom(client);
  await verifyConditionalWorkspaceRead(client);
  await verifyClassroomGrouping(client, db);
  console.log("[2/8] 並行讀取 24 名學生作答畫面");
  const initialViews = await loadStudentViews(client, "answering");
  assert.equal(initialViews.filter(({ snapshot: view }) => view.currentUser.participatesInQuestion).length, 21);
  await verifyCancelledReadRecovery(client, dispatchFetch, baseUrl);
  await verifyResponseRolesAndConflict(client);
  console.log("[3/8] 代表提交其餘小組回答");
  await submitRemainingResponses(client);
  snapshot = (await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}`)).payload.data.snapshot;
  snapshot = await advanceQuestion(client, snapshot, "presenting");
  snapshot = await advanceQuestion(client, snapshot, "ranking");
  console.log("[4/8] 並行讀取 24 名學生排序畫面");
  const rankingViews = await loadStudentViews(client, "ranking");
  await verifyFiftyRequestReadBurst(client);
  const groupIds = rankingViews[0].snapshot.groups.map((group) => group.id);
  await verifyRankingInputBoundaries(client, groupIds);
  console.log("[5/8] 並行提交 21 份學生排序與 3 份遲到拒絕案例");
  await submitStudentRankings(client, rankingViews);
  console.log("[6/8] 提交教師排序與同帳號並行修改");
  await submitTeacherAndConcurrentEdit(client, groupIds);
  snapshot = (await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}`)).payload.data.snapshot;
  snapshot = await advanceQuestion(client, snapshot, "locked");
  await advanceQuestion(client, snapshot, "published");
  console.log("[7/8] 並行核對 24 名學生公布結果");
  await verifyPublishedResults(client);
  await db.prepare("UPDATE classroom_questions SET phase = 'archived', published_at = NULL WHERE id = 'question-demo-2'").run();
  await verifyHistoricalVisibility(client);
  await verifyClassroomPublication(client, db, DEMO_SESSION_ID);
  await verifyParticipationManagement(client, db, DEMO_SESSION_ID);
  await verifyMutationRateLimit(client);
  console.log("[8/8] 產生可重現測試報告");
  const report = simulationReport(client.records, performance.now() - startedAt);
  assert.equal(report.requests.unexpectedFailures, 0);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function main() {
  assert.ok(existsSync(workerEntry), "Build output is missing. Run npm run build first.");
  const baseUrl = "http://127.0.0.1";
  const persistence = await mkdtemp(join(tmpdir(), "classroom-api-simulation-"));
  const bindings = {
    CLASSROOM_ENVIRONMENT: "development",
    CLASSROOM_LOCAL_USER_ID: "api-simulation-administrator",
    CLASSROOM_LOCAL_USER_NAME: "API Simulation Administrator",
    CLASSROOM_LOCAL_USER_EMAIL: "api-simulation@example.invalid",
    CLASSROOM_ADMIN_EMAILS: "api-simulation@example.invalid",
    CLASSROOM_RELEASE: "api-simulation",
  };
  const miniflare = new Miniflare({
    modules: await workerModules(),
    modulesRoot: workerRoot,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    bindings,
    d1Databases: { DB: "classroom-api-simulation" },
    d1Persist: persistence,
    serviceBindings: { ASSETS: async () => new Response(null, { status: 404 }) },
  });
  try {
    const db = await miniflare.getD1Database("DB");
    await applyMigrations(db);
    const report = await runScenario(baseUrl, (url, init) => miniflare.dispatchFetch(url, init), db);
    console.log("課堂 API 並行演練通過");
    console.log(`- ${report.requests.total} 個請求；非預期失敗 ${report.requests.unexpectedFailures} 個`);
    console.log(`- P50 ${report.requests.latencyMs.p50} ms；P95 ${report.requests.latencyMs.p95} ms；最大 ${report.requests.latencyMs.maximum} ms`);
    console.log(`- 約 ${report.requests.requestsPerSecond} requests/second（本機合成資料）`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(detail);
  } finally {
    await miniflare.dispose();
    await rm(persistence, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

await main();
