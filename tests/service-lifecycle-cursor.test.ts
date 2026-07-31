import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeServiceLifecycleCursor,
  encodeServiceLifecycleCursor,
} from "../lib/service-lifecycle-cursor.ts";

const SECRET = "test-only-lifecycle-cursor-secret-20260731";
const CONTEXT = { serviceId: "svc-identity", organizationId: "ops-singleton" };
const BOUNDARY = {
  changedAt: "2026-07-31T03:04:05.006Z",
  id: "svc_identity:lifecycle:42",
};

test("signed service lifecycle cursor round-trips its opaque keyset boundary", async () => {
  const encoded = await encodeServiceLifecycleCursor(BOUNDARY, CONTEXT, SECRET);
  assert.match(encoded, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
  assert.equal(encoded.includes(BOUNDARY.changedAt), false);
  assert.deepEqual(await decodeServiceLifecycleCursor(encoded, CONTEXT, SECRET), BOUNDARY);
});

test("service lifecycle cursor rejects payload and signature tampering", async () => {
  const encoded = await encodeServiceLifecycleCursor(BOUNDARY, CONTEXT, SECRET);
  const [payload, signature] = encoded.split(".");
  const payloadTampered = `${flip(payload)}.${signature}`;
  const signatureTampered = `${payload}.${flip(signature)}`;

  await assert.rejects(
    decodeServiceLifecycleCursor(payloadTampered, CONTEXT, SECRET),
    /INVALID_LIFECYCLE_CURSOR/u,
  );
  await assert.rejects(
    decodeServiceLifecycleCursor(signatureTampered, CONTEXT, SECRET),
    /INVALID_LIFECYCLE_CURSOR/u,
  );
});

test("service lifecycle cursor is bound to its service and organization", async () => {
  const encoded = await encodeServiceLifecycleCursor(BOUNDARY, CONTEXT, SECRET);
  await assert.rejects(
    decodeServiceLifecycleCursor(encoded, { ...CONTEXT, serviceId: "svc-other" }, SECRET),
    /INVALID_LIFECYCLE_CURSOR/u,
  );
  await assert.rejects(
    decodeServiceLifecycleCursor(encoded, { ...CONTEXT, organizationId: "ops-other" }, SECRET),
    /INVALID_LIFECYCLE_CURSOR/u,
  );
});

test("service lifecycle cursor rejects oversized, malformed, and noncanonical input", async () => {
  const valid = await encodeServiceLifecycleCursor(BOUNDARY, CONTEXT, SECRET);
  const reordered = JSON.stringify({
    organizationId: CONTEXT.organizationId,
    serviceId: CONTEXT.serviceId,
    id: BOUNDARY.id,
    changedAt: BOUNDARY.changedAt,
    v: 1,
  });
  const noncanonicalSigned = await signedToken(reordered, SECRET);
  const invalid = [
    "",
    "not+base64.signature",
    "a".repeat(513),
    `${valid}=`,
    noncanonicalSigned,
  ];
  for (const cursor of invalid) {
    await assert.rejects(
      decodeServiceLifecycleCursor(cursor, CONTEXT, SECRET),
      /INVALID_LIFECYCLE_CURSOR/u,
    );
  }
});

test("service lifecycle cursor fails closed when its signing secret is absent or too short", async () => {
  await assert.rejects(
    encodeServiceLifecycleCursor(BOUNDARY, CONTEXT, undefined),
    /INVALID_LIFECYCLE_CURSOR/u,
  );
  await assert.rejects(
    encodeServiceLifecycleCursor(BOUNDARY, CONTEXT, "too-short"),
    /INVALID_LIFECYCLE_CURSOR/u,
  );
  const valid = await encodeServiceLifecycleCursor(BOUNDARY, CONTEXT, SECRET);
  await assert.rejects(
    decodeServiceLifecycleCursor(valid, CONTEXT, undefined),
    /INVALID_LIFECYCLE_CURSOR/u,
  );
});

async function signedToken(payload: string, secret: string): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, bytes);
  return `${base64Url(bytes)}.${base64Url(new Uint8Array(signature))}`;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function flip(value: string): string {
  const replacement = value[0] === "A" ? "B" : "A";
  return `${replacement}${value.slice(1)}`;
}
