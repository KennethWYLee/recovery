export const CLASSROOM_RELEASE = "classroom-0.3.0-unverified";
export const CLASSROOM_LOG_RETENTION_DAYS = 90;

export type ClassroomLogWindow = "24h" | "7d" | "30d";
export type ClassroomOperationOutcome = "success" | "client_error" | "server_error";
export type ClassroomLogCaptureKind = "error" | "mutation" | "slow" | "sample";
export type ClassroomIncidentSeverity = "low" | "medium" | "high" | "critical";
export type ClassroomIncidentStatus = "open" | "investigating" | "resolved";

const IDENTIFIER_SEGMENT = /\/(?:course|session|question|question-bank|access-request|participant|group)-[a-z0-9-]{6,100}(?=\/|$)/giu;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,79}$/u;
const SAFE_RELEASE = /^[a-zA-Z0-9._-]{4,120}$/u;

export function normalizeClassroomRelease(value: unknown): string {
  return typeof value === "string" && SAFE_RELEASE.test(value) ? value : CLASSROOM_RELEASE;
}

export function classroomRecordedSuccessShare(total: number, successful: number): number | null {
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  const boundedSuccessful = Number.isSafeInteger(successful) ? Math.min(total, Math.max(0, successful)) : 0;
  return Number(((boundedSuccessful / total) * 100).toFixed(1));
}

export function normalizeClassroomLogWindow(value: unknown): ClassroomLogWindow {
  return value === "24h" || value === "30d" ? value : "7d";
}

export function classroomLogWindowStart(window: ClassroomLogWindow, now = new Date()): string {
  const duration = window === "24h" ? 24 * 60 * 60 * 1_000 : window === "7d" ? 7 * 24 * 60 * 60 * 1_000 : 30 * 24 * 60 * 60 * 1_000;
  return new Date(now.getTime() - duration).toISOString();
}

export function normalizeClassroomRoute(value: string): string {
  let pathname = "/unknown";
  try {
    pathname = new URL(value, "https://classroom.invalid").pathname;
  } catch {
    return pathname;
  }
  const normalized = pathname
    .replace(IDENTIFIER_SEGMENT, "/:id")
    .replace(/^\/api\/classroom\/join\/[^/]+$/u, "/api/classroom/join/:joinCode");
  return normalized.startsWith("/api/classroom/") ? normalized.slice(0, 180) : "/unknown";
}

export function classroomLogScope(value: string): { type: "course" | "session" | "question" | "system"; id: string | null } {
  let pathname = "";
  try {
    pathname = new URL(value, "https://classroom.invalid").pathname;
  } catch {
    return { type: "system", id: null };
  }
  const question = pathname.match(/\/(question-[a-z0-9-]{6,100})(?:\/|$)/iu)?.[1];
  if (question) return { type: "question", id: question };
  const session = pathname.match(/\/(session-[a-z0-9-]{8,80})(?:\/|$)/iu)?.[1];
  if (session) return { type: "session", id: session };
  const course = pathname.match(/\/(course-[a-z0-9-]{8,80})(?:\/|$)/iu)?.[1];
  return course ? { type: "course", id: course } : { type: "system", id: null };
}

export function normalizeClassroomErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  return SAFE_ERROR_CODE.test(normalized) ? normalized : null;
}

export function classroomOperationOutcome(statusCode: number): ClassroomOperationOutcome {
  if (statusCode >= 500) return "server_error";
  if (statusCode >= 400) return "client_error";
  return "success";
}

export function classroomSecurityRelevant(statusCode: number, errorCode: string | null): boolean {
  if (statusCode === 401 || statusCode === 403 || statusCode === 429) return true;
  return Boolean(errorCode && /(?:AUTHENTICATION|ACCESS_|PERMISSION_|ORIGIN_|DOMAIN_|RATE_LIMITED|REQUEST_TOO_LARGE|TEST_MODE_)/u.test(errorCode));
}

export function boundedDurationMilliseconds(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(120_000, Math.round(value));
}

export function classroomLogCaptureKind(
  requestId: string,
  method: string,
  statusCode: number,
  durationMs: number,
): ClassroomLogCaptureKind | null {
  if (statusCode >= 400) return "error";
  if (!["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return "mutation";
  if (durationMs >= 1_000) return "slow";
  const sampleByte = Number.parseInt(requestId.replace(/[^a-f0-9]/giu, "").slice(-2), 16);
  return Number.isFinite(sampleByte) && sampleByte % 10 === 0 ? "sample" : null;
}

export function percentile95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.map(boundedDurationMilliseconds).sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function normalizedText(value: unknown, maximumLength: number): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "").replace(/\r\n?/gu, "\n").trim().slice(0, maximumLength);
}

export type ClassroomIncidentDraft = {
  title: string;
  severity: ClassroomIncidentSeverity;
  status: ClassroomIncidentStatus;
  sourceRequestId: string | null;
  verificationRequestId: string | null;
  symptom: string;
  rootCause: string;
  resolution: string;
  fixRelease: string;
  regressionCheck: string;
  regressionCommand: string;
  regressionEvidence: string;
  verificationResult: "not_run" | "passed" | "failed";
};

export type ClassroomIncidentRequestEvidence = {
  outcome: string;
  release: string;
  occurredAt: string;
};

export function classroomResolvedIncidentEvidenceIsValid(
  draft: ClassroomIncidentDraft,
  source: ClassroomIncidentRequestEvidence | null,
  verification: ClassroomIncidentRequestEvidence | null,
): boolean {
  if (draft.status !== "resolved") return true;
  if (!draft.sourceRequestId || !draft.verificationRequestId || draft.sourceRequestId === draft.verificationRequestId) return false;
  if (!source || !verification || verification.outcome !== "success" || verification.release !== draft.fixRelease) return false;
  if (verification.release.endsWith("-unverified")) return false;
  const sourceTime = Date.parse(source.occurredAt);
  const verificationTime = Date.parse(verification.occurredAt);
  return Number.isFinite(sourceTime) && Number.isFinite(verificationTime) && verificationTime > sourceTime;
}

function resolvedIncidentDraftIsComplete(draft: ClassroomIncidentDraft): boolean {
  if (draft.status !== "resolved") return true;
  return draft.rootCause.length >= 8 && draft.resolution.length >= 8 && draft.fixRelease.length >= 4 &&
    draft.regressionCheck.length >= 4 && draft.regressionCommand.length >= 3 && draft.regressionEvidence.length >= 8 &&
    Boolean(draft.sourceRequestId) && Boolean(draft.verificationRequestId) &&
    draft.sourceRequestId !== draft.verificationRequestId && normalizeClassroomRelease(draft.fixRelease) === draft.fixRelease &&
    !draft.fixRelease.endsWith("-unverified") && draft.verificationResult === "passed";
}

export function normalizeClassroomIncidentDraft(value: unknown): ClassroomIncidentDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const title = normalizedText(record.title, 120);
  const symptom = normalizedText(record.symptom, 2_000);
  const rootCause = normalizedText(record.rootCause, 2_000);
  const resolution = normalizedText(record.resolution, 2_000);
  const regressionEvidence = normalizedText(record.regressionEvidence, 2_000);
  const fixRelease = normalizedText(record.fixRelease, 120);
  const regressionCheck = normalizedText(record.regressionCheck, 240);
  const regressionCommand = normalizedText(record.regressionCommand, 500);
  const severity = record.severity;
  const status = record.status;
  const sourceRequestId = normalizedText(record.sourceRequestId, 80) || null;
  const verificationRequestId = normalizedText(record.verificationRequestId, 80) || null;
  const verificationResult = record.verificationResult;
  if (title.length < 4 || symptom.length < 8) return null;
  if (severity !== "low" && severity !== "medium" && severity !== "high" && severity !== "critical") return null;
  if (status !== "open" && status !== "investigating" && status !== "resolved") return null;
  if (sourceRequestId && !/^req-[a-f0-9-]{16,64}$/u.test(sourceRequestId)) return null;
  if (verificationRequestId && !/^req-[a-f0-9-]{16,64}$/u.test(verificationRequestId)) return null;
  if (verificationResult !== "not_run" && verificationResult !== "passed" && verificationResult !== "failed") return null;
  const draft: ClassroomIncidentDraft = {
    title, severity, status, sourceRequestId, verificationRequestId, symptom, rootCause, resolution,
    fixRelease, regressionCheck, regressionCommand, regressionEvidence, verificationResult,
  };
  return resolvedIncidentDraftIsComplete(draft) ? draft : null;
}
