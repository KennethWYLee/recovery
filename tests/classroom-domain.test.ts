import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASSROOM_DEFAULT_COURSES,
  courseNameKey,
  courseTermLabel,
  currentAcademicTerm,
  normalizeCourseName,
  validCourseName,
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
