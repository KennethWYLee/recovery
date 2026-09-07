"use client";

import type { ClassroomParticipationReport, ClassroomQuestionPhase, ClassroomStudentParticipation } from "@/lib/classroom-domain";

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function participationLabel(eligible: boolean, completed: boolean, phase: ClassroomQuestionPhase) {
  if (!eligible) return { label: "本題開始後加入，未列入本題", kind: "not-eligible" };
  if (completed) return { label: "個人排序：已送出", kind: "completed" };
  if (["answering", "presenting"].includes(phase)) return { label: "已參與", kind: "participating" };
  if (phase === "ranking") return { label: "個人排序：尚未送出", kind: "pending" };
  return { label: "個人排序：未收到（已截止）", kind: "missing" };
}

export function ParticipationRows({ report, students, pending, onManage }: {
  report: ClassroomParticipationReport; students: ClassroomStudentParticipation[]; pending: boolean;
  onManage: (body: Record<string, string>, message: string) => void;
}) {
  const editable = ["grouping", "answering"].includes(report.sessionPhase);
  return <tbody>{students.map((student) => {
    const group = report.groups.find((item) => item.id === student.groupId);
    const isRepresentative = group?.representativeUserId === student.userId;
    return <tr key={student.userId} className={student.completionRate !== null && student.completionRate < 1 ? "needs-attention" : ""}>
      <td><strong>{student.displayName}</strong><small>{student.email}</small></td>
      <td><strong>{timeLabel(student.checkedInAt)}</strong><small>{student.attendance === "late" ? "遲到加入" : "準時加入"}</small></td>
      <td>
        <select className="participation-group-select" aria-label={`調整 ${student.displayName} 的組別`} value={student.groupId ?? ""} disabled={pending || !editable || report.groups.length === 0}
          onChange={(event) => onManage({ action: "move_participant", participantId: student.participantId, groupId: event.target.value }, `${student.displayName} 的組別已更新。`)}>
          {!group && <option value="" disabled>尚未分組</option>}
          {report.groups.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      </td>
      <td>
        {isRepresentative ? <strong className="participation-speaker">發言人</strong> : group ? <button type="button" className="button secondary participation-speaker-button" disabled={pending || !editable}
          aria-label={`將 ${student.displayName} 設為 ${group.label} 發言人`}
          onClick={() => onManage({ action: "set_representative", groupId: group.id, userId: student.userId }, `${group.label} 的發言人已改為 ${student.displayName}。`)}>設為發言人</button> : <span>尚未分組</span>}
        {group && !group.representativeUserId && <small>本組尚未指定發言人</small>}
      </td>
      {report.questions.map((question) => {
        const state = student.questions.find((item) => item.questionId === question.id);
        const status = participationLabel(Boolean(state?.eligible), Boolean(state?.rankingCompleted), question.phase);
        return <td key={question.id}>
          <span className={`participation-status ${status.kind}`}>{status.label}</span>
          {state?.representativeSubmitted && <small>小組回答：已由此代表送出</small>}
        </td>;
      })}
      <td>{student.eligibleQuestionCount} / {report.questions.length}</td>
      <td>{student.completedRankingCount} / {student.rankingOpportunityCount}</td>
      <td><strong>{student.completionRate === null ? "—" : `${Math.round(student.completionRate * 100)}%`}</strong></td>
    </tr>;
  })}</tbody>;
}
