import { dispatchOperationsApi, normalizeOperationsApiError } from "../_handlers";
import { emitOperationsRequestTelemetry, problemResponse, requestId } from "../_shared";
import { drainOperationsRequestBody } from "@/lib/operations-input";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path: string[] }> };

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const currentRequestId = requestId();
  const startedAt = performance.now();
  let path: string[] = [];
  let problemCode: string | null = null;
  let response: Response;
  try {
    const params = await context.params;
    path = params.path ?? [];
    response = await dispatchOperationsApi(request, path, currentRequestId);
  } catch (error) {
    if (request.body && !request.bodyUsed) {
      try {
        await drainOperationsRequestBody(request);
      } catch {
        // Preserve the original rejection; draining is only transport hygiene.
      }
    }
    const problem = normalizeOperationsApiError(error);
    problemCode = problem.code;
    response = problemResponse(problem, currentRequestId);
  }
  try {
    emitOperationsRequestTelemetry({
      requestId: currentRequestId,
      path,
      method: request.method,
      status: response.status,
      problemCode,
      latencyMs: performance.now() - startedAt,
    });
  } catch {
    // Telemetry must never change the API result.
  }
  return response;
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
