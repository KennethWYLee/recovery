"use client";

import { ArrowDown, ArrowUp, Check, ClipboardCheck, Hand, RotateCcw, Undo2 } from "lucide-react";
import { useRef } from "react";
import type { ClassroomGroup } from "@/lib/classroom-domain";

type Props = {
  groups: ClassroomGroup[];
  order: string[];
  labels: Record<string, string>;
  selectedCount: number;
  pending: boolean;
  hasSubmittedRanking: boolean;
  onChoose: (groupId: string) => void;
  onUndo: () => void;
  onRestart: () => void;
  onMove: (index: number, offset: number) => void;
  onSubmit: () => void;
};

export function StudentProgressiveRanking({
  groups,
  order,
  labels,
  selectedCount,
  pending,
  hasSubmittedRanking,
  onChoose,
  onUndo,
  onRestart,
  onMove,
  onSubmit,
}: Props) {
  const selected = order.slice(0, selectedCount);
  const candidates = order.slice(selectedCount);
  const complete = order.length > 0 && selectedCount === order.length;
  const instructionRef = useRef<HTMLHeadingElement>(null);
  function selectAndContinue(action: () => void) {
    action();
    requestAnimationFrame(() => instructionRef.current?.focus());
  }

  return (
    <section className="student-focus-card student-ranking-card progressive-ranking">
      <header>
        <div>
          <p>個人完整排序</p>
          <h2>點選按鈕，依序排出名次</h2>
          <p className="ranking-howto">先讀回答，再點「排第 1 名」，接著選第 2 名。全部選完後，確認並送出。</p>
          <small>包含自己的組別也要排序；計算全班共識時，系統會排除你對本組的排序。</small>
        </div>
        <strong className="ranking-progress-label">{selectedCount}／{order.length}</strong>
      </header>

      <div className="ranking-progress" aria-label={`已完成 ${selectedCount}／${order.length}`}>
        <span style={{ width: `${order.length ? (selectedCount / order.length) * 100 : 0}%` }} />
      </div>

      <div className="ranking-next-step">
        <h3 ref={instructionRef} tabIndex={-1} aria-live="polite" aria-atomic="true">
          {complete ? <Check aria-hidden="true" /> : <Hand aria-hidden="true" />}
          {complete ? "全部選好了，確認後記得送出" : `點選下方按鈕，排第 ${selectedCount + 1} 名`}
        </h3>
        {selected.length > 0 && <p>已選：{selected.map((id, index) => `第 ${index + 1} 名 ${labels[id] ?? groups.find((group) => group.id === id)?.label ?? ""}`).join("、")}</p>}
        {selected.length > 0 && <div className="ranking-edit-actions">
          <button type="button" disabled={pending} onClick={() => selectAndContinue(onUndo)}><Undo2 />取消剛才的選擇</button>
          <button type="button" disabled={pending} onClick={() => selectAndContinue(onRestart)}><RotateCcw />全部重選</button>
        </div>}
      </div>

      {!complete && (
        <section className="ranking-candidates" aria-label={`請選出第 ${selectedCount + 1} 名`}>
          <div className="ranking-section-heading">
            <div><strong>從剩下的 {candidates.length} 份回答中選一份</strong></div>
          </div>
          <div className="ranking-choice-list">
            {candidates.map((groupId) => {
              const group = groups.find((item) => item.id === groupId);
              if (!group) return null;
              const label = labels[group.id] ?? group.label;
              return (
                <article key={group.id} className="ranking-choice">
                  <div className="ranking-choice-heading">
                    <strong>{label}</strong>
                    <button type="button" className="button primary" disabled={pending} aria-label={`點選${label}，排第 ${selectedCount + 1} 名`} onClick={() => selectAndContinue(() => onChoose(group.id))}>
                      <Hand aria-hidden="true" />點選，排第 {selectedCount + 1} 名
                    </button>
                  </div>
                  <p>{group.response.content}</p>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {selected.length > 0 && (
        <section className="selected-ranking" aria-label="目前排序">
          <div className="ranking-section-heading">
            <div><Check /><strong>{complete ? "確認你的排序" : "已排好的回答"}</strong></div>
            <small>第 1 名在最上方；可點「往前一名／往後一名」調整。</small>
          </div>
          <ol>
            {selected.map((groupId, index) => {
              const group = groups.find((item) => item.id === groupId);
              if (!group) return null;
              return (
                <li key={group.id}>
                  <strong className="selected-rank-number">第 {index + 1} 名</strong>
                  <div>
                    <small>{labels[group.id] ?? group.label}</small>
                    <p>{group.response.content}</p>
                  </div>
                  <span className="rank-controls">
                    <button type="button" aria-label={`將第 ${index + 1} 名往前一名`} disabled={pending || index === 0} onClick={() => onMove(index, -1)}><ArrowUp />往前一名</button>
                    <button type="button" aria-label={`將第 ${index + 1} 名往後一名`} disabled={pending || index === selectedCount - 1} onClick={() => onMove(index, 1)}><ArrowDown />往後一名</button>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      <button type="button" className="button primary wide ranking-submit" disabled={pending || !complete} onClick={onSubmit}>
        <ClipboardCheck />
        {pending ? "正在送出…" : !complete ? `還有 ${candidates.length} 份回答待選` : hasSubmittedRanking ? "確認並更新排序" : "確認並送出排序"}
      </button>
    </section>
  );
}
