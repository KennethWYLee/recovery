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

export function TeacherRankingEntry({ snapshot }: { snapshot: ClassroomSessionSnapshot }) {
  const phase = snapshot.question?.phase;
  const editable = phase === "ranking" && snapshot.currentUser.canRank;
  const description = phase === "ranking"
    ? editable ? snapshot.currentUser.hasSubmittedRanking ? "已送出，結束排序前仍可修改。" : "尚未送出，請完成教師排序後再結束排序。" : "請由建立本題的教師完成排序。"
    : phase === "locked" ? "排序已截止；如需修改，請按下方「重新開放排序」。"
    : ["published", "archived"].includes(phase ?? "") ? "已截止，教師排序列在下方結果中。"
    : "各組作答結束並完成答案展示後，按「開放個人排序」，即可進行教師排序。";
  return <aside className="teacher-ranking-entry" aria-label="教師排序入口">
    <div><strong>教師排序</strong><p>{description}</p></div>
    {editable && <a className="button primary" href="#teacher-ranking-workspace">{snapshot.currentUser.hasSubmittedRanking ? "查看／修改教師排序" : "進行教師排序"}</a>}
  </aside>;
}

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
      <section id="teacher-ranking-workspace" tabIndex={-1} className="ranking-workspace teacher-ranking-workspace">
        <header>
          <div><p>教師排序</p><h2>按「上移／下移」調整名次，最上方為第 1 名</h2></div>
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
                  <button type="button" aria-label="上移" disabled={index === 0} onClick={() => onMove(index, -1)}><ArrowUp />上移</button>
                  <button type="button" aria-label="下移" disabled={index === order.length - 1} onClick={() => onMove(index, 1)}><ArrowDown />下移</button>
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
