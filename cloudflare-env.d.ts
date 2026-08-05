/// <reference types="@cloudflare/workers-types" />

interface CloudflareEnv {
  DB: D1Database;
  CONTINUITY_OPS_ENVIRONMENT?: "development" | "staging" | "production";
  CONTINUITY_OPS_DEPLOYMENT_VERSION?: string;
  CONTINUITY_OPS_CURSOR_HMAC_SECRET?: string;
  CONTINUITY_OPS_ORGANIZATION_NAME?: string;
  CONTINUITY_OPS_ORGANIZATION_TIMEZONE?: string;
  CONTINUITY_OPS_PUBLIC_ORIGIN?: string;
  CONTINUITY_OPS_BOOTSTRAP_ADMIN_EMAIL?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_ID?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_NAME?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL?: string;
  CONTINUITY_OPS_LOCAL_OPERATOR_ROLE?: "admin" | "commander" | "responder" | "observer" | "auditor";
  CLASSROOM_TEACHER_EMAILS?: string;
}

declare module "cloudflare:workers" {
  const env: CloudflareEnv;
}

declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}
