import {
  balancedGroupSizesByCount,
  classroomAnswerWindowError,
  completeClassroomRankingOrder,
  nextQuestionPhase,
  normalizeSessionText,
  type ClassroomGroup,
  type ClassroomQuestion,
  type ClassroomQuestionPhase,
  type ClassroomQuestionSummary,
  type ClassroomSavedRanking,
  type ClassroomSession,
  type ClassroomSessionPhase,
  type ClassroomSessionSnapshot,
} from "@/lib/classroom-domain";
import { classroomGroupsForViewer, classroomQuestionGroupId, studentMaySeeGroupNames } from "@/lib/classroom-privacy";
import { classroomId, classroomNow, type ClassroomActor } from "./classroom";
import {
  guardedClassroomRankingBatch,
  guardedClassroomResponseWrite,
  questionAdvanceEvidenceFailure,
} from "./classroom-live-security";
import { readSnapshotBase, readSnapshotDetails, snapshotRanks } from "./classroom-snapshot-data";
import { ClassroomWorkflowError } from "./classroom-errors";

export { ClassroomWorkflowError } from "./classroom-errors";

type SessionRow = {
  id: string; course_id: string; title: string; join_code: string; phase: ClassroomSessionPhase;
  group_count: number; effective_group_capacity: number; anonymous_groups: number;
  allow_ranking_edits: number; admission_open: number; qr_enabled: number; version: number; created_by_user_id: string;
  created_at: string; updated_at: string;
};

type QuestionRow = {
  id: string; session_id: string; question_text: string; ranking_criteria: string;
  phase: ClassroomQuestionPhase; answer_duration_seconds: number; answer_deadline_at: string | null; created_by_user_id: string;
  position: number; version: number; created_at: string; updated_at: string;
};

const QUESTION_COLUMNS = `id, session_id, question_text, ranking_criteria, phase,
  answer_duration_seconds, answer_deadline_at, position, version, created_by_user_id, created_at, updated_at`;

const SESSION_COLUMNS = `id, course_id, title, join_code, phase, group_count,
  effective_group_capacity, anonymous_groups, allow_ranking_edits,
  admission_open, qr_enabled, version, created_by_user_id, created_at, updated_at`;

function mapSession(row: SessionRow): ClassroomSession {
  return {
    id: row.id, courseId: row.course_id, title: row.title, joinCode: row.join_code,
    phase: row.phase, groupCount: row.group_count,
    effectiveGroupCapacity: row.effective_group_capacity,
    anonymousGroups: row.anonymous_groups === 1,
    allowRankingEdits: row.allow_ranking_edits === 1,
    admissionOpen: row.admission_open === 1,
    qrEnabled: row.qr_enabled === 1,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapQuestion(row: QuestionRow): ClassroomQuestion {
  return {
    id: row.id, sessionId: row.session_id, text: row.question_text,
    rankingCriteria: row.ranking_criteria, phase: row.phase,
    answerDurationSeconds: row.answer_duration_seconds,
    answerDeadlineAt: row.answer_deadline_at,
    position: row.position, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

async function actorCanAccessCourse(db: D1Database, actor: ClassroomActor, courseId: string): Promise<boolean> {
  if (actor.isAdmin) {
    return Boolean(await db.prepare("SELECT id FROM classroom_courses WHERE id = ? AND status = 'active'")
      .bind(courseId).first<{ id: string }>());
  }
  return Boolean(await db.prepare(
    `SELECT c.id FROM classroom_courses c
     JOIN classroom_course_members m ON m.course_id = c.id
     WHERE c.id = ? AND c.status = 'active' AND m.user_id = ? AND m.status = 'active'`,
  ).bind(courseId, actor.id).first<{ id: string }>());
}

export async function requireSession(db: D1Database, actor: ClassroomActor, sessionId: string): Promise<SessionRow> {
  const row = await db.prepare(`SELECT ${SESSION_COLUMNS.split(",").map((column) => `s.${column.trim()}`).join(", ")}
    FROM classroom_sessions s JOIN classroom_courses c ON c.id = s.course_id AND c.status = 'active'
    WHERE s.id = ? AND (? = 1 OR EXISTS (SELECT 1 FROM classroom_course_members m WHERE m.course_id = c.id AND m.user_id = ? AND m.status = 'active'))`)
    .bind(sessionId, actor.isAdmin ? 1 : 0, actor.id).first<SessionRow>();
  if (!row) {
    throw new ClassroomWorkflowError(404, "SESSION_NOT_FOUND", "找不到這次課堂，或你沒有查看權限。");
  }
  return row;
}

async function requireQuestion(db: D1Database, sessionId: string, questionId: string): Promise<QuestionRow> {
  const row = await db.prepare(
    `SELECT ${QUESTION_COLUMNS}
     FROM classroom_questions WHERE id = ? AND session_id = ?`,
  ).bind(questionId, sessionId).first<QuestionRow>();
  if (!row) throw new ClassroomWorkflowError(404, "QUESTION_NOT_FOUND", "找不到這個問題。");
  return row;
}

function randomJoinCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

function shuffled<T>(values: T[]): T[] {
  const result = [...values];
  const random = crypto.getRandomValues(new Uint32Array(Math.max(1, result.length)));
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = random[index] % (index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function placeholders(rows: number, columns: number): string {
  return Array.from({ length: rows }, () => `(${Array.from({ length: columns }, () => "?").join(", ")})`).join(", ");
}

function actorMayRankQuestion(actor: ClassroomActor, question: QuestionRow | undefined, membershipCanRank: boolean): boolean {
  if (!question) return false;
  return actor.isAdmin ? question.phase === "ranking" && question.created_by_user_id === actor.id : membershipCanRank;
}

function actorHasCurrentRanking(actor: ClassroomActor, current: ClassroomSavedRanking | null, studentUsers: Set<string>): boolean {
  return actor.isAdmin ? Boolean(current) : studentUsers.has(actor.id);
}

async function requireRankingActor(db: D1Database, actor: ClassroomActor, question: QuestionRow): Promise<void> {
  if (actor.isAdmin) {
    if (question.created_by_user_id !== actor.id) {
      throw new ClassroomWorkflowError(403, "TEACHER_RANKING_OWNER_REQUIRED", "只有建立本題的教師可以提交教師排序。");
    }
    return;
  }
  const membership = await db.prepare(
    "SELECT can_rank FROM classroom_question_memberships WHERE question_id = ? AND user_id = ?",
  ).bind(question.id, actor.id).first<{ can_rank: number }>();
  if (membership?.can_rank !== 1) {
    throw new ClassroomWorkflowError(403, "RANKING_NOT_ALLOWED", "你目前不能提交這一題的排序。");
  }
}

export async function createClassroomSession(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  values: { title: unknown; groupCount: number; anonymousGroups: boolean; allowRankingEdits: boolean; qrEnabled: boolean },
): Promise<ClassroomSession> {
  if (!actor.isAdmin || !await actorCanAccessCourse(db, actor, courseId)) {
    throw new ClassroomWorkflowError(403, "COURSE_MANAGEMENT_REQUIRED", "只有系統管理員可以建立今日課堂。");
  }
  const title = normalizeSessionText(values.title, 100);
  if (title.length < 2) throw new ClassroomWorkflowError(400, "INVALID_SESSION_CONTENT", "請填寫本次課堂名稱。");
  if (!Number.isInteger(values.groupCount) || values.groupCount < 2 || values.groupCount > 20) {
    throw new ClassroomWorkflowError(400, "INVALID_GROUP_COUNT", "分組組數必須介於 2 至 20 組。");
  }
  const active = await db.prepare("SELECT id FROM classroom_sessions WHERE course_id = ? AND phase != 'archived' LIMIT 1")
    .bind(courseId).first<{ id: string }>();
  if (active) throw new ClassroomWorkflowError(409, "ACTIVE_SESSION_EXISTS", "這門課已有進行中的課堂，請先封存它。");

  const sessionId = classroomId("session");
  const now = classroomNow();
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const joinCode = randomJoinCode();
    try {
      await db.batch([
        db.prepare(
          `INSERT INTO classroom_sessions
            (id, course_id, title, question, ranking_criteria, join_code, phase,
             group_capacity, effective_group_capacity, anonymous_groups, allow_ranking_edits,
             group_count, admission_open, qr_enabled, version, created_by_user_id, created_at, updated_at)
           VALUES (?, ?, ?, '尚未建立問題', '尚未設定排序判準', ?, 'check_in',
             20, 20, ?, ?, ?, 1, ?, 1, ?, ?, ?)`,
        ).bind(sessionId, courseId, title, joinCode, values.anonymousGroups ? 1 : 0,
          values.allowRankingEdits ? 1 : 0, values.groupCount, values.qrEnabled ? 1 : 0,
          actor.id, now, now),
        db.prepare(
          `INSERT INTO classroom_audit_events
            (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
           VALUES (?, ?, 'session.create', 'classroom_session', ?, ?, ?)`,
        ).bind(classroomId("class-audit"), actor.id, sessionId, JSON.stringify({ courseId, groupCount: values.groupCount }), now),
      ]);
      const row = await db.prepare(`SELECT ${SESSION_COLUMNS} FROM classroom_sessions WHERE id = ?`)
        .bind(sessionId).first<SessionRow>();
      if (!row) throw new Error("Created session was not found.");
      return mapSession(row);
    } catch (error) {
      lastError = error;
      if (!/join_code/iu.test(error instanceof Error ? error.message : String(error))) break;
    }
  }
  if (/course_active|classroom_sessions\.course_id/iu.test(lastError instanceof Error ? lastError.message : String(lastError))) {
    throw new ClassroomWorkflowError(409, "ACTIVE_SESSION_EXISTS", "這門課已有進行中的課堂，請先封存它。");
  }
  throw lastError;
}

export async function activeClassroomSession(
  db: D1Database, actor: ClassroomActor, courseId: string, questionId?: string | null,
): Promise<ClassroomSessionSnapshot | null> {
  const row = await db.prepare(
    `SELECT s.id FROM classroom_sessions s JOIN classroom_courses c ON c.id = s.course_id AND c.status = 'active'
     WHERE s.course_id = ? AND s.phase != 'archived' AND (? = 1 OR EXISTS (SELECT 1 FROM classroom_course_members m WHERE m.course_id = c.id AND m.user_id = ? AND m.status = 'active'))
     ORDER BY s.created_at DESC LIMIT 1`,
  ).bind(courseId, actor.isAdmin ? 1 : 0, actor.id).first<{ id: string }>();
  return row ? classroomSessionSnapshot(db, actor, row.id, questionId) : null;
}

export async function classroomSessionSnapshot(
  db: D1Database, actor: ClassroomActor, sessionId: string, requestedQuestionId?: string | null,
): Promise<ClassroomSessionSnapshot> {
  const sessionRow = await requireSession(db, actor, sessionId);
  const session = mapSession(sessionRow);
  const base = await readSnapshotBase<QuestionRow>(db, actor, sessionId, QUESTION_COLUMNS);
  const participants = base.participants; const participantTotals = base.totals;
  const baseGroupRows = { results: base.groups }; const questionRows = { results: base.questions };
  const visibleRows = questionRows.results;
  let selectedRow = requestedQuestionId ? visibleRows.find((row) => row.id === requestedQuestionId) : undefined;
  if (!selectedRow) selectedRow = visibleRows.find((row) => ["answering", "presenting", "ranking", "locked"].includes(row.phase));
  if (!selectedRow) selectedRow = [...visibleRows].reverse().find((row) => row.phase === "published");
  if (!selectedRow && actor.isAdmin) selectedRow = visibleRows[0];
  const question = selectedRow ? mapQuestion(selectedRow) : null;

  const showResults = Boolean(question && (actor.isAdmin ? ["locked", "published", "archived"].includes(question.phase) : ["published", "archived"].includes(question.phase)));
  const details = await readSnapshotDetails(db, actor, sessionId, question?.id ?? null, showResults);
  const responseRows = { results: details.responses };
  const responseByGroup = new Map(responseRows.results.map((row) => [row.group_id, row]));
  const currentParticipant = participants.find((participant) => participant.userId === actor.id) ?? null;
  const membership = details.membership;
  const questionGroupId = classroomQuestionGroupId(Boolean(question), membership?.group_id ?? null, currentParticipant?.groupId ?? null);
  const publicResponses = Boolean(question && ["presenting", "ranking", "locked", "published", "archived"].includes(question.phase));
  const internalGroups: ClassroomGroup[] = baseGroupRows.results.map((row) => {
    const response = responseByGroup.get(row.id);
    const mayRead = actor.isAdmin || publicResponses || questionGroupId === row.id;
    return {
      id: row.id, label: row.label, position: row.position,
      representativeUserId: row.representative_user_id,
      members: participants.filter((participant) => participant.groupId === row.id),
      response: {
        content: mayRead ? response?.content ?? "" : "",
        status: response?.status ?? "draft", version: response?.version ?? 1,
        updatedAt: response?.updated_at ?? null,
      },
    };
  });
  const groups = classroomGroupsForViewer(internalGroups, actor.isAdmin, !studentMaySeeGroupNames(question?.phase, session.anonymousGroups));

  const groupLabels = groups.map((group) => ({ id: group.id, label: group.label }));
  const summaryCountRows = details.counts;
  const summaryCounts = new Map(summaryCountRows.map((row) => [row.id, row]));
  const summaries: ClassroomQuestionSummary[] = visibleRows.map((row) => ({
    ...mapQuestion(row),
    submittedGroups: summaryCounts.get(row.id)?.submitted_groups ?? 0,
    rankedStudents: summaryCounts.get(row.id)?.ranked_students ?? 0,
    teacherRanked: summaryCounts.get(row.id)?.teacher_ranked === 1,
    leaderLabel: null,
    leaderAverageScore: null,
  }));

  const submittedUsers = details.submittedUsers;
  const { currentRanking, teacherRanking, rawRankings, results } = snapshotRanks(details.ranks, details.responses, actor, showResults, groupLabels, question?.phase);
  if (question?.phase === "published" && results[0]) {
    const summary = summaries.find((item) => item.id === question.id);
    if (summary) {
      summary.leaderLabel = results[0].label;
      summary.leaderAverageScore = results[0].averageScore;
    }
  }
  const orderedGroupIds = currentRanking?.orderedGroupIds ?? [];
  const eligible = { count: details.eligible };
  return {
    serverNow: classroomNow(), session, questions: summaries, question,
    participants: actor.isAdmin ? participants : [], groups,
    completion: {
      checkedIn: participantTotals.checked_in,
      grouped: participantTotals.grouped,
      submittedGroups: internalGroups.filter((group) => ["submitted", "locked"].includes(group.response.status)).length,
      rankedStudents: submittedUsers.size,
      eligibleStudents: eligible?.count ?? 0,
    },
    currentUser: {
      participantId: currentParticipant?.id ?? null, groupId: questionGroupId,
      isRepresentative: internalGroups.some((group) => group.id === questionGroupId && group.representativeUserId === actor.id),
      participatesInQuestion: Boolean(membership),
      canRank: actorMayRankQuestion(actor, selectedRow, membership?.can_rank === 1),
      hasSubmittedRanking: actorHasCurrentRanking(actor, currentRanking, submittedUsers),
      orderedGroupIds,
    },
    teacherRanking, results, rawRankings,
  };
}

export async function joinClassroomSession(
  db: D1Database, actor: ClassroomActor, joinCodeValue: unknown,
): Promise<ClassroomSessionSnapshot> {
  const joinCode = typeof joinCodeValue === "string" ? joinCodeValue.trim().toUpperCase() : "";
  if (!/^[23456789A-HJ-NP-Z]{6}$/u.test(joinCode)) {
    throw new ClassroomWorkflowError(404, "JOIN_CODE_NOT_FOUND", "課堂代碼錯誤或尚未開放。");
  }
  const session = await db.prepare(
    `SELECT ${SESSION_COLUMNS} FROM classroom_sessions
     WHERE join_code = ? AND phase != 'archived' AND admission_open = 1`,
  ).bind(joinCode).first<SessionRow>();
  if (!session) throw new ClassroomWorkflowError(404, "JOIN_CODE_NOT_FOUND", "課堂代碼錯誤或尚未開放。");
  const existing = await db.prepare(
    "SELECT id FROM classroom_session_participants WHERE session_id = ? AND user_id = ?",
  ).bind(session.id, actor.id).first<{ id: string }>();
  if (!existing) {
    const now = classroomNow();
    const late = session.phase !== "check_in";
    let groupId: string | null = null;
    if (session.phase === "grouping" || session.phase === "answering") {
      const group = await db.prepare(
        `SELECT g.id, COUNT(p.id) AS member_count
         FROM classroom_groups g LEFT JOIN classroom_session_participants p ON p.group_id = g.id
         WHERE g.session_id = ? GROUP BY g.id, g.position ORDER BY member_count, random() LIMIT 1`,
      ).bind(session.id).first<{ id: string; member_count: number }>();
      groupId = group?.id ?? null;
    }
    await db.batch([
      db.prepare(
        `INSERT INTO classroom_course_members
          (id, course_id, user_id, role, status, joined_at, updated_at)
         VALUES (?, ?, ?, 'student', 'active', ?, ?)
         ON CONFLICT(course_id, user_id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at`,
      ).bind(classroomId("course-member"), session.course_id, actor.id, now, now),
      db.prepare(
        `INSERT INTO classroom_session_participants
          (id, session_id, user_id, group_id, attendance, joined_phase, can_rank, checked_in_at, grouped_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(classroomId("participant"), session.id, actor.id, groupId, late ? "late" : "on_time", session.phase, now, groupId ? now : null, now),
      db.prepare(
        `INSERT INTO classroom_audit_events
          (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
         VALUES (?, ?, 'session.check_in', 'classroom_session', ?, ?, ?)`,
      ).bind(classroomId("class-audit"), actor.id, session.id, JSON.stringify({ late, groupId }), now),
    ]);
  }
  return classroomSessionSnapshot(db, actor, session.id);
}

async function createBalancedGroups(db: D1Database, actor: ClassroomActor, session: SessionRow): Promise<void> {
  const rows = await db.prepare(
    "SELECT id, user_id FROM classroom_session_participants WHERE session_id = ? ORDER BY checked_in_at, id",
  ).bind(session.id).all<{ id: string; user_id: string }>();
  if (rows.results.length < session.group_count) {
    throw new ClassroomWorkflowError(409, "NOT_ENOUGH_PARTICIPANTS", `目前只有 ${rows.results.length} 位學生，無法建立 ${session.group_count} 組。`);
  }
  const participants = shuffled(rows.results);
  const sizes = balancedGroupSizesByCount(participants.length, session.group_count);
  const now = classroomNow();
  const groups: Array<{ id: string; label: string; position: number; representative: string; memberIds: string[] }> = [];
  let offset = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    const members = participants.slice(offset, offset + sizes[index]);
    offset += sizes[index];
    groups.push({ id: classroomId("group"), label: `第 ${index + 1} 組`, position: index + 1, representative: members[0].user_id, memberIds: members.map((item) => item.id) });
  }
  const statements: D1PreparedStatement[] = [];
  for (const group of groups) {
    statements.push(
      db.prepare(
        `INSERT INTO classroom_groups
          (id, session_id, label, position, representative_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(group.id, session.id, group.label, group.position, group.representative, now, now),
      db.prepare(
        `UPDATE classroom_session_participants SET group_id = ?, grouped_at = ?, updated_at = ?
         WHERE session_id = ? AND id IN (${group.memberIds.map(() => "?").join(", ")})`,
      ).bind(group.id, now, now, session.id, ...group.memberIds),
    );
  }
  statements.push(
    db.prepare(
      `UPDATE classroom_sessions SET phase = 'grouping', effective_group_capacity = MAX(group_capacity, ?), version = version + 1, updated_at = ?
       WHERE id = ? AND phase = 'check_in' AND version = ?`,
    ).bind(Math.max(...sizes), now, session.id, session.version),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'session.group', 'classroom_session', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, session.id, JSON.stringify({ groups: groups.length, participants: participants.length }), now),
  );
  await db.batch(statements);
}

export async function advanceClassroomSession(
  db: D1Database, actor: ClassroomActor, sessionId: string, expectedVersion: number,
): Promise<ClassroomSessionSnapshot> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以控制課堂流程。");
  const session = await requireSession(db, actor, sessionId);
  if (session.version !== expectedVersion) throw new ClassroomWorkflowError(409, "SESSION_VERSION_CONFLICT", "課堂狀態已更新，請重新載入。");
  if (session.phase === "check_in") {
    await createBalancedGroups(db, actor, session);
    return classroomSessionSnapshot(db, actor, sessionId);
  }
  let target: ClassroomSessionPhase;
  if (session.phase === "grouping") {
    const incomplete = await db.prepare(
      `SELECT COUNT(*) AS count FROM classroom_groups g
       WHERE g.session_id = ? AND (g.representative_user_id IS NULL OR NOT EXISTS
         (SELECT 1 FROM classroom_session_participants p WHERE p.group_id = g.id AND p.user_id = g.representative_user_id))`,
    ).bind(sessionId).first<{ count: number }>();
    if ((incomplete?.count ?? 0) > 0) throw new ClassroomWorkflowError(409, "GROUPING_INCOMPLETE", "請先確認每組都有作答代表。");
    target = "answering";
  } else if (session.phase === "answering") {
    const active = await db.prepare(
      "SELECT id FROM classroom_questions WHERE session_id = ? AND phase IN ('answering','presenting','ranking','locked') LIMIT 1",
    ).bind(sessionId).first<{ id: string }>();
    if (active) throw new ClassroomWorkflowError(409, "QUESTION_STILL_ACTIVE", "請先完成或公布目前問題，再封存課堂。");
    target = "archived";
  } else {
    throw new ClassroomWorkflowError(409, "SESSION_ALREADY_ARCHIVED", "這次課堂已經封存。");
  }
  const now = classroomNow();
  await db.batch([
    db.prepare("UPDATE classroom_sessions SET phase = ?, admission_open = CASE WHEN ? = 'archived' THEN 0 ELSE admission_open END, version = version + 1, updated_at = ? WHERE id = ? AND version = ?")
      .bind(target, target, now, sessionId, expectedVersion),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'session.advance', 'classroom_session', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, sessionId, JSON.stringify({ from: session.phase, to: target }), now),
  ]);
  return classroomSessionSnapshot(db, actor, sessionId);
}

export async function rollbackClassroomSession(
  db: D1Database, actor: ClassroomActor, sessionId: string, expectedVersion: number,
): Promise<never> {
  void db; void actor; void sessionId; void expectedVersion;
  throw new ClassroomWorkflowError(409, "SESSION_ROLLBACK_NOT_ALLOWED", "課堂開始後不會回到上一階段；需要調整時請修改本次課堂設定。");
}

export async function updateClassroomSessionSettings(
  db: D1Database, actor: ClassroomActor, sessionId: string, expectedVersion: number,
  values: { title: unknown; groupCount?: number; anonymousGroups: boolean; allowRankingEdits: boolean; admissionOpen: boolean; qrEnabled: boolean },
): Promise<ClassroomSessionSnapshot> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以修改課堂設定。");
  const session = await requireSession(db, actor, sessionId);
  if (session.version !== expectedVersion) throw new ClassroomWorkflowError(409, "SESSION_VERSION_CONFLICT", "課堂設定已更新，請重新載入。");
  const title = normalizeSessionText(values.title, 100);
  if (title.length < 2) throw new ClassroomWorkflowError(400, "INVALID_SESSION_CONTENT", "請填寫本次課堂名稱。");
  const groupCount = values.groupCount ?? session.group_count;
  if (!Number.isInteger(groupCount) || groupCount < 2 || groupCount > 20) throw new ClassroomWorkflowError(400, "INVALID_GROUP_COUNT", "分組組數必須介於 2 至 20 組。");
  if (session.phase !== "check_in" && groupCount !== session.group_count) {
    throw new ClassroomWorkflowError(409, "GROUP_COUNT_LOCKED", "新增組別請使用學生表格的「新增一組」；其他設定仍可調整。");
  }
  const now = classroomNow();
  await db.batch([
    db.prepare(
      `UPDATE classroom_sessions SET title = ?, group_count = ?, anonymous_groups = ?, allow_ranking_edits = ?,
         admission_open = ?, qr_enabled = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`,
    ).bind(title, groupCount, values.anonymousGroups ? 1 : 0, values.allowRankingEdits ? 1 : 0,
      values.admissionOpen ? 1 : 0, values.qrEnabled ? 1 : 0, now, sessionId, expectedVersion),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'session.settings.update', 'classroom_session', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, sessionId, JSON.stringify({ title, groupCount, admissionOpen: values.admissionOpen }), now),
  ]);
  return classroomSessionSnapshot(db, actor, sessionId);
}

export async function moveClassroomParticipant(
  db: D1Database, actor: ClassroomActor, sessionId: string, participantId: string, targetGroupId: string,
): Promise<ClassroomSessionSnapshot> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以調整分組。");
  const session = await requireSession(db, actor, sessionId);
  if (session.phase !== "grouping" && session.phase !== "answering") throw new ClassroomWorkflowError(409, "GROUPING_LOCKED", "目前不能調整分組。");
  const participant = await db.prepare(
    "SELECT user_id, group_id FROM classroom_session_participants WHERE id = ? AND session_id = ?",
  ).bind(participantId, sessionId).first<{ user_id: string; group_id: string | null }>();
  const target = await db.prepare("SELECT id FROM classroom_groups WHERE id = ? AND session_id = ?")
    .bind(targetGroupId, sessionId).first<{ id: string }>();
  if (!participant || !target) throw new ClassroomWorkflowError(404, "GROUP_MEMBER_NOT_FOUND", "找不到指定學生或小組。");
  if (participant.group_id === targetGroupId) return classroomSessionSnapshot(db, actor, sessionId);
  const now = classroomNow();
  const statements: D1PreparedStatement[] = [
    db.prepare("UPDATE classroom_session_participants SET group_id = ?, grouped_at = ?, updated_at = ? WHERE id = ? AND session_id = ?")
      .bind(targetGroupId, now, now, participantId, sessionId),
    db.prepare("UPDATE classroom_groups SET representative_user_id = NULL, updated_at = ? WHERE session_id = ? AND representative_user_id = ? AND id != ?")
      .bind(now, sessionId, participant.user_id, targetGroupId),
  ];
  const answering = await db.prepare("SELECT id FROM classroom_questions WHERE session_id = ? AND phase = 'answering' LIMIT 1")
    .bind(sessionId).first<{ id: string }>();
  if (answering) {
    statements.push(db.prepare("UPDATE classroom_question_memberships SET group_id = ? WHERE question_id = ? AND user_id = ?")
      .bind(targetGroupId, answering.id, participant.user_id));
  }
  statements.push(db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'group.move_member', 'classroom_session', ?, ?, ?)`,
  ).bind(classroomId("class-audit"), actor.id, sessionId, JSON.stringify({ participantId, from: participant.group_id, to: targetGroupId }), now));
  await db.batch(statements);
  return classroomSessionSnapshot(db, actor, sessionId);
}

export async function setClassroomRepresentative(
  db: D1Database, actor: ClassroomActor, sessionId: string, groupId: string, userId: string,
): Promise<ClassroomSessionSnapshot> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以指定作答代表。");
  await requireSession(db, actor, sessionId);
  const member = await db.prepare(
    "SELECT user_id FROM classroom_session_participants WHERE session_id = ? AND group_id = ? AND user_id = ?",
  ).bind(sessionId, groupId, userId).first<{ user_id: string }>();
  if (!member) throw new ClassroomWorkflowError(400, "REPRESENTATIVE_NOT_IN_GROUP", "作答代表必須是該組成員。");
  const now = classroomNow();
  await db.batch([
    db.prepare("UPDATE classroom_groups SET representative_user_id = ?, updated_at = ? WHERE id = ? AND session_id = ?")
      .bind(userId, now, groupId, sessionId),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'group.set_representative', 'classroom_group', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, groupId, JSON.stringify({ sessionId, userId }), now),
  ]);
  return classroomSessionSnapshot(db, actor, sessionId);
}

export async function createClassroomQuestion(
  db: D1Database, actor: ClassroomActor, sessionId: string,
  values: { questionText: unknown; rankingCriteria: unknown; questionBankId?: unknown; answerDurationSeconds?: unknown },
): Promise<ClassroomSessionSnapshot> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以新增問題。");
  const session = await requireSession(db, actor, sessionId);
  if (session.phase !== "answering") throw new ClassroomWorkflowError(409, "SESSION_NOT_LIVE", "請完成分組並開始課堂後再新增問題。");
  const requestedBankId = typeof values.questionBankId === "string" ? values.questionBankId.trim() : "";
  const bankItem = requestedBankId ? await db.prepare(
    `SELECT id, question_text, ranking_criteria
     FROM classroom_course_question_bank
     WHERE id = ? AND course_id = ? AND status = 'ready'`,
  ).bind(requestedBankId, session.course_id).first<{
    id: string;
    question_text: string;
    ranking_criteria: string;
  }>() : null;
  if (requestedBankId && (!/^question-bank-[a-z0-9-]{8,100}$/u.test(requestedBankId) || !bankItem)) {
    throw new ClassroomWorkflowError(404, "QUESTION_BANK_ITEM_NOT_FOUND", "問題庫中找不到這個問題，請重新選擇。");
  }
  const questionText = normalizeSessionText(bankItem?.question_text ?? values.questionText, 2_000);
  const criteria = normalizeSessionText(bankItem?.ranking_criteria ?? values.rankingCriteria, 500);
  const answerDurationSeconds = values.answerDurationSeconds === undefined ? 300 : Number(values.answerDurationSeconds);
  if (questionText.length < 5 || criteria.length < 5) throw new ClassroomWorkflowError(400, "INVALID_QUESTION", "問題與排序判準都至少需要 5 個字，請補充後再建立草稿。");
  if (!Number.isInteger(answerDurationSeconds) || answerDurationSeconds < 60 || answerDurationSeconds > 7_200) {
    throw new ClassroomWorkflowError(400, "INVALID_ANSWER_DURATION", "小組作答時間必須介於 1 至 120 分鐘。");
  }
  const position = await db.prepare("SELECT COALESCE(MAX(position), 0) + 1 AS position FROM classroom_questions WHERE session_id = ?")
    .bind(sessionId).first<{ position: number }>();
  const id = classroomId("question");
  const now = classroomNow();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO classroom_questions
        (id, session_id, question_text, ranking_criteria, source_question_bank_id,
         phase, answer_duration_seconds, position, version, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, 1, ?, ?, ?)`,
    ).bind(id, sessionId, questionText, criteria, bankItem?.id ?? null, answerDurationSeconds, position?.position ?? 1, actor.id, now, now),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'question.create', 'classroom_question', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, id, JSON.stringify({
      sessionId,
      position: position?.position ?? 1,
      questionBankId: bankItem?.id ?? null,
    }), now),
  ];
  if (bankItem) {
    statements.push(db.prepare(
      `UPDATE classroom_course_question_bank
       SET usage_count = usage_count + 1, last_used_at = ?, updated_at = ?
       WHERE id = ? AND course_id = ? AND status = 'ready'`,
    ).bind(now, now, bankItem.id, session.course_id));
  }
  await db.batch(statements);
  return classroomSessionSnapshot(db, actor, sessionId, id);
}

export async function advanceClassroomQuestion(
  db: D1Database, actor: ClassroomActor, sessionId: string, questionId: string, expectedVersion: number,
  forceCloseResponses = false,
): Promise<ClassroomSessionSnapshot> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以控制問題流程。");
  const session = await requireSession(db, actor, sessionId);
  if (session.phase !== "answering") throw new ClassroomWorkflowError(409, "SESSION_NOT_LIVE", "這次課堂目前未進行中。");
  const question = await requireQuestion(db, sessionId, questionId);
  if (question.version !== expectedVersion) throw new ClassroomWorkflowError(409, "QUESTION_VERSION_CONFLICT", "問題狀態已更新，請重新載入。");
  const target = nextQuestionPhase(question.phase);
  if (!target || question.phase === "archived") throw new ClassroomWorkflowError(409, "QUESTION_ALREADY_ARCHIVED", "這個問題已封存。");
  const now = classroomNow();
  const statements: D1PreparedStatement[] = [];
  if (question.phase === "draft") {
    const groups = await db.prepare("SELECT id FROM classroom_groups WHERE session_id = ? ORDER BY position")
      .bind(sessionId).all<{ id: string }>();
    const members = await db.prepare(
      "SELECT user_id, group_id, can_rank FROM classroom_session_participants WHERE session_id = ? AND group_id IS NOT NULL",
    ).bind(sessionId).all<{ user_id: string; group_id: string; can_rank: number }>();
    if (groups.results.length !== session.group_count || members.results.length === 0) throw new ClassroomWorkflowError(409, "GROUPING_INCOMPLETE", "分組尚未完成。");
    if (members.results.length > 0) {
      statements.push(...members.results.map((member) => db.prepare(
        `INSERT INTO classroom_question_memberships (id, question_id, user_id, group_id, can_rank, captured_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(classroomId("qmember"), questionId, member.user_id, member.group_id, member.can_rank, now)));
    }
    statements.push(...groups.results.map((group) => db.prepare(
      `INSERT INTO classroom_question_responses (id, question_id, group_id, content, status, version)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(classroomId("qresponse"), questionId, group.id, "", "draft", 1)));
  }
  if (question.phase === "answering") {
    const incomplete = await db.prepare(
      "SELECT COUNT(*) AS count FROM classroom_question_responses WHERE question_id = ? AND (status != 'submitted' OR length(trim(content)) = 0)",
    ).bind(questionId).first<{ count: number }>();
    if ((incomplete?.count ?? 0) > 0 && !forceCloseResponses) throw new ClassroomWorkflowError(409, "RESPONSES_INCOMPLETE", "仍有小組尚未正式提交回答。");
    statements.push(db.prepare(
      `UPDATE classroom_question_responses
       SET status = CASE WHEN length(trim(content)) > 0 THEN 'locked' ELSE 'draft' END,
           version = version + 1, updated_at = ?
       WHERE question_id = ?`,
    )
      .bind(now, questionId));
  }
  const evidenceFailure = await questionAdvanceEvidenceFailure(db, question.phase, questionId);
  if (evidenceFailure) throw new ClassroomWorkflowError(evidenceFailure.status, evidenceFailure.code, evidenceFailure.message);
  const timestampColumn = question.phase === "answering" ? "responses_locked_at" : question.phase === "ranking" ? "ranking_locked_at" : question.phase === "locked" ? "published_at" : null;
  if (question.phase === "draft") {
    const deadline = new Date(new Date(now).getTime() + question.answer_duration_seconds * 1_000).toISOString();
    statements.push(db.prepare(
      `UPDATE classroom_questions SET phase = ?, version = version + 1, updated_at = ?, opened_at = ?, answer_deadline_at = ?
       WHERE id = ? AND session_id = ? AND version = ?`,
    ).bind(target, now, now, deadline, questionId, sessionId, expectedVersion));
  } else {
    statements.push(db.prepare(
      `UPDATE classroom_questions SET phase = ?, version = version + 1, updated_at = ?${timestampColumn ? `, ${timestampColumn} = ?` : ""}
       WHERE id = ? AND session_id = ? AND version = ?`,
    ).bind(...(timestampColumn ? [target, now, now, questionId, sessionId, expectedVersion] : [target, now, questionId, sessionId, expectedVersion])));
  }
  statements.push(
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'question.advance', 'classroom_question', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, questionId, JSON.stringify({
      from: question.phase,
      to: target,
      forceCloseResponses: question.phase === "answering" && forceCloseResponses,
    }), now),
  );
  await db.batch(statements);
  return classroomSessionSnapshot(db, actor, sessionId, questionId);
}

export async function expireClassroomQuestionIfDue(
  db: D1Database, actor: ClassroomActor, sessionId: string, questionId: string,
): Promise<ClassroomSessionSnapshot> {
  await requireSession(db, actor, sessionId);
  const question = await requireQuestion(db, sessionId, questionId);
  const now = classroomNow();
  if (question.phase !== "answering" || !question.answer_deadline_at || question.answer_deadline_at > now) {
    return classroomSessionSnapshot(db, actor, sessionId, questionId);
  }
  const updated = await db.prepare(
    `UPDATE classroom_questions
     SET phase = 'presenting', version = version + 1, responses_locked_at = ?, updated_at = ?
     WHERE id = ? AND session_id = ? AND phase = 'answering' AND answer_deadline_at <= ?`,
  ).bind(now, now, questionId, sessionId, now).run();
  if ((updated.meta.changes ?? 0) === 1) {
    await db.batch([
      db.prepare(
        `UPDATE classroom_question_responses
         SET status = 'locked', version = version + 1, updated_at = ?
         WHERE question_id = ? AND length(trim(content)) > 0`,
      ).bind(now, questionId),
      db.prepare(
        `INSERT INTO classroom_audit_events
          (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
         VALUES (?, ?, 'question.answering_expired', 'classroom_question', ?, ?, ?)`,
      ).bind(classroomId("class-audit"), actor.id, questionId, JSON.stringify({ sessionId }), now),
    ]);
  }
  return classroomSessionSnapshot(db, actor, sessionId, questionId);
}

export async function classroomGroupResponseForActor(
  db: D1Database, actor: ClassroomActor, sessionId: string, questionId: string,
) {
  await requireSession(db, actor, sessionId);
  const question = await requireQuestion(db, sessionId, questionId);
  const membership = await db.prepare(
    `SELECT m.group_id, g.representative_user_id, r.content, r.status, r.version, r.updated_at
     FROM classroom_question_memberships m
     JOIN classroom_groups g ON g.id = m.group_id
     JOIN classroom_question_responses r ON r.question_id = m.question_id AND r.group_id = m.group_id
     WHERE m.question_id = ? AND m.user_id = ?`,
  ).bind(questionId, actor.id).first<{
    group_id: string; representative_user_id: string | null; content: string;
    status: "draft" | "submitted" | "locked"; version: number; updated_at: string | null;
  }>();
  if (!membership) throw new ClassroomWorkflowError(404, "QUESTION_MEMBERSHIP_NOT_FOUND", "你未參與這個問題。");
  return {
    questionPhase: question.phase,
    answerDeadlineAt: question.answer_deadline_at,
    groupId: membership.group_id,
    isRepresentative: membership.representative_user_id === actor.id,
    response: {
      content: membership.content, status: membership.status, version: membership.version, updatedAt: membership.updated_at,
    },
  };
}

export async function saveClassroomGroupResponse(
  db: D1Database, actor: ClassroomActor, sessionId: string, questionId: string,
  contentValue: unknown, expectedVersion: number, submit: boolean,
) {
  await requireSession(db, actor, sessionId);
  const question = await requireQuestion(db, sessionId, questionId);
  const now = classroomNow();
  const answerWindowError = classroomAnswerWindowError(question.phase, question.answer_deadline_at, now);
  if (answerWindowError === "ANSWERING_CLOSED") throw new ClassroomWorkflowError(409, answerWindowError, "目前不是小組作答階段。");
  if (answerWindowError === "ANSWER_DEADLINE_PASSED") throw new ClassroomWorkflowError(409, answerWindowError, "作答時間已結束，回答已停止接受修改。");
  const membership = await db.prepare(
    `SELECT m.group_id FROM classroom_question_memberships m
     JOIN classroom_groups g ON g.id = m.group_id
     WHERE m.question_id = ? AND m.user_id = ? AND g.representative_user_id = ?`,
  ).bind(questionId, actor.id, actor.id).first<{ group_id: string }>();
  if (!membership) throw new ClassroomWorkflowError(403, "REPRESENTATIVE_REQUIRED", "只有本組指定代表可以編輯回答。");
  const content = normalizeSessionText(contentValue, 4_000);
  if (submit && content.length === 0) throw new ClassroomWorkflowError(400, "EMPTY_GROUP_RESPONSE", "請先填寫小組回答再提交。");
  const writeFailure = await guardedClassroomResponseWrite(db, {
    sessionId, questionId, groupId: membership.group_id, actorId: actor.id, content,
    expectedVersion, submit, now, auditId: classroomId("class-audit"),
  });
  if (writeFailure) throw new ClassroomWorkflowError(writeFailure.status, writeFailure.code, writeFailure.message);
  return {
    questionPhase: question.phase,
    answerDeadlineAt: question.answer_deadline_at,
    groupId: membership.group_id,
    isRepresentative: true,
    response: {
      content,
      status: submit ? "submitted" as const : "draft" as const,
      version: expectedVersion + 1,
      updatedAt: now,
    },
  };
}

export async function submitClassroomRanking(
  db: D1Database, actor: ClassroomActor, sessionId: string, questionId: string, orderedGroupIds: unknown,
): Promise<ClassroomSessionSnapshot> {
  const session = await requireSession(db, actor, sessionId);
  const question = await requireQuestion(db, sessionId, questionId);
  if (question.phase !== "ranking") throw new ClassroomWorkflowError(409, "RANKING_CLOSED", "目前未開放個人排序，這次送出未被保存。若教師已結束排序，請告知教師。");
  await requireRankingActor(db, actor, question);
  const groupRows = await db.prepare(
    `SELECT g.id FROM classroom_groups g
     JOIN classroom_question_responses r ON r.group_id = g.id AND r.question_id = ?
     WHERE g.session_id = ? AND r.status IN ('submitted','locked') AND length(trim(r.content)) > 0
     ORDER BY g.position`,
  ).bind(questionId, sessionId).all<{ id: string }>();
  const expected = groupRows.results.map((row) => row.id);
  const submitted = completeClassroomRankingOrder(orderedGroupIds, expected);
  if (!submitted) {
    throw new ClassroomWorkflowError(400, "INCOMPLETE_RANKING", "排序不得漏掉、重複或加入不屬於本題的回答。");
  }
  const current = await db.prepare(
    "SELECT id, version FROM classroom_question_ranking_submissions WHERE question_id = ? AND user_id = ? AND is_current = 1",
  ).bind(questionId, actor.id).first<{ id: string; version: number }>();
  if (current && !session.allow_ranking_edits) throw new ClassroomWorkflowError(409, "RANKING_ALREADY_SUBMITTED", "排序已提交，教師未開放修改。");
  const submissionId = classroomId("qranking");
  const version = (current?.version ?? 0) + 1;
  const now = classroomNow();
  const statements: D1PreparedStatement[] = [];
  if (current) statements.push(db.prepare("UPDATE classroom_question_ranking_submissions SET is_current = 0 WHERE id = ?").bind(current.id));
  statements.push(db.prepare(
    `INSERT INTO classroom_question_ranking_submissions
      (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
     VALUES (?, (
       SELECT id FROM classroom_questions WHERE id = ? AND session_id = ? AND phase = 'ranking'
     ), ?, ?, 1, 'valid', NULL, ?)`,
  ).bind(submissionId, questionId, sessionId, actor.id, version, now));
  if (submitted.length) {
    statements.push(db.prepare(
      `INSERT INTO classroom_question_ranking_items (id, submission_id, group_id, rank)
       VALUES ${placeholders(submitted.length, 4)}`,
    ).bind(...submitted.flatMap((groupId, index) => [classroomId("qrank-item"), submissionId, groupId, index + 1])));
  }
  statements.push(db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'ranking.submit', 'classroom_question', ?, ?, ?)`,
  ).bind(classroomId("class-audit"), actor.id, questionId, JSON.stringify({
    version, rankedGroups: submitted.length, kind: actor.isAdmin ? "teacher" : "student",
  }), now));
  const rankingFailure = await guardedClassroomRankingBatch(db, statements, sessionId, questionId);
  if (rankingFailure) throw new ClassroomWorkflowError(rankingFailure.status, rankingFailure.code, rankingFailure.message);
  return classroomSessionSnapshot(db, actor, sessionId, questionId);
}
