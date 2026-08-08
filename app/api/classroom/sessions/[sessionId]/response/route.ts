import { classroomGroupResponseForActor, classroomSessionSnapshot, saveClassroomGroupResponse } from "@/db/classroom-live";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomData,
  classroomDemoActorForSession,
  classroomJsonBody,
  classroomQuestionId,
  classroomSessionId,
  expectedVersion,
  withClassroomApi,
} from "../../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(request, async () => {
    const api = await classroomApiContext(request);
    const sessionId = classroomSessionId((await context.params).sessionId);
    if (!sessionId) throw new ClassroomApiError(404, "SESSION_NOT_FOUND", "找不到這次課堂。");
    const url = new URL(request.url);
    const effective = await classroomDemoActorForSession(api, sessionId, url.searchParams.get("testStudentId"));
    const questionId = classroomQuestionId(url.searchParams.get("questionId"));
    if (!questionId) throw new ClassroomApiError(400, "QUESTION_REQUIRED", "請選擇要回答的問題。");
    return classroomData({ live: await classroomGroupResponseForActor(api.db, effective.actor, sessionId, questionId) });
  });
}

export async function PUT(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(request, async () => {
    const api = await classroomApiContext(request);
    const sessionId = classroomSessionId((await context.params).sessionId);
    if (!sessionId) throw new ClassroomApiError(404, "SESSION_NOT_FOUND", "找不到這次課堂。");
    const body = await classroomJsonBody(request);
    const effective = await classroomDemoActorForSession(api, sessionId, body.testStudentId);
    const questionId = classroomQuestionId(body.questionId);
    if (!questionId) throw new ClassroomApiError(400, "QUESTION_REQUIRED", "請選擇要回答的問題。");
    const version = expectedVersion(body.expectedVersion);
    if (!version) throw new ClassroomApiError(400, "EXPECTED_VERSION_REQUIRED", "缺少目前的回答版本。");
    const submit = body.submit === true;
    const live = await saveClassroomGroupResponse(
      api.db,
      effective.actor,
      sessionId,
      questionId,
      body.content,
      version,
      submit,
    );
    const snapshot = submit
      ? await classroomSessionSnapshot(api.db, effective.actor, sessionId, questionId)
      : undefined;
    return classroomData({ live, snapshot });
  });
}
