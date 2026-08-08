import { archiveClassroomQuestionBankItem, updateClassroomQuestionBankItem } from "@/db/classroom-question-bank";
import { getClassroomCourse } from "@/db/classroom";
import { normalizeQuestionBankDraft } from "@/lib/classroom-question-bank";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomCourseId,
  classroomData,
  classroomJsonBody,
  classroomQuestionBankId,
  expectedVersion,
  withClassroomApi,
} from "../../../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ courseId: string; questionBankId: string }> };

async function managedItem(request: Request, context: Context) {
  const api = await classroomApiContext(request, true);
  const params = await context.params;
  const courseId = classroomCourseId(params.courseId);
  const itemId = classroomQuestionBankId(params.questionBankId);
  if (!courseId || !itemId || !(await getClassroomCourse(api.db, api.actor, courseId))) {
    throw new ClassroomApiError(404, "QUESTION_BANK_ITEM_NOT_FOUND", "找不到這個問題庫項目。");
  }
  return { ...api, courseId, itemId };
}

function itemError(result: "not_found" | "conflict") {
  if (result === "not_found") {
    throw new ClassroomApiError(404, "QUESTION_BANK_ITEM_NOT_FOUND", "找不到這個問題庫項目。");
  }
  throw new ClassroomApiError(409, "QUESTION_BANK_VERSION_CONFLICT", "問題內容已更新，請重新載入後再操作。");
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(request, async () => {
    const api = await managedItem(request, context);
    const body = await classroomJsonBody(request);
    const version = expectedVersion(body.expectedVersion);
    const draft = normalizeQuestionBankDraft({
      title: body.title,
      category: body.category,
      questionText: body.questionText,
      rankingCriteria: body.rankingCriteria,
      status: body.status,
    });
    if (!version || !draft) {
      throw new ClassroomApiError(400, "INVALID_QUESTION_BANK_ITEM", "請重新確認問題內容與版本。");
    }
    const result = await updateClassroomQuestionBankItem(api.db, api.actor, api.courseId, api.itemId, version, draft);
    if (typeof result === "string") itemError(result);
    return classroomData({ item: result });
  });
}

export async function DELETE(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(request, async () => {
    const api = await managedItem(request, context);
    const body = await classroomJsonBody(request);
    const version = expectedVersion(body.expectedVersion);
    if (!version) throw new ClassroomApiError(400, "INVALID_VERSION", "請重新載入後再移除問題。");
    const result = await archiveClassroomQuestionBankItem(api.db, api.actor, api.courseId, api.itemId, version);
    if (result !== "archived") itemError(result);
    return classroomData({ archivedId: api.itemId });
  });
}
