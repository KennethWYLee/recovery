import assert from "node:assert/strict";
import test from "node:test";
import { matchesIfNoneMatch } from "../lib/classroom-http.ts";
import {
  ClassroomRequestBodyError,
  drainClassroomRequestBody,
  readBoundedClassroomJsonObject,
} from "../lib/classroom-input.ts";

function streamRequest(chunks: Uint8Array[], headers: Record<string, string> = {}): Request {
  let index = 0;
  return new Request("https://classroom.example.test/api/classroom/courses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) return controller.close();
        controller.enqueue(chunks[index]);
        index += 1;
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

const bytes = (value: string) => new TextEncoder().encode(value);

test("conditional reads match weak and strong entity tags and complete tag lists", () => {
  for (const header of ['"current"', 'W/"current"', '"old", W/"current"', ' W/"current" , "old" ', ', , W/"current",', '*']) {
    assert.equal(matchesIfNoneMatch(header, '"current"'), true, header);
    assert.equal(matchesIfNoneMatch(header, 'W/"current"'), true, header);
  }
  assert.equal(matchesIfNoneMatch('W/"a,b", "old"', '"a,b"'), true);
  assert.equal(matchesIfNoneMatch('""', 'W/""'), true);
});

test("conditional reads reject stale, partial, malformed and case-mismatched tags", () => {
  for (const header of [null, '', ', ,', '"old"', 'W/"Current"', 'current', 'W/current', 'W/"current', 'w/"current"', '* , "current"', 'garbage, "current"', '"prefix, "current", garbage', '"current" trailing']) {
    assert.equal(matchesIfNoneMatch(header, '"current"'), false, String(header));
  }
  assert.equal(matchesIfNoneMatch('W/"a,b"', '"b"'), false);
});

async function rejectsWithKind(promise: Promise<unknown>, kind: ClassroomRequestBodyError["kind"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ClassroomRequestBodyError);
    assert.equal(error.kind, kind);
    return true;
  });
}

test("bounded classroom JSON accepts an object and rejects oversized input", async () => {
  assert.deepEqual(await readBoundedClassroomJsonObject(streamRequest([bytes('{"name":"資料庫"}')])) , { name: "資料庫" });
  await rejectsWithKind(readBoundedClassroomJsonObject(streamRequest([bytes("1234"), bytes("56789")]), 8), "too_large");
});

test("bounded classroom JSON distinguishes malformed encodings and shapes", async () => {
  await rejectsWithKind(readBoundedClassroomJsonObject(streamRequest([new Uint8Array([0x7b, 0xff, 0x7d])])), "invalid_utf8");
  await rejectsWithKind(readBoundedClassroomJsonObject(streamRequest([bytes('{"x":}')])) , "invalid_json");
  await rejectsWithKind(readBoundedClassroomJsonObject(streamRequest([bytes("[]")])), "not_object");
});

test("unsupported classroom request bodies are fully drained", async () => {
  const request = streamRequest([bytes("not-json")]);
  await drainClassroomRequestBody(request);
  assert.equal(request.bodyUsed, true);
});

test("oversized request streams are cancelled instead of being read without a bound", async () => {
  let cancelled = false;
  const request = new Request("https://classroom.example.test/api/classroom/courses", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await rejectsWithKind(readBoundedClassroomJsonObject(request, 8), "too_large");
  assert.equal(cancelled, true);
});

test("declared oversized bodies are rejected before the first stream read", async () => {
  let cancelled = false;
  let pulled = false;
  const request = new Request("https://classroom.example.test/api/classroom/courses", {
    method: "POST",
    headers: { "content-length": "100" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled = true;
        controller.enqueue(bytes("{}"));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await rejectsWithKind(readBoundedClassroomJsonObject(request, 8), "too_large");
  assert.equal(cancelled, true);
  assert.equal(pulled, false);
});

test("missing and failed request streams use explicit machine-readable errors", async () => {
  const emptyRequest = new Request("https://classroom.example.test/api/classroom/courses", { method: "POST" });
  await rejectsWithKind(readBoundedClassroomJsonObject(emptyRequest), "invalid_json");

  const failedRequest = new Request("https://classroom.example.test/api/classroom/courses", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("synthetic stream failure");
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await rejectsWithKind(readBoundedClassroomJsonObject(failedRequest), "read_failed");
});

test("discarding unsupported bodies is bounded and reports stream failures", async () => {
  let cancelled = false;
  const oversizedRequest = new Request("https://classroom.example.test/api/classroom/courses", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await drainClassroomRequestBody(oversizedRequest, 8);
  assert.equal(cancelled, true);

  const failedRequest = new Request("https://classroom.example.test/api/classroom/courses", {
    method: "POST",
    body: new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("synthetic stream failure");
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  await rejectsWithKind(drainClassroomRequestBody(failedRequest), "read_failed");
});
