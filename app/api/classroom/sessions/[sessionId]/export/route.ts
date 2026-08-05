import { classroomSessionCsv } from "@/db/classroom-live";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomSessionId,
  withClassroomApi,
} from "../../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sessionId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request, true);
    const sessionId = classroomSessionId((await context.params).sessionId);
    if (!sessionId) throw new ClassroomApiError(404, "SESSION_NOT_FOUND", "找不到這次課堂。");
    const csv = await classroomSessionCsv(api.db, api.actor, sessionId);
    return new Response(csv, {
      headers: {
        "cache-control": "no-store, private",
        "content-disposition": `attachment; filename="classroom-${sessionId}.csv"`,
        "content-type": "text/csv; charset=utf-8",
      },
    });
  });
}
