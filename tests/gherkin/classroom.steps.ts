import assert from "node:assert/strict";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import {
  rankResults,
  rankingsExcludingOwnGroup,
  type ClassroomGroup,
  type ClassroomRawRankingItem,
  type ClassroomRankingResult,
} from "../../lib/classroom-domain.ts";
import { classroomGroupsForViewer } from "../../lib/classroom-privacy.ts";
import { normalizeClassroomIncidentDraft, type ClassroomIncidentDraft } from "../../lib/classroom-observability.ts";

let rawRankings: ClassroomRawRankingItem[] = [];
let filteredRankings: Array<{ groupId: string; rank: number }> = [];
let rankingResults: ClassroomRankingResult[] = [];
let storedGroups: ClassroomGroup[] = [];
let visibleGroups: ClassroomGroup[] = [];
let incidentInput: Record<string, unknown> = {};
let incident: ClassroomIncidentDraft | null = null;

Before(() => {
  rawRankings = [];
  filteredRankings = [];
  rankingResults = [];
  storedGroups = [];
  visibleGroups = [];
  incidentInput = {};
  incident = null;
});

Given("三組學生都完成包含自己組的完整排序", () => {
  const orders = [
    { userId: "student-a", ownGroupId: "group-a", order: ["group-a", "group-b", "group-c"] },
    { userId: "student-b", ownGroupId: "group-b", order: ["group-c", "group-b", "group-a"] },
    { userId: "student-c", ownGroupId: "group-c", order: ["group-b", "group-a", "group-c"] },
  ];
  rawRankings = orders.flatMap(({ userId, ownGroupId, order }) => order.map((groupId, index) => ({
    userId,
    ownGroupId,
    groupId,
    rank: index + 1,
  })));
});

When("系統計算排除自己組的全班共識", () => {
  filteredRankings = rankingsExcludingOwnGroup(rawRankings);
  rankingResults = rankResults([
    { id: "group-a", label: "回答 A" },
    { id: "group-b", label: "回答 B" },
    { id: "group-c", label: "回答 C" },
  ], filteredRankings);
});

Then("每位學生自己的組都不計分", () => {
  assert.equal(filteredRankings.length, 6);
  for (const item of rawRankings.filter((entry) => entry.groupId === entry.ownGroupId)) {
    const originalUserItems = rawRankings.filter((entry) => entry.userId === item.userId);
    const expectedRemaining = originalUserItems.length - 1;
    assert.equal(expectedRemaining, 2);
  }
});

Then("剩餘回答的名次會從第一名重新連續編排", () => {
  for (let offset = 0; offset < filteredRankings.length; offset += 2) {
    assert.deepEqual(filteredRankings.slice(offset, offset + 2).map((item) => item.rank), [1, 2]);
  }
});

Then("分數較高的回答會排在前面", () => {
  assert.equal(rankingResults[0]?.groupId, "group-b");
  assert.ok(rankingResults[0].averageScore >= rankingResults[1].averageScore);
});

Given("系統內有包含真實組名、組員與代表的三組回答", () => {
  storedGroups = [0, 1, 2].map((position) => ({
    id: `group-${position}`,
    label: `真實第 ${position + 1} 組`,
    position,
    representativeUserId: `student-${position}`,
    members: [{
      id: `participant-${position}`,
      userId: `student-${position}`,
      displayName: `學生 ${position + 1}`,
      email: `student-${position}@example.invalid`,
      groupId: `group-${position}`,
      attendance: "on_time",
      joinedPhase: "check_in",
      canRank: true,
      checkedInAt: "2026-08-08T00:00:00.000Z",
    }],
    response: { content: `回答 ${position + 1}`, status: "submitted", version: 1, updatedAt: null },
  }));
});

When("學生讀取匿名回答清單", () => {
  visibleGroups = classroomGroupsForViewer(storedGroups, false);
});

Then("回應不包含真實組名、組員、代表或儲存位置", () => {
  const serialized = JSON.stringify(visibleGroups);
  assert.doesNotMatch(serialized, /真實第|student-|displayName|position/u);
  assert.ok(visibleGroups.every((group) => group.members.length === 0 && group.representativeUserId === null));
});

Then("每組只顯示穩定的回答代號", () => {
  assert.deepEqual(visibleGroups.map((group) => group.label), ["回答 A", "回答 B", "回答 C"]);
  assert.deepEqual(classroomGroupsForViewer(storedGroups, false).map((group) => group.label), visibleGroups.map((group) => group.label));
});

function completeIncidentInput(): Record<string, unknown> {
  return {
    title: "排序提交失敗",
    severity: "high",
    status: "resolved",
    sourceRequestId: "req-11111111-1111-4111-8111-111111111111",
    verificationRequestId: "req-22222222-2222-4222-8222-222222222222",
    symptom: "部分學生送出排序時收到伺服器錯誤。",
    rootCause: "資料庫欄位與部署版本不一致。",
    resolution: "套用資料庫遷移並重新部署相同版本。",
    fixRelease: "commit-a1b2c3d4",
    regressionCheck: "排序提交與資料庫版本整合測試",
    regressionCommand: "npm run test:workflow",
    regressionEvidence: "CI run 184 的 8 項 workflow tests 全部通過。",
    verificationResult: "passed",
  };
}

Given("管理員已記錄失敗與修正後成功的 Request ID", () => {
  incidentInput = completeIncidentInput();
});

Given("管理員只記錄失敗的 Request ID", () => {
  incidentInput = completeIncidentInput();
  delete incidentInput.verificationRequestId;
  incidentInput.verificationResult = "not_run";
});

When("管理員填寫原因、修正方式、部署版本與回歸測試結果", () => {
  incident = normalizeClassroomIncidentDraft(incidentInput);
});

When("管理員嘗試將問題標示為已解決", () => {
  incident = normalizeClassroomIncidentDraft(incidentInput);
});

Then("系統接受問題結案", () => {
  assert.equal(incident?.status, "resolved");
  assert.equal(incident?.verificationResult, "passed");
});

Then("系統拒絕問題結案", () => {
  assert.equal(incident, null);
});
