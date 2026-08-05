import { classroomDb, loadOrProvisionClassroomActor, type ClassroomActor } from "@/db/classroom";
import { requestIsSameOrigin } from "@/lib/operations-auth";
import { RequestBodyError, drainOperationsRequestBody, readBoundedJsonObject } from "@/lib/operations-input";

export class ClassroomApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClassroomApiError";
  }
}

export type ClassroomApiContext = {
  actor: ClassroomActor;
  db: D1Database;
};

export async function classroomApiContext(request: Request, teacherOnly = false): Promise<ClassroomApiContext> {
  if (!requestIsSameOrigin(request)) {
    throw new ClassroomApiError(403, "CROSS_ORIGIN_REQUEST_REJECTED", "這項操作必須從本系統送出。");
  }
  const actor = await loadOrProvisionClassroomActor(request);
  if (!actor) throw new ClassroomApiError(401, "AUTHENTICATION_REQUIRED", "請使用經驗證的校內帳號登入。");
  if (teacherOnly && actor.role !== "teacher") {
    throw new ClassroomApiError(403, "TEACHER_PERMISSION_REQUIRED", "只有教師可以管理課程。");
  }
  return { actor, db: classroomDb() };
}

export async function classroomJsonBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    await drainOperationsRequestBody(request);
    throw new ClassroomApiError(415, "JSON_REQUIRED", "請使用JSON格式送出資料。");
  }
  try {
    return await readBoundedJsonObject(request, 8_192);
  } catch (error) {
    if (!(error instanceof RequestBodyError)) throw error;
    if (error.kind === "too_large") throw new ClassroomApiError(413, "REQUEST_TOO_LARGE", "送出的資料超過系統限制。");
    throw new ClassroomApiError(400, "INVALID_JSON", "送出的資料格式不完整。");
  }
}

export function classroomCourseId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return /^course-[a-z0-9-]{8,80}$/u.test(id) ? id : "";
}

export function expectedVersion(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : 0;
}

export function classroomData<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data }, init);
}

export function classroomProblem(error: unknown): Response {
  if (error instanceof ClassroomApiError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/iu.test(message)) {
    return Response.json({ error: { code: "COURSE_NAME_EXISTS", message: "目前學期已經有同名課程。" } }, { status: 409 });
  }
  console.error(JSON.stringify({ event: "classroom.api.failure", message }));
  return Response.json({ error: { code: "CLASSROOM_SERVICE_ERROR", message: "課程資料目前無法處理，請稍後再試。" } }, { status: 500 });
}

export async function withClassroomApi(handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return classroomProblem(error);
  }
}
