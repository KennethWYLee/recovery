import type { ObservabilitySnapshot } from "@/db/operations-telemetry";

export type GuidedTourView = "overview" | "observability";

export type GuidedTourStep = {
  id: string;
  view: GuidedTourView;
  target: string;
  title: string;
  description: string;
  side: "top" | "right" | "bottom" | "left";
  align: "start" | "center" | "end";
};

export type GuidedTourScenario = {
  id: string;
  title: string;
  summary: string;
  duration: string;
  sourceLabel: string;
  opening: {
    occurredAt: string;
    affectedServices: number;
    serverErrors: number;
    p95LatencyMs: number;
  };
  deployment: {
    occurredAt: string;
    version: string;
  };
  response: {
    action: string;
    verification: string;
    conclusion: string;
  };
  steps: GuidedTourStep[];
};

export const UPDATE_REGRESSION_SCENARIO: GuidedTourScenario = {
  id: "update-regression",
  title: "系統更新後，部分功能變慢或出錯",
  summary: "利用更新時間、錯誤率與系統紀錄，判斷問題是否與本次更新有關。",
  duration: "5 步 · 約 3 分鐘",
  sourceLabel: "受控模擬資料",
  opening: {
    occurredAt: "2026-08-05T06:18:00.000Z",
    affectedServices: 2,
    serverErrors: 52,
    p95LatencyMs: 1420,
  },
  deployment: {
    occurredAt: "2026-08-05T06:00:00.000Z",
    version: "2.2.0-demo.3",
  },
  response: {
    action: "先停止擴大發布，再回復上一個穩定版本，保留錯誤請求供後續查核。",
    verification: "連續 30 分鐘確認 5xx 錯誤率低於 0.5%，P95 回應時間低於 400 ms。",
    conclusion: "異常緊接更新出現，集中於相同版本與 API；回復版本後指標恢復。這些資料共同支持本次更新與異常有關。",
  },
  steps: [
    {
      id: "discover-impact",
      view: "overview",
      target: "[data-tour='scenario-opening']",
      title: "先確認發生了什麼",
      description: "更新後 18 分鐘，兩項服務出現錯誤與延遲。先記住影響、時間與異常程度，再往下查。",
      side: "bottom",
      align: "center",
    },
    {
      id: "confirm-timing",
      view: "observability",
      target: "[data-tour='update-signal']",
      title: "比較更新與異常時間",
      description: "版本 2.2.0-demo.3 在 14:00 完成更新，錯誤從 14:18 開始增加。時間接近是重要線索，但還不能單獨證明原因。",
      side: "bottom",
      align: "start",
    },
    {
      id: "compare-trends",
      view: "observability",
      target: "[data-tour='trend-comparison']",
      title: "比較更新前後的變化",
      description: "同時查看請求量、5xx 錯誤與回應時間。若只有流量增加，不能直接認定是程式更新造成。",
      side: "top",
      align: "center",
    },
    {
      id: "locate-problem",
      view: "observability",
      target: "[data-tour='problem-scope']",
      title: "找出問題集中在哪裡",
      description: "錯誤集中在總覽 API，問題代碼與版本也一致。利用路徑、問題代碼和 Request ID，縮小需要查核的範圍。",
      side: "top",
      align: "center",
    },
    {
      id: "verify-recovery",
      view: "observability",
      target: "[data-tour='recovery-decision']",
      title: "確認處理後真的恢復",
      description: "回復上一版後，連續觀察錯誤率與 P95 回應時間。只有符合事先設定的條件，才能判斷服務已恢復。",
      side: "top",
      align: "center",
    },
  ],
};

export const GUIDED_TOUR_SCENARIOS = [UPDATE_REGRESSION_SCENARIO] as const;

const hourly = [
  ["2026-08-04T14:00:00.000Z", 92, 2, 0, 171],
  ["2026-08-04T15:00:00.000Z", 88, 1, 0, 166],
  ["2026-08-04T16:00:00.000Z", 75, 1, 0, 158],
  ["2026-08-04T17:00:00.000Z", 64, 0, 0, 151],
  ["2026-08-04T18:00:00.000Z", 58, 0, 0, 148],
  ["2026-08-04T19:00:00.000Z", 52, 0, 0, 145],
  ["2026-08-04T20:00:00.000Z", 49, 0, 0, 143],
  ["2026-08-04T21:00:00.000Z", 46, 0, 0, 141],
  ["2026-08-04T22:00:00.000Z", 51, 0, 0, 146],
  ["2026-08-04T23:00:00.000Z", 67, 1, 0, 153],
  ["2026-08-05T00:00:00.000Z", 95, 1, 0, 165],
  ["2026-08-05T01:00:00.000Z", 126, 2, 0, 178],
  ["2026-08-05T02:00:00.000Z", 151, 2, 0, 184],
  ["2026-08-05T03:00:00.000Z", 167, 3, 0, 191],
  ["2026-08-05T04:00:00.000Z", 176, 2, 0, 187],
  ["2026-08-05T05:00:00.000Z", 182, 3, 0, 196],
  ["2026-08-05T06:00:00.000Z", 194, 4, 14, 672],
  ["2026-08-05T07:00:00.000Z", 201, 5, 26, 1128],
  ["2026-08-05T08:00:00.000Z", 188, 4, 10, 804],
  ["2026-08-05T09:00:00.000Z", 172, 3, 2, 286],
  ["2026-08-05T10:00:00.000Z", 165, 2, 0, 218],
  ["2026-08-05T11:00:00.000Z", 158, 2, 0, 205],
  ["2026-08-05T12:00:00.000Z", 149, 2, 0, 198],
  ["2026-08-05T13:00:00.000Z", 142, 2, 0, 192],
] as const;

export const UPDATE_REGRESSION_OBSERVABILITY: ObservabilitySnapshot = {
  window: "24h",
  from: "2026-08-04T14:00:00.000Z",
  to: "2026-08-05T13:00:00.000Z",
  bucketUnit: "hour",
  summary: {
    totalRequests: 2908,
    successfulRequests: 2814,
    clientErrors: 42,
    serverErrors: 52,
    deniedRequests: 11,
    errorRatePercent: 1.79,
    averageLatencyMs: 293,
    p50LatencyMs: 184,
    p95LatencyMs: 1420,
    lastObservedAt: "2026-08-05T13:58:00.000Z",
  },
  coverage: {
    runtimeEvents: 0,
    simulatedEvents: 2908,
    hasSimulatedData: true,
  },
  timeSeries: hourly.map(([bucket, requests, clientErrors, serverErrors, averageLatencyMs]) => ({
    bucket,
    requests,
    clientErrors,
    serverErrors,
    averageLatencyMs,
  })),
  statusClasses: [
    { statusClass: "2xx", count: 2814 },
    { statusClass: "3xx", count: 0 },
    { statusClass: "4xx", count: 42 },
    { statusClass: "5xx", count: 52 },
  ],
  routes: [
    { route: "/api/v1/overview", requests: 840, clientErrors: 8, serverErrors: 46, averageLatencyMs: 742 },
    { route: "/api/v1/incidents", requests: 680, clientErrors: 10, serverErrors: 4, averageLatencyMs: 238 },
    { route: "/api/v1/services", requests: 570, clientErrors: 7, serverErrors: 2, averageLatencyMs: 206 },
    { route: "/api/v1/observability", requests: 468, clientErrors: 9, serverErrors: 0, averageLatencyMs: 189 },
    { route: "/api/v1/access", requests: 350, clientErrors: 8, serverErrors: 0, averageLatencyMs: 175 },
  ],
  problemCodes: [
    { code: "OVERVIEW_QUERY_TIMEOUT", count: 39 },
    { code: "OPERATIONS_SCHEMA_READ", count: 7 },
    { code: "UPSTREAM_UNAVAILABLE", count: 6 },
  ],
  recentErrors: [
    { requestId: "req-tour-20260805-0817", occurredAt: "2026-08-05T08:17:00.000Z", route: "/api/v1/overview", method: "GET", status: 500, problemCode: "OVERVIEW_QUERY_TIMEOUT", latencyMs: 1832, deploymentVersion: "2.2.0-demo.3", source: "simulated" },
    { requestId: "req-tour-20260805-0754", occurredAt: "2026-08-05T07:54:00.000Z", route: "/api/v1/overview", method: "GET", status: 500, problemCode: "OVERVIEW_QUERY_TIMEOUT", latencyMs: 1764, deploymentVersion: "2.2.0-demo.3", source: "simulated" },
    { requestId: "req-tour-20260805-0729", occurredAt: "2026-08-05T07:29:00.000Z", route: "/api/v1/overview", method: "GET", status: 500, problemCode: "OPERATIONS_SCHEMA_READ", latencyMs: 1588, deploymentVersion: "2.2.0-demo.3", source: "simulated" },
    { requestId: "req-tour-20260805-0642", occurredAt: "2026-08-05T06:42:00.000Z", route: "/api/v1/incidents", method: "GET", status: 502, problemCode: "UPSTREAM_UNAVAILABLE", latencyMs: 1215, deploymentVersion: "2.2.0-demo.3", source: "simulated" },
  ],
};
