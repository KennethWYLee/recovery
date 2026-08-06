import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeRosterDrafts,
  normalizeRosterStudentId,
  rosterEmailForStudentId,
  rosterEntriesFromRows,
  rosterEntriesFromText,
} from "../lib/classroom-roster.ts";

test("student numbers become exact NTUB email identities", () => {
  assert.equal(normalizeRosterStudentId(" 11256001 "), "11256001");
  assert.equal(normalizeRosterStudentId("bad id"), "");
  assert.equal(rosterEmailForStudentId("11256001"), "11256001@ntub.edu.tw");
});

test("TXT rosters accept one student per line and optional names", () => {
  const result = rosterEntriesFromText("11256002\n11256001\t王小明\n11256003@ntub.edu.tw,陳同學\n");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.entries.map((entry) => entry.studentId), ["11256001", "11256002", "11256003"]);
  assert.equal(result.entries[0].displayName, "王小明");
});

test("Excel rosters require a recognized identity column and preserve optional names", () => {
  const result = rosterEntriesFromRows([
    ["學號", "姓名", "Email"],
    [11256001, "王小明", ""],
    ["11256002", "李小美", "11256002@ntub.edu.tw"],
  ]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[1].displayName, "李小美");
  assert.deepEqual(rosterEntriesFromRows([["座號", "姓名"], [1, "王小明"]]).errors, ["Excel 第一列必須包含「學號」或「Email」欄位。"]);
});

test("server roster validation rejects duplicates, outside domains, and oversized lists", () => {
  assert.equal(normalizeRosterDrafts([{ studentId: "11256001", email: "11256001@gmail.com" }]), null);
  assert.equal(normalizeRosterDrafts([
    { studentId: "11256001", email: "11256001@ntub.edu.tw" },
    { studentId: "11256001", email: "other@ntub.edu.tw" },
  ]), null);
  assert.equal(normalizeRosterDrafts([]), null);
});
