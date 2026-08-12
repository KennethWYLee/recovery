"use client";

import { ArrowDown, ArrowUp, BarChart3, ClipboardCheck, GripVertical } from "lucide-react";
import type { ClassroomSessionSnapshot } from "@/lib/classroom-domain";

type Props = {
  snapshot: ClassroomSessionSnapshot;
  order: string[];
  dragging: string | null;
  pending: boolean;
  onDrag: (groupId: string | null) => void;
  onMove: (index: number, offset: number) => void;
  onDrop: (index: number) => void;
  onSubmit: () => void;
};

export function TeacherRankingPanel({ snapshot, order, dragging, pending, onDrag, onMove, onDrop, onSubmit }: Props) {
  const groups = snapshot.groups.filter((group) => ["submitted", "locked"].includes(group.response.status) && group.response.content.trim());
  return (
    <div className="teacher-ranking-layout">
      <section className="ranking-monitor compact">
        <BarChart3 />
        <strong>{snapshot.completion.rankedStudents} / {snapshot.completion.eligibleStudents} 位學生已完成</strong>
        <span>請教師也完成一份排序。教師排序不納入全班分數，結果公布後才會與全班共識並列顯示。</span>
        <div className="progress-track"><span style={{ width: `${snapshot.completion.eligibleStudents ? (snapshot.completion.rankedStudents / snapshot.completion.eligibleStudents) * 100 : 0}%` }} /></div>
      </section>
      <section className="ranking-workspace teacher-ranking-workspace">
        <header>
          <div><p>教師排序</p><h2>依回答內容拖曳；越上方排名越高</h2></div>
          <span>{groups.length} 份回答</span>
        </header>
        <ol className="ranking-list">
          {order.map((groupId, index) => {
            const group = groups.find((item) => item.id === groupId);
            if (!group) return null;
            return (
              <li key={group.id} draggable onDragStart={() => onDrag(group.id)} onDragEnd={() => onDrag(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => onDrop(index)} className={dragging === group.id ? "dragging" : ""}>
                <span className="rank-number">{index + 1}<small>名</small></span>
                <GripVertical />
                <div className="ranking-answer"><p>{group.response.content}</p><small>{group.label}</small></div>
                <span className="rank-controls">
                  <button type="button" aria-label="上移" disabled={index === 0} onClick={() => onMove(index, -1)}><ArrowUp /></button>
                  <button type="button" aria-label="下移" disabled={index === order.length - 1} onClick={() => onMove(index, 1)}><ArrowDown /></button>
                </span>
              </li>
            );
          })}
        </ol>
        <button type="button" className="button primary wide" disabled={pending || order.length !== groups.length} onClick={onSubmit}>
          <ClipboardCheck />{snapshot.currentUser.hasSubmittedRanking ? "更新教師排序" : "送出教師排序"}
        </button>
      </section>
    </div>
  );
}
