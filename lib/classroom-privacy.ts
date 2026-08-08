import type { ClassroomGroup } from "./classroom-domain";

/**
 * Converts a zero-based ordinal to the familiar A, B, ... Z, AA sequence.
 * The label depends only on the server-side group order, so repeated snapshots
 * use the same anonymous label without exposing the stored group position.
 */
export function anonymousAnswerLabel(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error("Anonymous answer ordinal must be a non-negative integer.");
  }
  let value = ordinal + 1;
  let suffix = "";
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(65 + value % 26) + suffix;
    value = Math.floor(value / 26);
  }
  return `回答 ${suffix}`;
}

export function classroomQuestionGroupId(
  hasSelectedQuestion: boolean,
  membershipGroupId: string | null,
  participantGroupId: string | null,
): string | null {
  return hasSelectedQuestion ? membershipGroupId : participantGroupId;
}

/**
 * Produces the group DTO that may cross the classroom API boundary.
 *
 * `ClassroomGroup` remains the public TypeScript contract for compatibility
 * with existing clients. For a non-administrator, the runtime object
 * deliberately omits `position` and replaces every identifying field before
 * it is serialized. Callers must keep the original groups for authorization
 * decisions; this projection is display data only.
 */
export function classroomGroupsForViewer(
  groups: readonly ClassroomGroup[],
  isAdministrator: boolean,
  anonymousGroups = true,
): ClassroomGroup[] {
  if (isAdministrator) {
    return groups.map((group) => ({
      ...group,
      members: group.members.map((member) => ({ ...member })),
      response: { ...group.response },
    }));
  }

  const stableOrder = [...groups].sort((left, right) =>
    left.position - right.position || left.id.localeCompare(right.id, "en"));
  const anonymousLabels = new Map(
    stableOrder.map((group, index) => [group.id, anonymousAnswerLabel(index)]),
  );

  return groups.map((group) => {
    const safeGroup = {
      id: group.id,
      label: anonymousGroups ? anonymousLabels.get(group.id)! : group.label,
      representativeUserId: null,
      members: [],
      response: { ...group.response },
    };
    return safeGroup as unknown as ClassroomGroup;
  });
}
