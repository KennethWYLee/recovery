"use client";

import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { classroomApiData } from "@/lib/classroom-api-client";
import { receiveResponseDraft, responseDraftScope, type ClassroomResponseDraft } from "@/lib/classroom-response-draft";
import type { ClassroomGroup } from "@/lib/classroom-domain";
import type { WorkspacePayload } from "./workspace-types";

type SaveState = "idle" | "saving" | "saved" | "error";
type LiveResponse = { groupId: string; isRepresentative: boolean; response: ClassroomGroup["response"] };
type Props = {
  payload: WorkspacePayload | null; responseText: string; testStudentId: string | null;
  draftRef: MutableRefObject<ClassroomResponseDraft>;
  setPayload: Dispatch<SetStateAction<WorkspacePayload | null>>;
  setResponseText: Dispatch<SetStateAction<string>>;
  setSaveState: Dispatch<SetStateAction<SaveState>>; saveState: SaveState;
  setPending: Dispatch<SetStateAction<boolean>>; setError: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
};

export function useResponseAutosave(props: Props) {
  const inFlight = useRef<Promise<void> | null>(null);
  const manual = useRef(false);
  const blocked = useRef("");
  const { payload, draftRef, responseText, testStudentId, saveState } = props;
  const snapshot = payload?.snapshot;
  const question = snapshot?.question;
  const group = snapshot?.groups.find((item) => item.id === snapshot.currentUser.groupId);
  const scope = payload && question && group ? responseDraftScope(payload.actor.id, question.id, group.id) : "";

  function accept(live: LiveResponse) {
    if (!payload || !question || !group || draftRef.current.scope !== scope || live.groupId !== group.id) return;
    props.setResponseText(receiveResponseDraft(draftRef.current, scope, live.response));
    props.setPayload((current) => {
      if (!current?.snapshot || current.actor.id !== payload.actor.id || current.snapshot.question?.id !== question.id) return current;
      return { ...current, snapshot: { ...current.snapshot, groups: current.snapshot.groups.map((item) =>
        item.id === live.groupId && item.response.version <= live.response.version ? { ...item, response: live.response } : item) } };
    });
  }

  async function refreshBeforeSubmit(url: string) {
    if (!question || !group) return;
    const search = new URLSearchParams({ questionId: question.id });
    if (testStudentId) search.set("testStudentId", testStudentId);
    const latest = await classroomApiData<{ live: LiveResponse }>(await fetch(`${url}?${search}`, {
      cache: "no-store", signal: AbortSignal.timeout(15_000),
    }));
    if (draftRef.current.scope !== scope) return;
    if (latest.live.groupId !== group.id || !latest.live.isRepresentative) throw new Error("發言人或組別已更新，請確認目前分組。輸入內容仍保留。");
    accept(latest.live);
  }

  async function write(submit: boolean) {
    if (!snapshot || !question || !group || draftRef.current.scope !== scope) return;
    props.setSaveState("saving");
    const url = `/api/classroom/sessions/${encodeURIComponent(snapshot.session.id)}/response`;
    try {
      if (submit) await refreshBeforeSubmit(url);
      if (draftRef.current.scope !== scope) return;
      const sentText = draftRef.current.text;
      const data = await classroomApiData<{ live: LiveResponse }>(await fetch(url, {
        method: "PUT", headers: { accept: "application/json", "content-type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ questionId: question.id, content: sentText, expectedVersion: draftRef.current.version, submit, testStudentId }),
      }));
      if (draftRef.current.scope !== scope) return;
      accept(data.live);
      blocked.current = "";
      props.setError(null);
      props.setSaveState(draftRef.current.dirty ? "idle" : "saved");
      if (submit) props.setNotice("小組回答已送出。");
    } catch (cause) {
      if (draftRef.current.scope !== scope) return;
      blocked.current = `${scope}|${draftRef.current.text}`;
      props.setSaveState("error");
      props.setError(`儲存未完成，輸入內容仍保留。${cause instanceof Error ? cause.message : "請檢查連線。"} 可再按「送出本組回答」。`);
    }
  }

  async function saveResponse(submit: boolean) {
    if (manual.current) return;
    manual.current = true;
    props.setPending(true);
    try {
      await inFlight.current;
      await write(submit);
    } finally {
      manual.current = false;
      props.setPending(false);
    }
  }

  useEffect(() => {
    if (payload?.actor.isAdmin || question?.phase !== "answering" || !snapshot?.currentUser.isRepresentative || group?.response.status !== "draft") return;
    if (!draftRef.current.dirty || draftRef.current.scope !== scope || blocked.current === `${scope}|${responseText}`) return;
    const timer = window.setTimeout(() => {
      if (inFlight.current || manual.current) return;
      const task = write(false);
      inFlight.current = task;
      void task.finally(() => { if (inFlight.current === task) inFlight.current = null; });
    }, 1_000);
    return () => window.clearTimeout(timer);
  // The current render supplies the matching question, draft and response version.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload, scope, responseText, testStudentId, saveState]);

  return { saveResponse };
}
