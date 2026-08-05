export const CLASSROOM_DEFAULT_COURSES = [
  "資料庫",
  "IoT",
  "智慧金融科技",
  "商業智慧",
  "機器學習",
  "AI量化交易",
] as const;

export type ClassroomRole = "teacher" | "student";

export type ClassroomCourse = {
  id: string;
  name: string;
  academicYear: number;
  term: "1" | "2" | "summer";
  version: number;
  createdAt: string;
  updatedAt: string;
};

export function normalizeCourseName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function courseNameKey(value: string): string {
  return normalizeCourseName(value).toLocaleLowerCase("zh-Hant");
}

export function validCourseName(value: unknown): value is string {
  const name = normalizeCourseName(value);
  return name.length >= 2 && name.length <= 80;
}

export function currentAcademicTerm(now = new Date()): { academicYear: number; term: "1" | "2" } {
  const taipeiParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = Number(taipeiParts.find((part) => part.type === "year")?.value ?? now.getUTCFullYear());
  const month = Number(taipeiParts.find((part) => part.type === "month")?.value ?? now.getUTCMonth() + 1);
  const academicYear = month >= 8 ? year - 1911 : year - 1912;
  return { academicYear, term: month >= 8 || month === 1 ? "1" : "2" };
}

export function courseTermLabel(course: Pick<ClassroomCourse, "academicYear" | "term">): string {
  const term = course.term === "summer" ? "暑期" : `第${course.term}學期`;
  return `${course.academicYear}學年度 ${term}`;
}
