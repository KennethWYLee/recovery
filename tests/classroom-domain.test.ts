import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASSROOM_DEFAULT_COURSES,
  courseNameKey,
  courseTermLabel,
  currentAcademicTerm,
  balancedGroupSizes,
  balancedGroupSizesByCount,
  classroomAnswerWindowError,
  completeClassroomRankingOrder,
  nextQuestionPhase,
  nextSessionPhase,
  normalizeCourseName,
  normalizeSessionText,
  previousSessionPhase,
  rankResults,
  rankingOrderExcludingGroup,
  rankingPosition,
  rankingsExcludingOwnGroup,
  validAcademicTerm,
  validAcademicYear,
  validCourseName,
  validDemoStudentId,
  validGroupCapacity,
  validGroupCount,
  validSessionPhase,
} from "../lib/classroom-domain.ts";

test("ranking position returns a one-based position or null", () => {
  assert.equal(rankingPosition(["group-b", "group-a", "group-c"], "group-a"), 2);
  assert.equal(rankingPosition(["group-b", "group-a", "group-c"], "group-missing"), null);
});

test("student result comparison removes the student's own group before reindexing", () => {
  const comparable = rankingOrderExcludingGroup(["own", "group-b", "group-c"], "own");
  assert.deepEqual(comparable, ["group-b", "group-c"]);
  assert.equal(rankingPosition(comparable, "group-b"), 1);
  assert.equal(rankingPosition(comparable, "own"), null);
  assert.deepEqual(rankingOrderExcludingGroup(["group-a"], null), ["group-a"]);
});

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
    [{ id: "b", label: "第2組" }, { id: "a", label: "第1組" }],
    [
      { groupId: "a", rank: 1 }, { groupId: "a", rank: 3 },
      { groupId: "b", rank: 2 }, { groupId: "b", rank: 2 },
    ],
  );
  assert.deepEqual(results.map((result) => result.groupId), ["a", "b"]);
  assert.deepEqual(results.map((result) => result.finalRank), [1, 2]);
});

test("ranking order comes from scores and rank distribution, not input order or labels", () => {
  const scoreOrdered = rankResults(
    [
      { id: "weak", label: "A" },
      { id: "strong", label: "Z" },
      { id: "middle", label: "M" },
    ],
    [
      { groupId: "weak", rank: 3 }, { groupId: "weak", rank: 3 },
      { groupId: "strong", rank: 1 }, { groupId: "strong", rank: 1 },
      { groupId: "middle", rank: 2 }, { groupId: "middle", rank: 2 },
    ],
  );
  assert.deepEqual(scoreOrdered.map((result) => result.groupId), ["strong", "middle", "weak"]);
  assert.deepEqual(scoreOrdered.map((result) => result.finalRank), [1, 2, 3]);

  const distributionOrdered = rankResults(
    [{ id: "first-place", label: "Z" }, { id: "steady", label: "A" }],
    [
      { groupId: "first-place", rank: 1 }, { groupId: "first-place", rank: 3 },
      { groupId: "steady", rank: 2 }, { groupId: "steady", rank: 2 },
    ],
  );
  assert.deepEqual(distributionOrdered.map((result) => result.groupId), ["first-place", "steady"]);
  assert.deepEqual(distributionOrdered.map((result) => result.tied), [false, false]);
});

test("average score remains the first comparison when groups receive different vote counts", () => {
  const results = rankResults(
    [{ id: "more-votes", label: "A" }, { id: "sparse-best", label: "Z" }],
    [
      { groupId: "more-votes", rank: 1 },
      { groupId: "more-votes", rank: 3 },
      { groupId: "sparse-best", rank: 1 },
    ],
  );
  assert.deepEqual(results.map((result) => result.groupId), ["sparse-best", "more-votes"]);
  assert.deepEqual(results.map((result) => result.averageScore), [3, 2]);
});

test("ranking ignores malformed and unknown items and reports the exact distribution", () => {
  const results = rankResults(
    [{ id: "b", label: "回答 B" }, { id: "a", label: "回答 A" }],
    [
      { groupId: "a", rank: 3 }, { groupId: "a", rank: 1 },
      { groupId: "b", rank: 2 }, { groupId: "b", rank: 2 },
      { groupId: "missing", rank: 1 }, { groupId: "a", rank: 0 },
      { groupId: "a", rank: 1.5 }, { groupId: "b", rank: Number.NaN },
    ],
  );
  assert.deepEqual(results.map((result) => result.groupId), ["a", "b"]);
  assert.deepEqual(results.map((result) => result.ratingCount), [2, 2]);
  assert.deepEqual(results.map((result) => result.rankCounts), [[1, 0, 1], [0, 2, 0]]);
  assert.deepEqual(results.map((result) => result.averageScore), [2, 2]);
  assert.deepEqual(results.map((result) => result.finalRank), [1, 2]);
  assert.deepEqual(results.map((result) => result.tied), [false, false]);
});

test("equal averages are ties only when every rank count is equal", () => {
  const results = rankResults(
    [{ id: "b", label: "回答 B" }, { id: "a", label: "回答 A" }],
    [
      { groupId: "a", rank: 1 }, { groupId: "a", rank: 3 }, { groupId: "a", rank: 4 },
      { groupId: "b", rank: 2 }, { groupId: "b", rank: 2 }, { groupId: "b", rank: 4 },
    ],
  );
  assert.deepEqual(results.map((result) => result.groupId), ["a", "b"]);
  assert.deepEqual(results.map((result) => result.finalRank), [1, 2]);
  assert.deepEqual(results.map((result) => result.tied), [false, false]);
});

test("consensus scoring removes each student's own group and reindexes the remaining answers", () => {
  const first = rankingsExcludingOwnGroup([
    { userId: "u1", ownGroupId: "a", groupId: "a", rank: 1 },
    { userId: "u1", ownGroupId: "a", groupId: "b", rank: 2 },
    { userId: "u1", ownGroupId: "a", groupId: "c", rank: 3 },
  ]);
  const second = rankingsExcludingOwnGroup([
    { userId: "u1", ownGroupId: "a", groupId: "b", rank: 1 },
    { userId: "u1", ownGroupId: "a", groupId: "c", rank: 2 },
    { userId: "u1", ownGroupId: "a", groupId: "a", rank: 3 },
  ]);
  assert.deepEqual(first, [{ groupId: "b", rank: 1 }, { groupId: "c", rank: 2 }]);
  assert.deepEqual(second, first, "moving the student's own answer must not change other groups' effective ranks");

  const mixedUsers = rankingsExcludingOwnGroup([
    { userId: "u2", ownGroupId: "b", groupId: "a", rank: 3 },
    { userId: "u1", ownGroupId: "a", groupId: "c", rank: 3 },
    { userId: "u2", ownGroupId: "b", groupId: "b", rank: 2 },
    { userId: "u1", ownGroupId: "a", groupId: "a", rank: 1 },
    { userId: "u2", ownGroupId: "b", groupId: "c", rank: 1 },
    { userId: "u1", ownGroupId: "a", groupId: "b", rank: 2 },
  ]);
  assert.deepEqual(mixedUsers, [
    { groupId: "c", rank: 1 }, { groupId: "a", rank: 2 },
    { groupId: "b", rank: 1 }, { groupId: "c", rank: 2 },
  ]);
});

test("answer windows and complete ranking orders reject bypass attempts", () => {
  assert.equal(classroomAnswerWindowError("answering", "2026-08-08T10:00:01.000Z", "2026-08-08T10:00:00.000Z"), null);
  assert.equal(classroomAnswerWindowError("answering", "2026-08-08T10:00:00.000Z", "2026-08-08T10:00:00.000Z"), "ANSWER_DEADLINE_PASSED");
  assert.equal(classroomAnswerWindowError("presenting", null, "2026-08-08T10:00:00.000Z"), "ANSWERING_CLOSED");

  const expected = ["group-a", "group-b", "group-c"];
  assert.deepEqual(completeClassroomRankingOrder(["group-c", "group-a", "group-b"], expected), ["group-c", "group-a", "group-b"]);
  assert.equal(completeClassroomRankingOrder(["group-a", "group-b"], expected), null);
  assert.equal(completeClassroomRankingOrder(["group-a", "group-a", "group-c"], expected), null);
  assert.equal(completeClassroomRankingOrder(["group-a", "group-b", "group-x"], expected), null);
  assert.equal(completeClassroomRankingOrder(["group-a", 2, "group-c"], expected), null);
  assert.equal(completeClassroomRankingOrder("group-a,group-b,group-c", expected), null);
});

test("course names are normalized and bounded", () => {
  assert.equal(normalizeCourseName("  AI　量化   交易  "), "AI 量化 交易");
  assert.equal(courseNameKey("  IoT "), "iot");
  assert.equal(validCourseName("資料庫"), true);
  assert.equal(validCourseName("A"), false);
  assert.equal(validCourseName("課".repeat(81)), false);
});

test("student test mode accepts only the fixed synthetic student identifiers", () => {
  assert.equal(validDemoStudentId("demo-user-1"), true);
  assert.equal(validDemoStudentId("demo-user-24"), true);
  assert.equal(validDemoStudentId("demo-user-25"), false);
  assert.equal(validDemoStudentId("class-user-1"), false);
  assert.equal(validDemoStudentId(null), false);
});

test("academic terms follow the Taiwan school-year boundary", () => {
  assert.deepEqual(currentAcademicTerm(new Date("2026-08-05T00:00:00.000Z")), { academicYear: 115, term: "1" });
  assert.deepEqual(currentAcademicTerm(new Date("2027-02-15T00:00:00.000Z")), { academicYear: 115, term: "2" });
  assert.equal(courseTermLabel({ academicYear: 115, term: "1" }), "115學年度 第1學期");
});
