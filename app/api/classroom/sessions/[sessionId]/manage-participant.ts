import type { ClassroomActor } from "@/db/classroom";
import { addClassroomGroupForParticipant } from "@/db/classroom-add-group";
import { moveClassroomParticipant } from "@/db/classroom-live";
import { ClassroomApiError, classroomGroupId, classroomParticipantId } from "../../_shared";

export async function manageParticipant(
  db: D1Database, actor: ClassroomActor, sessionId: string, body: Record<string, unknown>,
) {
  const participantId = classroomParticipantId(body.participantId);
  if (!participantId) throw new ClassroomApiError(400, "INVALID_GROUP_MOVE", "請選擇學生。");
  if (body.groupId === "new") {
    const expectedGroupId = classroomGroupId(body.expectedGroupId);
    if (body.expectedGroupId !== "" && !expectedGroupId) {
      throw new ClassroomApiError(400, "INVALID_GROUP_MOVE", "缺少學生目前的組別，請重新載入。");
    }
    return addClassroomGroupForParticipant(db, actor, sessionId, participantId, expectedGroupId || null);
  }
  const groupId = classroomGroupId(body.groupId);
  if (!groupId) throw new ClassroomApiError(400, "INVALID_GROUP_MOVE", "請選擇目標組別。");
  return moveClassroomParticipant(db, actor, sessionId, participantId, groupId);
}
