import assert from "node:assert/strict";
import test from "node:test";
import {
  CLASSROOM_SYSTEM_ADMIN_EMAILS,
  classroomIdentityKind,
  isClassroomSystemAdministrator,
  normalizeClassroomEmail,
} from "../lib/classroom-access.ts";

test("the two confirmed accounts are system administrators", () => {
  assert.deepEqual(CLASSROOM_SYSTEM_ADMIN_EMAILS, [
    "wy.lee@ntub.edu.tw",
    "kenneth.wy.lee21@gmail.com",
  ]);
  assert.equal(isClassroomSystemAdministrator("WY.LEE@NTUB.EDU.TW"), true);
  assert.equal(isClassroomSystemAdministrator("kenneth.wy.lee21@gmail.com"), true);
});

test("classroom email normalization is strict and deterministic", () => {
  assert.equal(normalizeClassroomEmail(" Student@NTUB.EDU.TW "), "student@ntub.edu.tw");
  assert.equal(normalizeClassroomEmail("student @ntub.edu.tw"), "");
  assert.equal(normalizeClassroomEmail("not-an-email"), "");
});

test("only the exact NTUB domain may request access", () => {
  assert.equal(classroomIdentityKind("student@ntub.edu.tw"), "ntub_member");
  assert.equal(classroomIdentityKind("student@sub.ntub.edu.tw"), "ineligible");
  assert.equal(classroomIdentityKind("student@ntub.edu.tw.example.com"), "ineligible");
  assert.equal(classroomIdentityKind("student@gmail.com"), "ineligible");
});

test("configured administrators are additive and normalized", () => {
  assert.equal(classroomIdentityKind("chair@example.org", " chair@example.org "), "administrator");
  assert.equal(isClassroomSystemAdministrator("wy.lee@ntub.edu.tw", "chair@example.org"), true);
});
