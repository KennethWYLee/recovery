export const CLASSROOM_DEFAULT_COURSES = [
  "資料庫",
  "IoT",
  "智慧金融科技",
  "商業智慧",
  "機器學習",
  "AI量化交易",
] as const;

export type ClassroomRole = "teacher" | "student";
export type AcademicTerm = "1" | "2" | "summer";
export type ClassroomSessionPhase =
  | "check_in"
  | "grouping"
  | "answering"
  | "presenting"
  | "ranking"
  | "results"
  | "archived";

export type ClassroomCourse = {
  id: string;
  name: string;
  academicYear: number;
  term: AcademicTerm;
  defaultGroupCapacity: number;
  studentCount: number;
  sessionCount: number;
  activeSessionId: string | null;
  activeSessionPhase: ClassroomSessionPhase | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ClassroomSession = {
  id: string;
  courseId: string;
  title: string;
  question: string;
  rankingCriteria: string;
  joinCode: string;
  phase: ClassroomSessionPhase;
  groupCapacity: number;
  effectiveGroupCapacity: number;
  anonymousGroups: boolean;
  allowRankingEdits: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ClassroomParticipant = {
  id: string;
  userId: string;
  displayName: string;
  email: string | null;
  groupId: string | null;
  attendance: "on_time" | "late";
  joinedPhase: ClassroomSessionPhase;
  canRank: boolean;
  checkedInAt: string;
};

export type ClassroomGroupResponse = {
  content: string;
  status: "draft" | "submitted" | "locked";
  version: number;
  updatedAt: string | null;
};

export type ClassroomGroup = {
  id: string;
  label: string;
  position: number;
  representativeUserId: string | null;
  members: ClassroomParticipant[];
  response: ClassroomGroupResponse;
};

export type ClassroomRankingResult = {
  groupId: string;
  label: string;
  finalRank: number;
  averageRank: number;
  ratingCount: number;
  rankCounts: number[];
  tied: boolean;
};

export type ClassroomSessionSnapshot = {
  session: ClassroomSession;
  participants: ClassroomParticipant[];
  groups: ClassroomGroup[];
  completion: {
    checkedIn: number;
    grouped: number;
    submittedGroups: number;
    rankedStudents: number;
    eligibleStudents: number;
  };
  currentUser: {
    participantId: string | null;
    groupId: string | null;
    isRepresentative: boolean;
    hasSubmittedRanking: boolean;
  };
  results: ClassroomRankingResult[];
  rawRankings: Array<{
    userId: string;
    displayName: string;
    email: string;
    submittedAt: string;
    orderedGroupIds: string[];
  }>;
};

export const SESSION_PHASE_LABELS: Record<ClassroomSessionPhase, string> = {
  check_in: "學生報到",
  grouping: "確認分組",
  answering: "小組作答",
  presenting: "展示回答",
  ranking: "個人排序",
  results: "公布結果",
  archived: "已封存",
};

export const SESSION_PHASE_ORDER: ClassroomSessionPhase[] = [
  "check_in",
  "grouping",
  "answering",
  "presenting",
  "ranking",
  "results",
  "archived",
];

export function normalizeCourseName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

export function normalizeSessionText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").trim().slice(0, maximum);
}

export function courseNameKey(value: string): string {
  return normalizeCourseName(value).toLocaleLowerCase("zh-Hant");
}

export function validCourseName(value: unknown): value is string {
  const name = normalizeCourseName(value);
  return name.length >= 2 && name.length <= 80;
}

export function validAcademicYear(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 999;
}

export function validAcademicTerm(value: unknown): value is AcademicTerm {
  return value === "1" || value === "2" || value === "summer";
}

export function validGroupCapacity(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 2 && Number(value) <= 20;
}

export function validSessionPhase(value: unknown): value is ClassroomSessionPhase {
  return typeof value === "string" && SESSION_PHASE_ORDER.includes(value as ClassroomSessionPhase);
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

export function balancedGroupSizes(participantCount: number, capacity: number): number[] {
  if (!Number.isSafeInteger(participantCount) || participantCount <= 0) return [];
  if (!validGroupCapacity(capacity)) throw new Error("Group capacity is outside the supported range.");
  const groupCount = Math.ceil(participantCount / capacity);
  const minimum = Math.floor(participantCount / groupCount);
  const remainder = participantCount % groupCount;
  return Array.from({ length: groupCount }, (_, index) => minimum + (index < remainder ? 1 : 0));
}

export function nextSessionPhase(phase: ClassroomSessionPhase): ClassroomSessionPhase | null {
  const index = SESSION_PHASE_ORDER.indexOf(phase);
  return index >= 0 && index < SESSION_PHASE_ORDER.length - 1 ? SESSION_PHASE_ORDER[index + 1] : null;
}

export function previousSessionPhase(phase: ClassroomSessionPhase): ClassroomSessionPhase | null {
  const index = SESSION_PHASE_ORDER.indexOf(phase);
  return index > 0 ? SESSION_PHASE_ORDER[index - 1] : null;
}

export function rankResults(
  groups: Array<{ id: string; label: string }>,
  rankings: Array<{ groupId: string; rank: number }>,
): ClassroomRankingResult[] {
  const byGroup = new Map(groups.map((group) => [group.id, { group, ranks: [] as number[] }]));
  for (const item of rankings) {
    const target = byGroup.get(item.groupId);
    if (target && Number.isSafeInteger(item.rank) && item.rank >= 1) target.ranks.push(item.rank);
  }
  const maximumRank = Math.max(1, ...rankings.map((item) => item.rank));
  const compared = [...byGroup.values()].map(({ group, ranks }) => {
    const rankCounts = Array.from({ length: maximumRank }, (_, index) => ranks.filter((rank) => rank === index + 1).length);
    return {
      groupId: group.id,
      label: group.label,
      averageRank: ranks.length ? ranks.reduce((sum, rank) => sum + rank, 0) / ranks.length : Number.POSITIVE_INFINITY,
      ratingCount: ranks.length,
      rankCounts,
    };
  });
  compared.sort((left, right) => {
    if (left.averageRank !== right.averageRank) return left.averageRank - right.averageRank;
    for (let index = 0; index < maximumRank; index += 1) {
      if (left.rankCounts[index] !== right.rankCounts[index]) return right.rankCounts[index] - left.rankCounts[index];
    }
    return left.label.localeCompare(right.label, "zh-Hant");
  });
  const results: ClassroomRankingResult[] = [];
  compared.forEach((entry, index, all) => {
    const previous = all[index - 1];
    const sameDistribution = previous && entry.averageRank === previous.averageRank
      && entry.rankCounts.every((count, rankIndex) => count === previous.rankCounts[rankIndex]);
    const finalRank = sameDistribution ? results[index - 1].finalRank : index + 1;
    const tied = Boolean(sameDistribution || all[index + 1]
      && entry.averageRank === all[index + 1].averageRank
      && entry.rankCounts.every((count, rankIndex) => count === all[index + 1].rankCounts[rankIndex]));
    results.push({ ...entry, averageRank: Number.isFinite(entry.averageRank) ? entry.averageRank : 0, finalRank, tied });
  });
  return results;
}
