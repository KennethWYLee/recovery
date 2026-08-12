import { classroomParticipationReport } from "@/db/classroom-participation";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomData,
  classroomSessionId,
  withClassroomApi,
} from "../../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(request, async () => {
    const api = await classroomApiContext(request, true);
    const sessionId = classroomSessionId((await context.params).sessionId);
    if (!sessionId) throw new ClassroomApiError(404, "SESSION_NOT_FOUND", "找不到這次課堂。");
    return classroomData({ report: await classroomParticipationReport(api.db, api.actor, sessionId) });
  });
}
