import { listClassroomAccessRequests } from "@/db/classroom";
import { classroomApiContext, classroomData, withClassroomApi } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return withClassroomApi(async () => {
    const context = await classroomApiContext(request, true);
    const access = await listClassroomAccessRequests(context.db, context.actor);
    return classroomData({ actor: context.actor, ...access });
  });
}
