import { joinClassroomSession } from "@/db/classroom-live";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomData,
  withClassroomApi,
} from "../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ joinCode: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request);
    const joinCode = (await context.params).joinCode;
    if (!joinCode) throw new ClassroomApiError(404, "JOIN_CODE_NOT_FOUND", "課堂代碼不存在或已失效。");
    const snapshot = await joinClassroomSession(api.db, api.actor, joinCode);
    return classroomData({ snapshot });
  });
}
