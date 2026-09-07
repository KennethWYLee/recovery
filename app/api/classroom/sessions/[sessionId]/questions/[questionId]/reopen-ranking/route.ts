import { reopenClassroomRanking } from "@/db/classroom-reopen-ranking";
import { ClassroomApiError, classroomApiContext, classroomData, classroomJsonBody, classroomQuestionId, classroomSessionId, expectedVersion, withClassroomApi } from "../../../../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sessionId: string; questionId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(request, async () => {
    const api = await classroomApiContext(request, true);
    const params = await context.params;
    const sessionId = classroomSessionId(params.sessionId);
    const questionId = classroomQuestionId(params.questionId);
    if (!sessionId || !questionId) throw new ClassroomApiError(404, "QUESTION_NOT_FOUND", "找不到這個問題。");
    const body = await classroomJsonBody(request);
    const version = expectedVersion(body.expectedQuestionVersion);
    if (!version) throw new ClassroomApiError(400, "QUESTION_VERSION_REQUIRED", "缺少目前問題版本。");
    return classroomData({ snapshot: await reopenClassroomRanking(api.db, api.actor, sessionId, questionId, version) });
  });
}
