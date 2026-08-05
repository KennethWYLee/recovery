import { createClassroomQuestion } from "@/db/classroom-live";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomData,
  classroomJsonBody,
  classroomSessionId,
  withClassroomApi,
} from "../../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sessionId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request, true);
    const sessionId = classroomSessionId((await context.params).sessionId);
    if (!sessionId) throw new ClassroomApiError(404, "SESSION_NOT_FOUND", "找不到這次課堂。");
    const body = await classroomJsonBody(request);
    const snapshot = await createClassroomQuestion(api.db, api.actor, sessionId, {
      questionText: body.questionText,
      rankingCriteria: body.rankingCriteria,
    });
    return classroomData({ snapshot }, { status: 201 });
  });
}
