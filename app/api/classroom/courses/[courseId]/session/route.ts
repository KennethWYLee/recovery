import { getClassroomCourse } from "@/db/classroom";
import { activeClassroomSession, createClassroomSession } from "@/db/classroom-live";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomCourseId,
  classroomData,
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
    const snapshot = await activeClassroomSession(api.db, api.actor, courseId);
    return classroomData({ actor: api.actor, course, snapshot });
  });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request, true);
    const courseId = await parsedCourseId(context);
    const body = await classroomJsonBody(request);
    const groupCapacity = Number(body.groupCapacity);
    const session = await createClassroomSession(api.db, api.actor, courseId, {
      title: body.title,
      question: body.question,
      rankingCriteria: body.rankingCriteria,
      groupCapacity,
      anonymousGroups: body.anonymousGroups !== false,
      allowRankingEdits: body.allowRankingEdits !== false,
    });
    return classroomData({ session }, { status: 201 });
  });
}
