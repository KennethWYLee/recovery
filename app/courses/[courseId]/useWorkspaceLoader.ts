"use client";

import { useCallback, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { classroomApiData } from "@/lib/classroom-api-client";
import type { ClassroomSessionSnapshot } from "@/lib/classroom-domain";
import { completeSavedRankingOrder, workspaceAnswerLabels, workspaceRankingKey, workspaceResponseKey } from "@/lib/classroom-workspace-state";
import { rankingStartsComplete, shouldPrepareRanking } from "./useProgressiveRanking";
import type { WorkspacePayload } from "./workspace-types";

type LoaderRefs = {
  responseKey: MutableRefObject<string>;
  rankingKey: MutableRefObject<string>;
  selectedQuestion: MutableRefObject<string | null>;
  snapshotSignature: MutableRefObject<string>;
};

type LoaderSetters = {
  setPayload: Dispatch<SetStateAction<WorkspacePayload | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  setPending: Dispatch<SetStateAction<boolean>>;
  setResponseText: Dispatch<SetStateAction<string>>;
  setAnswerLabels: Dispatch<SetStateAction<Record<string, string>>>;
};

function shuffle<T>(values: readonly T[]): T[] {
  const next = [...values];
  const random = new Uint32Array(Math.max(1, next.length));
  crypto.getRandomValues(random);
  for (let index = next.length - 1; index > 0; index -= 1) {
    const target = random[index] % (index + 1);
    [next[index], next[target]] = [next[target], next[index]];
  }
  return next;
}

function snapshotSignature(snapshot: ClassroomSessionSnapshot | null): string {
  if (!snapshot) return "empty";
  return [
    snapshot.session.version, snapshot.question?.id ?? "none", snapshot.question?.version ?? 0,
    snapshot.question?.phase ?? "none", snapshot.completion.checkedIn,
    snapshot.completion.submittedGroups, snapshot.completion.rankedStudents,
    snapshot.groups.map((group) => `${group.id}:${group.response.version}:${group.response.status}`).join(","),
    snapshot.currentUser.groupId ?? "none", snapshot.currentUser.hasSubmittedRanking ? 1 : 0,
  ].join("|");
}

function applyPayload(
  data: WorkspacePayload,
  quiet: boolean,
  signatureRef: MutableRefObject<string>,
  setPayload: Dispatch<SetStateAction<WorkspacePayload | null>>,
) {
  const signature = `${data.actor.id}|${snapshotSignature(data.snapshot)}`;
  if (quiet && signature === signatureRef.current) return;
  signatureRef.current = signature;
  setPayload(data);
}

function preparePayloadState(
  data: WorkspacePayload,
  refs: LoaderRefs,
  initializeRanking: (order: string[], complete: boolean) => void,
  setResponseText: Dispatch<SetStateAction<string>>,
  setAnswerLabels: Dispatch<SetStateAction<Record<string, string>>>,
) {
  const snapshot = data.snapshot;
  refs.selectedQuestion.current = snapshot?.question?.id ?? null;
  const currentGroup = snapshot?.groups.find((group) => group.id === snapshot.currentUser.groupId);
  const responseKey = workspaceResponseKey(data.actor.id, snapshot?.question?.id, currentGroup);
  if (responseKey && responseKey !== refs.responseKey.current) {
    refs.responseKey.current = responseKey;
    setResponseText(currentGroup?.response.content ?? "");
  }
  const question = snapshot?.question;
  if (!snapshot || !question || !shouldPrepareRanking(data.actor.isAdmin, question.phase)) return;
  const eligible = snapshot.groups
    .filter((group) => ["submitted", "locked"].includes(group.response.status) && group.response.content.trim().length > 0)
    .map((group) => group.id);
  const savedOrder = snapshot.currentUser.orderedGroupIds;
  const savedOrderIsComplete = completeSavedRankingOrder(eligible, savedOrder);
  const rankingKey = workspaceRankingKey(data.actor.id, question.id, eligible, savedOrder, savedOrderIsComplete);
  if (rankingKey === refs.rankingKey.current) return;
  refs.rankingKey.current = rankingKey;
  initializeRanking(savedOrderIsComplete ? savedOrder : shuffle(eligible), rankingStartsComplete(data.actor.isAdmin, savedOrderIsComplete));
  setAnswerLabels(workspaceAnswerLabels(snapshot.groups));
}

function requestIsStale(requestId: number, currentRequestId: number, aborted: boolean, timedOut: boolean): boolean {
  return requestId !== currentRequestId || (aborted && !timedOut);
}

function workspaceSearch(questionId: string | null, testStudentId: string | null): string {
  const search = new URLSearchParams();
  if (questionId) search.set("questionId", questionId);
  if (testStudentId) search.set("testStudentId", testStudentId);
  return search.size ? `?${search.toString()}` : "";
}

export function useWorkspaceLoader({ courseId, testStudentId, refs, setters, initializeRanking }: {
  courseId: string;
  testStudentId: string | null;
  refs: LoaderRefs;
  setters: LoaderSetters;
  initializeRanking: (order: string[], complete: boolean) => void;
}) {
  const requestRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const cancelLoading = useCallback(() => {
    requestRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);
  const load = useCallback(async (quiet = false, questionId?: string | null, testStudentOverride?: string | null) => {
    if (quiet && abortRef.current) return;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    if (!quiet) { setters.setError(null); setters.setPending(true); }
    const selected = questionId === undefined ? refs.selectedQuestion.current : questionId;
    const activeTestStudent = testStudentOverride === undefined ? testStudentId : testStudentOverride;
    try {
      const suffix = workspaceSearch(selected, activeTestStudent);
      const data = await classroomApiData<WorkspacePayload>(await fetch(`/api/classroom/courses/${encodeURIComponent(courseId)}/session${suffix}`, {
        cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal,
      }));
      if (requestId !== requestRef.current) return;
      preparePayloadState(data, refs, initializeRanking, setters.setResponseText, setters.setAnswerLabels);
      applyPayload(data, quiet, refs.snapshotSignature, setters.setPayload);
    } catch (cause) {
      if (requestIsStale(requestId, requestRef.current, controller.signal.aborted, timedOut)) return;
      if (!quiet) setters.setError(timedOut ? "課程載入超過 15 秒，請確認網路連線後按「重新載入」。" : cause instanceof Error ? cause.message : "目前無法取得課堂資料。");
    } finally {
      clearTimeout(timeout);
      if (requestId === requestRef.current) {
        if (abortRef.current === controller) abortRef.current = null;
        if (!quiet) setters.setPending(false);
      }
    }
  }, [courseId, initializeRanking, refs, setters, testStudentId]);
  return { load, cancelLoading };
}
