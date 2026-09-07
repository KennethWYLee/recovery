import type { ClassroomGroup, ClassroomParticipant, ClassroomParticipationReport, ClassroomSession } from "./classroom-domain.ts";

type ManagementSnapshot = {
  session: Pick<ClassroomSession, "id" | "phase">;
  groups: Array<Pick<ClassroomGroup, "id" | "label" | "representativeUserId">>;
  participants: Array<Pick<ClassroomParticipant, "id" | "userId" | "groupId">>;
};

export function applyParticipationManagementSnapshot(report: ClassroomParticipationReport, snapshot: ManagementSnapshot): ClassroomParticipationReport {
  if (report.sessionId !== snapshot.session.id) return report;
  const groups = snapshot.groups.map(({ id, label, representativeUserId }) => ({ id, label, representativeUserId }));
  const participants = new Map(snapshot.participants.map((participant) => [participant.userId, participant]));
  return {
    ...report,
    sessionPhase: snapshot.session.phase,
    groups,
    students: report.students.map((student) => {
      const participant = participants.get(student.userId);
      if (!participant) return student;
      return { ...student, participantId: participant.id, groupId: participant.groupId,
        groupLabel: groups.find((group) => group.id === participant.groupId)?.label ?? null };
    }),
  };
}
