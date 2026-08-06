import assert from "node:assert/strict";
import test from "node:test";
import { normalizeQuestionBankDraft } from "../lib/classroom-question-bank.ts";

test("question bank drafts normalize reusable classroom questions", () => {
  assert.deepEqual(normalizeQuestionBankDraft({
    title: "  正規化  設計判斷  ",
    category: "  資料庫  設計 ",
    questionText: "說明這個資料表設計是否符合第三正規化。\r\n請提出理由。",
    rankingCriteria: "請依正確性、解釋力與理由充分程度排序。",
    status: "ready",
  }), {
    title: "正規化 設計判斷",
    category: "資料庫 設計",
    questionText: "說明這個資料表設計是否符合第三正規化。\n請提出理由。",
    rankingCriteria: "請依正確性、解釋力與理由充分程度排序。",
    status: "ready",
  });
});

test("question bank drafts reject incomplete content", () => {
  assert.equal(normalizeQuestionBankDraft({ title: "A", category: "SQL", questionText: "太短", rankingCriteria: "不足", status: "ready" }), null);
  assert.equal(normalizeQuestionBankDraft({ title: "有效標題", category: "SQL", questionText: "這是一個完整問題。", rankingCriteria: "請依正確性排序。", status: "active" }), null);
  assert.equal(normalizeQuestionBankDraft({ title: null, category: null, questionText: null, rankingCriteria: null, status: null }), null);
});
