"use client";

import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  CircleDot,
  Clock3,
  FileWarning,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  TimerReset,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClassroomPageIdentity } from "@/app/courses/classroom-page-identity";

type LogWindow = "24h" | "7d" | "30d";
type IncidentSeverity = "low" | "medium" | "high" | "critical";
type IncidentStatus = "open" | "investigating" | "resolved";
type VerificationResult = "not_run" | "passed" | "failed";

type IncidentDraft = {
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  sourceRequestId: string;
  verificationRequestId: string;
  symptom: string;
  rootCause: string;
  resolution: string;
  fixRelease: string;
  regressionCheck: string;
  regressionCommand: string;
  regressionEvidence: string;
  verificationResult: VerificationResult;
};

type Incident = IncidentDraft & {
  id: string;
  version: number;
  detectedAt: string;
  resolvedAt: string | null;
  verifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type Failure = {
  requestId: string;
  route: string;
  method: string;
  statusCode: number;
  errorCode: string | null;
  durationMs: number;
  occurredAt: string;
  securityRelevant: boolean;
};

type Snapshot = {
  generatedAt: string;
  window: LogWindow;
  windowStartedAt: string;
  release: string;
  releaseIsConfigured: boolean;
  retentionDays: number;
  excludesTestMode: true;
  summary: {
    recordedEvents: number;
    recordedSuccessfulEvents: number;
    recordedClientErrors: number;
    recordedServerErrors: number;
    recordedSuccessShare: number | null;
    recordedAverageDurationMs: number;
    recordedP95DurationMs: number;
    recordedSecurityEvents: number;
    unresolvedIncidents: number;
  };
  timeSeries: Array<{ bucket: string; total: number; clientErrors: number; serverErrors: number; averageDurationMs: number }>;
  routes: Array<{ route: string; total: number; failures: number; averageDurationMs: number; maximumDurationMs: number }>;
  errorCodes: Array<{ code: string; count: number; lastSeenAt: string }>;
  recentFailures: Failure[];
  recentSecurityEvents: Array<{
    requestId: string;
    route: string;
    method: string;
    statusCode: number;
    errorCode: string | null;
    actorKind: string;
    occurredAt: string;
  }>;
  incidents: Incident[];
};

type ApiEnvelope<T> = { data?: T; error?: { code?: string; message?: string } };

const EMPTY_INCIDENT: IncidentDraft = {
  title: "",
  severity: "medium",
  status: "open",
  sourceRequestId: "",
  verificationRequestId: "",
  symptom: "",
  rootCause: "",
  resolution: "",
  fixRelease: "",
  regressionCheck: "",
  regressionCommand: "",
  regressionEvidence: "",
  verificationResult: "not_run",
};

const WINDOW_LABELS: Record<LogWindow, string> = { "24h": "24 小時", "7d": "7 天", "30d": "30 天" };
const SEVERITY_LABELS: Record<IncidentSeverity, string> = { low: "低", medium: "中", high: "高", critical: "重大" };
const STATUS_LABELS: Record<IncidentStatus, string> = { open: "待處理", investigating: "調查中", resolved: "已結案" };
const VERIFICATION_LABELS: Record<VerificationResult, string> = { not_run: "尚未驗證", passed: "驗證通過", failed: "驗證失敗" };

async function apiData<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok || body?.data === undefined) throw new Error(body?.error?.message ?? "目前無法取得營運紀錄。");
  return body.data;
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function bucketLabel(value: string, window: LogWindow): string {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    ...(window === "24h" ? { hour: "2-digit" as const } : {}),
  }).format(new Date(value));
}

function durationLabel(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} 秒` : `${Math.round(value)} ms`;
}

function incidentDraft(incident: Incident): IncidentDraft {
  return {
    title: incident.title,
    severity: incident.severity,
    status: incident.status,
    sourceRequestId: incident.sourceRequestId ?? "",
    verificationRequestId: incident.verificationRequestId ?? "",
    symptom: incident.symptom,
    rootCause: incident.rootCause ?? "",
    resolution: incident.resolution ?? "",
    fixRelease: incident.fixRelease ?? "",
    regressionCheck: incident.regressionCheck ?? "",
    regressionCommand: incident.regressionCommand ?? "",
    regressionEvidence: incident.regressionEvidence ?? "",
    verificationResult: incident.verificationResult ?? "not_run",
  };
}

function IncidentDialog({ open, draft, incident, pending, verificationPending, currentRelease, error, onChange, onClose, onSave, onGenerateVerification }: {
  open: boolean;
  draft: IncidentDraft;
  incident: Incident | null;
  pending: boolean;
  verificationPending: boolean;
  currentRelease: string | null;
  error: string | null;
  onChange: (draft: IncidentDraft) => void;
  onClose: () => void;
  onSave: () => void;
  onGenerateVerification: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  const set = <K extends keyof IncidentDraft>(key: K, value: IncidentDraft[K]) => onChange({ ...draft, [key]: value });
  return <dialog ref={ref} className="observability-dialog" onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }}>
    <form method="dialog" onSubmit={(event) => event.preventDefault()}>
      <header>
        <div><p>{incident ? "更新追蹤紀錄" : "建立追蹤紀錄"}</p><h2>{incident ? incident.title : "記錄問題與驗證結果"}</h2></div>
        <button className="course-icon-button" type="button" aria-label="關閉" disabled={pending} onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      <div className="observability-privacy-note" role="note"><ShieldAlert aria-hidden="true" /><span><strong>只記錄排查所需資訊。</strong>請勿貼上姓名、學號、Email、密碼、Token、Cookie、學生回答或完整請求／回應本文。</span></div>
      <div className="observability-form-grid">
        <label className="course-field span-2"><span>問題名稱</span><input autoFocus maxLength={120} value={draft.title} onChange={(event) => set("title", event.target.value)} placeholder="例如：課程資料載入時回傳 503" /></label>
        <label className="course-field"><span>影響程度</span><select value={draft.severity} onChange={(event) => set("severity", event.target.value as IncidentSeverity)}><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="critical">重大</option></select></label>
        <label className="course-field"><span>處理狀態</span><select value={draft.status} onChange={(event) => set("status", event.target.value as IncidentStatus)}><option value="open">待處理</option><option value="investigating">調查中</option><option value="resolved">已結案</option></select></label>
        <label className="course-field"><span>發現問題的 Request ID</span><input maxLength={80} value={draft.sourceRequestId} onChange={(event) => set("sourceRequestId", event.target.value)} placeholder="req-…" /></label>
        <label className="course-field"><span>修正後驗證的 Request ID</span><div className="verification-request-control"><input maxLength={80} value={draft.verificationRequestId} onChange={(event) => set("verificationRequestId", event.target.value)} placeholder="req-…" /><button className="button secondary" type="button" disabled={pending || verificationPending} onClick={onGenerateVerification}>{verificationPending ? "正在產生…" : "產生驗證 Request ID"}</button></div><small>目前部署版次：{currentRelease ?? "尚未取得"}{currentRelease?.endsWith("-unverified") && "（未設定可核對的版次 ID，不能作為結案證據）"}</small></label>
        <label className="course-field span-2"><span>看到了什麼問題？</span><textarea rows={3} maxLength={2000} value={draft.symptom} onChange={(event) => set("symptom", event.target.value)} placeholder="說明時間、功能、錯誤狀態與可觀察影響；不要貼完整資料內容。" /></label>
        <label className="course-field span-2"><span>原因是什麼？</span><textarea rows={3} maxLength={2000} value={draft.rootCause} onChange={(event) => set("rootCause", event.target.value)} placeholder="說明確認過的技術原因；調查中可先留白。" /></label>
        <label className="course-field span-2"><span>如何修正或回復？</span><textarea rows={3} maxLength={2000} value={draft.resolution} onChange={(event) => set("resolution", event.target.value)} placeholder="說明採取的安全修改、回復方式與影響範圍。" /></label>
        <label className="course-field"><span>修正版次</span><input maxLength={120} value={draft.fixRelease} onChange={(event) => set("fixRelease", event.target.value)} placeholder="例如：classroom-0.3.1 / commit SHA" /></label>
        <label className="course-field"><span>驗證結果</span><select value={draft.verificationResult} onChange={(event) => set("verificationResult", event.target.value as VerificationResult)}><option value="not_run">尚未驗證</option><option value="passed">驗證通過</option><option value="failed">驗證失敗</option></select></label>
        <label className="course-field span-2"><span>回歸檢查</span><input maxLength={240} value={draft.regressionCheck} onChange={(event) => set("regressionCheck", event.target.value)} placeholder="哪個測試或操作證明問題已修正，且原有功能沒有受影響？" /></label>
        <label className="course-field span-2"><span>可重現的驗證指令</span><textarea className="code-input" rows={2} maxLength={500} spellCheck={false} value={draft.regressionCommand} onChange={(event) => set("regressionCommand", event.target.value)} placeholder="例如：npm run test:unit -- classroom-observability" /></label>
        <label className="course-field span-2"><span>回歸驗證證據</span><textarea rows={3} maxLength={2000} value={draft.regressionEvidence} onChange={(event) => set("regressionEvidence", event.target.value)} placeholder="記錄執行時間、測試範圍、預期與實際結果；不要只寫「已測試」。" /></label>
      </div>
      {draft.status === "resolved" && <p className="observability-resolution-rule">結案時，發現問題與修正後驗證的 Request ID 都必須存在且不可相同。驗證須晚於問題、結果成功，驗證紀錄的部署版次也須與修正版次完全相同，且不能是以「-unverified」結尾的未確認版次；另須填妥原因、修正內容、回歸檢查、驗證指令與證據。</p>}
      {error && <div className="course-form-error" role="alert">{error}</div>}
      <footer><button className="button secondary" type="button" disabled={pending} onClick={onClose}>取消</button><button className="button primary" type="button" disabled={pending || draft.title.trim().length < 4 || draft.symptom.trim().length < 8} onClick={onSave}>{pending ? "正在儲存…" : incident ? "儲存追蹤紀錄" : "建立追蹤紀錄"}</button></footer>
    </form>
  </dialog>;
}

function ObservabilityTopbar({ identity, adminConfirmed }: { identity: ClassroomPageIdentity; adminConfirmed: boolean }) {
  return <header className="course-topbar">
    <Link href="/courses" className="course-brand"><span aria-hidden="true">課</span><strong>課堂小組回應與排序</strong></Link>
    <div className="course-account"><span><strong>{identity.displayName}</strong><small>{adminConfirmed ? "系統管理員" : "正在確認權限"}</small></span><a href={identity.signOutPath}><LogOut aria-hidden="true" />登出</a></div>
  </header>;
}

function ObservabilityIntroduction({ loading, windowValue, snapshot, onRefresh, onCreate, onWindowChange }: {
  loading: boolean;
  windowValue: LogWindow;
  snapshot: Snapshot | null;
  onRefresh: () => void;
  onCreate: () => void;
  onWindowChange: (value: LogWindow) => void;
}) {
  return <>
    <Link className="course-back" href="/courses"><ArrowLeft aria-hidden="true" />回到課程</Link>
    <section className="observability-heading">
      <div><p>營運紀錄與問題追蹤</p><h1>系統目前發生了什麼？</h1><span>用 Request ID 連結錯誤、修正與回歸驗證，保留可核對的處理歷程。</span></div>
      <div className="observability-actions"><button className="button secondary" type="button" disabled={loading} onClick={onRefresh}><RefreshCw aria-hidden="true" />更新</button><button className="button primary" type="button" onClick={onCreate}><Plus aria-hidden="true" />記錄問題</button></div>
    </section>

    <section className="observability-method" aria-labelledby="observability-method-title">
      <Activity aria-hidden="true" />
      <div><strong id="observability-method-title">這裡呈現的是已記錄事件，不是全站流量。</strong><p>系統保留所有錯誤、異動與耗時至少 1 秒的慢請求；普通成功 GET 約取樣 10%。延遲 p95 最多使用時間範圍內最近 10,000 筆紀錄。因此延遲與比例只代表紀錄樣本，不能解讀為全站成功率或完整流量。虛擬學生模式排除，示範課管理操作仍記錄。</p></div>
      {snapshot && <dl><div><dt>保留規則</dt><dd>一般營運紀錄由請求觸發清理至 {snapshot.retentionDays} 天；被問題追蹤引用的來源／驗證紀錄保留到解除引用。</dd></div><div><dt>部署版次</dt><dd>{snapshot.release}{!snapshot.releaseIsConfigured && "（未設定可核對的版次 ID，不可作為結案證據）"}</dd></div></dl>}
    </section>

    <nav className="observability-window" aria-label="紀錄時間範圍">{(["24h", "7d", "30d"] as LogWindow[]).map((value) => <button type="button" aria-pressed={windowValue === value} className={windowValue === value ? "active" : ""} key={value} onClick={() => onWindowChange(value)}>{WINDOW_LABELS[value]}</button>)}</nav>
  </>;
}

function useIncidentEditor(snapshot: Snapshot | null, windowValue: LogWindow, load: (window: LogWindow) => Promise<void>) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingIncident, setEditingIncident] = useState<Incident | null>(null);
  const [draft, setDraft] = useState<IncidentDraft>(EMPTY_INCIDENT);
  const [saving, setSaving] = useState(false);
  const [verificationPending, setVerificationPending] = useState(false);
  const [verificationRelease, setVerificationRelease] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  function startNew(failure?: Failure) {
    setEditingIncident(null);
    setDraft(failure ? {
      ...EMPTY_INCIDENT,
      title: `${failure.errorCode ?? `HTTP ${failure.statusCode}`} · ${failure.route}`.slice(0, 120),
      sourceRequestId: failure.requestId,
      symptom: `${timeLabel(failure.occurredAt)} 記錄到 ${failure.method} ${failure.route} 回傳 HTTP ${failure.statusCode}，耗時 ${durationLabel(failure.durationMs)}。`,
      severity: failure.statusCode >= 500 ? "high" : "medium",
    } : { ...EMPTY_INCIDENT });
    setVerificationRelease(snapshot?.release ?? null);
    setSaveError(null);
    setDialogOpen(true);
  }

  function startEdit(incident: Incident) {
    setEditingIncident(incident);
    setDraft(incidentDraft(incident));
    setVerificationRelease(snapshot?.release ?? incident.fixRelease ?? null);
    setSaveError(null);
    setDialogOpen(true);
  }

  async function generateVerificationRequest() {
    setVerificationPending(true);
    setSaveError(null);
    try {
      const response = await fetch("/api/classroom/observability/verification", {
        method: "POST",
        headers: { accept: "application/json" },
      });
      const data = await apiData<{ release: string }>(response);
      const requestId = response.headers.get("x-request-id");
      if (!requestId) throw new Error("系統未回傳驗證 Request ID，請稍後再試。");
      setDraft((current) => ({ ...current, fixRelease: data.release, verificationRequestId: requestId }));
      setVerificationRelease(data.release);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "目前無法產生驗證 Request ID。");
    } finally {
      setVerificationPending(false);
    }
  }

  async function saveIncident() {
    setSaving(true);
    setSaveError(null);
    try {
      const body = {
        ...draft,
        sourceRequestId: draft.sourceRequestId.trim() || null,
        verificationRequestId: draft.verificationRequestId.trim() || null,
        ...(editingIncident ? { id: editingIncident.id, expectedVersion: editingIncident.version } : {}),
      };
      await apiData<{ incident: Incident }>(await fetch("/api/classroom/observability", {
        method: editingIncident ? "PATCH" : "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
      setDialogOpen(false);
      setEditingIncident(null);
      await load(windowValue);
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "目前無法儲存追蹤紀錄。");
    } finally {
      setSaving(false);
    }
  }

  return {
    dialogOpen, draft, editingIncident, saveError, saving, verificationPending,
    currentRelease: verificationRelease ?? snapshot?.release ?? null,
    setDraft, startNew, startEdit, saveIncident, generateVerificationRequest,
    close: () => { if (!saving && !verificationPending) setDialogOpen(false); },
  };
}

export function ObservabilityApp({ identity }: { identity: ClassroomPageIdentity }) {
  const [windowValue, setWindowValue] = useState<LogWindow>("7d");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async (selectedWindow: LogWindow) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiData<{ snapshot: Snapshot }>(await fetch(`/api/classroom/observability?window=${selectedWindow}`, { cache: "no-store", headers: { accept: "application/json" } }));
      setSnapshot(data.snapshot);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "目前無法取得營運紀錄。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(windowValue); }, 0);
    return () => window.clearTimeout(timer);
  }, [load, windowValue]);

  const trendMaximum = useMemo(() => Math.max(1, ...(snapshot?.timeSeries.map((point) => point.total) ?? [])), [snapshot]);
  const routeMaximum = useMemo(() => Math.max(1, ...(snapshot?.routes.map((route) => route.total) ?? [])), [snapshot]);
  const errorMaximum = useMemo(() => Math.max(1, ...(snapshot?.errorCodes.map((error) => error.count) ?? [])), [snapshot]);
  const editor = useIncidentEditor(snapshot, windowValue, load);

  const summary = snapshot?.summary;
  return <div className="course-shell">
    <ObservabilityTopbar identity={identity} adminConfirmed={snapshot !== null} />
    <main id="main-content" className="observability-main">
      <ObservabilityIntroduction loading={loading} windowValue={windowValue} snapshot={snapshot} onRefresh={() => void load(windowValue)} onCreate={() => editor.startNew()} onWindowChange={setWindowValue} />

      {loadError && <div className="observability-error" role="alert"><AlertTriangle aria-hidden="true" /><div><strong>無法取得營運紀錄</strong><span>{loadError}</span></div><button className="button secondary" type="button" onClick={() => void load(windowValue)}>重試</button></div>}
      {loading && !snapshot ? <div className="courses-loading" role="status"><span className="spinner" />正在取得營運紀錄…</div> : snapshot && <>
        <section className="observability-summary" aria-label={`${WINDOW_LABELS[windowValue]}已記錄事件摘要`} aria-busy={loading}>
          <article><span><Activity aria-hidden="true" /></span><p>已記錄事件</p><strong>{summary?.recordedEvents.toLocaleString("zh-TW")}</strong><small>符合保留條件的紀錄</small></article>
          <article><span><AlertTriangle aria-hidden="true" /></span><p>已記錄伺服器錯誤</p><strong>{summary?.recordedServerErrors.toLocaleString("zh-TW")}</strong><small>HTTP 5xx 紀錄</small></article>
          <article><span><TimerReset aria-hidden="true" /></span><p>紀錄樣本延遲 p95</p><strong>{durationLabel(summary?.recordedP95DurationMs ?? 0)}</strong><small>不是全站延遲</small></article>
          <article><span><ShieldAlert aria-hidden="true" /></span><p>資安相關事件</p><strong>{summary?.recordedSecurityEvents.toLocaleString("zh-TW")}</strong><small>例如拒絕存取或限流</small></article>
          <article><span><FileWarning aria-hidden="true" /></span><p>未結案問題</p><strong>{summary?.unresolvedIncidents.toLocaleString("zh-TW")}</strong><small>待處理與調查中</small></article>
        </section>

        <section className="observability-grid">
          <article className="observability-panel trend-panel">
            <header><div><h2>已記錄事件趨勢</h2><p>每個時段的保留紀錄，以及其中的 4xx 與 5xx。</p></div><span>{WINDOW_LABELS[windowValue]}</span></header>
            {snapshot.timeSeries.length === 0 ? <div className="observability-empty">這段期間尚無已記錄事件。</div> : <div className="observability-trend" role="img" aria-label={`已記錄事件趨勢，共 ${snapshot.timeSeries.length} 個時段`}>
              {snapshot.timeSeries.map((point) => {
                const errorTotal = point.clientErrors + point.serverErrors;
                return <div className="observability-trend-point" key={point.bucket} title={`${bucketLabel(point.bucket, windowValue)}：已記錄 ${point.total}，4xx ${point.clientErrors}，5xx ${point.serverErrors}`}>
                  <span className="trend-value">{point.total}</span>
                  <div className="trend-column" style={{ height: `${Math.max(4, (point.total / trendMaximum) * 100)}%` }}><span className="trend-server" style={{ height: `${point.total ? (point.serverErrors / point.total) * 100 : 0}%` }} /><span className="trend-client" style={{ height: `${point.total ? (point.clientErrors / point.total) * 100 : 0}%` }} /><span className="sr-only">其中錯誤 {errorTotal} 筆</span></div>
                  <time dateTime={point.bucket}>{bucketLabel(point.bucket, windowValue)}</time>
                </div>;
              })}
            </div>}
            <footer className="observability-legend"><span><i className="recorded" />已記錄總數</span><span><i className="client" />4xx</span><span><i className="server" />5xx</span></footer>
          </article>

          <article className="observability-panel">
            <header><div><h2>錯誤代碼</h2><p>辨識最常出現的失敗類型。</p></div><span>{snapshot.errorCodes.reduce((total, item) => total + item.count, 0)} 筆</span></header>
            {snapshot.errorCodes.length === 0 ? <div className="observability-empty">這段期間沒有已記錄錯誤。</div> : <ol className="observability-bars">{snapshot.errorCodes.map((item) => <li key={item.code}><div><strong>{item.code}</strong><span>{item.count} 筆 · 最近 {timeLabel(item.lastSeenAt)}</span></div><div className="observability-bar-track" aria-hidden="true"><i style={{ width: `${(item.count / errorMaximum) * 100}%` }} /></div></li>)}</ol>}
          </article>
        </section>

        <section className="observability-panel route-panel">
          <header><div><h2>路由紀錄</h2><p>比較已記錄事件數、失敗與紀錄樣本延遲；不代表各路由的完整呼叫量。</p></div></header>
          {snapshot.routes.length === 0 ? <div className="observability-empty">這段期間沒有路由紀錄。</div> : <div className="observability-table-wrap"><table><thead><tr><th scope="col">路由</th><th scope="col">已記錄</th><th scope="col">失敗</th><th scope="col">樣本平均</th><th scope="col">樣本最慢</th></tr></thead><tbody>{snapshot.routes.map((route) => <tr key={route.route}><th scope="row"><code>{route.route}</code><span className="route-volume" aria-hidden="true"><i style={{ width: `${(route.total / routeMaximum) * 100}%` }} /></span></th><td>{route.total}</td><td>{route.failures}</td><td>{durationLabel(route.averageDurationMs)}</td><td>{durationLabel(route.maximumDurationMs)}</td></tr>)}</tbody></table></div>}
        </section>

        <section className="observability-grid events-grid">
          <article className="observability-panel">
            <header><div><h2>近期失敗</h2><p>從 Request ID 建立可追蹤的問題紀錄。</p></div><span>{snapshot.recentFailures.length} 筆</span></header>
            {snapshot.recentFailures.length === 0 ? <div className="observability-empty"><CheckCircle2 aria-hidden="true" />這段期間沒有已記錄失敗。</div> : <ol className="observability-event-list">{snapshot.recentFailures.map((failure) => <li key={failure.requestId}><div className="event-status"><strong>{failure.statusCode}</strong><span>{failure.errorCode ?? "未提供代碼"}</span></div><div className="event-copy"><code>{failure.method} {failure.route}</code><span><time dateTime={failure.occurredAt}>{timeLabel(failure.occurredAt)}</time> · {durationLabel(failure.durationMs)}</span><small>{failure.requestId}</small></div><button type="button" title="從這筆失敗建立追蹤紀錄" aria-label={`從 Request ID ${failure.requestId} 建立問題`} onClick={() => editor.startNew(failure)}><Plus aria-hidden="true" /></button></li>)}</ol>}
          </article>

          <article className="observability-panel">
            <header><div><h2>資安相關事件</h2><p>顯示拒絕存取、限流與其他安全控制紀錄。</p></div><span>{snapshot.recentSecurityEvents.length} 筆</span></header>
            {snapshot.recentSecurityEvents.length === 0 ? <div className="observability-empty"><CheckCircle2 aria-hidden="true" />這段期間沒有資安相關紀錄。</div> : <ol className="observability-security-list">{snapshot.recentSecurityEvents.map((event) => <li key={event.requestId}><ShieldAlert aria-hidden="true" /><div><strong>{event.errorCode ?? `HTTP ${event.statusCode}`}</strong><code>{event.method} {event.route}</code><span>{event.actorKind} · <time dateTime={event.occurredAt}>{timeLabel(event.occurredAt)}</time></span><small>{event.requestId}</small></div></li>)}</ol>}
          </article>
        </section>

        <section className="observability-panel incidents-panel">
          <header><div><h2>問題追蹤</h2><p>每一筆結案都應連結發現紀錄、修正版次與可重現的回歸證據。</p></div><button className="button secondary" type="button" onClick={() => editor.startNew()}><Plus aria-hidden="true" />新增</button></header>
          {snapshot.incidents.length === 0 ? <div className="observability-empty"><CircleDot aria-hidden="true" />尚未建立問題追蹤紀錄。</div> : <div className="incident-list">{snapshot.incidents.map((incident) => <article key={incident.id}>
            <header><div className="incident-labels"><span className={`incident-status ${incident.status}`}>{STATUS_LABELS[incident.status]}</span><span className={`incident-severity ${incident.severity}`}>{SEVERITY_LABELS[incident.severity]}影響</span></div><button type="button" aria-label={`編輯 ${incident.title}`} onClick={() => editor.startEdit(incident)}><Pencil aria-hidden="true" />編輯</button></header>
            <h3>{incident.title}</h3><p>{incident.symptom}</p>
            <dl><div><dt>發現時間</dt><dd>{timeLabel(incident.detectedAt)}</dd></div><div><dt>來源 Request ID</dt><dd><code>{incident.sourceRequestId || "未連結"}</code></dd></div><div><dt>修正版次</dt><dd>{incident.fixRelease || "尚未填寫"}</dd></div><div><dt>驗證結果</dt><dd>{VERIFICATION_LABELS[incident.verificationResult ?? "not_run"]}</dd></div></dl>
            {(incident.rootCause || incident.resolution || incident.regressionEvidence) && <details><summary>查看原因、修正與回歸證據</summary><div>{incident.rootCause && <section><h4>原因</h4><p>{incident.rootCause}</p></section>}{incident.resolution && <section><h4>修正或回復</h4><p>{incident.resolution}</p></section>}{incident.regressionCheck && <section><h4>回歸檢查</h4><p>{incident.regressionCheck}</p></section>}{incident.regressionCommand && <section><h4>驗證指令</h4><pre>{incident.regressionCommand}</pre></section>}{incident.regressionEvidence && <section><h4>回歸證據</h4><p>{incident.regressionEvidence}</p></section>}{incident.verificationRequestId && <section><h4>驗證 Request ID</h4><code>{incident.verificationRequestId}</code></section>}</div></details>}
          </article>)}</div>}
        </section>

        <footer className="observability-generated"><Clock3 aria-hidden="true" />最後產生：<time dateTime={snapshot.generatedAt}>{timeLabel(snapshot.generatedAt)}</time>。虛擬學生模式排除，示範課管理操作仍記錄。</footer>
      </>}
    </main>
    <IncidentDialog open={editor.dialogOpen} draft={editor.draft} incident={editor.editingIncident} pending={editor.saving} verificationPending={editor.verificationPending} currentRelease={editor.currentRelease} error={editor.saveError} onChange={editor.setDraft} onClose={editor.close} onSave={() => void editor.saveIncident()} onGenerateVerification={() => void editor.generateVerificationRequest()} />
  </div>;
}
