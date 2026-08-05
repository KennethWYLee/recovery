import { getClassroomCourse } from "@/db/classroom";
import { activeClassroomSession, createClassroomSession } from "@/db/classroom-live";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomCourseId,
  classroomData,
  classroomDemoActorForCourse,
  classroomJsonBody,
  withClassroomApi,
} from "../../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ courseId: string }> };

async function parsedCourseId(context: Context): Promise<string> {
  const id = classroomCourseId((await context.params).courseId);
  if (!id) throw new ClassroomApiError(404, "COURSE_NOT_FOUND", "找不到這門課程。");
  return id;
}

export async function GET(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request);
    const courseId = await parsedCourseId(context);
    const course = await getClassroomCourse(api.db, api.actor, courseId);
    if (!course) throw new ClassroomApiError(404, "COURSE_NOT_FOUND", "找不到這門課程，或您沒有存取權限。");
    const search = new URL(request.url).searchParams;
    const effective = await classroomDemoActorForCourse(api, courseId, search.get("testStudentId"));
    const snapshot = await activeClassroomSession(api.db, effective.actor, courseId, search.get("questionId"));
    return classroomData({ ...effective, course, snapshot });
  });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request, true);
    const courseId = await parsedCourseId(context);
    const body = await classroomJsonBody(request);
    const groupCount = Number(body.groupCount);
    const session = await createClassroomSession(api.db, api.actor, courseId, {
      title: body.title,
      groupCount,
      anonymousGroups: body.anonymousGroups !== false,
      allowRankingEdits: body.allowRankingEdits !== false,
      qrEnabled: body.qrEnabled === true,
    });
    return classroomData({ session }, { status: 201 });
  });
}
