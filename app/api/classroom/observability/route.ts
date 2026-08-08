import {
  classroomObservabilitySnapshot,
  createClassroomIncident,
  updateClassroomIncident,
} from "@/db/classroom-observability";
import { classroomEnvironment } from "@/db/classroom";
import { normalizeClassroomLogWindow } from "@/lib/classroom-observability";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomData,
  classroomJsonBody,
  expectedVersion,
  withClassroomApi,
} from "../_shared";

export const dynamic = "force-dynamic";

function incidentProblem(result: "invalid" | "not_found" | "conflict" | "request_not_found"): never {
  if (result === "not_found") throw new ClassroomApiError(404, "INCIDENT_NOT_FOUND", "找不到這筆問題追查紀錄。");
  if (result === "conflict") throw new ClassroomApiError(409, "INCIDENT_VERSION_CONFLICT", "這筆紀錄已由其他管理員更新，請重新載入。");
  if (result === "request_not_found") throw new ClassroomApiError(400, "REQUEST_EVIDENCE_NOT_FOUND", "找不到指定的正式 Request ID，或驗證不是較晚發生的成功請求、部署版次也可能與修正版次不符。");
  throw new ClassroomApiError(400, "INVALID_INCIDENT", "請完整填寫問題與處理狀態；結案時須提供不同的問題與驗證 Request ID、修正與回歸驗證資料，且部署版次不可是未確認的 -unverified 版次。");
}

export async function GET(request: Request): Promise<Response> {
  return withClassroomApi(request, async () => {
    const api = await classroomApiContext(request, true);
    const window = normalizeClassroomLogWindow(new URL(request.url).searchParams.get("window"));
    return classroomData({
      snapshot: await classroomObservabilitySnapshot(api.db, api.actor, window, classroomEnvironment().CLASSROOM_RELEASE),
    });
  });
}

export async function POST(request: Request): Promise<Response> {
  return withClassroomApi(request, async () => {
    const api = await classroomApiContext(request, true);
    const body = await classroomJsonBody(request, 16_384);
    const incident = await createClassroomIncident(api.db, api.actor, body);
    if (typeof incident === "string") incidentProblem(incident);
    return classroomData({ incident }, { status: 201 });
  });
}

export async function PATCH(request: Request): Promise<Response> {
  return withClassroomApi(request, async () => {
    const api = await classroomApiContext(request, true);
    const body = await classroomJsonBody(request, 16_384);
    const incidentId = typeof body.id === "string" ? body.id.trim() : "";
    const version = expectedVersion(body.expectedVersion);
    const incident = await updateClassroomIncident(api.db, api.actor, incidentId, version, body);
    if (typeof incident === "string") incidentProblem(incident);
    return classroomData({ incident });
  });
}
