import {
  deleteClassroomCourse,
  getClassroomCourse,
  renameClassroomCourse,
} from "@/db/classroom";
import { validCourseName } from "@/lib/classroom-domain";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomCourseId,
  classroomData,
  classroomJsonBody,
  expectedVersion,
  withClassroomApi,
} from "../../_shared";

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
    const course = await getClassroomCourse(api.db, api.actor, await parsedCourseId(context));
    if (!course) throw new ClassroomApiError(404, "COURSE_NOT_FOUND", "找不到這門課程，或您沒有存取權限。");
    return classroomData({ actor: api.actor, course });
  });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request, true);
    const courseId = await parsedCourseId(context);
    const body = await classroomJsonBody(request);
    if (!validCourseName(body.name)) {
      throw new ClassroomApiError(400, "INVALID_COURSE_NAME", "課程名稱須為2至80個字元。");
    }
    const version = expectedVersion(body.expectedVersion);
    if (!version) throw new ClassroomApiError(400, "EXPECTED_VERSION_REQUIRED", "缺少目前的課程版本。");
    const course = await renameClassroomCourse(api.db, api.actor, courseId, body.name, version);
    if (!course) throw new ClassroomApiError(409, "COURSE_VERSION_CONFLICT", "課程已在其他畫面更新，請重新載入後再試。");
    return classroomData({ course });
  });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request, true);
    const courseId = await parsedCourseId(context);
    const body = await classroomJsonBody(request);
    const version = expectedVersion(body.expectedVersion);
    if (!version) throw new ClassroomApiError(400, "EXPECTED_VERSION_REQUIRED", "缺少目前的課程版本。");
    const deleted = await deleteClassroomCourse(api.db, api.actor, courseId, version);
    if (!deleted) throw new ClassroomApiError(409, "COURSE_VERSION_CONFLICT", "課程已被更新或刪除，請重新載入後再試。");
    return classroomData({ deleted: true, courseId });
  });
}
