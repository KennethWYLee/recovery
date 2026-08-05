"use client";

import Link from "next/link";
import { CheckCircle2, Clock3, LogOut, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ClassroomSessionSnapshot } from "@/lib/classroom-domain";
import type { ClassroomPageIdentity } from "@/app/courses/classroom-page-identity";

type Envelope = {
  data?: { snapshot: ClassroomSessionSnapshot };
  error?: { code?: string; message?: string };
};

export function JoinSessionApp({ joinCode, identity }: { joinCode: string; identity: ClassroomPageIdentity }) {
  const [state, setState] = useState<"joining" | "pending" | "error" | "joined">("joining");
  const [message, setMessage] = useState("正在加入課堂…");
  const [courseId, setCourseId] = useState<string | null>(null);

  const join = useCallback(async () => {
    setState("joining");
    setMessage("正在加入課堂…");
    const response = await fetch(`/api/classroom/join/${encodeURIComponent(joinCode)}`, {
      method: "POST",
      headers: { accept: "application/json" },
    });
    const body = await response.json().catch(() => null) as Envelope | null;
    if (!response.ok || !body?.data) {
      if (body?.error?.code === "ACCESS_APPROVAL_PENDING") {
        setState("pending");
        setMessage(body.error.message ?? "帳號正在等待核准。");
        return;
      }
      setState("error");
      setMessage(body?.error?.message ?? "目前無法加入這次課堂。");
      return;
    }
    setState("joined");
    setCourseId(body.data.snapshot.session.courseId);
    setMessage("報到完成，正在進入課堂…");
  }, [joinCode]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void join(); }, 0);
    return () => window.clearTimeout(timer);
  }, [join]);
  useEffect(() => {
    if (state !== "joined" || !courseId) return;
    const timer = window.setTimeout(() => { window.location.assign(`/courses/${encodeURIComponent(courseId)}`); }, 600);
    return () => window.clearTimeout(timer);
  }, [courseId, state]);

  const Icon = state === "pending" ? Clock3 : state === "error" ? ShieldAlert : state === "joined" ? CheckCircle2 : RefreshCw;
  return <div className="course-shell">
    <header className="course-topbar"><Link href="/courses" className="course-brand"><span aria-hidden="true">課</span><strong>課堂小組回應與排序</strong></Link><div className="course-account"><span><strong>{identity.displayName}</strong><small>{identity.email}</small></span><a href={identity.signOutPath}><LogOut />登出</a></div></header>
    <main className="join-session-main">
      <section className={`join-session-card ${state}`}>
        <span className="join-session-icon"><Icon className={state === "joining" ? "spin-icon" : ""} /></span>
        <p>課堂代碼 {joinCode.toUpperCase()}</p>
        <h1>{state === "joining" ? "正在確認身分" : state === "pending" ? "等待系統管理員核准" : state === "joined" ? "已加入今日課堂" : "無法加入課堂"}</h1>
        <span>{message}</span>
        {state === "error" && <button className="button secondary" type="button" onClick={() => void join()}><RefreshCw />重新嘗試</button>}
        {state === "pending" && <p className="join-session-note">核准後重新掃描 QR Code 或按下重新嘗試即可加入。</p>}
        {state === "pending" && <button className="button secondary" type="button" onClick={() => void join()}><RefreshCw />重新嘗試</button>}
      </section>
    </main>
  </div>;
}
