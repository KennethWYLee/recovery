import { resetDemoClassroom } from "@/db/classroom-test-mode";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomCourseId,
  classroomData,
  withClassroomApi,
} from "../../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ courseId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request, true);
    const courseId = classroomCourseId((await context.params).courseId);
    if (!courseId) throw new ClassroomApiError(404, "COURSE_NOT_FOUND", "找不到這門課程。");
    await resetDemoClassroom(api.db, api.actor, courseId);
    return classroomData({ reset: true });
  });
}
