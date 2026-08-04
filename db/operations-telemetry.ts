import { OPERATIONS_ORGANIZATION_ID, operationsEnvironment } from "@/db/operations";
import { cleanOperationsText } from "@/lib/operations-domain";

export const OBSERVABILITY_WINDOWS = ["24h", "7d", "30d"] as const;
export type ObservabilityWindow = (typeof OBSERVABILITY_WINDOWS)[number];

export type RequestTelemetryInput = {
  requestId: string;
  route: string;
  method: string;
  status: number;
  problemCode?: string | null;
  latencyMs: number;
  apiVersion: string;
  schemaVersion: string;
  deploymentVersion: string;
  occurredAt?: string;
};

export type ObservabilitySnapshot = {
  window: ObservabilityWindow;
  from: string;
  to: string;
  bucketUnit: "hour" | "day";
  summary: {
    totalRequests: number;
    successfulRequests: number;
    clientErrors: number;
    serverErrors: number;
    deniedRequests: number;
    errorRatePercent: number;
    averageLatencyMs: number | null;
    p50LatencyMs: number | null;
    p95LatencyMs: number | null;
    lastObservedAt: string | null;
  };
  coverage: {
    runtimeEvents: number;
    simulatedEvents: number;
    hasSimulatedData: boolean;
  };
  timeSeries: Array<{
    bucket: string;
    requests: number;
    clientErrors: number;
    serverErrors: number;
    averageLatencyMs: number | null;
  }>;
  statusClasses: Array<{ statusClass: "2xx" | "3xx" | "4xx" | "5xx"; count: number }>;
  routes: Array<{
    route: string;
    requests: number;
    clientErrors: number;
    serverErrors: number;
    averageLatencyMs: number | null;
  }>;
  problemCodes: Array<{ code: string; count: number }>;
  recentErrors: Array<{
    requestId: string;
    occurredAt: string;
    route: string;
    method: string;
    status: number;
    problemCode: string | null;
    latencyMs: number;
    deploymentVersion: string;
    source: "runtime" | "simulated";
  }>;
};

function deploymentEnvironment(): "development" | "staging" | "production" | "unknown" {
  const value = operationsEnvironment().CONTINUITY_OPS_ENVIRONMENT?.trim().toLowerCase();
  return value === "development" || value === "staging" || value === "production" ? value : "unknown";
}

export async function persistRequestTelemetry(db: D1Database, input: RequestTelemetryInput): Promise<void> {
  const method = input.method.toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
  const requestId = cleanOperationsText(input.requestId, 128);
  const route = cleanOperationsText(input.route, 160);
  if (requestId.length < 8 || !route.startsWith("/api/v1/")) return;
  const problemCode = cleanOperationsText(input.problemCode, 80) || null;
  const deploymentVersion = cleanOperationsText(input.deploymentVersion, 80) || "unversioned";
  await db.prepare(
    `INSERT OR IGNORE INTO ops_request_telemetry
       (id, organization_id, request_id, route_template, method, status_code,
        problem_code, latency_ms, api_version, schema_version, deployment_version,
        environment, source, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'runtime', ?)`,
  ).bind(
    `telemetry-${requestId}`,
    OPERATIONS_ORGANIZATION_ID,
    requestId,
    route,
    method,
    Math.min(599, Math.max(100, Math.round(input.status))),
    problemCode,
    Math.min(3_600_000, Math.max(0, Math.round(input.latencyMs))),
    cleanOperationsText(input.apiVersion, 32) || "unknown",
    cleanOperationsText(input.schemaVersion, 32) || "unknown",
    deploymentVersion,
    deploymentEnvironment(),
    input.occurredAt ?? new Date().toISOString(),
  ).run();
}

function windowDurationMs(window: ObservabilityWindow): number {
  if (window === "24h") return 24 * 60 * 60 * 1000;
  if (window === "7d") return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

function rounded(value: unknown): number | null {
  if (value == null) return null;
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? Math.round(numberValue) : null;
}

async function latencyPercentile(
  db: D1Database,
  organizationId: string,
  from: string,
  count: number,
  percentile: number,
): Promise<number | null> {
  if (count === 0) return null;
  const offset = Math.max(0, Math.ceil(count * percentile) - 1);
  const row = await db.prepare(
    `SELECT latency_ms FROM ops_request_telemetry
     WHERE organization_id = ? AND occurred_at >= ?
     ORDER BY latency_ms ASC LIMIT 1 OFFSET ?`,
  ).bind(organizationId, from, offset).first<{ latency_ms: number }>();
  return row ? Number(row.latency_ms) : null;
}

function filledTimeSeries(
  from: Date,
  to: Date,
  unit: "hour" | "day",
  rows: Array<{ bucket: string; requests: number; client_errors: number; server_errors: number; average_latency_ms: number | null }>,
): ObservabilitySnapshot["timeSeries"] {
  const rowByBucket = new Map(rows.map((row) => [row.bucket, row]));
  const cursor = new Date(from);
  if (unit === "hour") cursor.setUTCMinutes(0, 0, 0);
  else cursor.setUTCHours(0, 0, 0, 0);
  const result: ObservabilitySnapshot["timeSeries"] = [];
  while (cursor <= to) {
    const bucket = unit === "hour"
      ? `${cursor.toISOString().slice(0, 13)}:00:00Z`
      : `${cursor.toISOString().slice(0, 10)}T00:00:00Z`;
    const row = rowByBucket.get(bucket);
    result.push({
      bucket,
      requests: Number(row?.requests ?? 0),
      clientErrors: Number(row?.client_errors ?? 0),
      serverErrors: Number(row?.server_errors ?? 0),
      averageLatencyMs: row?.average_latency_ms == null ? null : Number(row.average_latency_ms),
    });
    if (unit === "hour") cursor.setUTCHours(cursor.getUTCHours() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export async function loadObservabilitySnapshot(
  db: D1Database,
  organizationId: string,
  window: ObservabilityWindow,
  now = new Date(),
): Promise<ObservabilitySnapshot> {
  const fromDate = new Date(now.getTime() - windowDurationMs(window));
  const from = fromDate.toISOString();
  const to = now.toISOString();
  const bucketUnit = window === "24h" ? "hour" : "day";
  const bucketSql = bucketUnit === "hour"
    ? "strftime('%Y-%m-%dT%H:00:00Z', occurred_at)"
    : "substr(occurred_at, 1, 10) || 'T00:00:00Z'";
  const [summaryRow, seriesRows, statusRows, routeRows, problemRows, recentRows] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total_requests,
              SUM(CASE WHEN status_code BETWEEN 200 AND 399 THEN 1 ELSE 0 END) AS successful_requests,
              SUM(CASE WHEN status_code BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS client_errors,
              SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS server_errors,
              SUM(CASE WHEN status_code = 403 THEN 1 ELSE 0 END) AS denied_requests,
              ROUND(AVG(latency_ms), 0) AS average_latency_ms,
              MAX(occurred_at) AS last_observed_at,
              SUM(CASE WHEN source = 'runtime' THEN 1 ELSE 0 END) AS runtime_events,
              SUM(CASE WHEN source = 'simulated' THEN 1 ELSE 0 END) AS simulated_events
       FROM ops_request_telemetry WHERE organization_id = ? AND occurred_at >= ?`,
    ).bind(organizationId, from).first<Record<string, unknown>>(),
    db.prepare(
      `SELECT ${bucketSql} AS bucket, COUNT(*) AS requests,
              SUM(CASE WHEN status_code BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS client_errors,
              SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS server_errors,
              ROUND(AVG(latency_ms), 0) AS average_latency_ms
       FROM ops_request_telemetry WHERE organization_id = ? AND occurred_at >= ?
       GROUP BY bucket ORDER BY bucket`,
    ).bind(organizationId, from).all<{ bucket: string; requests: number; client_errors: number; server_errors: number; average_latency_ms: number | null }>(),
    db.prepare(
      `SELECT CAST(status_code / 100 AS INTEGER) || 'xx' AS status_class, COUNT(*) AS count
       FROM ops_request_telemetry WHERE organization_id = ? AND occurred_at >= ?
       GROUP BY status_class ORDER BY status_class`,
    ).bind(organizationId, from).all<{ status_class: string; count: number }>(),
    db.prepare(
      `SELECT route_template AS route, COUNT(*) AS requests,
              SUM(CASE WHEN status_code BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS client_errors,
              SUM(CASE WHEN status_code >= 500 THEN 1 ELSE 0 END) AS server_errors,
              ROUND(AVG(latency_ms), 0) AS average_latency_ms
       FROM ops_request_telemetry WHERE organization_id = ? AND occurred_at >= ?
       GROUP BY route_template ORDER BY requests DESC, route_template LIMIT 10`,
    ).bind(organizationId, from).all<{ route: string; requests: number; client_errors: number; server_errors: number; average_latency_ms: number | null }>(),
    db.prepare(
      `SELECT problem_code AS code, COUNT(*) AS count
       FROM ops_request_telemetry
       WHERE organization_id = ? AND occurred_at >= ? AND problem_code IS NOT NULL
       GROUP BY problem_code ORDER BY count DESC, problem_code LIMIT 10`,
    ).bind(organizationId, from).all<{ code: string; count: number }>(),
    db.prepare(
      `SELECT request_id, occurred_at, route_template, method, status_code,
              problem_code, latency_ms, deployment_version, source
       FROM ops_request_telemetry
       WHERE organization_id = ? AND occurred_at >= ? AND status_code >= 400
       ORDER BY occurred_at DESC LIMIT 30`,
    ).bind(organizationId, from).all<Record<string, unknown>>(),
  ]);
  const totalRequests = Number(summaryRow?.total_requests ?? 0);
  const serverErrors = Number(summaryRow?.server_errors ?? 0);
  const [p50LatencyMs, p95LatencyMs] = await Promise.all([
    latencyPercentile(db, organizationId, from, totalRequests, 0.5),
    latencyPercentile(db, organizationId, from, totalRequests, 0.95),
  ]);
  const statusByClass = new Map(statusRows.results.map((row) => [row.status_class, Number(row.count)]));
  const simulatedEvents = Number(summaryRow?.simulated_events ?? 0);
  return {
    window,
    from,
    to,
    bucketUnit,
    summary: {
      totalRequests,
      successfulRequests: Number(summaryRow?.successful_requests ?? 0),
      clientErrors: Number(summaryRow?.client_errors ?? 0),
      serverErrors,
      deniedRequests: Number(summaryRow?.denied_requests ?? 0),
      errorRatePercent: totalRequests === 0 ? 0 : Math.round((serverErrors / totalRequests) * 10_000) / 100,
      averageLatencyMs: rounded(summaryRow?.average_latency_ms),
      p50LatencyMs,
      p95LatencyMs,
      lastObservedAt: typeof summaryRow?.last_observed_at === "string" ? summaryRow.last_observed_at : null,
    },
    coverage: {
      runtimeEvents: Number(summaryRow?.runtime_events ?? 0),
      simulatedEvents,
      hasSimulatedData: simulatedEvents > 0,
    },
    timeSeries: filledTimeSeries(fromDate, now, bucketUnit, seriesRows.results),
    statusClasses: (["2xx", "3xx", "4xx", "5xx"] as const).map((statusClass) => ({ statusClass, count: statusByClass.get(statusClass) ?? 0 })),
    routes: routeRows.results.map((row) => ({
      route: row.route,
      requests: Number(row.requests),
      clientErrors: Number(row.client_errors ?? 0),
      serverErrors: Number(row.server_errors ?? 0),
      averageLatencyMs: row.average_latency_ms == null ? null : Number(row.average_latency_ms),
    })),
    problemCodes: problemRows.results.map((row) => ({ code: row.code, count: Number(row.count) })),
    recentErrors: recentRows.results.map((row) => ({
      requestId: String(row.request_id),
      occurredAt: String(row.occurred_at),
      route: String(row.route_template),
      method: String(row.method),
      status: Number(row.status_code),
      problemCode: row.problem_code == null ? null : String(row.problem_code),
      latencyMs: Number(row.latency_ms),
      deploymentVersion: String(row.deployment_version),
      source: row.source === "simulated" ? "simulated" : "runtime",
    })),
  };
}
