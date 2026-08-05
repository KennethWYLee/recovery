import {
  ClassroomAccessError,
  classroomDb,
  enforceClassroomMutationRateLimit,
  loadOrProvisionClassroomActor,
  type ClassroomActor,
} from "@/db/classroom";
import { ClassroomWorkflowError } from "@/db/classroom-live";
import { requestIsSameOrigin } from "@/lib/classroom-auth";
import {
  ClassroomRequestBodyError,
  drainClassroomRequestBody,
  readBoundedClassroomJsonObject,
} from "@/lib/classroom-input";

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

export async function classroomApiContext(request: Request, adminOnly = false): Promise<ClassroomApiContext> {
  if (!requestIsSameOrigin(request)) {
    throw new ClassroomApiError(403, "CROSS_ORIGIN_REQUEST_REJECTED", "這項操作必須從本系統送出。");
  }
  let actor: ClassroomActor | null;
  try {
    actor = await loadOrProvisionClassroomActor(request);
  } catch (error) {
    if (!(error instanceof ClassroomAccessError)) throw error;
    if (error.reason === "approval_pending") {
      throw new ClassroomApiError(403, "ACCESS_APPROVAL_PENDING", error.message);
    }
    if (error.reason === "approval_rejected") {
      throw new ClassroomApiError(403, "ACCESS_APPROVAL_REJECTED", error.message);
    }
    throw new ClassroomApiError(403, "EMAIL_DOMAIN_NOT_ALLOWED", error.message);
  }
  if (!actor) throw new ClassroomApiError(401, "AUTHENTICATION_REQUIRED", "請使用經驗證的校內帳號登入。");
  if (adminOnly && !actor.isAdmin) {
    throw new ClassroomApiError(403, "SYSTEM_ADMIN_PERMISSION_REQUIRED", "只有系統管理員可以執行這項操作。");
  }
  const db = classroomDb();
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
    const allowed = await enforceClassroomMutationRateLimit(db, actor, new URL(request.url).pathname);
    if (!allowed) throw new ClassroomApiError(429, "RATE_LIMITED", "操作次數過於頻繁，請稍候再試。");
  }
  return { actor, db };
}

export async function classroomJsonBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    await drainClassroomRequestBody(request);
    throw new ClassroomApiError(415, "JSON_REQUIRED", "請使用JSON格式送出資料。");
  }
  try {
    return await readBoundedClassroomJsonObject(request, 8_192);
  } catch (error) {
    if (!(error instanceof ClassroomRequestBodyError)) throw error;
    if (error.kind === "too_large") throw new ClassroomApiError(413, "REQUEST_TOO_LARGE", "送出的資料超過系統限制。");
    throw new ClassroomApiError(400, "INVALID_JSON", "送出的資料格式不完整。");
  }
}

export function classroomCourseId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return /^course-[a-z0-9-]{8,80}$/u.test(id) ? id : "";
}

export function classroomAccessRequestId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return /^access-request-[a-z0-9-]{8,80}$/u.test(id) ? id : "";
}

export function classroomSessionId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return /^session-[a-z0-9-]{8,80}$/u.test(id) ? id : "";
}

export function classroomParticipantId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return /^participant-[a-z0-9-]{8,80}$/u.test(id) ? id : "";
}

export function classroomGroupId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return /^group-[a-z0-9-]{8,80}$/u.test(id) ? id : "";
}

export function expectedVersion(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : 0;
}

export function classroomData<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data }, init);
}

export function classroomProblem(error: unknown): Response {
  if (error instanceof ClassroomWorkflowError) {
    return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
  }
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
