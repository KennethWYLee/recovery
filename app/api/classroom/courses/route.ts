import {
  createClassroomCourse,
  listClassroomCourses,
} from "@/db/classroom";
import { validCourseName } from "@/lib/classroom-domain";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomData,
  classroomJsonBody,
  withClassroomApi,
} from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withClassroomApi(async () => {
    const context = await classroomApiContext(request);
    const courses = await listClassroomCourses(context.db, context.actor);
    return classroomData({ actor: context.actor, courses });
  });
}

export async function POST(request: Request): Promise<Response> {
  return withClassroomApi(async () => {
    const context = await classroomApiContext(request, true);
    const body = await classroomJsonBody(request);
    if (!validCourseName(body.name)) {
      throw new ClassroomApiError(400, "INVALID_COURSE_NAME", "課程名稱須為2至80個字元。");
    }
    const course = await createClassroomCourse(context.db, context.actor, body.name);
    return classroomData({ course }, { status: 201 });
  });
}
