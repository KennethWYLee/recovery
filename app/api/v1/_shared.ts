import {
  loadOrProvisionOperationsActor,
  normalizeIdempotencyKey,
  operationsDb,
  operationsEnvironment,
} from "@/db/operations";
import {
  actorHasPermission,
  requestIsSameOrigin,
  resolveExternalOperationsIdentity,
  type OperationsActor,
} from "@/lib/operations-auth";
import { cleanOperationsText, operationsRouteTemplate, type OperationsPermission } from "@/lib/operations-domain";
import {
  RequestBodyError,
  boundedOperationsText,
  drainOperationsRequestBody,
  readBoundedJsonObject,
} from "@/lib/operations-input";

export const OPERATIONS_API_VERSION = "2.2.0";
export const OPERATIONS_SCHEMA_VERSION = "0004";

export class ApiProblem extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly title = status >= 500 ? "Service unavailable" : "Request rejected",
  ) {
    super(message);
    this.name = "ApiProblem";
  }
}

export type OperationsRequestContext = {
  request: Request;
  requestId: string;
  db: D1Database;
  actor: OperationsActor;
};

export async function authenticatedContext(request: Request, requestId: string): Promise<OperationsRequestContext> {
  if (!requestIsSameOrigin(request)) {
    throw new ApiProblem(403, "CROSS_ORIGIN_REQUEST_REJECTED", "State-changing requests must originate from this application.");
  }
  const identity = resolveExternalOperationsIdentity(request, operationsEnvironment());
  if (!identity) throw new ApiProblem(401, "AUTHENTICATION_REQUIRED", "A verified operator identity is required.", "Authentication required");
  const actor = await loadOrProvisionOperationsActor(identity);
  if (!actor) {
    throw new ApiProblem(403, "ACTIVE_MEMBERSHIP_REQUIRED", "The authenticated identity does not have an active Continuity Ops membership.", "Access denied");
  }
  return { request, requestId, db: operationsDb(), actor };
}

export function requirePermission(context: OperationsRequestContext, permission: OperationsPermission): void {
  if (!actorHasPermission(context.actor, permission)) {
    throw new ApiProblem(403, "PERMISSION_DENIED", `The ${permission} permission is required.`, "Access denied");
  }
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
  if (contentType !== "application/json" && !contentType.endsWith("+json")) {
    try {
      await drainOperationsRequestBody(request);
    } catch (error) {
      if (error instanceof RequestBodyError && error.kind === "read_failed") {
        throw new ApiProblem(400, "REQUEST_BODY_READ_FAILED", "The request body could not be read completely.");
      }
      throw error;
    }
    throw new ApiProblem(415, "JSON_CONTENT_TYPE_REQUIRED", "Use Content-Type: application/json.");
  }
  try {
    return await readBoundedJsonObject(request);
  } catch (error) {
    if (!(error instanceof RequestBodyError)) throw error;
    if (error.kind === "too_large") {
      throw new ApiProblem(413, "REQUEST_TOO_LARGE", "The request body exceeds 32 KiB.");
    }
    if (error.kind === "invalid_utf8") {
      throw new ApiProblem(400, "INVALID_UTF8", "The request body must contain valid UTF-8 JSON text.");
    }
    if (error.kind === "read_failed") {
      throw new ApiProblem(400, "REQUEST_BODY_READ_FAILED", "The request body could not be read completely.");
    }
    throw new ApiProblem(
      400,
      "INVALID_JSON",
      error.kind === "not_object"
        ? "The request body must be a JSON object."
        : "The request body must contain valid JSON.",
    );
  }
}

export function boundedText(value: unknown, key: string, max: number): string {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new ApiProblem(400, "INVALID_FIELD", `${key} must be text.`);
  }
  const normalized = boundedOperationsText(value, max);
  if (normalized.exceedsLimit) {
    throw new ApiProblem(400, "INVALID_FIELD", `${key} must contain at most ${max} characters.`);
  }
  return normalized.value;
}

export function requiredText(body: Record<string, unknown>, key: string, min: number, max: number): string {
  const value = boundedText(body[key], key, max);
  if (value.length < min) throw new ApiProblem(400, "INVALID_FIELD", `${key} must contain ${min}-${max} characters.`);
  return value;
}

export function optionalText(body: Record<string, unknown>, key: string, max: number): string {
  return boundedText(body[key], key, max);
}

export function requiredInteger(body: Record<string, unknown>, key: string, minimum = 1): number {
  const value = Number(body[key]);
  if (!Number.isInteger(value) || value < minimum) throw new ApiProblem(400, "INVALID_FIELD", `${key} must be an integer of at least ${minimum}.`);
  return value;
}

export function requestId(): string {
  return `req-${crypto.randomUUID()}`;
}

export function idempotencyKey(request: Request, body: Record<string, unknown>): string {
  const key = normalizeIdempotencyKey(request.headers.get("idempotency-key") ?? body.idempotencyKey);
  if (!key) throw new ApiProblem(400, "IDEMPOTENCY_KEY_REQUIRED", "Provide an Idempotency-Key header containing 8-128 visible ASCII characters.");
  return key;
}

export function successResponse(data: unknown, requestIdValue: string, status = 200): Response {
  return new Response(JSON.stringify({ data, meta: { requestId: requestIdValue } }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": requestIdValue,
    },
  });
}

export function problemResponse(error: unknown, requestIdValue: string): Response {
  const problem = error instanceof ApiProblem
    ? error
    : new ApiProblem(500, "INTERNAL_ERROR", "The operation could not be completed.", "Internal server error");
  return new Response(JSON.stringify({
    type: `https://continuity-ops.invalid/problems/${problem.code.toLowerCase()}`,
    title: problem.title,
    status: problem.status,
    detail: problem.message,
    code: problem.code,
    requestId: requestIdValue,
  }), {
    status: problem.status,
    headers: {
      "content-type": "application/problem+json; charset=utf-8",
      "cache-control": "no-store",
      "x-request-id": requestIdValue,
    },
  });
}

export function emitOperationsRequestTelemetry(values: {
  requestId: string;
  path: readonly string[];
  method: string;
  status: number;
  problemCode?: string | null;
  latencyMs: number;
}): void {
  console.info(JSON.stringify({
    event: "continuity_ops.api_request",
    requestId: values.requestId,
    route: operationsRouteTemplate(values.path),
    method: values.method.toUpperCase(),
    status: values.status,
    problemCode: values.problemCode ?? null,
    latencyMs: Math.max(0, Math.round(values.latencyMs)),
    apiVersion: OPERATIONS_API_VERSION,
    deploymentVersion: deploymentVersion(),
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
  }));
}

export function emitRejectedMutationAuditFailure(values: {
  requestId: string;
  path: readonly string[];
  method: string;
  status: number;
  problemCode: string;
}): void {
  console.error(JSON.stringify({
    event: "continuity_ops.rejected_mutation_audit_write_failed",
    requestId: values.requestId,
    route: operationsRouteTemplate(values.path),
    method: values.method.toUpperCase(),
    status: values.status,
    problemCode: values.problemCode,
    apiVersion: OPERATIONS_API_VERSION,
    deploymentVersion: deploymentVersion(),
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
  }));
}

function deploymentVersion(): string {
  return cleanOperationsText(operationsEnvironment().CONTINUITY_OPS_DEPLOYMENT_VERSION, 80) || "unversioned";
}
