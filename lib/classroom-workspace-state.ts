import { validDemoStudentId, type ClassroomGroup, type ClassroomParticipant } from "./classroom-domain.ts";

export function workspaceResponseKey(
  actorId: string,
  questionId: string | null | undefined,
  group: ClassroomGroup | null | undefined,
): string {
  return questionId && group
    ? `${actorId}:${questionId}:${group.id}:${group.response.version}`
    : "";
}

export function completeSavedRankingOrder(
  eligibleGroupIds: readonly string[],
  savedOrder: readonly string[],
): boolean {
  return savedOrder.length === eligibleGroupIds.length
    && new Set(savedOrder).size === savedOrder.length
    && eligibleGroupIds.every((groupId) => savedOrder.includes(groupId));
}

export function workspaceRankingKey(
  actorId: string,
  questionId: string,
  eligibleGroupIds: readonly string[],
  savedOrder: readonly string[],
  savedOrderIsComplete: boolean,
): string {
  const saved = savedOrderIsComplete ? savedOrder.join(",") : "new";
  return `${actorId}:${questionId}:${eligibleGroupIds.join(",")}:${saved}`;
}

export function workspaceAnswerLabels(groups: readonly ClassroomGroup[]): Record<string, string> {
  return Object.fromEntries(groups.map((group) => [group.id, group.label]));
}

export function demoTestParticipants(
  participants: readonly ClassroomParticipant[],
): ClassroomParticipant[] {
  return participants.filter((participant) => validDemoStudentId(participant.userId));
}
