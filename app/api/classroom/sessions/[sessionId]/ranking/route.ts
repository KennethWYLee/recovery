import { submitClassroomRanking } from "@/db/classroom-live";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomData,
  classroomDemoActorForSession,
  classroomJsonBody,
  classroomQuestionId,
  classroomSessionId,
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
    const effective = await classroomDemoActorForSession(api, sessionId, body.testStudentId);
    const questionId = classroomQuestionId(body.questionId);
    if (!questionId) throw new ClassroomApiError(400, "QUESTION_REQUIRED", "請選擇要排序的問題。");
    const snapshot = await submitClassroomRanking(api.db, effective.actor, sessionId, questionId, body.orderedGroupIds);
    return classroomData({ snapshot });
  });
}
