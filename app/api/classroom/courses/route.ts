import {
  createClassroomCourse,
  listClassroomCourses,
} from "@/db/classroom";
import {
  validAcademicTerm,
  validAcademicYear,
  validCourseName,
  validGroupCapacity,
} from "@/lib/classroom-domain";
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
    if (!validAcademicYear(body.academicYear) || !validAcademicTerm(body.term)) {
      throw new ClassroomApiError(400, "INVALID_ACADEMIC_TERM", "請選擇正確的學年與學期。");
    }
    if (!validGroupCapacity(body.defaultGroupCapacity)) {
      throw new ClassroomApiError(400, "INVALID_GROUP_CAPACITY", "每組人數上限必須介於 2 至 20 人。");
    }
    const course = await createClassroomCourse(context.db, context.actor, {
      name: body.name,
      academicYear: body.academicYear,
      term: body.term,
      defaultGroupCapacity: body.defaultGroupCapacity,
    });
    return classroomData({ course }, { status: 201 });
  });
}
