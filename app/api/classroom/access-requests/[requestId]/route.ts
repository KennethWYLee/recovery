import { reviewClassroomAccessRequest } from "@/db/classroom";
import {
  ClassroomApiError,
  classroomAccessRequestId,
  classroomApiContext,
  classroomData,
  classroomJsonBody,
  expectedVersion,
  withClassroomApi,
} from "../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ requestId: string }> };

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request, true);
    const requestId = classroomAccessRequestId((await context.params).requestId);
    if (!requestId) throw new ClassroomApiError(404, "ACCESS_REQUEST_NOT_FOUND", "找不到這筆登入申請。");
    const body = await classroomJsonBody(request);
    if (body.action !== "approve" && body.action !== "reject") {
      throw new ClassroomApiError(400, "INVALID_REVIEW_ACTION", "請選擇允許或拒絕這筆申請。");
    }
    const version = expectedVersion(body.expectedVersion);
    if (!version) throw new ClassroomApiError(400, "EXPECTED_VERSION_REQUIRED", "缺少目前的申請版本。");
    const reviewed = await reviewClassroomAccessRequest(api.db, api.actor, requestId, body.action, version);
    if (!reviewed) {
      throw new ClassroomApiError(409, "ACCESS_REQUEST_VERSION_CONFLICT", "這筆申請已由其他管理員處理，請重新載入。");
    }
    return classroomData({ request: reviewed });
  });
}
