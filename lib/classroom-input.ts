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
  let tooLarge = declaredLength !== null && Number.isSafeInteger(declaredLength) && declaredLength >= 0 && declaredLength > maxBytes;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (tooLarge) continue;
      if (byteLength + result.value.byteLength > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        byteLength = 0;
        continue;
      }
      chunks.push(result.value);
      byteLength += result.value.byteLength;
    }
  } catch {
    throw new ClassroomRequestBodyError("read_failed");
  }
  if (tooLarge) throw new ClassroomRequestBodyError("too_large");

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

export async function drainClassroomRequestBody(request: Request): Promise<void> {
  const reader = request.body?.getReader();
  if (!reader) return;
  try {
    while (!(await reader.read()).done) {
      // Deliberately discard the request body without retaining it.
    }
  } catch {
    throw new ClassroomRequestBodyError("read_failed");
  }
}
