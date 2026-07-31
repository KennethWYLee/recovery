export type ServiceLifecycleCursor = {
  changedAt: string;
  id: string;
};

export type ServiceLifecycleCursorContext = {
  serviceId: string;
  organizationId: string;
};

const CURSOR_VERSION = 1;
const MAX_CURSOR_LENGTH = 512;
const MIN_SECRET_LENGTH = 32;
const HMAC_ALGORITHM = "HMAC";
const HMAC_HASH = "SHA-256";
const EVENT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,256}$/;
const CONTEXT_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

type CursorPayload = ServiceLifecycleCursor & ServiceLifecycleCursorContext & {
  v: typeof CURSOR_VERSION;
};

export function assertServiceLifecycleCursorSecret(secret: unknown): asserts secret is string {
  validatedSecret(secret);
}

export async function encodeServiceLifecycleCursor(
  cursor: ServiceLifecycleCursor,
  context: ServiceLifecycleCursorContext,
  secret: unknown,
): Promise<string> {
  try {
    const payload = canonicalPayload(cursor, context);
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
    const signature = await sign(payloadBytes, validatedSecret(secret));
    const encoded = `${base64UrlEncode(payloadBytes)}.${base64UrlEncode(signature)}`;
    if (encoded.length > MAX_CURSOR_LENGTH) throw new Error("cursor too long");
    return encoded;
  } catch {
    throw invalidCursor();
  }
}

export async function decodeServiceLifecycleCursor(
  value: string,
  context: ServiceLifecycleCursorContext,
  secret: unknown,
): Promise<ServiceLifecycleCursor> {
  if (!value || value.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  const segments = value.split(".");
  if (
    segments.length !== 2
    || !BASE64URL_PATTERN.test(segments[0])
    || !BASE64URL_PATTERN.test(segments[1])
  ) {
    throw invalidCursor();
  }

  try {
    const payloadBytes = base64UrlDecode(segments[0]);
    const signature = base64UrlDecode(segments[1]);
    if (signature.byteLength !== 32) throw new Error("invalid signature length");
    const key = await importHmacKey(validatedSecret(secret));
    const verified = await crypto.subtle.verify(HMAC_ALGORITHM, key, signature, payloadBytes);
    if (!verified) throw new Error("invalid signature");

    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    const parsed: unknown = JSON.parse(decoded);
    if (!isRecord(parsed) || Object.keys(parsed).length !== 5) throw new Error("invalid payload");
    const payload = canonicalPayload(
      { changedAt: parsed.changedAt, id: parsed.id },
      { serviceId: parsed.serviceId, organizationId: parsed.organizationId },
    );
    if (parsed.v !== CURSOR_VERSION || JSON.stringify(payload) !== decoded) {
      throw new Error("noncanonical payload");
    }

    const expectedContext = validateContext(context);
    if (
      payload.serviceId !== expectedContext.serviceId
      || payload.organizationId !== expectedContext.organizationId
    ) {
      throw new Error("cursor context mismatch");
    }
    return { changedAt: payload.changedAt, id: payload.id };
  } catch {
    throw invalidCursor();
  }
}

function canonicalPayload(
  cursor: { changedAt: unknown; id: unknown },
  context: { serviceId: unknown; organizationId: unknown },
): CursorPayload {
  const validatedCursor = validateCursorFields(cursor.changedAt, cursor.id);
  const validatedContext = validateContext(context);
  return {
    v: CURSOR_VERSION,
    changedAt: validatedCursor.changedAt,
    id: validatedCursor.id,
    serviceId: validatedContext.serviceId,
    organizationId: validatedContext.organizationId,
  };
}

function validateCursorFields(changedAt: unknown, id: unknown): ServiceLifecycleCursor {
  if (
    typeof changedAt !== "string"
    || !UTC_TIMESTAMP_PATTERN.test(changedAt)
    || !Number.isFinite(Date.parse(changedAt))
    || typeof id !== "string"
    || !EVENT_ID_PATTERN.test(id)
  ) {
    throw invalidCursor();
  }
  return { changedAt, id };
}

function validateContext(context: { serviceId: unknown; organizationId: unknown }): ServiceLifecycleCursorContext {
  if (
    typeof context.serviceId !== "string"
    || !CONTEXT_ID_PATTERN.test(context.serviceId)
    || typeof context.organizationId !== "string"
    || !CONTEXT_ID_PATTERN.test(context.organizationId)
  ) {
    throw invalidCursor();
  }
  return { serviceId: context.serviceId, organizationId: context.organizationId };
}

function validatedSecret(secret: unknown): string {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) throw invalidCursor();
  return secret;
}

async function sign(payload: Uint8Array<ArrayBuffer>, secret: string): Promise<ArrayBuffer> {
  const key = await importHmacKey(secret);
  return crypto.subtle.sign(HMAC_ALGORITHM, key, payload);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: HMAC_ALGORITHM, hash: HMAC_HASH },
    false,
    ["sign", "verify"],
  );
}

function base64UrlEncode(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) throw invalidCursor();
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob(value.replaceAll("-", "+").replaceAll("_", "/") + padding);
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (base64UrlEncode(bytes) !== value) throw invalidCursor();
  return bytes;
}

function invalidCursor(): Error {
  return new Error("INVALID_LIFECYCLE_CURSOR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
