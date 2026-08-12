import assert from "node:assert/strict";
import test from "node:test";
import type { ClassroomGroup } from "../lib/classroom-domain.ts";
import {
  anonymousAnswerLabel,
  classroomGroupsForViewer,
  classroomQuestionGroupId,
  studentMaySeeGroupNames,
} from "../lib/classroom-privacy.ts";

function group(id: string, label: string, position: number): ClassroomGroup {
  return {
    id,
    label,
    position,
    representativeUserId: `representative-${id}`,
    members: [{
      id: `participant-${id}`,
      userId: `user-${id}`,
      displayName: `Student ${id}`,
      email: `${id}@ntub.edu.tw`,
      groupId: id,
      attendance: "on_time",
      joinedPhase: "check_in",
      canRank: true,
      checkedInAt: "2026-08-08T00:00:00.000Z",
    }],
    response: {
      content: `Answer ${id}`,
      status: "submitted",
      version: 2,
      updatedAt: "2026-08-08T00:05:00.000Z",
    },
  };
}

test("anonymous answer labels remain deterministic beyond twenty-six groups", () => {
  assert.equal(anonymousAnswerLabel(0), "回答 A");
  assert.equal(anonymousAnswerLabel(25), "回答 Z");
  assert.equal(anonymousAnswerLabel(26), "回答 AA");
  assert.equal(anonymousAnswerLabel(27), "回答 AB");
  assert.throws(() => anonymousAnswerLabel(-1), /non-negative integer/iu);
});

test("student group DTOs expose answers but no group identity or stored position", () => {
  const source = [
    group("group-two", "智慧金融組", 20),
    group("group-one", "量化交易組", 10),
  ];

  const visible = classroomGroupsForViewer(source, false);
  const repeated = classroomGroupsForViewer(source, false);

  assert.deepEqual(visible.map((item) => item.label), ["回答 B", "回答 A"]);
  assert.deepEqual(visible, repeated);
  assert.equal(JSON.stringify(visible).includes("智慧金融組"), false);
  assert.equal(JSON.stringify(visible).includes("量化交易組"), false);
  for (const item of visible) {
    assert.equal(Object.hasOwn(item, "position"), false);
    assert.equal(item.representativeUserId, null);
    assert.deepEqual(item.members, []);
    assert.match(item.response.content, /^Answer /u);
  }

  assert.equal(source[0].label, "智慧金融組");
  assert.equal(source[0].position, 20);
  assert.equal(source[0].members.length, 1);
});

test("administrator group DTOs retain the complete group evidence", () => {
  const source = [group("group-one", "資料庫組", 1)];
  const visible = classroomGroupsForViewer(source, true);

  assert.deepEqual(visible, source);
  assert.notEqual(visible, source);
  assert.notEqual(visible[0].members, source[0].members);
  assert.notEqual(visible[0].response, source[0].response);
});

test("anonymous labels use the identifier to break equal stored positions", () => {
  const source = [group("group-z", "第 Z 組", 1), group("group-a", "第 A 組", 1)];
  const byId = new Map(classroomGroupsForViewer(source, false).map((item) => [item.id, item.label]));
  assert.equal(byId.get("group-a"), "回答 A");
  assert.equal(byId.get("group-z"), "回答 B");
});

test("named mode keeps only the teacher-approved group label", () => {
  const source = [group("group-one", "資料庫組", 1)];
  const visible = classroomGroupsForViewer(source, false, false);
  assert.equal(visible[0].label, "資料庫組");
  assert.deepEqual(visible[0].members, []);
  assert.equal(visible[0].representativeUserId, null);
  assert.equal(Object.hasOwn(visible[0], "position"), false);
});

test("students cannot see group names while answers are being compared", () => {
  for (const phase of ["answering", "presenting", "ranking", "locked"]) {
    assert.equal(studentMaySeeGroupNames(phase, false), false, phase);
  }
});

test("teacher may reveal group names only after publishing the result", () => {
  assert.equal(studentMaySeeGroupNames("published", false), true);
  assert.equal(studentMaySeeGroupNames("archived", false), true);
  assert.equal(studentMaySeeGroupNames("published", true), false);
  assert.equal(studentMaySeeGroupNames(null, false), false);
});

test("an active question uses only its captured membership and never the session-group fallback", () => {
  assert.equal(classroomQuestionGroupId(true, null, "group-late"), null);
  assert.equal(classroomQuestionGroupId(true, "group-captured", "group-current"), "group-captured");
  assert.equal(classroomQuestionGroupId(false, null, "group-next"), "group-next");
});
