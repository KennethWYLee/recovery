import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const root = process.cwd();
const sourceVariables = resolve(root, ".dev.vars");
const generatedConfig = resolve(root, "dist/server/wrangler.json");
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
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

function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

function percentile(values, proportion) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1)];
}

function rotatedOrder(groupIds, index) {
  const offset = index % groupIds.length;
  return [...groupIds.slice(offset), ...groupIds.slice(0, offset)];
}

function applyMigrations(persistence) {
  for (const migrationFile of migrationFiles) {
    const result = spawnSync(process.execPath, [
      wrangler, "d1", "execute", "DB", "--config", generatedConfig,
      "--local", "--persist-to", persistence, "--file", migrationFile, "--yes",
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WRANGLER_LOG_PATH: resolve(root, ".wrangler/wrangler-api-simulation.log") },
      windowsHide: true,
    });
    if (result.status !== 0) {
      throw new Error(`Migration ${migrationFile} failed.\n${result.stderr || result.stdout}`);
    }
  }
}

async function waitUntilReady(baseUrl, child, output) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Local server stopped before it was ready.\n${output()}`);
    try {
      const response = await fetch(`${baseUrl}/api/classroom/courses`);
      if (response.ok) return;
    } catch {
      // The local listener is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`Local server did not become ready.\n${output()}`);
}

function createMeasuredClient(baseUrl) {
  const records = [];
  const request = async (path, options = {}, acceptedStatuses = [200]) => {
    const startedAt = performance.now();
    let response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
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
      throw new Error(`${options.method ?? "GET"} ${path} did not complete: ${detail}`);
    }
    const durationMs = performance.now() - startedAt;
    const responseText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
    records.push({
      method: options.method ?? "GET",
      path: path.replace(/[?].*$/u, ""),
      status: response.status,
      durationMs,
      errorCode: payload?.error?.code ?? null,
    });
    if (!acceptedStatuses.includes(response.status)) {
      throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}: ${payload?.error?.code ?? "UNKNOWN"}\n${responseText.slice(0, 2_000)}`);
    }
    return { response, payload };
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

function simulationReport(records, elapsedMs) {
  const durations = records.map((record) => record.durationMs);
  const expectedErrors = new Set(["RANKING_NOT_ALLOWED", "RANKING_VERSION_CONFLICT"]);
  const unexpected = records.filter((record) => record.status >= 400 && !expectedErrors.has(record.errorCode));
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
    },
    requests: {
      total: records.length,
      successful: records.filter((record) => record.status < 400).length,
      expectedRejected: records.filter((record) => record.status >= 400 && expectedErrors.has(record.errorCode)).length,
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
      anonymousStudentPayloads: "passed",
      representativeOnlyResponses: "passed",
      concurrentRankingEdits: "passed",
      lateStudentBoundary: "passed",
      teacherRankingSeparated: "passed",
      publishedConsensus: "passed",
    },
  };
}

async function runScenario(baseUrl) {
  const startedAt = performance.now();
  const client = createMeasuredClient(baseUrl);
  console.log("[1/8] 重設示範課堂並讀取教師快照");
  let snapshot = await resetAndLoadClassroom(client);
  console.log("[2/8] 並行讀取 24 名學生作答畫面");
  const initialViews = await loadStudentViews(client, "answering");
  assert.equal(initialViews.filter(({ snapshot: view }) => view.currentUser.participatesInQuestion).length, 21);
  console.log("[3/8] 代表提交其餘小組回答");
  await submitRemainingResponses(client);
  snapshot = (await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}`)).payload.data.snapshot;
  snapshot = await advanceQuestion(client, snapshot, "presenting");
  snapshot = await advanceQuestion(client, snapshot, "ranking");
  console.log("[4/8] 並行讀取 24 名學生排序畫面");
  const rankingViews = await loadStudentViews(client, "ranking");
  console.log("[5/8] 並行提交 21 份學生排序與 3 份遲到拒絕案例");
  await submitStudentRankings(client, rankingViews);
  const groupIds = rankingViews[0].snapshot.groups.map((group) => group.id);
  console.log("[6/8] 提交教師排序與同帳號並行修改");
  await submitTeacherAndConcurrentEdit(client, groupIds);
  snapshot = (await client.request(`/api/classroom/sessions/${DEMO_SESSION_ID}`)).payload.data.snapshot;
  snapshot = await advanceQuestion(client, snapshot, "locked");
  await advanceQuestion(client, snapshot, "published");
  console.log("[7/8] 並行核對 24 名學生公布結果");
  await verifyPublishedResults(client);
  console.log("[8/8] 產生可重現測試報告");
  const report = simulationReport(client.records, performance.now() - startedAt);
  assert.equal(report.requests.unexpectedFailures, 0);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function main() {
  assert.ok(existsSync(generatedConfig), "Build output is missing. Run npm run build first.");
  assert.ok(existsSync(sourceVariables), "Local variables are missing. Copy .dev.vars.example to .dev.vars first.");
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const persistence = await mkdtemp(join(tmpdir(), "classroom-api-simulation-"));
  applyMigrations(persistence);
  let serverOutput = "";
  const child = spawn(process.execPath, [
    wrangler, "dev", "--config", generatedConfig, "--env-file", sourceVariables,
    "--local", "--persist-to", persistence, "--port", String(port),
    "--show-interactive-dev-session=false",
  ], {
    cwd: root,
    env: { ...process.env, WRANGLER_LOG_PATH: resolve(root, ".wrangler/wrangler-api-simulation.log") },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-12_000); });
  child.stderr.on("data", (chunk) => { serverOutput = `${serverOutput}${chunk}`.slice(-12_000); });
  try {
    await waitUntilReady(baseUrl, child, () => serverOutput);
    const report = await runScenario(baseUrl);
    console.log("課堂 API 並行演練通過");
    console.log(`- ${report.requests.total} 個請求；非預期失敗 ${report.requests.unexpectedFailures} 個`);
    console.log(`- P50 ${report.requests.latencyMs.p50} ms；P95 ${report.requests.latencyMs.p95} ms；最大 ${report.requests.latencyMs.maximum} ms`);
    console.log(`- 約 ${report.requests.requestsPerSecond} requests/second（本機合成資料）`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${detail}\nLocal server output:\n${serverOutput.slice(-8_000)}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      if (child.exitCode !== null) return resolveExit();
      child.once("exit", resolveExit);
      setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit();
      }, 5_000).unref();
    });
    await rm(persistence, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}

await main();
