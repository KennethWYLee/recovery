"use client";

import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Activity,
  Boxes,
  Check,
  Clock3,
  LayoutDashboard,
  Menu,
  Plus,
  RefreshCcw,
  ScrollText,
  Search,
  ShieldCheck,
  Siren,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ObservabilitySnapshot, ObservabilityWindow } from "@/db/operations-telemetry";
import { normalizeObservabilitySnapshot } from "@/lib/observability-client";
import {
  canApproveIncidentCommunication,
  canDraftIncidentCommunication,
  incidentStatusMatchesFilter,
  isOrganizationRole,
  organizationRoleCanHoldIncidentRole,
  serviceCanAcceptNewIncidents,
  type IncidentRole,
  type OrganizationRole,
} from "@/lib/operations-domain";
import { parseZonedDateTimeInput, resolveOrganizationTimeZone, toZonedDateTimeInput } from "@/lib/operations-time";

const ObservabilityView = lazy(() => import("./ObservabilityView").then((module) => ({ default: module.ObservabilityView })));

export type InitialIdentity = {
  displayName: string;
  email: string;
  mode: "hosted" | "local";
  signOutPath: string;
};

type Severity = "SEV1" | "SEV2" | "SEV3" | "SEV4";
type IncidentEnvironment = "production" | "staging" | "development" | "other";
type IncidentStatus =
  | "declared"
  | "investigating"
  | "mitigating"
  | "monitoring"
  | "resolved"
  | "closed"
  | "cancelled";
type ServiceStatus = "operational" | "degraded" | "disrupted" | "maintenance" | "unknown";
type TaskStatus = "open" | "in_progress" | "blocked" | "completed" | "cancelled";
type TaskPriority = "critical" | "high" | "medium" | "low";
type CommunicationAudience = "internal" | "stakeholder" | "public";
type CommunicationStatus = "draft" | "reviewed" | "published";
type ViewId = "overview" | "observability" | "incidents" | "services" | "audit" | "access";
type WorkspaceTab = "summary" | "timeline" | "tasks" | "communications" | "review";
type Actor = {
  id: string;
  displayName: string;
  email: string;
  roles: string[];
  teamNames?: string[];
  permissions?: string[];
};

type Organization = {
  id: string;
  name: string;
  timezone?: string;
};

type Operator = {
  id: string;
  membershipId?: string;
  membershipVersion: number;
  displayName: string;
  email: string;
  roles: string[];
  teamNames?: string[];
  status?: "active" | "suspended";
  lastSeenAt?: string | null;
};

type OverviewMetrics = {
  activeIncidents: number;
  sev1Incidents: number;
  unassignedIncidents: number | null;
  overdueTasks: number;
  servicesAtRisk: number;
  incidentAffectedServices: number;
  monitoredServices: number;
  sloBreaches: number | null;
  meanTimeToAcknowledgeMinutes: number | null;
  meanTimeToRestoreMinutes: number | null;
  acknowledgeSampleSize: number;
  restoreSampleSize: number;
};

type IncidentSummary = {
  id: string;
  key: string;
  title: string;
  summary?: string;
  severity: Severity;
  status: IncidentStatus;
  environment: IncidentEnvironment;
  serviceId: string;
  serviceName: string;
  commander?: { id: string; displayName: string } | null;
  startedAt: string;
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
  updatedAt: string;
  version: number;
  affectedScope?: string;
  tags?: string[];
};

type TimelineEntry = {
  id: string;
  kind: "declaration" | "status" | "investigation" | "mitigation" | "communication" | "evidence" | "system";
  message: string;
  occurredAt: string;
  actor: { id: string; displayName: string };
  result?: "success" | "failure" | "denied" | "info";
  referenceUrl?: string | null;
  sourceLabel?: string | null;
  observedFrom?: string | null;
  observedTo?: string | null;
  sha256Digest?: string | null;
  fromStatus?: IncidentStatus | null;
  toStatus?: IncidentStatus | null;
};

type IncidentTask = {
  id: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  owner?: { id: string; displayName: string } | null;
  dueAt?: string | null;
  createdAt: string;
  updatedAt: string;
  evidenceRef?: string | null;
  cancellationReason?: string | null;
  version: number;
};

type IncidentCommunication = {
  id: string;
  audience: CommunicationAudience;
  status: CommunicationStatus;
  message: string;
  affectedComponents: string[];
  nextUpdateAt: string | null;
  version: number;
  createdByUserId: string;
  updatedByUserId: string;
  reviewedByUserId: string | null;
  publishedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  publishedAt: string | null;
};

type IncidentReview = {
  id?: string;
  status: "draft" | "final";
  summary: string;
  customerImpact: string;
  rootCause: string;
  detectionGap: string;
  lessonsLearned: string;
  followUpActions: string;
  version?: number;
  owner?: { id: string; displayName: string } | null;
  updatedAt?: string | null;
};

type IncidentAssignment = {
  assignmentId: string;
  id: string;
  displayName: string;
  role: string;
  incidentRole: IncidentRole;
  team?: string;
};

type IncidentDetail = IncidentSummary & {
  impact?: string;
  currentHypothesis?: string;
  currentMitigation?: string;
  verificationCriteria?: string;
  responders: IncidentAssignment[];
  service?: Service | null;
  timeline: TimelineEntry[];
  tasks: IncidentTask[];
  communications: IncidentCommunication[];
  review?: IncidentReview | null;
};

type Service = {
  id: string;
  key: string;
  name: string;
  description?: string;
  tier: "tier_1" | "tier_2" | "tier_3" | "tier_4";
  status: ServiceStatus;
  telemetryStatus: "available" | "unavailable";
  lifecycleStatus: "active" | "deprecated";
  statusChangeReason?: string | null;
  statusChangedAt?: string | null;
  statusChangedByUserId?: string | null;
  statusChangedByName?: string | null;
  statusChangeRequestId?: string | null;
  ownerName?: string | null;
  ownerTeam: string;
  sloTarget: number | null;
  sloAttainment: number | null;
  errorBudgetRemaining: number | null;
  activeIncidentCount: number;
  dependencies?: string[];
  runbookUrl?: string | null;
  version: number;
  updatedAt: string;
};

type ServiceLifecycleEvent = {
  id: string;
  serviceId: string;
  fromStatus: Service["lifecycleStatus"];
  toStatus: Service["lifecycleStatus"];
  reason: string;
  actor: { id: string; displayName: string };
  requestId: string;
  changedAt: string;
};

type ServiceLifecycleHistory = {
  status: "loading" | "ready" | "error";
  serviceVersion: number;
  events: ServiceLifecycleEvent[];
  nextCursor: string | null;
  loadingMore: boolean;
  failedCursor?: string | null;
  error?: DisplayError;
};

type AuditRecord = {
  id: string;
  occurredAt: string;
  actor: { id: string; displayName: string; email?: string };
  action: string;
  resourceType: string;
  resourceKey: string;
  result: "success" | "failure" | "denied";
  requestId?: string;
  source?: string;
  actorRole?: string;
  reasonCode?: string | null;
  details?: Record<string, unknown> | null;
};

type HealthStatus = {
  status: "operational" | "degraded" | "unavailable";
  version?: string;
  checkedAt?: string;
  database?: "operational" | "degraded" | "unavailable";
};

type OperationsSnapshot = {
  actor: Actor;
  organization: Organization;
  metrics: OverviewMetrics;
  incidents: IncidentSummary[];
  services: Service[];
  operators: Operator[];
  recentAudit: AuditRecord[];
};

type AccessData = {
  actor: Actor;
  organization?: Organization;
  operators: Operator[];
  permissions?: string[];
  policies?: { id: string; name: string; description: string; status: "enforced" | "disabled" }[];
};

type ServiceCreateInput = {
  key: string;
  name: string;
  description: string;
  ownerTeam: string;
  ownerEmail?: string;
  tier: Service["tier"];
  sloTarget: number;
  runbookUrl?: string;
};

type CommunicationDraftInput = {
  audience: CommunicationAudience;
  message: string;
  affectedComponents: string[];
  nextUpdateAt?: string | null;
};

type TaskUpdateInput = {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  assigneeUserId?: string | null;
  dueAt?: string | null;
  evidenceRef?: string | null;
  cancellationReason?: string | null;
};

type ServiceUpdateInput = {
  name?: string;
  description?: string;
  ownerEmail?: string | null;
  ownerTeam?: string;
  tier?: Service["tier"];
  sloTarget?: number;
  runbookUrl?: string | null;
  status?: Service["lifecycleStatus"];
  statusChangeReason?: string;
  lifecycleConfirmed?: true;
};

type IncidentOverviewInput = {
  impactSummary: string;
  currentHypothesis: string;
  currentMitigation: string;
  verificationCriteria: string;
};

type MemberCreateInput = {
  email: string;
  displayName: string;
  role: OrganizationRole;
};

type ApiEnvelope<T> = {
  ok?: boolean;
  requestId?: string;
  data?: T;
  error?: { code?: string; message?: string };
  code?: string;
  message?: string;
  detail?: string;
  title?: string;
  meta?: { requestId?: string };
};

type DisplayError = {
  message: string;
  requestId?: string;
  code?: string;
  status?: number;
};

class ApiError extends Error {
  status: number;
  requestId?: string;
  code?: string;

  constructor(message: string, status: number, requestId?: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.requestId = requestId;
    this.code = code;
  }
}

const NAV_ITEMS: { id: ViewId; label: string; description: string; icon: IconName }[] = [
  { id: "overview", label: "營運總覽", description: "風險與待處理事項", icon: "grid" },
  { id: "observability", label: "系統觀測", description: "流量、錯誤與延遲", icon: "pulse" },
  { id: "incidents", label: "事件指揮", description: "共享事件工作區", icon: "incident" },
  { id: "services", label: "服務目錄", description: "責任、SLO 與操作手冊", icon: "service" },
  { id: "audit", label: "稽核紀錄", description: "操作、結果與請求編號", icon: "audit" },
  { id: "access", label: "存取與權限", description: "角色與政策狀態", icon: "access" },
];

const NAV_PERMISSIONS: Record<ViewId, readonly string[]> = {
  overview: [],
  observability: ["observability:read"],
  incidents: ["incident:read"],
  services: ["service:read"],
  audit: ["audit:read"],
  access: ["access:read", "access:manage", "incident:assign"],
};
const NO_PERMISSIONS: readonly string[] = [];

const VIEW_IDS: readonly ViewId[] = ["overview", "observability", "incidents", "services", "audit", "access"];
const WORKSPACE_TABS: readonly WorkspaceTab[] = ["summary", "timeline", "tasks", "communications", "review"];

const SEVERITY_ORDER: Record<Severity, number> = { SEV1: 1, SEV2: 2, SEV3: 3, SEV4: 4 };
const SEVERITY_LABEL: Record<Severity, string> = {
  SEV1: "重大",
  SEV2: "高",
  SEV3: "中",
  SEV4: "低",
};
const ENVIRONMENT_LABEL: Record<IncidentEnvironment, string> = {
  production: "正式環境",
  staging: "預備環境",
  development: "開發環境",
  other: "其他環境",
};
const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  declared: "已宣告",
  investigating: "調查中",
  mitigating: "處置中",
  monitoring: "監控中",
  resolved: "已解決",
  closed: "已結案",
  cancelled: "已取消",
};
const SERVICE_STATUS_LABEL: Record<ServiceStatus, string> = {
  operational: "正常",
  degraded: "效能下降",
  disrupted: "服務中斷",
  maintenance: "維護中",
  unknown: "未接監控",
};
const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  open: "待處理",
  in_progress: "進行中",
  blocked: "受阻",
  completed: "已完成",
  cancelled: "已取消",
};
const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  critical: "緊急",
  high: "高",
  medium: "中",
  low: "低",
};
const COMMUNICATION_AUDIENCE_LABEL: Record<CommunicationAudience, string> = {
  internal: "內部團隊",
  stakeholder: "利害關係人",
  public: "公開狀態",
};
const COMMUNICATION_STATUS_LABEL: Record<CommunicationStatus, string> = {
  draft: "草稿",
  reviewed: "已核准",
  published: "已發布",
};
const ORGANIZATION_ROLE_LABEL: Record<OrganizationRole, string> = {
  admin: "系統管理員",
  commander: "事件指揮者",
  responder: "應變人員",
  observer: "觀察者",
  auditor: "稽核人員",
};
const INCIDENT_ROLE_LABEL: Record<IncidentRole, string> = {
  incident_commander: "事件指揮官",
  responder: "應變人員",
  communications_lead: "溝通負責人",
  service_owner: "服務負責人",
  observer: "觀察者",
};
const TIMELINE_KIND_LABEL: Record<TimelineEntry["kind"], string> = {
  declaration: "事件宣告",
  status: "狀態更新",
  investigation: "調查紀錄",
  mitigation: "處置紀錄",
  communication: "溝通更新",
  evidence: "驗證證據",
  system: "系統紀錄",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrap<T>(value: unknown): T {
  if (isRecord(value) && "data" in value && value.data !== undefined) return value.data as T;
  return value as T;
}

const MAX_SCHEMA_INITIALIZATION_RETRIES = 5;

function waitForApiRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("The request was aborted.", "AbortError"));
      return;
    }
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("The request was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
  schemaInitializationAttempt = 0,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    signal,
    credentials: "same-origin",
    cache: init?.method && init.method !== "GET" ? "no-store" : "no-store",
    headers: {
      accept: "application/json",
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const contentType = response.headers.get("content-type") ?? "";
  const body: ApiEnvelope<T> | null = contentType.includes("json")
    ? ((await response.json()) as ApiEnvelope<T>)
    : null;
  if (!response.ok || body?.ok === false) {
    const requestId = body?.requestId ?? body?.meta?.requestId ?? response.headers.get("x-request-id") ?? undefined;
    const code = body?.error?.code ?? body?.code;
    const method = (init?.method ?? "GET").toUpperCase();
    const schemaMayBecomeReady = code === "DATABASE_INITIALIZING"
      || (path === "/api/v1/health" && code === "DATABASE_NOT_READY");
    if (
      response.status === 503
      && schemaMayBecomeReady
      && ["GET", "HEAD"].includes(method)
      && schemaInitializationAttempt < MAX_SCHEMA_INITIALIZATION_RETRIES
    ) {
      await waitForApiRetry(Math.min(800, 150 * (2 ** schemaInitializationAttempt)), signal);
      return apiRequest<T>(path, init, signal, schemaInitializationAttempt + 1);
    }
    const message = body?.error?.message ?? body?.detail ?? body?.message ?? body?.title ?? `要求未完成（HTTP ${response.status}）。`;
    throw new ApiError(message, response.status, requestId, code);
  }
  if (response.status === 204) return undefined as T;
  return unwrap<T>(body);
}

function mutationKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function mutationRequest(method: "POST" | "PUT" | "PATCH" | "DELETE", key: string, payload: Record<string, unknown>): RequestInit {
  return {
    method,
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({ ...payload, idempotencyKey: key }),
  };
}

function safeDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTimestamp(value: string | null | undefined, timeZone: string): string {
  const date = safeDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);
}

function formatLongTimestamp(value: string | null | undefined, timeZone: string): string {
  const date = safeDate(value);
  if (!date) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "long",
    hour12: false,
    timeZone,
  }).format(date);
}

function formatDuration(start?: string | null, end?: string | null): string {
  const startDate = safeDate(start);
  const endDate = safeDate(end) ?? new Date();
  if (!startDate) return "—";
  const minutes = Math.max(0, Math.floor((endDate.getTime() - startDate.getTime()) / 60_000));
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours < 24) return `${hours} 小時 ${remainder} 分鐘`;
  const days = Math.floor(hours / 24);
  return `${days} 日 ${hours % 24} 小時`;
}

function formatMinutes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 60) return `${Math.round(value)} 分鐘`;
  return `${(value / 60).toFixed(value >= 600 ? 0 : 1)} 小時`;
}

function isHttpsUrl(value?: string | null): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function getErrorMessage(error: unknown): DisplayError {
  if (error instanceof ApiError) {
    const localized: Partial<Record<string, string>> = {
      RESOLUTION_CRITERIA_REQUIRED: "請先建立可判定復原的驗證條件。",
      RESOLUTION_VERIFICATION_REQUIRED: "請先在時間軸加入一筆驗證證據。",
      RESOLUTION_CRITICAL_TASKS_OPEN: "仍有未完成的緊急工作，暫時不能確認復原。",
      TASK_EVIDENCE_REQUIRED: "工作標記為完成前，必須附上有效的 HTTPS 證據網址。",
      TASK_CANCELLATION_REASON_REQUIRED: "取消緊急工作前，必須填寫 8–1000 字的取消理由。",
      TASK_CANCELLATION_REASON_IMMUTABLE: "已記錄的取消理由不可修改或移除。",
      COMMUNICATION_NEXT_UPDATE_REQUIRED: "對外訊息核准前，必須安排未來更新時間，或將最終公告標記為 [FINAL]。",
      ACTIVE_INCIDENT_HANDOFF_REQUIRED: "這位成員仍指揮進行中的事件。請先完成事件交接，再調整存取權。",
      LAST_ADMIN_REQUIRED: "組織必須保留至少一位啟用中的系統管理員。",
      VERSION_CONFLICT: "資料已由其他人更新。請載入最新版，確認目前草稿後再提交。",
    };
    return {
      message: (error.code && localized[error.code]) || error.message,
      requestId: error.requestId,
      code: error.code,
      status: error.status,
    };
  }
  if (error instanceof Error) return { message: error.message };
  return { message: "無法完成要求。" };
}

function initials(name: string): string {
  const compact = name.trim();
  if (!compact) return "?";
  const words = compact.split(/\s+/).filter(Boolean);
  return words.length > 1 ? `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase() : compact.slice(0, 2).toUpperCase();
}

function textValue(record: Record<string, unknown>, key: string, fallback = ""): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function numberValue(record: Record<string, unknown>, key: string, fallback = 0): number {
  const value = Number(record[key]);
  return Number.isFinite(value) ? value : fallback;
}

function invalidResponse(field: string): never {
  throw new ApiError(`伺服器回應中的 ${field} 無效；已停止更新畫面，避免顯示錯誤狀態。`, 502, undefined, "INVALID_RESPONSE");
}

function requiredTextValue(record: Record<string, unknown>, key: string, field: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) invalidResponse(field);
  return value;
}

function requiredTimestampValue(record: Record<string, unknown>, key: string, field: string): string {
  const value = requiredTextValue(record, key, field);
  if (!safeDate(value)) invalidResponse(field);
  return value;
}

function nullableTimestampValue(record: Record<string, unknown>, key: string, field: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !safeDate(value)) invalidResponse(field);
  return value;
}

function positiveVersionValue(record: Record<string, unknown>, key: string, field: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalidResponse(field);
  return value;
}

function parseEnumValue<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) invalidResponse(field);
  return value as T;
}

function normalizeList<T>(values: unknown[], normalizer: (value: unknown) => T | null, field: string): T[] {
  return values.map((value, index) => {
    const normalized = normalizer(value);
    if (normalized == null) invalidResponse(`${field}[${index}]`);
    return normalized;
  });
}

function normalizeSeverity(value: unknown): Severity {
  const normalized = typeof value === "string" ? value.toUpperCase() : "";
  return parseEnumValue(normalized, ["SEV1", "SEV2", "SEV3", "SEV4"] as const, "incident.severity");
}

function normalizeIncidentStatus(value: unknown, field = "incident.status"): IncidentStatus {
  return parseEnumValue(value, ["declared", "investigating", "mitigating", "monitoring", "resolved", "closed", "cancelled"] as const, field);
}

function normalizeIncidentEnvironment(value: unknown): IncidentEnvironment {
  return parseEnumValue(value, ["production", "staging", "development", "other"] as const, "incident.environment");
}

function normalizeIncident(value: unknown, serviceNames = new Map<string, string>()): IncidentSummary {
  if (!isRecord(value)) invalidResponse("incident");
  const id = requiredTextValue(value, "id", "incident.id");
  const serviceId = requiredTextValue(value, "serviceId", "incident.serviceId");
  const commanderRecord = isRecord(value.commander) ? value.commander : null;
  return {
    id,
    key: requiredTextValue(value, "incidentNumber", "incident.incidentNumber"),
    title: requiredTextValue(value, "title", "incident.title"),
    summary: textValue(value, "summary"),
    severity: normalizeSeverity(value.severity),
    status: normalizeIncidentStatus(value.status),
    environment: normalizeIncidentEnvironment(value.environment),
    serviceId,
    serviceName: textValue(value, "serviceName", serviceNames.get(serviceId) ?? "未知服務"),
    commander: commanderRecord ? { id: textValue(commanderRecord, "id"), displayName: textValue(commanderRecord, "displayName", "未命名") } : null,
    startedAt: requiredTimestampValue(value, "declaredAt", "incident.declaredAt"),
    acknowledgedAt: textValue(value, "acknowledgedAt") || null,
    resolvedAt: textValue(value, "resolvedAt") || null,
    updatedAt: requiredTimestampValue(value, "updatedAt", "incident.updatedAt"),
    version: positiveVersionValue(value, "version", "incident.version"),
    affectedScope: textValue(value, "impactSummary", textValue(value, "affectedScope")),
    tags: Array.isArray(value.tags) ? value.tags.filter((item): item is string => typeof item === "string") : [],
  };
}

function normalizeService(value: unknown, incidents: IncidentSummary[] = []): Service {
  if (!isRecord(value)) invalidResponse("service");
  const id = requiredTextValue(value, "id", "service.id");
  const rawStatus = textValue(value, "healthStatus");
  const status: ServiceStatus = rawStatus
    ? parseEnumValue(rawStatus, ["operational", "degraded", "disrupted", "maintenance", "unknown"] as const, "service.healthStatus")
    : "unknown";
  const lifecycleStatus = parseEnumValue(value.status, ["active", "deprecated"] as const, "service.status");
  const telemetryRaw = textValue(value, "telemetryStatus");
  const telemetryStatus: Service["telemetryStatus"] = telemetryRaw
    ? parseEnumValue(telemetryRaw, ["available", "unavailable"] as const, "service.telemetryStatus")
    : "unavailable";
  const tier = parseEnumValue(value.tier, ["tier_1", "tier_2", "tier_3", "tier_4"] as const, "service.tier");
  return {
    id,
    key: textValue(value, "slug", textValue(value, "key", id)).toUpperCase(),
    name: textValue(value, "name", "未命名服務"),
    description: textValue(value, "description"),
    tier,
    status: telemetryStatus === "unavailable" ? "unknown" : status,
    telemetryStatus,
    lifecycleStatus,
    statusChangeReason: textValue(value, "statusChangeReason") || null,
    statusChangedAt: textValue(value, "statusChangedAt") || null,
    statusChangedByUserId: textValue(value, "statusChangedByUserId") || null,
    statusChangedByName: textValue(value, "statusChangedByName") || null,
    statusChangeRequestId: textValue(value, "statusChangeRequestId") || null,
    ownerName: textValue(value, "ownerName") || null,
    ownerTeam: textValue(value, "ownerTeam", textValue(value, "ownerName", "待指派")),
    sloTarget: value.sloTarget == null ? null : numberValue(value, "sloTarget"),
    sloAttainment: value.sloAttainment == null ? null : numberValue(value, "sloAttainment"),
    errorBudgetRemaining: value.errorBudgetRemaining == null ? null : numberValue(value, "errorBudgetRemaining"),
    activeIncidentCount: incidents.filter((incident) => incident.serviceId === id && !["closed", "cancelled"].includes(incident.status)).length,
    dependencies: Array.isArray(value.dependencies) ? value.dependencies.filter((item): item is string => typeof item === "string") : [],
    runbookUrl: isHttpsUrl(textValue(value, "runbookUrl")) ? textValue(value, "runbookUrl") : null,
    version: positiveVersionValue(value, "version", "service.version"),
    updatedAt: requiredTimestampValue(value, "updatedAt", "service.updatedAt"),
  };
}

function normalizeServiceLifecycleEvent(value: unknown, expectedServiceId: string): ServiceLifecycleEvent {
  if (!isRecord(value)) invalidResponse("service.lifecycleEvent");
  const actor = isRecord(value.actor) ? value.actor : {};
  const serviceId = requiredTextValue(value, "serviceId", "service.lifecycleEvent.serviceId");
  if (serviceId !== expectedServiceId) invalidResponse("service.lifecycleEvent.serviceId");
  return {
    id: requiredTextValue(value, "id", "service.lifecycleEvent.id"),
    serviceId,
    fromStatus: parseEnumValue(value.fromStatus, ["active", "deprecated"] as const, "service.lifecycleEvent.fromStatus"),
    toStatus: parseEnumValue(value.toStatus, ["active", "deprecated"] as const, "service.lifecycleEvent.toStatus"),
    reason: requiredTextValue(value, "reason", "service.lifecycleEvent.reason"),
    actor: {
      id: requiredTextValue(actor, "id", "service.lifecycleEvent.actor.id"),
      displayName: textValue(actor, "displayName", "操作者未列出"),
    },
    requestId: requiredTextValue(value, "requestId", "service.lifecycleEvent.requestId"),
    changedAt: requiredTimestampValue(value, "changedAt", "service.lifecycleEvent.changedAt"),
  };
}

function normalizeActor(value: unknown, permissions: string[] = []): Actor | null {
  if (!isRecord(value)) return null;
  const id = textValue(value, "id");
  const email = textValue(value, "email");
  if (!id && !email) return null;
  const role = textValue(value, "role");
  return {
    id: id || email,
    email,
    displayName: textValue(value, "displayName", email),
    roles: Array.isArray(value.roles) ? value.roles.filter((item): item is string => typeof item === "string") : role ? [role] : [],
    teamNames: Array.isArray(value.teamNames) ? value.teamNames.filter((item): item is string => typeof item === "string") : [],
    permissions,
  };
}

function normalizeOperator(value: unknown): Operator | null {
  if (!isRecord(value)) return null;
  const membershipId = textValue(value, "id");
  const userId = textValue(value, "userId", membershipId);
  const actor = normalizeActor({ ...value, id: userId });
  if (!actor) return null;
  const status = parseEnumValue(value.status, ["active", "suspended"] as const, "member.status");
  return {
    ...actor,
    membershipId: membershipId || undefined,
    membershipVersion: positiveVersionValue(value, "version", "member.version"),
    status,
    lastSeenAt: textValue(value, "lastSeenAt") || null,
  };
}

function normalizeTimelineEntry(value: unknown): TimelineEntry {
  if (!isRecord(value)) invalidResponse("timeline event");
  const id = requiredTextValue(value, "id", "timeline.id");
  const rawKind = textValue(value, "eventType", textValue(value, "kind"));
  const kindMap: Record<string, TimelineEntry["kind"]> = {
    status_change: "status",
    note: "investigation",
    investigation: "investigation",
    mitigation: "mitigation",
    verification: "evidence",
    communication: "communication",
    task: "system",
    assignment: "system",
    review: "system",
    declaration: "declaration",
    system: "system",
  };
  const kind = kindMap[rawKind];
  if (!kind) invalidResponse("timeline.eventType");
  const actorValue = isRecord(value.actor) ? value.actor : null;
  return {
    id,
    kind,
    message: textValue(value, "message"),
    occurredAt: requiredTimestampValue(value, "createdAt", "timeline.createdAt"),
    actor: {
      id: actorValue ? textValue(actorValue, "id") : textValue(value, "actorUserId"),
      displayName: actorValue ? textValue(actorValue, "displayName", "系統") : textValue(value, "actorName", "系統"),
    },
    result: "info",
    referenceUrl: textValue(value, "referenceUrl") || null,
    sourceLabel: textValue(value, "sourceLabel") || null,
    observedFrom: textValue(value, "observedFrom") || null,
    observedTo: textValue(value, "observedTo") || null,
    sha256Digest: textValue(value, "sha256Digest") || null,
    fromStatus: textValue(value, "fromStatus") ? normalizeIncidentStatus(value.fromStatus, "timeline.fromStatus") : null,
    toStatus: textValue(value, "toStatus") ? normalizeIncidentStatus(value.toStatus, "timeline.toStatus") : null,
  };
}

function normalizeTask(value: unknown): IncidentTask {
  if (!isRecord(value)) invalidResponse("task");
  const id = requiredTextValue(value, "id", "task.id");
  const status = parseEnumValue(value.status, ["open", "in_progress", "blocked", "completed", "cancelled"] as const, "task.status");
  const priority = parseEnumValue(value.priority, ["critical", "high", "medium", "low"] as const, "task.priority");
  const ownerValue = isRecord(value.owner) ? value.owner : null;
  const assigneeId = textValue(value, "assigneeUserId");
  const assigneeName = textValue(value, "assigneeName");
  return {
    id,
    title: requiredTextValue(value, "title", "task.title"),
    description: textValue(value, "description") || undefined,
    status,
    priority,
    owner: ownerValue
      ? { id: textValue(ownerValue, "id"), displayName: textValue(ownerValue, "displayName", "未命名") }
      : assigneeId || assigneeName ? { id: assigneeId, displayName: assigneeName || assigneeId } : null,
    dueAt: textValue(value, "dueAt") || null,
    createdAt: requiredTimestampValue(value, "createdAt", "task.createdAt"),
    updatedAt: requiredTimestampValue(value, "updatedAt", "task.updatedAt"),
    evidenceRef: textValue(value, "evidenceRef") || null,
    cancellationReason: textValue(value, "cancellationReason") || null,
    version: positiveVersionValue(value, "version", "task.version"),
  };
}

function normalizeCommunication(value: unknown): IncidentCommunication {
  if (!isRecord(value)) invalidResponse("communication");
  const components = value.affectedComponents;
  if (!Array.isArray(components) || components.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    invalidResponse("communication.affectedComponents");
  }
  return {
    id: requiredTextValue(value, "id", "communication.id"),
    audience: parseEnumValue(value.audience, ["internal", "stakeholder", "public"] as const, "communication.audience"),
    status: parseEnumValue(value.status, ["draft", "reviewed", "published"] as const, "communication.status"),
    message: requiredTextValue(value, "message", "communication.message"),
    affectedComponents: components as string[],
    nextUpdateAt: nullableTimestampValue(value, "nextUpdateAt", "communication.nextUpdateAt"),
    version: positiveVersionValue(value, "version", "communication.version"),
    createdByUserId: requiredTextValue(value, "createdByUserId", "communication.createdByUserId"),
    updatedByUserId: requiredTextValue(value, "updatedByUserId", "communication.updatedByUserId"),
    reviewedByUserId: textValue(value, "reviewedByUserId") || null,
    publishedByUserId: textValue(value, "publishedByUserId") || null,
    createdAt: requiredTimestampValue(value, "createdAt", "communication.createdAt"),
    updatedAt: requiredTimestampValue(value, "updatedAt", "communication.updatedAt"),
    reviewedAt: nullableTimestampValue(value, "reviewedAt", "communication.reviewedAt"),
    publishedAt: nullableTimestampValue(value, "publishedAt", "communication.publishedAt"),
  };
}

function normalizeReview(value: unknown): IncidentReview | null {
  if (value == null) return null;
  if (!isRecord(value)) invalidResponse("review");
  const rawStatus = parseEnumValue(value.status, ["draft", "completed"] as const, "review.status");
  return {
    id: textValue(value, "id") || undefined,
    status: rawStatus === "completed" ? "final" : "draft",
    summary: textValue(value, "summary"),
    customerImpact: textValue(value, "customerImpact"),
    rootCause: textValue(value, "rootCause"),
    detectionGap: textValue(value, "detectionGap"),
    lessonsLearned: textValue(value, "lessonsLearned"),
    followUpActions: textValue(value, "followUpActions"),
    version: positiveVersionValue(value, "version", "review.version"),
    owner: null,
    updatedAt: textValue(value, "updatedAt") || null,
  };
}

function normalizeAuditRecord(value: unknown): AuditRecord {
  if (!isRecord(value)) invalidResponse("audit event");
  const id = requiredTextValue(value, "id", "audit.id");
  const actorValue = isRecord(value.actor) ? value.actor : null;
  const rawResult = textValue(value, "outcome", textValue(value, "result"));
  const result = parseEnumValue(rawResult, ["success", "failure", "denied"] as const, "audit.result");
  return {
    id,
    occurredAt: requiredTimestampValue(value, "occurredAt", "audit.occurredAt"),
    actor: {
      id: actorValue ? textValue(actorValue, "id") : textValue(value, "actorUserId"),
      displayName: actorValue ? textValue(actorValue, "displayName", "未知操作者") : textValue(value, "actorName", "未知操作者"),
      email: actorValue ? textValue(actorValue, "email") : textValue(value, "actorEmail"),
    },
    action: textValue(value, "action"),
    resourceType: textValue(value, "resourceType"),
    resourceKey: textValue(value, "resourceKey", textValue(value, "resourceId")),
    result,
    requestId: textValue(value, "requestId") || undefined,
    source: textValue(value, "source") || undefined,
    actorRole: textValue(value, "actorRole") || undefined,
    reasonCode: textValue(value, "reasonCode") || null,
    details: isRecord(value.details) ? value.details : null,
  };
}

function incidentRoleLabel(role: string): string {
  return INCIDENT_ROLE_LABEL[role as IncidentRole] ?? role;
}

function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    "access.member.auto_provision": "建立校內唯讀帳號",
    "access.member.create": "新增組織成員",
    "access.member.update": "更新成員存取權",
    "service.create": "建立服務",
    "service.update": "更新服務",
    "incident.create": "宣告事件",
    "incident.update": "更新事件總覽",
    "incident.assignment.create": "指派事件角色",
    "incident.assignment.revoke": "撤銷事件角色",
    "incident.assignment.handoff": "交接事件指揮",
    "incident.timeline.create": "新增時間軸紀錄",
    "incident.task.create": "建立工作項目",
    "incident.task.update": "更新工作項目",
    "incident.communication.create": "建立通訊草稿",
    "incident.communication.update": "更新通訊草稿",
    "incident.communication.review": "核准事件通訊",
    "incident.communication.publish": "標記事件通訊已發布",
    "incident.review.create": "建立事後檢討",
    "incident.review.update": "更新事後檢討",
    "incident.review.reopen": "重新開啟事後檢討",
  };
  if (labels[action]) return labels[action];
  if (action.startsWith("incident.transition")) return "變更事件狀態";
  return "系統操作";
}

function auditResourceLabel(resourceType: string): string {
  const labels: Record<string, string> = {
    incident: "事件",
    service: "服務",
    task: "工作項目",
    membership: "成員存取權",
    incident_assignment: "事件角色",
    incident_communication: "事件通訊",
    post_incident_review: "事後檢討",
  };
  return labels[resourceType] ?? resourceType;
}

type IconName = "grid" | "pulse" | "incident" | "service" | "audit" | "access" | "search" | "refresh" | "plus" | "menu" | "close" | "clock" | "check" | "arrow";

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const glyphs: Record<IconName, LucideIcon> = {
    grid: LayoutDashboard,
    pulse: Activity,
    incident: Siren,
    service: Boxes,
    audit: ScrollText,
    access: ShieldCheck,
    search: Search,
    refresh: RefreshCcw,
    plus: Plus,
    menu: Menu,
    close: X,
    clock: Clock3,
    check: Check,
    arrow: ArrowRight,
  };
  const Glyph = glyphs[name];
  return <Glyph className={`icon icon-${name}`} size={size} strokeWidth={2} aria-hidden="true" />;
}

type NavigationState = {
  view: ViewId;
  incidentId: string | null;
  tab: WorkspaceTab;
};

function navigationFromUrl(url: URL): NavigationState {
  const rawView = url.searchParams.get("view");
  const rawTab = url.searchParams.get("tab");
  return {
    view: rawView && VIEW_IDS.includes(rawView as ViewId) ? rawView as ViewId : "overview",
    incidentId: url.searchParams.get("incident"),
    tab: rawTab && WORKSPACE_TABS.includes(rawTab as WorkspaceTab) ? rawTab as WorkspaceTab : "summary",
  };
}

function initialNavigationState(): NavigationState {
  if (typeof window === "undefined") return { view: "overview", incidentId: null, tab: "summary" };
  return navigationFromUrl(new URL(window.location.href));
}

function viewAllowed(view: ViewId, permissions: readonly string[]): boolean {
  const required = NAV_PERMISSIONS[view];
  return required.length === 0 || required.some((permission) => permissions.includes(permission));
}

function writeNavigationUrl(state: NavigationState, mode: "push" | "replace") {
  const url = new URL(window.location.href);
  url.searchParams.set("view", state.view);
  if (state.incidentId) url.searchParams.set("incident", state.incidentId);
  else url.searchParams.delete("incident");
  if (state.view === "incidents") url.searchParams.set("tab", state.tab);
  else url.searchParams.delete("tab");
  const next = `${url.pathname}${url.search}${url.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` === next) return;
  if (mode === "push") window.history.pushState(null, "", next);
  else window.history.replaceState(null, "", next);
}

export function OperationsApp({ initialIdentity }: { initialIdentity: InitialIdentity }) {
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [activeView, setActiveView] = useState<ViewId>("overview");
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("summary");
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [auditRecords, setAuditRecords] = useState<AuditRecord[] | null>(null);
  const [observabilityData, setObservabilityData] = useState<ObservabilitySnapshot | null>(null);
  const [observabilityRange, setObservabilityRange] = useState<ObservabilityWindow>("24h");
  const [accessData, setAccessData] = useState<AccessData | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<DisplayError | null>(null);
  const [detailError, setDetailError] = useState<DisplayError | null>(null);
  const [secondaryError, setSecondaryError] = useState<DisplayError | null>(null);
  const [overviewLastUpdatedAt, setOverviewLastUpdatedAt] = useState<Date | null>(null);
  const [detailLastUpdatedAt, setDetailLastUpdatedAt] = useState<Date | null>(null);
  const [globalQuery, setGlobalQuery] = useState("");
  const [incidentQuery, setIncidentQuery] = useState("");
  const [severityFilter, setSeverityFilter] = useState<Severity | "all">("all");
  const [statusFilter, setStatusFilter] = useState<IncidentStatus | "open" | "all">("open");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [compactNav, setCompactNav] = useState(false);
  const [declareOpen, setDeclareOpen] = useState(false);
  const [serviceOpen, setServiceOpen] = useState(false);
  const [serviceEditTarget, setServiceEditTarget] = useState<Service | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [taskEditTargetId, setTaskEditTargetId] = useState<string | null>(null);
  const [incidentEditOpen, setIncidentEditOpen] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [communicationEditor, setCommunicationEditor] = useState<string | "new" | null>(null);
  const [communicationAction, setCommunicationAction] = useState<{ communicationId: string; action: "review" | "publish" } | null>(null);
  const [memberCreateOpen, setMemberCreateOpen] = useState(false);
  const [memberEditTargetId, setMemberEditTargetId] = useState<string | null>(null);
  const [transitionTarget, setTransitionTarget] = useState<IncidentStatus | null>(null);
  const [mutationPending, setMutationPending] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<DisplayError | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const overviewAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const detailRequestIncidentRef = useRef<string | null>(null);
  const mutationKeysRef = useRef(new Map<string, string>());
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const mobileNavWasOpenRef = useRef(false);

  useEffect(() => {
    const restoreNavigation = window.setTimeout(() => {
      const navigation = initialNavigationState();
      setActiveView(navigation.view);
      setSelectedIncidentId(navigation.incidentId);
      setWorkspaceTab(navigation.tab);
    }, 0);
    return () => window.clearTimeout(restoreNavigation);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => {
      setCompactNav(media.matches);
      if (!media.matches) setMobileNavOpen(false);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!compactNav) {
      mobileNavWasOpenRef.current = false;
      return;
    }
    if (mobileNavOpen) document.querySelector<HTMLButtonElement>(".nav-close")?.focus();
    else if (mobileNavWasOpenRef.current) menuButtonRef.current?.focus();
    mobileNavWasOpenRef.current = mobileNavOpen;
  }, [compactNav, mobileNavOpen]);

  useEffect(() => {
    if (!compactNav || !mobileNavOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [compactNav, mobileNavOpen]);

  function idempotencyKeyFor(intent: string): string {
    const existing = mutationKeysRef.current.get(intent);
    if (existing) return existing;
    const created = mutationKey(intent);
    mutationKeysRef.current.set(intent, created);
    return created;
  }

  function resetMutationIntent(intent: string) {
    mutationKeysRef.current.delete(intent);
  }

  function resetMutationIntents(prefix: string) {
    for (const intent of mutationKeysRef.current.keys()) {
      if (intent === prefix || intent.startsWith(prefix)) mutationKeysRef.current.delete(intent);
    }
  }

  const loadOverview = useCallback(async (quiet = false) => {
    if (overviewAbortRef.current && !overviewAbortRef.current.signal.aborted) return false;
    const controller = new AbortController();
    overviewAbortRef.current = controller;
    if (!quiet) setLoading(true);
    try {
      const healthRequest = apiRequest<Record<string, unknown>>("/api/v1/health", undefined, controller.signal)
        .then((value) => ({ ok: true as const, value }))
        .catch(() => ({ ok: false as const }));
      const [overviewPayload, incidentPayload, servicePayload, accessPayload, healthResult] = await Promise.all([
        apiRequest<Record<string, unknown>>("/api/v1/overview", undefined, controller.signal),
        apiRequest<Record<string, unknown>>("/api/v1/incidents", undefined, controller.signal),
        apiRequest<Record<string, unknown>>("/api/v1/services", undefined, controller.signal),
        apiRequest<Record<string, unknown>>("/api/v1/access", undefined, controller.signal),
        healthRequest,
      ]);
      if (!Array.isArray(servicePayload.services)) throw new ApiError("服務目錄回應格式不完整。", 502);
      if (!Array.isArray(incidentPayload.incidents)) throw new ApiError("事件清單回應格式不完整。", 502);
      const rawServices = servicePayload.services;
      const initialServices = normalizeList(rawServices, (service) => normalizeService(service), "services");
      const serviceNames = new Map(initialServices.map((service) => [service.id, service.name]));
      const rawIncidents = incidentPayload.incidents;
      const incidents = normalizeList(rawIncidents, (incident) => normalizeIncident(incident, serviceNames), "incidents");
      if (!Array.isArray(overviewPayload.serviceHealth)) throw new ApiError("營運總覽回應格式不完整。", 502);
      const serviceHealth = overviewPayload.serviceHealth;
      const services = normalizeList(rawServices, (service) => normalizeService(service, incidents), "services").map((service) => {
        const healthRow = serviceHealth.find((item) => isRecord(item) && textValue(item, "serviceId") === service.id);
        if (!isRecord(healthRow)) return service;
        const rawStatus = parseEnumValue(healthRow.operationalStatus, ["operational", "degraded", "disrupted", "maintenance", "unknown"] as const, "overview.serviceHealth.operationalStatus");
        const rawTelemetryStatus = parseEnumValue(healthRow.telemetryStatus, ["available", "unavailable"] as const, "overview.serviceHealth.telemetryStatus");
        const telemetryStatus = rawTelemetryStatus === "unavailable" || rawStatus === "unknown"
          ? "unavailable" as const
          : "available" as const;
        return {
          ...service,
          status: rawStatus,
          telemetryStatus,
          activeIncidentCount: numberValue(healthRow, "activeIncidentCount", service.activeIncidentCount),
          sloTarget: healthRow.sloTarget == null ? service.sloTarget : numberValue(healthRow, "sloTarget"),
          sloAttainment: healthRow.sloAttainment == null ? null : numberValue(healthRow, "sloAttainment"),
        };
      });
      const permissions = Array.isArray(accessPayload.permissions) ? accessPayload.permissions.filter((item): item is string => typeof item === "string") : [];
      const actor = normalizeActor(accessPayload.actor, permissions);
      if (!actor) throw new ApiError("存取服務未傳回有效的操作者身分。", 502);
      const organizationRecord = isRecord(accessPayload.organization) ? accessPayload.organization : {};
      const canReadMembers = permissions.includes("access:manage") || permissions.includes("incident:assign");
      const membersPayload = canReadMembers
        ? await apiRequest<Record<string, unknown>>("/api/v1/access/members", undefined, controller.signal)
        : {};
      if (canReadMembers && !Array.isArray(membersPayload.members)) throw new ApiError("組織成員回應格式不完整。", 502);
      const rawMembers = Array.isArray(membersPayload.members) ? membersPayload.members : [];
      const operators = normalizeList(rawMembers, normalizeOperator, "members");
      const recentAuditPayload = overviewPayload.recentAuditEvents ?? overviewPayload.recentAudit;
      const rawRecentAudit = Array.isArray(recentAuditPayload)
        ? recentAuditPayload
        : isRecord(recentAuditPayload) && Array.isArray(recentAuditPayload.events)
          ? recentAuditPayload.events
          : Array.isArray(overviewPayload.events) ? overviewPayload.events : [];
      const recentAudit = normalizeList(rawRecentAudit, normalizeAuditRecord, "recentAuditEvents");
      const counts = isRecord(overviewPayload.counts) ? overviewPayload.counts : {};
      const reliabilityMetrics = isRecord(overviewPayload.reliabilityMetrics) ? overviewPayload.reliabilityMetrics : {};
      const activeIncidents = numberValue(counts, "openIncidents", incidents.filter((incident) => !["closed", "cancelled"].includes(incident.status)).length);
      const monitoredServices = services.filter((service) => service.telemetryStatus === "available" && service.sloAttainment != null);
      const incidentAffectedServices = services.filter((service) => service.activeIncidentCount > 0).length;
      const servicesAtRisk = services.filter((service) => service.telemetryStatus === "available" && ["degraded", "disrupted"].includes(service.status)).length;
      const next: OperationsSnapshot = {
        actor,
        organization: {
          id: textValue(organizationRecord, "id", "organization"),
          name: textValue(organizationRecord, "name", "Continuity Ops"),
          timezone: textValue(organizationRecord, "timezone") || undefined,
        },
        metrics: {
          activeIncidents,
          sev1Incidents: numberValue(counts, "criticalIncidents", incidents.filter((incident) => incident.severity === "SEV1" && !["closed", "cancelled"].includes(incident.status)).length),
          unassignedIncidents: counts.unassignedIncidents == null ? null : numberValue(counts, "unassignedIncidents"),
          overdueTasks: numberValue(counts, "overdueTasks"),
          servicesAtRisk,
          incidentAffectedServices,
          monitoredServices: monitoredServices.length,
          sloBreaches: monitoredServices.length === 0
            ? null
            : monitoredServices.filter((service) => service.sloTarget != null && service.sloAttainment! < service.sloTarget).length,
          meanTimeToAcknowledgeMinutes: reliabilityMetrics.meanTimeToAcknowledgeMinutes == null ? null : numberValue(reliabilityMetrics, "meanTimeToAcknowledgeMinutes"),
          meanTimeToRestoreMinutes: reliabilityMetrics.meanTimeToRestoreMinutes == null ? null : numberValue(reliabilityMetrics, "meanTimeToRestoreMinutes"),
          acknowledgeSampleSize: numberValue(reliabilityMetrics, "acknowledgeSampleSize"),
          restoreSampleSize: numberValue(reliabilityMetrics, "restoreSampleSize"),
        },
        incidents,
        services,
        operators,
        recentAudit,
      };
      setSnapshot(next);
      setServiceEditTarget((current) => current ? next.services.find((service) => service.id === current.id) ?? current : null);
      const rawPolicies = Array.isArray(accessPayload.policies) ? accessPayload.policies : [];
      const policies = rawPolicies.filter(isRecord).map((policy) => {
        const rawStatus = textValue(policy, "status");
        if (!(["enforced", "disabled"] as string[]).includes(rawStatus)) return null;
        return {
          id: textValue(policy, "id"),
          name: textValue(policy, "name"),
          description: textValue(policy, "description"),
          status: rawStatus as "enforced" | "disabled",
        };
      }).filter((policy): policy is NonNullable<typeof policy> => Boolean(policy?.id && policy.name));
      setAccessData({ actor, organization: next.organization, operators, permissions, policies: policies.length > 0 ? policies : undefined });
      setOverviewError(null);
      setOverviewLastUpdatedAt(new Date());
      setSelectedIncidentId((current) => {
        const fromUrl = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("incident");
        const stored = typeof window === "undefined" ? null : window.localStorage.getItem("continuity-ops:selected-incident");
        const candidate = current ?? fromUrl ?? stored;
        if (candidate && next.incidents.some((incident) => incident.id === candidate)) return candidate;
        return next.incidents.find((incident) => !["closed", "cancelled"].includes(incident.status))?.id ?? next.incidents[0]?.id ?? null;
      });
      if (healthResult.ok) {
        const rawHealth = healthResult.value;
        const rawStatus = textValue(rawHealth, "status");
        setHealth({
          status: rawStatus === "ok" || rawStatus === "operational" ? "operational" : rawStatus === "degraded" ? "degraded" : "unavailable",
          database: textValue(rawHealth, "database") === "ok" ? "operational" : "unavailable",
          version: textValue(rawHealth, "version") || undefined,
          checkedAt: new Date().toISOString(),
        });
      } else {
        setHealth({ status: "unavailable", database: "unavailable", checkedAt: new Date().toISOString() });
      }
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      setOverviewError(getErrorMessage(error));
      return false;
    } finally {
      if (overviewAbortRef.current === controller) overviewAbortRef.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  const loadIncident = useCallback(async (incidentId: string, quiet = false) => {
    if (detailAbortRef.current && !detailAbortRef.current.signal.aborted) {
      if (detailRequestIncidentRef.current === incidentId) return false;
      detailAbortRef.current.abort();
    }
    const controller = new AbortController();
    detailAbortRef.current = controller;
    detailRequestIncidentRef.current = incidentId;
    if (!quiet) {
      setDetailLoading(true);
      setDetailError(null);
    }
    try {
      const [payload, timelinePayload, communicationsPayload] = await Promise.all([
        apiRequest<Record<string, unknown>>(`/api/v1/incidents/${encodeURIComponent(incidentId)}`, undefined, controller.signal),
        apiRequest<Record<string, unknown>>(`/api/v1/incidents/${encodeURIComponent(incidentId)}/timeline`, undefined, controller.signal),
        apiRequest<Record<string, unknown>>(`/api/v1/incidents/${encodeURIComponent(incidentId)}/communications`, undefined, controller.signal),
      ]);
      const rawIncident = payload.incident;
      const rawService = normalizeService(payload.service);
      const summary = normalizeIncident(rawIncident, new Map([[rawService.id, rawService.name]]));
      if (!isRecord(rawIncident)) throw new ApiError("事件資料格式不完整。", 502);
      if (!Array.isArray(payload.assignments)) throw new ApiError("事件指派回應格式不完整。", 502);
      if (!Array.isArray(timelinePayload.events)) throw new ApiError("事件時間軸回應格式不完整。", 502);
      if (!Array.isArray(communicationsPayload.communications)) throw new ApiError("事件通訊回應格式不完整。", 502);
      const assignments = payload.assignments;
      const responders = assignments.map((assignment, index) => {
        if (!isRecord(assignment)) invalidResponse(`assignments[${index}]`);
        const status = parseEnumValue(assignment.status, ["active", "revoked"] as const, `assignments[${index}].status`);
        if (status !== "active") return null;
        const incidentRole = parseEnumValue(assignment.incidentRole, Object.keys(INCIDENT_ROLE_LABEL) as IncidentRole[], `assignments[${index}].incidentRole`);
        return {
          assignmentId: requiredTextValue(assignment, "id", `assignments[${index}].id`),
          id: requiredTextValue(assignment, "userId", `assignments[${index}].userId`),
          displayName: requiredTextValue(assignment, "displayName", `assignments[${index}].displayName`),
          role: incidentRoleLabel(incidentRole),
          incidentRole,
          team: textValue(assignment, "teamName") || undefined,
        };
      }).filter((assignment): assignment is NonNullable<typeof assignment> => assignment !== null);
      const commanderAssignment = responders.find((assignment) => assignment.incidentRole === "incident_commander");
      if (commanderAssignment) summary.commander = { id: commanderAssignment.id, displayName: commanderAssignment.displayName };
      const rawTimeline = timelinePayload.events;
      if (!Array.isArray(payload.tasks)) throw new ApiError("事件工作項目回應格式不完整。", 502);
      const rawTasks = payload.tasks;
      const next: IncidentDetail = {
        ...summary,
        impact: textValue(rawIncident, "impactSummary", textValue(rawIncident, "summary")),
        currentHypothesis: textValue(rawIncident, "currentHypothesis"),
        currentMitigation: textValue(rawIncident, "currentMitigation"),
        verificationCriteria: textValue(rawIncident, "verificationCriteria"),
        responders,
        service: rawService,
        timeline: normalizeList(rawTimeline, normalizeTimelineEntry, "timeline"),
        tasks: normalizeList(rawTasks, normalizeTask, "tasks"),
        communications: normalizeList(communicationsPayload.communications, normalizeCommunication, "communications"),
        review: normalizeReview(payload.review),
      };
      setDetail(next);
      setDetailError(null);
      setDetailLastUpdatedAt(new Date());
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      setDetailError(getErrorMessage(error));
      return false;
    } finally {
      if (detailAbortRef.current === controller) {
        detailAbortRef.current = null;
        detailRequestIncidentRef.current = null;
      }
      if (!controller.signal.aborted) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadOverview(), 0);
    return () => {
      window.clearTimeout(initialLoad);
      overviewAbortRef.current?.abort();
      detailAbortRef.current?.abort();
    };
  }, [loadOverview]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible" && !mutationPending) void loadOverview(true);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [loadOverview, mutationPending]);

  useEffect(() => {
    if (!selectedIncidentId || !snapshot) return;
    window.localStorage.setItem("continuity-ops:selected-incident", selectedIncidentId);
    const detailLoad = window.setTimeout(() => {
      setDetailLastUpdatedAt(null);
      void loadIncident(selectedIncidentId);
    }, 0);
    return () => window.clearTimeout(detailLoad);
  }, [selectedIncidentId, loadIncident, snapshot]);

  useEffect(() => {
    if (!selectedIncidentId || !snapshot) return;
    const refreshVisibleDetail = () => {
      if (document.visibilityState === "visible" && !mutationPending) void loadIncident(selectedIncidentId, true);
    };
    const interval = window.setInterval(refreshVisibleDetail, 8_000);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshVisibleDetail();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadIncident, mutationPending, selectedIncidentId, snapshot]);

  const actor: Actor = snapshot?.actor ?? {
    id: initialIdentity.email,
    displayName: initialIdentity.displayName,
    email: initialIdentity.email,
    roles: [],
  };

  const overviewIncident = snapshot?.incidents.find((incident) => incident.id === selectedIncidentId) ?? null;
  const selectedDetail = detail?.id === selectedIncidentId ? detail : null;
  const communicationEditorRecord = communicationEditor && communicationEditor !== "new"
    ? selectedDetail?.communications.find((communication) => communication.id === communicationEditor) ?? null
    : null;
  const communicationActionRecord = communicationAction
    ? selectedDetail?.communications.find((communication) => communication.id === communicationAction.communicationId) ?? null
    : null;
  const taskEditTarget = taskEditTargetId
    ? selectedDetail?.tasks.find((task) => task.id === taskEditTargetId) ?? null
    : null;
  const memberEditTarget = memberEditTargetId
    ? (accessData?.operators ?? snapshot?.operators ?? []).find((operator) => operator.id === memberEditTargetId) ?? null
    : null;
  const detailIsCurrent = Boolean(selectedDetail && (!overviewIncident || (
    selectedDetail.version >= overviewIncident.version &&
    (safeDate(selectedDetail.updatedAt)?.getTime() ?? 0) >= (safeDate(overviewIncident.updatedAt)?.getTime() ?? 0)
  )));
  const currentIncident = detailIsCurrent ? selectedDetail : overviewIncident ?? selectedDetail;
  const detailStale = Boolean(detailError || (selectedDetail && overviewIncident && !detailIsCurrent));
  const organizationRole = actor.roles[0] as OrganizationRole | undefined;
  const actorIncidentRoles = selectedDetail?.responders
    .filter((responder) => responder.id === actor.id)
    .map((responder) => responder.incidentRole) ?? [];
  const isIncidentCommander = organizationRole === "admin" ||
    (organizationRole === "commander" && actorIncidentRoles.includes("incident_commander"));
  const canRespondToIncident = Boolean(selectedDetail && actor.permissions?.includes("incident:respond") && (
    organizationRole === "admin" ||
    (organizationRole === "commander" && actorIncidentRoles.includes("incident_commander")) ||
    (organizationRole === "responder" && actorIncidentRoles.some((role) => role === "responder" || role === "service_owner"))
  ));
  const canDraftCommunication = Boolean(
    selectedDetail && organizationRole && canDraftIncidentCommunication(organizationRole, actorIncidentRoles),
  );
  const canApproveCommunication = Boolean(
    selectedDetail && organizationRole && canApproveIncidentCommunication(organizationRole, actorIncidentRoles),
  );
  const canAddTimeline = canRespondToIncident;
  const allowedTimelineKinds: TimelineEntry["kind"][] = canRespondToIncident
    ? ["investigation", "mitigation", "evidence"]
    : [];
  const canCreateIncident = Boolean(actor.permissions?.includes("incident:create"));
  const canCreateService = Boolean(actor.permissions?.includes("service:write"));
  const canAssignIncident = Boolean(selectedDetail && actor.permissions?.includes("incident:assign") && isIncidentCommander);
  const canReviewIncident = Boolean(selectedDetail && actor.permissions?.includes("review:write") && isIncidentCommander);
  const canManageAccess = Boolean(actor.permissions?.includes("access:manage"));
  const actorPermissions = actor.permissions ?? NO_PERMISSIONS;
  const readOnlyAccess = organizationRole === "observer" || organizationRole === "auditor";
  const visibleNavItems = useMemo(() => NAV_ITEMS.filter((item) => viewAllowed(item.id, actorPermissions)), [actorPermissions]);
  const renderedView = viewAllowed(activeView, actorPermissions) ? activeView : "overview";
  const organizationTimeZone = resolveOrganizationTimeZone(snapshot?.organization.timezone);

  const filteredIncidents = useMemo(() => {
    const query = incidentQuery.trim().toLocaleLowerCase("zh-Hant");
    return [...(snapshot?.incidents ?? [])]
      .filter((incident) => {
        if (severityFilter !== "all" && incident.severity !== severityFilter) return false;
        if (!incidentStatusMatchesFilter(incident.status, statusFilter)) return false;
        if (!query) return true;
        return [incident.key, incident.title, incident.serviceName, incident.commander?.displayName ?? ""]
          .some((value) => value.toLocaleLowerCase("zh-Hant").includes(query));
      })
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [snapshot?.incidents, incidentQuery, severityFilter, statusFilter]);

  function changeStatusFilter(nextFilter: IncidentStatus | "open" | "all") {
    setStatusFilter(nextFilter);
    const selectedIncident = snapshot?.incidents.find((incident) => incident.id === selectedIncidentId);
    if (!selectedIncident || incidentStatusMatchesFilter(selectedIncident.status, nextFilter)) return;

    if (workspaceTab === "review" && selectedIncidentId) resetMutationIntent(`review-${selectedIncidentId}`);
    const query = incidentQuery.trim().toLocaleLowerCase("zh-Hant");
    const replacement = [...(snapshot?.incidents ?? [])]
      .filter((incident) => {
        if (severityFilter !== "all" && incident.severity !== severityFilter) return false;
        if (!incidentStatusMatchesFilter(incident.status, nextFilter)) return false;
        if (!query) return true;
        return [incident.key, incident.title, incident.serviceName, incident.commander?.displayName ?? ""]
          .some((value) => value.toLocaleLowerCase("zh-Hant").includes(query));
      })
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null;
    setSelectedIncidentId(replacement?.id ?? null);
    setWorkspaceTab("summary");
  }

  function changeView(view: ViewId) {
    if (!viewAllowed(view, actorPermissions)) return;
    if (activeView === "incidents" && view !== "incidents" && workspaceTab === "review" && selectedIncidentId) resetMutationIntent(`review-${selectedIncidentId}`);
    setActiveView(view);
    setMobileNavOpen(false);
    setSecondaryError(null);
    writeNavigationUrl({ view, incidentId: selectedIncidentId, tab: workspaceTab }, "push");
  }

  const loadAuditView = useCallback(async () => {
    setSecondaryLoading(true);
    setSecondaryError(null);
    try {
      const payload = await apiRequest<Record<string, unknown>>("/api/v1/audit?limit=100");
      if (!Array.isArray(payload.events)) throw new ApiError("稽核紀錄回應格式不完整。", 502);
      const events = payload.events;
      setAuditRecords(normalizeList(events, normalizeAuditRecord, "audit.events"));
    } catch (error) {
      setSecondaryError(getErrorMessage(error));
    } finally {
      setSecondaryLoading(false);
    }
  }, []);

  const loadObservabilityView = useCallback(async () => {
    setSecondaryLoading(true);
    setSecondaryError(null);
    try {
      const payload = await apiRequest<unknown>(`/api/v1/observability?range=${observabilityRange}`);
      setObservabilityData(normalizeObservabilitySnapshot(payload));
      return true;
    } catch (error) {
      setSecondaryError(getErrorMessage(error));
      return false;
    } finally {
      setSecondaryLoading(false);
    }
  }, [observabilityRange]);

  const loadAccessView = useCallback(async () => {
    setSecondaryLoading(true);
    setSecondaryError(null);
    try {
      const accessPayload = await apiRequest<Record<string, unknown>>("/api/v1/access");
      const permissions = Array.isArray(accessPayload.permissions) ? accessPayload.permissions.filter((item): item is string => typeof item === "string") : [];
      const actor = normalizeActor(accessPayload.actor, permissions);
      if (!actor) throw new ApiError("伺服器未傳回有效的操作者身分。", 502);
      const organizationRecord = isRecord(accessPayload.organization) ? accessPayload.organization : {};
      const canReadMembers = permissions.includes("access:manage") || permissions.includes("incident:assign");
      const membersPayload = canReadMembers ? await apiRequest<Record<string, unknown>>("/api/v1/access/members") : {};
      if (canReadMembers && !Array.isArray(membersPayload.members)) throw new ApiError("組織成員回應格式不完整。", 502);
      const members = Array.isArray(membersPayload.members) ? membersPayload.members : [];
      const rawPolicies = Array.isArray(accessPayload.policies) ? accessPayload.policies : [];
      const policies = rawPolicies.filter(isRecord).map((policy) => {
        const status = textValue(policy, "status");
        if (!(["enforced", "disabled"] as string[]).includes(status)) return null;
        return { id: textValue(policy, "id"), name: textValue(policy, "name"), description: textValue(policy, "description"), status: status as "enforced" | "disabled" };
      }).filter((policy): policy is NonNullable<typeof policy> => Boolean(policy?.id && policy.name));
      setAccessData({
        actor,
        organization: { id: textValue(organizationRecord, "id", "organization"), name: textValue(organizationRecord, "name", "Continuity Ops") },
        permissions,
        operators: normalizeList(members, normalizeOperator, "members"),
        policies: policies.length > 0 ? policies : undefined,
      });
      return true;
    } catch (error) {
      setSecondaryError(getErrorMessage(error));
      return false;
    } finally {
      setSecondaryLoading(false);
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const navigation = navigationFromUrl(new URL(window.location.href));
      const nextView = viewAllowed(navigation.view, actorPermissions) ? navigation.view : "overview";
      const nextIncidentId = navigation.incidentId && snapshot?.incidents.some((incident) => incident.id === navigation.incidentId)
        ? navigation.incidentId
        : navigation.incidentId && !snapshot ? navigation.incidentId : null;
      if (selectedIncidentId && workspaceTab === "review" && (nextView !== "incidents" || navigation.tab !== "review" || nextIncidentId !== selectedIncidentId)) {
        mutationKeysRef.current.delete(`review-${selectedIncidentId}`);
      }
      setActiveView(nextView);
      setSelectedIncidentId(nextIncidentId);
      setWorkspaceTab(navigation.tab);
      setMobileNavOpen(false);
      setSecondaryError(null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [actorPermissions, selectedIncidentId, snapshot, workspaceTab]);

  useEffect(() => {
    if (!snapshot) return;
    const shouldLoadAudit = activeView === "audit" && actorPermissions.includes("audit:read") && !auditRecords && !secondaryLoading && !secondaryError;
    const shouldLoadObservability = activeView === "observability" && actorPermissions.includes("observability:read") && !observabilityData && !secondaryLoading && !secondaryError;
    const shouldLoadAccess = activeView === "access" && viewAllowed("access", actorPermissions) && !accessData && !secondaryLoading && !secondaryError;
    if (!shouldLoadAudit && !shouldLoadObservability && !shouldLoadAccess) return;
    const loadSecondaryView = window.setTimeout(() => {
      if (shouldLoadAudit) void loadAuditView();
      if (shouldLoadObservability) void loadObservabilityView();
      if (shouldLoadAccess) void loadAccessView();
    }, 0);
    return () => window.clearTimeout(loadSecondaryView);
  }, [accessData, activeView, actorPermissions, auditRecords, loadAccessView, loadAuditView, loadObservabilityView, observabilityData, secondaryError, secondaryLoading, snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const allowedView = viewAllowed(activeView, actorPermissions) ? activeView : "overview";
    const selectedExists = selectedIncidentId && snapshot.incidents.some((incident) => incident.id === selectedIncidentId);
    const fallbackIncidentId = filteredIncidents[0]?.id ?? null;
    const incidentId = selectedExists ? selectedIncidentId : fallbackIncidentId;
    const selectedIncident = incidentId ? snapshot.incidents.find((incident) => incident.id === incidentId) : null;
    const revealTerminalIncident = statusFilter === "open" && Boolean(selectedIncident && ["closed", "cancelled"].includes(selectedIncident.status));
    writeNavigationUrl({ view: allowedView, incidentId, tab: workspaceTab }, "replace");
    if (allowedView === activeView && incidentId === selectedIncidentId && !revealTerminalIncident) return;
    const reconcileNavigation = window.setTimeout(() => {
      if (allowedView !== activeView) setActiveView(allowedView);
      if (incidentId !== selectedIncidentId) setSelectedIncidentId(incidentId);
      if (revealTerminalIncident) setStatusFilter("all");
    }, 0);
    return () => window.clearTimeout(reconcileNavigation);
  }, [activeView, actorPermissions, filteredIncidents, selectedIncidentId, snapshot, statusFilter, workspaceTab]);

  function selectIncident(incidentId: string) {
    if (selectedIncidentId && selectedIncidentId !== incidentId && workspaceTab === "review") resetMutationIntent(`review-${selectedIncidentId}`);
    const nextTab = selectedIncidentId === incidentId ? workspaceTab : "summary";
    const selectedIncident = snapshot?.incidents.find((incident) => incident.id === incidentId);
    if (statusFilter === "open" && selectedIncident && ["closed", "cancelled"].includes(selectedIncident.status)) {
      setStatusFilter("all");
    }
    setSelectedIncidentId(incidentId);
    setActiveView("incidents");
    setWorkspaceTab(nextTab);
    writeNavigationUrl({ view: "incidents", incidentId, tab: nextTab }, "push");
  }

  function changeWorkspaceTab(tab: WorkspaceTab) {
    if (workspaceTab === "review" && tab !== "review" && selectedIncidentId) resetMutationIntent(`review-${selectedIncidentId}`);
    setWorkspaceTab(tab);
    writeNavigationUrl({ view: "incidents", incidentId: selectedIncidentId, tab }, "push");
  }

  function submitGlobalSearch(event: FormEvent) {
    event.preventDefault();
    setIncidentQuery(globalQuery);
    setSeverityFilter("all");
    setStatusFilter("all");
    changeView("incidents");
  }

  async function refreshOperations(quiet = false) {
    const requests: Promise<boolean>[] = [loadOverview(quiet)];
    if (selectedIncidentId) requests.push(loadIncident(selectedIncidentId, quiet));
    if (activeView === "observability" && actorPermissions.includes("observability:read")) requests.push(loadObservabilityView());
    const results = await Promise.all(requests);
    return results.every(Boolean);
  }

  async function reloadLatestAfterConflict() {
    const refreshed = await refreshOperations(true);
    if (refreshed) {
      setMutationError(null);
      setToast("已載入最新版；尚未提交的內容仍保留。請確認後重新提交。");
    }
  }

  function clearStaleMutationIntent(prefix: string) {
    resetMutationIntents(prefix);
    setMutationError(null);
  }

  async function reloadMemberAfterConflict(membershipId: string) {
    resetMutationIntents(`member-${membershipId}`);
    const refreshed = await loadAccessView();
    if (refreshed) {
      setMutationError(null);
      setToast("已載入最新存取設定；請合併後重新確認變更。");
    }
  }

  async function reloadTaskAfterConflict(taskId: string) {
    resetMutationIntents(`task-${taskId}`);
    await reloadLatestAfterConflict();
  }

  async function recoverVisibleConflict() {
    if (memberEditTarget?.membershipId) {
      await reloadMemberAfterConflict(memberEditTarget.membershipId);
      return;
    }
    if (taskEditTarget) {
      await reloadTaskAfterConflict(taskEditTarget.id);
      return;
    }
    await reloadLatestAfterConflict();
  }

  async function runMutation<T>(
    key: string,
    request: (idempotencyKey: string) => Promise<T>,
    successMessage: string,
    after?: (value: T) => void,
    intent = key,
  ) {
    setMutationPending(key);
    setMutationError(null);
    const idempotencyKey = idempotencyKeyFor(intent);
    try {
      const value = await request(idempotencyKey);
      after?.(value);
      resetMutationIntent(intent);
      setToast(successMessage);
      await loadOverview(true);
      if (selectedIncidentId) await loadIncident(selectedIncidentId, true);
      return true;
    } catch (error) {
      setMutationError(getErrorMessage(error));
      return false;
    } finally {
      setMutationPending(null);
    }
  }

  async function declareIncident(values: { title: string; serviceId: string; severity: Severity; environment: IncidentEnvironment; impact: string }) {
    let createdId: string | null = null;
    const ok = await runMutation(
      "declare",
      (idempotencyKey) => apiRequest<Record<string, unknown>>("/api/v1/incidents", mutationRequest("POST", idempotencyKey, {
        title: values.title,
        summary: values.impact,
        severity: values.severity.toLowerCase(),
        serviceId: values.serviceId,
        environment: values.environment,
        impactSummary: values.impact,
      })),
      "事件已宣告，相關人員現在可進入同一工作區。",
      (payload) => {
        const incident = normalizeIncident(payload.incident);
        createdId = incident.id;
        setSelectedIncidentId(incident.id);
        setActiveView("incidents");
        setWorkspaceTab("summary");
        writeNavigationUrl({ view: "incidents", incidentId: incident.id, tab: "summary" }, "push");
      },
    );
    if (ok) {
      setDeclareOpen(false);
      if (createdId) window.localStorage.setItem("continuity-ops:selected-incident", createdId);
    }
    return ok;
  }

  async function createService(values: ServiceCreateInput) {
    const ok = await runMutation(
      "service-create",
      (idempotencyKey) => apiRequest<Record<string, unknown>>("/api/v1/services", mutationRequest("POST", idempotencyKey, {
        name: values.name,
        slug: values.key.toLowerCase(),
        description: values.description,
        tier: values.tier,
        ownerTeam: values.ownerTeam,
        ownerEmail: values.ownerEmail,
        sloTarget: values.sloTarget,
        runbookUrl: values.runbookUrl,
      })),
      "服務已加入目錄。",
    );
    if (ok) setServiceOpen(false);
    return ok;
  }

  async function updateService(service: Service, values: ServiceUpdateInput) {
    const ok = await runMutation(
      `service-update-${service.id}`,
      (idempotencyKey) => apiRequest<Record<string, unknown>>(`/api/v1/services/${encodeURIComponent(service.id)}`, mutationRequest("PATCH", idempotencyKey, {
        ...values,
        expectedVersion: service.version,
      })),
      "服務目錄已更新。",
    );
    if (ok) setServiceEditTarget(null);
    return ok;
  }

  async function updateIncidentOverview(values: Partial<IncidentOverviewInput>, expectedVersion: number) {
    if (!selectedDetail || !currentIncident) return false;
    const ok = await runMutation(
      "incident-overview",
      (idempotencyKey) => apiRequest<Record<string, unknown>>(`/api/v1/incidents/${encodeURIComponent(selectedDetail.id)}`, mutationRequest("PATCH", idempotencyKey, {
        ...values,
        expectedVersion,
      })),
      "事件總覽已更新。",
    );
    if (ok) setIncidentEditOpen(false);
    return ok;
  }

  async function assignIncident(values: { userId: string; incidentRole: IncidentRole }) {
    if (!selectedDetail) return false;
    const ok = await runMutation(
      "incident-assignment",
      (idempotencyKey) => apiRequest<Record<string, unknown>>(`/api/v1/incidents/${encodeURIComponent(selectedDetail.id)}/assignments`, mutationRequest("POST", idempotencyKey, values)),
      "事件角色已指派。",
    );
    if (ok) setAssignmentOpen(false);
    return ok;
  }

  async function revokeAssignment(assignmentId: string, replacementUserId?: string) {
    if (!selectedDetail) return false;
    const ok = await runMutation(
      `assignment-revoke-${assignmentId}`,
      (idempotencyKey) => apiRequest<Record<string, unknown>>(
        `/api/v1/incidents/${encodeURIComponent(selectedDetail.id)}/assignments/${encodeURIComponent(assignmentId)}`,
        mutationRequest("DELETE", idempotencyKey, replacementUserId ? { replacementUserId } : {}),
      ),
      replacementUserId ? "事件角色已撤銷，指揮權已完成交接。" : "事件角色已撤銷。",
    );
    if (ok) setAssignmentOpen(false);
    return ok;
  }

  async function createMember(values: MemberCreateInput) {
    const ok = await runMutation(
      "member-create",
      (idempotencyKey) => apiRequest<Record<string, unknown>>("/api/v1/access/members", mutationRequest("POST", idempotencyKey, values)),
      "組織成員已新增。",
    );
    if (ok) {
      setMemberCreateOpen(false);
      await loadAccessView();
    }
    return ok;
  }

  async function updateMember(operator: Operator, values: { role: OrganizationRole; status: "active" | "suspended" }) {
    if (!operator.membershipId) return false;
    const ok = await runMutation(
      `member-${operator.membershipId}`,
      (idempotencyKey) => apiRequest<Record<string, unknown>>(`/api/v1/access/members/${encodeURIComponent(operator.membershipId!)}`, mutationRequest("PATCH", idempotencyKey, {
        ...values,
        expectedVersion: operator.membershipVersion,
      })),
      "成員存取設定已更新。",
      undefined,
      `member-${operator.membershipId}-v${operator.membershipVersion}-${values.role}-${values.status}`,
    );
    if (ok) {
      setMemberEditTargetId(null);
      await loadAccessView();
    }
    return ok;
  }

  async function addTimelineEntry(values: {
    kind: TimelineEntry["kind"];
    message: string;
    referenceUrl?: string;
    sourceLabel?: string;
    observedFrom?: string;
    observedTo?: string;
    sha256Digest?: string;
  }) {
    if (!currentIncident) return false;
    const ok = await runMutation(
      "timeline-add",
      (idempotencyKey) => apiRequest<Record<string, unknown>>(`/api/v1/incidents/${encodeURIComponent(currentIncident.id)}/timeline`, mutationRequest("POST", idempotencyKey, {
        eventType: values.kind === "evidence" ? "verification" : values.kind === "status" ? "note" : values.kind,
        message: values.message,
        referenceUrl: values.referenceUrl,
        sourceLabel: values.sourceLabel,
        observedFrom: values.observedFrom,
        observedTo: values.observedTo,
        sha256Digest: values.sha256Digest,
      })),
      "時間軸已更新。",
    );
    if (ok) setUpdateOpen(false);
    return ok;
  }

  async function saveCommunication(values: CommunicationDraftInput, existing: IncidentCommunication | null, expectedVersion: number | null) {
    if (!currentIncident) return false;
    const intent = existing ? `communication-update-${existing.id}` : `communication-create-${currentIncident.id}`;
    const endpoint = existing
      ? `/api/v1/incidents/${encodeURIComponent(currentIncident.id)}/communications/${encodeURIComponent(existing.id)}`
      : `/api/v1/incidents/${encodeURIComponent(currentIncident.id)}/communications`;
    const payload: Record<string, unknown> = {
      audience: values.audience,
      message: values.message,
      affectedComponents: values.affectedComponents,
      nextUpdateAt: values.nextUpdateAt ?? null,
      ...(existing ? { expectedVersion } : {}),
    };
    const ok = await runMutation(
      intent,
      (idempotencyKey) => apiRequest<Record<string, unknown>>(endpoint, mutationRequest(existing ? "PATCH" : "POST", idempotencyKey, payload)),
      existing ? "通訊草稿已更新。" : "通訊草稿已建立。",
      undefined,
      intent,
    );
    if (ok) setCommunicationEditor(null);
    return ok;
  }

  async function actOnCommunication(communication: IncidentCommunication, action: "review" | "publish") {
    if (!currentIncident) return false;
    const key = `communication-${action}-${communication.id}`;
    const ok = await runMutation(
      key,
      (idempotencyKey) => apiRequest<Record<string, unknown>>(
        `/api/v1/incidents/${encodeURIComponent(currentIncident.id)}/communications/${encodeURIComponent(communication.id)}`,
        mutationRequest("PATCH", idempotencyKey, { action, expectedVersion: communication.version }),
      ),
      action === "review" ? "通訊草稿已核准。" : "通訊紀錄已標記為發布。",
      undefined,
      key,
    );
    if (ok) setCommunicationAction(null);
    return ok;
  }

  async function addTask(values: { title: string; priority: TaskPriority; ownerId?: string; dueAt?: string; evidenceRef?: string }) {
    if (!currentIncident) return false;
    const ok = await runMutation(
      "task-add",
      (idempotencyKey) => apiRequest<Record<string, unknown>>(`/api/v1/incidents/${encodeURIComponent(currentIncident.id)}/tasks`, mutationRequest("POST", idempotencyKey, {
        title: values.title,
        assigneeUserId: values.ownerId,
        dueAt: values.dueAt,
        priority: values.priority,
        evidenceRef: values.evidenceRef,
      })),
      "工作項目已建立。",
    );
    if (ok) setTaskOpen(false);
    return ok;
  }

  async function updateTask(task: IncidentTask, changes: TaskUpdateInput) {
    if (!currentIncident) return false;
    const ok = await runMutation(
      `task-${task.id}`,
      (idempotencyKey) => apiRequest<Record<string, unknown>>(`/api/v1/incidents/${encodeURIComponent(currentIncident.id)}/tasks/${encodeURIComponent(task.id)}`, mutationRequest("PATCH", idempotencyKey, {
        ...changes,
        expectedVersion: task.version,
      })),
      changes.status ? `工作項目已更新為「${TASK_STATUS_LABEL[changes.status]}」。` : "工作項目已更新。",
      undefined,
      `task-${task.id}-${changes.status ? `status-${changes.status}` : "details"}`,
    );
    if (ok) setTaskEditTargetId(null);
    return ok;
  }

  async function transitionIncident(target: IncidentStatus, note: string) {
    if (!currentIncident) return false;
    const ok = await runMutation(
      "transition",
      (idempotencyKey) => apiRequest<Record<string, unknown>>(`/api/v1/incidents/${encodeURIComponent(currentIncident.id)}/transitions`, mutationRequest("POST", idempotencyKey, {
        toStatus: target,
        note,
        expectedVersion: currentIncident.version,
      })),
      `事件已更新為「${INCIDENT_STATUS_LABEL[target]}」。`,
      undefined,
      "transition",
    );
    if (ok) setTransitionTarget(null);
    return ok;
  }

  async function saveReview(review: IncidentReview) {
    if (!currentIncident) return false;
    return runMutation(
      "review-save",
      (idempotencyKey) => apiRequest<Record<string, unknown>>(`/api/v1/incidents/${encodeURIComponent(currentIncident.id)}/review`, mutationRequest("PUT", idempotencyKey, {
        summary: review.summary,
        customerImpact: review.customerImpact,
        rootCause: review.rootCause,
        detectionGap: review.detectionGap,
        lessonsLearned: review.lessonsLearned,
        followUpActions: review.followUpActions,
        status: review.status === "final" ? "completed" : "draft",
        expectedVersion: review.version ?? 0,
      })),
      "事後檢討已儲存。",
      undefined,
      `review-${currentIncident.id}`,
    );
  }

  return (
    <div className="ops-shell">
      <a
        className="skip-link"
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById("main-content");
          main?.focus({ preventScroll: true });
          main?.scrollIntoView({ block: "start" });
          window.history.replaceState(null, "", "#main-content");
        }}
      >跳到主要內容</a>
      <button
        className={`nav-scrim ${mobileNavOpen ? "visible" : ""}`}
        type="button"
        aria-label="關閉導覽"
        onClick={() => setMobileNavOpen(false)}
      />
      <aside className={`side-nav ${mobileNavOpen ? "open" : ""}`} aria-label="主要導覽" aria-hidden={compactNav && !mobileNavOpen ? true : undefined} inert={compactNav && !mobileNavOpen ? true : undefined}>
        <div className="brand-lockup">
          <div className="product-mark" aria-hidden="true">CO</div>
          <div><strong>Continuity Ops</strong><span>事件指揮中心</span></div>
          <button className="icon-button nav-close" type="button" aria-label="關閉導覽" onClick={() => setMobileNavOpen(false)}><Icon name="close" /></button>
        </div>
        <nav>
          <p className="nav-section-label">OPERATIONS</p>
          {visibleNavItems.filter((item) => ["overview", "observability", "incidents", "services"].includes(item.id)).map((item) => (
            <button key={item.id} className={renderedView === item.id ? "active" : ""} type="button" aria-current={renderedView === item.id ? "page" : undefined} onClick={() => changeView(item.id)}>
              <Icon name={item.icon} /><span><strong>{item.label}</strong><small>{item.description}</small></span>
            </button>
          ))}
          {visibleNavItems.some((item) => ["audit", "access"].includes(item.id)) && <p className="nav-section-label governance">GOVERNANCE</p>}
          {visibleNavItems.filter((item) => ["audit", "access"].includes(item.id)).map((item) => (
            <button key={item.id} className={renderedView === item.id ? "active" : ""} type="button" aria-current={renderedView === item.id ? "page" : undefined} onClick={() => changeView(item.id)}>
              <Icon name={item.icon} /><span><strong>{item.label}</strong><small>{item.description}</small></span>
            </button>
          ))}
        </nav>
        <div className="nav-identity">
          <Avatar name={actor.displayName} />
          <div><strong>{actor.displayName}</strong><span>{snapshot?.organization.name ?? actor.email}</span></div>
        </div>
      </aside>

      <div className="ops-main-column" inert={compactNav && mobileNavOpen ? true : undefined}>
        <header className="topbar">
          <button ref={menuButtonRef} className="icon-button menu-button" type="button" aria-label="開啟導覽" aria-expanded={mobileNavOpen} onClick={() => setMobileNavOpen(true)}><Icon name="menu" /></button>
          <form className="global-search" role="search" onSubmit={submitGlobalSearch}>
            <label htmlFor="global-search"><Icon name="search" /><span className="sr-only">搜尋事件</span></label>
            <input id="global-search" type="search" value={globalQuery} onChange={(event) => setGlobalQuery(event.target.value)} placeholder="搜尋事件編號、服務或標題" />
          </form>
          <div className="topbar-actions">
            <SystemHealth health={health} timeZone={organizationTimeZone} />
            <button className="button ghost compact" type="button" disabled={loading || detailLoading} onClick={() => void refreshOperations()}><Icon name="refresh" />更新</button>
            {canCreateIncident && <button className="button primary compact declare-action" type="button" aria-label="宣告事件" onClick={() => { setMutationError(null); setDeclareOpen(true); }}><Icon name="plus" /><span className="button-label">宣告事件</span></button>}
              <div className="identity-menu">
              <Avatar name={actor.displayName} />
              <div><strong>{actor.displayName}</strong><span>{initialIdentity.mode === "local" ? "LOCAL" : ORGANIZATION_ROLE_LABEL[actor.roles[0] as OrganizationRole] ?? "已登入"}</span></div>
              <a href={initialIdentity.signOutPath}>{initialIdentity.mode === "local" ? "身分設定" : "登出"}</a>
            </div>
          </div>
        </header>

        {toast && <div className="toast" role="status"><Icon name="check" /><span>{toast}</span><button type="button" aria-label="關閉提示" onClick={() => setToast(null)}><Icon name="close" size={16} /></button></div>}

        <main id="main-content" className="content" tabIndex={-1}>
          {readOnlyAccess && <div className="read-only-notice" role="status"><Icon name="access" /><div><strong>目前為唯讀存取</strong><span>你可以查閱所有營運頁面；新增、編輯、指派、發布與刪除功能均未開放。</span></div></div>}
          {overviewError && <ErrorBanner
            title={snapshot ? "資料更新失敗，正在顯示最後成功快照" : "無法取得營運資料"}
            error={snapshot && overviewLastUpdatedAt
              ? { ...overviewError, message: `快照時間：${formatLongTimestamp(overviewLastUpdatedAt.toISOString(), organizationTimeZone)}。${overviewError.message}` }
              : overviewError}
            onRetry={() => void loadOverview()}
          />}
          {mutationError && <ErrorBanner title="操作未完成" error={mutationError} onRetry={mutationError.code === "VERSION_CONFLICT" ? () => void recoverVisibleConflict() : undefined} retryLabel="載入最新版" onDismiss={() => setMutationError(null)} />}
          {loading && !snapshot ? <LoadingScreen /> : !snapshot ? (
            <InitialLoadFailure onRetry={() => void loadOverview()} />
          ) : (
            <>
              {renderedView === "overview" && <OverviewView snapshot={snapshot} lastUpdatedAt={overviewLastUpdatedAt} stale={Boolean(overviewError)} timeZone={organizationTimeZone} selectIncident={selectIncident} openIncidents={() => changeView("incidents")} />}
              {renderedView === "observability" && <Suspense fallback={<div className="workspace-loading" role="status"><span className="spinner" />正在載入系統觀測圖表…</div>}><ObservabilityView data={observabilityData} loading={secondaryLoading} error={secondaryError} range={observabilityRange} onRangeChange={(nextRange) => { setObservabilityRange(nextRange); setObservabilityData(null); setSecondaryError(null); }} retry={() => void loadObservabilityView()} timeZone={organizationTimeZone} role={organizationRole ?? "observer"} /></Suspense>}
              {renderedView === "incidents" && (
                <IncidentsView
                  incidents={filteredIncidents}
                  query={incidentQuery}
                  setQuery={setIncidentQuery}
                  severityFilter={severityFilter}
                  setSeverityFilter={setSeverityFilter}
                  statusFilter={statusFilter}
                  setStatusFilter={changeStatusFilter}
                  selectedIncidentId={selectedIncidentId}
                  selectIncident={selectIncident}
                  incident={currentIncident}
                  detail={detail?.id === selectedIncidentId ? detail : null}
                  loading={detailLoading}
                  error={detailError}
                  lastUpdatedAt={detailLastUpdatedAt}
                  stale={detailStale}
                  timeZone={organizationTimeZone}
                  retry={() => selectedIncidentId && void loadIncident(selectedIncidentId)}
                  tab={workspaceTab}
                  setTab={changeWorkspaceTab}
                  openUpdate={() => { setMutationError(null); setUpdateOpen(true); }}
                  openTask={() => { setMutationError(null); setTaskOpen(true); }}
                  openEdit={() => { setMutationError(null); setIncidentEditOpen(true); }}
                  openAssignment={() => { setMutationError(null); setAssignmentOpen(true); }}
                  requestTransition={(target) => { setMutationError(null); setTransitionTarget(target); }}
                  openTaskEditor={(task) => { setMutationError(null); setTaskEditTargetId(task.id); }}
                  operators={snapshot.operators}
                  openCommunication={(communication) => { setMutationError(null); setCommunicationEditor(communication?.id ?? "new"); }}
                  requestCommunicationAction={(communication, action) => { setMutationError(null); setCommunicationAction({ communicationId: communication.id, action }); }}
                  mutationPending={mutationPending}
                  saveReview={saveReview}
                  canRespond={canRespondToIncident}
                  canTimeline={canAddTimeline}
                  canCommand={isIncidentCommander}
                  canAssign={canAssignIncident}
                  canReview={canReviewIncident}
                  canDraftCommunication={canDraftCommunication}
                  canApproveCommunication={canApproveCommunication}
                />
              )}
              {renderedView === "services" && <ServicesView services={snapshot.services} openCreate={canCreateService ? () => { setMutationError(null); setServiceOpen(true); } : undefined} openEdit={canCreateService ? (service) => { setMutationError(null); setServiceEditTarget(service); } : undefined} selectIncident={selectIncident} incidents={snapshot.incidents} timeZone={organizationTimeZone} />}
              {renderedView === "audit" && <AuditView records={auditRecords ?? snapshot?.recentAudit ?? []} loading={secondaryLoading} error={secondaryError} retry={() => void loadAuditView()} timeZone={organizationTimeZone} />}
              {renderedView === "access" && <AccessView data={accessData ?? { actor: snapshot.actor, operators: snapshot.operators, permissions: snapshot.actor.permissions }} identityMode={initialIdentity.mode} loading={secondaryLoading} error={secondaryError} retry={() => void loadAccessView()} timeZone={organizationTimeZone} canManage={canManageAccess} mutationPending={mutationPending} openCreate={() => { setMutationError(null); setMemberCreateOpen(true); }} openMember={(operator) => { setMutationError(null); setMemberEditTargetId(operator.id); }} />}
            </>
          )}
        </main>
      </div>

      {canCreateIncident && <DeclareIncidentDialog open={declareOpen} services={snapshot?.services ?? []} pending={mutationPending === "declare"} error={mutationError} onClose={() => { resetMutationIntent("declare"); setDeclareOpen(false); }} onSubmit={declareIncident} />}
      {canCreateService && <CreateServiceDialog open={serviceOpen} pending={mutationPending === "service-create"} error={mutationError} onClose={() => { resetMutationIntent("service-create"); setServiceOpen(false); }} onSubmit={createService} />}
      {canCreateService && serviceEditTarget && <ServiceEditDialog key={serviceEditTarget.id} open service={serviceEditTarget} timeZone={organizationTimeZone} pending={mutationPending === `service-update-${serviceEditTarget.id}`} error={mutationError} recoverConflict={reloadLatestAfterConflict} onClose={() => { resetMutationIntents(`service-update-${serviceEditTarget.id}`); setServiceEditTarget(null); }} onSubmit={updateService} />}
      {canAddTimeline && <TimelineDialog open={updateOpen} allowedKinds={allowedTimelineKinds} timeZone={organizationTimeZone} pending={mutationPending === "timeline-add"} error={mutationError} onClose={() => { resetMutationIntent("timeline-add"); setUpdateOpen(false); }} onSubmit={addTimelineEntry} />}
      {canDraftCommunication && communicationEditor && (communicationEditor === "new" || communicationEditorRecord) && <CommunicationEditorDialog key={communicationEditor === "new" ? `new-${selectedIncidentId}` : communicationEditor} open communication={communicationEditorRecord} timeZone={organizationTimeZone} pending={mutationPending?.startsWith("communication-") ?? false} error={mutationError} recoverConflict={reloadLatestAfterConflict} onClose={() => { if (communicationEditor !== "new") resetMutationIntent(`communication-update-${communicationEditor}`); else if (selectedIncidentId) resetMutationIntent(`communication-create-${selectedIncidentId}`); setCommunicationEditor(null); }} onSubmit={saveCommunication} />}
      {canApproveCommunication && communicationAction && communicationActionRecord && <CommunicationActionDialog open action={communicationAction.action} communication={communicationActionRecord} incident={currentIncident} timeZone={organizationTimeZone} pending={mutationPending === `communication-${communicationAction.action}-${communicationActionRecord.id}`} error={mutationError} recoverConflict={reloadLatestAfterConflict} onClose={() => { resetMutationIntent(`communication-${communicationAction.action}-${communicationActionRecord.id}`); setCommunicationAction(null); }} onConfirm={actOnCommunication} />}
      {canRespondToIncident && <TaskDialog open={taskOpen} operators={snapshot?.operators ?? []} timeZone={organizationTimeZone} pending={mutationPending === "task-add"} error={mutationError} onClose={() => { resetMutationIntent("task-add"); setTaskOpen(false); }} onSubmit={addTask} />}
      {canRespondToIncident && taskEditTarget && <TaskEditorDialog key={taskEditTarget.id} open task={taskEditTarget} operators={snapshot?.operators ?? []} timeZone={organizationTimeZone} pending={mutationPending === `task-${taskEditTarget.id}`} error={mutationError} recoverConflict={() => void reloadTaskAfterConflict(taskEditTarget.id)} resetIntent={() => clearStaleMutationIntent(`task-${taskEditTarget.id}`)} onClose={() => { resetMutationIntents(`task-${taskEditTarget.id}`); setTaskEditTargetId(null); }} onSubmit={updateTask} />}
      {canRespondToIncident && selectedDetail && <IncidentOverviewDialog key={selectedDetail.id} open={incidentEditOpen} incident={selectedDetail} canEditImpact={isIncidentCommander} pending={mutationPending === "incident-overview"} error={mutationError} recoverConflict={reloadLatestAfterConflict} onClose={() => { resetMutationIntent("incident-overview"); setIncidentEditOpen(false); }} onSubmit={updateIncidentOverview} />}
      {canAssignIncident && selectedDetail && <AssignmentDialog key={`${selectedDetail.id}:${selectedDetail.responders.map((responder) => responder.assignmentId).join(":")}`} open={assignmentOpen} operators={snapshot?.operators ?? []} responders={selectedDetail.responders} pending={mutationPending} error={mutationError} onClose={() => { resetMutationIntent("incident-assignment"); resetMutationIntents("assignment-revoke-"); setAssignmentOpen(false); }} onSubmit={assignIncident} onRevoke={revokeAssignment} />}
      {canManageAccess && <MemberCreateDialog open={memberCreateOpen} pending={mutationPending === "member-create"} error={mutationError} onClose={() => { resetMutationIntent("member-create"); setMemberCreateOpen(false); }} onSubmit={createMember} />}
      {canManageAccess && memberEditTarget && <MemberAccessDialog key={memberEditTarget.id} open operator={memberEditTarget} pending={mutationPending === `member-${memberEditTarget.membershipId}`} error={mutationError} recoverConflict={() => { if (memberEditTarget.membershipId) void reloadMemberAfterConflict(memberEditTarget.membershipId); }} resetIntent={() => { if (memberEditTarget.membershipId) clearStaleMutationIntent(`member-${memberEditTarget.membershipId}`); }} onClose={() => { if (memberEditTarget.membershipId) resetMutationIntents(`member-${memberEditTarget.membershipId}`); setMemberEditTargetId(null); }} onSubmit={updateMember} />}
      {canRespondToIncident && <TransitionDialog key={transitionTarget ?? "none"} incident={currentIncident} target={transitionTarget} pending={mutationPending === "transition"} error={mutationError} recoverConflict={reloadLatestAfterConflict} onClose={() => { resetMutationIntent("transition"); setTransitionTarget(null); }} onSubmit={transitionIncident} />}
    </div>
  );
}

function OverviewView({ snapshot, lastUpdatedAt, stale, timeZone, selectIncident, openIncidents }: {
  snapshot: OperationsSnapshot;
  lastUpdatedAt: Date | null;
  stale: boolean;
  timeZone: string;
  selectIncident: (id: string) => void;
  openIncidents: () => void;
}) {
  const metrics = snapshot.metrics;
  const active = [...snapshot.incidents]
    .filter((incident) => !["closed", "cancelled"].includes(incident.status))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const unknownTelemetry = snapshot.services.filter((service) => service.telemetryStatus === "unavailable").length;
  const serviceAttention = [...snapshot.services]
    .filter((service) => service.activeIncidentCount > 0 || service.status !== "operational" || service.telemetryStatus === "unavailable")
    .sort((a, b) => b.activeIncidentCount - a.activeIncidentCount || Number(a.status === "unknown") - Number(b.status === "unknown"));
  const severityCounts = (["SEV1", "SEV2", "SEV3", "SEV4"] as const).map((severity) => ({
    severity,
    count: active.filter((incident) => incident.severity === severity).length,
  }));
  const activeSeverityTotal = Math.max(1, severityCounts.reduce((sum, item) => sum + item.count, 0));
  const organizationRole = snapshot.actor.roles[0] as OrganizationRole | undefined;
  const situationTitle = metrics.sev1Incidents > 0
    ? `${metrics.sev1Incidents}件重大事件需要立即指揮`
    : metrics.activeIncidents > 0
      ? `${metrics.activeIncidents}件事件仍在處理`
      : "目前沒有未結案事件";
  const situationDescription = metrics.sev1Incidents > 0
    ? "先確認影響範圍、事件指揮官與下一次對外更新，再檢查是否有新的5xx或延遲異常。"
    : metrics.activeIncidents > 0
      ? "依嚴重度、服務影響與逾期工作安排下一個行動；尚未接入的監控資料不視為正常。"
      : "持續確認服務遙測與工作狀態；沒有事件不代表沒有未知風險。";
  const roleBrief = organizationRole === "responder"
    ? "從事件工作區與系統觀測比對異常，留下可以重跑的驗證證據。"
    : organizationRole === "auditor"
      ? "利用request ID交叉查核錯誤請求與稽核紀錄，不以單一畫面下結論。"
      : organizationRole === "observer"
        ? "先掌握事件、服務影響與資料更新時間；目前角色維持唯讀。"
        : "確認高風險事件已有負責人，並讓每個下一步都有明確所有者。";
  return (
    <div className="view-stack">
      <PageHeader eyebrow="LIVE BRIEFING" title="營運總覽" description="先掌握現在的風險、責任與下一個行動，再進入事件細節。">
        <div className={`freshness ${stale ? "stale" : ""}`}><span className={lastUpdatedAt && !stale ? "live-dot" : "live-dot idle"} />{stale ? `快照 ${formatTimestamp(lastUpdatedAt?.toISOString(), timeZone)}` : lastUpdatedAt ? `更新於 ${formatTimestamp(lastUpdatedAt.toISOString(), timeZone)}` : "等待首次更新"}</div>
      </PageHeader>
      <section className={`command-briefing ${metrics.sev1Incidents > 0 ? "critical" : metrics.activeIncidents > 0 ? "active" : "calm"}`} aria-labelledby="situation-title">
        <div className="command-briefing-copy"><span className="briefing-kicker">CURRENT SITUATION</span><h2 id="situation-title">{situationTitle}</h2><p>{situationDescription}</p>{metrics.activeIncidents > 0 && <button className="button briefing-action" type="button" onClick={openIncidents}>進入事件指揮 <Icon name="arrow" size={16} /></button>}</div>
        <dl className="command-briefing-facts">
          <div><dt>受影響服務</dt><dd>{metrics.incidentAffectedServices}</dd><small>目前未結案事件</small></div>
          <div><dt>未指派指揮官</dt><dd>{metrics.unassignedIncidents ?? "—"}</dd><small>需要明確責任</small></div>
          <div><dt>逾期工作</dt><dd>{metrics.overdueTasks}</dd><small>仍待完成或取消</small></div>
        </dl>
      </section>
      <section className="overview-insight-grid">
        <article className="panel severity-profile" aria-labelledby="severity-profile-title"><header><div><p className="eyebrow">INCIDENT PROFILE</p><h2 id="severity-profile-title">未結案事件分布</h2></div><span>{active.length}件</span></header><div className="severity-bar" role="img" aria-label={severityCounts.map((item) => `${item.severity} ${item.count}件`).join("、")}>{severityCounts.filter((item) => item.count > 0).map((item) => <span key={item.severity} className={item.severity.toLowerCase()} style={{ width: `${item.count / activeSeverityTotal * 100}%` }} />)}</div><dl>{severityCounts.map((item) => <div key={item.severity}><dt><span className={`severity-dot ${item.severity.toLowerCase()}`} />{item.severity}</dt><dd>{item.count}</dd></div>)}</dl></article>
        <article className="panel role-brief"><p className="eyebrow">YOUR OPERATING FOCUS</p><h2>{ORGANIZATION_ROLE_LABEL[organizationRole ?? "observer"]}的判斷重點</h2><p>{roleBrief}</p><button className="text-button" type="button" onClick={() => openIncidents()}>查看需要處理的事件 <Icon name="arrow" size={16} /></button></article>
      </section>
      <section className="panel reliability-strip" aria-labelledby="reliability-metrics-title">
        <div className="reliability-heading"><p className="eyebrow">RESPONSE ANALYTICS</p><h2 id="reliability-metrics-title">應變指標</h2><span>目前組織中，操作者有權查看的事件</span></div>
        <dl>
          <div><dt>平均確認時間</dt><dd>{formatMinutes(metrics.meanTimeToAcknowledgeMinutes)}</dd><dd className="metric-detail">MTTA · {metrics.acknowledgeSampleSize} 件有效樣本</dd></div>
          <div><dt>平均復原時間</dt><dd>{formatMinutes(metrics.meanTimeToRestoreMinutes)}</dd><dd className="metric-detail">MTTR · {metrics.restoreSampleSize} 件已解決事件</dd></div>
          <div><dt>SLO 遙測</dt><dd>{metrics.sloBreaches == null ? "尚無樣本" : `${metrics.sloBreaches} 項違反`}</dd><dd className="metric-detail">{metrics.monitoredServices} / {snapshot.services.length} 項服務有可用資料</dd></div>
        </dl>
      </section>
      <div className="overview-grid">
        <section className="panel active-incidents-panel" aria-labelledby="active-incidents-title">
          <PanelHeader title="優先處理事件" eyebrow="ACTIVE INCIDENTS" id="active-incidents-title">
            <button className="text-button" type="button" onClick={openIncidents}>查看全部 <Icon name="arrow" size={16} /></button>
          </PanelHeader>
          <IncidentTable incidents={active.slice(0, 8)} selectIncident={selectIncident} emptyMessage="目前沒有進行中的事件。" timeZone={timeZone} />
        </section>
        <section className="panel service-risk-panel" aria-labelledby="service-risk-title">
          <PanelHeader title="服務健康與事件影響" eyebrow="SERVICE HEALTH" id="service-risk-title"><span className="monitoring-summary">{snapshot.services.length === 0 ? "尚無服務" : unknownTelemetry > 0 ? `${unknownTelemetry} 項未接監控` : "遙測皆有資料"}</span></PanelHeader>
          <div className="service-risk-list">
            {serviceAttention.slice(0, 6).map((service) => (
              <article key={service.id}>
                <ServiceStatusDot status={service.status} />
                <span className="sr-only">{SERVICE_STATUS_LABEL[service.status]}</span>
                <div><strong>{service.name}</strong><span>{service.ownerTeam} · 監控：{SERVICE_STATUS_LABEL[service.status]}</span></div>
                <div className="service-risk-values"><strong>{service.telemetryStatus === "unavailable" ? "未接監控" : service.sloAttainment == null ? "無 SLO 樣本" : `${service.sloAttainment.toFixed(3)}%`}</strong><span>{service.activeIncidentCount > 0 ? `${service.activeIncidentCount} 件事件影響` : "無未結案事件"}</span></div>
              </article>
            ))}
            {serviceAttention.length === 0 && <EmptyState compact title="目前沒有已知服務風險" description="已連線的監控與未結案事件均未顯示需立即處理的項目。" />}
          </div>
        </section>
        {snapshot.actor.permissions?.includes("audit:read") && <section className="panel audit-preview-panel" aria-labelledby="recent-activity-title">
          <PanelHeader title="最近操作" eyebrow="AUDIT ACTIVITY" id="recent-activity-title" />
          <AuditList records={(snapshot?.recentAudit ?? []).slice(0, 8)} timeZone={timeZone} />
        </section>}
      </div>
    </div>
  );
}

function IncidentsView(props: {
  incidents: IncidentSummary[];
  query: string;
  setQuery: (value: string) => void;
  severityFilter: Severity | "all";
  setSeverityFilter: (value: Severity | "all") => void;
  statusFilter: IncidentStatus | "open" | "all";
  setStatusFilter: (value: IncidentStatus | "open" | "all") => void;
  selectedIncidentId: string | null;
  selectIncident: (id: string) => void;
  incident: IncidentSummary | IncidentDetail | null;
  detail: IncidentDetail | null;
  loading: boolean;
  error: DisplayError | null;
  lastUpdatedAt: Date | null;
  stale: boolean;
  timeZone: string;
  retry: () => void;
  tab: WorkspaceTab;
  setTab: (tab: WorkspaceTab) => void;
  openUpdate: () => void;
  openTask: () => void;
  openEdit: () => void;
  openAssignment: () => void;
  requestTransition: (target: IncidentStatus) => void;
  openTaskEditor: (task: IncidentTask) => void;
  operators: Operator[];
  openCommunication: (communication?: IncidentCommunication) => void;
  requestCommunicationAction: (communication: IncidentCommunication, action: "review" | "publish") => void;
  mutationPending: string | null;
  saveReview: (review: IncidentReview) => Promise<boolean>;
  canRespond: boolean;
  canTimeline: boolean;
  canCommand: boolean;
  canAssign: boolean;
  canReview: boolean;
  canDraftCommunication: boolean;
  canApproveCommunication: boolean;
}) {
  const [mobileWorkspaceOpen, setMobileWorkspaceOpen] = useState(false);
  useEffect(() => {
    const navigation = initialNavigationState();
    if (navigation.view !== "incidents" || !navigation.incidentId) return;
    const openWorkspace = window.setTimeout(() => setMobileWorkspaceOpen(true), 0);
    return () => window.clearTimeout(openWorkspace);
  }, []);
  const selectForWorkspace = (incidentId: string) => {
    props.selectIncident(incidentId);
    setMobileWorkspaceOpen(true);
  };
  return (
    <div className="view-stack incidents-view">
      <PageHeader eyebrow="INCIDENT COMMAND" title="事件指揮" description="在單一共享工作區協調調查、處置、溝通與復原驗證。" />
      <div className={`incident-command-layout ${mobileWorkspaceOpen ? "mobile-workspace-open" : ""}`}>
        <section className="incident-queue panel" aria-labelledby="incident-queue-title">
          <div className="queue-header">
            <div><p className="eyebrow">INCIDENT QUEUE</p><h2 id="incident-queue-title">事件佇列</h2></div>
            <span className="count-badge">{props.incidents.length}</span>
          </div>
          <div className="queue-filters">
            <label className="search-field"><span className="sr-only">搜尋事件佇列</span><Icon name="search" /><input type="search" value={props.query} onChange={(event) => props.setQuery(event.target.value)} placeholder="搜尋事件" /></label>
            <div className="queue-filter-row">
              <label><span className="sr-only">嚴重度</span><select value={props.severityFilter} onChange={(event) => props.setSeverityFilter(event.target.value as Severity | "all")}><option value="all">全部嚴重度</option><option value="SEV1">SEV1</option><option value="SEV2">SEV2</option><option value="SEV3">SEV3</option><option value="SEV4">SEV4</option></select></label>
              <label><span className="sr-only">事件狀態</span><select value={props.statusFilter} onChange={(event) => props.setStatusFilter(event.target.value as IncidentStatus | "open" | "all")}><option value="open">未結案</option><option value="all">全部狀態</option>{Object.entries(INCIDENT_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            </div>
          </div>
          <div className="incident-list">
            {props.incidents.map((incident) => (
              <button key={incident.id} className={props.selectedIncidentId === incident.id ? "incident-list-item selected" : "incident-list-item"} type="button" aria-pressed={props.selectedIncidentId === incident.id} onClick={() => selectForWorkspace(incident.id)}>
                <div className="incident-list-top"><SeverityBadge severity={incident.severity} /><span className="incident-key">{incident.key}</span><time>{formatDuration(incident.startedAt, incident.resolvedAt)}</time></div>
                <strong>{incident.title}</strong>
                <span className="incident-service">{incident.serviceName} · {ENVIRONMENT_LABEL[incident.environment]}</span>
                <div className="incident-list-bottom"><StatusBadge status={incident.status} /><span>{incident.commander?.displayName ?? "待指派事件指揮官"}</span></div>
              </button>
            ))}
            {props.incidents.length === 0 && <EmptyState compact title="沒有符合條件的事件" description="請放寬搜尋或篩選條件。" />}
          </div>
        </section>
        <section className="incident-workspace panel" aria-label="事件指揮工作區">
          {!props.incident ? <EmptyState title="選擇一個事件" description="從左側佇列開啟事件的共享工作區。" /> : (
            <IncidentWorkspace {...props} incident={props.incident} showQueue={() => setMobileWorkspaceOpen(false)} />
          )}
        </section>
      </div>
    </div>
  );
}

function IncidentWorkspace(props: {
  incident: IncidentSummary | IncidentDetail;
  detail: IncidentDetail | null;
  loading: boolean;
  error: DisplayError | null;
  lastUpdatedAt: Date | null;
  stale: boolean;
  timeZone: string;
  retry: () => void;
  tab: WorkspaceTab;
  setTab: (tab: WorkspaceTab) => void;
  openUpdate: () => void;
  openTask: () => void;
  openEdit: () => void;
  openAssignment: () => void;
  requestTransition: (target: IncidentStatus) => void;
  openTaskEditor: (task: IncidentTask) => void;
  operators: Operator[];
  openCommunication: (communication?: IncidentCommunication) => void;
  requestCommunicationAction: (communication: IncidentCommunication, action: "review" | "publish") => void;
  mutationPending: string | null;
  saveReview: (review: IncidentReview) => Promise<boolean>;
  canRespond: boolean;
  canTimeline: boolean;
  canCommand: boolean;
  canAssign: boolean;
  canReview: boolean;
  canDraftCommunication: boolean;
  canApproveCommunication: boolean;
  showQueue: () => void;
}) {
  const incident = props.incident;
  const detail = props.detail;
  const tabs: { id: WorkspaceTab; label: string; count?: number }[] = [
    { id: "summary", label: "總覽" },
    { id: "timeline", label: "時間軸", count: detail?.timeline.length },
    { id: "tasks", label: "工作項目", count: detail?.tasks.filter((task) => !["completed", "cancelled"].includes(task.status)).length },
    { id: "communications", label: "事件通訊", count: detail?.communications.filter((communication) => communication.status !== "published").length },
    { id: "review", label: "事後檢討" },
  ];
  const transitionTargets = allowedIncidentTransitions(incident.status).filter((target) => {
    const requiresCommand = ["resolved", "closed"].includes(incident.status) || ["resolved", "closed", "cancelled"].includes(target);
    return !props.error && (props.canCommand || (props.canRespond && !requiresCommand));
  });

  function tabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!(["ArrowLeft", "ArrowRight", "Home", "End"] as string[]).includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    props.setTab(tabs[nextIndex].id);
    document.getElementById(`workspace-tab-${tabs[nextIndex].id}`)?.focus();
  }

  return (
    <>
      <header className="workspace-titlebar">
        <button className="button ghost compact mobile-back-button" type="button" onClick={props.showQueue}>返回事件清單</button>
        <div className="workspace-title-meta"><SeverityBadge severity={incident.severity} /><span>{incident.key}</span><StatusBadge status={incident.status} /><div className={`freshness ${props.stale ? "stale" : ""}`}><span className={props.lastUpdatedAt && !props.stale ? "live-dot" : "live-dot idle"} />{props.stale ? `事件快照 ${formatTimestamp(props.lastUpdatedAt?.toISOString(), props.timeZone)}` : props.lastUpdatedAt ? `事件資料 ${formatTimestamp(props.lastUpdatedAt.toISOString(), props.timeZone)}` : "等待事件資料"}</div></div>
        <div className="workspace-title-row">
          <div><h2>{incident.title}</h2><p>{incident.serviceName} · 持續 {formatDuration(incident.startedAt, incident.resolvedAt)}</p></div>
          <div className="workspace-actions">
            {props.canRespond && props.tab === "summary" && <button className="button secondary compact" type="button" onClick={props.openEdit}>編輯總覽</button>}
            {props.canAssign && <button className="button secondary compact" type="button" onClick={props.openAssignment}>指派人員</button>}
            {props.canTimeline && props.tab === "summary" && <button className="button secondary compact" type="button" onClick={props.openUpdate}><Icon name="plus" />加入更新</button>}
            {transitionTargets.map((target, index) => <button key={target} className={`button compact ${target === "cancelled" ? "danger" : index === 0 ? "primary" : "secondary"}`} type="button" onClick={() => props.requestTransition(target)}>{transitionActionLabel(incident.status, target)}</button>)}
          </div>
        </div>
        <dl className="incident-facts">
          <div><dt>執行環境</dt><dd>{ENVIRONMENT_LABEL[incident.environment]}</dd></div>
          <div><dt>事件指揮官</dt><dd>{incident.commander?.displayName ?? (props.loading ? "載入中…" : props.error ? "無法取得" : "待指派")}</dd></div>
          <div><dt>影響範圍</dt><dd>{incident.affectedScope || "待確認"}</dd></div>
          <div><dt>宣告時間</dt><dd>{formatLongTimestamp(incident.startedAt, props.timeZone)}</dd></div>
          <div><dt>確認時間</dt><dd>{incident.acknowledgedAt ? formatLongTimestamp(incident.acknowledgedAt, props.timeZone) : "尚未確認"}</dd></div>
          <div><dt>解決時間</dt><dd>{incident.resolvedAt ? formatLongTimestamp(incident.resolvedAt, props.timeZone) : "尚未解決"}</dd></div>
          <div><dt>最後更新</dt><dd>{formatTimestamp(incident.updatedAt, props.timeZone)}</dd></div>
        </dl>
      </header>
      <div className="workspace-tabs" role="tablist" aria-label="事件工作區分頁">
        {tabs.map((tab, index) => <button id={`workspace-tab-${tab.id}`} key={tab.id} type="button" role="tab" aria-selected={props.tab === tab.id} aria-controls={`workspace-panel-${tab.id}`} tabIndex={props.tab === tab.id ? 0 : -1} onKeyDown={(event) => tabKeyDown(event, index)} onClick={() => props.setTab(tab.id)}>{tab.label}{tab.count != null && <span>{tab.count}</span>}</button>)}
      </div>
      {props.error && <div className="workspace-error"><ErrorBanner title={detail ? "事件更新失敗，正在顯示最後成功快照" : "無法取得事件工作區"} error={props.error} onRetry={props.retry} /></div>}
      {props.loading && !detail ? <div className="workspace-loading" role="status"><span className="spinner" />正在載入共享工作區…</div> : !detail ? (
        <div className="workspace-unavailable"><strong>事件內容尚未載入</strong><p>總覽、時間軸與工作項目未取得前，不會以空白資料代替。</p><button className="button secondary compact" type="button" onClick={props.retry}>重新取得</button></div>
      ) : (
        <div className="workspace-panel-body">
          {props.tab === "summary" && <SummaryPanel incident={incident} detail={detail} />}
          {props.tab === "timeline" && <TimelinePanel entries={detail?.timeline ?? []} canWrite={props.canTimeline} openUpdate={props.openUpdate} timeZone={props.timeZone} />}
          {props.tab === "tasks" && <TasksPanel tasks={detail?.tasks ?? []} canWrite={props.canRespond} openTask={props.openTask} openTaskEditor={props.openTaskEditor} mutationPending={props.mutationPending} timeZone={props.timeZone} />}
          {props.tab === "communications" && <CommunicationsPanel incidentStatus={incident.status} communications={detail.communications} operators={props.operators} responders={detail.responders} canDraft={props.canDraftCommunication} canApprove={props.canApproveCommunication} openEditor={props.openCommunication} requestAction={props.requestCommunicationAction} mutationPending={props.mutationPending} timeZone={props.timeZone} />}
          {props.tab === "review" && <ReviewPanel key={incident.id} incidentStatus={incident.status} review={detail?.review ?? null} canWrite={props.canReview} pending={props.mutationPending === "review-save"} save={props.saveReview} />}
        </div>
      )}
    </>
  );
}

function SummaryPanel({ incident, detail }: { incident: IncidentSummary | IncidentDetail; detail: IncidentDetail | null }) {
  const openTasks = detail?.tasks.filter((task) => !["completed", "cancelled"].includes(task.status)) ?? [];
  return (
    <div id="workspace-panel-summary" role="tabpanel" aria-labelledby="workspace-tab-summary" className="summary-grid">
      <section className="summary-main">
        <InfoBlock label="當前影響" value={detail?.impact || incident.summary || "尚未建立影響說明。"} />
        <InfoBlock label="當前假設" value={detail?.currentHypothesis || "調查中，尚未建立可驗證假設。"} />
        <InfoBlock label="處置方向" value={detail?.currentMitigation || "尚未記錄當前處置方向。"} />
        <InfoBlock label="復原驗證條件" value={detail?.verificationCriteria || "尚未建立可判定復原的驗證條件。"} />
      </section>
      <aside className="summary-rail">
        <section><h3>應變人員</h3><div className="responder-list">{(detail?.responders ?? []).map((responder) => <div key={responder.assignmentId}><Avatar name={responder.displayName} small /><span><strong>{responder.displayName}</strong><small>{responder.role}{responder.team ? ` · ${responder.team}` : ""}</small></span></div>)}{(detail?.responders.length ?? 0) === 0 && <p className="muted-copy">尚未指派應變人員。</p>}</div></section>
        <section><h3>待處理工作</h3><div className="compact-task-list">{openTasks.slice(0, 5).map((task) => <div key={task.id}><PriorityDot priority={task.priority} /><span><strong>{task.title}</strong><small>{task.owner?.displayName ?? "待指派"} · {TASK_STATUS_LABEL[task.status]}</small></span></div>)}{openTasks.length === 0 && <p className="muted-copy">目前沒有待處理工作。</p>}</div></section>
        {detail?.service?.runbookUrl && <section className="service-runbook"><h3>服務操作手冊</h3><a href={detail.service.runbookUrl} target="_blank" rel="noreferrer">開啟 {detail.service.name} Runbook <span aria-hidden="true">↗</span></a><p>由服務目錄維護的 HTTPS 操作手冊。</p></section>}
      </aside>
    </div>
  );
}

function TimelinePanel({ entries, canWrite, openUpdate, timeZone }: { entries: TimelineEntry[]; canWrite: boolean; openUpdate: () => void; timeZone: string }) {
  return (
    <div id="workspace-panel-timeline" role="tabpanel" aria-labelledby="workspace-tab-timeline" className="timeline-panel">
      <div className="panel-toolbar"><div><h3>事件時間軸</h3><p>時間軸依伺服器時間排序，保留操作者與結果。</p></div>{canWrite && <button className="button secondary compact" type="button" onClick={openUpdate}><Icon name="plus" />加入更新</button>}</div>
      {entries.length > 0 ? <ol className="incident-timeline">{[...entries].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()).map((entry) => <li key={entry.id}><div className={`timeline-marker ${entry.result ?? "info"}`}><span /></div><div className="timeline-content"><div><span className="timeline-kind">{TIMELINE_KIND_LABEL[entry.kind]}</span><time>{formatLongTimestamp(entry.occurredAt, timeZone)}</time></div><p>{entry.message}</p>{entry.kind === "evidence" && (entry.sourceLabel || entry.observedFrom || entry.observedTo || entry.sha256Digest) && <dl className="evidence-metadata">{entry.sourceLabel && <div><dt>來源</dt><dd>{entry.sourceLabel}</dd></div>}{(entry.observedFrom || entry.observedTo) && <div><dt>觀測區間</dt><dd>{formatLongTimestamp(entry.observedFrom, timeZone)} — {formatLongTimestamp(entry.observedTo, timeZone)}</dd></div>}{entry.sha256Digest && <div><dt>SHA-256</dt><dd><code title={entry.sha256Digest}>{entry.sha256Digest}</code></dd></div>}</dl>}<footer><span>{entry.actor.displayName}</span>{isHttpsUrl(entry.referenceUrl) && <a href={entry.referenceUrl} target="_blank" rel="noreferrer">開啟證據來源 <span aria-hidden="true">↗</span></a>}</footer></div></li>)}</ol> : <EmptyState title="尚無時間軸記錄" description="尚未建立調查、處置或溝通更新。" actionLabel={canWrite ? "加入更新" : undefined} onAction={canWrite ? openUpdate : undefined} />}
    </div>
  );
}

function TasksPanel({ tasks, canWrite, openTask, openTaskEditor, mutationPending, timeZone }: { tasks: IncidentTask[]; canWrite: boolean; openTask: () => void; openTaskEditor: (task: IncidentTask) => void; mutationPending: string | null; timeZone: string }) {
  return (
    <div id="workspace-panel-tasks" role="tabpanel" aria-labelledby="workspace-tab-tasks" className="tasks-panel">
      <div className="panel-toolbar"><div><h3>工作項目</h3><p>每項工作都應有負責人、優先度、狀態與完成證據。</p></div>{canWrite && <button className="button secondary compact" type="button" onClick={openTask}><Icon name="plus" />新增工作</button>}</div>
      {tasks.length > 0 ? <div className="table-scroll" role="region" aria-label="事件工作項目，可水平捲動" tabIndex={0}><table className="data-table task-table"><caption className="sr-only">事件工作項目</caption><thead><tr><th scope="col">工作</th><th scope="col">優先度</th><th scope="col">負責人</th><th scope="col">到期時間</th><th scope="col">狀態</th><th scope="col">證據</th>{canWrite && <th scope="col"><span className="sr-only">操作</span></th>}</tr></thead><tbody>{tasks.map((task) => {
        const pending = mutationPending === `task-${task.id}`;
        return <tr key={task.id}><th scope="row"><strong>{task.title}</strong>{task.description && <small>{task.description}</small>}{task.cancellationReason && <small className="task-cancellation-reason" title={task.cancellationReason}>取消理由：{task.cancellationReason}</small>}<small>更新 {formatTimestamp(task.updatedAt, timeZone)}</small></th><td><PriorityBadge priority={task.priority} /></td><td>{task.owner?.displayName ?? "待指派"}</td><td>{formatTimestamp(task.dueAt, timeZone)}</td><td><span className={`task-status ${task.status}`}>{TASK_STATUS_LABEL[task.status]}</span></td><td>{isHttpsUrl(task.evidenceRef) ? <a href={task.evidenceRef!} target="_blank" rel="noreferrer">開啟證據 <span aria-hidden="true">↗</span></a> : <span className={task.status === "completed" ? "value-critical" : undefined}>{task.status === "completed" ? "缺少證據" : "—"}</span>}</td>{canWrite && <td>{pending ? <span className="member-pending" role="status"><span className="spinner" />更新中</span> : <button className="button ghost compact" type="button" onClick={() => openTaskEditor(task)}>管理</button>}</td>}</tr>;
      })}</tbody></table></div> : <EmptyState title="尚無工作項目" description="尚未建立可追蹤工作。" actionLabel={canWrite ? "新增工作" : undefined} onAction={canWrite ? openTask : undefined} />}
    </div>
  );
}

function CommunicationsPanel({ incidentStatus, communications, operators, responders, canDraft, canApprove, openEditor, requestAction, mutationPending, timeZone }: {
  incidentStatus: IncidentStatus;
  communications: IncidentCommunication[];
  operators: Operator[];
  responders: IncidentAssignment[];
  canDraft: boolean;
  canApprove: boolean;
  openEditor: (communication?: IncidentCommunication) => void;
  requestAction: (communication: IncidentCommunication, action: "review" | "publish") => void;
  mutationPending: string | null;
  timeZone: string;
}) {
  const [renderedAt] = useState(() => Date.now());
  const people = new Map<string, string>();
  for (const operator of operators) people.set(operator.id, operator.displayName);
  for (const responder of responders) people.set(responder.id, responder.displayName);
  const personName = (id: string | null) => id ? people.get(id) ?? `成員 ${id.slice(-6)}` : "—";
  const terminalIncident = ["resolved", "closed", "cancelled"].includes(incidentStatus);
  const ordered = [...communications].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return (
    <div id="workspace-panel-communications" role="tabpanel" aria-labelledby="workspace-tab-communications" className="communications-panel">
      <div className="panel-toolbar"><div><h3>事件通訊</h3><p>將訊息分成草稿、核准與發布狀態，保留負責人、受眾及下一次更新時間。</p></div>{canDraft && <button className="button secondary compact" type="button" onClick={() => openEditor()}><Icon name="plus" />建立草稿</button>}</div>
      <div className="integration-notice" role="note"><strong>發布範圍</strong><span>此頁記錄已核准的通訊版本與發布時間；尚未連接外部狀態頁、郵件或訊息平台，不代表訊息已送達外部受眾。</span></div>
      {terminalIncident && communications.some((communication) => communication.status === "reviewed") && <div className="form-warning communication-terminal-note" role="note">事件已解決、結案或取消；已核准但尚未發布的通訊不能再標記發布。</div>}
      {ordered.length > 0 ? <div className="communication-list">{ordered.map((communication) => {
        const pending = mutationPending?.endsWith(communication.id) ?? false;
        const nextUpdate = safeDate(communication.nextUpdateAt);
        const nextUpdateOverdue = Boolean(nextUpdate && communication.status === "published" && nextUpdate.getTime() < renderedAt);
        return <article key={communication.id} className={`communication-card ${communication.status}`}>
          <header><div className="communication-badges"><span className={`audience-badge ${communication.audience}`}>{COMMUNICATION_AUDIENCE_LABEL[communication.audience]}</span><span className={`communication-status ${communication.status}`}>{COMMUNICATION_STATUS_LABEL[communication.status]}</span></div><time dateTime={communication.updatedAt}>更新 {formatLongTimestamp(communication.updatedAt, timeZone)}</time></header>
          <p className="communication-message">{communication.message}</p>
          {communication.affectedComponents.length > 0 && <div className="component-chips" aria-label="受影響元件">{communication.affectedComponents.map((component) => <span key={component}>{component}</span>)}</div>}
          <dl className="communication-metadata">
            <div><dt>建立者</dt><dd>{personName(communication.createdByUserId)}</dd></div>
            <div><dt>核准</dt><dd>{communication.reviewedAt ? `${personName(communication.reviewedByUserId)} · ${formatTimestamp(communication.reviewedAt, timeZone)}` : "尚未核准"}</dd></div>
            <div><dt>發布</dt><dd>{communication.publishedAt ? `${personName(communication.publishedByUserId)} · ${formatTimestamp(communication.publishedAt, timeZone)}` : "尚未發布"}</dd></div>
            <div><dt>下次更新</dt><dd className={nextUpdateOverdue ? "value-critical" : undefined}>{communication.nextUpdateAt ? `${formatLongTimestamp(communication.nextUpdateAt, timeZone)}${nextUpdateOverdue ? " · 已逾期" : ""}` : communication.message.toLowerCase().startsWith("[final]") ? "最終公告" : "未安排"}</dd></div>
          </dl>
          {(canDraft || canApprove) && communication.status !== "published" && <footer>
            {canDraft && communication.status === "draft" && <button className="button ghost compact" type="button" disabled={pending} onClick={() => openEditor(communication)}>編輯草稿</button>}
            {canApprove && communication.status === "draft" && <button className="button secondary compact" type="button" disabled={pending} onClick={() => requestAction(communication, "review")}>核准草稿</button>}
            {canApprove && communication.status === "reviewed" && <button className="button primary compact" type="button" disabled={pending || terminalIncident} title={terminalIncident ? "事件已進入終止狀態，不能再發布通訊。" : undefined} onClick={() => requestAction(communication, "publish")}>標記為已發布</button>}
          </footer>}
        </article>;
      })}</div> : <EmptyState title="尚無事件通訊" description="建立第一份通訊草稿，清楚記錄受眾、已確認資訊與下一次更新時間。" actionLabel={canDraft ? "建立草稿" : undefined} onAction={canDraft ? () => openEditor() : undefined} />}
    </div>
  );
}

function ReviewPanel({ incidentStatus, review, canWrite, pending, save }: { incidentStatus: IncidentStatus; review: IncidentReview | null; canWrite: boolean; pending: boolean; save: (review: IncidentReview) => Promise<boolean> }) {
  const incoming: IncidentReview = review ?? { status: "draft", summary: "", customerImpact: "", rootCause: "", detectionGap: "", lessonsLearned: "", followUpActions: "" };
  const [base, setBase] = useState<IncidentReview>(incoming);
  const [values, setValues] = useState<IncidentReview>(incoming);
  const completed = [
    values.summary.trim().length >= 20,
    values.customerImpact.trim().length >= 10,
    values.rootCause.trim().length >= 10,
    values.detectionGap.trim().length >= 10,
    values.lessonsLearned.trim().length >= 10,
    values.followUpActions.trim().length >= 10,
  ].filter(Boolean).length;
  const reviewEnabled = incidentStatus === "resolved" || incidentStatus === "closed";
  const isFinal = values.status === "final";
  const hasChanges = values.status !== base.status || values.summary !== base.summary || values.customerImpact !== base.customerImpact || values.rootCause !== base.rootCause || values.detectionGap !== base.detectionGap || values.lessonsLearned !== base.lessonsLearned || values.followUpActions !== base.followUpActions;
  const newerAvailable = (review?.version ?? 0) !== (base.version ?? 0);

  function mergeLatest() {
    setValues((current) => ({
      ...current,
      status: current.status === base.status ? incoming.status : current.status,
      summary: current.summary === base.summary ? incoming.summary : current.summary,
      customerImpact: current.customerImpact === base.customerImpact ? incoming.customerImpact : current.customerImpact,
      rootCause: current.rootCause === base.rootCause ? incoming.rootCause : current.rootCause,
      detectionGap: current.detectionGap === base.detectionGap ? incoming.detectionGap : current.detectionGap,
      lessonsLearned: current.lessonsLearned === base.lessonsLearned ? incoming.lessonsLearned : current.lessonsLearned,
      followUpActions: current.followUpActions === base.followUpActions ? incoming.followUpActions : current.followUpActions,
    }));
    setBase(incoming);
  }

  async function submitReview() {
    const ok = await save({ ...values, id: base.id, version: base.version, owner: base.owner, updatedAt: base.updatedAt });
    if (ok) setBase({ ...values, id: base.id, version: (base.version ?? 0) + 1, owner: base.owner, updatedAt: base.updatedAt });
  }
  return (
    <div id="workspace-panel-review" role="tabpanel" aria-labelledby="workspace-tab-review" className="review-panel">
      <div className="review-heading"><div><p className="eyebrow">POST-INCIDENT REVIEW</p><h3>事後檢討</h3><p>將事件影響、原因、偵測缺口與改善轉成可追蹤記錄。</p></div><div className="review-progress"><strong>{completed}/6</strong><span>必要段落</span></div></div>
      {!canWrite && <div className="form-warning" role="note">您目前以唯讀模式查看事後檢討。</div>}
      {canWrite && !reviewEnabled && <div className="form-warning" role="note">事件確認復原後，才能儲存事後檢討。</div>}
      {newerAvailable && <div className="version-notice review-version-notice" role="alert"><div><strong>事後檢討已有新版本</strong><span>先合併最新版；你改過的段落會保留。</span></div><button className="button secondary compact" type="button" onClick={mergeLatest}>合併最新版</button></div>}
      <form className="review-form" onSubmit={(event) => { event.preventDefault(); void submitReview(); }}>
        <label><span>事件摘要</span><textarea rows={3} minLength={isFinal ? 20 : undefined} maxLength={3000} required={isFinal} readOnly={!canWrite} value={values.summary} onChange={(event) => setValues({ ...values, summary: event.target.value })} placeholder="發生了什麼事，團隊如何復原？" /></label>
        <label><span>影響</span><textarea rows={3} minLength={isFinal ? 10 : undefined} maxLength={3000} required={isFinal} readOnly={!canWrite} value={values.customerImpact} onChange={(event) => setValues({ ...values, customerImpact: event.target.value })} placeholder="哪些使用者、服務或營運目標受到影響？" /></label>
        <label><span>根本原因</span><textarea rows={3} minLength={isFinal ? 10 : undefined} maxLength={3000} required={isFinal} readOnly={!canWrite} value={values.rootCause} onChange={(event) => setValues({ ...values, rootCause: event.target.value })} placeholder="哪個技術或系統條件導致事件？" /></label>
        <label><span>偵測缺口</span><textarea rows={3} minLength={isFinal ? 10 : undefined} maxLength={3000} required={isFinal} readOnly={!canWrite} value={values.detectionGap} onChange={(event) => setValues({ ...values, detectionGap: event.target.value })} placeholder="為什麼未能更早發現或縮小影響？" /></label>
        <label><span>學習與改善方向</span><textarea rows={3} minLength={isFinal ? 10 : undefined} maxLength={3000} required={isFinal} readOnly={!canWrite} value={values.lessonsLearned} onChange={(event) => setValues({ ...values, lessonsLearned: event.target.value })} placeholder="哪些變更可降低再次發生的可能性或影響？" /></label>
        <label><span>後續改善行動</span><textarea rows={3} minLength={isFinal ? 10 : undefined} maxLength={3000} required={isFinal} readOnly={!canWrite} value={values.followUpActions} onChange={(event) => setValues({ ...values, followUpActions: event.target.value })} placeholder="列出具體可指派、有期限且可驗證的改善行動。" /></label>
        {canWrite && <div className="review-actions"><p className="review-save-note">草稿可分段儲存；標記為已完成時，六個段落都必須達到最低內容要求。</p><label><span>文件狀態</span><select value={values.status} onChange={(event) => setValues({ ...values, status: event.target.value as IncidentReview["status"] })}><option value="draft">草稿</option><option value="final">已完成</option></select></label><button className="button primary" type="submit" disabled={pending || !reviewEnabled || !hasChanges || newerAvailable || (isFinal && completed < 6)}>{pending ? "儲存中…" : isFinal ? "完成檢討" : "儲存草稿"}</button></div>}
      </form>
    </div>
  );
}

function ServicesView({ services, openCreate, openEdit, selectIncident, incidents, timeZone }: { services: Service[]; openCreate?: () => void; openEdit?: (service: Service) => void; selectIncident: (id: string) => void; incidents: IncidentSummary[]; timeZone: string }) {
  const [query, setQuery] = useState("");
  const [histories, setHistories] = useState<Record<string, ServiceLifecycleHistory>>({});
  const filtered = services.filter((service) => [service.name, service.key, service.ownerTeam].some((value) => value.toLocaleLowerCase("zh-Hant").includes(query.trim().toLocaleLowerCase("zh-Hant"))));

  async function loadLifecycleHistory(service: Service, cursor: string | null = null, force = false) {
    const current = histories[service.id];
    if (!force && cursor === null && current?.serviceVersion === service.version && (current.status === "loading" || current.status === "ready")) return;
    if (!force && cursor !== null && current?.serviceVersion === service.version && current.loadingMore) return;
    setHistories((previous) => {
      const previousHistory = previous[service.id];
      const sameVersion = previousHistory?.serviceVersion === service.version;
      const events = sameVersion ? previousHistory.events : [];
      return {
        ...previous,
        [service.id]: {
          status: cursor === null && events.length === 0 ? "loading" : "ready",
          serviceVersion: service.version,
          events,
          nextCursor: sameVersion ? previousHistory.nextCursor : null,
          loadingMore: cursor !== null,
        },
      };
    });
    try {
      const cursorQuery = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      const payload = await apiRequest<Record<string, unknown>>(`/api/v1/services/${encodeURIComponent(service.id)}/lifecycle-events${cursorQuery}`);
      if (!Array.isArray(payload.events)) invalidResponse("service.lifecycleEvents");
      if (payload.limit !== 25 || typeof payload.hasMore !== "boolean") invalidResponse("service.lifecycleEvents.pagination");
      if (payload.nextCursor !== null && typeof payload.nextCursor !== "string") invalidResponse("service.lifecycleEvents.nextCursor");
      const nextCursor = payload.nextCursor;
      if ((payload.hasMore === true && !nextCursor) || (payload.hasMore === false && nextCursor !== null)) invalidResponse("service.lifecycleEvents.nextCursor");
      const events = payload.events.map((event) => normalizeServiceLifecycleEvent(event, service.id));
      setHistories((previous) => previous[service.id]?.serviceVersion === service.version ? ({
        ...previous,
        [service.id]: {
          status: "ready",
          serviceVersion: service.version,
          events: [...new Map([...(cursor ? previous[service.id].events : []), ...events].map((event) => [event.id, event])).values()],
          nextCursor,
          loadingMore: false,
        },
      }) : previous);
    } catch (error) {
      setHistories((previous) => previous[service.id]?.serviceVersion === service.version ? ({
        ...previous,
        [service.id]: {
          status: "error",
          serviceVersion: service.version,
          events: previous[service.id]?.events ?? [],
          nextCursor: previous[service.id]?.nextCursor ?? null,
          loadingMore: false,
          failedCursor: cursor,
          error: getErrorMessage(error),
        },
      }) : previous);
    }
  }

  return (
    <div className="view-stack">
      <PageHeader eyebrow="SERVICE CATALOG" title="服務目錄" description="將服務責任、SLO、操作手冊與目前事件整理在同一營運視圖。">{openCreate && <button className="button primary" type="button" onClick={openCreate}><Icon name="plus" />新增服務</button>}</PageHeader>
      <section className="panel catalog-panel" aria-labelledby="service-catalog-title">
        <div className="catalog-toolbar"><div><h2 id="service-catalog-title">所有服務</h2><p>{services.length} 項已登錄服務</p></div><label className="search-field catalog-search"><span className="sr-only">搜尋服務</span><Icon name="search" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜尋服務或團隊" /></label></div>
        {filtered.length > 0 ? (
          <div className="table-scroll" role="region" aria-label="服務目錄，可水平捲動" tabIndex={0}>
            <table className="data-table service-table">
              <caption className="sr-only">服務責任、生命週期、SLO、操作手冊與事件狀態</caption>
              <thead><tr><th scope="col">服務</th><th scope="col">生命週期</th><th scope="col">監控健康</th><th scope="col">層級</th><th scope="col">責任</th><th scope="col">SLO</th><th scope="col">未結案事件</th><th scope="col">操作手冊</th>{openEdit && <th scope="col"><span className="sr-only">管理</span></th>}</tr></thead>
              <tbody>{filtered.map((service) => {
                const incident = incidents.find((item) => item.serviceId === service.id && !["closed", "cancelled"].includes(item.status));
                return <tr key={service.id}>
                  <th scope="row"><strong>{service.name}</strong><small>{service.key}{service.description ? ` · ${service.description}` : ""}</small></th>
                  <td className="service-lifecycle-cell">
                    <span className={`lifecycle-badge ${service.lifecycleStatus}`}>{service.lifecycleStatus === "active" ? "使用中" : "已淘汰"}</span>
                    {service.statusChangeReason && <div className="lifecycle-latest" aria-label="最近一次生命週期變更">
                      <strong>{service.statusChangeReason}</strong>
                      <span>{service.statusChangedByName ?? "操作者未列出"}{service.statusChangedAt ? ` · ${formatLongTimestamp(service.statusChangedAt, timeZone)}` : ""}</span>
                      {service.statusChangeRequestId && <code title={service.statusChangeRequestId}>Request ID: {service.statusChangeRequestId}</code>}
                    </div>}
                    {!service.statusChangeReason && service.lifecycleStatus === "deprecated" && <small className="lifecycle-legacy-note">舊資料未保存淘汰原因</small>}
                    <details key={`${service.id}:${service.version}`} className="lifecycle-event-details" onToggle={(event) => { if (event.currentTarget.open) void loadLifecycleHistory(service); }}>
                      <summary>查看變更歷程</summary>
                      <div className="lifecycle-event-panel" aria-live="polite">
                        {histories[service.id]?.status === "loading" && <p role="status"><span className="spinner" />正在載入變更歷程…</p>}
                        {histories[service.id]?.status === "error" && <div className="lifecycle-event-error" role="alert"><span>{histories[service.id].error?.message ?? "無法載入變更歷程。"}</span>{histories[service.id].error?.requestId && <code>Request ID: {histories[service.id].error?.requestId}</code>}<button className="text-button" type="button" onClick={() => void loadLifecycleHistory(service, histories[service.id].failedCursor ?? null, true)}>重試</button></div>}
                        {histories[service.id]?.status === "ready" && histories[service.id].events.length === 0 && <p>尚無生命週期變更記錄。</p>}
                        {histories[service.id]?.events.length > 0 && <ol className="lifecycle-event-list">{histories[service.id].events.map((event) => <li key={event.id}>
                          <div><strong>{event.fromStatus === "active" ? "使用中" : "已淘汰"} → {event.toStatus === "active" ? "使用中" : "已淘汰"}</strong><time dateTime={event.changedAt}>{formatLongTimestamp(event.changedAt, timeZone)}</time></div>
                          <p>{event.reason}</p>
                          <span>{event.actor.displayName}</span>
                          <code title={event.requestId}>Request ID: {event.requestId}</code>
                        </li>)}</ol>}
                        {histories[service.id]?.loadingMore && <p role="status"><span className="spinner" />正在載入更早的記錄…</p>}
                        {histories[service.id]?.status === "ready" && histories[service.id].nextCursor && !histories[service.id].loadingMore && <button className="button secondary compact lifecycle-load-more" type="button" onClick={() => void loadLifecycleHistory(service, histories[service.id].nextCursor)}>載入更早記錄</button>}
                        {histories[service.id]?.status === "ready" && histories[service.id].events.length > 0 && !histories[service.id].nextCursor && <small>已載入全部生命週期變更；每次要求最多讀取 25 筆。</small>}
                      </div>
                    </details>
                  </td>
                  <td><span className={`service-status ${service.status}`}><ServiceStatusDot status={service.status} />{SERVICE_STATUS_LABEL[service.status]}</span><small>{service.telemetryStatus === "unavailable" ? "沒有可用遙測" : "監控已有資料"}</small></td>
                  <td>{service.tier.replace("tier_", "Tier ")}</td>
                  <td><strong>{service.ownerTeam}</strong><small>{service.ownerName || "未列出個人負責人"}</small></td>
                  <td>{service.sloTarget == null ? "未設定" : <><strong>{service.telemetryStatus === "unavailable" || service.sloAttainment == null ? "尚無樣本" : `${service.sloAttainment.toFixed(3)}%`}</strong><small>目標 {service.sloTarget}%</small></>}</td>
                  <td>{incident ? <button className="text-button" type="button" onClick={() => selectIncident(incident.id)}>{service.activeIncidentCount} · {incident.key}</button> : service.activeIncidentCount}</td>
                  <td>{service.runbookUrl ? <a href={service.runbookUrl} target="_blank" rel="noreferrer">開啟 Runbook <span aria-hidden="true">↗</span></a> : "—"}</td>
                  {openEdit && <td><button className="button ghost compact" type="button" onClick={() => openEdit(service)}>編輯</button></td>}
                </tr>;
              })}</tbody>
            </table>
          </div>
        ) : <EmptyState
          title={services.length === 0 ? "尚未建立服務" : "找不到符合條件的服務"}
          description={services.length === 0 ? "先建立服務責任、SLO 與操作手冊，再開始宣告事件。" : "請調整服務名稱或負責團隊的搜尋條件。"}
          actionLabel={services.length === 0 && openCreate ? "新增服務" : undefined}
          onAction={services.length === 0 ? openCreate : undefined}
        />}
      </section>
    </div>
  );
}

function AuditView({ records, loading, error, retry, timeZone }: { records: AuditRecord[]; loading: boolean; error: { message: string; requestId?: string } | null; retry: () => void; timeZone: string }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<AuditRecord["result"] | "all">("all");
  const filtered = records.filter((record) => {
    if (result !== "all" && record.result !== result) return false;
    const needle = query.trim().toLocaleLowerCase("zh-Hant");
    return !needle || [record.actor.displayName, record.action, auditActionLabel(record.action), record.resourceKey, record.reasonCode ?? "", record.requestId ?? ""].some((value) => value.toLocaleLowerCase("zh-Hant").includes(needle));
  });
  return (
    <div className="view-stack">
      <PageHeader eyebrow="AUDIT TRAIL" title="稽核紀錄" description="查閱誰在什麼時間對哪個資源執行了什麼操作，以及伺服器的最終判定。" />
      {error && <ErrorBanner title="無法取得完整稽核紀錄" error={error} onRetry={retry} />}
      <section className="panel catalog-panel" aria-labelledby="audit-table-title">
        <div className="catalog-toolbar">
          <div><h2 id="audit-table-title">操作紀錄</h2><p>最新 {records.length} 筆；目前篩選後顯示 {filtered.length} 筆</p></div>
          <div className="audit-filters">
            <label className="search-field"><span className="sr-only">搜尋稽核紀錄</span><Icon name="search" /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="操作者、動作、原因或 request ID" /></label>
            <label><span className="sr-only">結果</span><select value={result} onChange={(event) => setResult(event.target.value as AuditRecord["result"] | "all")}><option value="all">全部結果</option><option value="success">成功</option><option value="failure">失敗</option><option value="denied">已拒絕</option></select></label>
          </div>
        </div>
        {loading && records.length === 0 ? <div className="workspace-loading" role="status"><span className="spinner" />正在載入稽核紀錄…</div> : filtered.length > 0 ? (
          <div className="table-scroll" role="region" aria-label="最新稽核紀錄，可水平捲動" tabIndex={0}>
            <table className="data-table audit-table">
              <caption className="sr-only">使用者操作、資源、結果、原因與請求編號</caption>
              <thead><tr><th scope="col">時間</th><th scope="col">操作者</th><th scope="col">操作</th><th scope="col">資源</th><th scope="col">結果</th><th scope="col">Request ID</th><th scope="col">安全細節</th></tr></thead>
              <tbody>{filtered.map((record) => <tr key={record.id}>
                <td><time dateTime={record.occurredAt}>{formatLongTimestamp(record.occurredAt, timeZone)}</time></td>
                <td><strong>{record.actor.displayName}</strong><small>{[
                  record.actor.email,
                  record.actorRole ? ORGANIZATION_ROLE_LABEL[record.actorRole as OrganizationRole] ?? record.actorRole : "",
                ].filter(Boolean).join(" · ") || "身分資料已隱去"}</small></td>
                <td><strong>{auditActionLabel(record.action)}</strong><small><code>{record.action}</code></small></td>
                <td><strong>{auditResourceLabel(record.resourceType)}</strong><small><code>{record.resourceKey}</code></small></td>
                <td><ResultBadge result={record.result} />{record.reasonCode && <small><code>{record.reasonCode}</code></small>}</td>
                <td><code>{record.requestId ?? "—"}</code></td>
                <td>{record.details && Object.keys(record.details).length > 0 ? <details className="audit-details"><summary>查看</summary><pre>{JSON.stringify(record.details, null, 2).slice(0, 2000)}</pre></details> : "—"}</td>
              </tr>)}</tbody>
            </table>
          </div>
        ) : <EmptyState title="沒有符合條件的稽核紀錄" description="請放寬搜尋或結果篩選條件。" />}
      </section>
    </div>
  );
}

function operatorOrganizationRole(operator: Operator): OrganizationRole {
  return operator.roles.find((candidate): candidate is OrganizationRole => candidate in ORGANIZATION_ROLE_LABEL) ?? "observer";
}

function AccessView({ data, identityMode, loading, error, retry, timeZone, canManage, mutationPending, openCreate, openMember }: {
  data: AccessData | null;
  identityMode: InitialIdentity["mode"];
  loading: boolean;
  error: { message: string; requestId?: string } | null;
  retry: () => void;
  timeZone: string;
  canManage: boolean;
  mutationPending: string | null;
  openCreate: () => void;
  openMember: (operator: Operator) => void;
}) {
  function organizationRoleNames(roles: string[]) {
    return roles.map((role) => ORGANIZATION_ROLE_LABEL[role as OrganizationRole] ?? role).join("、") || "—";
  }

  const showPolicies = Boolean(data?.policies?.length);
  const showOperators = Boolean(canManage || data?.permissions?.includes("incident:assign") || data?.operators.length);

  return (
    <div className="view-stack">
      <PageHeader eyebrow="ACCESS CONTROL" title={canManage ? "存取管理" : "存取與權限"} description={canManage ? "管理組織成員，並查閱伺服器端強制執行的存取政策。" : "查閱目前身分與伺服器端強制執行的存取政策。"}>
        {canManage && <button className="button primary" type="button" onClick={openCreate}><Icon name="plus" />新增成員</button>}
      </PageHeader>
      {error && <ErrorBanner title={data ? "存取資料更新失敗，正在顯示最後成功快照" : "無法取得存取資料"} error={error} onRetry={retry} />}
      <div className={`access-grid ${!showPolicies ? "without-policies" : ""}`}>
        <section className="panel current-access-card" aria-labelledby="current-access-title">
          <PanelHeader title="目前身分" eyebrow="CURRENT ACCESS" id="current-access-title" />
          {data ? <><div className="current-actor"><Avatar name={data.actor.displayName} /><div><strong>{data.actor.displayName}</strong><span>{data.actor.email}</span></div></div><dl><div><dt>身分來源</dt><dd>{identityMode === "hosted" ? "組織身分提供者" : "本機開發設定"}</dd></div><div><dt>系統角色</dt><dd>{organizationRoleNames(data.actor.roles)}</dd></div><div><dt>所屬團隊</dt><dd>{data.actor.teamNames?.join("、") || "未列出"}</dd></div></dl><p>前端顯示的角色不是授權依據。伺服器會在每一個高風險操作重新驗證身分、角色、資源與當前版本。</p></> : loading ? <div className="workspace-loading"><span className="spinner" />正在載入身分資料…</div> : <EmptyState compact title="尚無身分資料" description="伺服器未傳回存取資訊。" />}
        </section>
        {showPolicies && <section className="panel policy-card" aria-labelledby="policy-title">
          <PanelHeader title="強制政策" eyebrow="ENFORCEMENT" id="policy-title" />
          <div className="policy-list">{data?.policies?.map((policy) => <article key={policy.id}><span className={`policy-state ${policy.status}`}><Icon name={policy.status === "enforced" ? "check" : "close"} size={15} /></span><div><strong>{policy.name}</strong><p>{policy.description}</p></div><b>{policy.status === "enforced" ? "已強制" : "未啟用"}</b></article>)}</div>
        </section>}
        {showOperators && <section className="panel operator-panel" aria-labelledby="operator-title">
          <PanelHeader title="組織成員" eyebrow="OPERATORS" id="operator-title">
            {canManage && <button className="button secondary compact" type="button" onClick={openCreate}><Icon name="plus" />新增成員</button>}
          </PanelHeader>
          {(data?.operators.length ?? 0) > 0 ? (
            <div className="table-scroll" role="region" aria-label="組織成員與存取狀態，可水平捲動" tabIndex={0}>
              <table className="data-table member-table">
                <caption className="sr-only">組織成員、角色與帳號狀態</caption>
                <thead><tr><th scope="col">成員</th><th scope="col">團隊</th><th scope="col">系統角色</th><th scope="col">狀態</th><th scope="col">最近活動時間</th>{canManage && <th scope="col"><span className="sr-only">操作</span></th>}</tr></thead>
                <tbody>{data?.operators.map((operator) => {
                  const role = operatorOrganizationRole(operator);
                  const status = operator.status ?? "active";
                  const pending = mutationPending === `member-${operator.membershipId}`;
                  return (
                    <tr key={operator.membershipId ?? operator.id}>
                      <th scope="row"><strong>{operator.displayName}</strong><small>{operator.email}</small></th>
                      <td>{operator.teamNames?.join("、") || "—"}</td>
                      <td>{ORGANIZATION_ROLE_LABEL[role]}</td>
                      <td><span className={`operator-status ${status}`}>{status === "suspended" ? "已停用" : "啟用中"}</span></td>
                      <td>{pending ? <span className="member-pending" role="status"><span className="spinner" />更新中</span> : formatTimestamp(operator.lastSeenAt, timeZone)}</td>
                      {canManage && <td>{operator.membershipId && !pending ? <button className="button ghost compact" type="button" onClick={() => openMember(operator)}>管理存取</button> : null}</td>}
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          ) : <EmptyState compact title="尚無成員資料" description="建立第一位組織成員，以便指派事件責任與存取權限。" actionLabel="新增成員" onAction={canManage ? openCreate : undefined} />}
        </section>}
      </div>
    </div>
  );
}

function DeclareIncidentDialog({ open, services, pending, error, onClose, onSubmit }: { open: boolean; services: Service[]; pending: boolean; error: DisplayError | null; onClose: () => void; onSubmit: (values: { title: string; serviceId: string; severity: Severity; environment: IncidentEnvironment; impact: string }) => Promise<boolean> }) {
  const [title, setTitle] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [severity, setSeverity] = useState<Severity>("SEV2");
  const [environment, setEnvironment] = useState<IncidentEnvironment>("production");
  const [impact, setImpact] = useState("");
  const activeServices = services.filter((service) => serviceCanAcceptNewIncidents(service.lifecycleStatus));
  const effectiveServiceId = activeServices.some((service) => service.id === serviceId) ? serviceId : "";
  return <Modal open={open} title="宣告事件" description="建立共享事件工作區，並立即開始追蹤處置活動。" onClose={onClose} canClose={!pending}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ title, serviceId: effectiveServiceId, severity, environment, impact }).then((ok) => { if (ok) { setTitle(""); setServiceId(""); setImpact(""); setSeverity("SEV2"); setEnvironment("production"); } }); }}><label><span>事件標題</span><input autoFocus maxLength={140} required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="簡短說明影響中的服務與現象" /></label><div className="form-row"><label><span>受影響服務</span><select required value={effectiveServiceId} onChange={(event) => setServiceId(event.target.value)}><option value="" disabled>選擇服務</option>{activeServices.map((service) => <option value={service.id} key={service.id}>{service.name} · {service.ownerTeam}</option>)}</select></label><label><span>嚴重度</span><select value={severity} onChange={(event) => setSeverity(event.target.value as Severity)}>{Object.entries(SEVERITY_LABEL).map(([value, label]) => <option value={value} key={value}>{value} · {label}</option>)}</select></label></div><label><span>執行環境</span><select value={environment} onChange={(event) => setEnvironment(event.target.value as IncidentEnvironment)}>{Object.entries(ENVIRONMENT_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>已知影響</span><textarea rows={4} maxLength={1000} required value={impact} onChange={(event) => setImpact(event.target.value)} placeholder="受影響的使用者、區域、功能與目前可觀測的程度" /></label>{activeServices.length === 0 && <div className="form-warning" role="status">目前沒有可用於新事件的服務；請先建立或重新啟用服務。</div>}{error && <InlineError error={error} />}<div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={pending || !effectiveServiceId || title.trim().length < 5 || impact.trim().length < 8}>{pending ? "正在宣告…" : "宣告事件"}</button></div></form></Modal>;
}

function CreateServiceDialog({ open, pending, error, onClose, onSubmit }: {
  open: boolean;
  pending: boolean;
  error: { message: string; requestId?: string } | null;
  onClose: () => void;
  onSubmit: (values: ServiceCreateInput) => Promise<boolean>;
}) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ownerTeam, setOwnerTeam] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [tier, setTier] = useState<Service["tier"]>("tier_1");
  const [sloTarget, setSloTarget] = useState("99.9");
  const [runbookUrl, setRunbookUrl] = useState("");
  const slo = Number(sloTarget);
  const keyValid = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(key);

  function reset() {
    setKey("");
    setName("");
    setDescription("");
    setOwnerTeam("");
    setOwnerEmail("");
    setTier("tier_1");
    setSloTarget("99.9");
    setRunbookUrl("");
  }

  return (
    <Modal open={open} title="新增服務" description="登錄服務責任、可靠性目標與操作手冊，作為事件協調的共同基準。" onClose={onClose} canClose={!pending}>
      <form className="modal-form" onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({
          key,
          name: name.trim(),
          description: description.trim(),
          ownerTeam: ownerTeam.trim(),
          ownerEmail: ownerEmail.trim() || undefined,
          tier,
          sloTarget: slo,
          runbookUrl: runbookUrl.trim() || undefined,
        }).then((ok) => { if (ok) reset(); });
      }}>
        <div className="form-row">
          <label><span>服務識別碼</span><input autoFocus required pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" minLength={3} maxLength={64} value={key} onChange={(event) => setKey(event.target.value.toLowerCase().replace(/\s+/g, "-"))} placeholder="identity-service" aria-describedby="service-key-help" /><small id="service-key-help" className="field-help">3–64 個小寫英文字母、數字或連字號；建立後用於 API 與稽核識別。</small></label>
          <label><span>服務名稱</span><input required minLength={2} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="身分驗證服務" /></label>
        </div>
        <label><span>服務說明</span><textarea rows={3} maxLength={600} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="說明服務提供的能力、主要使用者與營運邊界。" /></label>
        <div className="form-row">
          <label><span>負責團隊</span><input required maxLength={120} value={ownerTeam} onChange={(event) => setOwnerTeam(event.target.value)} placeholder="Identity Platform" /></label>
          <label><span>服務負責人信箱（選填）</span><input type="email" maxLength={254} value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="owner@example.com" /></label>
        </div>
        <div className="form-row">
          <label><span>服務層級</span><select value={tier} onChange={(event) => setTier(event.target.value as Service["tier"])}><option value="tier_1">Tier 1 · 組織核心</option><option value="tier_2">Tier 2 · 高關鍵</option><option value="tier_3">Tier 3 · 重要</option><option value="tier_4">Tier 4 · 一般</option></select></label>
          <label><span>SLO 目標（%）</span><input type="number" required min="0.001" max="100" step="0.001" inputMode="decimal" value={sloTarget} onChange={(event) => setSloTarget(event.target.value)} /></label>
        </div>
        <label><span>操作手冊網址（選填）</span><input type="url" pattern="https://.*" maxLength={2048} value={runbookUrl} onChange={(event) => setRunbookUrl(event.target.value)} placeholder="https://runbooks.example.com/identity" /><small className="field-help">僅接受 HTTPS 網址。</small></label>
        {error && <InlineError error={error} />}
        <div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={pending || !keyValid || name.trim().length < 2 || ownerTeam.trim().length === 0 || !Number.isFinite(slo) || slo <= 0 || slo > 100}>{pending ? "建立中…" : "建立服務"}</button></div>
      </form>
    </Modal>
  );
}

function ServiceEditDialog({ open, service, timeZone, pending, error, recoverConflict, onClose, onSubmit }: {
  open: boolean;
  service: Service;
  timeZone: string;
  pending: boolean;
  error: DisplayError | null;
  recoverConflict: () => void;
  onClose: () => void;
  onSubmit: (service: Service, values: ServiceUpdateInput) => Promise<boolean>;
}) {
  const [base, setBase] = useState(service);
  const [name, setName] = useState(service.name);
  const [description, setDescription] = useState(service.description ?? "");
  const [ownerTeam, setOwnerTeam] = useState(service.ownerTeam);
  const [ownerEmail, setOwnerEmail] = useState("");
  const [clearOwner, setClearOwner] = useState(false);
  const [tier, setTier] = useState(service.tier);
  const [sloTarget, setSloTarget] = useState(service.sloTarget?.toString() ?? "99.9");
  const [runbookUrl, setRunbookUrl] = useState(service.runbookUrl ?? "");
  const [status, setStatus] = useState(service.lifecycleStatus);
  const [statusChangeReason, setStatusChangeReason] = useState("");
  const [lifecycleConfirmed, setLifecycleConfirmed] = useState(false);
  const slo = Number(sloTarget);
  const normalizedRunbook = runbookUrl.trim();
  const normalizedStatusChangeReason = statusChangeReason.trim();
  const statusChanged = status !== base.lifecycleStatus;
  const values: ServiceUpdateInput = {};
  if (name.trim() !== base.name) values.name = name.trim();
  if (description.trim() !== (base.description ?? "")) values.description = description.trim();
  if (ownerTeam.trim() !== base.ownerTeam) values.ownerTeam = ownerTeam.trim();
  if (tier !== base.tier) values.tier = tier;
  if (slo !== base.sloTarget) values.sloTarget = slo;
  if (normalizedRunbook !== (base.runbookUrl ?? "")) values.runbookUrl = normalizedRunbook || null;
  if (statusChanged) {
    values.status = status;
    values.statusChangeReason = normalizedStatusChangeReason;
    if (lifecycleConfirmed) values.lifecycleConfirmed = true;
  }
  if (clearOwner) values.ownerEmail = null;
  else if (ownerEmail.trim()) values.ownerEmail = ownerEmail.trim();
  const hasChanges = Object.keys(values).length > 0;
  const runbookValid = !normalizedRunbook || isHttpsUrl(normalizedRunbook);
  const statusChangeReasonValid = !statusChanged || (normalizedStatusChangeReason.length >= 8 && normalizedStatusChangeReason.length <= 1000);
  const newerAvailable = service.version !== base.version;
  const deprecationBlocked = statusChanged && status === "deprecated" && service.activeIncidentCount > 0;

  function mergeLatest() {
    const lifecycleUntouched = status === base.lifecycleStatus;
    setName((current) => current === base.name ? service.name : current);
    setDescription((current) => current === (base.description ?? "") ? service.description ?? "" : current);
    setOwnerTeam((current) => current === base.ownerTeam ? service.ownerTeam : current);
    setTier((current) => current === base.tier ? service.tier : current);
    setSloTarget((current) => current === (base.sloTarget?.toString() ?? "99.9") ? service.sloTarget?.toString() ?? "99.9" : current);
    setRunbookUrl((current) => current === (base.runbookUrl ?? "") ? service.runbookUrl ?? "" : current);
    setStatus((current) => current === base.lifecycleStatus ? service.lifecycleStatus : current);
    if (lifecycleUntouched) setStatusChangeReason("");
    setLifecycleConfirmed(false);
    setBase(service);
  }

  return (
    <Modal open={open} title="編輯服務" description={`${service.key} · 編輯基準版本 ${base.version}`} onClose={onClose} dismissible={false} canClose={!pending}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void onSubmit(base, values); }}>
        <div className="form-row">
          <label><span>服務識別碼</span><input value={service.key.toLowerCase()} readOnly aria-readonly="true" /><small className="field-help">識別碼建立後不可變更。</small></label>
          <label><span>生命週期</span><select value={status} onChange={(event) => { setStatus(event.target.value as Service["lifecycleStatus"]); setStatusChangeReason(""); setLifecycleConfirmed(false); }}><option value="active">使用中</option><option value="deprecated" disabled={service.lifecycleStatus === "active" && service.activeIncidentCount > 0}>已淘汰</option></select></label>
        </div>
        <label><span>服務名稱</span><input autoFocus required minLength={2} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>服務說明</span><textarea rows={3} maxLength={600} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <div className="form-row">
          <label><span>負責團隊</span><input required maxLength={120} value={ownerTeam} onChange={(event) => setOwnerTeam(event.target.value)} /></label>
          <label><span>更換負責人信箱（選填）</span><input type="email" maxLength={254} disabled={clearOwner} value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} placeholder="owner@example.com" /><small className="field-help">留白會保留目前負責人。</small></label>
        </div>
        <label className="check-field"><input type="checkbox" checked={clearOwner} onChange={(event) => setClearOwner(event.target.checked)} /><span>移除目前的個人負責人</span></label>
        <div className="form-row">
          <label><span>服務層級</span><select value={tier} onChange={(event) => setTier(event.target.value as Service["tier"])}><option value="tier_1">Tier 1 · 組織核心</option><option value="tier_2">Tier 2 · 高關鍵</option><option value="tier_3">Tier 3 · 重要</option><option value="tier_4">Tier 4 · 一般</option></select></label>
          <label><span>SLO 目標（%）</span><input type="number" required min="0.001" max="100" step="0.001" inputMode="decimal" value={sloTarget} onChange={(event) => setSloTarget(event.target.value)} /></label>
        </div>
        <label><span>操作手冊網址</span><input type="url" pattern="https://.*" maxLength={2048} value={runbookUrl} onChange={(event) => setRunbookUrl(event.target.value)} placeholder="https://runbooks.example.com/service" /><small className="field-help">僅接受 HTTPS 網址；清空可移除既有連結。</small></label>
        {service.activeIncidentCount > 0 && <div className="form-warning" role={deprecationBlocked ? "alert" : "note"}>{deprecationBlocked ? `無法淘汰：最新版仍有 ${service.activeIncidentCount} 件未結案事件。請先結案或取消事件，再重新提交。` : `仍有 ${service.activeIncidentCount} 件未結案事件，須先結案或取消，才能將服務標記為已淘汰。`}</div>}
        {!statusChanged && base.statusChangeReason && <div className="integration-notice lifecycle-history" role="note"><strong>最近一次生命週期變更</strong><div><span>{base.statusChangeReason}</span><small>{base.statusChangedByName ?? "操作者未列出"}{base.statusChangedAt ? ` · ${formatLongTimestamp(base.statusChangedAt, timeZone)}` : ""}</small></div></div>}
        {!statusChanged && base.lifecycleStatus === "deprecated" && !base.statusChangeReason && <div className="form-warning" role="note"><strong>舊資料未保存淘汰原因</strong><span>此服務在生命週期理由功能上線前已淘汰；系統不會替歷史決策補寫不存在的理由。</span></div>}
        {statusChanged && <section className="lifecycle-confirmation" aria-labelledby="service-lifecycle-change-title">
          <div className="form-section-heading"><strong id="service-lifecycle-change-title">{status === "deprecated" ? "確認淘汰服務" : "確認重新啟用服務"}</strong><span>{status === "deprecated" ? "停止用於新事件，但保留歷史記錄。" : "恢復用於新事件。"}</span></div>
          <label><span>變更原因</span><textarea required minLength={8} maxLength={1000} rows={3} value={statusChangeReason} onChange={(event) => setStatusChangeReason(event.target.value)} placeholder={status === "deprecated" ? "說明停止使用的原因、替代方案與已處理的風險。" : "說明重新啟用前完成的驗證、責任與操作準備。"} /><small className="field-help">8–1000 字；原因、操作者、時間與 Request ID 會保存在不可覆寫的生命週期歷程中。</small></label>
          <label className="check-field"><input type="checkbox" checked={lifecycleConfirmed} onChange={(event) => setLifecycleConfirmed(event.target.checked)} /><span>{status === "deprecated" ? "我已確認此服務沒有未結案事件，且不再用於宣告新事件。" : "我已確認重新啟用後的責任歸屬與事件應變準備。"}</span></label>
        </section>}
        {newerAvailable && <div className="version-notice" role="alert"><div><strong>服務目錄已有新版本</strong><span>合併後會保留你改過的欄位，未改欄位採用最新內容。</span></div><button className="button secondary compact" type="button" onClick={mergeLatest}>合併最新版</button></div>}
        {error && <InlineError error={error} onRecover={error.code === "VERSION_CONFLICT" ? recoverConflict : undefined} />}
        <div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={onClose}>取消</button><button className={`button ${statusChanged && status === "deprecated" ? "danger" : "primary"}`} type="submit" disabled={pending || !hasChanges || newerAvailable || deprecationBlocked || name.trim().length < 2 || ownerTeam.trim().length === 0 || !Number.isFinite(slo) || slo <= 0 || slo > 100 || !runbookValid || !statusChangeReasonValid || (statusChanged && !lifecycleConfirmed)}>{pending ? "儲存中…" : statusChanged ? status === "deprecated" ? "確認淘汰服務" : "確認重新啟用" : "儲存服務"}</button></div>
      </form>
    </Modal>
  );
}

function IncidentOverviewDialog({ open, incident, canEditImpact, pending, error, recoverConflict, onClose, onSubmit }: {
  open: boolean;
  incident: IncidentDetail;
  canEditImpact: boolean;
  pending: boolean;
  error: DisplayError | null;
  recoverConflict: () => void;
  onClose: () => void;
  onSubmit: (values: Partial<IncidentOverviewInput>, expectedVersion: number) => Promise<boolean>;
}) {
  const incomingValues: IncidentOverviewInput = {
    impactSummary: incident.impact ?? "",
    currentHypothesis: incident.currentHypothesis ?? "",
    currentMitigation: incident.currentMitigation ?? "",
    verificationCriteria: incident.verificationCriteria ?? "",
  };
  const [base, setBase] = useState(() => ({ version: incident.version, values: incomingValues }));
  const [values, setValues] = useState<IncidentOverviewInput>(incomingValues);
  const changes: Partial<IncidentOverviewInput> = {};
  if (canEditImpact && values.impactSummary.trim() !== base.values.impactSummary.trim()) changes.impactSummary = values.impactSummary.trim();
  if (values.currentHypothesis.trim() !== base.values.currentHypothesis.trim()) changes.currentHypothesis = values.currentHypothesis.trim();
  if (values.currentMitigation.trim() !== base.values.currentMitigation.trim()) changes.currentMitigation = values.currentMitigation.trim();
  if (values.verificationCriteria.trim() !== base.values.verificationCriteria.trim()) changes.verificationCriteria = values.verificationCriteria.trim();
  const hasChanges = Object.keys(changes).length > 0;
  const newerAvailable = incident.version !== base.version;

  function mergeLatest() {
    setValues((current) => ({
      impactSummary: current.impactSummary === base.values.impactSummary ? incomingValues.impactSummary : current.impactSummary,
      currentHypothesis: current.currentHypothesis === base.values.currentHypothesis ? incomingValues.currentHypothesis : current.currentHypothesis,
      currentMitigation: current.currentMitigation === base.values.currentMitigation ? incomingValues.currentMitigation : current.currentMitigation,
      verificationCriteria: current.verificationCriteria === base.values.verificationCriteria ? incomingValues.verificationCriteria : current.verificationCriteria,
    }));
    setBase({ version: incident.version, values: incomingValues });
  }

  function close() {
    setBase({ version: incident.version, values: incomingValues });
    setValues(incomingValues);
    onClose();
  }

  return (
    <Modal open={open} title="更新事件總覽" description={`${incident.key} · 維護目前已知影響、調查方向、處置與復原判定。`} onClose={close} dismissible={false} canClose={!pending}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void onSubmit(changes, base.version); }}>
        <label><span>目前影響</span><textarea autoFocus={canEditImpact} rows={3} maxLength={1200} readOnly={!canEditImpact} value={values.impactSummary} onChange={(event) => setValues({ ...values, impactSummary: event.target.value })} placeholder="受影響的使用者、功能、區域與可觀測程度" />{!canEditImpact && <small className="field-help">影響範圍由事件指揮官維護；你仍可更新其餘調查資訊。</small>}</label>
        <label><span>目前判斷</span><textarea autoFocus={!canEditImpact} rows={3} maxLength={1600} value={values.currentHypothesis} onChange={(event) => setValues({ ...values, currentHypothesis: event.target.value })} placeholder="目前最可能的原因，以及支持或反駁這項判斷的觀測結果" /></label>
        <label><span>目前處置</span><textarea rows={3} maxLength={1600} value={values.currentMitigation} onChange={(event) => setValues({ ...values, currentMitigation: event.target.value })} placeholder="正在執行或已完成的處置，以及預期降低的影響" /></label>
        <label><span>復原判定條件</span><textarea rows={3} maxLength={1600} value={values.verificationCriteria} onChange={(event) => setValues({ ...values, verificationCriteria: event.target.value })} placeholder="哪些服務指標與使用者流程恢復到何種程度，才能判定事件已解決" /></label>
        {newerAvailable && <div className="version-notice" role="alert"><div><strong>其他人已更新事件總覽</strong><span>先合併最新版；你改過的欄位會保留，未改欄位會採用伺服器內容。</span></div><button className="button secondary compact" type="button" onClick={mergeLatest}>合併最新版</button></div>}
        {error && <InlineError error={error} onRecover={error.code === "VERSION_CONFLICT" ? recoverConflict : undefined} />}
        <div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={close}>取消</button><button className="button primary" type="submit" disabled={pending || !hasChanges || newerAvailable}>{pending ? "儲存中…" : "儲存更新"}</button></div>
      </form>
    </Modal>
  );
}

function AssignmentDialog({ open, operators, responders, pending, error, onClose, onSubmit, onRevoke }: {
  open: boolean;
  operators: Operator[];
  responders: IncidentDetail["responders"];
  pending: string | null;
  error: { message: string; requestId?: string } | null;
  onClose: () => void;
  onSubmit: (values: { userId: string; incidentRole: IncidentRole }) => Promise<boolean>;
  onRevoke: (assignmentId: string, replacementUserId?: string) => Promise<boolean>;
}) {
  const activeOperators = operators.filter((operator) => operator.status !== "suspended");
  const [userId, setUserId] = useState("");
  const [incidentRole, setIncidentRole] = useState<IncidentRole>("responder");
  const [revokeTargetId, setRevokeTargetId] = useState<string | null>(null);
  const [replacementUserId, setReplacementUserId] = useState("");
  const selectedOperator = activeOperators.find((operator) => operator.id === userId);
  const selectedRoleCompatible = Boolean(
    selectedOperator?.roles.some((role) => (
      isOrganizationRole(role) && organizationRoleCanHoldIncidentRole(role, incidentRole)
    )),
  );
  const duplicate = responders.some((responder) => responder.id === userId && responder.incidentRole === incidentRole);
  const revokeTarget = responders.find((responder) => responder.assignmentId === revokeTargetId) ?? null;
  const commanderCount = responders.filter((responder) => responder.incidentRole === "incident_commander").length;
  const replacementRequired = revokeTarget?.incidentRole === "incident_commander" && commanderCount === 1;
  const commanderCandidates = activeOperators.filter((operator) => (
    operator.id !== revokeTarget?.id && operator.roles.some((role) => (
      isOrganizationRole(role) && organizationRoleCanHoldIncidentRole(role, "incident_commander")
    ))
  ));
  const adding = pending === "incident-assignment";
  const revoking = Boolean(revokeTarget && pending === `assignment-revoke-${revokeTarget.assignmentId}`);

  function close() {
    setRevokeTargetId(null);
    setReplacementUserId("");
    onClose();
  }

  return (
    <Modal open={open} title="管理事件角色" description="新增或撤銷事件層級的責任；撤銷最後一位指揮官時必須同時完成交接。" onClose={close} dismissible={false} canClose={!pending}>
      <form className="modal-form assignment-dialog-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ userId, incidentRole }); }}>
        <div className="form-section-heading"><strong>新增指派</strong><span>組織角色仍由存取管理政策控制。</span></div>
        <label><span>組織成員</span><select autoFocus required value={userId} onChange={(event) => setUserId(event.target.value)}><option value="" disabled>選擇成員</option>{activeOperators.map((operator) => <option key={operator.id} value={operator.id}>{operator.displayName} · {operator.email}</option>)}</select></label>
        <label><span>事件角色</span><select value={incidentRole} onChange={(event) => setIncidentRole(event.target.value as IncidentRole)}>{Object.entries(INCIDENT_ROLE_LABEL).map(([value, label]) => <option key={value} value={value} disabled={selectedOperator ? !selectedOperator.roles.some((role) => isOrganizationRole(role) && organizationRoleCanHoldIncidentRole(role, value as IncidentRole)) : false}>{label}</option>)}</select><small className="field-help">可選角色依成員的組織權限顯示；事件指派只代表本次事件責任，不會提高組織權限。</small></label>
        {activeOperators.length === 0 && <div className="form-warning" role="status">目前沒有可指派的啟用中成員。</div>}
        {duplicate && <div className="form-warning" role="status">這位成員已具備相同的事件角色。</div>}
        {selectedOperator && !selectedRoleCompatible && <div className="form-warning" role="status">所選成員的組織角色不允許擔任這個事件角色。</div>}
        <div className="assignment-create-action"><button className="button primary compact" type="submit" disabled={Boolean(pending) || !userId || duplicate || !selectedRoleCompatible}>{adding ? "指派中…" : "確認指派"}</button></div>
        <section className="assignment-list" aria-labelledby="active-assignment-title">
          <div className="form-section-heading"><strong id="active-assignment-title">目前指派</strong><span>{responders.length} 個啟用中的事件角色</span></div>
          {responders.map((responder) => <article key={responder.assignmentId}><Avatar name={responder.displayName} small /><div><strong>{responder.displayName}</strong><span>{responder.role}</span></div><button className="button ghost compact" type="button" disabled={Boolean(pending)} aria-label={`撤銷 ${responder.displayName} 的${responder.role}`} onClick={() => { setRevokeTargetId(responder.assignmentId); setReplacementUserId(""); }}>撤銷</button></article>)}
          {responders.length === 0 && <p className="muted-copy">目前沒有啟用中的事件角色。</p>}
        </section>
        {revokeTarget && <section className="assignment-revoke-panel" aria-labelledby="revoke-assignment-title"><div className="form-section-heading"><strong id="revoke-assignment-title">確認撤銷</strong><span>{revokeTarget.displayName} · {revokeTarget.role}</span></div>{revokeTarget.incidentRole === "incident_commander" && <label><span>{replacementRequired ? "接任指揮官" : "接任指揮官（選填）"}</span><select required={replacementRequired} value={replacementUserId} onChange={(event) => setReplacementUserId(event.target.value)}><option value="">{replacementRequired ? "選擇接任者" : "不指定接任者"}</option>{commanderCandidates.map((operator) => <option key={operator.id} value={operator.id}>{operator.displayName} · {ORGANIZATION_ROLE_LABEL[(operator.roles[0] as OrganizationRole)] ?? operator.roles[0]}</option>)}</select><small className="field-help">交接與撤銷會由伺服器在同一筆交易完成，不會留下無指揮官的中間狀態。</small></label>}{replacementRequired && commanderCandidates.length === 0 && <div className="form-warning" role="alert">目前沒有符合資格的接任者。請先在存取管理加入系統管理員或事件指揮者。</div>}<div className="modal-actions"><button className="button ghost" type="button" disabled={Boolean(pending)} onClick={() => { setRevokeTargetId(null); setReplacementUserId(""); }}>保留指派</button><button className="button danger" type="button" disabled={Boolean(pending) || (replacementRequired && !replacementUserId)} onClick={() => void onRevoke(revokeTarget.assignmentId, replacementUserId || undefined)}>{revoking ? "撤銷中…" : replacementRequired ? "交接並撤銷" : "確認撤銷"}</button></div></section>}
        {error && <InlineError error={error} />}
        <div className="modal-actions"><button className="button ghost" type="button" disabled={Boolean(pending)} onClick={close}>關閉</button></div>
      </form>
    </Modal>
  );
}

function CommunicationEditorDialog({ open, communication, timeZone, pending, error, recoverConflict, onClose, onSubmit }: {
  open: boolean;
  communication: IncidentCommunication | null;
  timeZone: string;
  pending: boolean;
  error: DisplayError | null;
  recoverConflict: () => void;
  onClose: () => void;
  onSubmit: (values: CommunicationDraftInput, existing: IncidentCommunication | null, expectedVersion: number | null) => Promise<boolean>;
}) {
  const [base, setBase] = useState(communication);
  const [audience, setAudience] = useState<CommunicationAudience>(communication?.audience ?? "internal");
  const [message, setMessage] = useState(communication?.message ?? "");
  const [components, setComponents] = useState(communication?.affectedComponents.join("\n") ?? "");
  const [nextUpdateAt, setNextUpdateAt] = useState(() => toZonedDateTimeInput(communication?.nextUpdateAt, timeZone));
  const [openedAt] = useState(() => Date.now());
  const affectedComponents = [...new Map(components.split(/[\n,]/).map((item) => item.trim()).filter(Boolean).map((item) => [item.toLocaleLowerCase("zh-Hant"), item])).values()];
  const componentTooLong = affectedComponents.some((component) => component.length > 120);
  const nextUpdateDate = nextUpdateAt ? parseZonedDateTimeInput(nextUpdateAt, timeZone) : null;
  const nextUpdateValid = !nextUpdateAt || Boolean(nextUpdateDate && nextUpdateDate.getTime() > openedAt);
  const finalMessage = /^\[final\](?:\s|$)/i.test(message);
  const externalAudience = audience !== "internal";
  const baseNextUpdateAt = toZonedDateTimeInput(base?.nextUpdateAt, timeZone);
  const hasChanges = base
    ? audience !== base.audience || message.trim() !== base.message || components.trim() !== base.affectedComponents.join("\n") || nextUpdateAt !== baseNextUpdateAt
    : message.trim().length >= 10;
  const newerAvailable = Boolean(base && communication && communication.version !== base.version);

  function mergeLatest() {
    if (!base || !communication) return;
    const incomingNextUpdate = toZonedDateTimeInput(communication.nextUpdateAt, timeZone);
    setAudience((current) => current === base.audience ? communication.audience : current);
    setMessage((current) => current === base.message ? communication.message : current);
    setComponents((current) => current === base.affectedComponents.join("\n") ? communication.affectedComponents.join("\n") : current);
    setNextUpdateAt((current) => current === baseNextUpdateAt ? incomingNextUpdate : current);
    setBase(communication);
  }

  return <Modal open={open} title={base ? "編輯通訊草稿" : "建立通訊草稿"} description={base ? `編輯基準版本 ${base.version}；核准與發布是分開且可稽核的操作。` : "先保存可修改的草稿；核准與發布是分開且可稽核的操作。"} onClose={onClose} dismissible={false} canClose={!pending}>
    <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ audience, message: message.trim(), affectedComponents, nextUpdateAt: nextUpdateDate ? nextUpdateDate.toISOString() : null }, base, base?.version ?? null); }}>
      <label><span>受眾</span><select value={audience} onChange={(event) => setAudience(event.target.value as CommunicationAudience)}>{Object.entries(COMMUNICATION_AUDIENCE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label><span>訊息內容</span><textarea autoFocus rows={8} minLength={10} maxLength={5000} required value={message} onChange={(event) => setMessage(event.target.value)} placeholder="說明已確認的影響、目前處置、使用者可採取的行動，以及何時會再次更新。" /><small className="field-help">只寫已確認資訊。最終公告必須從第一個字元開始標記 [FINAL]。</small></label>
      <label><span>受影響元件（選填）</span><textarea rows={3} maxLength={3600} value={components} onChange={(event) => setComponents(event.target.value)} placeholder={"每行一項，例如：\n登入 API\n區域閘道"} /><small className="field-help">最多 30 項；可用換行或逗號分隔。</small></label>
      <label><span>下一次更新時間（{timeZone}，選填）</span><input type="datetime-local" value={nextUpdateAt} onChange={(event) => setNextUpdateAt(event.target.value)} /><small className="field-help">利害關係人與公開訊息在核准前，必須安排未來更新時間；以 [FINAL] 開頭的最終公告除外。</small></label>
      {!nextUpdateValid && <div className="form-warning" role="alert">下一次更新時間必須是 {timeZone} 中存在、且晚於現在的時間。</div>}
      {affectedComponents.length > 30 && <div className="form-warning" role="alert">受影響元件最多 30 項，目前有 {affectedComponents.length} 項。</div>}
      {componentTooLong && <div className="form-warning" role="alert">每個受影響元件名稱最多 120 個字元。</div>}
      {externalAudience && !nextUpdateAt && !finalMessage && <div className="form-warning" role="note">可以先儲存草稿；核准前必須安排未來更新時間，或將最終公告從第一個字元開始標記為 [FINAL]。</div>}
      {newerAvailable && <div className="version-notice" role="alert"><div><strong>通訊草稿已有新版本</strong><span>先合併最新版；你改過的內容會保留，未改內容會採用伺服器版本。</span></div><button className="button secondary compact" type="button" onClick={mergeLatest}>合併最新版</button></div>}
      {error && <InlineError error={error} onRecover={error.code === "VERSION_CONFLICT" ? recoverConflict : undefined} />}
      <div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={pending || !hasChanges || newerAvailable || message.trim().length < 10 || affectedComponents.length > 30 || componentTooLong || !nextUpdateValid}>{pending ? "儲存中…" : "儲存草稿"}</button></div>
    </form>
  </Modal>;
}

function CommunicationActionDialog({ open, action, communication, incident, timeZone, pending, error, recoverConflict, onClose, onConfirm }: {
  open: boolean;
  action: "review" | "publish";
  communication: IncidentCommunication;
  incident: IncidentSummary | IncidentDetail | null;
  timeZone: string;
  pending: boolean;
  error: DisplayError | null;
  recoverConflict: () => void;
  onClose: () => void;
  onConfirm: (communication: IncidentCommunication, action: "review" | "publish") => Promise<boolean>;
}) {
  const [openedAt] = useState(() => Date.now());
  const terminalIncident = Boolean(incident && ["resolved", "closed", "cancelled"].includes(incident.status));
  const finalMessage = /^\[final\](?:\s|$)/i.test(communication.message);
  const nextUpdate = safeDate(communication.nextUpdateAt);
  const scheduleValid = communication.audience === "internal" || finalMessage || Boolean(nextUpdate && nextUpdate.getTime() > openedAt);
  const blocked = (action === "publish" && terminalIncident) || !scheduleValid;
  return <Modal open={open} title={action === "review" ? "核准通訊草稿" : "標記通訊為已發布"} description={action === "review" ? "確認內容、受眾與後續更新安排後再核准。" : "這會建立不可修改的發布紀錄與稽核事件。"} onClose={onClose} dismissible={false} canClose={!pending}>
    <div className="modal-form communication-confirmation">
      <dl><div><dt>受眾</dt><dd>{COMMUNICATION_AUDIENCE_LABEL[communication.audience]}</dd></div><div><dt>狀態</dt><dd>{COMMUNICATION_STATUS_LABEL[communication.status]}</dd></div><div><dt>下一次更新</dt><dd>{communication.nextUpdateAt ? formatLongTimestamp(communication.nextUpdateAt, timeZone) : finalMessage ? "最終公告" : "未安排"}</dd></div></dl>
      <blockquote tabIndex={0} aria-label="待確認的通訊內容，可捲動">{communication.message}</blockquote>
      {action === "publish" && <div className="integration-notice" role="note"><strong>尚未連接外部傳送</strong><span>確認後只會鎖定這個版本並標記發布，不會自動寄信或更新第三方狀態頁。</span></div>}
      {terminalIncident && action === "publish" && <div className="form-warning" role="alert">事件已解決、結案或取消，系統不允許再發布通訊。</div>}
      {!scheduleValid && <div className="form-warning" role="alert">對外訊息必須在核准前安排未來更新時間，或從第一個字元開始標記 [FINAL]。</div>}
      {error && <InlineError error={error} onRecover={error.code === "VERSION_CONFLICT" ? recoverConflict : undefined} />}
      <div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={onClose}>取消</button><button className="button primary" type="button" disabled={pending || blocked} onClick={() => void onConfirm(communication, action)}>{pending ? "處理中…" : action === "review" ? "確認核准" : "確認並標記發布"}</button></div>
    </div>
  </Modal>;
}

function MemberCreateDialog({ open, pending, error, onClose, onSubmit }: {
  open: boolean;
  pending: boolean;
  error: { message: string; requestId?: string } | null;
  onClose: () => void;
  onSubmit: (values: MemberCreateInput) => Promise<boolean>;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<OrganizationRole>("observer");

  function reset() {
    setEmail("");
    setDisplayName("");
    setRole("observer");
  }

  return (
    <Modal open={open} title="新增組織成員" description="建立可稽核的成員身分與初始角色；後續可在成員清單調整角色或停用帳號。" onClose={onClose} canClose={!pending}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ email: email.trim(), displayName: displayName.trim(), role }).then((ok) => { if (ok) reset(); }); }}>
        <label><span>工作信箱</span><input autoFocus type="email" required maxLength={254} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="operator@example.com" /></label>
        <label><span>顯示名稱</span><input required minLength={2} maxLength={120} autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="王小明" /></label>
        <label><span>初始角色</span><select value={role} onChange={(event) => setRole(event.target.value as OrganizationRole)}>{Object.entries(ORGANIZATION_ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small className="field-help">請依最小權限原則選擇完成職責所需的最低角色。</small></label>
        {error && <InlineError error={error} />}
        <div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={pending || displayName.trim().length < 2 || !email.includes("@")}>{pending ? "新增中…" : "新增成員"}</button></div>
      </form>
    </Modal>
  );
}

function MemberAccessDialog({ open, operator, pending, error, recoverConflict, resetIntent, onClose, onSubmit }: {
  open: boolean;
  operator: Operator;
  pending: boolean;
  error: DisplayError | null;
  recoverConflict: () => void;
  resetIntent: () => void;
  onClose: () => void;
  onSubmit: (operator: Operator, values: { role: OrganizationRole; status: "active" | "suspended" }) => Promise<boolean>;
}) {
  const [base, setBase] = useState(operator);
  const baseRole = operatorOrganizationRole(base);
  const baseStatus = base.status ?? "active";
  const incomingRole = operatorOrganizationRole(operator);
  const incomingStatus = operator.status ?? "active";
  const [role, setRole] = useState(baseRole);
  const [status, setStatus] = useState<"active" | "suspended">(baseStatus);
  const changed = role !== baseRole || status !== baseStatus;
  const newerAvailable = operator.membershipVersion !== base.membershipVersion;
  const reducesAccess = status === "suspended" || (baseRole === "admin" && role !== "admin") || (baseRole === "commander" && !["admin", "commander"].includes(role));

  function mergeLatest() {
    setRole((current) => current === baseRole ? incomingRole : current);
    setStatus((current) => current === baseStatus ? incomingStatus : current);
    setBase(operator);
    resetIntent();
  }

  return <Modal open={open} title="管理成員存取" description={`${operator.displayName} · 編輯基準版本 ${base.membershipVersion}`} onClose={onClose} dismissible={false} canClose={!pending}>
    <form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (changed && !newerAvailable) void onSubmit(base, { role, status }); }}>
      <div className="access-change-grid">
        <section><span>目前設定</span><strong>{ORGANIZATION_ROLE_LABEL[baseRole]}</strong><small>{baseStatus === "active" ? "啟用中" : "已停用"}</small></section>
        <Icon name="arrow" />
        <section><span>變更後</span><strong>{ORGANIZATION_ROLE_LABEL[role]}</strong><small>{status === "active" ? "啟用中" : "已停用"}</small></section>
      </div>
      <div className="form-row">
        <label><span>系統角色</span><select autoFocus value={role} onChange={(event) => setRole(event.target.value as OrganizationRole)}>{Object.entries(ORGANIZATION_ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>帳號狀態</span><select value={status} onChange={(event) => setStatus(event.target.value as "active" | "suspended")}><option value="active">啟用中</option><option value="suspended">已停用</option></select></label>
      </div>
      <div className={reducesAccess ? "form-warning" : "integration-notice"} role="note"><strong>{reducesAccess ? "這會降低或停用存取權" : "權限會立即變更"}</strong><span>{status === "suspended" ? "停用後，這位成員無法再執行組織內操作；既有稽核紀錄仍會保留。" : "伺服器會在下一個要求重新驗證角色。若成員仍負責進行中的事件，系統可能要求先完成交接。"}</span></div>
      {newerAvailable && <div className="version-notice" role="alert"><div><strong>其他管理員已更新存取設定</strong><span>先合併最新版；你改過的欄位會保留，未改欄位採用伺服器內容。</span></div><button className="button secondary compact" type="button" disabled={pending} onClick={mergeLatest}>合併最新版</button></div>}
      {error && <InlineError error={error} onRecover={error.code === "VERSION_CONFLICT" ? recoverConflict : undefined} />}
      <div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={onClose}>取消</button><button className={`button ${reducesAccess ? "danger" : "primary"}`} type="submit" disabled={pending || !changed || newerAvailable}>{pending ? "更新中…" : "確認變更"}</button></div>
    </form>
  </Modal>;
}

function TimelineDialog({ open, allowedKinds, timeZone, pending, error, onClose, onSubmit }: {
  open: boolean;
  allowedKinds: TimelineEntry["kind"][];
  timeZone: string;
  pending: boolean;
  error: { message: string; requestId?: string } | null;
  onClose: () => void;
  onSubmit: (values: { kind: TimelineEntry["kind"]; message: string; referenceUrl?: string; sourceLabel?: string; observedFrom?: string; observedTo?: string; sha256Digest?: string }) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<TimelineEntry["kind"]>(allowedKinds[0] ?? "communication");
  const [message, setMessage] = useState("");
  const [referenceUrl, setReferenceUrl] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [observedFrom, setObservedFrom] = useState("");
  const [observedTo, setObservedTo] = useState("");
  const [sha256Digest, setSha256Digest] = useState("");
  const effectiveKind = allowedKinds.includes(kind) ? kind : allowedKinds[0] ?? "communication";
  const evidence = effectiveKind === "evidence";
  const referenceValid = !referenceUrl.trim() || isHttpsUrl(referenceUrl.trim());
  const digestValid = !sha256Digest.trim() || /^[a-fA-F0-9]{64}$/.test(sha256Digest.trim());
  const observedFromDate = observedFrom ? parseZonedDateTimeInput(observedFrom, timeZone) : null;
  const observedToDate = observedTo ? parseZonedDateTimeInput(observedTo, timeZone) : null;
  const observedTimesValid = (!observedFrom || Boolean(observedFromDate)) && (!observedTo || Boolean(observedToDate));
  const observedRangeValid = observedTimesValid && (!observedFromDate || !observedToDate || observedFromDate.getTime() <= observedToDate.getTime());

  function reset() {
    setMessage("");
    setReferenceUrl("");
    setSourceLabel("");
    setObservedFrom("");
    setObservedTo("");
    setSha256Digest("");
  }

  return <Modal open={open} title="加入時間軸更新" description="記錄新的調查結果、處置或可回查的驗證證據。" onClose={onClose} dismissible={false} canClose={!pending}>
    <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ kind: effectiveKind, message: message.trim(), referenceUrl: evidence && referenceUrl.trim() ? referenceUrl.trim() : undefined, sourceLabel: evidence && sourceLabel.trim() ? sourceLabel.trim() : undefined, observedFrom: evidence ? observedFromDate?.toISOString() : undefined, observedTo: evidence ? observedToDate?.toISOString() : undefined, sha256Digest: evidence && sha256Digest.trim() ? sha256Digest.trim().toLowerCase() : undefined }).then((ok) => { if (ok) reset(); }); }}>
      <label><span>更新類型</span><select value={effectiveKind} onChange={(event) => setKind(event.target.value as TimelineEntry["kind"])}>{allowedKinds.map((value) => <option value={value} key={value}>{TIMELINE_KIND_LABEL[value]}</option>)}</select></label>
      <label><span>更新內容</span><textarea autoFocus rows={5} maxLength={2000} required value={message} onChange={(event) => setMessage(event.target.value)} placeholder="說明已確認事項、依據、結果與下一步。" /></label>
      {evidence && <fieldset className="evidence-fieldset"><legend>證據來源與完整性</legend>
        <label><span>來源名稱（選填）</span><input maxLength={120} value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} placeholder="Grafana · checkout latency" /></label>
        <label><span>HTTPS 參考網址（選填）</span><input type="url" pattern="https://.*" maxLength={2048} value={referenceUrl} onChange={(event) => setReferenceUrl(event.target.value)} placeholder="https://observability.example/..." /></label>
        <div className="form-row"><label><span>觀測開始（{timeZone}，選填）</span><input type="datetime-local" value={observedFrom} onChange={(event) => setObservedFrom(event.target.value)} /></label><label><span>觀測結束（{timeZone}，選填）</span><input type="datetime-local" value={observedTo} onChange={(event) => setObservedTo(event.target.value)} /></label></div>
        <label><span>SHA-256 摘要（選填）</span><input className="mono-input" inputMode="text" minLength={64} maxLength={64} pattern="[a-fA-F0-9]{64}" value={sha256Digest} onChange={(event) => setSha256Digest(event.target.value.replace(/\s/g, ""))} placeholder="64 位十六進位字元" /><small className="field-help">用於日後確認證據內容沒有被替換；不會取代原始證據保存。</small></label>
        {!observedTimesValid && <div className="form-warning" role="alert">觀測時間在 {timeZone} 不存在或有兩種可能，請改用其他時間。</div>}
        {observedTimesValid && !observedRangeValid && <div className="form-warning" role="alert">觀測結束時間不得早於開始時間。</div>}
      </fieldset>}
      {error && <InlineError error={error} />}
      <div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={pending || allowedKinds.length === 0 || message.trim().length < 8 || !referenceValid || !digestValid || !observedRangeValid}>{pending ? "加入中…" : "加入時間軸"}</button></div>
    </form>
  </Modal>;
}

function TaskDialog({ open, operators, timeZone, pending, error, onClose, onSubmit }: { open: boolean; operators: Operator[]; timeZone: string; pending: boolean; error: { message: string; requestId?: string } | null; onClose: () => void; onSubmit: (values: { title: string; priority: TaskPriority; ownerId?: string; dueAt?: string; evidenceRef?: string }) => Promise<boolean> }) {
  const [title, setTitle] = useState(""); const [priority, setPriority] = useState<TaskPriority>("high"); const [ownerId, setOwnerId] = useState(""); const [dueAt, setDueAt] = useState(""); const [evidenceRef, setEvidenceRef] = useState("");
  const evidenceValid = !evidenceRef.trim() || isHttpsUrl(evidenceRef.trim());
  const dueDate = dueAt ? parseZonedDateTimeInput(dueAt, timeZone) : null;
  const dueAtValid = !dueAt || Boolean(dueDate);
  return <Modal open={open} title="新增工作項目" description="建立可追蹤的調查、處置、溝通或改善工作。" onClose={onClose} canClose={!pending}>
    <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void onSubmit({ title, priority, ownerId: ownerId || undefined, dueAt: dueDate?.toISOString(), evidenceRef: evidenceRef.trim() || undefined }).then((ok) => { if (ok) { setTitle(""); setOwnerId(""); setDueAt(""); setEvidenceRef(""); } }); }}>
      <label><span>工作內容</span><input autoFocus maxLength={180} required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="以可驗證的完成結果描述工作" /></label>
      <div className="form-row"><label><span>優先度</span><select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>{Object.entries(TASK_PRIORITY_LABEL).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label><span>負責人</span><select value={ownerId} onChange={(event) => setOwnerId(event.target.value)}><option value="">待指派</option>{operators.filter((operator) => operator.status !== "suspended").map((operator) => <option value={operator.id} key={operator.id}>{operator.displayName}</option>)}</select></label></div>
      <label><span>到期時間（{timeZone}，選填）</span><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
      {!dueAtValid && <div className="form-warning" role="alert">到期時間在 {timeZone} 不存在或有兩種可能，請改用其他時間。</div>}
      <label><span>完成證據網址（選填）</span><input type="url" pattern="https://.*" maxLength={2048} value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="https://tickets.example/..." /><small className="field-help">僅接受 HTTPS 網址；工作標記為完成時必須提供。</small></label>
      {error && <InlineError error={error} />}
      <div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={onClose}>取消</button><button className="button primary" type="submit" disabled={pending || title.trim().length < 5 || !evidenceValid || !dueAtValid}>{pending ? "建立中…" : "建立工作"}</button></div>
    </form>
  </Modal>;
}

function TaskEditorDialog({ open, task, operators, timeZone, pending, error, recoverConflict, resetIntent, onClose, onSubmit }: {
  open: boolean;
  task: IncidentTask;
  operators: Operator[];
  timeZone: string;
  pending: boolean;
  error: DisplayError | null;
  recoverConflict: () => void;
  resetIntent: () => void;
  onClose: () => void;
  onSubmit: (task: IncidentTask, changes: TaskUpdateInput) => Promise<boolean>;
}) {
  const [base, setBase] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [priority, setPriority] = useState(task.priority);
  const [status, setStatus] = useState(task.status);
  const [assigneeUserId, setAssigneeUserId] = useState(task.owner?.id ?? "");
  const [dueAt, setDueAt] = useState(() => toZonedDateTimeInput(task.dueAt, timeZone));
  const [evidenceRef, setEvidenceRef] = useState(task.evidenceRef ?? "");
  const [cancellationReason, setCancellationReason] = useState(task.cancellationReason ?? "");
  const incomingDueAt = toZonedDateTimeInput(task.dueAt, timeZone);
  const baseDueAt = toZonedDateTimeInput(base.dueAt, timeZone);
  const dueDate = dueAt ? parseZonedDateTimeInput(dueAt, timeZone) : null;
  const dueAtValid = !dueAt || Boolean(dueDate);
  const normalizedEvidence = evidenceRef.trim();
  const normalizedCancellationReason = cancellationReason.trim();
  const changes: TaskUpdateInput = {};
  if (title.trim() !== base.title) changes.title = title.trim();
  if (description.trim() !== (base.description ?? "")) changes.description = description.trim();
  if (priority !== base.priority) changes.priority = priority;
  if (status !== base.status) changes.status = status;
  if (assigneeUserId !== (base.owner?.id ?? "")) changes.assigneeUserId = assigneeUserId || null;
  if (dueAt !== baseDueAt) changes.dueAt = dueDate ? dueDate.toISOString() : null;
  if (normalizedEvidence !== (base.evidenceRef ?? "")) changes.evidenceRef = normalizedEvidence || null;
  if (status === "cancelled" && normalizedCancellationReason !== (base.cancellationReason ?? "")) changes.cancellationReason = normalizedCancellationReason || null;
  const hasChanges = Object.keys(changes).length > 0;
  const evidenceValid = !normalizedEvidence || isHttpsUrl(normalizedEvidence);
  const completionReady = status !== "completed" || isHttpsUrl(normalizedEvidence);
  const cancellationReasonRequired = status === "cancelled" && (base.priority === "critical" || priority === "critical");
  const cancellationReasonReady = !cancellationReasonRequired || (normalizedCancellationReason.length >= 8 && normalizedCancellationReason.length <= 1000);
  const cancellationReasonLocked = base.status === "cancelled" && Boolean(base.cancellationReason);
  const newerAvailable = task.version !== base.version;
  const terminalChange = status !== base.status && (status === "completed" || status === "cancelled");

  function mergeLatest() {
    setTitle((current) => current === base.title ? task.title : current);
    setDescription((current) => current === (base.description ?? "") ? task.description ?? "" : current);
    setPriority((current) => current === base.priority ? task.priority : current);
    setStatus((current) => current === base.status ? task.status : current);
    setAssigneeUserId((current) => current === (base.owner?.id ?? "") ? task.owner?.id ?? "" : current);
    setDueAt((current) => current === baseDueAt ? incomingDueAt : current);
    setEvidenceRef((current) => current === (base.evidenceRef ?? "") ? task.evidenceRef ?? "" : current);
    setCancellationReason((current) => task.cancellationReason
      ? task.cancellationReason
      : current === (base.cancellationReason ?? "") ? "" : current);
    setBase(task);
    resetIntent();
  }

  return <Modal open={open} title="管理工作項目" description={`編輯基準版本 ${base.version}；儲存前會再次核對伺服器版本。`} onClose={onClose} dismissible={false} canClose={!pending}>
    <form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (completionReady && cancellationReasonReady) void onSubmit(base, changes); }}>
      <label><span>工作內容</span><input autoFocus required minLength={3} maxLength={180} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      <label><span>完成條件或補充說明（選填）</span><textarea rows={3} maxLength={1500} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="說明什麼結果可視為完成，或補充執行背景與限制。" /></label>
      <div className="form-row">
        <label><span>優先度</span><select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>{Object.entries(TASK_PRIORITY_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label><span>狀態</span><select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>{Object.entries(TASK_STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      <div className="form-row">
        <label><span>負責人</span><select value={assigneeUserId} onChange={(event) => setAssigneeUserId(event.target.value)}><option value="">待指派</option>{operators.filter((operator) => operator.status !== "suspended").map((operator) => <option key={operator.id} value={operator.id}>{operator.displayName} · {operator.email}</option>)}</select></label>
        <label><span>到期時間（{timeZone}，選填）</span><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label>
      </div>
      <label><span>完成證據網址{status === "completed" ? "（必填）" : "（選填）"}</span><input type="url" pattern="https://.*" maxLength={2048} required={status === "completed"} value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="https://tickets.example/..." /><small className="field-help">完成工作前必須附上可由授權人員查閱的 HTTPS 證據。</small></label>
      {cancellationReasonRequired && <label><span>{cancellationReasonLocked ? "取消理由（已記錄）" : "取消理由（必填）"}</span><textarea rows={4} required minLength={8} maxLength={1000} readOnly={cancellationReasonLocked} aria-readonly={cancellationReasonLocked || undefined} value={cancellationReason} onChange={(event) => setCancellationReason(event.target.value)} placeholder="說明為何不再執行這項緊急工作，以及風險如何處理。" /><small className="field-help">取消緊急工作會使它不再阻擋事件復原；請以 8–1000 字記錄判斷依據。已保存的取消理由不可修改。</small></label>}
      {terminalChange && <div className="confirmation-summary" role="note"><strong>{status === "completed" ? "確認完成工作" : "確認取消工作"}</strong><span>{status === "completed" ? "儲存後，系統會記錄完成狀態、證據與操作者。" : "儲存後，系統會保留取消狀態與這次變更的稽核紀錄。"}</span></div>}
      {!completionReady && <div className="form-warning" role="alert">工作標記為完成前，必須提供有效的 HTTPS 證據網址。</div>}
      {!cancellationReasonReady && <div className="form-warning" role="alert">取消緊急工作前，請填寫 8–1000 字的取消理由。</div>}
      {!dueAtValid && <div className="form-warning" role="alert">到期時間在 {timeZone} 不存在或有兩種可能，請改用其他時間。</div>}
      {newerAvailable && <div className="version-notice" role="alert"><div><strong>其他人已更新這項工作</strong><span>先合併最新版；你改過的欄位會保留，未改欄位採用伺服器內容。</span></div><button className="button secondary compact" type="button" onClick={mergeLatest}>合併最新版</button></div>}
      {error && <InlineError error={error} onRecover={error.code === "VERSION_CONFLICT" ? recoverConflict : undefined} />}
      <div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={onClose}>取消</button><button className={`button ${status === "cancelled" ? "danger" : "primary"}`} type="submit" disabled={pending || !hasChanges || newerAvailable || title.trim().length < 3 || !evidenceValid || !completionReady || !cancellationReasonReady || !dueAtValid}>{pending ? "儲存中…" : "確認並儲存"}</button></div>
    </form>
  </Modal>;
}

function TransitionDialog({ incident, target, pending, error, recoverConflict, onClose, onSubmit }: { incident: IncidentSummary | IncidentDetail | null; target: IncidentStatus | null; pending: boolean; error: DisplayError | null; recoverConflict: () => void; onClose: () => void; onSubmit: (target: IncidentStatus, note: string) => Promise<boolean> }) {
  const [note, setNote] = useState("");
  const detail = incident && "timeline" in incident ? incident : null;
  const monitoringAt = detail?.timeline
    .filter((entry) => entry.toStatus === "monitoring")
    .map((entry) => safeDate(entry.occurredAt)?.getTime() ?? 0)
    .sort((a, b) => b - a)[0] ?? null;
  const verificationAfterMonitoring = Boolean(detail && monitoringAt && detail.timeline.some((entry) => entry.kind === "evidence" && (safeDate(entry.occurredAt)?.getTime() ?? 0) >= monitoringAt));
  const resolutionChecks = [
    { label: "已建立明確的復原判定條件", ready: Boolean(detail?.verificationCriteria?.trim()) },
    { label: "進入監控後已有驗證證據", ready: verificationAfterMonitoring },
    { label: "沒有未完成的緊急工作", ready: Boolean(detail && !detail.tasks.some((task) => task.priority === "critical" && !["completed", "cancelled"].includes(task.status))) },
  ];
  const resolutionReady = target !== "resolved" || resolutionChecks.every((check) => check.ready);
  return <Modal open={Boolean(target && incident)} title={target ? `更新為「${INCIDENT_STATUS_LABEL[target]}」` : "更新事件"} description={incident ? `${incident.key} · ${incident.title}` : ""} onClose={onClose} canClose={!pending}><form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (target && resolutionReady) void onSubmit(target, note); }}><div className="transition-summary"><span>當前狀態</span><strong>{incident ? INCIDENT_STATUS_LABEL[incident.status] : "—"}</strong><Icon name="arrow" /><span>目標狀態</span><strong>{target ? INCIDENT_STATUS_LABEL[target] : "—"}</strong></div>{target === "resolved" && <section className="readiness-checks" aria-labelledby="resolution-readiness-title"><div><strong id="resolution-readiness-title">復原前檢查</strong><span>三項條件都符合後才能提交；伺服器會再次核對。</span></div><ul>{resolutionChecks.map((check) => <li key={check.label} className={check.ready ? "ready" : "blocked"}><span aria-hidden="true">{check.ready ? "✓" : "!"}</span><strong>{check.label}</strong><small>{check.ready ? "符合" : "尚未符合"}</small></li>)}</ul></section>}<label><span>判定依據</span><textarea autoFocus rows={4} maxLength={1000} required value={note} onChange={(event) => setNote(event.target.value)} placeholder="說明哪些事實、指標或驗證結果支持這次狀態變更。" /></label>{error && <InlineError error={error} onRecover={recoverConflict} />}<div className="modal-actions"><button className="button ghost" type="button" disabled={pending} onClick={onClose}>取消</button><button className={`button ${target === "cancelled" ? "danger" : "primary"}`} type="submit" disabled={pending || !target || note.trim().length < 8 || !resolutionReady}>{pending ? "更新中…" : "確認變更"}</button></div></form></Modal>;
}

function Modal({ open, title, description, onClose, children, dismissible = true, canClose = true }: { open: boolean; title: string; description?: string; onClose: () => void; children: ReactNode; dismissible?: boolean; canClose?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const focusCycleRef = useRef(0);
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const focusCycle = ++focusCycleRef.current;
    const restoreTriggerFocus = () => {
      const target = returnFocusRef.current;
      if (!target) return;
      queueMicrotask(() => {
        if (focusCycleRef.current !== focusCycle || !target.isConnected || target.hasAttribute("disabled")) return;
        target.focus({ preventScroll: true });
        if (returnFocusRef.current === target) returnFocusRef.current = null;
      });
    };
    if (open && !dialog.open) {
      const activeElement = document.activeElement;
      if (!returnFocusRef.current && activeElement instanceof HTMLElement && activeElement !== document.body && !dialog.contains(activeElement)) {
        returnFocusRef.current = activeElement;
      }
      dialog.showModal();
    }
    if (!open) {
      if (dialog.open) dialog.close();
      restoreTriggerFocus();
    }
    return () => {
      if (dialog.open) dialog.close();
      if (open) restoreTriggerFocus();
    };
  }, [open]);
  const requestDismiss = () => {
    if (dismissible && canClose) onClose();
  };
  return <dialog ref={ref} className="modal" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} aria-busy={!canClose || undefined} onCancel={(event) => { event.preventDefault(); requestDismiss(); }} onClick={(event) => { if (event.target === ref.current) requestDismiss(); }}><div className="modal-surface"><header><div><p className="eyebrow">CONTINUITY OPS</p><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div><button className="icon-button" type="button" aria-label="關閉對話視窗" disabled={!canClose} onClick={onClose}><Icon name="close" /></button></header>{children}</div></dialog>;
}

function PageHeader({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children?: ReactNode }) {
  return <header className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{children && <div className="page-header-actions">{children}</div>}</header>;
}

function PanelHeader({ title, eyebrow, id, children }: { title: string; eyebrow: string; id: string; children?: ReactNode }) {
  return <header className="panel-header"><div><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div>{children}</header>;
}

function IncidentTable({ incidents, selectIncident, emptyMessage, timeZone }: { incidents: IncidentSummary[]; selectIncident: (id: string) => void; emptyMessage: string; timeZone: string }) {
  if (incidents.length === 0) return <EmptyState compact title={emptyMessage} description="事件紀錄會在宣告後顯示在這裡。" />;
  return <div className="table-scroll" role="region" aria-label="優先處理事件，可水平捲動" tabIndex={0}>
    <table className="data-table incident-table">
      <caption className="sr-only">優先處理的未結案事件</caption>
      <thead><tr><th scope="col">事件</th><th scope="col">服務</th><th scope="col">狀態</th><th scope="col">事件指揮官</th><th scope="col">持續時間</th><th scope="col">最後更新</th><th scope="col"><span className="sr-only">開啟</span></th></tr></thead>
      <tbody>{incidents.map((incident) => <tr key={incident.id}>
        <th scope="row"><span className="incident-cell-title"><SeverityBadge severity={incident.severity} /><span><strong>{incident.title}</strong><small>{incident.key}</small></span></span></th>
        <td>{incident.serviceName}<small>{ENVIRONMENT_LABEL[incident.environment]}</small></td>
        <td><StatusBadge status={incident.status} /></td>
        <td className={!incident.commander ? "value-critical" : undefined}>{incident.commander?.displayName ?? "待指派"}</td>
        <td>{formatDuration(incident.startedAt, incident.resolvedAt)}</td>
        <td>{formatTimestamp(incident.updatedAt, timeZone)}</td>
        <td><button className="icon-button table-action" type="button" aria-label={`開啟 ${incident.key} ${incident.title}`} onClick={() => selectIncident(incident.id)}><Icon name="arrow" /></button></td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function AuditList({ records, timeZone }: { records: AuditRecord[]; timeZone: string }) {
  if (records.length === 0) return <EmptyState compact title="尚無操作紀錄" description="新的操作會以追加方式記錄在這裡。" />;
  return <ol className="audit-list">{records.map((record) => <li key={record.id}><ResultBadge result={record.result} compact /><div><strong>{record.actor.displayName} · {auditActionLabel(record.action)}</strong><span>{auditResourceLabel(record.resourceType)} · {record.resourceKey}{record.reasonCode ? ` · ${record.reasonCode}` : ""}</span></div><time>{formatTimestamp(record.occurredAt, timeZone)}</time></li>)}</ol>;
}

function InfoBlock({ label, value }: { label: string; value: string }) {
  return <section className="info-block"><h3>{label}</h3><p>{value}</p></section>;
}

function EmptyState({ title, description, actionLabel, onAction, compact = false }: { title: string; description: string; actionLabel?: string; onAction?: () => void; compact?: boolean }) {
  return <div className={`empty-state ${compact ? "compact" : ""}`}><div className="empty-icon" aria-hidden="true"><Icon name="service" /></div><strong>{title}</strong><p>{description}</p>{actionLabel && onAction && <button className="button secondary compact" type="button" onClick={onAction}>{actionLabel}</button>}</div>;
}

function ErrorBanner({ title, error, onRetry, retryLabel = "重試", onDismiss }: { title: string; error: DisplayError; onRetry?: () => void; retryLabel?: string; onDismiss?: () => void }) {
  return <div className="error-banner" role="alert"><div><strong>{title}</strong><span>{error.message}</span>{error.requestId && <small>Request ID: {error.requestId}</small>}</div><div>{onRetry && <button className="button secondary compact" type="button" onClick={onRetry}>{retryLabel}</button>}{onDismiss && <button className="icon-button" type="button" aria-label="關閉錯誤提示" onClick={onDismiss}><Icon name="close" /></button>}</div></div>;
}

function InlineError({ error, onRecover }: { error: DisplayError; onRecover?: () => void }) {
  return <div className="inline-error" role="alert"><strong>無法完成操作</strong><span>{error.message}</span>{error.requestId && <small>Request ID: {error.requestId}</small>}{error.code === "VERSION_CONFLICT" && onRecover && <button className="button secondary compact" type="button" onClick={onRecover}>載入最新版</button>}</div>;
}

function LoadingScreen() {
  return <div className="loading-screen" role="status" aria-live="polite"><span className="spinner large" /><strong>正在載入營運狀態</strong><span>取得共享事件、服務與稽核資料。</span></div>;
}

function InitialLoadFailure({ onRetry }: { onRetry: () => void }) {
  return <div className="initial-load-failure"><div className="empty-icon" aria-hidden="true">!</div><strong>營運資料尚未就緒</strong><p>事件、服務與存取資料必須完整取得後才會顯示；系統不會以空白清單代替失敗的回應。</p><button className="button primary" type="button" onClick={onRetry}>重新取得資料</button></div>;
}

function Avatar({ name, small = false }: { name: string; small?: boolean }) {
  return <span className={`avatar ${small ? "small" : ""}`} aria-hidden="true">{initials(name)}</span>;
}

function SeverityBadge({ severity }: { severity: Severity }) {
  return <span className={`severity-badge ${severity.toLowerCase()}`} title={`${severity} · ${SEVERITY_LABEL[severity]}`}>{severity}</span>;
}

function StatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={`status-badge ${status}`}><span />{INCIDENT_STATUS_LABEL[status]}</span>;
}

function ServiceStatusDot({ status }: { status: ServiceStatus }) {
  return <span className={`service-dot ${status}`} aria-hidden="true" />;
}

function PriorityDot({ priority, decorative = false }: { priority: TaskPriority; decorative?: boolean }) {
  return <span className={`priority-dot ${priority}`} role={decorative ? undefined : "img"} aria-hidden={decorative || undefined} aria-label={decorative ? undefined : TASK_PRIORITY_LABEL[priority]} />;
}

function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return <span className={`priority-badge ${priority}`}><PriorityDot priority={priority} decorative />{TASK_PRIORITY_LABEL[priority]}</span>;
}

function ResultBadge({ result, compact = false }: { result: AuditRecord["result"]; compact?: boolean }) {
  const labels = { success: "成功", failure: "失敗", denied: "已拒絕" };
  return <span className={`result-badge ${result} ${compact ? "compact" : ""}`}><span />{compact ? <span className="sr-only">{labels[result]}</span> : labels[result]}</span>;
}

function SystemHealth({ health, timeZone }: { health: HealthStatus | null; timeZone: string }) {
  const status = health?.status ?? "unavailable";
  const labels = { operational: "平台可用", degraded: "平台降級", unavailable: "平台狀態未知" };
  return <span className={`system-health ${status}`} title={health?.checkedAt ? `檢查於 ${formatLongTimestamp(health.checkedAt, timeZone)}` : undefined}><span />{labels[status]}</span>;
}

function allowedIncidentTransitions(status: IncidentStatus): IncidentStatus[] {
  const transitions: Record<IncidentStatus, IncidentStatus[]> = {
    declared: ["investigating", "cancelled"],
    investigating: ["mitigating", "cancelled"],
    mitigating: ["monitoring", "investigating", "cancelled"],
    monitoring: ["resolved", "investigating", "cancelled"],
    resolved: ["closed", "investigating"],
    closed: ["investigating"],
    cancelled: [],
  };
  return transitions[status];
}

function transitionActionLabel(current: IncidentStatus, target: IncidentStatus): string {
  if (current === "closed" && target === "investigating") return "重新開啟";
  if (current !== "declared" && target === "investigating") return "退回調查";
  if (target === "cancelled") return "取消事件";
  if (target === "investigating") return "開始調查";
  if (target === "mitigating") return "開始處置";
  if (target === "monitoring") return "進入監控";
  if (target === "resolved") return "確認復原";
  if (target === "closed") return "結案";
  return `更新為${INCIDENT_STATUS_LABEL[target]}`;
}
