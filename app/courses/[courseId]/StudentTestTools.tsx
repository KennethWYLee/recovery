"use client";

import { RotateCcw, UserRoundSearch, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ClassroomSessionSnapshot } from "@/lib/classroom-domain";
import { demoTestParticipants } from "@/lib/classroom-workspace-state";

export function StudentTestPicker({ snapshot, currentUserId, pending, onSelect, onReset, onClose }: {
  snapshot: ClassroomSessionSnapshot;
  currentUserId: string | null;
  pending: boolean;
  onSelect: (userId: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const participants = demoTestParticipants(snapshot.participants);
  return (
    <section className="student-test-picker" role="dialog" aria-label="選擇虛擬學生">
      <header>
        <div>
          <UserRoundSearch />
          <span>
            <strong>選擇學生情境</strong>
            <small>進入後會使用該虛擬學生的實際作答與排序權限。</small>
          </span>
        </div>
        <button type="button" aria-label="關閉學生測試選擇" disabled={pending} onClick={onClose}>
          <X />
        </button>
      </header>
      <div className="student-test-grid">
        {participants.map((participant) => {
          const group = snapshot.groups.find((item) => item.id === participant.groupId);
          const representative = group?.representativeUserId === participant.userId;
          return (
            <button type="button" disabled={pending} className={participant.userId === currentUserId ? "selected" : ""} key={participant.id} onClick={() => onSelect(participant.userId)}>
              <span>{participant.displayName.slice(-2)}</span>
              <div>
                <strong>{participant.displayName}</strong>
                <small>
                  {group?.label ?? "尚未分組"} · {representative ? "指定代表" : "一般組員"}
                  {participant.attendance === "late" ? " · 遲到加入" : ""}
                </small>
              </div>
              {participant.userId === currentUserId && <em>目前</em>}
            </button>
          );
        })}
      </div>
      <footer>
        <span>重設只影響示範課程的第三題，不會處理正式課程資料。</span>
        <button type="button" className="button secondary" disabled={pending} onClick={onReset}>
          <RotateCcw />
          重設示範資料
        </button>
      </footer>
    </section>
  );
}

export function StudentTestResetDialog({ open, pending, onClose, onConfirm }: {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  return (
    <dialog ref={ref} className="course-dialog" onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }}>
      <form method="dialog" onSubmit={(event) => event.preventDefault()}>
        <header>
          <div>
            <h2>重設示範課程第三題？</h2>
            <p>第三題會回到小組作答階段，虛擬學生的回答與排序會恢復為原始示範資料。</p>
          </div>
          <button type="button" className="course-icon-button" aria-label="關閉" disabled={pending} onClick={onClose}><X /></button>
        </header>
        <footer>
          <button type="button" className="button secondary" disabled={pending} onClick={onClose}>取消</button>
          <button type="button" className="button danger" disabled={pending} onClick={onConfirm}>{pending ? "正在重設…" : "確認重設"}</button>
        </footer>
      </form>
    </dialog>
  );
}
