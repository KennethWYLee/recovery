import { normalizeSessionText } from "./classroom-domain.ts";

export type ClassroomQuestionBankDraft = {
  title: string;
  category: string;
  questionText: string;
  rankingCriteria: string;
  status: "draft" | "ready";
};

export function normalizeQuestionBankDraft(values: {
  title: unknown;
  category: unknown;
  questionText: unknown;
  rankingCriteria: unknown;
  status: unknown;
}): ClassroomQuestionBankDraft | null {
  const title = normalizeSessionText(values.title, 100).replace(/\s+/gu, " ");
  const category = normalizeSessionText(values.category, 50).replace(/\s+/gu, " ");
  const questionText = normalizeSessionText(values.questionText, 2_000);
  const rankingCriteria = normalizeSessionText(values.rankingCriteria, 500);
  if (title.length < 2 || category.length < 1 || questionText.length < 5 || rankingCriteria.length < 5) return null;
  if (values.status !== "draft" && values.status !== "ready") return null;
  return { title, category, questionText, rankingCriteria, status: values.status };
}
