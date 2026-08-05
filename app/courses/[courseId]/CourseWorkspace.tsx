"use client";

import Link from "next/link";
import { ArrowLeft, CalendarPlus, History, LogOut, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
import { courseTermLabel, type ClassroomCourse, type ClassroomRole } from "@/lib/classroom-domain";
import type { ClassroomPageIdentity } from "../classroom-page-identity";

type Payload = { actor: { displayName: string; role: ClassroomRole; isAdmin: boolean }; course: ClassroomCourse };

export function CourseWorkspace({ courseId, identity }: { courseId: string; identity: ClassroomPageIdentity }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void fetch(`/api/classroom/courses/${encodeURIComponent(courseId)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => null) as { data?: Payload; error?: { message?: string } } | null;
        if (!response.ok || !body?.data) throw new Error(body?.error?.message ?? "目前無法取得課程資料。");
        if (active) setPayload(body.data);
      })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "目前無法取得課程資料。"); });
    return () => { active = false; };
  }, [courseId]);

  return <div className="course-shell">
    <header className="course-topbar"><Link href="/courses" className="course-brand"><span aria-hidden="true">課</span><strong>課堂小組回應與排序</strong></Link><div className="course-account"><span><strong>{payload?.actor.displayName ?? identity.displayName}</strong><small>{payload?.actor.isAdmin ? "系統管理員" : "學生"}</small></span><a href={identity.signOutPath}><LogOut />登出</a></div></header>
    <main className="course-workspace-main">
      <Link className="course-back" href="/courses"><ArrowLeft />所有課程</Link>
      {error ? <div className="courses-error" role="alert"><strong>無法開啟課程</strong><span>{error}</span><Link className="button secondary" href="/courses">回到課程列表</Link></div> : !payload ? <div className="courses-loading" role="status"><span className="spinner" />正在開啟課程…</div> : <>
        <section className="course-workspace-heading"><div><p>{courseTermLabel(payload.course)}</p><h1>{payload.course.name}</h1><span>從今天的課堂開始，管理學生加入、分組與問題活動。</span></div></section>
        <section className="course-workspace-grid">
          <article className="today-class-panel"><header><span>今天</span><time dateTime={new Date().toISOString()}>{new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", month: "long", day: "numeric", weekday: "long" }).format(new Date())}</time></header><div><CalendarPlus aria-hidden="true" /><h2>今天尚未建立課堂</h2><p>建立課堂後，系統會產生學生專用的QR Code與加入網址。</p></div></article>
          <aside className="course-overview-panel"><h2>課程概況</h2><dl><div><dt><UsersRound />學生</dt><dd>0</dd></div><div><dt><History />歷次課堂</dt><dd>0</dd></div></dl></aside>
        </section>
      </>}
    </main>
  </div>;
}
