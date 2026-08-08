import { isNtubClassroomEmail, normalizeClassroomEmail } from "./classroom-access.ts";

export type ClassroomRosterDraft = {
  studentId: string;
  email: string;
  displayName: string;
};

export type ClassroomRosterParseResult = {
  entries: ClassroomRosterDraft[];
  errors: string[];
};

const STUDENT_ID_HEADERS = new Set(["學號", "學生學號", "studentid", "studentnumber", "id"]);
const EMAIL_HEADERS = new Set(["email", "電子郵件", "電子郵件地址", "信箱", "學校信箱"]);
const NAME_HEADERS = new Set(["姓名", "學生姓名", "name", "displayname"]);

function normalizedHeader(value: unknown): string {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-]+/gu, "")
    : "";
}

export function normalizeRosterStudentId(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const normalized = String(value).normalize("NFKC").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,31}$/u.test(normalized) ? normalized : "";
}

export function rosterEmailForStudentId(studentId: string): string {
  const normalized = normalizeRosterStudentId(studentId);
  return normalized ? `${normalized}@ntub.edu.tw` : "";
}

function normalizeDisplayName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 120);
}

export function normalizeRosterDraft(value: unknown): ClassroomRosterDraft | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const email = normalizeClassroomEmail(row.email);
  const emailStudentId = email ? email.slice(0, email.lastIndexOf("@")) : "";
  const explicitStudentId = normalizeRosterStudentId(row.studentId);
  const normalizedEmailStudentId = normalizeRosterStudentId(emailStudentId);
  if (explicitStudentId && normalizedEmailStudentId && explicitStudentId !== normalizedEmailStudentId) return null;
  const studentId = explicitStudentId || normalizedEmailStudentId;
  const resolvedEmail = email || rosterEmailForStudentId(studentId);
  if (!studentId || !isNtubClassroomEmail(resolvedEmail)) return null;
  return { studentId, email: resolvedEmail, displayName: normalizeDisplayName(row.displayName) };
}

function deduplicate(entries: ClassroomRosterDraft[], errors: string[]): ClassroomRosterDraft[] {
  const byStudentId = new Map<string, ClassroomRosterDraft>();
  const usedEmails = new Map<string, string>();
  for (const entry of entries) {
    const previousId = usedEmails.get(entry.email);
    if (previousId && previousId !== entry.studentId) {
      errors.push(`信箱 ${entry.email} 同時對應到不同學號。`);
      continue;
    }
    const previous = byStudentId.get(entry.studentId);
    if (previous && previous.email !== entry.email) {
      errors.push(`學號 ${entry.studentId} 同時對應到不同信箱。`);
      continue;
    }
    byStudentId.set(entry.studentId, entry.displayName ? entry : previous ?? entry);
    usedEmails.set(entry.email, entry.studentId);
  }
  return [...byStudentId.values()].sort((a, b) => a.studentId.localeCompare(b.studentId, "en"));
}

export function rosterEntriesFromText(text: string): ClassroomRosterParseResult {
  const entries: ClassroomRosterDraft[] = [];
  const errors: string[] = [];
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].normalize("NFKC").trim();
    if (!line) continue;
    const [identifier, ...nameParts] = line.split(/[\t,]+/u).map((value) => value.trim());
    const email = normalizeClassroomEmail(identifier);
    const studentId = normalizeRosterStudentId(email ? email.slice(0, email.lastIndexOf("@")) : identifier);
    const draft = normalizeRosterDraft({ studentId, email: email || rosterEmailForStudentId(studentId), displayName: nameParts.join(" ") });
    if (!draft) errors.push(`第 ${index + 1} 行不是有效的學號或 NTUB 信箱。`);
    else entries.push(draft);
  }
  return { entries: deduplicate(entries, errors), errors };
}

export function rosterEntriesFromRows(rows: unknown[][]): ClassroomRosterParseResult {
  const errors: string[] = [];
  const firstNonEmpty = rows.findIndex((row) => row.some((cell) => String(cell ?? "").trim()));
  if (firstNonEmpty < 0) return { entries: [], errors: ["Excel 檔案沒有可匯入的資料。"] };
  const headers = rows[firstNonEmpty].map(normalizedHeader);
  const studentIdColumn = headers.findIndex((header) => STUDENT_ID_HEADERS.has(header));
  const emailColumn = headers.findIndex((header) => EMAIL_HEADERS.has(header));
  const nameColumn = headers.findIndex((header) => NAME_HEADERS.has(header));
  if (studentIdColumn < 0 && emailColumn < 0) {
    return { entries: [], errors: ["Excel 第一列必須包含「學號」或「Email」欄位。"] };
  }
  const entries: ClassroomRosterDraft[] = [];
  for (let index = firstNonEmpty + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row.some((cell) => String(cell ?? "").trim())) continue;
    const draft = normalizeRosterDraft({
      studentId: studentIdColumn >= 0 ? row[studentIdColumn] : "",
      email: emailColumn >= 0 ? row[emailColumn] : "",
      displayName: nameColumn >= 0 ? row[nameColumn] : "",
    });
    if (!draft) errors.push(`Excel 第 ${index + 1} 列不是有效的學號或 NTUB 信箱。`);
    else entries.push(draft);
  }
  return { entries: deduplicate(entries, errors), errors };
}

export function normalizeRosterDrafts(value: unknown, maximum = 500): ClassroomRosterDraft[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum) return null;
  const entries: ClassroomRosterDraft[] = [];
  const errors: string[] = [];
  for (const item of value) {
    const entry = normalizeRosterDraft(item);
    if (!entry) return null;
    entries.push(entry);
  }
  const result = deduplicate(entries, errors);
  return errors.length === 0 && result.length === entries.length ? result : null;
}
