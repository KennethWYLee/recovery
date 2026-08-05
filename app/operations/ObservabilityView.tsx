"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ObservabilitySnapshot, ObservabilityWindow } from "@/db/operations-telemetry";
import type { GuidedTourScenario } from "@/lib/operations-guided-tour";
import { observabilityRoleFocus } from "@/lib/observability-role-focus";

export type ObservabilityDisplayError = { message: string; requestId?: string };

const WINDOW_LABEL: Record<ObservabilityWindow, string> = { "24h": "24小時", "7d": "7天", "30d": "30天" };

function formatDateTime(value: string | null, timeZone: string): string {
  if (!value) return "尚無資料";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "時間格式錯誤";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function formatBucket(value: string, timeZone: string, unit: "hour" | "day"): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone,
    month: "numeric",
    day: "numeric",
    ...(unit === "hour" ? { hour: "2-digit", hour12: false } : {}),
  }).format(date);
}

function metricValue(value: number | null, unit = ""): string {
  return value == null ? "—" : `${value.toLocaleString("zh-TW")}${unit}`;
}

export function ObservabilityView({
  data,
  loading,
  error,
  range,
  onRangeChange,
  retry,
  timeZone,
  role,
  tourScenario,
}: {
  data: ObservabilitySnapshot | null;
  loading: boolean;
  error: ObservabilityDisplayError | null;
  range: ObservabilityWindow;
  onRangeChange: (range: ObservabilityWindow) => void;
  retry: () => void;
  timeZone: string;
  role: string;
  tourScenario?: GuidedTourScenario | null;
}) {
  const focus = observabilityRoleFocus(role);
  const chartData = data?.timeSeries.map((point) => ({
    ...point,
    label: formatBucket(point.bucket, timeZone, data.bucketUnit),
  })) ?? [];
  const maxRouteRequests = Math.max(1, ...(data?.routes.map((item) => item.requests) ?? [1]));
  const totalStatuses = Math.max(1, ...(data ? [data.summary.totalRequests] : [1]));
  const deploymentLabel = tourScenario && data
    ? formatBucket(tourScenario.deployment.occurredAt, timeZone, data.bucketUnit)
    : null;
  return (
    <div className="view-stack observability-view">
      <header className="page-header observability-heading">
        <div>
          <p className="eyebrow">SYSTEM OBSERVABILITY</p>
          <h1>系統觀測</h1>
          <p>用結構化請求紀錄回答流量、錯誤、延遲與問題來源；不保存請求內容、權杖或使用者Email。</p>
        </div>
        <div className="range-switcher" aria-label="觀測期間">
          {(["24h", "7d", "30d"] as const).map((option) => (
            <button key={option} type="button" className={range === option ? "active" : ""} aria-pressed={range === option} onClick={() => onRangeChange(option)}>{WINDOW_LABEL[option]}</button>
          ))}
        </div>
      </header>

      <section className="role-focus-card" aria-labelledby="role-focus-title">
        <span>本次角色重點</span><div><h2 id="role-focus-title">{focus.title}</h2><p>{focus.description} 可先問：「{focus.verificationQuestion}」</p></div>
      </section>

      {error && <div className="error-banner" role="alert"><div><strong>無法取得系統觀測資料</strong><span>{error.message}</span>{error.requestId && <code>Request ID: {error.requestId}</code>}</div><button className="button secondary compact" type="button" onClick={retry}>重試</button></div>}
      {data?.coverage.hasSimulatedData && <div className="simulation-notice" role="status"><strong>包含模擬資料</strong><span>{data.coverage.simulatedEvents.toLocaleString("zh-TW")}筆資料只用於操作演練與圖表測試，不代表正式環境監控結果。</span></div>}
      {tourScenario && <section className="tour-update-signal" data-tour="update-signal" aria-labelledby="tour-update-signal-title">
        <div><span>模擬情境 · 更新紀錄</span><h2 id="tour-update-signal-title">{tourScenario.deployment.version}</h2><p>{formatDateTime(tourScenario.deployment.occurredAt, timeZone)} 完成更新；第一批異常在 18 分鐘後出現。</p></div>
        <dl><div><dt>更新時間</dt><dd>{formatDateTime(tourScenario.deployment.occurredAt, timeZone)}</dd></div><div><dt>異常開始</dt><dd>{formatDateTime(tourScenario.opening.occurredAt, timeZone)}</dd></div><div><dt>判讀原則</dt><dd>時間接近是線索，仍須比對錯誤與延遲。</dd></div></dl>
      </section>}

      {loading && !data ? <div className="workspace-loading" role="status"><span className="spinner" />正在整理系統觀測資料…</div> : !data || data.summary.totalRequests === 0 ? (
        <section className="panel observability-empty"><h2>尚未累積可分析的請求紀錄</h2><p>系統會從後續API請求開始保存不含內容與身分資料的結構化紀錄。模擬資料必須透過受控的本機資料產生程序加入。</p></section>
      ) : (
        <>
          <section className="observability-metrics" aria-label={`${WINDOW_LABEL[data.window]}系統觀測摘要`}>
            <article><span>請求總數</span><strong>{data.summary.totalRequests.toLocaleString("zh-TW")}</strong><small>最後觀測 {formatDateTime(data.summary.lastObservedAt, timeZone)}</small></article>
            <article className={data.summary.serverErrors > 0 ? "critical" : ""}><span>伺服器錯誤率</span><strong>{data.summary.errorRatePercent.toFixed(2)}%</strong><small>{data.summary.serverErrors.toLocaleString("zh-TW")}筆5xx</small></article>
            <article><span>P95延遲</span><strong>{metricValue(data.summary.p95LatencyMs, " ms")}</strong><small>P50 {metricValue(data.summary.p50LatencyMs, " ms")}</small></article>
            <article><span>拒絕請求</span><strong>{data.summary.deniedRequests.toLocaleString("zh-TW")}</strong><small>HTTP 403，不等同系統故障</small></article>
          </section>

          <section className="observability-chart-grid" data-tour={tourScenario ? "trend-comparison" : undefined}>
            <article className="panel chart-panel">
              <header><div><p className="eyebrow">TRAFFIC & ERRORS</p><h2>請求與錯誤趨勢</h2></div><span>{formatDateTime(data.from, timeZone)}至{formatDateTime(data.to, timeZone)}</span></header>
              <div className="chart-frame" role="img" aria-label={`${WINDOW_LABEL[data.window]}共${data.summary.totalRequests}筆請求、${data.summary.clientErrors}筆4xx、${data.summary.serverErrors}筆5xx`}>
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <AreaChart data={chartData} margin={{ top: 10, right: 12, left: -12, bottom: 0 }}>
                    <defs><linearGradient id="traffic-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#256f68" stopOpacity={0.30}/><stop offset="95%" stopColor="#256f68" stopOpacity={0.02}/></linearGradient></defs>
                    <CartesianGrid stroke="#e7e2da" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6c665e" }} minTickGap={24} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#6c665e" }} />
                    <Tooltip />
                    <Legend />
                    {deploymentLabel && <ReferenceLine x={deploymentLabel} stroke="#6941c6" strokeDasharray="4 4" label={{ value: "系統更新", fill: "#6941c6", fontSize: 11, position: "insideTopRight" }} />}
                    <Area name="全部請求" type="monotone" dataKey="requests" stroke="#256f68" fill="url(#traffic-fill)" strokeWidth={2} isAnimationActive={false} />
                    <Line name="4xx" type="monotone" dataKey="clientErrors" stroke="#b7791f" strokeWidth={2} strokeDasharray="6 4" dot={false} isAnimationActive={false} />
                    <Line name="5xx" type="monotone" dataKey="serverErrors" stroke="#c2413b" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </article>
            <article className="panel chart-panel">
              <header><div><p className="eyebrow">LATENCY</p><h2>平均回應時間</h2></div><span>全期間P95 {metricValue(data.summary.p95LatencyMs, " ms")}</span></header>
              <div className="chart-frame" role="img" aria-label={`平均延遲${metricValue(data.summary.averageLatencyMs, "毫秒")}，P95延遲${metricValue(data.summary.p95LatencyMs, "毫秒")}`}>
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <LineChart data={chartData} margin={{ top: 10, right: 12, left: -4, bottom: 0 }}>
                    <CartesianGrid stroke="#e7e2da" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6c665e" }} minTickGap={24} />
                    <YAxis unit="ms" tick={{ fontSize: 11, fill: "#6c665e" }} />
                    <Tooltip />
                    {deploymentLabel && <ReferenceLine x={deploymentLabel} stroke="#6941c6" strokeDasharray="4 4" label={{ value: "系統更新", fill: "#6941c6", fontSize: 11, position: "insideTopRight" }} />}
                    <Line name="平均延遲" type="monotone" dataKey="averageLatencyMs" connectNulls stroke="#4a5d8f" strokeWidth={2.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </article>
          </section>

          <div className="observability-investigation-stack" data-tour={tourScenario ? "problem-scope" : undefined}>
          <section className="observability-detail-grid">
            <article className="panel route-analysis-panel">
              <header><div><p className="eyebrow">ROUTE ANALYSIS</p><h2>主要API路徑</h2></div><span>依請求量排序</span></header>
              <div className="route-analysis-list">
                {data.routes.map((route) => <div key={route.route}><div><code>{route.route}</code><span>{route.requests}筆 · {route.averageLatencyMs ?? "—"} ms · {route.serverErrors}筆5xx</span></div><div className="route-volume-track" aria-hidden="true"><span style={{ width: `${Math.max(3, route.requests / maxRouteRequests * 100)}%` }} /></div></div>)}
              </div>
            </article>
            <article className="panel status-analysis-panel">
              <header><div><p className="eyebrow">RESULTS</p><h2>回應結果分布</h2></div></header>
              <div className="status-distribution" role="img" aria-label={data.statusClasses.map((item) => `${item.statusClass} ${item.count}筆`).join("、")}>
                {data.statusClasses.filter((item) => item.count > 0).map((item) => <span key={item.statusClass} className={`status-${item.statusClass[0]}`} style={{ width: `${item.count / totalStatuses * 100}%` }} title={`${item.statusClass} ${item.count}筆`} />)}
              </div>
              <dl className="status-legend">{data.statusClasses.map((item) => <div key={item.statusClass}><dt><span className={`legend-dot status-${item.statusClass[0]}`} />{item.statusClass}</dt><dd>{item.count.toLocaleString("zh-TW")}</dd></div>)}</dl>
              <div className="problem-code-list"><h3>常見問題代碼</h3>{data.problemCodes.length > 0 ? data.problemCodes.map((item) => <div key={item.code}><code>{item.code}</code><strong>{item.count}</strong></div>) : <p>目前期間沒有問題代碼。</p>}</div>
            </article>
          </section>

          <section className="panel telemetry-log-panel" aria-labelledby="recent-errors-title">
            <header><div><p className="eyebrow">REQUEST LOG</p><h2 id="recent-errors-title">最近錯誤請求</h2></div><span>以request ID連結後續查核</span></header>
            {data.recentErrors.length > 0 ? <div className="table-scroll" role="region" aria-label="最近錯誤請求，可水平捲動" tabIndex={0}><table className="data-table telemetry-table"><thead><tr><th>時間</th><th>路徑</th><th>結果</th><th>問題代碼</th><th>延遲</th><th>版本</th><th>Request ID</th><th>來源</th></tr></thead><tbody>{data.recentErrors.map((item) => <tr key={item.requestId}><td>{formatDateTime(item.occurredAt, timeZone)}</td><td><code>{item.method} {item.route}</code></td><td><span className={`result-badge ${item.status >= 500 ? "failure" : "denied"}`}>{item.status}</span></td><td><code>{item.problemCode ?? "—"}</code></td><td>{item.latencyMs} ms</td><td><code>{item.deploymentVersion}</code></td><td><code>{item.requestId}</code></td><td>{item.source === "simulated" ? <span className="simulation-badge">模擬</span> : "系統"}</td></tr>)}</tbody></table></div> : <p className="no-error-copy">目前期間沒有4xx或5xx紀錄。</p>}
          </section>
          </div>
          {tourScenario && <section className="tour-recovery-decision panel" data-tour="recovery-decision" aria-labelledby="tour-recovery-title">
            <header><div><p className="eyebrow">RECOVERY CHECK</p><h2 id="tour-recovery-title">處理與恢復判定</h2></div><span>受控模擬結論</span></header>
            <div className="tour-decision-grid">
              <article><span>採取的處理</span><p>{tourScenario.response.action}</p></article>
              <article><span>怎樣才算恢復</span><p>{tourScenario.response.verification}</p></article>
              <article><span>目前可以怎麼判斷</span><p>{tourScenario.response.conclusion}</p></article>
            </div>
            <p className="tour-causality-note">更新時間本身不足以證明原因；結論必須同時符合時間、錯誤範圍、版本與處理後結果。</p>
          </section>}
        </>
      )}
    </div>
  );
}
