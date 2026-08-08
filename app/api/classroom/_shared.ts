import {
  ClassroomAccessError,
  classroomDb,
  classroomEnvironment,
  enforceClassroomMutationRateLimit,
  loadOrProvisionClassroomActor,
  type ClassroomActor,
} from "@/db/classroom";
import { ClassroomWorkflowError } from "@/db/classroom-live";
import { recordClassroomOperationLog } from "@/db/classroom-observability";
import {
  demoStudentActorForCourse,
  demoStudentActorForSession,
} from "@/db/classroom-test-mode";
import { validDemoStudentId } from "@/lib/classroom-domain";
import { requestIsSameOrigin } from "@/lib/classroom-auth";
import { normalizeClassroomRoute } from "@/lib/classroom-observability";
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
  request: Request;
};

export type ClassroomEffectiveActor = {
  actor: ClassroomActor;
  viewer: ClassroomActor;
  testMode: boolean;
};

type ClassroomRequestMetadata = {
  actor: ClassroomActor;
  testMode: boolean;
};

const classroomRequestMetadata = new WeakMap<Request, ClassroomRequestMetadata>();

export async function classroomApiContext(request: Request, adminOnly = false): Promise<ClassroomApiContext> {
  if (!requestIsSameOrigin(request)) {
    throw new ClassroomApiError(403, "CROSS_ORIGIN_REQUEST_REJECTED", "這項操作必須從本系統送出。");
  }
  let actor: ClassroomActor | null;
  try {
    actor = await loadOrProvisionClassroomActor(request);
  } catch (error) {
    if (!(error instanceof ClassroomAccessError)) throw error;
    if (error.reason === "rate_limited") {
      throw new ClassroomApiError(429, "ACCESS_REQUEST_RATE_LIMITED", error.message);
    }
    if (error.reason === "approval_pending") {
      throw new ClassroomApiError(403, "ACCESS_APPROVAL_PENDING", error.message);
    }
    if (error.reason === "approval_rejected") {
      throw new ClassroomApiError(403, "ACCESS_APPROVAL_REJECTED", error.message);
    }
    throw new ClassroomApiError(403, "EMAIL_DOMAIN_NOT_ALLOWED", error.message);
  }
  if (!actor) throw new ClassroomApiError(401, "AUTHENTICATION_REQUIRED", "請使用經驗證的校內帳號登入。");
  classroomRequestMetadata.set(request, { actor, testMode: false });
  if (adminOnly && !actor.isAdmin) {
    throw new ClassroomApiError(403, "SYSTEM_ADMIN_PERMISSION_REQUIRED", "只有系統管理員可以執行這項操作。");
  }
  const db = classroomDb();
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
    const route = normalizeClassroomRoute(request.url);
    const allowed = await enforceClassroomMutationRateLimit(db, actor, route, route === "/api/classroom/join/:joinCode" ? 12 : 120);
    if (!allowed) throw new ClassroomApiError(429, "RATE_LIMITED", "操作次數過於頻繁，請稍候再試。");
  }
  return { actor, db, request };
}

async function classroomDemoActor(
  context: ClassroomApiContext,
  value: unknown,
  resolve: (db: D1Database, viewer: ClassroomActor, scopeId: string, target: unknown) => Promise<ClassroomActor | null>,
  scopeId: string,
): Promise<ClassroomEffectiveActor> {
  if (value === undefined || value === null || value === "") {
    return { actor: context.actor, viewer: context.actor, testMode: false };
  }
  if (!context.actor.isAdmin) {
    throw new ClassroomApiError(403, "TEST_MODE_ADMIN_REQUIRED", "只有系統管理員可以使用學生測試模式。");
  }
  if (!validDemoStudentId(value)) {
    throw new ClassroomApiError(400, "INVALID_TEST_STUDENT", "指定的虛擬學生不正確。");
  }
  const actor = await resolve(context.db, context.actor, scopeId, value);
  if (!actor) {
    throw new ClassroomApiError(404, "TEST_STUDENT_NOT_FOUND", "這名虛擬學生不屬於目前的示範課程。");
  }
  classroomRequestMetadata.set(context.request, { actor: context.actor, testMode: true });
  return { actor, viewer: context.actor, testMode: true };
}

export function classroomDemoActorForCourse(
  context: ClassroomApiContext,
  courseId: string,
  value: unknown,
): Promise<ClassroomEffectiveActor> {
  return classroomDemoActor(context, value, demoStudentActorForCourse, courseId);
}

export function classroomDemoActorForSession(
  context: ClassroomApiContext,
  sessionId: string,
  value: unknown,
): Promise<ClassroomEffectiveActor> {
  return classroomDemoActor(context, value, demoStudentActorForSession, sessionId);
}

export async function classroomJsonBody(request: Request, maximumBytes = 8_192): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    await drainClassroomRequestBody(request);
    throw new ClassroomApiError(415, "JSON_REQUIRED", "請使用JSON格式送出資料。");
  }
  try {
    return await readBoundedClassroomJsonObject(request, maximumBytes);
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

export function classroomQuestionId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return /^question-[a-z0-9-]{6,100}$/u.test(id) ? id : "";
}

export function classroomQuestionBankId(value: unknown): string {
  if (typeof value !== "string") return "";
  const id = value.trim();
  return /^question-bank-[a-z0-9-]{8,100}$/u.test(id) ? id : "";
}

export function expectedVersion(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : 0;
}

export function classroomData<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ data }, init);
}

function classroomErrorCode(error: unknown): string {
  if (error instanceof ClassroomWorkflowError || error instanceof ClassroomApiError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("CLASSROOM_SCHEMA_MISMATCH:")) return "CLASSROOM_SCHEMA_MISMATCH";
  if (/UNIQUE constraint failed/iu.test(message)) return "COURSE_NAME_EXISTS";
  return "CLASSROOM_SERVICE_ERROR";
}

export function classroomProblem(error: unknown, requestId = `req-${crypto.randomUUID()}`): Response {
  if (error instanceof ClassroomWorkflowError) {
    return Response.json({ error: { code: error.code, message: error.message, requestId } }, { status: error.status });
  }
  if (error instanceof ClassroomApiError) {
    const headers = error.status === 429 ? { "retry-after": "60" } : undefined;
    return Response.json({ error: { code: error.code, message: error.message, requestId } }, { status: error.status, headers });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("CLASSROOM_SCHEMA_MISMATCH:")) {
    console.error(JSON.stringify({ event: "classroom.schema.mismatch", requestId }));
    return Response.json({
      error: {
        code: "CLASSROOM_SCHEMA_MISMATCH",
        message: "系統版本與資料庫結構不一致，請由管理員完成資料庫更新後再試。",
        requestId,
      },
    }, { status: 503 });
  }
  if (/UNIQUE constraint failed/iu.test(message)) {
    return Response.json({ error: { code: "COURSE_NAME_EXISTS", message: "目前學期已經有同名課程。", requestId } }, { status: 409 });
  }
  console.error(JSON.stringify({ event: "classroom.api.failure", requestId, errorName: error instanceof Error ? error.name : "UnknownError" }));
  return Response.json({ error: { code: "CLASSROOM_SERVICE_ERROR", message: "課程資料目前無法處理，請稍後再試。", requestId } }, { status: 500 });
}

export async function withClassroomApi(request: Request, handler: () => Promise<Response>): Promise<Response>;
export async function withClassroomApi(handler: () => Promise<Response>): Promise<Response>;
export async function withClassroomApi(
  requestOrHandler: Request | (() => Promise<Response>),
  maybeHandler?: () => Promise<Response>,
): Promise<Response> {
  const request = typeof requestOrHandler === "function" ? null : requestOrHandler;
  const handler: (() => Promise<Response>) | undefined = typeof requestOrHandler === "function"
    ? requestOrHandler
    : maybeHandler;
  if (!handler) throw new Error("A classroom API handler is required.");
  const requestId = `req-${crypto.randomUUID()}`;
  const startedAt = performance.now();
  let response: Response;
  let errorCode: string | null = null;
  try {
    response = await handler();
  } catch (error) {
    errorCode = classroomErrorCode(error);
    response = classroomProblem(error, requestId);
  }
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  const tracedResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  if (request) {
    try {
      const runtime = classroomEnvironment();
      const metadata = classroomRequestMetadata.get(request);
      await recordClassroomOperationLog(classroomDb(), {
        requestId,
        actor: metadata?.actor ?? null,
        method: request.method,
        url: request.url,
        statusCode: response.status,
        errorCode,
        durationMs: performance.now() - startedAt,
        testMode: metadata?.testMode ?? false,
        environment: runtime.CLASSROOM_ENVIRONMENT,
        release: runtime.CLASSROOM_RELEASE,
      });
    } catch (loggingError) {
      console.error(JSON.stringify({
        event: "classroom.operation_log.failure",
        requestId,
        errorName: loggingError instanceof Error ? loggingError.name : "UnknownError",
      }));
    }
  }
  return tracedResponse;
}
