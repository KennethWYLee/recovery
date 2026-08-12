"use client";

import { ArrowDown, ArrowUp, Check, ClipboardCheck, RotateCcw, Undo2 } from "lucide-react";
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

  return (
    <section className="student-focus-card student-ranking-card progressive-ranking">
      <header>
        <div>
          <p>個人完整排序</p>
          <h2>{complete ? "請確認完整排序" : `現在請選出第 ${selectedCount + 1} 名`}</h2>
          <small>只顯示匿名回答。計算全班共識時，系統會排除你對本組回答的排序。</small>
        </div>
        <strong className="ranking-progress-label">{selectedCount}／{order.length}</strong>
      </header>

      <div className="ranking-progress" aria-label={`已完成 ${selectedCount}／${order.length}`}>
        <span style={{ width: `${order.length ? (selectedCount / order.length) * 100 : 0}%` }} />
      </div>

      {selected.length > 0 && (
        <section className="selected-ranking" aria-label="目前排序">
          <div className="ranking-section-heading">
            <div><Check /><strong>目前排序</strong></div>
            <span>
              <button type="button" disabled={pending || selectedCount === 0} onClick={onUndo}><Undo2 />取消上一步</button>
              <button type="button" disabled={pending} onClick={onRestart}><RotateCcw />重新排序</button>
            </span>
          </div>
          <ol>
            {selected.map((groupId, index) => {
              const group = groups.find((item) => item.id === groupId);
              if (!group) return null;
              return (
                <li key={group.id}>
                  <strong className="selected-rank-number">第 {index + 1} 名</strong>
                  <div>
                    <small>{labels[group.id] ?? "匿名回答"}</small>
                    <p>{group.response.content}</p>
                  </div>
                  <span className="rank-controls">
                    <button type="button" aria-label={`將第 ${index + 1} 名上移`} disabled={index === 0} onClick={() => onMove(index, -1)}><ArrowUp /></button>
                    <button type="button" aria-label={`將第 ${index + 1} 名下移`} disabled={index === selectedCount - 1} onClick={() => onMove(index, 1)}><ArrowDown /></button>
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {!complete && (
        <section className="ranking-candidates" aria-label={`請選出第 ${selectedCount + 1} 名`}>
          <div className="ranking-section-heading">
            <div><strong>尚未排序的回答</strong></div>
            <small>點選一張回答卡片</small>
          </div>
          <div className="ranking-choice-list">
            {candidates.map((groupId) => {
              const group = groups.find((item) => item.id === groupId);
              if (!group) return null;
              return (
                <button type="button" key={group.id} className="ranking-choice" disabled={pending} onClick={() => onChoose(group.id)}>
                  <small>{labels[group.id] ?? "匿名回答"}</small>
                  <p>{group.response.content}</p>
                  <span>選為第 {selectedCount + 1} 名</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      <button className="button primary wide ranking-submit" disabled={pending || !complete} onClick={onSubmit}>
        <ClipboardCheck />
        {hasSubmittedRanking ? "更新完整排序" : "送出完整排序"}
      </button>
    </section>
  );
}
