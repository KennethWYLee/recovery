import assert from "node:assert/strict";
import test from "node:test";
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
