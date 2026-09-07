import { normalizeSessionText, type ClassroomGroup, type ClassroomSessionSnapshot } from "./classroom-domain";

export type ClassroomResponseDraft = {
  scope: string; text: string; serverContent: string; version: number; dirty: boolean;
};

export function emptyResponseDraft(): ClassroomResponseDraft {
  return { scope: "", text: "", serverContent: "", version: 0, dirty: false };
}

export function responseDraftScope(actorId: string, questionId: string, groupId: string): string {
  return `${actorId}:${questionId}:${groupId}`;
}

export function receiveResponseDraft(draft: ClassroomResponseDraft, scope: string, response: ClassroomGroup["response"]) {
  if (draft.scope !== scope) {
    Object.assign(draft, { scope, text: response.content, serverContent: response.content, version: response.version, dirty: false });
  } else if (response.version >= draft.version) {
    if (!draft.dirty) draft.text = response.content;
    draft.serverContent = response.content;
    draft.version = response.version;
    draft.dirty = normalizeSessionText(draft.text, 4_000) !== response.content;
  }
  return draft.text;
}

export function preserveNewerResponses(previous: ClassroomSessionSnapshot | null, incoming: ClassroomSessionSnapshot | null) {
  if (!previous || !incoming || previous.session.id !== incoming.session.id || previous.question?.id !== incoming.question?.id) return incoming;
  return { ...incoming, groups: incoming.groups.map((group) => {
    const saved = previous.groups.find((item) => item.id === group.id);
    return saved && saved.response.version > group.response.version ? { ...group, response: saved.response } : group;
  }) };
}
