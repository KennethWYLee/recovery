"use client";

import Link from "next/link";
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  LogOut,
  Pencil,
  Plus,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { courseTermLabel, type ClassroomCourse, type ClassroomRole } from "@/lib/classroom-domain";
import type { ClassroomPageIdentity } from "./classroom-page-identity";

type Actor = { id: string; email: string; displayName: string; role: ClassroomRole };
type CoursePayload = { actor: Actor; courses: ClassroomCourse[] };
type ApiEnvelope<T> = { data?: T; error?: { code?: string; message?: string } };

async function apiData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || payload?.data === undefined) {
    throw new Error(payload?.error?.message ?? "目前無法取得課程資料。");
  }
  return payload.data;
}

function CourseDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  pending,
  error,
  children,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  pending: boolean;
  error: string | null;
  children?: React.ReactNode;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className="course-dialog" onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }} onClose={() => { if (open && !pending) onClose(); }}>
    <form method="dialog" onSubmit={(event) => event.preventDefault()}>
      <header><div><h2>{title}</h2><p>{description}</p></div><button type="button" className="course-icon-button" aria-label="關閉" disabled={pending} onClick={onClose}><X /></button></header>
      {children}
      {error && <div className="course-form-error" role="alert">{error}</div>}
      <footer><button type="button" className="button secondary" disabled={pending} onClick={onClose}>取消</button><button type="button" className={`button ${destructive ? "danger" : "primary"}`} disabled={pending} onClick={onConfirm}>{pending ? "正在處理…" : confirmLabel}</button></footer>
    </form>
  </dialog>;
}

export function CoursesApp({ identity }: { identity: ClassroomPageIdentity }) {
  const [actor, setActor] = useState<Actor | null>(null);
  const [courses, setCourses] = useState<ClassroomCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"create" | "rename" | "delete" | null>(null);
  const [target, setTarget] = useState<ClassroomCourse | null>(null);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function loadCourses() {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiData<CoursePayload>(await fetch("/api/classroom/courses", { cache: "no-store", headers: { accept: "application/json" } }));
      setActor(data.actor);
      setCourses(data.courses);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "目前無法取得課程資料。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void fetch("/api/classroom/courses", { cache: "no-store", headers: { accept: "application/json" } })
      .then((response) => apiData<CoursePayload>(response))
      .then((data) => {
        if (!active) return;
        setActor(data.actor);
        setCourses(data.courses);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "目前無法取得課程資料。");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  function closeDialog(force = false) {
    if (pending && !force) return;
    setDialog(null);
    setTarget(null);
    setName("");
    setFormError(null);
  }

  function openCreate() {
    setName("");
    setFormError(null);
    setDialog("create");
  }

  function openRename(course: ClassroomCourse) {
    setTarget(course);
    setName(course.name);
    setFormError(null);
    setDialog("rename");
  }

  function openDelete(course: ClassroomCourse) {
    setTarget(course);
    setFormError(null);
    setDialog("delete");
  }

  async function saveCourse() {
    const normalized = name.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (normalized.length < 2 || normalized.length > 80) {
      setFormError("課程名稱須為2至80個字元。");
      return;
    }
    setPending(true);
    setFormError(null);
    try {
      if (dialog === "create") {
        const result = await apiData<{ course: ClassroomCourse }>(await fetch("/api/classroom/courses", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ name: normalized }),
        }));
        setCourses((current) => [result.course, ...current]);
      } else if (dialog === "rename" && target) {
        const result = await apiData<{ course: ClassroomCourse }>(await fetch(`/api/classroom/courses/${encodeURIComponent(target.id)}`, {
          method: "PATCH",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ name: normalized, expectedVersion: target.version }),
        }));
        setCourses((current) => current.map((course) => course.id === result.course.id ? result.course : course));
      }
      closeDialog(true);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "目前無法儲存課程。");
    } finally {
      setPending(false);
    }
  }

  async function removeCourse() {
    if (!target) return;
    setPending(true);
    setFormError(null);
    try {
      await apiData<{ deleted: boolean; courseId: string }>(await fetch(`/api/classroom/courses/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: target.version }),
      }));
      setCourses((current) => current.filter((course) => course.id !== target.id));
      closeDialog(true);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "目前無法刪除課程。");
    } finally {
      setPending(false);
    }
  }

  const teacher = actor?.role === "teacher";
  const displayName = actor?.displayName ?? identity.displayName;
  return <div className="course-shell">
    <header className="course-topbar">
      <Link href="/courses" className="course-brand" aria-label="回到我的課程"><span aria-hidden="true">課</span><strong>課堂小組回應與排序</strong></Link>
      <div className="course-account"><span><strong>{displayName}</strong><small>{actor?.role === "teacher" ? "教師" : "學生"}</small></span><a href={identity.signOutPath}><LogOut aria-hidden="true" />登出</a></div>
    </header>
    <main id="main-content" className="courses-main">
      <section className="courses-heading">
        <div><p>115學年度 第1學期</p><h1>我的課程</h1><span>{teacher ? "選擇今天要進行的課程，或建立一門新課程。" : "選擇要進入的課程。"}</span></div>
        {teacher && <button type="button" className="button primary" onClick={openCreate}><Plus aria-hidden="true" />新增課程</button>}
      </section>

      {loading ? <div className="courses-loading" role="status"><span className="spinner" />正在整理您的課程…</div> : loadError ? <div className="courses-error" role="alert"><strong>無法取得課程</strong><span>{loadError}</span><button className="button secondary" type="button" onClick={() => void loadCourses()}>重新載入</button></div> : courses.length === 0 ? <section className="courses-empty"><BookOpen aria-hidden="true" /><h2>{teacher ? "建立第一門課程" : "目前還沒有可進入的課程"}</h2><p>{teacher ? "課程建立後，就能安排課堂場次、學生與分組。" : "掃描教師提供的課堂QR Code後，課程會出現在這裡。"}</p>{teacher && <button className="button primary" type="button" onClick={openCreate}><Plus />新增課程</button>}</section> : <section className="course-grid" aria-label="課程列表">
        {courses.map((course, index) => <article className="course-card" key={course.id} style={{ "--course-sequence": index } as React.CSSProperties}>
          <div className="course-card-accent" aria-hidden="true" />
          <header><span><BookOpen aria-hidden="true" /></span>{teacher && <div className="course-card-actions"><button type="button" aria-label={`修改${course.name}名稱`} onClick={() => openRename(course)}><Pencil /></button><button type="button" className="delete" aria-label={`刪除${course.name}`} onClick={() => openDelete(course)}><Trash2 /></button></div>}</header>
          <div className="course-card-copy"><small>{courseTermLabel(course)}</small><h2>{course.name}</h2><p>尚未建立今天的課堂</p></div>
          <dl><div><dt><CalendarDays />課堂活動</dt><dd>0</dd></div><div><dt><UsersRound />學生</dt><dd>0</dd></div></dl>
          <Link href={`/courses/${encodeURIComponent(course.id)}`}><span>進入課程</span><ArrowRight aria-hidden="true" /></Link>
        </article>)}
      </section>}
    </main>

    <CourseDialog open={dialog === "create"} title="新增課程" description="建立後會加入目前學期的課程列表。" confirmLabel="建立課程" pending={pending} error={formError} onClose={closeDialog} onConfirm={() => void saveCourse()}>
      <label className="course-field"><span>課程名稱</span><input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveCourse(); } }} placeholder="例如：資料視覺化" /></label>
    </CourseDialog>
    <CourseDialog open={dialog === "rename"} title="修改課程名稱" description="新的名稱會同步顯示在課程入口及後續課堂活動。" confirmLabel="儲存名稱" pending={pending} error={formError} onClose={closeDialog} onConfirm={() => void saveCourse()}>
      <label className="course-field"><span>課程名稱</span><input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void saveCourse(); } }} /></label>
    </CourseDialog>
    <CourseDialog open={dialog === "delete"} title={`刪除「${target?.name ?? ""}」？`} description="課程會從列表移除；系統仍保留操作紀錄，不會以刪除方式掩蓋歷史異動。" confirmLabel="刪除課程" destructive pending={pending} error={formError} onClose={closeDialog} onConfirm={() => void removeCourse()} />
  </div>;
}
