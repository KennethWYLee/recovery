"use client";

import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Clock3,
  LogOut,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  courseTermLabel,
  currentAcademicTerm,
  SESSION_PHASE_LABELS,
  type AcademicTerm,
  type ClassroomCourse,
  type ClassroomRole,
} from "@/lib/classroom-domain";
import type { ClassroomPageIdentity } from "./classroom-page-identity";

type Actor = { id: string; email: string; displayName: string; role: ClassroomRole; isAdmin: boolean };
type CoursePayload = { actor: Actor; courses: ClassroomCourse[] };
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

function CourseDialog({ open, title, description, pending, error, confirmLabel, destructive = false, children, onClose, onConfirm }: {
  open: boolean;
  title: string;
  description: string;
  pending: boolean;
  error: string | null;
  confirmLabel: string;
  destructive?: boolean;
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
      <footer><button type="button" className="button secondary" disabled={pending} onClick={onClose}>取消</button><button type="button" className={`button ${destructive ? "danger" : "primary"}`} disabled={pending} onClick={onConfirm}>{pending ? "正在處理…" : confirmLabel}</button></footer>
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
  const [dialog, setDialog] = useState<"create" | "rename" | "delete" | null>(null);
  const [target, setTarget] = useState<ClassroomCourse | null>(null);
  const [name, setName] = useState("");
  const [academicYear, setAcademicYear] = useState(defaults.academicYear);
  const [term, setTerm] = useState<AcademicTerm>(defaults.term);
  const [capacity, setCapacity] = useState(6);
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

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
    setDialog(null); setTarget(null); setName(""); setFormError(null);
  }

  function openCreate() {
    setName(""); setAcademicYear(defaults.academicYear); setTerm(defaults.term); setCapacity(6); setFormError(null); setDialog("create");
  }

  async function saveCourse() {
    const normalized = name.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (normalized.length < 2 || normalized.length > 80) { setFormError("課程名稱須為 2 至 80 個字元。"); return; }
    setPending(true); setFormError(null);
    try {
      if (dialog === "create") {
        const result = await apiData<{ course: ClassroomCourse }>(await fetch("/api/classroom/courses", {
          method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ name: normalized, academicYear, term, defaultGroupCapacity: capacity }),
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
    <header className="course-topbar"><Link href="/courses" className="course-brand"><span aria-hidden="true">課</span><strong>課堂小組回應與排序</strong></Link><div className="course-topbar-actions">{actor?.isAdmin && <Link href="/access-review" className="course-admin-link"><ShieldCheck />帳號審核</Link>}<div className="course-account"><span><strong>{actor?.displayName ?? identity.displayName}</strong><small>{actor?.isAdmin ? "系統管理員" : "學生"}</small></span><a href={identity.signOutPath}><LogOut />登出</a></div></div></header>
    <main className="courses-main">
      <section className="courses-heading"><div><p>課程中心</p><h1>選擇今天的課程</h1><span>開啟一門課後，再建立本次問題、QR Code 與分組。</span></div>{actor?.isAdmin && <button className="button primary" type="button" onClick={openCreate}><Plus />建立課程</button>}</section>
      {loading ? <div className="courses-loading" role="status"><span className="spinner" />正在取得課程…</div> : loadError ? <div className="courses-error" role="alert"><strong>無法取得課程</strong><span>{loadError}</span><button className="button secondary" type="button" onClick={() => void loadCourses()}>重新載入</button></div> : courses.length === 0 ? <div className="courses-empty"><BookOpen /><h2>尚未建立課程</h2><p>{actor?.isAdmin ? "建立第一門課程，即可開始今日活動。" : "請掃描教師提供的今日課堂 QR Code。"}</p></div> : <div className="course-list" role="list">
        {courses.map((course) => <article className="course-list-row" role="listitem" key={course.id}>
          <span className="course-list-icon"><BookOpen /></span>
          <div className="course-list-copy"><small>{courseTermLabel(course)}</small><h2>{course.name}</h2><p><UsersRound />{course.studentCount} 位學生 <span aria-hidden="true">·</span> 每組預設 {course.defaultGroupCapacity} 人 <span aria-hidden="true">·</span> {course.sessionCount} 次課堂</p></div>
          <div className="course-list-status">{course.activeSessionPhase ? <span className="status-live"><i />{SESSION_PHASE_LABELS[course.activeSessionPhase]}</span> : <span><CheckCircle2 />沒有進行中活動</span>}</div>
          {actor?.isAdmin && <div className="course-list-actions"><button type="button" aria-label={`修改 ${course.name} 名稱`} onClick={() => { setTarget(course); setName(course.name); setFormError(null); setDialog("rename"); }}><Pencil /></button><button className="delete" type="button" aria-label={`刪除 ${course.name}`} onClick={() => { setTarget(course); setFormError(null); setDialog("delete"); }}><Trash2 /></button></div>}
          <Link href={`/courses/${encodeURIComponent(course.id)}`}>開啟課程<ArrowRight /></Link>
        </article>)}
      </div>}
    </main>
    <CourseDialog open={dialog === "create"} title="建立課程" description="設定學期與平均分組時使用的每組人數上限。" confirmLabel="建立課程" pending={pending} error={formError} onClose={closeDialog} onConfirm={() => void saveCourse()}>
      <label className="course-field"><span>課程名稱</span><input value={name} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} placeholder="例如：資料庫" /></label>
      <div className="course-field-row"><label className="course-field"><span>學年</span><input type="number" min={100} max={999} value={academicYear} onChange={(event) => setAcademicYear(Number(event.target.value))} /></label><label className="course-field"><span>學期</span><select value={term} onChange={(event) => setTerm(event.target.value as AcademicTerm)}><option value="1">第 1 學期</option><option value="2">第 2 學期</option><option value="summer">暑期</option></select></label></div>
      <label className="course-field"><span>每組人數上限</span><input type="number" min={2} max={20} value={capacity} onChange={(event) => setCapacity(Number(event.target.value))} /><small>例如 50 人、上限 6 人，系統會建立 9 組並盡量平均分配。</small></label>
    </CourseDialog>
    <CourseDialog open={dialog === "rename"} title="修改課程名稱" description="只會修改名稱，不影響已有學生與課堂紀錄。" confirmLabel="儲存名稱" pending={pending} error={formError} onClose={closeDialog} onConfirm={() => void saveCourse()}><label className="course-field"><span>課程名稱</span><input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label></CourseDialog>
    <CourseDialog open={dialog === "delete"} title={`刪除「${target?.name ?? ""}」？`} description="課程會從清單移除，系統仍保留操作紀錄。" confirmLabel="刪除課程" destructive pending={pending} error={formError} onClose={closeDialog} onConfirm={() => void removeCourse()} />
  </div>;
}
