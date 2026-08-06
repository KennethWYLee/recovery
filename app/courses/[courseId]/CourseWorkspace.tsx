"use client";

import Link from "next/link";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BarChart3, CheckCircle2, ClipboardCheck,
  Clock3, Copy, Download, Eye, GripVertical, Hash, History, LockKeyhole, LogOut,
  LibraryBig, Plus, RefreshCw, RotateCcw, Send, Settings2, UserCheck, UserRoundSearch, UsersRound, X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  courseTermLabel, QUESTION_PHASE_LABELS,
  type ClassroomCourse, type ClassroomGroup, type ClassroomQuestionBankItem, type ClassroomSessionSnapshot,
} from "@/lib/classroom-domain";
import type { ClassroomPageIdentity } from "../classroom-page-identity";

type Actor = { id: string; email: string; displayName: string; role: "teacher" | "student"; isAdmin: boolean };
type WorkspacePayload = { actor: Actor; viewer: Actor; testMode: boolean; course: ClassroomCourse; snapshot: ClassroomSessionSnapshot | null };
type Envelope<T> = { data?: T; error?: { message?: string } };

async function apiData<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as Envelope<T> | null;
  if (!response.ok || body?.data === undefined) throw new Error(body?.error?.message ?? "目前無法處理課堂資料。");
  return body.data;
}

function shuffle<T>(values: T[]): T[] {
  const next = [...values];
  const random = new Uint32Array(Math.max(1, next.length));
  crypto.getRandomValues(random);
  for (let index = next.length - 1; index > 0; index -= 1) {
    const target = random[index] % (index + 1);
    [next[index], next[target]] = [next[target], next[index]];
  }
  return next;
}

function displayGroup(group: ClassroomGroup, anonymous: boolean, groups: ClassroomGroup[]) {
  return anonymous ? `回答 ${String.fromCharCode(65 + groups.findIndex((item) => item.id === group.id))}` : group.label;
}

function EmptySession({ course, onCreated }: { course: ClassroomCourse; onCreated: () => void }) {
  const date = new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "numeric", day: "numeric" }).format(new Date());
  const [title, setTitle] = useState(`${date} 課堂`);
  const [groupCount, setGroupCount] = useState(course.defaultGroupCount);
  const [anonymous, setAnonymous] = useState(true);
  const [editable, setEditable] = useState(true);
  const [qrEnabled, setQrEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setPending(true); setError(null);
    try {
      await apiData(await fetch(`/api/classroom/courses/${encodeURIComponent(course.id)}/session`, {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ title, groupCount, anonymousGroups: anonymous, allowRankingEdits: editable, qrEnabled }),
      }));
      onCreated();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "目前無法建立課堂。"); }
    finally { setPending(false); }
  }

  return <section className="session-create-layout">
    <article className="session-create-card"><header><span><Hash /></span><div><p>建立本次課堂</p><h2>先確認分組與加入方式</h2></div></header>
      <label className="course-field"><span>課堂名稱</span><input value={title} maxLength={100} onChange={(event) => setTitle(event.target.value)} /></label>
      <div className="session-setting-grid"><label className="course-field"><span>指定組數</span><input type="number" min={2} max={20} value={groupCount} onChange={(event) => setGroupCount(Number(event.target.value))} /><small>學生到齊後一次隨機平均分組。</small></label><label className="check-field"><input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} /><span><strong>排序時隱藏組別</strong><small>顯示回答 A、B、C</small></span></label><label className="check-field"><input type="checkbox" checked={editable} onChange={(event) => setEditable(event.target.checked)} /><span><strong>截止前可修改排序</strong><small>每次送出都保留版本</small></span></label><label className="check-field"><input type="checkbox" checked={qrEnabled} onChange={(event) => setQrEnabled(event.target.checked)} /><span><strong>同時顯示 QR Code</strong><small>課堂代碼仍是主要方式</small></span></label></div>
      {error && <div className="course-form-error" role="alert">{error}</div>}
      <footer><span>建立後先讓學生輸入課堂代碼；問題可在課堂進行中隨時新增。</span><button className="button primary" disabled={pending || title.trim().length < 2} type="button" onClick={() => void create()}>{pending ? "正在建立…" : "建立並開放報到"}<ArrowRight /></button></footer>
    </article>
    <aside className="session-guidance"><h2>本次課堂流程</h2><ol><li><span>1</span><div><strong>輸入代碼並等待</strong><small>教師確認到齊後統一分組。</small></div></li><li><span>2</span><div><strong>確認小組與代表</strong><small>遲到學生之後自動加入人數最少的組。</small></div></li><li><span>3</span><div><strong>連續新增多個問題</strong><small>每題各自作答、展示、排序及公布。</small></div></li></ol></aside>
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
  const [questionPrompt, setQuestionPrompt] = useState("");
  const [questionCriteria, setQuestionCriteria] = useState("請依回答的正確性、解釋力及理由充分程度，將所有回答從最佳到相對較弱排列。");
  const [questionBankItems, setQuestionBankItems] = useState<ClassroomQuestionBankItem[]>([]);
  const [selectedQuestionBankId, setSelectedQuestionBankId] = useState("");
  const [questionBankSearch, setQuestionBankSearch] = useState("");
  const [questionBankCategory, setQuestionBankCategory] = useState("all");
  const [questionBankUsage, setQuestionBankUsage] = useState("unused");
  const [questionBankSort, setQuestionBankSort] = useState("updated");
  const [showQuestionForm, setShowQuestionForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showStudentTestPicker, setShowStudentTestPicker] = useState(false);
  const [testStudentId, setTestStudentId] = useState<string | null>(null);
  const responseKeyRef = useRef("");
  const rankingKeyRef = useRef("");
  const selectedQuestionRef = useRef<string | null>(null);

  const questionBankCategories = useMemo(() => [...new Set(questionBankItems.map((item) => item.category))].sort((left, right) => left.localeCompare(right, "zh-Hant")), [questionBankItems]);
  const visibleQuestionBankItems = useMemo(() => {
    const search = questionBankSearch.normalize("NFKC").trim().toLocaleLowerCase("zh-Hant");
    return questionBankItems.filter((item) => {
      if (questionBankCategory !== "all" && item.category !== questionBankCategory) return false;
      if (questionBankUsage === "used" && !item.usedInCurrentSession) return false;
      if (questionBankUsage === "unused" && item.usedInCurrentSession) return false;
      return !search || `${item.title}\n${item.questionText}\n${item.category}`.toLocaleLowerCase("zh-Hant").includes(search);
    }).sort((left, right) => {
      if (questionBankSort === "title") return left.title.localeCompare(right.title, "zh-Hant");
      if (questionBankSort === "usage") return right.usageCount - left.usageCount || left.title.localeCompare(right.title, "zh-Hant");
      if (questionBankSort === "lastUsed") return (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "") || left.title.localeCompare(right.title, "zh-Hant");
      return right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title, "zh-Hant");
    });
  }, [questionBankItems, questionBankSearch, questionBankCategory, questionBankUsage, questionBankSort]);

  const load = useCallback(async (quiet = false, questionId?: string | null, testStudentOverride?: string | null) => {
    if (!quiet) setError(null);
    const selected = questionId === undefined ? selectedQuestionRef.current : questionId;
    const activeTestStudent = testStudentOverride === undefined ? testStudentId : testStudentOverride;
    try {
      const search = new URLSearchParams();
      if (selected) search.set("questionId", selected);
      if (activeTestStudent) search.set("testStudentId", activeTestStudent);
      const suffix = search.size ? `?${search.toString()}` : "";
      const data = await apiData<WorkspacePayload>(await fetch(`/api/classroom/courses/${encodeURIComponent(courseId)}/session${suffix}`, { cache: "no-store", headers: { accept: "application/json" } }));
      selectedQuestionRef.current = data.snapshot?.question?.id ?? null;
      const currentGroup = data.snapshot?.groups.find((group) => group.id === data.snapshot?.currentUser.groupId);
      const responseKey = data.snapshot?.question && currentGroup ? `${data.snapshot.question.id}:${currentGroup.response.version}` : "";
      if (responseKey && responseKey !== responseKeyRef.current) { responseKeyRef.current = responseKey; setResponseText(currentGroup?.response.content ?? ""); }
      if (data.snapshot?.question?.phase === "ranking" && !data.actor.isAdmin) {
        const eligible = data.snapshot.groups.filter((group) => group.id !== data.snapshot?.currentUser.groupId).map((group) => group.id);
        const rankingKey = `${data.snapshot.question.id}:${eligible.join(",")}`;
        if (rankingKey !== rankingKeyRef.current) { rankingKeyRef.current = rankingKey; setRankingOrder(shuffle(eligible)); }
      }
      setPayload(data);
    } catch (cause) { if (!quiet) setError(cause instanceof Error ? cause.message : "目前無法取得課堂資料。"); }
  }, [courseId, testStudentId]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => { const timer = window.setInterval(() => { if (!pending) void load(true); }, 5000); return () => window.clearInterval(timer); }, [load, pending]);

  const snapshot = payload?.snapshot ?? null;
  const question = snapshot?.question ?? null;
  const myGroup = useMemo(() => snapshot?.groups.find((group) => group.id === snapshot.currentUser.groupId) ?? null, [snapshot]);

  async function applySnapshot(request: Promise<Response>, message?: string) {
    setPending(true); setError(null); setNotice(null);
    try {
      const data = await apiData<{ snapshot: ClassroomSessionSnapshot }>(await request);
      selectedQuestionRef.current = data.snapshot.question?.id ?? null;
      setPayload((current) => current ? { ...current, snapshot: data.snapshot } : current);
      if (message) setNotice(message);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作失敗。"); }
    finally { setPending(false); }
  }

  async function mutate(body: Record<string, unknown>) {
    if (!snapshot) return;
    await applySnapshot(fetch(`/api/classroom/sessions/${encodeURIComponent(snapshot.session.id)}`, {
      method: "PATCH", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body),
    }));
  }

  async function createQuestion() {
    if (!snapshot) return;
    await applySnapshot(fetch(`/api/classroom/sessions/${encodeURIComponent(snapshot.session.id)}/questions`, {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        questionText: questionPrompt,
        rankingCriteria: questionCriteria,
        questionBankId: selectedQuestionBankId || undefined,
      }),
    }), "問題草稿已建立，確認後即可開放作答。");
    setQuestionPrompt(""); setSelectedQuestionBankId(""); setShowQuestionForm(false);
  }

  async function toggleQuestionCreator() {
    const opening = !showQuestionForm;
    setShowQuestionForm(opening);
    if (!opening || !snapshot) return;
    setQuestionBankSearch(""); setQuestionBankCategory("all"); setQuestionBankUsage("unused"); setQuestionBankSort("updated");
    setPending(true); setError(null);
    try {
      const search = new URLSearchParams({ sessionId: snapshot.session.id, readyOnly: "true" });
      const data = await apiData<{ items: ClassroomQuestionBankItem[] }>(await fetch(`/api/classroom/courses/${encodeURIComponent(courseId)}/question-bank?${search.toString()}`, { cache: "no-store", headers: { accept: "application/json" } }));
      setQuestionBankItems(data.items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "目前無法取得問題庫。");
    } finally {
      setPending(false);
    }
  }

  function selectQuestionBankItem(itemId: string) {
    setSelectedQuestionBankId(itemId);
    const item = questionBankItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    setQuestionPrompt(item.questionText);
    setQuestionCriteria(item.rankingCriteria);
  }

  function updateQuestionPrompt(value: string) {
    setQuestionPrompt(value);
    setSelectedQuestionBankId("");
  }

  function updateQuestionCriteria(value: string) {
    setQuestionCriteria(value);
    setSelectedQuestionBankId("");
  }

  async function saveResponse(submit: boolean) {
    if (!snapshot || !question || !myGroup) return;
    await applySnapshot(fetch(`/api/classroom/sessions/${encodeURIComponent(snapshot.session.id)}/response`, {
      method: "PUT", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ questionId: question.id, content: responseText, expectedVersion: myGroup.response.version, submit, testStudentId }),
    }), submit ? "小組回答已送出。" : "草稿已儲存。");
  }

  async function submitRanking() {
    if (!snapshot || !question) return;
    await applySnapshot(fetch(`/api/classroom/sessions/${encodeURIComponent(snapshot.session.id)}/ranking`, {
      method: "PUT", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ questionId: question.id, orderedGroupIds: rankingOrder, testStudentId }),
    }), "完整排序已送出。");
  }

  function moveRank(index: number, offset: number) {
    const target = index + offset;
    if (target < 0 || target >= rankingOrder.length) return;
    setRankingOrder((current) => { const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  }

  function dropRank(targetIndex: number) {
    if (!dragRank) return;
    setRankingOrder((current) => { const source = current.indexOf(dragRank); if (source < 0 || source === targetIndex) return current; const next = [...current]; const [moved] = next.splice(source, 1); next.splice(targetIndex, 0, moved); return next; });
    setDragRank(null);
  }

  function selectTestStudent(userId: string) {
    responseKeyRef.current = "";
    rankingKeyRef.current = "";
    selectedQuestionRef.current = null;
    setTestStudentId(userId);
    setShowStudentTestPicker(false);
    setNotice(null);
  }

  function exitStudentTestMode() {
    responseKeyRef.current = "";
    rankingKeyRef.current = "";
    selectedQuestionRef.current = null;
    setTestStudentId(null);
    setShowStudentTestPicker(false);
    setNotice("已回到系統管理員畫面。");
  }

  async function resetStudentTestData() {
    if (!window.confirm("確定要重設示範課程嗎？虛擬學生在第三題的作答與排序變更將恢復原始狀態。")) return;
    setPending(true); setError(null); setNotice(null);
    try {
      await apiData(await fetch(`/api/classroom/courses/${encodeURIComponent(courseId)}/test-mode`, {
        method: "POST", headers: { accept: "application/json" },
      }));
      responseKeyRef.current = ""; rankingKeyRef.current = ""; selectedQuestionRef.current = null;
      setTestStudentId(null); setShowStudentTestPicker(false);
      await load(false, null, null);
      setNotice("示範課程已恢復，可以重新測試不同學生情境。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "目前無法重設示範課程。"); }
    finally { setPending(false); }
  }

  if (!payload) return <div className="course-shell"><main className="course-workspace-main">{error ? <div className="courses-error"><strong>無法開啟課程</strong><span>{error}</span><button className="button secondary" onClick={() => void load()}>重新載入</button></div> : <div className="courses-loading"><span className="spinner" />正在開啟課程…</div>}</main></div>;

  const { actor, viewer, testMode, course } = payload;
  const joinUrl = snapshot && typeof window !== "undefined" ? `${window.location.origin}/join/${snapshot.session.joinCode}` : "";
  const questionAdvanceLabels: Record<string, string> = { draft: "開放小組作答", answering: "鎖定回答並開始展示", presenting: "開放個人排序", ranking: "結束並鎖定排序", locked: "公布正式排名", published: "封存這個問題" };

  return <div className="course-shell">
    <header className="course-topbar"><Link href="/courses" className="course-brand"><span aria-hidden="true">課</span><strong>課堂小組回應與排序</strong></Link><div className="course-account"><span><strong>{actor.displayName}</strong><small>{testMode ? "學生測試模式" : actor.isAdmin ? "系統管理員" : "學生"}</small></span><a href={identity.signOutPath}><LogOut />登出</a></div></header>
    <main className="course-workspace-main">
      <Link className="course-back" href="/courses"><ArrowLeft />所有課程</Link>
      <section className="course-workspace-heading"><div><p>{courseTermLabel(course)}{course.isDemo ? " · 虛擬資料示範" : ""}</p><h1>{course.name}</h1><span>{snapshot?.session.title ?? "建立本次課堂後，再讓學生輸入代碼加入。"}</span></div>{snapshot && <div className="workspace-heading-actions">{viewer.isAdmin && course.isDemo && <button className="button secondary" onClick={() => setShowStudentTestPicker((value) => !value)}><UserRoundSearch />學生測試</button>}{actor.isAdmin && <button className="button secondary" onClick={() => setShowSettings((value) => !value)}><Settings2 />課堂設定</button>}<button className="button secondary" onClick={() => void load()}><RefreshCw />更新</button></div>}</section>
      {testMode && snapshot && <section className="student-test-banner" role="status"><div><UserRoundSearch /><span><strong>學生測試模式</strong><small>目前以 {actor.displayName} 查看與操作；所有權限均依這名虛擬學生判定。</small></span></div><button type="button" onClick={exitStudentTestMode}><X />回到管理員</button></section>}
      {showStudentTestPicker && viewer.isAdmin && course.isDemo && snapshot && <StudentTestPicker snapshot={snapshot} currentUserId={testMode ? actor.id : null} pending={pending} onSelect={selectTestStudent} onReset={() => void resetStudentTestData()} onClose={() => setShowStudentTestPicker(false)} />}
      {error && <div className="workspace-alert error" role="alert">{error}</div>}{notice && <div className="workspace-alert success" role="status">{notice}</div>}
      {!snapshot ? actor.isAdmin ? <EmptySession course={course} onCreated={() => void load()} /> : <div className="courses-empty"><Clock3 /><h2>今天尚未開放課堂</h2><p>請輸入教師提供的六位課堂代碼。</p></div> : <>
        {showSettings && actor.isAdmin && <SessionSettings snapshot={snapshot} pending={pending} onSave={(values) => void mutate({ action: "update_settings", expectedVersion: snapshot.session.version, ...values })} />}

        {snapshot.session.phase === "check_in" && <section className="checkin-layout"><article className="qr-panel"><Hash /><p>本次課堂代碼</p><strong>{snapshot.session.joinCode}</strong><button className="button secondary" onClick={() => { void navigator.clipboard.writeText(snapshot.session.joinCode); setNotice("課堂代碼已複製。"); }}><Copy />複製代碼</button>{snapshot.session.qrEnabled && <span className="qr-frame"><QRCodeSVG value={joinUrl} size={180} level="M" marginSize={2} /></span>}</article><article className="attendance-panel"><header><div><p>等待加入</p><h2>{snapshot.completion.checkedIn} 位學生已登入</h2></div><span className="live-pill"><i />即時更新</span></header>{snapshot.participants.length ? <ul>{snapshot.participants.map((participant) => <li key={participant.id}><span>{participant.displayName.slice(0, 1)}</span><div><strong>{participant.displayName}</strong><small>{participant.email}</small></div><CheckCircle2 /></li>)}</ul> : <div className="panel-empty"><UsersRound /><strong>等待學生輸入代碼</strong><span>此時只進入等待區，尚未決定組別。</span></div>}{actor.isAdmin && <footer><span>確認主要學生到齊後，系統會隨機平均分組，並為每組隨機指定一位作答代表。</span><button className="button primary" disabled={pending || snapshot.completion.checkedIn < snapshot.session.groupCount} onClick={() => void mutate({ action: "advance", expectedVersion: snapshot.session.version })}>建立 {snapshot.session.groupCount} 組<ArrowRight /></button></footer>}</article></section>}

        {snapshot.session.phase === "grouping" && <section><div className="section-intro"><div><p>確認分組</p><h2>檢查組員與隨機代表</h2><span>教師仍可拖曳調整組員或更換代表；遲到學生會自動加入當下人數最少的組。</span></div><strong>{snapshot.groups.length} 組 · {snapshot.completion.grouped} 位學生</strong></div><GroupBoard snapshot={snapshot} actor={actor} dragParticipant={dragParticipant} setDragParticipant={setDragParticipant} mutate={mutate} />{actor.isAdmin && <div className="session-action-bar"><span>組數在這一步確認後固定；之後移動組員只影響進行中的作答或未來問題。</span><button className="button primary" disabled={pending} onClick={() => void mutate({ action: "advance", expectedVersion: snapshot.session.version })}>開始本次課堂<ArrowRight /></button></div>}</section>}

        {snapshot.session.phase === "answering" && <section className="live-classroom-layout"><aside className="question-rail"><header><div><p>本次課堂</p><h2>問題與排名</h2></div>{actor.isAdmin && <button aria-label="新增問題" onClick={() => void toggleQuestionCreator()}><Plus /></button>}</header>{showQuestionForm && actor.isAdmin && <div className="question-create-inline">
          <section className="question-bank-classroom-picker"><header><span><LibraryBig />從問題庫選擇</span><small>{visibleQuestionBankItems.length}／{questionBankItems.length} 題</small></header><input aria-label="搜尋課堂問題庫" value={questionBankSearch} onChange={(event) => setQuestionBankSearch(event.target.value)} placeholder="搜尋問題" /><div className="question-bank-classroom-filters"><select aria-label="問題分類" value={questionBankCategory} onChange={(event) => setQuestionBankCategory(event.target.value)}><option value="all">全部分類</option>{questionBankCategories.map((category) => <option value={category} key={category}>{category}</option>)}</select><select aria-label="本次使用狀態" value={questionBankUsage} onChange={(event) => setQuestionBankUsage(event.target.value)}><option value="unused">本次尚未使用</option><option value="used">本次已使用</option><option value="all">全部</option></select><select aria-label="問題排序" value={questionBankSort} onChange={(event) => setQuestionBankSort(event.target.value)}><option value="updated">最近更新</option><option value="lastUsed">最近使用</option><option value="usage">使用次數</option><option value="title">問題名稱</option></select></div><div className="question-bank-classroom-list">{visibleQuestionBankItems.map((item) => <button type="button" className={selectedQuestionBankId === item.id ? "selected" : ""} key={item.id} onClick={() => selectQuestionBankItem(item.id)}><span><em>{item.category}</em>{item.usedInCurrentSession && <i>本次已使用</i>}</span><strong>{item.title}</strong><small>{item.questionText}</small></button>)}{visibleQuestionBankItems.length === 0 && <p>{questionBankItems.length === 0 ? "問題庫尚無可用問題。" : "沒有符合條件的問題。"}</p>}</div><button type="button" className="question-bank-custom" onClick={() => setSelectedQuestionBankId("")}>臨時輸入新問題</button></section>
          <label><span>新問題</span><textarea rows={4} maxLength={2000} value={questionPrompt} onChange={(event) => updateQuestionPrompt(event.target.value)} /></label><label><span>排序判準</span><textarea rows={3} maxLength={500} value={questionCriteria} onChange={(event) => updateQuestionCriteria(event.target.value)} /></label><button className="button primary wide" disabled={pending || questionPrompt.trim().length < 5 || questionCriteria.trim().length < 5} onClick={() => void createQuestion()}>建立問題草稿</button></div>}<ol>{snapshot.questions.map((item) => <li key={item.id}><button className={item.id === question?.id ? "selected" : ""} onClick={() => { selectedQuestionRef.current = item.id; void load(false, item.id); }}><span>{item.position}</span><div><strong>{item.text}</strong><small>{QUESTION_PHASE_LABELS[item.phase]}</small>{item.phase === "published" && item.leaderLabel && <em>第1名 {item.leaderLabel} · 平均 {item.leaderAverageScore?.toFixed(2)} 分</em>}{["ranking", "locked"].includes(item.phase) && <em>{item.rankedStudents} 人已排序</em>}</div></button></li>)}</ol>{snapshot.questions.length === 0 && <div className="question-rail-empty"><ClipboardCheck /><strong>尚未建立問題</strong><span>{actor.isAdmin ? "可從問題庫選取，或直接輸入本次問題。" : "等待教師新增問題。"}</span></div>}<footer><span>{snapshot.questions.filter((item) => item.phase === "published").length} 題已公布</span>{actor.isAdmin && <button className="text-button" disabled={snapshot.questions.some((item) => ["answering", "presenting", "ranking", "locked"].includes(item.phase))} onClick={() => void mutate({ action: "advance", expectedVersion: snapshot.session.version })}><History />封存課堂</button>}</footer></aside>
          <div className="question-stage">{!question ? <div className="stage-empty"><ClipboardCheck /><h2>選擇或新增一個問題</h2><p>每個問題都有獨立的回答、原始排序及公布結果。</p></div> : <>
            <header className="question-stage-header"><div><span>問題 {question.position}</span><h2>{question.text}</h2><p>{question.rankingCriteria}</p></div><strong className={`question-phase ${question.phase}`}>{QUESTION_PHASE_LABELS[question.phase]}</strong></header>
            {question.phase === "draft" && <div className="stage-empty"><Eye /><h2>問題草稿尚未對學生開放</h2><p>確認問題與排序判準後，開放作答時會保存當下分組，作為本題排除自己組的依據。</p></div>}
            {question.phase === "answering" && <AnsweringStage snapshot={snapshot} actor={actor} myGroup={myGroup} responseText={responseText} setResponseText={setResponseText} pending={pending} saveResponse={saveResponse} />}
            {question.phase === "presenting" && <PresentationStage snapshot={snapshot} />}
            {question.phase === "ranking" && <RankingStage snapshot={snapshot} actor={actor} rankingOrder={rankingOrder} dragRank={dragRank} setDragRank={setDragRank} moveRank={moveRank} dropRank={dropRank} pending={pending} submitRanking={submitRanking} />}
            {["locked", "published", "archived"].includes(question.phase) && <ResultsStage snapshot={snapshot} actor={actor} />}
            {actor.isAdmin && question.phase !== "archived" && <div className="session-action-bar question-actions"><span>{question.phase === "locked" ? "學生目前仍看不到排名；確認後再正式公布。" : question.phase === "published" ? "結果已固定並對學生公開。" : "同一時間只會開放一個問題。"}</span><button className="button primary" disabled={pending || (question.phase === "answering" && snapshot.completion.submittedGroups !== snapshot.groups.length) || (question.phase === "ranking" && snapshot.completion.rankedStudents === 0)} onClick={() => void mutate({ action: "question_advance", questionId: question.id, expectedQuestionVersion: question.version })}>{questionAdvanceLabels[question.phase]}<ArrowRight /></button></div>}
          </>}</div>
        </section>}
        <aside className="course-summary-strip"><span><UsersRound /><strong>{snapshot.completion.checkedIn}</strong>位本次課堂學生</span><span><UserCheck /><strong>{snapshot.groups.length || snapshot.session.groupCount}</strong>組</span><span><ClipboardCheck /><strong>{snapshot.questions.length}</strong>個問題</span>{actor.isAdmin && <a href={`/api/classroom/sessions/${encodeURIComponent(snapshot.session.id)}/export`}><Download />匯出全部資料</a>}</aside>
      </>}
    </main>
  </div>;
}

function StudentTestPicker({ snapshot, currentUserId, pending, onSelect, onReset, onClose }: {
  snapshot: ClassroomSessionSnapshot;
  currentUserId: string | null;
  pending: boolean;
  onSelect: (userId: string) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return <section className="student-test-picker" role="dialog" aria-label="選擇虛擬學生">
    <header><div><UserRoundSearch /><span><strong>選擇學生情境</strong><small>進入後會使用該學生的真實作答與排序權限。</small></span></div><button type="button" aria-label="關閉學生測試選擇" onClick={onClose}><X /></button></header>
    <div className="student-test-grid">{snapshot.participants.map((participant) => {
      const group = snapshot.groups.find((item) => item.id === participant.groupId);
      const representative = group?.representativeUserId === participant.userId;
      return <button type="button" className={participant.userId === currentUserId ? "selected" : ""} key={participant.id} onClick={() => onSelect(participant.userId)}>
        <span>{participant.displayName.slice(-2)}</span><div><strong>{participant.displayName}</strong><small>{group?.label ?? "尚未分組"} · {representative ? "指定代表" : "一般組員"}{participant.attendance === "late" ? " · 遲到加入" : ""}</small></div>{participant.userId === currentUserId && <em>目前</em>}
      </button>;
    })}</div>
    <footer><span>重設只影響示範課程的第三題，不會處理正式課程資料。</span><button type="button" className="button secondary" disabled={pending} onClick={onReset}><RotateCcw />重設示範資料</button></footer>
  </section>;
}

function SessionSettings({ snapshot, pending, onSave }: { snapshot: ClassroomSessionSnapshot; pending: boolean; onSave: (values: Record<string, unknown>) => void }) {
  const [title, setTitle] = useState(snapshot.session.title);
  const [groupCount, setGroupCount] = useState(snapshot.session.groupCount);
  const [anonymous, setAnonymous] = useState(snapshot.session.anonymousGroups);
  const [editable, setEditable] = useState(snapshot.session.allowRankingEdits);
  const [admissionOpen, setAdmissionOpen] = useState(snapshot.session.admissionOpen);
  const [qrEnabled, setQrEnabled] = useState(snapshot.session.qrEnabled);
  return <section className="session-settings-panel"><header><Settings2 /><div><strong>本次課堂設定</strong><small>一般設定立即生效；完成分組後不能改變組數。</small></div></header><label className="course-field"><span>課堂名稱</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="course-field"><span>指定組數</span><input type="number" min={2} max={20} disabled={snapshot.session.phase !== "check_in"} value={groupCount} onChange={(event) => setGroupCount(Number(event.target.value))} /></label><label className="check-field"><input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} /><span><strong>排序時隱藏組別</strong></span></label><label className="check-field"><input type="checkbox" checked={editable} onChange={(event) => setEditable(event.target.checked)} /><span><strong>截止前可修改排序</strong></span></label><label className="check-field"><input type="checkbox" checked={admissionOpen} onChange={(event) => setAdmissionOpen(event.target.checked)} /><span><strong>開放課堂代碼加入</strong></span></label><label className="check-field"><input type="checkbox" checked={qrEnabled} onChange={(event) => setQrEnabled(event.target.checked)} /><span><strong>顯示 QR Code</strong></span></label><button className="button primary" disabled={pending || title.trim().length < 2} onClick={() => onSave({ title, groupCount, anonymousGroups: anonymous, allowRankingEdits: editable, admissionOpen, qrEnabled })}>儲存設定</button></section>;
}

function GroupBoard({ snapshot, actor, dragParticipant, setDragParticipant, mutate }: { snapshot: ClassroomSessionSnapshot; actor: Actor; dragParticipant: string | null; setDragParticipant: (value: string | null) => void; mutate: (body: Record<string, unknown>) => Promise<void> }) {
  return <div className="group-board">{snapshot.groups.map((group) => <article className="group-column" key={group.id} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (dragParticipant) void mutate({ action: "move_participant", participantId: dragParticipant, groupId: group.id }); setDragParticipant(null); }}><header><div><span>{group.position}</span><h3>{group.label}</h3></div><strong>{group.members.length} 人</strong></header><div>{group.members.map((member) => <div className="participant-card" key={member.id} draggable={actor.isAdmin} onDragStart={() => setDragParticipant(member.id)} onDragEnd={() => setDragParticipant(null)}><GripVertical /><span><strong>{member.displayName}</strong><small>{member.attendance === "late" ? "遲到後自動加入" : member.email}</small></span>{member.userId === group.representativeUserId && <em>代表</em>}{actor.isAdmin && <select aria-label={`調整 ${member.displayName} 的組別`} value={group.id} onChange={(event) => void mutate({ action: "move_participant", participantId: member.id, groupId: event.target.value })}>{snapshot.groups.map((option) => <option value={option.id} key={option.id}>{option.label}</option>)}</select>}</div>)}</div>{actor.isAdmin && group.members.length > 0 && <label><span>作答代表</span><select value={group.representativeUserId ?? ""} onChange={(event) => void mutate({ action: "set_representative", groupId: group.id, userId: event.target.value })}>{group.members.map((member) => <option value={member.userId} key={member.id}>{member.displayName}</option>)}</select></label>}</article>)}</div>;
}

function AnsweringStage({ snapshot, actor, myGroup, responseText, setResponseText, pending, saveResponse }: { snapshot: ClassroomSessionSnapshot; actor: Actor; myGroup: ClassroomGroup | null; responseText: string; setResponseText: (value: string) => void; pending: boolean; saveResponse: (submit: boolean) => Promise<void> }) {
  if (actor.isAdmin) return <div className="response-layout"><article className="response-workspace"><header><div><p>小組作答進度</p><h2>{snapshot.completion.submittedGroups} / {snapshot.groups.length} 組已送出</h2></div></header><div className="presentation-grid compact">{snapshot.groups.map((group) => <article key={group.id}><header><span>{group.position}</span><h3>{group.label}</h3></header><p>{group.response.content || "尚未輸入回答"}</p><small>{group.response.status === "submitted" ? "已送出" : "草稿"}</small></article>)}</div></article><aside className="submission-progress"><h2>即時完成率</h2><strong>{snapshot.completion.submittedGroups}<small> / {snapshot.groups.length}</small></strong><div className="progress-track"><span style={{ width: `${snapshot.groups.length ? snapshot.completion.submittedGroups / snapshot.groups.length * 100 : 0}%` }} /></div><p>所有小組送出後才能鎖定回答並開始展示。</p></aside></div>;
  return <div className="response-layout"><article className="response-workspace"><header><div><p>{myGroup?.label ?? "尚未分組"}</p><h2>{snapshot.currentUser.isRepresentative ? "您是本組指定代表" : "與組員討論後，由指定代表輸入"}</h2></div>{myGroup && <span className={`response-status ${myGroup.response.status}`}>{myGroup.response.status === "submitted" ? "已送出" : "草稿"}</span>}</header>{myGroup ? snapshot.currentUser.isRepresentative ? <><textarea rows={12} maxLength={4000} value={responseText} onChange={(event) => setResponseText(event.target.value)} placeholder="整理小組共同回答與理由…" /><footer><span>{responseText.length} / 4000</span><div><button className="button secondary" disabled={pending} onClick={() => void saveResponse(false)}>儲存草稿</button><button className="button primary" disabled={pending || responseText.trim().length < 2} onClick={() => void saveResponse(true)}><Send />送出回答</button></div></footer></> : <div className="response-readonly">{myGroup.response.content || "代表尚未輸入回答。"}</div> : <div className="panel-empty"><Clock3 /><strong>您將從下一題開始參與</strong><span>若您剛加入排序或展示中的問題，本題不會納入您的排序。</span></div>}</article><aside className="submission-progress"><h2>全班進度</h2><strong>{snapshot.completion.submittedGroups}<small> / {snapshot.groups.length}</small></strong><div className="progress-track"><span style={{ width: `${snapshot.groups.length ? snapshot.completion.submittedGroups / snapshot.groups.length * 100 : 0}%` }} /></div></aside></div>;
}

function PresentationStage({ snapshot }: { snapshot: ClassroomSessionSnapshot }) {
  return <div><div className="section-intro"><div><p>答案展示</p><h2>依序介紹各組解答</h2><span>所有回答已鎖定，介紹完成後才開放個人排序。</span></div></div><div className="presentation-grid">{snapshot.groups.map((group) => <article key={group.id}><header><span>{group.position}</span><h3>{group.label}</h3></header><p>{group.response.content}</p></article>)}</div></div>;
}

function RankingStage({ snapshot, actor, rankingOrder, dragRank, setDragRank, moveRank, dropRank, pending, submitRanking }: { snapshot: ClassroomSessionSnapshot; actor: Actor; rankingOrder: string[]; dragRank: string | null; setDragRank: (value: string | null) => void; moveRank: (index: number, offset: number) => void; dropRank: (index: number) => void; pending: boolean; submitRanking: () => Promise<void> }) {
  if (actor.isAdmin) return <div className="ranking-monitor"><BarChart3 /><strong>{snapshot.completion.rankedStudents} / {snapshot.completion.eligibleStudents} 位已完成</strong><span>排序期間只顯示完成進度，不對學生顯示暫時名次，避免影響後提交者。</span><div className="progress-track"><span style={{ width: `${snapshot.completion.eligibleStudents ? snapshot.completion.rankedStudents / snapshot.completion.eligibleStudents * 100 : 0}%` }} /></div></div>;
  return <div className="ranking-workspace"><header><div><p>個人完整排序</p><h2>依回答內容拖曳排序；越上方得分越高</h2></div><span>{rankingOrder.length} 份回答</span></header><ol className="ranking-list">{rankingOrder.map((groupId, index) => { const group = snapshot.groups.find((item) => item.id === groupId); if (!group) return null; return <li key={group.id} draggable onDragStart={() => setDragRank(group.id)} onDragEnd={() => setDragRank(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => dropRank(index)} className={dragRank === group.id ? "dragging" : ""}><span className="rank-number">{rankingOrder.length - index}<small>分</small></span><GripVertical /><div className="ranking-answer"><p>{group.response.content}</p><small>{displayGroup(group, snapshot.session.anonymousGroups, snapshot.groups)} · 目前第 {index + 1} 名</small></div><span className="rank-controls"><button aria-label="上移" disabled={index === 0} onClick={() => moveRank(index, -1)}><ArrowUp /></button><button aria-label="下移" disabled={index === rankingOrder.length - 1} onClick={() => moveRank(index, 1)}><ArrowDown /></button></span></li>; })}</ol><button className="button primary wide" disabled={pending || rankingOrder.length !== snapshot.groups.length - 1} onClick={() => void submitRanking()}><ClipboardCheck />{snapshot.currentUser.hasSubmittedRanking ? "更新完整排序" : "送出完整排序"}</button></div>;
}

function ResultsStage({ snapshot, actor }: { snapshot: ClassroomSessionSnapshot; actor: Actor }) {
  if (snapshot.results.length === 0) return <div className="stage-empty"><LockKeyhole /><h2>{actor.isAdmin ? "尚無可計算的排序" : "排名尚未公布"}</h2><p>{actor.isAdmin ? "結束排序後可先核對結果，再決定是否向全班公布。" : "教師公布後，這裡會顯示固定的正式排名。"}</p></div>;
  return <div className="results-layout"><article className="results-table"><header><div><p>全班排序結果</p><h2>平均分數越高，整體排名越高</h2></div><span>{snapshot.completion.rankedStudents} 份有效排序</span></header><ol>{snapshot.results.map((result) => { const group = snapshot.groups.find((item) => item.id === result.groupId); return <li key={result.groupId}><p className="result-response">{group?.response.content || "未提供回答內容"}</p><footer className="result-meta"><span><b>{result.label}</b><small>{result.ratingCount} 人完成評選</small></span><span><strong>{result.tied ? `並列第 ${result.finalRank} 名` : `第 ${result.finalRank} 名`}</strong><em>平均 {result.averageScore.toFixed(2)} 分／最高 {result.maximumScore} 分</em></span></footer><div className="result-bar"><i style={{ width: `${result.maximumScore ? result.averageScore / result.maximumScore * 100 : 0}%` }} /></div></li>; })}</ol></article>{actor.isAdmin && snapshot.rawRankings.length > 0 && <details className="raw-ranking-panel"><summary>查看 {snapshot.rawRankings.length} 位學生的原始完整排序</summary><div><table><thead><tr><th>學生</th><th>虛擬／登入帳號</th><th>完整排序</th><th>送出時間</th></tr></thead><tbody>{snapshot.rawRankings.map((ranking) => <tr key={ranking.userId}><td>{ranking.displayName}</td><td>{ranking.email}</td><td>{ranking.orderedGroupIds.map((id) => snapshot.groups.find((group) => group.id === id)?.label ?? id).join(" → ")}</td><td>{new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit" }).format(new Date(ranking.submittedAt))}</td></tr>)}</tbody></table></div></details>}</div>;
}
