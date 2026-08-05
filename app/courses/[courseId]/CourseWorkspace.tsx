"use client";

import Link from "next/link";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BarChart3,
  CalendarPlus,
  Check,
  CheckCircle2,
  ClipboardCheck,
  Clock3,
  Copy,
  Download,
  GripVertical,
  History,
  LogOut,
  QrCode,
  RefreshCw,
  RotateCcw,
  Send,
  UserCheck,
  UsersRound,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  courseTermLabel,
  SESSION_PHASE_LABELS,
  SESSION_PHASE_ORDER,
  type ClassroomCourse,
  type ClassroomGroup,
  type ClassroomSessionSnapshot,
} from "@/lib/classroom-domain";
import type { ClassroomPageIdentity } from "../classroom-page-identity";

type Actor = { id: string; email: string; displayName: string; role: "teacher" | "student"; isAdmin: boolean };
type WorkspacePayload = { actor: Actor; course: ClassroomCourse; snapshot: ClassroomSessionSnapshot | null };
type Envelope<T> = { data?: T; error?: { code?: string; message?: string } };

async function apiData<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as Envelope<T> | null;
  if (!response.ok || body?.data === undefined) throw new Error(body?.error?.message ?? "目前無法處理課堂資料。");
  return body.data;
}

function groupName(group: ClassroomGroup, anonymous: boolean, groups: ClassroomGroup[]): string {
  return anonymous ? `回答 ${String.fromCharCode(65 + groups.findIndex((item) => item.id === group.id))}` : group.label;
}

function shuffle<T>(values: T[]): T[] {
  const result = [...values];
  const random = new Uint32Array(Math.max(1, result.length));
  crypto.getRandomValues(random);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = random[index] % (index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function PhaseTracker({ snapshot }: { snapshot: ClassroomSessionSnapshot }) {
  const current = SESSION_PHASE_ORDER.indexOf(snapshot.session.phase);
  return <ol className="phase-tracker" aria-label="課堂進度">
    {SESSION_PHASE_ORDER.slice(0, -1).map((phase, index) => <li key={phase} className={index < current ? "done" : index === current ? "current" : ""}><span>{index < current ? <Check /> : index + 1}</span><strong>{SESSION_PHASE_LABELS[phase]}</strong></li>)}
  </ol>;
}

function EmptySession({ course, onCreated }: { course: ClassroomCourse; onCreated: () => void }) {
  const date = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric" }).format(new Date());
  const [title, setTitle] = useState(`${date} 課堂活動`);
  const [question, setQuestion] = useState("");
  const [criteria, setCriteria] = useState("請依回答的正確性、解釋力及理由充分程度，將所有回答從最佳到相對較弱排列。");
  const [capacity, setCapacity] = useState(course.defaultGroupCapacity);
  const [anonymous, setAnonymous] = useState(true);
  const [editable, setEditable] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setPending(true); setError(null);
    try {
      await apiData(await fetch(`/api/classroom/courses/${encodeURIComponent(course.id)}/session`, {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ title, question, rankingCriteria: criteria, groupCapacity: capacity, anonymousGroups: anonymous, allowRankingEdits: editable }),
      }));
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "目前無法建立課堂。");
    } finally { setPending(false); }
  }

  return <section className="session-create-layout">
    <article className="session-create-card"><header><span><CalendarPlus /></span><div><p>開啟今天的課堂</p><h2>建立一個完整的作答與排序活動</h2></div></header>
      <label className="course-field"><span>課堂名稱</span><input value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="course-field"><span>本次問題</span><textarea value={question} maxLength={2000} rows={5} placeholder="讓每組需要討論、判斷並說明理由的問題" onChange={(event) => setQuestion(event.target.value)} /></label>
      <label className="course-field"><span>排序判準</span><textarea value={criteria} maxLength={500} rows={3} onChange={(event) => setCriteria(event.target.value)} /></label>
      <div className="session-setting-grid"><label className="course-field"><span>每組人數上限</span><input type="number" min={2} max={20} value={capacity} onChange={(event) => setCapacity(Number(event.target.value))} /></label><label className="check-field"><input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} /><span><strong>排序時隱藏組別</strong><small>只顯示回答 A、B、C</small></span></label><label className="check-field"><input type="checkbox" checked={editable} onChange={(event) => setEditable(event.target.checked)} /><span><strong>截止前可修改排序</strong><small>保留每次送出版本</small></span></label></div>
      {error && <div className="course-form-error" role="alert">{error}</div>}
      <footer><span>建立後即會產生 QR Code，但不會自動分組。</span><button className="button primary" disabled={pending} type="button" onClick={() => void create()}>{pending ? "正在建立…" : "建立今日課堂"}<ArrowRight /></button></footer>
    </article>
    <aside className="session-guidance"><h2>開課後的流程</h2><ol><li><span>1</span><div><strong>學生掃碼報到</strong><small>系統管理員先核准新帳號。</small></div></li><li><span>2</span><div><strong>系統平均分組</strong><small>教師可拖曳調整並指定代表。</small></div></li><li><span>3</span><div><strong>小組回答、全班排序</strong><small>關閉階段後才計算結果。</small></div></li></ol></aside>
  </section>;
}

export function CourseWorkspace({ courseId, identity }: { courseId: string; identity: ClassroomPageIdentity }) {
  const [payload, setPayload] = useState<WorkspacePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [dragParticipant, setDragParticipant] = useState<string | null>(null);
  const [dragRank, setDragRank] = useState<string | null>(null);
  const [responseText, setResponseText] = useState("");
  const [rankingOrder, setRankingOrder] = useState<string[]>([]);
  const responseVersionRef = useRef("");
  const rankingKeyRef = useRef("");

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setError(null);
    try {
      const data = await apiData<WorkspacePayload>(await fetch(`/api/classroom/courses/${encodeURIComponent(courseId)}/session`, { cache: "no-store", headers: { accept: "application/json" } }));
      const currentGroup = data.snapshot?.groups.find((group) => group.id === data.snapshot?.currentUser.groupId);
      const responseKey = currentGroup ? `${currentGroup.id}:${currentGroup.response.version}` : "";
      if (responseKey && responseKey !== responseVersionRef.current) {
        responseVersionRef.current = responseKey;
        setResponseText(currentGroup?.response.content ?? "");
      }
      if (data.snapshot?.session.phase === "ranking" && !data.actor.isAdmin) {
        const eligible = data.snapshot.groups.filter((group) => group.id !== data.snapshot?.currentUser.groupId).map((group) => group.id);
        const rankingKey = `${data.snapshot.session.id}:${eligible.join(",")}`;
        if (rankingKey !== rankingKeyRef.current) {
          rankingKeyRef.current = rankingKey;
          setRankingOrder(shuffle(eligible));
        }
      }
      setPayload(data);
    } catch (cause) {
      if (!quiet) setError(cause instanceof Error ? cause.message : "目前無法取得課堂資料。");
    }
  }, [courseId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { if (!pending) void load(true); }, 5000);
    return () => window.clearInterval(timer);
  }, [load, pending]);

  const snapshot = payload?.snapshot ?? null;
  const myGroup = useMemo(() => snapshot?.groups.find((group) => group.id === snapshot.currentUser.groupId) ?? null, [snapshot]);

  async function mutate(body: Record<string, unknown>) {
    if (!snapshot) return;
    setPending(true); setError(null); setNotice(null);
    try {
      const data = await apiData<{ snapshot: ClassroomSessionSnapshot }>(await fetch(`/api/classroom/sessions/${encodeURIComponent(snapshot.session.id)}`, {
        method: "PATCH", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body),
      }));
      setPayload((current) => current ? { ...current, snapshot: data.snapshot } : current);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失敗。"); }
    finally { setPending(false); }
  }

  async function saveResponse(submit: boolean) {
    if (!snapshot || !myGroup) return;
    setPending(true); setError(null);
    try {
      const data = await apiData<{ snapshot: ClassroomSessionSnapshot }>(await fetch(`/api/classroom/sessions/${encodeURIComponent(snapshot.session.id)}/response`, {
        method: "PUT", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ content: responseText, expectedVersion: myGroup.response.version, submit }),
      }));
      setPayload((current) => current ? { ...current, snapshot: data.snapshot } : current);
      setNotice(submit ? "小組回答已送出。" : "草稿已儲存。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "回答儲存失敗。"); }
    finally { setPending(false); }
  }

  async function submitRanking() {
    if (!snapshot) return;
    setPending(true); setError(null);
    try {
      const data = await apiData<{ snapshot: ClassroomSessionSnapshot }>(await fetch(`/api/classroom/sessions/${encodeURIComponent(snapshot.session.id)}/ranking`, {
        method: "PUT", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ orderedGroupIds: rankingOrder }),
      }));
      setPayload((current) => current ? { ...current, snapshot: data.snapshot } : current);
      setNotice("完整排序已送出。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "排序送出失敗。"); }
    finally { setPending(false); }
  }

  function moveRank(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= rankingOrder.length) return;
    setRankingOrder((current) => { const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  }

  function dropRank(targetIndex: number) {
    if (!dragRank) return;
    setRankingOrder((current) => {
      const sourceIndex = current.indexOf(dragRank);
      if (sourceIndex < 0 || sourceIndex === targetIndex) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    setDragRank(null);
  }

  const joinUrl = snapshot && typeof window !== "undefined" ? `${window.location.origin}/join/${snapshot.session.joinCode}` : "";

  return <div className="course-shell">
    <header className="course-topbar"><Link href="/courses" className="course-brand"><span aria-hidden="true">課</span><strong>課堂小組回應與排序</strong></Link><div className="course-account"><span><strong>{payload?.actor.displayName ?? identity.displayName}</strong><small>{payload?.actor.isAdmin ? "系統管理員" : "學生"}</small></span><a href={identity.signOutPath}><LogOut />登出</a></div></header>
    <main className="course-workspace-main">
      <Link className="course-back" href="/courses"><ArrowLeft />所有課程</Link>
      {error && !payload ? <div className="courses-error" role="alert"><strong>無法開啟課程</strong><span>{error}</span><button className="button secondary" onClick={() => void load()}>重新載入</button></div> : !payload ? <div className="courses-loading" role="status"><span className="spinner" />正在開啟課程…</div> : <>
        <section className="course-workspace-heading"><div><p>{courseTermLabel(payload.course)}</p><h1>{payload.course.name}</h1><span>{snapshot ? snapshot.session.title : "選擇今天的問題，開始一次可完整追蹤的課堂活動。"}</span></div>{snapshot && <button className="button secondary" type="button" onClick={() => void load()}><RefreshCw />更新</button>}</section>
        {error && <div className="workspace-alert error" role="alert">{error}</div>}{notice && <div className="workspace-alert success" role="status">{notice}</div>}
        {!snapshot ? payload.actor.isAdmin ? <EmptySession course={payload.course} onCreated={() => void load()} /> : <div className="courses-empty"><QrCode /><h2>今天尚未開放課堂</h2><p>請掃描教師投影畫面上的 QR Code 加入。</p></div> : <>
          <PhaseTracker snapshot={snapshot} />
          <section className="live-session-header"><div><small>本次問題</small><h2>{snapshot.session.question}</h2><p>{snapshot.session.rankingCriteria}</p></div><dl><div><dt>已報到</dt><dd>{snapshot.completion.checkedIn}</dd></div><div><dt>已分組</dt><dd>{snapshot.completion.grouped}</dd></div><div><dt>目前階段</dt><dd>{SESSION_PHASE_LABELS[snapshot.session.phase]}</dd></div></dl></section>

          {snapshot.session.phase === "check_in" && <section className="checkin-layout"><article className="qr-panel"><span className="qr-frame">{joinUrl && <QRCodeSVG value={joinUrl} size={220} level="M" marginSize={2} />}</span><p>課堂代碼</p><strong>{snapshot.session.joinCode}</strong><button className="button secondary" type="button" onClick={() => { void navigator.clipboard.writeText(joinUrl); setNotice("加入網址已複製。"); }}><Copy />複製加入網址</button></article><article className="attendance-panel"><header><div><p>即時報到</p><h2>{snapshot.completion.checkedIn} 位學生已加入</h2></div><span className="live-pill"><i />即時更新</span></header>{snapshot.participants.length ? <ul>{snapshot.participants.map((participant) => <li key={participant.id}><span>{participant.displayName.slice(0, 1)}</span><div><strong>{participant.displayName}</strong><small>{participant.email}</small></div><CheckCircle2 /></li>)}</ul> : <div className="panel-empty"><UsersRound /><strong>等待學生掃碼</strong><span>報到後會立即顯示在這裡。</span></div>}{payload.actor.isAdmin && <footer><span>開始分組後，遲到學生會自動補入人數最少的現有小組。</span><button className="button primary" type="button" disabled={pending || snapshot.completion.checkedIn < 2} onClick={() => void mutate({ action: "advance", expectedVersion: snapshot.session.version })}>平均分組<ArrowRight /></button></footer>}</article></section>}

          {snapshot.session.phase === "grouping" && <section><div className="section-intro"><div><p>確認分組</p><h2>拖曳學生卡片調整組別</h2><span>系統先依人數上限平均分配；教師可在開始作答前修正。</span></div><strong>現有 {snapshot.groups.length} 組 · 每組目前上限 {snapshot.session.effectiveGroupCapacity} 人</strong></div><div className="group-board">{snapshot.groups.map((group) => <article className="group-column" key={group.id} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (dragParticipant) void mutate({ action: "move_participant", participantId: dragParticipant, groupId: group.id }); setDragParticipant(null); }}><header><div><span>{group.position}</span><h3>{group.label}</h3></div><strong>{group.members.length} 人</strong></header><div>{group.members.map((member) => <div className="participant-card" key={member.id} draggable={payload.actor.isAdmin} onDragStart={() => setDragParticipant(member.id)} onDragEnd={() => setDragParticipant(null)}><GripVertical /><span><strong>{member.displayName}</strong><small>{member.attendance === "late" ? "遲到加入" : member.email}</small></span>{member.userId === group.representativeUserId && <em>代表</em>}{payload.actor.isAdmin && <select aria-label={`調整 ${member.displayName} 的組別`} value={group.id} onChange={(event) => void mutate({ action: "move_participant", participantId: member.id, groupId: event.target.value })}>{snapshot.groups.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select>}</div>)}</div>{payload.actor.isAdmin && <label><span>作答代表</span><select value={group.representativeUserId ?? ""} onChange={(event) => void mutate({ action: "set_representative", groupId: group.id, userId: event.target.value })}>{group.members.map((member) => <option value={member.userId} key={member.id}>{member.displayName}</option>)}</select></label>}</article>)}</div>{payload.actor.isAdmin && <div className="session-action-bar"><span>作答開始後將鎖定分組，每組只有指定代表可編輯。</span><button className="button primary" disabled={pending} type="button" onClick={() => void mutate({ action: "advance", expectedVersion: snapshot.session.version })}>開始小組作答<ArrowRight /></button></div>}</section>}

          {snapshot.session.phase === "answering" && <section className="response-layout"><article className="response-workspace"><header><div><p>{myGroup?.label ?? "小組作答"}</p><h2>{snapshot.currentUser.isRepresentative ? "您是本組指定代表" : "與組員討論後，由指定代表輸入"}</h2></div>{myGroup && <span className={`response-status ${myGroup.response.status}`}>{myGroup.response.status === "submitted" ? "已送出" : "草稿"}</span>}</header>{myGroup ? <>{snapshot.currentUser.isRepresentative ? <textarea rows={12} maxLength={4000} value={responseText} onChange={(event) => setResponseText(event.target.value)} placeholder="整理小組共同回答與理由…" /> : <div className="response-readonly">{myGroup.response.content || "代表尚未輸入回答。"}</div>}{snapshot.currentUser.isRepresentative && <footer><span>{responseText.length} / 4000</span><div><button className="button secondary" disabled={pending} onClick={() => void saveResponse(false)}>儲存草稿</button><button className="button primary" disabled={pending || responseText.trim().length < 2} onClick={() => void saveResponse(true)}><Send />送出小組回答</button></div></footer>}</> : <div className="panel-empty"><Clock3 /><strong>尚未完成分組</strong><span>請請教師確認您的組別。</span></div>}</article><aside className="submission-progress"><h2>小組送出進度</h2><strong>{snapshot.completion.submittedGroups}<small> / {snapshot.groups.length}</small></strong><div className="progress-track"><span style={{ width: `${snapshot.groups.length ? snapshot.completion.submittedGroups / snapshot.groups.length * 100 : 0}%` }} /></div><ul>{snapshot.groups.map((group) => <li key={group.id}><span>{group.label}</span>{["submitted", "locked"].includes(group.response.status) ? <CheckCircle2 /> : <Clock3 />}</li>)}</ul>{payload.actor.isAdmin && <button className="button primary wide" disabled={pending || snapshot.completion.submittedGroups !== snapshot.groups.length} onClick={() => void mutate({ action: "advance", expectedVersion: snapshot.session.version })}>鎖定回答並開始展示</button>}</aside></section>}

          {snapshot.session.phase === "presenting" && <section><div className="section-intro"><div><p>教師展示</p><h2>依序介紹每組回答</h2><span>本階段不顯示個人資料；全部介紹完畢後再開放排序。</span></div></div><div className="presentation-grid">{snapshot.groups.map((group) => <article key={group.id}><header><span>{group.position}</span><h3>{group.label}</h3></header><p>{group.response.content}</p></article>)}</div>{payload.actor.isAdmin && <div className="session-action-bar"><button className="button secondary" disabled={pending} onClick={() => void mutate({ action: "rollback", expectedVersion: snapshot.session.version })}><RotateCcw />回到作答</button><button className="button primary" disabled={pending} onClick={() => void mutate({ action: "advance", expectedVersion: snapshot.session.version })}>開放個人排序<ArrowRight /></button></div>}</section>}

          {snapshot.session.phase === "ranking" && <section className="ranking-layout"><article className="ranking-workspace"><header><div><p>個人完整排序</p><h2>{payload.actor.isAdmin ? "等待學生完成排序" : "拖曳所有其他組回答，排出完整先後"}</h2></div><span>{snapshot.completion.rankedStudents} / {snapshot.completion.eligibleStudents}</span></header>{payload.actor.isAdmin ? <div className="ranking-monitor"><BarChart3 /><strong>{snapshot.completion.rankedStudents} 位已送出</strong><span>只有教師可查看個人原始排序；投影畫面只顯示整體進度。</span></div> : <><p className="ranking-criteria">{snapshot.session.rankingCriteria}</p><ol className="ranking-list">{rankingOrder.map((groupId, index) => { const group = snapshot.groups.find((item) => item.id === groupId); if (!group) return null; return <li key={group.id} draggable onDragStart={() => setDragRank(group.id)} onDragEnd={() => setDragRank(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropRank(index)}><span className="rank-number">{index + 1}</span><GripVertical /><div><strong>{groupName(group, snapshot.session.anonymousGroups, snapshot.groups)}</strong><p>{group.response.content}</p></div><span className="rank-controls"><button aria-label="上移" disabled={index === 0} onClick={() => moveRank(index, -1)}><ArrowUp /></button><button aria-label="下移" disabled={index === rankingOrder.length - 1} onClick={() => moveRank(index, 1)}><ArrowDown /></button></span></li>; })}</ol><button className="button primary wide" disabled={pending || rankingOrder.length !== snapshot.groups.length - (snapshot.currentUser.groupId ? 1 : 0)} onClick={() => void submitRanking()}><ClipboardCheck />{snapshot.currentUser.hasSubmittedRanking ? "更新完整排序" : "送出完整排序"}</button></>}</article>{payload.actor.isAdmin && <aside className="submission-progress"><h2>排序完成率</h2><strong>{snapshot.completion.rankedStudents}<small> / {snapshot.completion.eligibleStudents}</small></strong><div className="progress-track"><span style={{ width: `${snapshot.completion.eligibleStudents ? snapshot.completion.rankedStudents / snapshot.completion.eligibleStudents * 100 : 0}%` }} /></div><p>關閉後不再接受排序，系統會排除每位學生的自己組再計算平均名次。</p><button className="button primary wide" disabled={pending || snapshot.completion.rankedStudents === 0} onClick={() => void mutate({ action: "advance", expectedVersion: snapshot.session.version })}>關閉排序並計算結果</button></aside>}</section>}

          {snapshot.session.phase === "results" && <section className="results-layout"><article className="results-table"><header><div><p>全班排序結果</p><h2>平均名次越小，整體排名越高</h2></div><span>{snapshot.completion.rankedStudents} 份有效排序</span></header><ol>{snapshot.results.map((result) => <li key={result.groupId}><strong className="final-rank">{result.tied ? `並列 ${result.finalRank}` : result.finalRank}</strong><span><b>{result.label}</b><small>{result.ratingCount} 份有效名次</small></span><em>{result.averageRank.toFixed(2)}</em><div className="result-bar"><i style={{ width: `${Math.max(8, 100 - (result.averageRank - 1) / Math.max(1, snapshot.groups.length - 1) * 92)}%` }} /></div></li>)}</ol></article><article className="rank-distribution"><header><p>各名次次數分布</p><h2>不只看平均值</h2></header><div className="chart-wrap"><ResponsiveContainer width="100%" height="100%"><BarChart data={snapshot.results.map((result) => ({ name: result.label, 第一名: result.rankCounts[0] ?? 0, 第二名: result.rankCounts[1] ?? 0, 其他: result.rankCounts.slice(2).reduce((sum, count) => sum + count, 0) }))}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="name" /><YAxis allowDecimals={false} /><Tooltip /><Bar dataKey="第一名" stackId="a" fill="#256f68" /><Bar dataKey="第二名" stackId="a" fill="#b7791f" /><Bar dataKey="其他" stackId="a" fill="#aeb8b4" /></BarChart></ResponsiveContainer></div></article>{payload.actor.isAdmin && <details className="raw-ranking-panel"><summary>查看 {snapshot.rawRankings.length} 位學生的原始完整排序</summary><div><table><thead><tr><th>學生</th><th>帳號</th><th>完整排序</th><th>送出時間</th></tr></thead><tbody>{snapshot.rawRankings.map((ranking) => <tr key={ranking.userId}><td>{ranking.displayName}</td><td>{ranking.email}</td><td>{ranking.orderedGroupIds.map((groupId) => snapshot.groups.find((group) => group.id === groupId)?.label ?? groupId).join(" → ")}</td><td>{new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ranking.submittedAt))}</td></tr>)}</tbody></table></div></details>}{payload.actor.isAdmin && <div className="session-action-bar full"><a className="button secondary" href={`/api/classroom/sessions/${encodeURIComponent(snapshot.session.id)}/export`}><Download />匯出 CSV</a><button className="button secondary" disabled={pending} onClick={() => void mutate({ action: "rollback", expectedVersion: snapshot.session.version })}><RotateCcw />回到排序</button><button className="button primary" disabled={pending} onClick={() => void mutate({ action: "advance", expectedVersion: snapshot.session.version })}><History />封存本次課堂</button></div>}</section>}
        </>}
        <aside className="course-summary-strip"><span><UsersRound /><strong>{payload.course.studentCount}</strong>位課程學生</span><span><History /><strong>{payload.course.sessionCount}</strong>次課堂紀錄</span><span><UserCheck /><strong>{payload.course.defaultGroupCapacity}</strong>人預設上限</span></aside>
      </>}
    </main>
  </div>;
}
