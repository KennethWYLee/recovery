import assert from "node:assert/strict";
import test from "node:test";

import {
  RequestBodyError,
  boundedOperationsText,
  drainOperationsRequestBody,
  readBoundedJsonObject,
} from "../lib/operations-input.ts";

function streamRequest(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  onCancel?: () => void,
): Request {
  let index = 0;
  return new Request("https://continuity-ops.invalid/api/v1/test", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index]);
        index += 1;
      },
      cancel() {
        onCancel?.();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function rejectsWithKind(promise: Promise<unknown>, kind: RequestBodyError["kind"]): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof RequestBodyError);
    assert.equal(error.kind, kind);
    return true;
  });
}

test("bounded JSON reader accepts a streamed object without Content-Length", async () => {
  const request = streamRequest([bytes('{"name":"'), bytes("核心服務"), bytes('"}')]);
  assert.deepEqual(await readBoundedJsonObject(request), { name: "核心服務" });
});

test("bounded JSON reader discards an oversized stream despite an understated Content-Length", async () => {
  let cancelled = false;
  const request = streamRequest([bytes("1234"), bytes("56789")], { "content-length": "1" }, () => {
    cancelled = true;
  });
  await rejectsWithKind(readBoundedJsonObject(request, 8), "too_large");
  assert.equal(cancelled, false);
});

test("bounded JSON reader drains a declared oversize without retaining its body", async () => {
  let cancelled = false;
  const request = streamRequest([bytes("{}")], { "content-length": "9" }, () => {
    cancelled = true;
  });
  await rejectsWithKind(readBoundedJsonObject(request, 8), "too_large");
  assert.equal(cancelled, false);
});

test("unsupported-media body drain consumes every chunk without cancellation", async () => {
  let cancelled = false;
  const request = streamRequest([bytes("not-"), bytes("json")], {}, () => {
    cancelled = true;
  });
  await drainOperationsRequestBody(request);
  assert.equal(request.bodyUsed, true);
  assert.equal(cancelled, false);
});

test("bounded JSON reader clearly distinguishes malformed UTF-8 and JSON", async () => {
  await rejectsWithKind(
    readBoundedJsonObject(streamRequest([new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d])])),
    "invalid_utf8",
  );
  await rejectsWithKind(readBoundedJsonObject(streamRequest([bytes('{"x":}')])) , "invalid_json");
  await rejectsWithKind(readBoundedJsonObject(streamRequest([bytes("[]")])), "not_object");
});

test("bounded text normalizes NFKC and controls without truncating silently", () => {
  assert.deepEqual(boundedOperationsText("  Ａ\u0000B\r\nC  ", 20), {
    value: "A B\nC",
    exceedsLimit: false,
  });
  assert.deepEqual(boundedOperationsText("12345", 4), {
    value: "12345",
    exceedsLimit: true,
  });
  assert.deepEqual(boundedOperationsText(undefined, 4), {
    value: "",
    exceedsLimit: false,
  });
});
