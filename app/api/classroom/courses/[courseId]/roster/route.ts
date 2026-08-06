import {
  listClassroomCourseRoster,
  previewClassroomCourseRoster,
  replaceClassroomCourseRoster,
} from "@/db/classroom-roster";
import { getClassroomCourse } from "@/db/classroom";
import { normalizeRosterDrafts } from "@/lib/classroom-roster";
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

async function managedCourse(request: Request, context: Context) {
  const api = await classroomApiContext(request, true);
  const courseId = classroomCourseId((await context.params).courseId);
  if (!courseId || !(await getClassroomCourse(api.db, api.actor, courseId))) {
    throw new ClassroomApiError(404, "COURSE_NOT_FOUND", "找不到這門課程。");
  }
  return { ...api, courseId };
}

function sourceFileName(value: unknown): string {
  if (typeof value !== "string") return "";
  const name = value.normalize("NFKC").split(/[\\/]/u).pop()?.trim() ?? "";
  return name.length >= 1 && name.length <= 120 && /\.(?:xlsx|txt)$/iu.test(name) ? name : "";
}

export async function GET(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await managedCourse(request, context);
    return classroomData({ roster: await listClassroomCourseRoster(api.db, api.actor, api.courseId) });
  });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await managedCourse(request, context);
    const body = await classroomJsonBody(request, 200_000);
    const entries = normalizeRosterDrafts(body.entries);
    const fileName = sourceFileName(body.sourceFileName);
    if (!entries) throw new ClassroomApiError(400, "INVALID_ROSTER", "名單必須包含 1 至 500 筆不重複的有效學號或 NTUB 信箱。");
    if (!fileName) throw new ClassroomApiError(400, "INVALID_ROSTER_FILE", "名單檔名必須是 .xlsx 或 .txt。");
    if (body.action === "preview") {
      return classroomData({ preview: await previewClassroomCourseRoster(api.db, api.actor, api.courseId, entries) });
    }
    if (body.action === "replace") {
      return classroomData(await replaceClassroomCourseRoster(api.db, api.actor, api.courseId, entries, fileName));
    }
    throw new ClassroomApiError(400, "INVALID_ROSTER_ACTION", "請先預覽名單，再確認套用。");
  });
}
