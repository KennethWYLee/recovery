import assert from "node:assert/strict";
import test from "node:test";
import type { ClassroomGroup, ClassroomParticipant, ClassroomParticipationReport } from "../lib/classroom-domain.ts";
import { applyParticipationManagementSnapshot } from "../lib/classroom-participation-state.ts";
import {
  completeSavedRankingOrder,
  demoTestParticipants,
  workspaceAnswerLabels,
  workspaceRankingKey,
  workspaceResponseKey,
} from "../lib/classroom-workspace-state.ts";

function group(id: string, label: string, version = 1): ClassroomGroup {
  return {
    id,
    label,
    position: 1,
    representativeUserId: null,
    members: [],
    response: { content: "回答", status: "submitted", version, updatedAt: null },
  };
}

function participant(userId: string): ClassroomParticipant {
  return {
    id: `participant-${userId}`,
    userId,
    displayName: userId,
    email: null,
    groupId: null,
    attendance: "on_time",
    joinedPhase: "check_in",
    canRank: true,
    checkedInAt: "2026-08-20T00:00:00.000Z",
  };
}

test("workspace keys isolate actors and groups that share the same response version", () => {
  assert.equal(
    workspaceResponseKey("student", "question-1", group("group-1", "回答 A", 2)),
    "student:question-1:group-1:2",
  );
  assert.notEqual(
    workspaceResponseKey("teacher", "question-1", group("group-1", "回答 A")),
    workspaceResponseKey("student", "question-1", group("group-1", "回答 A")),
  );
  assert.notEqual(
    workspaceResponseKey("student", "question-1", group("group-1", "回答 A")),
    workspaceResponseKey("student", "question-1", group("group-2", "回答 B")),
  );
  assert.equal(workspaceResponseKey("student", null, group("group-1", "回答 A")), "");
  assert.equal(workspaceResponseKey("student", "question-1", null), "");
});

test("ranking keys change when the effective actor changes", () => {
  const teacher = workspaceRankingKey("teacher", "question-1", ["a", "b"], [], false);
  const student = workspaceRankingKey("student", "question-1", ["a", "b"], [], false);
  assert.notEqual(teacher, student);
  assert.equal(student, "student:question-1:a,b:new");
  assert.equal(
    workspaceRankingKey("student", "question-1", ["a", "b"], ["b", "a"], true),
    "student:question-1:a,b:b,a",
  );
});

test("complete saved rankings contain every eligible group exactly once", () => {
  assert.equal(completeSavedRankingOrder(["a", "b"], ["b", "a"]), true);
  assert.equal(completeSavedRankingOrder(["a", "b"], ["a", "a"]), false);
  assert.equal(completeSavedRankingOrder(["a", "b"], ["a"]), false);
  assert.equal(completeSavedRankingOrder(["a", "b"], ["a", "c"]), false);
  assert.equal(completeSavedRankingOrder(["a"], ["a", "b"]), false);
  assert.equal(completeSavedRankingOrder(["a"], ["a", "a"]), false);
  assert.equal(completeSavedRankingOrder(["a", "a"], ["a", "a"]), false);
  assert.equal(completeSavedRankingOrder([], []), true);
});

test("answer labels remain the stable server-projected labels after card shuffling", () => {
  const labels = workspaceAnswerLabels([group("group-2", "回答 B"), group("group-1", "回答 A")]);
  assert.deepEqual(labels, { "group-2": "回答 B", "group-1": "回答 A" });
});

test("student test picker includes only the fixed synthetic accounts", () => {
  const visible = demoTestParticipants([
    participant("demo-user-1"),
    participant("real-student"),
    participant("demo-user-24"),
    participant("demo-user-25"),
  ]);
  assert.deepEqual(visible.map((item) => item.userId), ["demo-user-1", "demo-user-24"]);
});

test("moving a speaker immediately updates both groups and keeps participation history", () => {
  const report: ClassroomParticipationReport = {
    generatedAt: "2026-09-07T00:00:00.000Z", sessionId: "session-1", sessionPhase: "answering",
    groups: [{ id: "a", label: "第 1 組", representativeUserId: "alice" }, { id: "b", label: "第 2 組", representativeUserId: "bob" }],
    questions: [],
    students: ["alice", "bob"].map((userId) => ({
      participantId: `participant-${userId}`, userId, displayName: userId, email: "",
      groupId: userId === "alice" ? "a" : "b", groupLabel: userId === "alice" ? "第 1 組" : "第 2 組",
      attendance: "on_time", joinedPhase: "check_in", checkedInAt: "2026-09-07T00:00:00.000Z",
      eligibleQuestionCount: 1, rankingOpportunityCount: 1, completedRankingCount: 1,
      representativeSubmissionCount: 1, completionRate: 1, questions: [],
    })),
  };
  const snapshot = {
    session: { id: "session-1", phase: "answering" as const },
    groups: [{ id: "a", label: "第 1 組", representativeUserId: null }, { id: "b", label: "第 2 組", representativeUserId: "bob" }],
    participants: ["alice", "bob"].map((userId) => ({ id: `participant-${userId}`, userId, groupId: "b" })),
  };
  const moved = applyParticipationManagementSnapshot(report, snapshot);
  assert.equal(moved.students[0].groupId, "b");
  assert.equal(moved.students[0].groupLabel, "第 2 組");
  assert.equal(moved.groups[0].representativeUserId, null);
  assert.equal(moved.groups[1].representativeUserId, "bob");
  assert.equal(moved.students[0].completedRankingCount, 1);
  assert.equal(moved.students[0].representativeSubmissionCount, 1);
  assert.equal(moved.students[0].questions, report.students[0].questions);
  assert.equal(report.students[0].groupId, "a");
  const appointed = applyParticipationManagementSnapshot(moved, {
    ...snapshot, groups: [snapshot.groups[0], { ...snapshot.groups[1], representativeUserId: "alice" }],
  });
  assert.equal(appointed.groups[1].representativeUserId, "alice");
  assert.equal(appointed.students[1].groupId, "b");
  assert.equal(applyParticipationManagementSnapshot(report, { ...snapshot, session: { ...snapshot.session, id: "other-session" } }), report);
});
