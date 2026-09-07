import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function harness() {
  const root = new URL("../", import.meta.url);
  const refs = [], timers = new Map(), requests = [];
  let cursor = 0, timerId = 0, effect, cleanup;
  const state = { saveState: "idle", responseText: "", pending: false, error: null, notice: null };
  const response = (content, version, status = "draft") => ({ content, version, status, updatedAt: null });
  state.payload = { actor: { id: "student", isAdmin: false }, snapshot: {
    session: { id: "session" }, question: { id: "question", phase: "answering" },
    groups: [{ id: "group", response: response("", 1) }], currentUser: { groupId: "group", isRepresentative: true },
  } };
  const draftRef = { current: { scope: "student:question:group", text: "", serverContent: "", version: 1, dirty: false } };
  const cache = new Map();
  const window = { setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); } };
  function moduleAt(url) {
    if (cache.has(url.href)) return cache.get(url.href);
    const loadedModule = { exports: {} };
    const require = (name) => {
      if (name === "react") return { useRef(value) { const index = cursor++; return refs[index] ??= { current: value }; }, useEffect(fn) { effect = fn; } };
      const target = name.startsWith("@/") ? new URL(name.slice(2), root) : new URL(name, url);
      if (!/\.tsx?$/.test(target.pathname)) target.pathname += ".ts";
      return moduleAt(target);
    };
    const source = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(source, { module: loadedModule, exports: loadedModule.exports, require, window, URLSearchParams, AbortSignal,
      fetch: (url, options) => new Promise((resolve, reject) => { requests.push({ url, options, resolve, reject }); }),
    });
    cache.set(url.href, loadedModule.exports);
    return loadedModule.exports;
  }
  const { useResponseAutosave: createAutosave } = moduleAt(new URL("app/courses/[courseId]/useResponseAutosave.ts", root));
  let api;
  const render = () => {
    cleanup?.(); cursor = 0;
    const setters = Object.fromEntries(["payload", "responseText", "saveState", "pending", "error", "notice"].map((key) => [
      `set${key[0].toUpperCase()}${key.slice(1)}`, (value) => { state[key] = typeof value === "function" ? value(state[key]) : value; },
    ]));
    api = createAutosave({ ...state, ...setters, draftRef, testStudentId: null });
    cleanup = effect();
    return api;
  };
  const edit = (text) => { state.responseText = text; draftRef.current.text = text; draftRef.current.dirty = true; state.saveState = "idle"; return render(); };
  const fire = () => { const queued = [...timers.values()]; timers.clear(); queued.forEach((fn) => fn()); };
  const resolve = (index, content, version, status = "draft") => requests[index].resolve({ ok: true, json: async () => ({ data: {
    live: { groupId: "group", isRepresentative: true, response: response(content, version, status) },
  } }) });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  render();
  return { state, requests, draftRef, edit, fire, render, resolve, flush };
}

test("slow autosave serializes writes and preserves text typed while the earlier save is in flight", async () => {
  const h = harness();
  h.edit("第一段"); h.fire();
  h.edit("第一段加上新內容"); h.fire();
  assert.equal(h.requests.length, 1);
  h.resolve(0, "第一段", 2); await h.flush();
  assert.equal(h.state.responseText, "第一段加上新內容");
  assert.equal(h.draftRef.current.dirty, true);
  h.render(); h.fire();
  const body = JSON.parse(h.requests[1].options.body);
  assert.equal(body.expectedVersion, 2);
  assert.equal(body.content, "第一段加上新內容");
  h.resolve(1, body.content, 3); await h.flush();
  assert.equal(h.state.saveState, "saved");
  assert.equal(h.draftRef.current.dirty, false);
});

test("submit waits for autosave and sends the latest single-character answer only once", async () => {
  const h = harness();
  h.edit("先前答案"); h.fire();
  const api = h.edit("0");
  const submit = api.saveResponse(true);
  await api.saveResponse(true);
  assert.equal(h.requests.length, 1);
  h.resolve(0, "先前答案", 2); await h.flush();
  assert.match(h.requests[1].url, /questionId=question/);
  h.resolve(1, "先前答案", 2); await h.flush();
  assert.deepEqual(JSON.parse(h.requests[2].options.body), { questionId: "question", content: "0", expectedVersion: 2, submit: true, testStudentId: null });
  h.resolve(2, "0", 3, "submitted"); await submit;
  assert.equal(h.state.pending, false);
  assert.equal(h.state.payload.snapshot.groups[0].response.status, "submitted");
});

test("failed save keeps input, does not loop on polling, and manual retry refreshes the version", async () => {
  const h = harness();
  h.edit("保留這份答案"); h.fire();
  h.requests[0].reject(new Error("network unavailable")); await h.flush();
  assert.equal(h.state.responseText, "保留這份答案");
  assert.equal(h.state.saveState, "error");
  h.render(); h.fire(); assert.equal(h.requests.length, 1);
  const retry = h.render().saveResponse(true); await h.flush();
  h.resolve(1, "舊草稿", 5); await h.flush();
  assert.equal(JSON.parse(h.requests[2].options.body).content, "保留這份答案");
  assert.equal(JSON.parse(h.requests[2].options.body).expectedVersion, 5);
  h.resolve(2, "保留這份答案", 6, "submitted"); await retry;
  assert.equal(h.state.error, null);
});

test("a late acknowledgement from a previous question cannot overwrite the newly selected answer", async () => {
  const h = harness();
  h.edit("上一题文字"); h.fire();
  Object.assign(h.draftRef.current, { scope: "student:question-2:group", text: "本題文字", version: 1 });
  h.state.responseText = "本題文字";
  h.resolve(0, "上一题文字", 2); await h.flush();
  assert.equal(h.state.responseText, "本題文字");
  assert.equal(h.state.payload.snapshot.groups[0].response.version, 1);
});
