import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASSROOM_DEFAULT_COURSES,
  courseNameKey,
  courseTermLabel,
  currentAcademicTerm,
  balancedGroupSizes,
  balancedGroupSizesByCount,
  nextQuestionPhase,
  nextSessionPhase,
  normalizeCourseName,
  normalizeSessionText,
  previousSessionPhase,
  rankResults,
  validAcademicTerm,
  validAcademicYear,
  validCourseName,
  validGroupCapacity,
  validGroupCount,
  validSessionPhase,
} from "../lib/classroom-domain.ts";

test("the teacher receives the six confirmed courses without duplicates", () => {
  assert.deepEqual(CLASSROOM_DEFAULT_COURSES, [
    "資料庫",
    "IoT",
    "智慧金融科技",
    "商業智慧",
    "機器學習",
    "AI量化交易",
  ]);
  assert.equal(new Set(CLASSROOM_DEFAULT_COURSES.map(courseNameKey)).size, 6);
});

test("session validators reject values outside the supported classroom contract", () => {
  assert.equal(normalizeSessionText("  第一行\r\n第二行  ", 100), "第一行\n第二行");
  assert.equal(normalizeSessionText(null, 100), "");
  assert.equal(validAcademicYear(115), true);
  assert.equal(validAcademicYear(99), false);
  assert.equal(validAcademicTerm("summer"), true);
  assert.equal(validAcademicTerm("3"), false);
  assert.equal(validGroupCapacity(6), true);
  assert.equal(validGroupCapacity(21), false);
  assert.equal(validGroupCount(6), true);
  assert.equal(validSessionPhase("answering"), true);
  assert.equal(validSessionPhase("ranking"), false);
  assert.equal(validSessionPhase("unknown"), false);
  assert.equal(nextSessionPhase("check_in"), "grouping");
  assert.equal(nextSessionPhase("grouping"), "answering");
  assert.equal(nextSessionPhase("archived"), null);
  assert.equal(previousSessionPhase("answering"), "grouping");
  assert.equal(previousSessionPhase("check_in"), null);
  assert.deepEqual(balancedGroupSizes(0, 6), []);
  assert.throws(() => balancedGroupSizes(10, 1), /supported range/iu);
  assert.deepEqual(balancedGroupSizesByCount(30, 6), [5, 5, 5, 5, 5, 5]);
  assert.deepEqual(balancedGroupSizesByCount(31, 6), [6, 5, 5, 5, 5, 5]);
  assert.throws(() => balancedGroupSizesByCount(3, 4), /exceeds/iu);
  assert.equal(nextQuestionPhase("ranking"), "locked");
  assert.equal(nextQuestionPhase("locked"), "published");
});

test("balanced grouping keeps the requested capacity and differs by at most one student", () => {
  assert.deepEqual(balancedGroupSizes(50, 6), [6, 6, 6, 6, 6, 5, 5, 5, 5]);
  assert.deepEqual(balancedGroupSizes(31, 6), [6, 5, 5, 5, 5, 5]);
});

test("ranking converts positions to scores, ranks higher scores first, and preserves true ties", () => {
  const results = rankResults(
    [{ id: "a", label: "第1組" }, { id: "b", label: "第2組" }, { id: "c", label: "第3組" }, { id: "d", label: "第4組" }],
    [
      { groupId: "a", rank: 1 }, { groupId: "a", rank: 2 },
      { groupId: "b", rank: 2 }, { groupId: "b", rank: 1 },
      { groupId: "c", rank: 3 }, { groupId: "c", rank: 3 },
    ],
  );
  assert.deepEqual(results.map((result) => result.finalRank), [1, 1, 3, 4]);
  assert.deepEqual(results.map((result) => result.tied), [true, true, false, false]);
  assert.deepEqual(results.map((result) => result.averageScore), [2.5, 2.5, 1, 0]);
  assert.equal(results[0].maximumScore, 3);
});

test("ranking breaks equal average scores by first-place count", () => {
  const results = rankResults(
    [{ id: "a", label: "第1組" }, { id: "b", label: "第2組" }],
    [
      { groupId: "a", rank: 1 }, { groupId: "a", rank: 3 },
      { groupId: "b", rank: 2 }, { groupId: "b", rank: 2 },
    ],
  );
  assert.deepEqual(results.map((result) => result.groupId), ["a", "b"]);
  assert.deepEqual(results.map((result) => result.finalRank), [1, 2]);
});

test("course names are normalized and bounded", () => {
  assert.equal(normalizeCourseName("  AI　量化   交易  "), "AI 量化 交易");
  assert.equal(courseNameKey("  IoT "), "iot");
  assert.equal(validCourseName("資料庫"), true);
  assert.equal(validCourseName("A"), false);
  assert.equal(validCourseName("課".repeat(81)), false);
});

test("academic terms follow the Taiwan school-year boundary", () => {
  assert.deepEqual(currentAcademicTerm(new Date("2026-08-05T00:00:00.000Z")), { academicYear: 115, term: "1" });
  assert.deepEqual(currentAcademicTerm(new Date("2027-02-15T00:00:00.000Z")), { academicYear: 115, term: "2" });
  assert.equal(courseTermLabel({ academicYear: 115, term: "1" }), "115學年度 第1學期");
});
