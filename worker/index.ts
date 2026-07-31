/** Cloudflare Worker entry point for Continuity Ops. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  CONTINUITY_OPS_ENVIRONMENT?: string;
  CONTINUITY_OPS_DEPLOYMENT_VERSION?: string;
  CONTINUITY_OPS_CURSOR_HMAC_SECRET?: string;
  CONTINUITY_OPS_ORGANIZATION_NAME?: string;
  CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_ID?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_NAME?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_ROLE?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

function withSecurityHeaders(request: Request, response: Response): Response {
  const url = new URL(request.url);
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  headers.set("x-permitted-cross-domain-policies", "none");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  headers.set("cross-origin-opener-policy", "same-origin");
  headers.set("cross-origin-resource-policy", "same-origin");
  headers.set(
    "content-security-policy",
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; script-src-attr 'none'",
  );
  if (url.protocol === "https:") {
    // Do not add includeSubDomains until every subordinate host is known to be HTTPS-only.
    headers.set("strict-transport-security", "max-age=31536000");
  }
  const contentType = headers.get("content-type") ?? "";
  if (url.pathname.startsWith("/api/") || contentType.includes("text/html")) {
    headers.set("cache-control", "no-store");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(request, response);
    }

    const response = await handler.fetch(request, env, ctx);
    return withSecurityHeaders(request, response);
  },
};

export default worker;
