/// <reference types="@cloudflare/workers-types" />

interface CloudflareEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  CLASSROOM_ENVIRONMENT?: "development" | "staging" | "production";
  CLASSROOM_LOCAL_USER_ID?: string;
  CLASSROOM_LOCAL_USER_NAME?: string;
  CLASSROOM_LOCAL_USER_EMAIL?: string;
  CLASSROOM_ADMIN_EMAILS?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

declare module "cloudflare:workers" {
  const env: CloudflareEnv;
}

declare module "*.sql?raw" {
  const sql: string;
  export default sql;
}

declare namespace NodeJS {
  interface ProcessEnv {
    CLASSROOM_ENVIRONMENT?: "development" | "staging" | "production";
    CLASSROOM_LOCAL_USER_ID?: string;
    CLASSROOM_LOCAL_USER_NAME?: string;
    CLASSROOM_LOCAL_USER_EMAIL?: string;
    CLASSROOM_ADMIN_EMAILS?: string;
  }
}
