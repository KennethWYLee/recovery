"use client";

import { CheckCircle2, Clock3, Download, RefreshCw, UserCheck, UsersRound } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClassroomParticipationReport, ClassroomSessionSnapshot } from "@/lib/classroom-domain";
import { classroomApiData } from "@/lib/classroom-api-client";
import { applyParticipationManagementSnapshot } from "@/lib/classroom-participation-state";
import { ParticipationRows } from "./ParticipationRows";

type Envelope = { data?: { report: ClassroomParticipationReport }; error?: { message?: string } };

export function StudentParticipationPanel({ sessionId }: { sessionId: string }) {
  const [report, setReport] = useState<ClassroomParticipationReport | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const requestRef = useRef(0);
  const changingRef = useRef(false);
  const [changing, setChanging] = useState(false);
  const [changeMessage, setChangeMessage] = useState<string | null>(null);
  const [changeError, setChangeError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (loadingRef.current || (quiet && changingRef.current)) return;
    const requestId = ++requestRef.current;
    loadingRef.current = true;
    if (!quiet) setPending(true);
    try {
      const response = await fetch(`/api/classroom/sessions/${encodeURIComponent(sessionId)}/participation`, {
        cache: "no-store",
        headers: { accept: "application/json" },
      });
      const payload = await response.json().catch(() => null) as Envelope | null;
      if (requestId !== requestRef.current) return;
      if (!response.ok || !payload?.data?.report) throw new Error(payload?.error?.message ?? "目前無法取得學生參與紀錄。");
      setReport(payload.data.report);
      setError(null);
    } catch (cause) {
      if (requestId === requestRef.current) setError(cause instanceof Error ? cause.message : "目前無法取得學生參與紀錄。");
    } finally {
      if (requestId === requestRef.current) { loadingRef.current = false; setPending(false); }
    }
  }, [sessionId]);

  async function manage(body: Record<string, string>, message: string) {
    if (changingRef.current) return;
    changingRef.current = true;
    requestRef.current += 1;
    loadingRef.current = false;
    setChanging(true); setChangeMessage(null); setChangeError(null);
    try {
      const data = await classroomApiData<{ snapshot: ClassroomSessionSnapshot }>(await fetch(`/api/classroom/sessions/${encodeURIComponent(sessionId)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      setReport((current) => current ? applyParticipationManagementSnapshot(current, data.snapshot) : current);
      setError(null);
      setChangeMessage(message);
    } catch (cause) {
      setChangeError(cause instanceof Error ? cause.message : "調整未完成，請稍後再試。");
      await load();
    } finally {
      changingRef.current = false;
      setChanging(false);
      setPending(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(true); };
    const timer = window.setInterval(refresh, 6_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);

  const students = useMemo(() => [...(report?.students ?? [])].sort((left, right) => {
    if (left.completionRate === null && right.completionRate !== null) return 1;
    if (left.completionRate !== null && right.completionRate === null) return -1;
    if (left.completionRate !== right.completionRate) return (left.completionRate ?? 1) - (right.completionRate ?? 1);
    return left.checkedInAt.localeCompare(right.checkedInAt);
  }), [report]);
  const lateCount = students.filter((student) => student.attendance === "late").length;
  const completedRankings = students.reduce((sum, student) => sum + student.completedRankingCount, 0);
  const rankingOpportunities = students.reduce((sum, student) => sum + student.rankingOpportunityCount, 0);
  const overallRate = rankingOpportunities ? completedRankings / rankingOpportunities : null;

  return (
    <section className="student-participation-panel" aria-labelledby="student-participation-title">
      <header>
        <div>
          <p>學生參與紀錄</p>
          <h2 id="student-participation-title">哪些學生參與較少？</h2>
          <span>完成率只計算學生到課後、且已進入排序階段的題目；遲到前未取得參與資格的題目不列入分母。</span>
          <span>小組回答由代表送出；個人排序須每位學生各自送出。本表每 6 秒自動更新。</span>
          <span>可在下表調整目前組別與發言人；發言人就是負責送出小組回答的代表。組別調整只影響作答中或之後的題目。</span>
        </div>
        <div>
          <a className="button secondary" href={`/api/classroom/sessions/${encodeURIComponent(sessionId)}/export`}>
            <Download />匯出
          </a>
          <button className="button secondary" type="button" disabled={pending || changing} onClick={() => void load()}>
            <RefreshCw />更新
          </button>
        </div>
      </header>
      {changeMessage && <div className="participation-change-message" role="status">{changeMessage}</div>}
      {changeError && <div className="participation-change-message error" role="alert">{changeError}</div>}

      {pending && !report ? <div className="participation-message"><span className="spinner" />正在整理參與紀錄…</div> : error ? (
        <div className="participation-message error" role="alert"><strong>{error}</strong><button className="button secondary" type="button" onClick={() => void load()}>重試</button></div>
      ) : report ? (
        <>
          <div className="participation-summary">
            <span><UsersRound /><small>本次到課</small><strong>{students.length} 人</strong></span>
            <span><Clock3 /><small>遲到加入</small><strong>{lateCount} 人</strong></span>
            <span><CheckCircle2 /><small>已完成排序</small><strong>{completedRankings} / {rankingOpportunities}</strong></span>
            <span><UserCheck /><small>到課後完成率</small><strong>{overallRate === null ? "尚無可計算題目" : `${Math.round(overallRate * 100)}%`}</strong></span>
          </div>
          <div className="participation-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>學生</th>
                  <th>報到</th>
                  <th>目前組別</th>
                  <th>目前發言人</th>
                  {report.questions.map((question) => <th key={question.id} title={question.text}>第 {question.position} 題</th>)}
                  <th>可參與題數</th>
                  <th>完成排序</th>
                  <th>完成率</th>
                </tr>
              </thead>
              <ParticipationRows report={report} students={students} pending={pending || changing} onManage={(body, message) => void manage(body, message)} />
            </table>
          </div>
          <footer>「本題開始後加入，未列入本題」表示學生已加入課堂，將從加入後的新題目開始參與。「已參與」表示學生在該題開始時已加入課堂；小組回答由指定代表送出，不能據此判定每位組員實際發言情形。</footer>
        </>
      ) : null}
    </section>
  );
}
