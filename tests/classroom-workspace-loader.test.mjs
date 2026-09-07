import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const root = new URL("../", import.meta.url);

function harness() {
  const state = { pending: false, error: null, payload: null };
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  const context = {
    AbortController, URLSearchParams, crypto,
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    fetch: (_url, { signal }) => new Promise((resolve, reject) => {
      requests.push({ signal, resolve });
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
  const { useWorkspaceLoader: createLoader } = moduleAt(new URL("app/courses/[courseId]/useWorkspaceLoader.ts", root));
  const refs = Object.fromEntries(["responseKey", "rankingKey", "selectedQuestion", "snapshotSignature"].map((key) => [key, { current: "" }]));
  const loader = createLoader({ courseId: "synthetic-course", testStudentId: null, refs, initializeRanking() {}, setters: {
    setPending: (value) => { state.pending = value; }, setError: (value) => { state.error = value; },
    setPayload: (value) => { state.payload = value; }, setResponseText() {}, setAnswerLabels() {},
  } });
  const respond = (index, snapshot = null) => requests[index].resolve({ ok: true, json: async () => ({ data: { actor: { id: "synthetic-actor" }, snapshot } }) });
  return { ...loader, state, requests, timers, respond };
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
  const replaced = h.load(true); h.respond(2, snapshot); await replaced;
  assert.equal(h.state.payload.snapshot.currentUser.isRepresentative, false);
});
