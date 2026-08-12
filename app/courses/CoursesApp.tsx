"use client";

import Link from "next/link";
import {
  Activity,
  Archive,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clock3,
  LogOut,
  KeyRound,
  FileSpreadsheet,
  ListChecks,
  LibraryBig,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Upload,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  courseTermLabel,
  currentAcademicTerm,
  SESSION_PHASE_LABELS,
  type AcademicTerm,
  type ClassroomCourse,
  type ClassroomQuestionBankItem,
  type ClassroomRole,
} from "@/lib/classroom-domain";
import type { ClassroomPageIdentity } from "./classroom-page-identity";
import {
  rosterEntriesFromRows,
  rosterEntriesFromText,
  type ClassroomRosterDraft,
} from "@/lib/classroom-roster";

type Actor = { id: string; email: string; displayName: string; role: ClassroomRole; isAdmin: boolean };
type CoursePayload = { actor: Actor; courses: ClassroomCourse[] };
type RosterEntry = ClassroomRosterDraft & { sourceFileName: string; importedAt: string };
type ApiEnvelope<T> = { data?: T; error?: { code?: string; message?: string } };

class ClassroomClientError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

async function apiData<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || body?.data === undefined) {
    throw new ClassroomClientError(body?.error?.code ?? "UNKNOWN_ERROR", body?.error?.message ?? "目前無法取得課程資料。");
  }
  return body.data;
}

function CourseDialog({ open, title, description, pending, error, confirmLabel, destructive = false, confirmDisabled = false, children, onClose, onConfirm }: {
  open: boolean;
  title: string;
  description: string;
  pending: boolean;
  error: string | null;
  confirmLabel: string;
  destructive?: boolean;
  confirmDisabled?: boolean;
  children?: React.ReactNode;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  return <dialog ref={ref} className="course-dialog" onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }}>
    <form method="dialog" onSubmit={(event) => event.preventDefault()}>
      <header><div><h2>{title}</h2><p>{description}</p></div><button type="button" className="course-icon-button" aria-label="關閉" disabled={pending} onClick={onClose}><X /></button></header>
      {children}
      {error && <div className="course-form-error" role="alert">{error}</div>}
      <footer><button type="button" className="button secondary" disabled={pending} onClick={onClose}>取消</button><button type="button" className={`button ${destructive ? "danger" : "primary"}`} disabled={pending || confirmDisabled} onClick={onConfirm}>{pending ? "正在處理…" : confirmLabel}</button></footer>
    </form>
  </dialog>;
}

export function CoursesApp({ identity }: { identity: ClassroomPageIdentity }) {
  const defaults = currentAcademicTerm();
  const [actor, setActor] = useState<Actor | null>(null);
  const [courses, setCourses] = useState<ClassroomCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadCode, setLoadCode] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "rename" | "delete" | "roster" | "questionBank" | null>(null);
  const [target, setTarget] = useState<ClassroomCourse | null>(null);
  const [name, setName] = useState("");
  const [academicYear, setAcademicYear] = useState(defaults.academicYear);
  const [term, setTerm] = useState<AcademicTerm>(defaults.term);
  const [groupCount, setGroupCount] = useState(6);
  const [joinCode, setJoinCode] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rosterFileName, setRosterFileName] = useState("");
  const [rosterEntries, setRosterEntries] = useState<ClassroomRosterDraft[]>([]);
  const [rosterCurrent, setRosterCurrent] = useState<RosterEntry[]>([]);
  const [rosterPreview, setRosterPreview] = useState<{ total: number; added: number; updated: number; unchanged: number; removed: number } | null>(null);
  const [questionBankItems, setQuestionBankItems] = useState<ClassroomQuestionBankItem[]>([]);
  const [questionBankTitle, setQuestionBankTitle] = useState("");
  const [questionBankCategory, setQuestionBankCategory] = useState("未分類");
  const [questionBankPrompt, setQuestionBankPrompt] = useState("");
  const [questionBankCriteria, setQuestionBankCriteria] = useState("請依回答的正確性、解釋力及理由充分程度，將所有回答從最佳到相對較弱排列。");
  const [questionBankStatus, setQuestionBankStatus] = useState<"draft" | "ready">("ready");
  const [editingQuestionBankId, setEditingQuestionBankId] = useState<string | null>(null);
  const [questionBankSearch, setQuestionBankSearch] = useState("");
  const [questionBankCategoryFilter, setQuestionBankCategoryFilter] = useState("all");
  const [questionBankStatusFilter, setQuestionBankStatusFilter] = useState("all");
  const [questionBankUsageFilter, setQuestionBankUsageFilter] = useState("all");
  const [questionBankSort, setQuestionBankSort] = useState("updated");

  const questionBankCategories = useMemo(() => [...new Set(questionBankItems.map((item) => item.category))].sort((left, right) => left.localeCompare(right, "zh-Hant")), [questionBankItems]);
  const visibleQuestionBankItems = useMemo(() => {
    const search = questionBankSearch.normalize("NFKC").trim().toLocaleLowerCase("zh-Hant");
    const items = questionBankItems.filter((item) => {
      if (questionBankCategoryFilter !== "all" && item.category !== questionBankCategoryFilter) return false;
      if (questionBankStatusFilter !== "all" && item.status !== questionBankStatusFilter) return false;
      if (questionBankUsageFilter === "used" && item.usageCount === 0) return false;
      if (questionBankUsageFilter === "never" && item.usageCount > 0) return false;
      return !search || `${item.title}\n${item.questionText}\n${item.category}`.toLocaleLowerCase("zh-Hant").includes(search);
    });
    return items.sort((left, right) => {
      if (questionBankSort === "title") return left.title.localeCompare(right.title, "zh-Hant");
      if (questionBankSort === "usage") return right.usageCount - left.usageCount || left.title.localeCompare(right.title, "zh-Hant");
      if (questionBankSort === "lastUsed") return (right.lastUsedAt ?? "").localeCompare(left.lastUsedAt ?? "") || left.title.localeCompare(right.title, "zh-Hant");
      return right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title, "zh-Hant");
    });
  }, [questionBankItems, questionBankSearch, questionBankCategoryFilter, questionBankStatusFilter, questionBankUsageFilter, questionBankSort]);

  const loadCourses = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiData<CoursePayload>(await fetch("/api/classroom/courses", { cache: "no-store", headers: { accept: "application/json" } }));
      setActor(data.actor);
      setCourses(data.courses);
      setLoadCode(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "目前無法取得課程資料。");
      setLoadCode(error instanceof ClassroomClientError ? error.code : "UNKNOWN_ERROR");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadCourses(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadCourses]);

  function closeDialog() {
    if (pending) return;
    setDialog(null); setTarget(null); setName(""); setFormError(null); setRosterFileName(""); setRosterEntries([]); setRosterCurrent([]); setRosterPreview(null);
    setQuestionBankItems([]); resetQuestionBankForm();
  }

  function resetQuestionBankForm() {
    setQuestionBankTitle("");
    setQuestionBankCategory("未分類");
    setQuestionBankPrompt("");
    setQuestionBankCriteria("請依回答的正確性、解釋力及理由充分程度，將所有回答從最佳到相對較弱排列。");
    setQuestionBankStatus("ready");
    setEditingQuestionBankId(null);
  }

  async function openQuestionBank(course: ClassroomCourse) {
    setTarget(course); setDialog("questionBank"); setPending(true); setFormError(null); resetQuestionBankForm();
    setQuestionBankSearch(""); setQuestionBankCategoryFilter("all"); setQuestionBankStatusFilter("all"); setQuestionBankUsageFilter("all"); setQuestionBankSort("updated");
    try {
      const result = await apiData<{ items: ClassroomQuestionBankItem[] }>(await fetch(`/api/classroom/courses/${encodeURIComponent(course.id)}/question-bank`, { cache: "no-store", headers: { accept: "application/json" } }));
      setQuestionBankItems(result.items);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "目前無法取得問題庫。");
    } finally {
      setPending(false);
    }
  }

  function editQuestionBankItem(item: ClassroomQuestionBankItem) {
    setQuestionBankTitle(item.title);
    setQuestionBankCategory(item.category);
    setQuestionBankPrompt(item.questionText);
    setQuestionBankCriteria(item.rankingCriteria);
    setQuestionBankStatus(item.status);
    setEditingQuestionBankId(item.id);
    setFormError(null);
  }

  async function saveQuestionBankItem() {
    if (!target) return;
    const current = questionBankItems.find((item) => item.id === editingQuestionBankId);
    setPending(true); setFormError(null);
    try {
      const url = current
        ? `/api/classroom/courses/${encodeURIComponent(target.id)}/question-bank/${encodeURIComponent(current.id)}`
        : `/api/classroom/courses/${encodeURIComponent(target.id)}/question-bank`;
      const result = await apiData<{ item: ClassroomQuestionBankItem }>(await fetch(url, {
        method: current ? "PATCH" : "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({
          title: questionBankTitle,
          category: questionBankCategory,
          questionText: questionBankPrompt,
          rankingCriteria: questionBankCriteria,
          status: questionBankStatus,
          expectedVersion: current?.version,
        }),
      }));
      setQuestionBankItems((items) => current
        ? items.map((item) => item.id === result.item.id ? result.item : item)
        : [result.item, ...items]);
      if (!current) {
        setCourses((courses) => courses.map((course) => course.id === target.id
          ? { ...course, questionBankCount: course.questionBankCount + 1 }
          : course));
      }
      resetQuestionBankForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "目前無法儲存問題。");
    } finally {
      setPending(false);
    }
  }

  async function archiveQuestionBankItem(item: ClassroomQuestionBankItem) {
    if (!target || !window.confirm(`確定要從問題庫移除「${item.title}」嗎？已使用過的課堂問題不會受影響。`)) return;
    setPending(true); setFormError(null);
    try {
      await apiData(await fetch(`/api/classroom/courses/${encodeURIComponent(target.id)}/question-bank/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: item.version }),
      }));
      setQuestionBankItems((items) => items.filter((current) => current.id !== item.id));
      setCourses((courses) => courses.map((course) => course.id === target.id
        ? { ...course, questionBankCount: Math.max(0, course.questionBankCount - 1) }
        : course));
      if (editingQuestionBankId === item.id) resetQuestionBankForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "目前無法移除問題。");
    } finally {
      setPending(false);
    }
  }

  async function openRoster(course: ClassroomCourse) {
    setTarget(course); setDialog("roster"); setPending(true); setFormError(null); setRosterFileName(""); setRosterEntries([]); setRosterPreview(null);
    try {
      const result = await apiData<{ roster: RosterEntry[] }>(await fetch(`/api/classroom/courses/${encodeURIComponent(course.id)}/roster`, { cache: "no-store", headers: { accept: "application/json" } }));
      setRosterCurrent(result.roster);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "目前無法取得課程名單。");
    } finally {
      setPending(false);
    }
  }

  async function previewRosterFile(file: File) {
    if (!target) return;
    setPending(true); setFormError(null); setRosterPreview(null); setRosterEntries([]); setRosterFileName(file.name);
    try {
      if (file.size > 2_000_000) throw new Error("檔案不得超過 2 MB。");
      const extension = file.name.split(".").pop()?.toLowerCase();
      let parsed;
      if (extension === "txt") parsed = rosterEntriesFromText(await file.text());
      else if (extension === "xlsx") {
        const { readSheet } = await import("read-excel-file/browser");
        parsed = rosterEntriesFromRows(await readSheet(file));
      } else throw new Error("請上傳 .xlsx 或 .txt 檔案；舊式 .xls 請先另存為 .xlsx。");
      if (parsed.errors.length > 0) throw new Error(parsed.errors.slice(0, 5).join("\n"));
      if (parsed.entries.length === 0) throw new Error("檔案沒有可匯入的學生資料。");
      const result = await apiData<{ preview: { total: number; added: number; updated: number; unchanged: number; removed: number } }>(await fetch(`/api/classroom/courses/${encodeURIComponent(target.id)}/roster`, {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ action: "preview", sourceFileName: file.name, entries: parsed.entries }),
      }));
      setRosterEntries(parsed.entries); setRosterPreview(result.preview);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "無法讀取這份名單。");
    } finally {
      setPending(false);
    }
  }

  async function applyRoster() {
    if (!target || !rosterPreview || rosterEntries.length === 0) return;
    setPending(true); setFormError(null);
    try {
      const result = await apiData<{ roster: RosterEntry[] }>(await fetch(`/api/classroom/courses/${encodeURIComponent(target.id)}/roster`, {
        method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ action: "replace", sourceFileName: rosterFileName, entries: rosterEntries }),
      }));
      setCourses((current) => current.map((course) => course.id === target.id ? { ...course, rosterCount: result.roster.length } : course));
      setPending(false); setDialog(null); setTarget(null); setRosterEntries([]); setRosterCurrent([]); setRosterPreview(null); setRosterFileName("");
    } catch (error) {
      setPending(false); setFormError(error instanceof Error ? error.message : "目前無法套用課程名單。");
    }
  }

  function openCreate() {
    setName(""); setAcademicYear(defaults.academicYear); setTerm(defaults.term); setGroupCount(6); setFormError(null); setDialog("create");
  }

  async function saveCourse() {
    const normalized = name.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (normalized.length < 2 || normalized.length > 80) { setFormError("課程名稱須為 2 至 80 個字元。"); return; }
    setPending(true); setFormError(null);
    try {
      if (dialog === "create") {
        const result = await apiData<{ course: ClassroomCourse }>(await fetch("/api/classroom/courses", {
          method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ name: normalized, academicYear, term, defaultGroupCount: groupCount }),
        }));
        setCourses((current) => [result.course, ...current]);
      } else if (dialog === "rename" && target) {
        const result = await apiData<{ course: ClassroomCourse }>(await fetch(`/api/classroom/courses/${encodeURIComponent(target.id)}`, {
          method: "PATCH", headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ name: normalized, expectedVersion: target.version }),
        }));
        setCourses((current) => current.map((course) => course.id === target.id ? result.course : course));
      }
      setPending(false); setDialog(null); setTarget(null); setName("");
    } catch (error) {
      setPending(false); setFormError(error instanceof Error ? error.message : "目前無法儲存課程。");
    }
  }

  async function removeCourse() {
    if (!target) return;
    setPending(true); setFormError(null);
    try {
      await apiData(await fetch(`/api/classroom/courses/${encodeURIComponent(target.id)}`, {
        method: "DELETE", headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: target.version }),
      }));
      setCourses((current) => current.filter((course) => course.id !== target.id));
      setPending(false); setDialog(null); setTarget(null);
    } catch (error) {
      setPending(false); setFormError(error instanceof Error ? error.message : "目前無法刪除課程。");
    }
  }

  if (loadCode === "ACCESS_APPROVAL_PENDING" || loadCode === "ACCESS_APPROVAL_REJECTED") {
    const rejected = loadCode === "ACCESS_APPROVAL_REJECTED";
    return <div className="course-shell"><header className="course-topbar"><span className="course-brand"><span aria-hidden="true">課</span><strong>課堂小組回應與排序</strong></span><div className="course-account"><span><strong>{identity.displayName}</strong><small>{identity.email}</small></span><a href={identity.signOutPath}><LogOut />登出</a></div></header><main className="courses-main"><section className="courses-access-status"><span className={`access-status-icon ${rejected ? "denied" : "pending"}`}>{rejected ? <ShieldCheck /> : <Clock3 />}</span><p>帳號存取</p><h2>{rejected ? "目前未核准" : "正在等待核准"}</h2><span>{loadError}</span><dl><div><dt>帳號</dt><dd>{identity.email}</dd></div><div><dt>下一步</dt><dd>{rejected ? "請聯絡系統管理員" : "核准後重新載入即可進入"}</dd></div></dl><button type="button" className="button secondary" onClick={() => void loadCourses()}>重新確認</button></section></main></div>;
  }

  return <div className="course-shell">
    <header className="course-topbar"><Link href="/courses" className="course-brand"><span aria-hidden="true">課</span><strong>課堂小組回應與排序</strong></Link><div className="course-topbar-actions">{actor?.isAdmin && <><Link href="/observability" className="course-admin-link"><Activity />營運紀錄</Link><Link href="/access-review" className="course-admin-link"><ShieldCheck />帳號審核</Link></>}<div className="course-account"><span><strong>{actor?.displayName ?? identity.displayName}</strong><small>{actor?.isAdmin ? "系統管理員" : "學生"}</small></span><a href={identity.signOutPath}><LogOut />登出</a></div></div></header>
    <main className="courses-main">
      <section className="courses-heading"><div><p>課程中心</p><h1>選擇今天的課程</h1><span>教師管理課堂與問題；學生輸入本次課堂代碼後加入分組。</span></div>{actor?.isAdmin && <button className="button primary" type="button" onClick={openCreate}><Plus />建立課程</button>}</section>
      <form className="join-code-panel" onSubmit={(event) => { event.preventDefault(); const code = joinCode.trim().toUpperCase(); if (/^[23456789A-HJ-NP-Z]{6}$/u.test(code)) window.location.assign(`/join/${code}`); }}>
        <span><KeyRound /></span><div><strong>輸入課堂代碼 <small className="test-class-code">測試代碼：DEMA26</small></strong><small>代碼正確且課堂仍開放時，系統才會加入本次課堂並進行分組。</small></div><input aria-label="六位課堂代碼" value={joinCode} maxLength={6} placeholder="例如 A7K2M6" onChange={(event) => setJoinCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/gu, ""))} /><button className="button primary" type="submit" disabled={!/^[23456789A-HJ-NP-Z]{6}$/u.test(joinCode)}>加入課堂<ArrowRight /></button>
      </form>
      {loading ? <div className="courses-loading" role="status"><span className="spinner" />正在取得課程…</div> : loadError ? <div className="courses-error" role="alert"><strong>無法取得課程</strong><span>{loadError}</span><button className="button secondary" type="button" onClick={() => void loadCourses()}>重新載入</button></div> : courses.length === 0 ? <div className="courses-empty"><BookOpen /><h2>尚未建立課程</h2><p>{actor?.isAdmin ? "建立第一門課程，即可開始今日活動。" : "請掃描教師提供的今日課堂 QR Code。"}</p></div> : <div className="course-list" role="list">
        {courses.map((course) => <article className="course-list-row" role="listitem" key={course.id}>
          <span className="course-list-icon"><BookOpen /></span>
          <div className="course-list-copy"><small>{courseTermLabel(course)}{course.isDemo ? " · 虛擬資料" : ""}</small><h2>{course.name}</h2><p><UsersRound />{course.studentCount} 位已登入 <span aria-hidden="true">·</span> 名單 {course.rosterCount} 人 <span aria-hidden="true">·</span> 問題庫 {course.questionBankCount} 題 <span aria-hidden="true">·</span> 預設 {course.defaultGroupCount} 組 <span aria-hidden="true">·</span> {course.sessionCount} 次課堂</p></div>
          <div className="course-list-status">{course.activeSessionPhase ? <span className="status-live"><i />{SESSION_PHASE_LABELS[course.activeSessionPhase]}</span> : <span><CheckCircle2 />沒有進行中活動</span>}</div>
          {actor?.isAdmin && <div className="course-list-actions"><button type="button" aria-label={`管理 ${course.name} 問題庫`} title="問題庫" onClick={() => void openQuestionBank(course)}><LibraryBig /></button><button type="button" aria-label={`管理 ${course.name} 學生名單`} title="學生名單" onClick={() => void openRoster(course)}><ListChecks /></button><button type="button" aria-label={`修改 ${course.name} 名稱`} title="修改名稱" onClick={() => { setTarget(course); setName(course.name); setFormError(null); setDialog("rename"); }}><Pencil /></button><button className="delete" type="button" aria-label={`刪除 ${course.name}`} title="刪除課程" onClick={() => { setTarget(course); setFormError(null); setDialog("delete"); }}><Trash2 /></button></div>}
          <Link href={`/courses/${encodeURIComponent(course.id)}`}>開啟課程<ArrowRight /></Link>
        </article>)}
      </div>}
    </main>
    <CourseDialog open={dialog === "create"} title="建立課程" description="設定學期與每次建立課堂時預先帶入的組數。" confirmLabel="建立課程" pending={pending} error={formError} onClose={closeDialog} onConfirm={() => void saveCourse()}>
      <label className="course-field"><span>課程名稱</span><input value={name} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} placeholder="例如：資料庫" /></label>
      <div className="course-field-row"><label className="course-field"><span>學年</span><input type="number" min={100} max={999} value={academicYear} onChange={(event) => setAcademicYear(Number(event.target.value))} /></label><label className="course-field"><span>學期</span><select value={term} onChange={(event) => setTerm(event.target.value as AcademicTerm)}><option value="1">第 1 學期</option><option value="2">第 2 學期</option><option value="summer">暑期</option></select></label></div>
      <label className="course-field"><span>預設組數</span><input type="number" min={2} max={20} value={groupCount} onChange={(event) => setGroupCount(Number(event.target.value))} /><small>建立本次課堂時仍可調整；分組後不再變更組數。</small></label>
    </CourseDialog>
    <CourseDialog open={dialog === "rename"} title="修改課程名稱" description="只會修改名稱，不影響已有學生與課堂紀錄。" confirmLabel="儲存名稱" pending={pending} error={formError} onClose={closeDialog} onConfirm={() => void saveCourse()}><label className="course-field"><span>課程名稱</span><input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label></CourseDialog>
    <CourseDialog open={dialog === "delete"} title={`刪除「${target?.name ?? ""}」？`} description="課程會從清單移除，系統仍保留操作紀錄。" confirmLabel="刪除課程" destructive pending={pending} error={formError} onClose={closeDialog} onConfirm={() => void removeCourse()} />
    <CourseDialog open={dialog === "questionBank"} title={`「${target?.name ?? ""}」問題庫`} description="依主題分類與使用情況整理問題；上課時可從這份清單直接選用。" confirmLabel={editingQuestionBankId ? "儲存修改" : "新增到問題庫"} confirmDisabled={questionBankTitle.trim().length < 2 || questionBankCategory.trim().length < 1 || questionBankPrompt.trim().length < 5 || questionBankCriteria.trim().length < 5} pending={pending} error={formError} onClose={closeDialog} onConfirm={() => void saveQuestionBankItem()}>
      <section className="question-bank-manager">
        <div className="question-bank-editor">
          <label className="course-field"><span>問題名稱</span><input value={questionBankTitle} maxLength={100} onChange={(event) => setQuestionBankTitle(event.target.value)} placeholder="例如：正規化設計判斷" /></label>
          <div className="course-field-row"><label className="course-field"><span>主題分類</span><input list="question-bank-categories" value={questionBankCategory} maxLength={50} onChange={(event) => setQuestionBankCategory(event.target.value)} placeholder="例如：正規化" /><datalist id="question-bank-categories">{questionBankCategories.map((category) => <option value={category} key={category} />)}</datalist></label><label className="course-field"><span>狀態</span><select value={questionBankStatus} onChange={(event) => setQuestionBankStatus(event.target.value as "draft" | "ready")}><option value="ready">可使用</option><option value="draft">草稿</option></select></label></div>
          <label className="course-field"><span>問題內容</span><textarea rows={4} maxLength={2000} value={questionBankPrompt} onChange={(event) => setQuestionBankPrompt(event.target.value)} /></label>
          <label className="course-field"><span>排序判準</span><textarea rows={3} maxLength={500} value={questionBankCriteria} onChange={(event) => setQuestionBankCriteria(event.target.value)} /></label>
          {editingQuestionBankId && <button className="text-button" type="button" onClick={resetQuestionBankForm}>取消修改，改為新增問題</button>}
        </div>
        <div className="question-bank-list"><header><strong>既有問題</strong><span>{visibleQuestionBankItems.length}／{questionBankItems.length} 題</span></header><div className="question-bank-filters"><input aria-label="搜尋問題庫" value={questionBankSearch} onChange={(event) => setQuestionBankSearch(event.target.value)} placeholder="搜尋名稱、內容或分類" /><div><select aria-label="分類" value={questionBankCategoryFilter} onChange={(event) => setQuestionBankCategoryFilter(event.target.value)}><option value="all">全部分類</option>{questionBankCategories.map((category) => <option value={category} key={category}>{category}</option>)}</select><select aria-label="狀態" value={questionBankStatusFilter} onChange={(event) => setQuestionBankStatusFilter(event.target.value)}><option value="all">全部狀態</option><option value="ready">可使用</option><option value="draft">草稿</option></select><select aria-label="使用情況" value={questionBankUsageFilter} onChange={(event) => setQuestionBankUsageFilter(event.target.value)}><option value="all">全部使用情況</option><option value="never">從未使用</option><option value="used">曾經使用</option></select><select aria-label="排序方式" value={questionBankSort} onChange={(event) => setQuestionBankSort(event.target.value)}><option value="updated">最近更新</option><option value="lastUsed">最近使用</option><option value="usage">使用次數</option><option value="title">問題名稱</option></select></div></div>{questionBankItems.length === 0 ? <p>尚未建立問題。完成左側內容後，即可新增第一題。</p> : visibleQuestionBankItems.length === 0 ? <p>目前沒有符合條件的問題。</p> : <ol>{visibleQuestionBankItems.map((item) => <li key={item.id}><div><span className="question-bank-item-meta"><em>{item.category}</em><i className={item.status}>{item.status === "ready" ? "可使用" : "草稿"}</i></span><strong>{item.title}</strong><p>{item.questionText}</p><small>{item.usageCount > 0 ? `已使用 ${item.usageCount} 次${item.lastUsedAt ? ` · 最近 ${new Date(item.lastUsedAt).toLocaleDateString("zh-TW")}` : ""}` : "從未使用"}</small></div><span><button type="button" aria-label={`修改 ${item.title}`} title="修改" disabled={pending} onClick={() => editQuestionBankItem(item)}><Pencil /></button><button type="button" aria-label={`移除 ${item.title}`} title="移除" disabled={pending} onClick={() => void archiveQuestionBankItem(item)}><Archive /></button></span></li>)}</ol>}</div>
      </section>
    </CourseDialog>
    <CourseDialog open={dialog === "roster"} title={`「${target?.name ?? ""}」學生白名單`} description="上傳後先預覽差異；確認套用才會取代目前名單。名單內的 NTUB 帳號登入時會自動核准，名單外才送交管理員審核。" confirmLabel="確認取代名單" confirmDisabled={!rosterPreview || rosterEntries.length === 0} pending={pending} error={formError} onClose={closeDialog} onConfirm={() => void applyRoster()}>
      <section className="roster-import">
        <label className="roster-dropzone">
          <FileSpreadsheet />
          <span><strong>選擇 Excel 或學號 TXT</strong><small>Excel 第一列需有「學號」或「Email」；姓名選填。TXT 每行一個學號，也可用 Tab 或逗號補姓名。</small></span>
          <input type="file" accept=".xlsx,.txt,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={pending} onChange={(event) => { const file = event.target.files?.[0]; if (file) void previewRosterFile(file); event.currentTarget.value = ""; }} />
          <em><Upload />選擇檔案</em>
        </label>
        <div className="roster-current"><span>目前名單</span><strong>{rosterCurrent.length} 人</strong>{rosterCurrent[0] && <small>最近來源：{rosterCurrent[0].sourceFileName}</small>}</div>
        {rosterPreview && <><div className="roster-preview" aria-label="名單匯入預覽"><span><small>匯入後</small><strong>{rosterPreview.total}</strong></span><span><small>新增</small><strong>{rosterPreview.added}</strong></span><span><small>更新</small><strong>{rosterPreview.updated}</strong></span><span><small>保留</small><strong>{rosterPreview.unchanged}</strong></span><span className={rosterPreview.removed > 0 ? "will-remove" : ""}><small>移除</small><strong>{rosterPreview.removed}</strong></span></div><div className="roster-sample"><header><strong>{rosterFileName}</strong><small>顯示前 {Math.min(8, rosterEntries.length)} 筆，共 {rosterEntries.length} 筆</small></header><ol>{rosterEntries.slice(0, 8).map((entry) => <li key={entry.studentId}><span>{entry.studentId}</span><strong>{entry.displayName || "未提供姓名"}</strong><small>{entry.email}</small></li>)}</ol></div></>}
      </section>
    </CourseDialog>
  </div>;
}
