"use client";

import { ArrowRight, Undo2 } from "lucide-react";
import type { ClassroomSessionSnapshot } from "@/lib/classroom-domain";

function rankingActionDescription(phase: string, missing: number): string {
  if (phase === "locked") return `依實際收到的有效排序公布，不要求固定人數。${missing > 0 ? `還有 ${missing} 位未完成；可直接公布目前結果，或重新開放讓學生補送。` : "確認後即可公布。"}`;
  return `小組回答與個人排序分開計算。${missing > 0 ? `還有 ${missing} 位未完成個人排序。` : "學生均已完成個人排序。"}`;
}

export function QuestionActions({ snapshot, pending, label, onAdvance, onReopen }: {
  snapshot: ClassroomSessionSnapshot; pending: boolean; label: string;
  onAdvance: () => void; onReopen: () => void;
}) {
  const question = snapshot.question;
  if (!question) return null;
  const count = snapshot.completion.rankedStudents;
  const teacherSubmitted = snapshot.currentUser.hasSubmittedRanking;
  const missing = Math.max(0, snapshot.completion.eligibleStudents - count);
  const cannotLock = question.phase === "ranking" && (count === 0 || !teacherSubmitted);
  const cannotPublish = question.phase === "locked" && (count === 0 || !teacherSubmitted);
  return <div className="session-action-bar question-actions">
    <div>
      {["ranking", "locked"].includes(question.phase) ? <>
        <strong>個人排序已收到 {count}／{snapshot.completion.eligibleStudents} 份；教師{teacherSubmitted ? "已送出" : "尚未送出"}。</strong>
        <p>{rankingActionDescription(question.phase, missing)}</p>
        {count === 0 && <p>尚未收到學生的有效排序。</p>}
      </> : <span>{question.phase === "published" ? "結果已固定並對學生公開。" : "同一時間只會開放一個問題。"}</span>}
    </div>
    {question.phase === "locked" && <button type="button" className="button secondary" disabled={pending} onClick={onReopen}><Undo2 />重新開放排序</button>}
    <button type="button" className="button primary" disabled={pending || cannotLock || cannotPublish} onClick={onAdvance}>{label}<ArrowRight /></button>
  </div>;
}
