import { createClassroomQuestionBankItem, listClassroomQuestionBank } from "@/db/classroom-question-bank";
import { getClassroomCourse } from "@/db/classroom";
import { normalizeQuestionBankDraft } from "@/lib/classroom-question-bank";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomCourseId,
  classroomData,
  classroomJsonBody,
  classroomSessionId,
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

export async function GET(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await managedCourse(request, context);
    const search = new URL(request.url).searchParams;
    const rawSessionId = search.get("sessionId");
    const sessionId = rawSessionId ? classroomSessionId(rawSessionId) : "";
    if (rawSessionId && !sessionId) throw new ClassroomApiError(400, "INVALID_SESSION", "課堂識別資料不正確。");
    return classroomData({ items: await listClassroomQuestionBank(api.db, api.actor, api.courseId, {
      readyOnly: search.get("readyOnly") === "true",
      sessionId,
    }) });
  });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await managedCourse(request, context);
    const body = await classroomJsonBody(request);
    const draft = normalizeQuestionBankDraft({
      title: body.title,
      category: body.category,
      questionText: body.questionText,
      rankingCriteria: body.rankingCriteria,
      status: body.status,
    });
    if (!draft) {
      throw new ClassroomApiError(400, "INVALID_QUESTION_BANK_ITEM", "請完整填寫問題名稱、問題內容與排序判準。");
    }
    const item = await createClassroomQuestionBankItem(api.db, api.actor, api.courseId, draft);
    return classroomData({ item }, { status: 201 });
  });
}
