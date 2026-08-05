export const CLASSROOM_SYSTEM_ADMIN_EMAILS = [
  "wy.lee@ntub.edu.tw",
  "kenneth.wy.lee21@gmail.com",
] as const;

export type ClassroomIdentityKind = "administrator" | "ntub_member" | "ineligible";

export function normalizeClassroomEmail(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (normalized.length < 6 || normalized.length > 254 || /\s/u.test(normalized)) return "";
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return "";
  return normalized;
}

export function isNtubClassroomEmail(value: unknown): boolean {
  const email = normalizeClassroomEmail(value);
  return Boolean(email && email.slice(email.lastIndexOf("@") + 1) === "ntub.edu.tw");
}

function configuredAdministratorEmails(configuredEmails?: string): Set<string> {
  return new Set([
    ...CLASSROOM_SYSTEM_ADMIN_EMAILS,
    ...(configuredEmails?.split(",") ?? []),
  ].map((email) => normalizeClassroomEmail(email)).filter(Boolean));
}

export function isClassroomSystemAdministrator(email: unknown, configuredEmails?: string): boolean {
  const normalized = normalizeClassroomEmail(email);
  return Boolean(normalized && configuredAdministratorEmails(configuredEmails).has(normalized));
}

export function classroomIdentityKind(email: unknown, configuredEmails?: string): ClassroomIdentityKind {
  if (isClassroomSystemAdministrator(email, configuredEmails)) return "administrator";
  return isNtubClassroomEmail(email) ? "ntub_member" : "ineligible";
}
