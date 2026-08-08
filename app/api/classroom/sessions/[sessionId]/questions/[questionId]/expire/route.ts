import { expireClassroomQuestionIfDue } from "@/db/classroom-live";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomData,
  classroomDemoActorForSession,
  classroomJsonBody,
  classroomQuestionId,
  classroomSessionId,
  withClassroomApi,
} from "../../../../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sessionId: string; questionId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(request, async () => {
    const api = await classroomApiContext(request);
    const params = await context.params;
    const sessionId = classroomSessionId(params.sessionId);
    const questionId = classroomQuestionId(params.questionId);
    if (!sessionId || !questionId) throw new ClassroomApiError(404, "QUESTION_NOT_FOUND", "找不到這個問題。");
    const body = await classroomJsonBody(request);
    const effective = await classroomDemoActorForSession(api, sessionId, body.testStudentId);
    const snapshot = await expireClassroomQuestionIfDue(api.db, effective.actor, sessionId, questionId);
    return classroomData({ snapshot });
  });
}
