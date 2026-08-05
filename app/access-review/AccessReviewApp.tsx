"use client";

import Link from "next/link";
import { ArrowLeft, Check, Clock3, LogOut, RefreshCw, ShieldCheck, UserCheck, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ClassroomAccessRequest, ClassroomAllowlistEntry, ClassroomActor } from "@/db/classroom";
import type { ClassroomPageIdentity } from "@/app/courses/classroom-page-identity";

type AccessPayload = {
  actor: ClassroomActor;
  requests: ClassroomAccessRequest[];
  allowlist: ClassroomAllowlistEntry[];
};

type ApiEnvelope<T> = { data?: T; error?: { message?: string } };

async function apiData<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || body?.data === undefined) throw new Error(body?.error?.message ?? "目前無法取得登入申請。");
  return body.data;
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AccessReviewApp({ identity }: { identity: ClassroomPageIdentity }) {
  const [payload, setPayload] = useState<AccessPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewingId, setReviewingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPayload(await apiData<AccessPayload>(await fetch("/api/classroom/access-requests", {
        cache: "no-store",
        headers: { accept: "application/json" },
      })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "目前無法取得登入申請。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/classroom/access-requests", { cache: "no-store", headers: { accept: "application/json" } })
      .then((response) => apiData<AccessPayload>(response))
      .then((data) => { if (active) setPayload(data); })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "目前無法取得登入申請。"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function review(request: ClassroomAccessRequest, action: "approve" | "reject") {
    setReviewingId(request.id);
    setError(null);
    try {
      await apiData<{ request: ClassroomAccessRequest }>(await fetch(`/api/classroom/access-requests/${encodeURIComponent(request.id)}`, {
        method: "PATCH",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ action, expectedVersion: request.version }),
      }));
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "目前無法完成審核。");
    } finally {
      setReviewingId(null);
    }
  }

  const pending = payload?.requests.filter((request) => request.status === "pending") ?? [];
  const decided = payload?.requests.filter((request) => request.status !== "pending").slice(0, 12) ?? [];

  return <div className="course-shell">
    <header className="course-topbar">
      <Link href="/courses" className="course-brand"><span aria-hidden="true">課</span><strong>課堂小組回應與排序</strong></Link>
      <div className="course-account"><span><strong>{payload?.actor.displayName ?? identity.displayName}</strong><small>系統管理員</small></span><a href={identity.signOutPath}><LogOut aria-hidden="true" />登出</a></div>
    </header>
    <main id="main-content" className="access-review-main">
      <Link className="course-back" href="/courses"><ArrowLeft aria-hidden="true" />回到課程</Link>
      <section className="access-review-heading">
        <div><p>帳號與白名單</p><h1>登入審核</h1><span>確認申請人後，允許的帳號才可進入課程系統。</span></div>
        <button className="button secondary" type="button" disabled={loading} onClick={() => void load()}><RefreshCw aria-hidden="true" />更新申請</button>
      </section>

      {error && <div className="access-review-alert" role="alert">{error}</div>}
      {loading && !payload ? <div className="courses-loading" role="status"><span className="spinner" />正在取得登入申請…</div> : payload && <>
        <section className="access-review-summary" aria-label="登入審核摘要">
          <div><span><Clock3 aria-hidden="true" /></span><p>等待審核</p><strong>{pending.length}</strong></div>
          <div><span><UserCheck aria-hidden="true" /></span><p>白名單帳號</p><strong>{payload.allowlist.length}</strong></div>
          <div><span><ShieldCheck aria-hidden="true" /></span><p>可申請網域</p><strong>@ntub.edu.tw</strong></div>
        </section>

        <section className="access-review-section">
          <header><div><h2>等待審核</h2><p>允許前，請先確認姓名與學校信箱是否合理。</p></div><span>{pending.length} 筆</span></header>
          {pending.length === 0 ? <div className="access-review-empty"><Check aria-hidden="true" /><strong>目前沒有待審核申請</strong><span>新的 NTUB 帳號完成登入後，會自動出現在這裡。</span></div> : <div className="access-request-list">
            {pending.map((request) => <article key={request.id} className="access-request-card">
              <div className="access-request-person"><span aria-hidden="true">{request.displayName.slice(0, 1).toUpperCase()}</span><div><strong>{request.displayName}</strong><small>{request.email}</small></div></div>
              <dl><div><dt>首次申請</dt><dd>{timeLabel(request.requestedAt)}</dd></div><div><dt>最近嘗試</dt><dd>{timeLabel(request.lastRequestedAt)}</dd></div></dl>
              <div className="access-request-actions"><button className="button danger" type="button" disabled={reviewingId === request.id} onClick={() => void review(request, "reject")}><X aria-hidden="true" />拒絕</button><button className="button primary" type="button" disabled={reviewingId === request.id} onClick={() => void review(request, "approve")}><Check aria-hidden="true" />允許登入</button></div>
            </article>)}
          </div>}
        </section>

        <section className="access-review-grid">
          <section className="access-review-section compact"><header><div><h2>目前白名單</h2><p>下列帳號已可進入系統。</p></div></header><div className="access-simple-list">{payload.allowlist.length === 0 ? <p>尚未核准任何帳號。</p> : payload.allowlist.map((entry) => <div key={entry.email}><span><strong>{entry.displayName}</strong><small>{entry.email}</small></span><time dateTime={entry.approvedAt}>{timeLabel(entry.approvedAt)}</time></div>)}</div></section>
          <section className="access-review-section compact"><header><div><h2>最近審核紀錄</h2><p>顯示最近 12 筆處理結果。</p></div></header><div className="access-simple-list">{decided.length === 0 ? <p>尚無審核紀錄。</p> : decided.map((request) => <div key={request.id}><span><strong>{request.displayName}</strong><small>{request.status === "approved" ? "已允許" : "已拒絕"} · {request.email}</small></span>{request.reviewedAt && <time dateTime={request.reviewedAt}>{timeLabel(request.reviewedAt)}</time>}</div>)}</div></section>
        </section>
      </>}
    </main>
  </div>;
}
