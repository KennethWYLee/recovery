import {
  balancedGroupSizes,
  nextSessionPhase,
  normalizeSessionText,
  previousSessionPhase,
  rankResults,
  type ClassroomGroup,
  type ClassroomParticipant,
  type ClassroomSession,
  type ClassroomSessionPhase,
  type ClassroomSessionSnapshot,
} from "@/lib/classroom-domain";
import { classroomId, classroomNow, type ClassroomActor } from "./classroom";

export class ClassroomWorkflowError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "ClassroomWorkflowError";
  }
}

type SessionRow = {
  id: string;
  course_id: string;
  title: string;
  question: string;
  ranking_criteria: string;
  join_code: string;
  phase: ClassroomSessionPhase;
  group_capacity: number;
  effective_group_capacity: number;
  anonymous_groups: number;
  allow_ranking_edits: number;
  version: number;
  created_at: string;
  updated_at: string;
};

function mapSession(row: SessionRow): ClassroomSession {
  return {
    id: row.id,
    courseId: row.course_id,
    title: row.title,
    question: row.question,
    rankingCriteria: row.ranking_criteria,
    joinCode: row.join_code,
    phase: row.phase,
    groupCapacity: row.group_capacity,
    effectiveGroupCapacity: row.effective_group_capacity,
    anonymousGroups: row.anonymous_groups === 1,
    allowRankingEdits: row.allow_ranking_edits === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function actorCanAccessCourse(db: D1Database, actor: ClassroomActor, courseId: string): Promise<boolean> {
  if (actor.isAdmin) {
    const row = await db.prepare("SELECT id FROM classroom_courses WHERE id = ? AND status = 'active'")
      .bind(courseId).first<{ id: string }>();
    return Boolean(row);
  }
  const row = await db.prepare(
    `SELECT c.id FROM classroom_courses c
     JOIN classroom_course_members m ON m.course_id = c.id
     WHERE c.id = ? AND c.status = 'active' AND m.user_id = ? AND m.status = 'active'`,
  ).bind(courseId, actor.id).first<{ id: string }>();
  return Boolean(row);
}

async function requireSession(db: D1Database, actor: ClassroomActor, sessionId: string): Promise<SessionRow> {
  const row = await db.prepare(
    `SELECT id, course_id, title, question, ranking_criteria, join_code, phase,
            group_capacity, effective_group_capacity, anonymous_groups,
            allow_ranking_edits, version, created_at, updated_at
     FROM classroom_sessions WHERE id = ?`,
  ).bind(sessionId).first<SessionRow>();
  if (!row || !await actorCanAccessCourse(db, actor, row.course_id)) {
    throw new ClassroomWorkflowError(404, "SESSION_NOT_FOUND", "找不到這次課堂，或你沒有查看權限。");
  }
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

export async function createClassroomSession(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  values: {
    title: unknown;
    question: unknown;
    rankingCriteria: unknown;
    groupCapacity: number;
    anonymousGroups: boolean;
    allowRankingEdits: boolean;
  },
): Promise<ClassroomSession> {
  if (!actor.isAdmin || !await actorCanAccessCourse(db, actor, courseId)) {
    throw new ClassroomWorkflowError(403, "COURSE_MANAGEMENT_REQUIRED", "只有系統管理員可以建立今日課堂。");
  }
  const title = normalizeSessionText(values.title, 100);
  const question = normalizeSessionText(values.question, 2_000);
  const rankingCriteria = normalizeSessionText(values.rankingCriteria, 500);
  if (title.length < 2 || question.length < 5 || rankingCriteria.length < 5) {
    throw new ClassroomWorkflowError(400, "INVALID_SESSION_CONTENT", "請完整填寫課堂名稱、問題及排序判準。");
  }
  if (!Number.isInteger(values.groupCapacity) || values.groupCapacity < 2 || values.groupCapacity > 20) {
    throw new ClassroomWorkflowError(400, "INVALID_GROUP_CAPACITY", "每組人數上限必須介於 2 至 20 人。");
  }
  const active = await db.prepare(
    "SELECT id FROM classroom_sessions WHERE course_id = ? AND phase != 'archived' LIMIT 1",
  ).bind(courseId).first<{ id: string }>();
  if (active) {
    throw new ClassroomWorkflowError(409, "ACTIVE_SESSION_EXISTS", "這門課已有進行中的課堂，請先完成或封存它。");
  }
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
             version, created_by_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'check_in', ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).bind(
          sessionId, courseId, title, question, rankingCriteria, joinCode,
          values.groupCapacity, values.groupCapacity, values.anonymousGroups ? 1 : 0,
          values.allowRankingEdits ? 1 : 0, actor.id, now, now,
        ),
        db.prepare(
          `INSERT INTO classroom_audit_events
            (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
           VALUES (?, ?, 'session.create', 'classroom_session', ?, ?, ?)`,
        ).bind(classroomId("class-audit"), actor.id, sessionId, JSON.stringify({ courseId, groupCapacity: values.groupCapacity }), now),
      ]);
      const row = await db.prepare(
        `SELECT id, course_id, title, question, ranking_criteria, join_code, phase,
                group_capacity, effective_group_capacity, anonymous_groups,
                allow_ranking_edits, version, created_at, updated_at
         FROM classroom_sessions WHERE id = ?`,
      ).bind(sessionId).first<SessionRow>();
      if (!row) throw new Error("Created session was not found.");
      return mapSession(row);
    } catch (error) {
      lastError = error;
      if (!/join_code/iu.test(error instanceof Error ? error.message : String(error))) break;
    }
  }
  if (/course_active|classroom_sessions\.course_id/iu.test(lastError instanceof Error ? lastError.message : String(lastError))) {
    throw new ClassroomWorkflowError(409, "ACTIVE_SESSION_EXISTS", "這門課已有進行中的課堂，請先完成或封存它。");
  }
  throw lastError;
}

export async function activeClassroomSession(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
): Promise<ClassroomSessionSnapshot | null> {
  if (!await actorCanAccessCourse(db, actor, courseId)) return null;
  const row = await db.prepare(
    `SELECT id FROM classroom_sessions
     WHERE course_id = ? AND phase != 'archived'
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(courseId).first<{ id: string }>();
  return row ? classroomSessionSnapshot(db, actor, row.id) : null;
}

export async function classroomSessionSnapshot(
  db: D1Database,
  actor: ClassroomActor,
  sessionId: string,
): Promise<ClassroomSessionSnapshot> {
  const sessionRow = await requireSession(db, actor, sessionId);
  const session = mapSession(sessionRow);
  const participantRows = await db.prepare(
    `SELECT p.id, p.user_id, u.display_name, u.email, p.group_id, p.attendance,
            p.joined_phase, p.can_rank, p.checked_in_at
     FROM classroom_session_participants p
     JOIN classroom_users u ON u.id = p.user_id
     WHERE p.session_id = ?
     ORDER BY p.checked_in_at, u.display_name`,
  ).bind(sessionId).all<{
    id: string; user_id: string; display_name: string; email: string; group_id: string | null;
    attendance: "on_time" | "late"; joined_phase: ClassroomSessionPhase; can_rank: number; checked_in_at: string;
  }>();
  const participants: ClassroomParticipant[] = participantRows.results.map((row) => ({
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    email: actor.isAdmin ? row.email : null,
    groupId: row.group_id,
    attendance: row.attendance,
    joinedPhase: row.joined_phase,
    canRank: row.can_rank === 1,
    checkedInAt: row.checked_in_at,
  }));
  const groupRows = await db.prepare(
    `SELECT g.id, g.label, g.position, g.representative_user_id,
            r.content, r.status AS response_status, r.version AS response_version, r.updated_at AS response_updated_at
     FROM classroom_groups g
     LEFT JOIN classroom_group_responses r ON r.group_id = g.id
     WHERE g.session_id = ? ORDER BY g.position`,
  ).bind(sessionId).all<{
    id: string; label: string; position: number; representative_user_id: string | null;
    content: string | null; response_status: "draft" | "submitted" | "locked" | null;
    response_version: number | null; response_updated_at: string | null;
  }>();
  const currentParticipant = participants.find((participant) => participant.userId === actor.id) ?? null;
  const publicResponses = ["presenting", "ranking", "results", "archived"].includes(session.phase);
  const groups: ClassroomGroup[] = groupRows.results.map((row) => {
    const mayReadResponse = actor.isAdmin || publicResponses || currentParticipant?.groupId === row.id;
    return {
      id: row.id,
      label: row.label,
      position: row.position,
      representativeUserId: row.representative_user_id,
      members: participants.filter((participant) => participant.groupId === row.id),
      response: {
        content: mayReadResponse ? row.content ?? "" : "",
        status: row.response_status ?? "draft",
        version: row.response_version ?? 1,
        updatedAt: row.response_updated_at,
      },
    };
  });
  const submissionRows = await db.prepare(
    `SELECT user_id FROM classroom_ranking_submissions
     WHERE session_id = ? AND is_current = 1 AND status = 'valid'`,
  ).bind(sessionId).all<{ user_id: string }>();
  const submittedUsers = new Set(submissionRows.results.map((row) => row.user_id));
  let results: ClassroomSessionSnapshot["results"] = [];
  if (session.phase === "results" || session.phase === "archived") {
    const rankingRows = await db.prepare(
      `SELECT i.group_id, i.rank
       FROM classroom_ranking_items i
       JOIN classroom_ranking_submissions s ON s.id = i.submission_id
       WHERE s.session_id = ? AND s.is_current = 1 AND s.status = 'valid'`,
    ).bind(sessionId).all<{ group_id: string; rank: number }>();
    results = rankResults(
      groups.map((group) => ({ id: group.id, label: group.label })),
      rankingRows.results.map((row) => ({ groupId: row.group_id, rank: row.rank })),
    );
  }
  const rawRankings: ClassroomSessionSnapshot["rawRankings"] = [];
  if (actor.isAdmin && ["ranking", "results", "archived"].includes(session.phase)) {
    const rows = await db.prepare(
      `SELECT s.user_id, u.display_name, u.email, s.submitted_at, i.group_id, i.rank
       FROM classroom_ranking_submissions s
       JOIN classroom_users u ON u.id = s.user_id
       JOIN classroom_ranking_items i ON i.submission_id = s.id
       WHERE s.session_id = ? AND s.is_current = 1 AND s.status = 'valid'
       ORDER BY s.submitted_at, u.display_name, i.rank`,
    ).bind(sessionId).all<{
      user_id: string; display_name: string; email: string; submitted_at: string; group_id: string; rank: number;
    }>();
    for (const row of rows.results) {
      let ranking = rawRankings.find((item) => item.userId === row.user_id);
      if (!ranking) {
        ranking = { userId: row.user_id, displayName: row.display_name, email: row.email, submittedAt: row.submitted_at, orderedGroupIds: [] };
        rawRankings.push(ranking);
      }
      ranking.orderedGroupIds[row.rank - 1] = row.group_id;
    }
  }
  return {
    session,
    participants,
    groups,
    completion: {
      checkedIn: participants.length,
      grouped: participants.filter((participant) => participant.groupId).length,
      submittedGroups: groups.filter((group) => group.response.status === "submitted" || group.response.status === "locked").length,
      rankedStudents: submittedUsers.size,
      eligibleStudents: participants.filter((participant) => participant.canRank).length,
    },
    currentUser: {
      participantId: currentParticipant?.id ?? null,
      groupId: currentParticipant?.groupId ?? null,
      isRepresentative: groups.some((group) => group.representativeUserId === actor.id),
      hasSubmittedRanking: submittedUsers.has(actor.id),
    },
    results,
    rawRankings,
  };
}

export async function joinClassroomSession(
  db: D1Database,
  actor: ClassroomActor,
  joinCodeValue: unknown,
): Promise<ClassroomSessionSnapshot> {
  const joinCode = typeof joinCodeValue === "string" ? joinCodeValue.trim().toUpperCase() : "";
  if (!/^[23456789A-HJ-NP-Z]{6}$/u.test(joinCode)) {
    throw new ClassroomWorkflowError(404, "JOIN_CODE_NOT_FOUND", "課堂代碼不存在或已失效。");
  }
  const sessionRow = await db.prepare(
    `SELECT id, course_id, title, question, ranking_criteria, join_code, phase,
            group_capacity, effective_group_capacity, anonymous_groups,
            allow_ranking_edits, version, created_at, updated_at
     FROM classroom_sessions WHERE join_code = ? AND phase != 'archived'`,
  ).bind(joinCode).first<SessionRow>();
  if (!sessionRow) throw new ClassroomWorkflowError(404, "JOIN_CODE_NOT_FOUND", "課堂代碼不存在或已失效。");
  const existing = await db.prepare(
    "SELECT id FROM classroom_session_participants WHERE session_id = ? AND user_id = ?",
  ).bind(sessionRow.id, actor.id).first<{ id: string }>();
  if (!existing) {
    const now = classroomNow();
    const late = sessionRow.phase !== "check_in";
    let groupId: string | null = null;
    let canRank = 1;
    let effectiveCapacity = sessionRow.effective_group_capacity;
    if (sessionRow.phase === "grouping" || sessionRow.phase === "answering") {
      const group = await db.prepare(
        `SELECT g.id, COUNT(p.id) AS member_count
         FROM classroom_groups g
         LEFT JOIN classroom_session_participants p ON p.group_id = g.id
         WHERE g.session_id = ?
         GROUP BY g.id, g.position
         ORDER BY member_count, g.position LIMIT 1`,
      ).bind(sessionRow.id).first<{ id: string; member_count: number }>();
      if (group) {
        groupId = group.id;
        if (group.member_count >= effectiveCapacity) effectiveCapacity += 1;
      }
    } else if (sessionRow.phase === "results") {
      canRank = 0;
    }
    const statements = [
      db.prepare(
        `INSERT INTO classroom_course_members
          (id, course_id, user_id, role, status, joined_at, updated_at)
         VALUES (?, ?, ?, 'student', 'active', ?, ?)
         ON CONFLICT(course_id, user_id) DO UPDATE SET status = 'active', updated_at = excluded.updated_at`,
      ).bind(classroomId("course-member"), sessionRow.course_id, actor.id, now, now),
      db.prepare(
        `INSERT INTO classroom_session_participants
          (id, session_id, user_id, group_id, attendance, joined_phase, can_rank, checked_in_at, grouped_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, user_id) DO NOTHING`,
      ).bind(
        classroomId("participant"), sessionRow.id, actor.id, groupId,
        late ? "late" : "on_time", sessionRow.phase, canRank, now, groupId ? now : null, now,
      ),
      db.prepare(
        `INSERT INTO classroom_audit_events
          (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
         VALUES (?, ?, 'session.check_in', 'classroom_session', ?, ?, ?)`,
      ).bind(classroomId("class-audit"), actor.id, sessionRow.id, JSON.stringify({ phase: sessionRow.phase, late, groupId }), now),
    ];
    if (effectiveCapacity !== sessionRow.effective_group_capacity) {
      statements.push(db.prepare(
        `UPDATE classroom_sessions
         SET effective_group_capacity = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND effective_group_capacity = ?`,
      ).bind(effectiveCapacity, now, sessionRow.id, sessionRow.effective_group_capacity));
    }
    await db.batch(statements);
  }
  return classroomSessionSnapshot(db, actor, sessionRow.id);
}

async function createBalancedGroups(db: D1Database, actor: ClassroomActor, session: SessionRow): Promise<void> {
  const participantRows = await db.prepare(
    "SELECT id, user_id FROM classroom_session_participants WHERE session_id = ? ORDER BY checked_in_at, id",
  ).bind(session.id).all<{ id: string; user_id: string }>();
  if (participantRows.results.length < 2) {
    throw new ClassroomWorkflowError(409, "NOT_ENOUGH_PARTICIPANTS", "至少需要兩位已報到學生才能分組。");
  }
  const participants = shuffled(participantRows.results);
  const sizes = balancedGroupSizes(participants.length, session.group_capacity);
  const now = classroomNow();
  const groupData: Array<{ id: string; label: string; position: number; representativeUserId: string; memberIds: string[] }> = [];
  let offset = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    const members = participants.slice(offset, offset + sizes[index]);
    offset += sizes[index];
    groupData.push({
      id: classroomId("group"),
      label: `第 ${index + 1} 組`,
      position: index + 1,
      representativeUserId: members[0].user_id,
      memberIds: members.map((member) => member.id),
    });
  }
  const statements: D1PreparedStatement[] = [];
  for (let index = 0; index < groupData.length; index += 15) {
    const chunk = groupData.slice(index, index + 15);
    statements.push(db.prepare(
      `INSERT INTO classroom_groups
        (id, session_id, label, position, representative_user_id, created_at, updated_at)
       VALUES ${placeholders(chunk.length, 7)}`,
    ).bind(...chunk.flatMap((group) => [group.id, session.id, group.label, group.position, group.representativeUserId, now, now])));
  }
  statements.push(db.prepare(
    `INSERT INTO classroom_group_responses (group_id, content, status, version)
     VALUES ${placeholders(groupData.length, 4)}`,
  ).bind(...groupData.flatMap((group) => [group.id, "", "draft", 1])));
  for (const group of groupData) {
    statements.push(db.prepare(
      `UPDATE classroom_session_participants
       SET group_id = ?, grouped_at = ?, updated_at = ?
       WHERE session_id = ? AND id IN (${group.memberIds.map(() => "?").join(", ")})`,
    ).bind(group.id, now, now, session.id, ...group.memberIds));
  }
  statements.push(
    db.prepare(
      `UPDATE classroom_sessions SET phase = 'grouping', version = version + 1, updated_at = ?
       WHERE id = ? AND phase = 'check_in' AND version = ?`,
    ).bind(now, session.id, session.version),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'session.group', 'classroom_session', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, session.id, JSON.stringify({ groups: groupData.length, participants: participants.length }), now),
  );
  await db.batch(statements);
}

export async function advanceClassroomSession(
  db: D1Database,
  actor: ClassroomActor,
  sessionId: string,
  expectedVersion: number,
): Promise<ClassroomSessionSnapshot> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以控制課堂流程。");
  const session = await requireSession(db, actor, sessionId);
  if (session.version !== expectedVersion) throw new ClassroomWorkflowError(409, "SESSION_VERSION_CONFLICT", "課堂狀態已更新，請重新載入。");
  if (session.phase === "check_in") {
    await createBalancedGroups(db, actor, session);
    return classroomSessionSnapshot(db, actor, sessionId);
  }
  const target = nextSessionPhase(session.phase);
  if (!target) throw new ClassroomWorkflowError(409, "SESSION_ALREADY_ARCHIVED", "這次課堂已經封存。");
  if (session.phase === "grouping") {
    const unassigned = await db.prepare(
      "SELECT COUNT(*) AS count FROM classroom_session_participants WHERE session_id = ? AND group_id IS NULL",
    ).bind(sessionId).first<{ count: number }>();
    const missingRepresentatives = await db.prepare(
      "SELECT COUNT(*) AS count FROM classroom_groups WHERE session_id = ? AND representative_user_id IS NULL",
    ).bind(sessionId).first<{ count: number }>();
    if ((unassigned?.count ?? 0) > 0 || (missingRepresentatives?.count ?? 0) > 0) {
      throw new ClassroomWorkflowError(409, "GROUPING_INCOMPLETE", "仍有學生未分組，或小組尚未指定作答代表。");
    }
  }
  if (session.phase === "answering") {
    const incomplete = await db.prepare(
      `SELECT COUNT(*) AS count FROM classroom_group_responses r
       JOIN classroom_groups g ON g.id = r.group_id
       WHERE g.session_id = ? AND (r.status != 'submitted' OR length(trim(r.content)) = 0)`,
    ).bind(sessionId).first<{ count: number }>();
    if ((incomplete?.count ?? 0) > 0) {
      throw new ClassroomWorkflowError(409, "RESPONSES_INCOMPLETE", "仍有小組尚未正式提交回答。");
    }
  }
  if (session.phase === "ranking") {
    const valid = await db.prepare(
      `SELECT COUNT(*) AS count FROM classroom_ranking_submissions
       WHERE session_id = ? AND is_current = 1 AND status = 'valid'`,
    ).bind(sessionId).first<{ count: number }>();
    if ((valid?.count ?? 0) === 0) throw new ClassroomWorkflowError(409, "NO_RANKINGS", "尚未收到任何完整排序。");
  }
  const now = classroomNow();
  const statements: D1PreparedStatement[] = [];
  if (target === "presenting") {
    statements.push(db.prepare(
      `UPDATE classroom_group_responses SET status = 'locked', version = version + 1, updated_at = ?
       WHERE group_id IN (SELECT id FROM classroom_groups WHERE session_id = ?)`,
    ).bind(now, sessionId));
  }
  statements.push(
    db.prepare(
      `UPDATE classroom_sessions SET phase = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND phase = ? AND version = ?`,
    ).bind(target, now, sessionId, session.phase, expectedVersion),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'session.advance', 'classroom_session', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, sessionId, JSON.stringify({ from: session.phase, to: target }), now),
  );
  await db.batch(statements);
  return classroomSessionSnapshot(db, actor, sessionId);
}

export async function rollbackClassroomSession(
  db: D1Database,
  actor: ClassroomActor,
  sessionId: string,
  expectedVersion: number,
): Promise<ClassroomSessionSnapshot> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以控制課堂流程。");
  const session = await requireSession(db, actor, sessionId);
  if (session.version !== expectedVersion) throw new ClassroomWorkflowError(409, "SESSION_VERSION_CONFLICT", "課堂狀態已更新，請重新載入。");
  const target = previousSessionPhase(session.phase);
  if (!target || session.phase === "grouping" || session.phase === "archived") {
    throw new ClassroomWorkflowError(409, "SESSION_ROLLBACK_NOT_ALLOWED", "目前階段不能退回上一階段。");
  }
  const now = classroomNow();
  const statements: D1PreparedStatement[] = [];
  if (session.phase === "presenting") {
    statements.push(db.prepare(
      `UPDATE classroom_group_responses SET status = 'submitted', version = version + 1, updated_at = ?
       WHERE group_id IN (SELECT id FROM classroom_groups WHERE session_id = ?)`,
    ).bind(now, sessionId));
  }
  statements.push(
    db.prepare(
      `UPDATE classroom_sessions SET phase = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND phase = ? AND version = ?`,
    ).bind(target, now, sessionId, session.phase, expectedVersion),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'session.rollback', 'classroom_session', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, sessionId, JSON.stringify({ from: session.phase, to: target }), now),
  );
  await db.batch(statements);
  return classroomSessionSnapshot(db, actor, sessionId);
}

export async function moveClassroomParticipant(
  db: D1Database,
  actor: ClassroomActor,
  sessionId: string,
  participantId: string,
  targetGroupId: string,
): Promise<ClassroomSessionSnapshot> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以調整分組。");
  const session = await requireSession(db, actor, sessionId);
  if (session.phase !== "grouping") throw new ClassroomWorkflowError(409, "GROUPING_LOCKED", "只有確認分組階段可以移動學生。");
  const participant = await db.prepare(
    "SELECT user_id, group_id FROM classroom_session_participants WHERE id = ? AND session_id = ?",
  ).bind(participantId, sessionId).first<{ user_id: string; group_id: string | null }>();
  const target = await db.prepare(
    "SELECT id FROM classroom_groups WHERE id = ? AND session_id = ?",
  ).bind(targetGroupId, sessionId).first<{ id: string }>();
  if (!participant || !target) throw new ClassroomWorkflowError(404, "GROUP_MEMBER_NOT_FOUND", "找不到指定學生或小組。");
  if (participant.group_id === targetGroupId) return classroomSessionSnapshot(db, actor, sessionId);
  const targetCount = await db.prepare(
    "SELECT COUNT(*) AS count FROM classroom_session_participants WHERE group_id = ?",
  ).bind(targetGroupId).first<{ count: number }>();
  const effectiveCapacity = (targetCount?.count ?? 0) >= session.effective_group_capacity
    ? session.effective_group_capacity + 1
    : session.effective_group_capacity;
  const now = classroomNow();
  const statements: D1PreparedStatement[] = [
    db.prepare(
      "UPDATE classroom_session_participants SET group_id = ?, grouped_at = ?, updated_at = ? WHERE id = ? AND session_id = ?",
    ).bind(targetGroupId, now, now, participantId, sessionId),
    db.prepare(
      "UPDATE classroom_groups SET representative_user_id = NULL, updated_at = ? WHERE session_id = ? AND representative_user_id = ? AND id != ?",
    ).bind(now, sessionId, participant.user_id, targetGroupId),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'group.move_member', 'classroom_session', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, sessionId, JSON.stringify({ participantId, from: participant.group_id, to: targetGroupId }), now),
  ];
  if (effectiveCapacity !== session.effective_group_capacity) {
    statements.push(db.prepare(
      "UPDATE classroom_sessions SET effective_group_capacity = ?, version = version + 1, updated_at = ? WHERE id = ?",
    ).bind(effectiveCapacity, now, sessionId));
  }
  await db.batch(statements);
  return classroomSessionSnapshot(db, actor, sessionId);
}

export async function setClassroomRepresentative(
  db: D1Database,
  actor: ClassroomActor,
  sessionId: string,
  groupId: string,
  userId: string,
): Promise<ClassroomSessionSnapshot> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_MANAGEMENT_REQUIRED", "只有系統管理員可以指定作答代表。");
  const session = await requireSession(db, actor, sessionId);
  if (session.phase !== "grouping" && session.phase !== "answering") {
    throw new ClassroomWorkflowError(409, "REPRESENTATIVE_LOCKED", "目前階段不能更換作答代表。");
  }
  const member = await db.prepare(
    `SELECT p.user_id FROM classroom_session_participants p
     JOIN classroom_groups g ON g.id = p.group_id
     WHERE p.session_id = ? AND p.group_id = ? AND p.user_id = ? AND g.session_id = ?`,
  ).bind(sessionId, groupId, userId, sessionId).first<{ user_id: string }>();
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

export async function saveClassroomGroupResponse(
  db: D1Database,
  actor: ClassroomActor,
  sessionId: string,
  contentValue: unknown,
  expectedVersion: number,
  submit: boolean,
): Promise<ClassroomSessionSnapshot> {
  const session = await requireSession(db, actor, sessionId);
  if (session.phase !== "answering") throw new ClassroomWorkflowError(409, "ANSWERING_CLOSED", "目前不是小組作答階段。");
  const group = await db.prepare(
    "SELECT id FROM classroom_groups WHERE session_id = ? AND representative_user_id = ?",
  ).bind(sessionId, actor.id).first<{ id: string }>();
  if (!group) throw new ClassroomWorkflowError(403, "REPRESENTATIVE_REQUIRED", "只有本組指定代表可以編輯回答。");
  const content = normalizeSessionText(contentValue, 4_000);
  if (submit && content.length < 2) throw new ClassroomWorkflowError(400, "EMPTY_GROUP_RESPONSE", "請先填寫小組回答再提交。");
  const now = classroomNow();
  const result = await db.prepare(
    `UPDATE classroom_group_responses
     SET content = ?, status = ?, version = version + 1, updated_by_user_id = ?,
         submitted_at = CASE WHEN ? = 1 THEN ? ELSE NULL END, updated_at = ?
     WHERE group_id = ? AND version = ?`,
  ).bind(content, submit ? "submitted" : "draft", actor.id, submit ? 1 : 0, now, now, group.id, expectedVersion).run();
  if ((result.meta.changes ?? 0) !== 1) throw new ClassroomWorkflowError(409, "RESPONSE_VERSION_CONFLICT", "回答已在其他裝置更新，請重新載入。");
  if (submit) {
    await db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'response.submit', 'classroom_group', ?, ?, ?)`,
    ).bind(classroomId("class-audit"), actor.id, group.id, JSON.stringify({ sessionId }), now).run();
  }
  return classroomSessionSnapshot(db, actor, sessionId);
}

export async function submitClassroomRanking(
  db: D1Database,
  actor: ClassroomActor,
  sessionId: string,
  orderedGroupIds: unknown,
): Promise<ClassroomSessionSnapshot> {
  const session = await requireSession(db, actor, sessionId);
  if (session.phase !== "ranking") throw new ClassroomWorkflowError(409, "RANKING_CLOSED", "目前不是個人排序階段。");
  const participant = await db.prepare(
    "SELECT group_id, can_rank FROM classroom_session_participants WHERE session_id = ? AND user_id = ?",
  ).bind(sessionId, actor.id).first<{ group_id: string | null; can_rank: number }>();
  if (!participant || participant.can_rank !== 1) throw new ClassroomWorkflowError(403, "RANKING_NOT_ALLOWED", "你目前不能提交排序。");
  const groupRows = await db.prepare("SELECT id FROM classroom_groups WHERE session_id = ? ORDER BY position")
    .bind(sessionId).all<{ id: string }>();
  const expected = groupRows.results.map((row) => row.id).filter((id) => id !== participant.group_id);
  if (!Array.isArray(orderedGroupIds) || orderedGroupIds.some((id) => typeof id !== "string")) {
    throw new ClassroomWorkflowError(400, "INCOMPLETE_RANKING", "請完成全部回答的排序。");
  }
  const submitted = orderedGroupIds as string[];
  if (submitted.length !== expected.length || new Set(submitted).size !== submitted.length
    || expected.some((id) => !submitted.includes(id))) {
    throw new ClassroomWorkflowError(400, "INCOMPLETE_RANKING", "排序不得漏掉、重複或加入不屬於本題的回答。");
  }
  const current = await db.prepare(
    `SELECT id, version FROM classroom_ranking_submissions
     WHERE session_id = ? AND user_id = ? AND is_current = 1`,
  ).bind(sessionId, actor.id).first<{ id: string; version: number }>();
  if (current && !session.allow_ranking_edits) {
    throw new ClassroomWorkflowError(409, "RANKING_ALREADY_SUBMITTED", "這次排序已提交，教師未開放修改。");
  }
  const submissionId = classroomId("ranking");
  const version = (current?.version ?? 0) + 1;
  const now = classroomNow();
  const statements: D1PreparedStatement[] = [];
  if (current) statements.push(db.prepare("UPDATE classroom_ranking_submissions SET is_current = 0 WHERE id = ? AND is_current = 1").bind(current.id));
  statements.push(
    db.prepare(
      `INSERT INTO classroom_ranking_submissions
        (id, session_id, user_id, version, is_current, status, invalid_reason, submitted_at)
       VALUES (?, ?, ?, ?, 1, 'valid', NULL, ?)`,
    ).bind(submissionId, sessionId, actor.id, version, now),
  );
  if (submitted.length > 0) {
    statements.push(db.prepare(
      `INSERT INTO classroom_ranking_items (id, submission_id, group_id, rank, is_own_group)
       VALUES ${placeholders(submitted.length, 5)}`,
    ).bind(...submitted.flatMap((groupId, index) => [classroomId("rank-item"), submissionId, groupId, index + 1, 0])));
  }
  statements.push(db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'ranking.submit', 'classroom_session', ?, ?, ?)`,
  ).bind(classroomId("class-audit"), actor.id, sessionId, JSON.stringify({ version, itemCount: submitted.length }), now));
  await db.batch(statements);
  return classroomSessionSnapshot(db, actor, sessionId);
}

function csvCell(value: string | number | boolean | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export async function classroomSessionCsv(
  db: D1Database,
  actor: ClassroomActor,
  sessionId: string,
): Promise<string> {
  if (!actor.isAdmin) throw new ClassroomWorkflowError(403, "SESSION_EXPORT_REQUIRED", "只有系統管理員可匯出課堂原始資料。");
  const snapshot = await classroomSessionSnapshot(db, actor, sessionId);
  const rows: Array<Array<string | number | boolean | null>> = [[
    "record_type", "session_id", "session_title", "question", "group_id", "group_label",
    "group_response", "student_name", "student_email", "rank", "ranking_submitted_at",
  ]];
  for (const group of snapshot.groups) {
    rows.push([
      "group_response", snapshot.session.id, snapshot.session.title, snapshot.session.question,
      group.id, group.label, group.response.content, null, null, null, group.response.updatedAt,
    ]);
  }
  for (const ranking of snapshot.rawRankings) {
    ranking.orderedGroupIds.forEach((groupId, index) => {
      const group = snapshot.groups.find((item) => item.id === groupId);
      rows.push([
        "individual_ranking", snapshot.session.id, snapshot.session.title, snapshot.session.question,
        groupId, group?.label ?? "", null, ranking.displayName, ranking.email, index + 1, ranking.submittedAt,
      ]);
    });
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}
