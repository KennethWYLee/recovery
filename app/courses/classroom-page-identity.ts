import { headers } from "next/headers";
import { getChatGPTUser, chatGPTSignOutPath } from "@/app/chatgpt-auth";
import { classroomEnvironment } from "@/db/classroom";

export type ClassroomPageIdentity = {
  displayName: string;
  email: string;
  mode: "hosted" | "local";
  signOutPath: string;
};

function localHost(value: string): boolean {
  try {
    const hostname = new URL(`http://${value}`).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export async function classroomPageIdentity(returnTo: string): Promise<ClassroomPageIdentity | null> {
  const requestHeaders = await headers();
  const hosted = await getChatGPTUser();
  if (hosted) {
    return {
      displayName: hosted.displayName,
      email: hosted.email,
      mode: "hosted",
      signOutPath: chatGPTSignOutPath(returnTo),
    };
  }
  const host = (requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "").split(",")[0].trim();
  if (!localHost(host)) return null;
  const environment = classroomEnvironment();
  const email = environment.CONTINUITY_OPS_LOCAL_OPERATOR_EMAIL?.trim();
  const displayName = environment.CONTINUITY_OPS_LOCAL_OPERATOR_NAME?.trim();
  if (!email || !displayName) return null;
  return { displayName, email, mode: "local", signOutPath: returnTo };
}
