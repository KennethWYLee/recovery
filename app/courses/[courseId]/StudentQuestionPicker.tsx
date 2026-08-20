import { QUESTION_PHASE_LABELS, type ClassroomQuestion, type ClassroomQuestionSummary } from "@/lib/classroom-domain";

export function StudentQuestionPicker({
  questions,
  question,
  pending,
  onSelect,
}: {
  questions: ClassroomQuestionSummary[];
  question: ClassroomQuestion | null;
  pending: boolean;
  onSelect: (questionId: string) => void;
}) {
  if (!question || questions.length < 2) return null;
  return (
    <label className="student-question-picker">
      <span>目前與歷史問題</span>
      <select value={question.id} disabled={pending} onChange={(event) => onSelect(event.target.value)}>
        {questions.map((item) => (
          <option value={item.id} key={item.id}>
            {`問題 ${item.position} · ${QUESTION_PHASE_LABELS[item.phase]}`}
          </option>
        ))}
      </select>
    </label>
  );
}
