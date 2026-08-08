import { classroomId, classroomNow, type ClassroomActor } from "./classroom";
import {
  CLASSROOM_LOG_RETENTION_DAYS,
  boundedDurationMilliseconds,
  classroomLogWindowStart,
  classroomLogCaptureKind,
  classroomLogScope,
  classroomOperationOutcome,
  classroomRecordedSuccessShare,
  classroomResolvedIncidentEvidenceIsValid,
  classroomSecurityRelevant,
  normalizeClassroomErrorCode,
  normalizeClassroomIncidentDraft,
  normalizeClassroomRelease,
  normalizeClassroomRoute,
  percentile95,
  type ClassroomIncidentDraft,
  type ClassroomIncidentRequestEvidence,
  type ClassroomIncidentSeverity,
  type ClassroomIncidentStatus,
  type ClassroomLogWindow,
} from "../lib/classroom-observability";

export type ClassroomOperationLogInput = {
  requestId: string;
  actor: ClassroomActor | null;
  method: string;
  url: string;
  statusCode: number;
  errorCode: string | null;
  durationMs: number;
  testMode?: boolean;
  environment?: string;
  release?: string;
  occurredAt?: string;
};

export type ClassroomIncident = ClassroomIncidentDraft & {
  id: string;
  version: number;
  detectedAt: string;
  resolvedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClassroomObservabilitySnapshot = {
  generatedAt: string;
  window: ClassroomLogWindow;
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
  recentFailures: Array<{
    requestId: string;
    route: string;
    method: string;
    statusCode: number;
    errorCode: string | null;
    durationMs: number;
    occurredAt: string;
    securityRelevant: boolean;
  }>;
  recentSecurityEvents: Array<{
    requestId: string;
    route: string;
    method: string;
    statusCode: number;
    errorCode: string | null;
    actorKind: string;
    occurredAt: string;
  }>;
  incidents: ClassroomIncident[];
};

let lastPrunedDay = "";

async function pruneOperationLogsIfNeeded(db: D1Database, now: string): Promise<void> {
  const day = now.slice(0, 10);
  if (day === lastPrunedDay) return;
  const cutoff = new Date(new Date(now).getTime() - CLASSROOM_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  await db.prepare(
    `DELETE FROM classroom_operation_logs
     WHERE occurred_at < ?
       AND request_id NOT IN (
         SELECT source_request_id FROM classroom_incidents WHERE source_request_id IS NOT NULL
         UNION
         SELECT verification_request_id FROM classroom_incidents WHERE verification_request_id IS NOT NULL
       )`,
  ).bind(cutoff).run();
  lastPrunedDay = day;
}

export async function recordClassroomOperationLog(db: D1Database, input: ClassroomOperationLogInput): Promise<void> {
  const occurredAt = input.occurredAt ?? classroomNow();
  const statusCode = Math.min(599, Math.max(100, Math.trunc(input.statusCode)));
  const errorCode = normalizeClassroomErrorCode(input.errorCode);
  const outcome = classroomOperationOutcome(statusCode);
  const captureKind = classroomLogCaptureKind(input.requestId, input.method, statusCode, input.durationMs);
  if (!captureKind) return;
  const scope = classroomLogScope(input.url);
  const environment = input.environment === "production" ? "production" : "development";
  const release = normalizeClassroomRelease(input.release);
  const actorKind = input.actor?.isAdmin ? "administrator" : input.actor ? "student" : "anonymous";
  await db.prepare(
    `INSERT OR IGNORE INTO classroom_operation_logs
      (id, request_id, actor_user_id, actor_kind, method, route, scope_type, scope_id,
       outcome, status_code, error_code, duration_ms, capture_kind, test_mode, environment,
       security_relevant, release, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    classroomId("oplog"),
    input.requestId,
    input.actor?.id ?? null,
    actorKind,
    input.method.toUpperCase().slice(0, 10),
    normalizeClassroomRoute(input.url),
    scope.type,
    scope.id,
    outcome,
    statusCode,
    errorCode,
    boundedDurationMilliseconds(input.durationMs),
    captureKind,
    input.testMode ? 1 : 0,
    environment,
    classroomSecurityRelevant(statusCode, errorCode) ? 1 : 0,
    release,
    occurredAt,
  ).run();
  await pruneOperationLogsIfNeeded(db, occurredAt);
}

function mapIncident(row: {
  id: string;
  title: string;
  severity: ClassroomIncidentSeverity;
  status: ClassroomIncidentStatus;
  source_request_id: string | null;
  verification_request_id: string | null;
  symptom: string;
  root_cause: string;
  resolution: string;
  fix_release: string;
  regression_check: string;
  regression_command: string;
  regression_evidence: string;
  verification_result: "not_run" | "passed" | "failed";
  version: number;
  detected_at: string;
  resolved_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}): ClassroomIncident {
  return {
    id: row.id,
    title: row.title,
    severity: row.severity,
    status: row.status,
    sourceRequestId: row.source_request_id,
    verificationRequestId: row.verification_request_id,
    symptom: row.symptom,
    rootCause: row.root_cause,
    resolution: row.resolution,
    fixRelease: row.fix_release,
    regressionCheck: row.regression_check,
    regressionCommand: row.regression_command,
    regressionEvidence: row.regression_evidence,
    verificationResult: row.verification_result,
    version: row.version,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const INCIDENT_COLUMNS = `id, title, severity, status, source_request_id, verification_request_id,
  symptom, root_cause, resolution, fix_release, regression_check, regression_command,
  regression_evidence, verification_result, version, detected_at, resolved_at, verified_at,
  created_at, updated_at`;

export async function classroomObservabilitySnapshot(
  db: D1Database,
  actor: ClassroomActor,
  window: ClassroomLogWindow,
  runtimeRelease?: unknown,
): Promise<ClassroomObservabilitySnapshot> {
  if (!actor.isAdmin) throw new Error("OBSERVABILITY_ADMIN_REQUIRED");
  const generatedAt = classroomNow();
  await pruneOperationLogsIfNeeded(db, generatedAt);
  const windowStartedAt = classroomLogWindowStart(window, new Date(generatedAt));
  const bucketExpression = window === "24h"
    ? "substr(occurred_at, 1, 13) || ':00:00.000Z'"
    : "substr(occurred_at, 1, 10) || 'T00:00:00.000Z'";

  const [summaryRow, durations, timeSeriesRows, routeRows, errorRows, failureRows, securityRows, incidentRows, incidentCount] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successful,
              SUM(CASE WHEN outcome = 'client_error' THEN 1 ELSE 0 END) AS client_errors,
              SUM(CASE WHEN outcome = 'server_error' THEN 1 ELSE 0 END) AS server_errors,
              SUM(CASE WHEN security_relevant = 1 THEN 1 ELSE 0 END) AS security_events,
              COALESCE(AVG(duration_ms), 0) AS average_duration
       FROM classroom_operation_logs WHERE occurred_at >= ? AND test_mode = 0`,
    ).bind(windowStartedAt).first<{ total: number; successful: number; client_errors: number; server_errors: number; security_events: number; average_duration: number }>(),
    db.prepare("SELECT duration_ms FROM classroom_operation_logs WHERE occurred_at >= ? AND test_mode = 0 ORDER BY occurred_at DESC LIMIT 10000")
      .bind(windowStartedAt).all<{ duration_ms: number }>(),
    db.prepare(
      `SELECT ${bucketExpression} AS bucket, COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'client_error' THEN 1 ELSE 0 END) AS client_errors,
              SUM(CASE WHEN outcome = 'server_error' THEN 1 ELSE 0 END) AS server_errors,
              COALESCE(AVG(duration_ms), 0) AS average_duration
       FROM classroom_operation_logs WHERE occurred_at >= ? AND test_mode = 0 GROUP BY bucket ORDER BY bucket`,
    ).bind(windowStartedAt).all<{ bucket: string; total: number; client_errors: number; server_errors: number; average_duration: number }>(),
    db.prepare(
      `SELECT route, COUNT(*) AS total,
              SUM(CASE WHEN outcome != 'success' THEN 1 ELSE 0 END) AS failures,
              COALESCE(AVG(duration_ms), 0) AS average_duration,
              COALESCE(MAX(duration_ms), 0) AS maximum_duration
       FROM classroom_operation_logs WHERE occurred_at >= ? AND test_mode = 0
       GROUP BY route ORDER BY total DESC, failures DESC LIMIT 12`,
    ).bind(windowStartedAt).all<{ route: string; total: number; failures: number; average_duration: number; maximum_duration: number }>(),
    db.prepare(
      `SELECT COALESCE(error_code, 'HTTP_' || status_code) AS code, COUNT(*) AS count, MAX(occurred_at) AS last_seen_at
       FROM classroom_operation_logs WHERE occurred_at >= ? AND test_mode = 0 AND outcome != 'success'
       GROUP BY code ORDER BY count DESC, last_seen_at DESC LIMIT 12`,
    ).bind(windowStartedAt).all<{ code: string; count: number; last_seen_at: string }>(),
    db.prepare(
      `SELECT request_id, route, method, status_code, error_code, duration_ms, occurred_at, security_relevant
       FROM classroom_operation_logs WHERE occurred_at >= ? AND test_mode = 0 AND outcome != 'success'
       ORDER BY occurred_at DESC LIMIT 30`,
    ).bind(windowStartedAt).all<{ request_id: string; route: string; method: string; status_code: number; error_code: string | null; duration_ms: number; occurred_at: string; security_relevant: number }>(),
    db.prepare(
      `SELECT request_id, route, method, status_code, error_code, actor_kind, occurred_at
       FROM classroom_operation_logs WHERE occurred_at >= ? AND test_mode = 0 AND security_relevant = 1
       ORDER BY occurred_at DESC LIMIT 20`,
    ).bind(windowStartedAt).all<{ request_id: string; route: string; method: string; status_code: number; error_code: string | null; actor_kind: string; occurred_at: string }>(),
    db.prepare(`SELECT ${INCIDENT_COLUMNS} FROM classroom_incidents ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END, updated_at DESC LIMIT 50`)
      .all<Parameters<typeof mapIncident>[0]>(),
    db.prepare("SELECT COUNT(*) AS count FROM classroom_incidents WHERE status != 'resolved'").first<{ count: number }>(),
  ]);

  const total = summaryRow?.total ?? 0;
  const successful = summaryRow?.successful ?? 0;
  const release = normalizeClassroomRelease(runtimeRelease);
  return {
    generatedAt,
    window,
    windowStartedAt,
    release,
    releaseIsConfigured: !release.endsWith("-unverified"),
    retentionDays: CLASSROOM_LOG_RETENTION_DAYS,
    excludesTestMode: true,
    summary: {
      recordedEvents: total,
      recordedSuccessfulEvents: successful,
      recordedClientErrors: summaryRow?.client_errors ?? 0,
      recordedServerErrors: summaryRow?.server_errors ?? 0,
      recordedSuccessShare: classroomRecordedSuccessShare(total, successful),
      recordedAverageDurationMs: Math.round(summaryRow?.average_duration ?? 0),
      recordedP95DurationMs: percentile95(durations.results.map((row) => row.duration_ms)),
      recordedSecurityEvents: summaryRow?.security_events ?? 0,
      unresolvedIncidents: incidentCount?.count ?? 0,
    },
    timeSeries: timeSeriesRows.results.map((row) => ({
      bucket: row.bucket,
      total: row.total,
      clientErrors: row.client_errors,
      serverErrors: row.server_errors,
      averageDurationMs: Math.round(row.average_duration),
    })),
    routes: routeRows.results.map((row) => ({
      route: row.route,
      total: row.total,
      failures: row.failures,
      averageDurationMs: Math.round(row.average_duration),
      maximumDurationMs: row.maximum_duration,
    })),
    errorCodes: errorRows.results.map((row) => ({ code: row.code, count: row.count, lastSeenAt: row.last_seen_at })),
    recentFailures: failureRows.results.map((row) => ({
      requestId: row.request_id,
      route: row.route,
      method: row.method,
      statusCode: row.status_code,
      errorCode: row.error_code,
      durationMs: row.duration_ms,
      occurredAt: row.occurred_at,
      securityRelevant: row.security_relevant === 1,
    })),
    recentSecurityEvents: securityRows.results.map((row) => ({
      requestId: row.request_id,
      route: row.route,
      method: row.method,
      statusCode: row.status_code,
      errorCode: row.error_code,
      actorKind: row.actor_kind,
      occurredAt: row.occurred_at,
    })),
    incidents: incidentRows.results.map(mapIncident),
  };
}

type IncidentRequestEvidenceRow = {
  outcome: string;
  release: string;
  occurred_at: string;
};

async function incidentRequestEvidenceIsValid(db: D1Database, draft: ClassroomIncidentDraft): Promise<boolean> {
  const load = (requestId: string | null) => requestId
    ? db.prepare(
      "SELECT outcome, release, occurred_at FROM classroom_operation_logs WHERE request_id = ? AND test_mode = 0",
    ).bind(requestId).first<IncidentRequestEvidenceRow>()
    : Promise.resolve(null);
  const [source, verification] = await Promise.all([
    load(draft.sourceRequestId),
    load(draft.verificationRequestId),
  ]);
  if ((draft.sourceRequestId && !source) || (draft.verificationRequestId && !verification)) return false;
  if (verification && verification.outcome !== "success") return false;
  const evidence = (row: IncidentRequestEvidenceRow | null): ClassroomIncidentRequestEvidence | null => row ? {
    outcome: row.outcome,
    release: row.release,
    occurredAt: row.occurred_at,
  } : null;
  return classroomResolvedIncidentEvidenceIsValid(draft, evidence(source), evidence(verification));
}

export async function createClassroomIncident(
  db: D1Database,
  actor: ClassroomActor,
  value: unknown,
): Promise<ClassroomIncident | "invalid" | "request_not_found"> {
  if (!actor.isAdmin) throw new Error("OBSERVABILITY_ADMIN_REQUIRED");
  const draft = normalizeClassroomIncidentDraft(value);
  if (!draft) return "invalid";
  if (!await incidentRequestEvidenceIsValid(db, draft)) return "request_not_found";
  const now = classroomNow();
  const id = classroomId("incident");
  const resolvedAt = draft.status === "resolved" ? now : null;
  const verifiedAt = draft.verificationResult === "passed" ? now : null;
  await db.batch([
    db.prepare(
      `INSERT INTO classroom_incidents
        (id, title, severity, status, source_request_id, verification_request_id, symptom,
         root_cause, resolution, fix_release, regression_check, regression_command,
         regression_evidence, verification_result, created_by_user_id, updated_by_user_id,
         version, detected_at, resolved_at, verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      id, draft.title, draft.severity, draft.status, draft.sourceRequestId,
      draft.verificationRequestId, draft.symptom, draft.rootCause, draft.resolution,
      draft.fixRelease, draft.regressionCheck, draft.regressionCommand,
      draft.regressionEvidence, draft.verificationResult, actor.id, actor.id, now,
      resolvedAt, verifiedAt, now, now,
    ),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'incident.create', 'incident', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, id, JSON.stringify({
      severity: draft.severity,
      status: draft.status,
      sourceRequestId: draft.sourceRequestId,
      verificationRequestId: draft.verificationRequestId,
      fixRelease: draft.fixRelease,
      verificationResult: draft.verificationResult,
    }), now),
  ]);
  const row = await db.prepare(`SELECT ${INCIDENT_COLUMNS} FROM classroom_incidents WHERE id = ?`).bind(id).first<Parameters<typeof mapIncident>[0]>();
  if (!row) throw new Error("Created incident could not be read.");
  return mapIncident(row);
}

export async function updateClassroomIncident(
  db: D1Database,
  actor: ClassroomActor,
  incidentId: string,
  expectedVersion: number,
  value: unknown,
): Promise<ClassroomIncident | "invalid" | "not_found" | "conflict" | "request_not_found"> {
  if (!actor.isAdmin) throw new Error("OBSERVABILITY_ADMIN_REQUIRED");
  if (!/^incident-[a-f0-9-]{16,64}$/u.test(incidentId)) return "not_found";
  const draft = normalizeClassroomIncidentDraft(value);
  if (!draft || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return "invalid";
  if (!await incidentRequestEvidenceIsValid(db, draft)) return "request_not_found";
  const now = classroomNow();
  const update = db.prepare(
    `UPDATE classroom_incidents
     SET title = ?, severity = ?, status = ?, source_request_id = ?, verification_request_id = ?,
         symptom = ?, root_cause = ?, resolution = ?, fix_release = ?, regression_check = ?,
         regression_command = ?, regression_evidence = ?, verification_result = ?,
         updated_by_user_id = ?, version = version + 1,
         resolved_at = CASE WHEN ? = 'resolved' THEN COALESCE(resolved_at, ?) ELSE NULL END,
         verified_at = CASE WHEN ? = 'passed' THEN COALESCE(verified_at, ?) ELSE NULL END,
         updated_at = ?
     WHERE id = ? AND version = ?`,
  ).bind(
    draft.title, draft.severity, draft.status, draft.sourceRequestId,
    draft.verificationRequestId, draft.symptom, draft.rootCause, draft.resolution,
    draft.fixRelease, draft.regressionCheck, draft.regressionCommand,
    draft.regressionEvidence, draft.verificationResult, actor.id, draft.status, now,
    draft.verificationResult, now, now, incidentId, expectedVersion,
  );
  const audit = db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     SELECT ?, ?, 'incident.update', 'incident', ?, ?, ?
     WHERE changes() = 1`,
  ).bind(classroomId("class-audit"), actor.id, incidentId, JSON.stringify({
    severity: draft.severity,
    status: draft.status,
    sourceRequestId: draft.sourceRequestId,
    verificationRequestId: draft.verificationRequestId,
    fixRelease: draft.fixRelease,
    verificationResult: draft.verificationResult,
  }), now);
  const [result] = await db.batch([update, audit]);
  if ((result.meta.changes ?? 0) !== 1) {
    const exists = await db.prepare("SELECT id FROM classroom_incidents WHERE id = ?").bind(incidentId).first<{ id: string }>();
    return exists ? "conflict" : "not_found";
  }
  const row = await db.prepare(`SELECT ${INCIDENT_COLUMNS} FROM classroom_incidents WHERE id = ?`).bind(incidentId).first<Parameters<typeof mapIncident>[0]>();
  if (!row) return "not_found";
  return mapIncident(row);
}
