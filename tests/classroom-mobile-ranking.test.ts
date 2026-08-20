import assert from "node:assert/strict";
import test from "node:test";
import {
  moveSelectedRankingChoice,
  selectNextRankingChoice,
  undoLastRankingChoice,
} from "../lib/classroom-mobile-ranking.ts";

test("點選回答時，回答依序放入下一個名次", () => {
  const first = selectNextRankingChoice(["a", "b", "c"], 0, "c");
  assert.deepEqual(first, { order: ["c", "a", "b"], selectedCount: 1 });

  const second = selectNextRankingChoice(first.order, first.selectedCount, "b");
  assert.deepEqual(second, { order: ["c", "b", "a"], selectedCount: 2 });
});

test("已選回答不能重複加入名次", () => {
  const result = selectNextRankingChoice(["c", "a", "b"], 1, "c");
  assert.deepEqual(result, { order: ["c", "a", "b"], selectedCount: 1 });
});

test("不存在的回答與錯誤進度不會破壞排序", () => {
  assert.deepEqual(selectNextRankingChoice(["a", "b"], 0, "missing"), {
    order: ["a", "b"], selectedCount: 0,
  });
  assert.deepEqual(selectNextRankingChoice(["a", "b"], Number.NaN, "a"), {
    order: ["a", "b"], selectedCount: 1,
  });
  assert.deepEqual(selectNextRankingChoice(["a", "b"], 1, "b"), {
    order: ["a", "b"], selectedCount: 2,
  });
});

test("重選最後一名只移除最後選定的名次", () => {
  assert.deepEqual(undoLastRankingChoice(["c", "b", "a"], 2), {
    order: ["c", "b", "a"],
    selectedCount: 1,
  });
});

test("上下移動不會跨入尚未選擇的回答", () => {
  assert.deepEqual(moveSelectedRankingChoice(["c", "b", "a"], 2, 1, -1), {
    order: ["b", "c", "a"],
    selectedCount: 2,
  });
  assert.deepEqual(moveSelectedRankingChoice(["c", "b", "a"], 2, 1, 1), {
    order: ["c", "b", "a"],
    selectedCount: 2,
  });
  for (const invalidIndex of [-1, 2, 3]) {
    assert.deepEqual(moveSelectedRankingChoice(["c", "b", "a"], 2, invalidIndex, -1), {
      order: ["c", "b", "a"], selectedCount: 2,
    });
  }
  assert.deepEqual(moveSelectedRankingChoice(["c", "b", "a"], 2, 0, -1), {
    order: ["c", "b", "a"], selectedCount: 2,
  });
  assert.deepEqual(moveSelectedRankingChoice(["c", "b", "a"], Number.NaN, 0, 1), {
    order: ["c", "b", "a"], selectedCount: 0,
  });
});
