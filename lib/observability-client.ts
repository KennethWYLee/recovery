import type { ObservabilitySnapshot, ObservabilityWindow } from "@/db/operations-telemetry";

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}格式不完整。`);
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string, nullable = false): number | null {
  if (nullable && value == null) return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) throw new Error(`${label}不是有效數值。`);
  return numberValue;
}

function text(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value == null) return null;
  if (typeof value !== "string") throw new Error(`${label}不是有效文字。`);
  return value;
}

export function normalizeObservabilitySnapshot(value: unknown): ObservabilitySnapshot {
  const root = record(value, "系統觀測回應");
  const summary = record(root.summary, "系統觀測摘要");
  const coverage = record(root.coverage, "資料來源摘要");
  const window = text(root.window, "觀測期間") as ObservabilityWindow;
  if (!( ["24h", "7d", "30d"] as string[]).includes(window)) throw new Error("觀測期間不受支援。");
  const timeSeries = Array.isArray(root.timeSeries) ? root.timeSeries : [];
  const statusClasses = Array.isArray(root.statusClasses) ? root.statusClasses : [];
  const routes = Array.isArray(root.routes) ? root.routes : [];
  const problemCodes = Array.isArray(root.problemCodes) ? root.problemCodes : [];
  const recentErrors = Array.isArray(root.recentErrors) ? root.recentErrors : [];
  return {
    window,
    from: text(root.from, "觀測起始時間") as string,
    to: text(root.to, "觀測結束時間") as string,
    bucketUnit: root.bucketUnit === "hour" ? "hour" : "day",
    summary: {
      totalRequests: finiteNumber(summary.totalRequests, "請求總數") as number,
      successfulRequests: finiteNumber(summary.successfulRequests, "成功請求數") as number,
      clientErrors: finiteNumber(summary.clientErrors, "用戶端錯誤數") as number,
      serverErrors: finiteNumber(summary.serverErrors, "伺服器錯誤數") as number,
      deniedRequests: finiteNumber(summary.deniedRequests, "拒絕請求數") as number,
      errorRatePercent: finiteNumber(summary.errorRatePercent, "錯誤率") as number,
      averageLatencyMs: finiteNumber(summary.averageLatencyMs, "平均延遲", true),
      p50LatencyMs: finiteNumber(summary.p50LatencyMs, "P50延遲", true),
      p95LatencyMs: finiteNumber(summary.p95LatencyMs, "P95延遲", true),
      lastObservedAt: text(summary.lastObservedAt, "最後觀測時間", true),
    },
    coverage: {
      runtimeEvents: finiteNumber(coverage.runtimeEvents, "正式執行資料數") as number,
      simulatedEvents: finiteNumber(coverage.simulatedEvents, "模擬資料數") as number,
      hasSimulatedData: coverage.hasSimulatedData === true,
    },
    timeSeries: timeSeries.map((item, index) => {
      const row = record(item, `時間序列第${index + 1}筆`);
      return { bucket: text(row.bucket, "時間區間") as string, requests: finiteNumber(row.requests, "請求數") as number, clientErrors: finiteNumber(row.clientErrors, "用戶端錯誤數") as number, serverErrors: finiteNumber(row.serverErrors, "伺服器錯誤數") as number, averageLatencyMs: finiteNumber(row.averageLatencyMs, "平均延遲", true) };
    }),
    statusClasses: statusClasses.map((item, index) => {
      const row = record(item, `狀態分布第${index + 1}筆`);
      const statusClass = text(row.statusClass, "狀態類別");
      if (!( ["2xx", "3xx", "4xx", "5xx"] as Array<string | null>).includes(statusClass)) throw new Error("狀態類別不受支援。");
      return { statusClass: statusClass as "2xx" | "3xx" | "4xx" | "5xx", count: finiteNumber(row.count, "狀態數量") as number };
    }),
    routes: routes.map((item, index) => {
      const row = record(item, `路徑統計第${index + 1}筆`);
      return { route: text(row.route, "路徑") as string, requests: finiteNumber(row.requests, "路徑請求數") as number, clientErrors: finiteNumber(row.clientErrors, "路徑用戶端錯誤數") as number, serverErrors: finiteNumber(row.serverErrors, "路徑伺服器錯誤數") as number, averageLatencyMs: finiteNumber(row.averageLatencyMs, "路徑平均延遲", true) };
    }),
    problemCodes: problemCodes.map((item, index) => {
      const row = record(item, `問題代碼第${index + 1}筆`);
      return { code: text(row.code, "問題代碼") as string, count: finiteNumber(row.count, "問題數量") as number };
    }),
    recentErrors: recentErrors.map((item, index) => {
      const row = record(item, `錯誤紀錄第${index + 1}筆`);
      return { requestId: text(row.requestId, "Request ID") as string, occurredAt: text(row.occurredAt, "錯誤時間") as string, route: text(row.route, "錯誤路徑") as string, method: text(row.method, "HTTP方法") as string, status: finiteNumber(row.status, "HTTP狀態") as number, problemCode: text(row.problemCode, "問題代碼", true), latencyMs: finiteNumber(row.latencyMs, "延遲") as number, deploymentVersion: text(row.deploymentVersion, "部署版本") as string, source: row.source === "simulated" ? "simulated" : "runtime" };
    }),
  };
}
