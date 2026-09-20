import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as classroomDomain from "../lib/classroom-domain.ts";
import ts from "typescript";

const root = new URL("../", import.meta.url);

test("unavailable course keeps unsaved text available to copy before sign-in", () => {
  const loadedModule = { exports: {} };
  const nativeRequire = createRequire(import.meta.url);
  const source = ts.transpileModule(readFileSync(new URL("app/courses/[courseId]/CourseWorkspaceLoadState.tsx", root), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, { module: loadedModule, exports: loadedModule.exports, encodeURIComponent,
    require: (specifier) => specifier === "./CourseWorkspaceHeader"
      ? { CourseJoinHelp: () => createElement("span", null, "輸入課程代碼加入") }
      : nativeRequire(specifier),
  });
  const props = { error: "請重新登入", draftText: "我的回答 <尚未儲存>", draftDirty: true,
    courseId: "synthetic-course", hosted: true, onRetry() {} };
  const render = (overrides) => renderToStaticMarkup(createElement(loadedModule.exports.CourseWorkspaceLoadState, { ...props, ...overrides }));
  const html = render();
  assert.match(html, /role="alert"/);
  assert.match(html, /<textarea[^>]*readOnly=""[^>]*>我的回答 &lt;尚未儲存&gt;<\/textarea>/);
  assert.match(html, /href="\/signin-with-chatgpt\?return_to=%2Fcourses%2Fsynthetic-course" target="_top"/);
  assert.match(html, /重新載入/);
  assert.match(html, /輸入課程代碼加入/);
  assert.doesNotMatch(render({ draftDirty: false, hosted: false }), /textarea|signin-with-chatgpt/);
  assert.match(render({ error: "" }), /正在開啟課程/);
  assert.doesNotMatch(render({ error: "" }), /role="alert"/);
});

function harness() {
  const state = { pending: false, error: null, payload: null };
  const requests = [];
  const timers = new Map();
  const intervals = new Map();
  const page = new EventTarget();
  page.visibilityState = "visible";
  const browser = new EventTarget();
  let timerId = 0;
  browser.setInterval = (callback, delay) => { intervals.set(++timerId, { callback, delay }); return timerId; };
  browser.clearInterval = (id) => intervals.delete(id);
  const context = {
    AbortController, URLSearchParams, Error, TypeError, crypto, document: page, window: browser,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: (url, { signal, headers }) => new Promise((resolve, reject) => {
      requests.push({ url, headers, signal, resolve, reject });
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  };
  const cache = new Map();
  function moduleAt(url) {
    if (cache.has(url.href)) return cache.get(url.href);
    const loadedModule = { exports: {} };
    const require = (specifier) => {
      if (specifier === "react") return { useCallback: (fn) => fn, useRef: (value) => ({ current: value }) };
      const target = specifier.startsWith("@/") ? new URL(specifier.slice(2), root) : new URL(specifier, url);
      if (!/\.tsx?$/.test(target.pathname)) target.pathname += ".ts";
      return moduleAt(target);
    };
    const source = ts.transpileModule(readFileSync(url, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(source, { ...context, module: loadedModule, exports: loadedModule.exports, require });
    cache.set(url.href, loadedModule.exports);
    return loadedModule.exports;
  }
  const { useWorkspaceLoader: createLoader, startWorkspaceRefresh } = moduleAt(new URL("app/courses/[courseId]/useWorkspaceLoader.ts", root));
  const refs = Object.fromEntries(["responseKey", "rankingKey", "selectedQuestion", "snapshotSignature"].map((key) => [key, { current: "" }]));
  refs.responseDraft = { current: { scope: "", text: "", serverContent: "", version: 0, dirty: false } };
  const loader = createLoader({ courseId: "synthetic-course", testStudentId: null, refs, initializeRanking() {}, setters: {
    setPending: (value) => { state.pending = value; }, setLoadError: (value) => { state.error = value; },
    setPayload: (value) => { state.payload = typeof value === "function" ? value(state.payload) : value; }, setResponseText(value) { state.responseText = value; }, setAnswerLabels() {},
  } });
  const respond = (index, snapshot = null) => requests[index].resolve({ ok: true, json: async () => ({ data: { actor: { id: "synthetic-actor" }, snapshot } }) });
  return { ...loader, state, requests, timers, respond, intervals, page, browser, startWorkspaceRefresh, refs };
}

test("initial load times out with a retryable error and retry can succeed", async () => {
  const h = harness();
  const initial = h.load();
  assert.equal(h.state.pending, true);
  const timeout = [...h.timers.values()][0];
  assert.equal(timeout.delay, 15_000);
  timeout.callback();
  await initial;
  assert.equal(h.state.pending, false);
  assert.match(h.state.error, /15 秒.*重新載入/);
  assert.equal(h.timers.size, 0);
  const retry = h.load();
  h.respond(1);
  await retry;
  assert.equal(h.state.error, null);
  assert.equal(h.state.payload.actor.id, "synthetic-actor");
  assert.equal(h.state.pending, false);
  assert.equal(h.timers.size, 0);
});

test("polling never aborts an unfinished foreground or background request", async () => {
  const h = harness();
  const initial = h.load();
  await h.load(true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].signal.aborted, false);
  h.respond(0);
  await initial;
  const poll = h.load(true);
  await h.load(true);
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].signal.aborted, false);
  h.respond(1);
  await poll;
  assert.equal(h.state.pending, false);
});

test("manual retry supersedes an old request without letting it clear the new loading state", async () => {
  const h = harness();
  const initial = h.load();
  const retry = h.load();
  await initial;
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.state.pending, true);
  assert.equal(h.state.error, null);
  h.respond(1);
  await retry;
  assert.equal(h.state.pending, false);
  assert.equal(h.timers.size, 0);
});

test("student polling applies speaker handover even when group identities are hidden", async () => {
  const h = harness();
  const snapshot = {
    session: { version: 1 }, question: { id: "question-1", version: 1, phase: "answering" },
    completion: { checkedIn: 2, submittedGroups: 0, rankedStudents: 0 },
    groups: [{ id: "group-1", representativeUserId: null, members: [], response: { version: 1, status: "draft", content: "共同草稿" } }],
    participants: [],
    currentUser: { groupId: "group-1", isRepresentative: false, participatesInQuestion: true, canRank: false, hasSubmittedRanking: false },
  };
  const initial = h.load(); h.respond(0, snapshot); await initial;
  assert.equal(h.state.payload.snapshot.currentUser.isRepresentative, false);
  const appointed = { ...snapshot, currentUser: { ...snapshot.currentUser, isRepresentative: true } };
  const poll = h.load(true); h.respond(1, appointed); await poll;
  assert.equal(h.state.payload.snapshot.currentUser.isRepresentative, true);
  assert.equal(h.state.payload.snapshot.groups[0].response.content, "共同草稿");
  assert.equal(h.state.payload.snapshot.groups[0].representativeUserId, null);
  h.refs.responseDraft.current.text = "學生繼續輸入的新答案";
  h.refs.responseDraft.current.dirty = true;
  const updated = h.load(true);
  h.respond(2, { ...appointed, groups: [{ ...snapshot.groups[0], response: { ...snapshot.groups[0].response, version: 3, content: "先前儲存的答案" } }] });
  await updated;
  assert.equal(h.state.responseText, "學生繼續輸入的新答案");
  const replaced = h.load(true); h.respond(3, snapshot); await replaced;
  assert.equal(h.state.payload.snapshot.currentUser.isRepresentative, false);
  for (const count of [1, 2]) {
    const progress = h.load(true);
    h.respond(count + 3, { ...snapshot, completion: { ...snapshot.completion, submittedGroups: count } });
    await progress;
    assert.equal(h.state.payload.snapshot.completion.submittedGroups, count);
  }
});

test("teacher progress refreshes every two seconds and resumes immediately on focus", () => {
  const h = harness();
  let calls = 0;
  const stop = h.startWorkspaceRefresh({ load: async (quiet) => { assert.equal(quiet, true); calls++; }, isAdmin: true, answering: true });
  const interval = [...h.intervals.values()][0];
  assert.equal(interval.delay, 2000);
  h.page.visibilityState = "hidden";
  interval.callback();
  assert.equal(calls, 0);
  h.page.visibilityState = "visible";
  h.page.dispatchEvent(new Event("visibilitychange"));
  h.browser.dispatchEvent(new Event("focus"));
  assert.equal(calls, 2);
  stop();
  assert.equal(h.intervals.size, 0);
  h.browser.dispatchEvent(new Event("focus"));
  h.page.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 2);
});

test("unchanged polling preserves the current payload and local text without reading a response body", async () => {
  const h = harness();
  const initial = h.load();
  h.requests[0].resolve({ ok: true, headers: new Headers({ etag: '"one"' }), json: async () => ({ data: { actor: { id: "synthetic-actor" }, snapshot: null } }) });
  await initial;
  const payload = h.state.payload;
  h.refs.responseDraft.current.text = "正在輸入的新答案";
  h.refs.responseDraft.current.dirty = true;
  const poll = h.load(true);
  assert.equal(h.requests[1].headers["if-none-match"], '"one"');
  h.requests[1].resolve({ status: 304, headers: new Headers({ "x-classroom-time": new Date().toISOString() }), json: () => assert.fail("304 has no body") });
  await poll;
  assert.equal(h.state.payload, payload);
  assert.equal(h.refs.responseDraft.current.text, "正在輸入的新答案");
  const selected = h.load(true, "different-question");
  assert.equal(h.requests[2].headers["if-none-match"], undefined);
  h.respond(2); await selected;
  const refresh = h.load(false);
  assert.equal(h.requests[3].headers["if-none-match"], undefined);
  h.respond(3); await refresh;
});

test("student refresh checks every three seconds and pauses while hidden", () => {
  const h = harness(); let calls = 0;
  const stop = h.startWorkspaceRefresh({ load: async () => { calls++; }, isAdmin: false, answering: true });
  const interval = [...h.intervals.values()][0];
  assert.equal(interval.delay, 3000);
  interval.callback(); assert.equal(calls, 1);
  h.page.visibilityState = "hidden";
  interval.callback(); assert.equal(calls, 1);
  stop(); assert.equal(h.intervals.size, 0);
});

function draftSnapshot() {
  return {
    session: { version: 1 }, question: { id: "question-1", version: 1, phase: "answering" },
    completion: { checkedIn: 2, submittedGroups: 0, rankedStudents: 0 },
    groups: [{ id: "group-1", representativeUserId: null, members: [], response: { version: 1, status: "draft", content: "先前草稿" } }],
    participants: [],
    currentUser: { groupId: "group-1", isRepresentative: true, participatesInQuestion: true, canRank: false, hasSubmittedRanking: false },
  };
}

function respondWithRevision(h, index, snapshot = null) {
  h.requests[index].resolve({ ok: true, status: 200, headers: new Headers({ etag: 'W/"one"' }),
    json: async () => ({ data: { actor: { id: "synthetic-actor" }, snapshot } }) });
}

for (const status of [401, 403, 404]) {
  test(`background ${status} hides stale controls and restores the same revision without losing the draft`, async () => {
    const h = harness();
    const initial = h.load(); respondWithRevision(h, 0, draftSnapshot()); await initial;
    h.refs.responseDraft.current.text = "尚未送出的回答";
    h.refs.responseDraft.current.dirty = true;
    const failed = h.load(true);
    h.requests[1].resolve({ status, ok: false, json: async () => ({ error: { message: `無法存取 ${status}` } }) });
    await failed;
    assert.equal(h.state.payload, null);
    assert.match(h.state.error, new RegExp(String(status)));
    assert.equal(h.refs.responseDraft.current.text, "尚未送出的回答");
    const recovered = h.load(true);
    assert.equal(h.requests[2].headers["if-none-match"], undefined);
    respondWithRevision(h, 2, draftSnapshot()); await recovered;
    assert.equal(h.state.error, null);
    assert.equal(h.state.payload.actor.id, "synthetic-actor");
    assert.equal(h.state.responseText, "尚未送出的回答");
  });
}

test("background network and service errors are visible, preserve input and clear on a successful 304", async () => {
  const h = harness();
  const initial = h.load(); respondWithRevision(h, 0); await initial;
  const payload = h.state.payload;
  h.refs.responseDraft.current.text = "正在輸入";
  h.refs.responseDraft.current.dirty = true;
  const disconnected = h.load(true);
  h.requests[1].reject(new TypeError("Failed to fetch")); await disconnected;
  assert.match(h.state.error, /網路連線中斷/);
  assert.equal(h.state.payload, payload);
  const unavailable = h.load(true);
  h.requests[2].resolve({ status: 503, ok: false, json: async () => ({ error: { message: "服務暫時無法使用" } }) });
  await unavailable;
  assert.match(h.state.error, /服務暫時/);
  assert.equal(h.state.payload, payload);
  const recovered = h.load(true);
  h.requests[3].resolve({ status: 304, headers: new Headers(), json: () => assert.fail("304 has no body") });
  await recovered;
  assert.equal(h.state.error, null);
  assert.equal(h.state.payload, payload);
  assert.equal(h.refs.responseDraft.current.text, "正在輸入");
});

test("a successful background retry clears an initial failure without a manual reload", async () => {
  const h = harness();
  const initial = h.load();
  h.requests[0].resolve({ status: 403, ok: false, json: async () => ({ error: { message: "尚未取得權限" } }) });
  await initial;
  assert.match(h.state.error, /權限/);
  const retry = h.load(true); h.respond(1); await retry;
  assert.equal(h.state.error, null);
  assert.equal(h.state.payload.actor.id, "synthetic-actor");
});

test("published lists independently order consensus by score and teacher by saved choices", () => {
  const nativeRequire = createRequire(import.meta.url);
  const target = { exports: {} };
  const source = ts.transpileModule(readFileSync(new URL("app/courses/[courseId]/StudentConsensusResults.tsx", root), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(source, { module: target, exports: target.exports, require: (name) => name === "@/lib/classroom-domain" ? classroomDomain : nativeRequire(name) });
  const snapshot = {
    groups: [{ id: "a", label: "回答 A", response: { content: "方案甲" } }, { id: "b", label: "回答 B", response: { content: "方案乙" } }],
    results: [{ groupId: "a", label: "回答 A", averageScore: 1, finalRank: 2, maximumScore: 2, ratingCount: 2, rankCounts: [0, 2], tied: false },
      { groupId: "b", label: "回答 B", averageScore: 2, finalRank: 1, maximumScore: 2, ratingCount: 2, rankCounts: [2, 0], tied: false }],
    teacherRanking: { orderedGroupIds: ["a", "b"] }, completion: { rankedStudents: 2 },
    currentUser: { orderedGroupIds: ["a", "b"], groupId: "a" },
  };
  const html = renderToStaticMarkup(createElement(target.exports.StudentConsensusResults, { snapshot }));
  const consensus = html.split('aria-label="全班共識排名"')[1].split('</section>')[0];
  const teacher = html.split('aria-label="教師排序排名"')[1].split('</section>')[0];
  assert.ok(consensus.indexOf("方案乙") < consensus.indexOf("方案甲"));
  assert.ok(teacher.indexOf("方案甲") < teacher.indexOf("方案乙"));
  assert.match(consensus, /2\.00 分/);
  assert.match(consensus, /本組，不列入/);
  assert.doesNotMatch(teacher, /共識分數|你的排序/);
  assert.deepEqual(snapshot.results.map((result) => result.groupId), ["a", "b"]);
});
