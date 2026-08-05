import { normalizeClassroomEmail } from "./classroom-access.ts";

export type ClassroomEnvironment = {
  CLASSROOM_ENVIRONMENT?: string;
  CLASSROOM_LOCAL_USER_ID?: string;
  CLASSROOM_LOCAL_USER_NAME?: string;
  CLASSROOM_LOCAL_USER_EMAIL?: string;
  CLASSROOM_ADMIN_EMAILS?: string;
};

export type ClassroomIdentity = {
  externalId: string;
  email: string;
  displayName: string;
  source: "forwarded_identity" | "local_environment";
  isLocal: boolean;
};

const EMAIL_HEADER = "oai-authenticated-user-email";
const USER_ID_HEADER = "oai-authenticated-user-id";
const NAME_HEADER = "oai-authenticated-user-full-name";
const NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";

function isLocalRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function resolveClassroomIdentity(
  request: Request,
  environment: ClassroomEnvironment,
): ClassroomIdentity | null {
  const localRequest = isLocalRequest(request);
  const configuredEnvironment = environment.CLASSROOM_ENVIRONMENT?.trim().toLowerCase();
  const development = configuredEnvironment === "development" || (!configuredEnvironment && localRequest);

  if (development && localRequest) {
    const email = normalizeClassroomEmail(environment.CLASSROOM_LOCAL_USER_EMAIL);
    const externalId = environment.CLASSROOM_LOCAL_USER_ID?.trim() ?? "";
    const displayName = environment.CLASSROOM_LOCAL_USER_NAME?.trim() ?? "";
    if (!email || externalId.length < 3 || displayName.length < 2) return null;
    return {
      externalId,
      email,
      displayName: displayName.slice(0, 120),
      source: "local_environment",
      isLocal: true,
    };
  }

  const email = normalizeClassroomEmail(request.headers.get(EMAIL_HEADER));
  if (!email) return null;
  const encodedName = request.headers.get(NAME_HEADER) ?? "";
  const decodedName = request.headers.get(NAME_ENCODING_HEADER) === "percent-encoded-utf-8"
    ? safeDecode(encodedName)
    : encodedName;
  return {
    externalId: request.headers.get(USER_ID_HEADER)?.trim() || email,
    email,
    displayName: (decodedName?.trim() || email).slice(0, 120),
    source: "forwarded_identity",
    isLocal: false,
  };
}

export function requestIsSameOrigin(request: Request): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
