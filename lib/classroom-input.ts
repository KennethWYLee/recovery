export type ClassroomRequestBodyErrorKind = "too_large" | "invalid_utf8" | "invalid_json" | "not_object" | "read_failed";

export class ClassroomRequestBodyError extends Error {
  readonly kind: ClassroomRequestBodyErrorKind;

  constructor(kind: ClassroomRequestBodyErrorKind) {
    super(kind);
    this.kind = kind;
    this.name = "ClassroomRequestBodyError";
  }
}

export async function readBoundedClassroomJsonObject(
  request: Request,
  maxBytes = 8_192,
): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new ClassroomRequestBodyError("invalid_json");
  const declaredLengthHeader = request.headers.get("content-length");
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  if (declaredLength !== null && Number.isSafeInteger(declaredLength) && declaredLength >= 0 && declaredLength > maxBytes) {
    await reader.cancel().catch(() => undefined);
    throw new ClassroomRequestBodyError("too_large");
  }
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (byteLength + result.value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ClassroomRequestBodyError("too_large");
      }
      chunks.push(result.value);
      byteLength += result.value.byteLength;
    }
  } catch (error) {
    if (error instanceof ClassroomRequestBodyError) throw error;
    throw new ClassroomRequestBodyError("read_failed");
  }

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
    throw new ClassroomRequestBodyError("invalid_utf8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ClassroomRequestBodyError("invalid_json");
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new ClassroomRequestBodyError("not_object");
  }
  return parsed as Record<string, unknown>;
}

export async function drainClassroomRequestBody(request: Request, maximumDiscardBytes = 65_536): Promise<void> {
  const reader = request.body?.getReader();
  if (!reader) return;
  let discardedBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      discardedBytes += result.value.byteLength;
      if (discardedBytes > maximumDiscardBytes) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  } catch {
    throw new ClassroomRequestBodyError("read_failed");
  }
}
