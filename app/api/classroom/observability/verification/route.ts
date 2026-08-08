import { classroomEnvironment } from "@/db/classroom";
import { normalizeClassroomRelease } from "@/lib/classroom-observability";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomData,
  withClassroomApi,
} from "../../_shared";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return withClassroomApi(request, async () => {
    await classroomApiContext(request, true);
    const release = normalizeClassroomRelease(classroomEnvironment().CLASSROOM_RELEASE);
    if (release.endsWith("-unverified")) {
      throw new ClassroomApiError(
        503,
        "RELEASE_ID_NOT_CONFIGURED",
        "目前部署未設定可核對的版次 ID，不能產生結案用的驗證 Request ID。",
      );
    }
    return classroomData({
      release,
    });
  });
}
