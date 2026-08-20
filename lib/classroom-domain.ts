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
  | "archived";
export type ClassroomQuestionPhase = "draft" | "answering" | "presenting" | "ranking" | "locked" | "published" | "archived";

export type ClassroomCourse = {
  id: string;
  name: string;
  academicYear: number;
  term: AcademicTerm;
  defaultGroupCapacity: number;
  defaultGroupCount: number;
  isDemo: boolean;
  studentCount: number;
  rosterCount: number;
  questionBankCount: number;
  sessionCount: number;
  activeSessionId: string | null;
  activeSessionPhase: ClassroomSessionPhase | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ClassroomQuestionBankItem = {
  id: string;
  courseId: string;
  title: string;
  category: string;
  questionText: string;
  rankingCriteria: string;
  status: "draft" | "ready";
  usageCount: number;
  lastUsedAt: string | null;
  usedInCurrentSession: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ClassroomSession = {
  id: string;
  courseId: string;
  title: string;
  joinCode: string;
  phase: ClassroomSessionPhase;
  groupCount: number;
  effectiveGroupCapacity: number;
  anonymousGroups: boolean;
  allowRankingEdits: boolean;
  admissionOpen: boolean;
  qrEnabled: boolean;
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

export type ClassroomQuestion = {
  id: string;
  sessionId: string;
  text: string;
  rankingCriteria: string;
  phase: ClassroomQuestionPhase;
  answerDurationSeconds: number;
  answerDeadlineAt: string | null;
  position: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ClassroomRawRankingItem = {
  userId: string;
  ownGroupId: string;
  groupId: string;
  rank: number;
};

export type ClassroomQuestionSummary = ClassroomQuestion & {
  submittedGroups: number;
  rankedStudents: number;
  teacherRanked: boolean;
  leaderLabel: string | null;
  leaderAverageScore: number | null;
};

export type ClassroomSavedRanking = {
  submittedAt: string;
  orderedGroupIds: string[];
};

export type ClassroomRankingResult = {
  groupId: string;
  label: string;
  finalRank: number;
  averageScore: number;
  maximumScore: number;
  ratingCount: number;
  rankCounts: number[];
  tied: boolean;
};

export type ClassroomStudentQuestionParticipation = {
  questionId: string;
  eligible: boolean;
  rankingCompleted: boolean;
  representativeSubmitted: boolean;
};

export type ClassroomStudentParticipation = {
  userId: string;
  displayName: string;
  email: string;
  attendance: "on_time" | "late";
  joinedPhase: ClassroomSessionPhase;
  checkedInAt: string;
  groupLabel: string | null;
  eligibleQuestionCount: number;
  rankingOpportunityCount: number;
  completedRankingCount: number;
  representativeSubmissionCount: number;
  completionRate: number | null;
  questions: ClassroomStudentQuestionParticipation[];
};

export type ClassroomParticipationReport = {
  generatedAt: string;
  sessionId: string;
  questions: Array<Pick<ClassroomQuestion, "id" | "text" | "position" | "phase">>;
  students: ClassroomStudentParticipation[];
};

export type ClassroomSessionSnapshot = {
  serverNow: string;
  session: ClassroomSession;
  questions: ClassroomQuestionSummary[];
  question: ClassroomQuestion | null;
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
    participatesInQuestion: boolean;
    canRank: boolean;
    hasSubmittedRanking: boolean;
    orderedGroupIds: string[];
  };
  teacherRanking: ClassroomSavedRanking | null;
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
  answering: "課堂進行中",
  archived: "已封存",
};

export const SESSION_PHASE_ORDER: ClassroomSessionPhase[] = [
  "check_in",
  "grouping",
  "answering",
  "archived",
];

export const QUESTION_PHASE_LABELS: Record<ClassroomQuestionPhase, string> = {
  draft: "尚未開放",
  answering: "小組作答中",
  presenting: "答案展示中",
  ranking: "個人排序中",
  locked: "排序已鎖定",
  published: "結果已公布",
  archived: "已封存",
};

export const QUESTION_PHASE_ORDER: ClassroomQuestionPhase[] = [
  "draft", "answering", "presenting", "ranking", "locked", "published", "archived",
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

export function validGroupCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 2 && Number(value) <= 20;
}

export function validDemoStudentId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^demo-user-(?:[1-9]|1\d|2[0-4])$/u.test(value.trim());
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

export function balancedGroupSizesByCount(participantCount: number, groupCount: number): number[] {
  if (!Number.isSafeInteger(participantCount) || participantCount <= 0) return [];
  if (!Number.isSafeInteger(groupCount) || groupCount < 2 || groupCount > 20) {
    throw new Error("Group count is outside the supported range.");
  }
  if (groupCount > participantCount) throw new Error("Group count exceeds participant count.");
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

export function nextQuestionPhase(phase: ClassroomQuestionPhase): ClassroomQuestionPhase | null {
  const index = QUESTION_PHASE_ORDER.indexOf(phase);
  return index >= 0 && index < QUESTION_PHASE_ORDER.length - 1 ? QUESTION_PHASE_ORDER[index + 1] : null;
}

export function rankResults(
  groups: Array<{ id: string; label: string }>,
  rankings: Array<{ groupId: string; rank: number }>,
): ClassroomRankingResult[] {
  const byGroup = new Map(groups.map((group) => [group.id, { group, ranks: [] as number[] }]));
  const acceptedRanks: number[] = [];
  for (const item of rankings) {
    const target = byGroup.get(item.groupId);
    if (target && Number.isSafeInteger(item.rank) && item.rank >= 1) {
      target.ranks.push(item.rank);
      acceptedRanks.push(item.rank);
    }
  }
  const maximumRank = Math.max(1, ...acceptedRanks);
  const compared = [...byGroup.values()].map(({ group, ranks }) => {
    const rankCounts = Array.from({ length: maximumRank }, (_, index) => ranks.filter((rank) => rank === index + 1).length);
    const scores = ranks.map((rank) => maximumRank - rank + 1);
    return {
      groupId: group.id,
      label: group.label,
      averageScore: scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0,
      maximumScore: maximumRank,
      ratingCount: ranks.length,
      rankCounts,
    };
  });
  compared.sort((left, right) => {
    if (left.averageScore !== right.averageScore) return right.averageScore - left.averageScore;
    for (let index = 0; index < maximumRank; index += 1) {
      if (left.rankCounts[index] !== right.rankCounts[index]) return right.rankCounts[index] - left.rankCounts[index];
    }
    return left.label.localeCompare(right.label, "zh-Hant");
  });
  const results: ClassroomRankingResult[] = [];
  compared.forEach((entry, index, all) => {
    const previous = all[index - 1];
    const sameDistribution = previous && entry.averageScore === previous.averageScore
      && entry.rankCounts.every((count, rankIndex) => count === previous.rankCounts[rankIndex]);
    const finalRank = sameDistribution ? results[index - 1].finalRank : index + 1;
    const tied = Boolean(sameDistribution || all[index + 1]
      && entry.averageScore === all[index + 1].averageScore
      && entry.rankCounts.every((count, rankIndex) => count === all[index + 1].rankCounts[rankIndex]));
    results.push({ ...entry, finalRank, tied });
  });
  return results;
}

export function rankingsExcludingOwnGroup(items: ClassroomRawRankingItem[]): Array<{ groupId: string; rank: number }> {
  const byUser = new Map<string, ClassroomRawRankingItem[]>();
  for (const item of items) {
    const current = byUser.get(item.userId) ?? [];
    current.push(item);
    byUser.set(item.userId, current);
  }
  return [...byUser.values()].flatMap((ranking) => ranking
    .filter((item) => item.groupId !== item.ownGroupId)
    .sort((left, right) => left.rank - right.rank)
    .map((item, index) => ({ groupId: item.groupId, rank: index + 1 })));
}

export function classroomAnswerWindowError(
  phase: ClassroomQuestionPhase,
  deadlineAt: string | null,
  now: string,
): "ANSWERING_CLOSED" | "ANSWER_DEADLINE_PASSED" | null {
  if (phase !== "answering") return "ANSWERING_CLOSED";
  if (deadlineAt && now >= deadlineAt) return "ANSWER_DEADLINE_PASSED";
  return null;
}

export function completeClassroomRankingOrder(value: unknown, expectedGroupIds: readonly string[]): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) return null;
  const submitted = value as string[];
  if (submitted.length !== expectedGroupIds.length || new Set(submitted).size !== submitted.length) return null;
  return expectedGroupIds.every((id) => submitted.includes(id)) ? submitted : null;
}

export function rankingPosition(orderedGroupIds: readonly string[], groupId: string): number | null {
  const index = orderedGroupIds.indexOf(groupId);
  return index >= 0 ? index + 1 : null;
}

export function rankingOrderExcludingGroup(
  orderedGroupIds: readonly string[],
  excludedGroupId: string | null,
): string[] {
  return excludedGroupId
    ? orderedGroupIds.filter((groupId) => groupId !== excludedGroupId)
    : [...orderedGroupIds];
}
