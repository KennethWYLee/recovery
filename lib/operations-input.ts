import { cleanOperationsText } from "./operations-domain.ts";

export const MAX_JSON_REQUEST_BYTES = 32_768;

export type RequestBodyErrorKind =
  | "too_large"
  | "invalid_utf8"
  | "invalid_json"
  | "not_object"
  | "read_failed";

export class RequestBodyError extends Error {
  readonly kind: RequestBodyErrorKind;

  constructor(kind: RequestBodyErrorKind) {
    super(kind);
    this.name = "RequestBodyError";
    this.kind = kind;
  }
}

/**
 * Applies the domain's canonical text normalization while retaining one extra
 * character so callers can distinguish an over-limit value from a valid value.
 */
export function boundedOperationsText(
  value: unknown,
  maxLength: number,
): { value: string; exceedsLimit: boolean } {
  const normalized = cleanOperationsText(value, maxLength + 1);
  return {
    value: normalized,
    exceedsLimit: normalized.length > maxLength,
  };
}

/** Reads a JSON object without ever buffering more than maxBytes of body data. */
export async function readBoundedJsonObject(
  request: Request,
  maxBytes = MAX_JSON_REQUEST_BYTES,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new RequestBodyError("invalid_json");

  const declaredLengthHeader = request.headers.get("content-length");
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  const declaredTooLarge = declaredLength !== null
    && Number.isSafeInteger(declaredLength)
    && declaredLength >= 0
    && declaredLength > maxBytes;

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let tooLarge = declaredTooLarge;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (tooLarge) continue;
      if (byteLength + chunk.byteLength > maxBytes) {
        // Workerd's local proxy can abort the response when an inbound body is
        // left unread. Discard the rest of an oversized stream while retaining
        // none of it, so memory remains bounded and the API can return its 413.
        tooLarge = true;
        chunks.length = 0;
        byteLength = 0;
        continue;
      }
      chunks.push(chunk);
      byteLength += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError("read_failed");
  }
  if (tooLarge) throw new RequestBodyError("too_large");

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RequestBodyError("invalid_utf8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new RequestBodyError("invalid_json");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new RequestBodyError("not_object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Consumes an unsupported request body without retaining it. Workerd's local
 * proxy can abort the response when a body is left unread, so callers that
 * reject a media type still drain the stream before returning a problem.
 */
export async function drainOperationsRequestBody(request: Request): Promise<void> {
  const reader = request.body?.getReader();
  if (!reader) return;
  try {
    while (!(await reader.read()).done) {
      // Deliberately discard every chunk so memory use does not grow with the body.
    }
  } catch {
    throw new RequestBodyError("read_failed");
  }
}
