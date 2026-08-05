import {
  advanceClassroomSession,
  classroomSessionSnapshot,
  moveClassroomParticipant,
  rollbackClassroomSession,
  setClassroomRepresentative,
} from "@/db/classroom-live";
import {
  ClassroomApiError,
  classroomApiContext,
  classroomData,
  classroomGroupId,
  classroomJsonBody,
  classroomParticipantId,
  classroomSessionId,
  expectedVersion,
  withClassroomApi,
} from "../../_shared";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ sessionId: string }> };

async function parsedSessionId(context: Context): Promise<string> {
  const id = classroomSessionId((await context.params).sessionId);
  if (!id) throw new ClassroomApiError(404, "SESSION_NOT_FOUND", "找不到這次課堂。");
  return id;
}

export async function GET(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request);
    const snapshot = await classroomSessionSnapshot(api.db, api.actor, await parsedSessionId(context));
    return classroomData({ actor: api.actor, snapshot });
  });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return withClassroomApi(async () => {
    const api = await classroomApiContext(request, true);
    const sessionId = await parsedSessionId(context);
    const body = await classroomJsonBody(request);
    let snapshot;
    if (body.action === "advance" || body.action === "rollback") {
      const version = expectedVersion(body.expectedVersion);
      if (!version) throw new ClassroomApiError(400, "EXPECTED_VERSION_REQUIRED", "缺少目前的課堂版本。");
      snapshot = body.action === "advance"
        ? await advanceClassroomSession(api.db, api.actor, sessionId, version)
        : await rollbackClassroomSession(api.db, api.actor, sessionId, version);
    } else if (body.action === "move_participant") {
      const participantId = classroomParticipantId(body.participantId);
      const groupId = classroomGroupId(body.groupId);
      if (!participantId || !groupId) throw new ClassroomApiError(400, "INVALID_GROUP_MOVE", "請選擇學生與目標組別。");
      snapshot = await moveClassroomParticipant(api.db, api.actor, sessionId, participantId, groupId);
    } else if (body.action === "set_representative") {
      const groupId = classroomGroupId(body.groupId);
      const userId = typeof body.userId === "string" ? body.userId : "";
      if (!groupId || !userId) throw new ClassroomApiError(400, "INVALID_REPRESENTATIVE", "請選擇一位組內成員。");
      snapshot = await setClassroomRepresentative(api.db, api.actor, sessionId, groupId, userId);
    } else {
      throw new ClassroomApiError(400, "UNKNOWN_SESSION_ACTION", "不支援這項課堂操作。");
    }
    return classroomData({ snapshot });
  });
}
