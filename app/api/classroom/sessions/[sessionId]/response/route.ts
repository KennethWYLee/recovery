import { saveClassroomGroupResponse } from "@/db/classroom-live";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomData,
  classroomJsonBody,
  classroomSessionId,
  expectedVersion,
  withClassroomApi,
} from "../../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sessionId: string }> };

export async function PUT(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request);
    const sessionId = classroomSessionId((await context.params).sessionId);
    if (!sessionId) throw new ClassroomApiError(404, "SESSION_NOT_FOUND", "找不到這次課堂。");
    const body = await classroomJsonBody(request);
    const version = expectedVersion(body.expectedVersion);
    if (!version) throw new ClassroomApiError(400, "EXPECTED_VERSION_REQUIRED", "缺少目前的回答版本。");
    const snapshot = await saveClassroomGroupResponse(
      api.db,
      api.actor,
      sessionId,
      body.content,
      version,
      body.submit === true,
    );
    return classroomData({ snapshot });
  });
}
