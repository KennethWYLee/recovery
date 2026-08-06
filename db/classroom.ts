import { env } from "cloudflare:workers";
import { classroomIdentityKind, normalizeClassroomEmail } from "@/lib/classroom-access";
import { resolveClassroomIdentity, type ClassroomEnvironment } from "@/lib/classroom-auth";
import {
  CLASSROOM_DEFAULT_COURSES,
  courseNameKey,
  currentAcademicTerm,
  normalizeCourseName,
  type AcademicTerm,
  type ClassroomCourse,
  type ClassroomRole,
} from "@/lib/classroom-domain";

export type ClassroomActor = {
  id: string;
  email: string;
  displayName: string;
  role: ClassroomRole;
  isAdmin: boolean;
};

export type ClassroomAccessStatus = "pending" | "approved" | "rejected";

export type ClassroomAccessRequest = {
  id: string;
  email: string;
  displayName: string;
  status: ClassroomAccessStatus;
  version: number;
  requestedAt: string;
  lastRequestedAt: string;
  reviewedAt: string | null;
  reviewedByEmail: string | null;
};

export type ClassroomAllowlistEntry = {
  email: string;
  displayName: string;
  approvedAt: string;
  approvedByEmail: string;
};

export type ClassroomAccessFailureReason = "domain_not_allowed" | "approval_pending" | "approval_rejected";

export class ClassroomAccessError extends Error {
  readonly reason: ClassroomAccessFailureReason;

  constructor(reason: ClassroomAccessFailureReason, message: string) {
    super(message);
    this.reason = reason;
    this.name = "ClassroomAccessError";
  }
}

let schemaReady: Promise<void> | null = null;

export function classroomEnvironment(): CloudflareEnv & ClassroomEnvironment {
  return env as unknown as CloudflareEnv & ClassroomEnvironment;
}

export function classroomDb(): D1Database {
  const db = classroomEnvironment().DB;
  if (!db) throw new Error("Cloudflare D1 binding DB is unavailable.");
  return db;
}

export function classroomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function classroomNow(): string {
  return new Date().toISOString();
}

export async function enforceClassroomMutationRateLimit(
  db: D1Database,
  actor: ClassroomActor,
  pathname: string,
  limit = 120,
  windowSeconds = 60,
): Promise<boolean> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const threshold = nowSeconds - windowSeconds;
  const scopeKey = `${actor.id}:${pathname.slice(0, 120)}`;
  const row = await db.prepare(
    `INSERT INTO classroom_rate_limits (scope_key, window_started_at, request_count, updated_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(scope_key) DO UPDATE SET
       window_started_at = CASE WHEN classroom_rate_limits.window_started_at <= ? THEN excluded.window_started_at ELSE classroom_rate_limits.window_started_at END,
       request_count = CASE WHEN classroom_rate_limits.window_started_at <= ? THEN 1 ELSE classroom_rate_limits.request_count + 1 END,
       updated_at = excluded.updated_at
     RETURNING request_count`,
  ).bind(scopeKey, nowSeconds, classroomNow(), threshold, threshold).first<{ request_count: number }>();
  return Boolean(row && row.request_count <= limit);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function ensureClassroomSchema(db = classroomDb()): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const tables = await db.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('classroom_users', 'classroom_courses', 'classroom_course_members', 'classroom_course_roster', 'classroom_seed_state', 'classroom_audit_events', 'classroom_access_requests', 'classroom_access_allowlist', 'classroom_sessions', 'classroom_groups', 'classroom_session_participants', 'classroom_group_responses', 'classroom_ranking_submissions', 'classroom_ranking_items', 'classroom_rate_limits', 'classroom_questions', 'classroom_question_memberships', 'classroom_question_responses', 'classroom_question_ranking_submissions', 'classroom_question_ranking_items') ORDER BY name",
      ).all<{ name: string }>();
      if (tables.results.length !== 20) throw new Error("The classroom database schema is incomplete.");
      await db.prepare("PRAGMA optimize").run();
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export async function loadOrProvisionClassroomActor(request: Request): Promise<ClassroomActor | null> {
  const environment = classroomEnvironment();
  const identity = resolveClassroomIdentity(request, environment);
  if (!identity) return null;
  const email = normalizeClassroomEmail(identity.email);
  if (!email) return null;
  const identityKind = classroomIdentityKind(email, environment.CLASSROOM_ADMIN_EMAILS);
  if (identityKind === "ineligible") {
    throw new ClassroomAccessError("domain_not_allowed", "僅開放 @ntub.edu.tw 帳號登入。");
  }
  const isAdmin = identityKind === "administrator";
  const provisionedRole: ClassroomRole = isAdmin ? "teacher" : "student";

  const db = classroomDb();
  await ensureClassroomSchema(db);
  const id = `class-user-${(await sha256(email)).slice(0, 24)}`;
  const now = classroomNow();
  const displayName = (identity.displayName.trim() || email).slice(0, 120);
  let actor = await db.prepare(
    "SELECT id, email, display_name, role, last_seen_at FROM classroom_users WHERE email = ? AND status = 'active'",
  ).bind(email).first<{ id: string; email: string; display_name: string; role: string; last_seen_at: string }>();
  if (!actor) {
    await db.prepare(
      `INSERT INTO classroom_users (id, email, display_name, role, status, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).bind(id, email, displayName, provisionedRole, now, now).run();
    actor = { id, email, display_name: displayName, role: provisionedRole, last_seen_at: now };
  } else {
    const lastSeen = Date.parse(actor.last_seen_at);
    const stale = !Number.isFinite(lastSeen) || Date.now() - lastSeen >= 5 * 60 * 1000;
    const roleNeedsPromotion = isAdmin && actor.role !== "teacher";
    if (stale || actor.display_name !== displayName || roleNeedsPromotion) {
      await db.prepare(
        `UPDATE classroom_users
         SET display_name = ?, role = CASE WHEN role = 'teacher' THEN 'teacher' ELSE ? END, last_seen_at = ?
         WHERE id = ?`,
      ).bind(displayName, provisionedRole, now, actor.id).run();
      actor = { ...actor, display_name: displayName, role: roleNeedsPromotion ? "teacher" : actor.role, last_seen_at: now };
    }
  }
  if (!actor || (actor.role !== "teacher" && actor.role !== "student")) return null;
  const result: ClassroomActor = {
    id: actor.id,
    email: actor.email,
    displayName: actor.display_name,
    role: actor.role,
    isAdmin,
  };
  if (!isAdmin) {
    const allowlisted = await db.prepare(
      "SELECT email FROM classroom_access_allowlist WHERE email = ? AND user_id = ? AND status = 'active'",
    ).bind(email, result.id).first<{ email: string }>();
    const studentId = email.slice(0, email.lastIndexOf("@"));
    const rosterMatches = await db.prepare(
      `SELECT r.course_id, r.imported_by_user_id
       FROM classroom_course_roster r
       JOIN classroom_courses c ON c.id = r.course_id
       WHERE r.status = 'active' AND c.status = 'active' AND (r.email = ? OR r.student_id = ?)
       ORDER BY r.course_id`,
    ).bind(email, studentId).all<{ course_id: string; imported_by_user_id: string }>();
    if (rosterMatches.results.length > 0) {
      const statements = rosterMatches.results.map((match) => db.prepare(
        `INSERT INTO classroom_course_members
          (id, course_id, user_id, role, status, joined_at, updated_at)
         VALUES (?, ?, ?, 'student', 'active', ?, ?)
         ON CONFLICT(course_id, user_id) DO UPDATE SET status = 'active', role = 'student', updated_at = excluded.updated_at`,
      ).bind(classroomId("course-member"), match.course_id, result.id, now, now));
      statements.push(db.prepare(
        `UPDATE classroom_access_requests
         SET status = 'approved', version = version + 1, reviewed_by_user_id = ?, reviewed_at = ?
         WHERE email = ? AND status != 'approved'`,
      ).bind(rosterMatches.results[0].imported_by_user_id, now, email));
      await db.batch(statements);
    }
    if (!allowlisted && rosterMatches.results.length === 0) {
      const request = await recordClassroomAccessRequest(db, result);
      if (request.status === "rejected") {
        throw new ClassroomAccessError("approval_rejected", "此帳號的使用申請尚未獲准，請洽系統管理員。");
      }
      throw new ClassroomAccessError("approval_pending", "申請已送出，系統管理員核准後即可使用。");
    }
  }
  if (isAdmin) {
    await seedTeacherCourses(db, result);
    await ensureDemoClassroom(db, result);
  }
  return result;
}

async function recordClassroomAccessRequest(db: D1Database, actor: ClassroomActor): Promise<{ status: ClassroomAccessStatus }> {
  const now = classroomNow();
  await db.prepare(
    `INSERT INTO classroom_access_requests
      (id, user_id, email, display_name, status, version, requested_at, last_requested_at, reviewed_by_user_id, reviewed_at)
     VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, NULL, NULL)
     ON CONFLICT(email) DO UPDATE SET
       display_name = excluded.display_name,
       status = CASE WHEN classroom_access_requests.status = 'approved' THEN 'pending' ELSE classroom_access_requests.status END,
       version = CASE WHEN classroom_access_requests.status = 'approved' THEN classroom_access_requests.version + 1 ELSE classroom_access_requests.version END,
       last_requested_at = excluded.last_requested_at,
       reviewed_by_user_id = CASE WHEN classroom_access_requests.status = 'approved' THEN NULL ELSE classroom_access_requests.reviewed_by_user_id END,
       reviewed_at = CASE WHEN classroom_access_requests.status = 'approved' THEN NULL ELSE classroom_access_requests.reviewed_at END`,
  ).bind(classroomId("access-request"), actor.id, actor.email, actor.displayName, now, now).run();
  const request = await db.prepare(
    "SELECT status FROM classroom_access_requests WHERE email = ?",
  ).bind(actor.email).first<{ status: ClassroomAccessStatus }>();
  if (!request) throw new Error("The access request could not be read.");
  return request;
}

async function seedTeacherCourses(db: D1Database, actor: ClassroomActor): Promise<void> {
  const seeded = await db.prepare("SELECT user_id FROM classroom_seed_state LIMIT 1")
    .first<{ user_id: string }>();
  if (seeded) return;
  const now = classroomNow();
  const { academicYear, term } = currentAcademicTerm(new Date(now));
  const statements: D1PreparedStatement[] = [];
  for (const name of CLASSROOM_DEFAULT_COURSES) {
    const key = courseNameKey(name);
    const courseId = `course-${(await sha256(`${actor.id}|${academicYear}|${term}|${key}`)).slice(0, 24)}`;
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO classroom_courses
          (id, owner_user_id, name, name_key, academic_year, term, status, version, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, NULL)`,
      ).bind(courseId, actor.id, name, key, academicYear, term, now, now),
      db.prepare(
        `INSERT OR IGNORE INTO classroom_course_members
          (id, course_id, user_id, role, status, joined_at, updated_at)
         VALUES (?, ?, ?, 'teacher', 'active', ?, ?)`,
      ).bind(`course-member-${(await sha256(`${courseId}|${actor.id}`)).slice(0, 24)}`, courseId, actor.id, now, now),
    );
  }
  statements.push(
    db.prepare("INSERT OR IGNORE INTO classroom_seed_state (user_id, seeded_at) VALUES (?, ?)").bind(actor.id, now),
  );
  await db.batch(statements);
}

async function runClassroomBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += 60) {
    await db.batch(statements.slice(index, index + 60));
  }
}

function demoRankOrder(base: number[], ownGroup: number, studentIndex: number): number[] {
  const order = base.filter((group) => group !== ownGroup);
  if (studentIndex % 4 === 1) [order[1], order[2]] = [order[2], order[1]];
  if (studentIndex % 4 === 2) [order[3], order[4]] = [order[4], order[3]];
  return order;
}

async function ensureDemoClassroom(db: D1Database, actor: ClassroomActor): Promise<void> {
  const courseId = "course-demo-classroom";
  const sessionId = "session-demo-classroom";
  const existing = await db.prepare("SELECT id FROM classroom_sessions WHERE id = ?")
    .bind(sessionId).first<{ id: string }>();
  if (existing) return;

  const now = classroomNow();
  const earlier = (minutes: number) => new Date(Date.parse(now) - minutes * 60_000).toISOString();
  const statements: D1PreparedStatement[] = [];
  statements.push(
    db.prepare(
      `INSERT OR IGNORE INTO classroom_courses
        (id, owner_user_id, name, name_key, academic_year, term, default_group_capacity,
         default_group_count, is_demo, status, version, created_at, updated_at, deleted_at)
       VALUES (?, ?, '示範課程｜資料庫決策與分析', '示範課程｜資料庫決策與分析', 115, '1', 4, 6, 1, 'active', 1, ?, ?, NULL)`,
    ).bind(courseId, actor.id, earlier(180), now),
    db.prepare(
      `INSERT OR IGNORE INTO classroom_course_members
        (id, course_id, user_id, role, status, joined_at, updated_at)
       VALUES ('course-member-demo-teacher', ?, ?, 'teacher', 'active', ?, ?)`,
    ).bind(courseId, actor.id, earlier(180), now),
    db.prepare(
      `INSERT OR IGNORE INTO classroom_sessions
        (id, course_id, title, question, ranking_criteria, join_code, phase,
         group_capacity, effective_group_capacity, anonymous_groups, allow_ranking_edits,
         group_count, admission_open, qr_enabled, version, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, '示範課堂｜資料庫設計決策', '本次課堂包含多個示範問題。',
         '依回答的正確性、解釋力及理由充分程度完成排序。', 'DEMA26', 'answering',
         4, 4, 1, 1, 6, 0, 0, 1, ?, ?, ?)`,
    ).bind(sessionId, courseId, actor.id, earlier(170), now),
  );

  const groupIds = Array.from({ length: 6 }, (_, index) => `group-demo-${index + 1}`);
  for (let index = 0; index < groupIds.length; index += 1) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO classroom_groups
        (id, session_id, label, position, representative_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    ).bind(groupIds[index], sessionId, `第 ${index + 1} 組`, index + 1, earlier(150), now));
  }

  for (let index = 0; index < 24; index += 1) {
    const number = index + 1;
    const userId = `demo-user-${number}`;
    const email = `demo.student${String(number).padStart(2, "0")}@example.invalid`;
    const groupId = groupIds[Math.floor(index / 4)];
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO classroom_users
          (id, email, display_name, role, status, created_at, last_seen_at)
         VALUES (?, ?, ?, 'student', 'active', ?, ?)`,
      ).bind(userId, email, `虛擬學生 ${String(number).padStart(2, "0")}`, earlier(160 - index), earlier(20 - Math.min(index, 19))),
      db.prepare(
        `INSERT OR IGNORE INTO classroom_course_members
          (id, course_id, user_id, role, status, joined_at, updated_at)
         VALUES (?, ?, ?, 'student', 'active', ?, ?)`,
      ).bind(`course-member-demo-${number}`, courseId, userId, earlier(150 - index), now),
      db.prepare(
        `INSERT OR IGNORE INTO classroom_session_participants
          (id, session_id, user_id, group_id, attendance, joined_phase, can_rank,
           checked_in_at, grouped_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        `participant-demo-${number}`, sessionId, userId, groupId,
        number > 21 ? "late" : "on_time", number > 21 ? "answering" : "check_in",
        earlier(145 - index), earlier(115), now,
      ),
    );
  }
  for (let index = 0; index < groupIds.length; index += 1) {
    statements.push(db.prepare(
      "UPDATE classroom_groups SET representative_user_id = ? WHERE id = ? AND representative_user_id IS NULL",
    ).bind(`demo-user-${index * 4 + 1}`, groupIds[index]));
  }

  const questions = [
    {
      id: "question-demo-1", phase: "published", position: 1,
      text: "尖峰促銷時，同一件商品只剩 1 件，兩位顧客同時結帳。系統應如何避免超賣？",
      criteria: "請依方案能否避免超賣、說明是否完整，以及失敗時是否能安全處理進行排序。",
      opened: earlier(105), locked: earlier(82), rankingLocked: earlier(67), published: earlier(64),
    },
    {
      id: "question-demo-2", phase: "published", position: 2,
      text: "訂單查詢從 0.4 秒變成 8 秒。現有 Log 顯示資料庫讀取量突然增加，你會先檢查什麼？",
      criteria: "請依定位順序是否合理、是否使用可核對資料，以及改善方式是否會造成新風險進行排序。",
      opened: earlier(58), locked: earlier(41), rankingLocked: earlier(27), published: earlier(24),
    },
    {
      id: "question-demo-3", phase: "answering", position: 3,
      text: "商品價格在尖峰期間被錯誤改為 0 元。你會如何停止影響、找出原因並安全恢復？",
      criteria: "請依處理順序、證據使用、資料修正與後續預防是否完整進行排序。",
      opened: earlier(12), locked: null, rankingLocked: null, published: null,
    },
  ] as const;
  for (const question of questions) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO classroom_questions
        (id, session_id, question_text, ranking_criteria, phase, position, version, opened_at,
         responses_locked_at, ranking_locked_at, published_at, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      question.id, sessionId, question.text, question.criteria, question.phase, question.position,
      question.opened, question.locked, question.rankingLocked, question.published,
      actor.id, earlier(110 - question.position * 5), question.published ?? question.opened,
    ));
    for (let index = 0; index < 24; index += 1) {
      const number = index + 1;
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO classroom_question_memberships
          (id, question_id, user_id, group_id, can_rank, captured_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      ).bind(`qmember-demo-${question.position}-${number}`, question.id, `demo-user-${number}`, groupIds[Math.floor(index / 4)], question.opened));
    }
  }

  const answers = [
    [
      "在庫存資料列上使用交易與條件更新：只有庫存量大於 0 時才能扣減。更新成功才建立訂單；失敗則回覆已售完。並以兩個同時結帳的整合測試確認只會成功一筆。",
      "先建立訂單，再用排程每分鐘檢查庫存；若超賣就取消較晚的訂單並通知顧客。",
      "在應用程式記憶體加鎖，讓同一台伺服器一次只處理一筆結帳。",
      "使用資料庫交易鎖定商品庫存，扣減與訂單建立同時成功或同時失敗；另設定逾時與失敗重試上限。",
      "每次結帳前重新查一次庫存，畫面顯示有貨就允許完成付款。",
      "將庫存先扣成負數，再由管理員每天人工修正異常訂單。",
    ],
    [
      "先用慢查詢紀錄確認是哪一段 SQL，再檢查執行計畫、掃描筆數與近期資料量變化；修正索引後比較修改前後的時間與讀取量。",
      "先增加伺服器規格，若速度恢復就不再處理。",
      "檢查最近部署與查詢條件是否改變，再用相同輸入重現問題，確認索引是否被使用及回傳資料是否過多。",
      "直接清除所有歷史訂單，減少資料筆數。",
      "比較正常與異常時段的 P95 查詢時間、掃描列數與錯誤 Log，確認瓶頸後以小流量驗證改善。",
      "重新啟動資料庫，觀察問題是否暫時消失。",
    ],
    [
      "先暫停受影響商品的結帳，保留價格異動與操作者紀錄，再確認影響訂單範圍。修正後以抽樣訂單和回歸測試確認金額。",
      "立即把價格改回去，之後再看是否有人反映。",
      "先關閉價格更新入口並查核異動 Log、部署紀錄與資料庫更新來源；建立受影響清單後分批修正並保留稽核紀錄。",
      "先刪除錯誤訂單，避免報表看到異常資料。",
      "草擬中：比較異常前後價格、找出受影響交易，再設計修正與通知流程。",
      "草擬中：停止新交易、保留證據、確認影響範圍。",
    ],
  ];
  for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
    for (let groupIndex = 0; groupIndex < groupIds.length; groupIndex += 1) {
      const active = questionIndex === 2;
      const submitted = !active || groupIndex < 3;
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO classroom_question_responses
          (id, question_id, group_id, content, status, version, updated_by_user_id, submitted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ).bind(
        `qresponse-demo-${questionIndex + 1}-${groupIndex + 1}`, questions[questionIndex].id,
        groupIds[groupIndex], answers[questionIndex][groupIndex], active ? (submitted ? "submitted" : "draft") : "locked",
        `demo-user-${groupIndex * 4 + 1}`, submitted ? earlier(active ? 5 + groupIndex : 70 - questionIndex * 40 - groupIndex) : null,
        earlier(active ? 5 + groupIndex : 70 - questionIndex * 40 - groupIndex),
      ));
    }
  }

  const bases = [[2, 5, 1, 4, 6, 3], [4, 1, 6, 3, 2, 5]];
  for (let questionIndex = 0; questionIndex < 2; questionIndex += 1) {
    for (let studentIndex = 0; studentIndex < 24; studentIndex += 1) {
      const number = studentIndex + 1;
      const ownGroup = Math.floor(studentIndex / 4) + 1;
      const submissionId = `qranking-demo-${questionIndex + 1}-${number}`;
      const order = demoRankOrder(bases[questionIndex], ownGroup, studentIndex);
      statements.push(db.prepare(
        `INSERT OR IGNORE INTO classroom_question_ranking_submissions
          (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
         VALUES (?, ?, ?, 1, 1, 'valid', NULL, ?)`,
      ).bind(submissionId, questions[questionIndex].id, `demo-user-${number}`, earlier(questionIndex === 0 ? 69 - studentIndex / 3 : 29 - studentIndex / 3)));
      for (let rank = 0; rank < order.length; rank += 1) {
        statements.push(db.prepare(
          `INSERT OR IGNORE INTO classroom_question_ranking_items
            (id, submission_id, group_id, rank) VALUES (?, ?, ?, ?)`,
        ).bind(`qrank-item-demo-${questionIndex + 1}-${number}-${rank + 1}`, submissionId, groupIds[order[rank] - 1], rank + 1));
      }
    }
  }
  statements.push(db.prepare(
    `INSERT OR IGNORE INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES ('class-audit-demo-seed', ?, 'demo.seed', 'classroom_session', ?, ?, ?)`,
  ).bind(actor.id, sessionId, JSON.stringify({ synthetic: true, students: 24, groups: 6, questions: 3 }), now));
  await runClassroomBatches(db, statements);
}

function mapCourse(row: {
  id: string;
  name: string;
  academic_year: number;
  term: string;
  default_group_capacity: number;
  default_group_count: number;
  is_demo: number;
  student_count: number;
  roster_count: number;
  session_count: number;
  active_session_id: string | null;
  active_session_phase: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}): ClassroomCourse {
  if (row.term !== "1" && row.term !== "2" && row.term !== "summer") {
    throw new Error("A course has an unsupported academic term.");
  }
  return {
    id: row.id,
    name: row.name,
    academicYear: row.academic_year,
    term: row.term,
    defaultGroupCapacity: row.default_group_capacity,
    defaultGroupCount: row.default_group_count,
    isDemo: row.is_demo === 1,
    studentCount: row.student_count,
    rosterCount: row.roster_count,
    sessionCount: row.session_count,
    activeSessionId: row.active_session_id,
    activeSessionPhase: row.active_session_phase as ClassroomCourse["activeSessionPhase"],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const COURSE_SELECT_COLUMNS = `c.id, c.name, c.academic_year, c.term, c.default_group_capacity, c.default_group_count, c.is_demo, c.version, c.created_at, c.updated_at,
  (SELECT COUNT(*) FROM classroom_course_members cm WHERE cm.course_id = c.id AND cm.role = 'student' AND cm.status = 'active') AS student_count,
  (SELECT COUNT(*) FROM classroom_course_roster cr WHERE cr.course_id = c.id AND cr.status = 'active') AS roster_count,
  (SELECT COUNT(*) FROM classroom_sessions cs WHERE cs.course_id = c.id) AS session_count,
  (SELECT cs.id FROM classroom_sessions cs WHERE cs.course_id = c.id AND cs.phase != 'archived' ORDER BY cs.created_at DESC LIMIT 1) AS active_session_id,
  (SELECT cs.phase FROM classroom_sessions cs WHERE cs.course_id = c.id AND cs.phase != 'archived' ORDER BY cs.created_at DESC LIMIT 1) AS active_session_phase`;

const MEMBER_COURSE_SELECT = `SELECT ${COURSE_SELECT_COLUMNS}
  FROM classroom_courses c
  JOIN classroom_course_members m ON m.course_id = c.id
  WHERE m.user_id = ? AND m.status = 'active' AND c.status = 'active'`;

const ADMIN_COURSE_SELECT = `SELECT ${COURSE_SELECT_COLUMNS}
  FROM classroom_courses c
  WHERE c.status = 'active'`;

export async function listClassroomCourses(db: D1Database, actor: ClassroomActor): Promise<ClassroomCourse[]> {
  const statement = actor.isAdmin
    ? db.prepare(`${ADMIN_COURSE_SELECT} ORDER BY c.updated_at DESC, c.name_key`)
    : db.prepare(`${MEMBER_COURSE_SELECT} ORDER BY c.updated_at DESC, c.name_key`).bind(actor.id);
  const rows = await statement
    .all<Parameters<typeof mapCourse>[0]>();
  return rows.results.map(mapCourse);
}

export async function getClassroomCourse(db: D1Database, actor: ClassroomActor, courseId: string): Promise<ClassroomCourse | null> {
  const statement = actor.isAdmin
    ? db.prepare(`${ADMIN_COURSE_SELECT} AND c.id = ? LIMIT 1`).bind(courseId)
    : db.prepare(`${MEMBER_COURSE_SELECT} AND c.id = ? LIMIT 1`).bind(actor.id, courseId);
  const row = await statement
    .first<Parameters<typeof mapCourse>[0]>();
  return row ? mapCourse(row) : null;
}

export async function createClassroomCourse(
  db: D1Database,
  actor: ClassroomActor,
  values: { name: unknown; academicYear: number; term: AcademicTerm; defaultGroupCount: number },
): Promise<ClassroomCourse> {
  const name = normalizeCourseName(values.name);
  const nameKey = courseNameKey(name);
  const now = classroomNow();
  const { academicYear, term, defaultGroupCount } = values;
  const courseId = classroomId("course");
  const memberId = classroomId("course-member");
  const auditId = classroomId("class-audit");
  await db.batch([
    db.prepare(
      `INSERT INTO classroom_courses
        (id, owner_user_id, name, name_key, academic_year, term, default_group_capacity, default_group_count, is_demo, status, version, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, 6, ?, 0, 'active', 1, ?, ?, NULL)`,
    ).bind(courseId, actor.id, name, nameKey, academicYear, term, defaultGroupCount, now, now),
    db.prepare(
      `INSERT INTO classroom_course_members
        (id, course_id, user_id, role, status, joined_at, updated_at)
       VALUES (?, ?, ?, 'teacher', 'active', ?, ?)`,
    ).bind(memberId, courseId, actor.id, now, now),
    db.prepare(
      `INSERT INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, 'course.create', 'course', ?, ?, ?)`,
    ).bind(auditId, actor.id, courseId, JSON.stringify({ name, academicYear, term, defaultGroupCount }), now),
  ]);
  const course = await getClassroomCourse(db, actor, courseId);
  if (!course) throw new Error("The created course could not be read.");
  return course;
}

export async function renameClassroomCourse(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  nameValue: unknown,
  expectedVersion: number,
): Promise<ClassroomCourse | null> {
  const current = await getClassroomCourse(db, actor, courseId);
  if (!current) return null;
  const name = normalizeCourseName(nameValue);
  const now = classroomNow();
  const result = await db.prepare(
    `UPDATE classroom_courses
     SET name = ?, name_key = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'active' AND version = ?`,
  ).bind(name, courseNameKey(name), now, courseId, expectedVersion).run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  await db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'course.rename', 'course', ?, ?, ?)`,
  ).bind(classroomId("class-audit"), actor.id, courseId, JSON.stringify({ from: current.name, to: name }), now).run();
  return getClassroomCourse(db, actor, courseId);
}

export async function deleteClassroomCourse(
  db: D1Database,
  actor: ClassroomActor,
  courseId: string,
  expectedVersion: number,
): Promise<boolean> {
  const current = await getClassroomCourse(db, actor, courseId);
  if (!current) return false;
  const now = classroomNow();
  const result = await db.prepare(
    `UPDATE classroom_courses
     SET status = 'deleted', deleted_at = ?, version = version + 1, updated_at = ?
     WHERE id = ? AND status = 'active' AND version = ?`,
  ).bind(now, now, courseId, expectedVersion).run();
  if ((result.meta.changes ?? 0) !== 1) return false;
  await db.prepare(
    `INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
     VALUES (?, ?, 'course.delete', 'course', ?, ?, ?)`,
  ).bind(classroomId("class-audit"), actor.id, courseId, JSON.stringify({ name: current.name }), now).run();
  return true;
}

export async function listClassroomAccessRequests(
  db: D1Database,
  actor: ClassroomActor,
): Promise<{ requests: ClassroomAccessRequest[]; allowlist: ClassroomAllowlistEntry[] }> {
  if (!actor.isAdmin) throw new ClassroomAccessError("domain_not_allowed", "只有系統管理員可以審核登入申請。");
  const [requestRows, allowlistRows] = await Promise.all([
    db.prepare(
      `SELECT r.id, r.email, r.display_name, r.status, r.version, r.requested_at,
              r.last_requested_at, r.reviewed_at, reviewer.email AS reviewed_by_email
       FROM classroom_access_requests r
       LEFT JOIN classroom_users reviewer ON reviewer.id = r.reviewed_by_user_id
       ORDER BY CASE r.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                r.last_requested_at DESC`,
    ).all<{
      id: string; email: string; display_name: string; status: ClassroomAccessStatus; version: number;
      requested_at: string; last_requested_at: string; reviewed_at: string | null; reviewed_by_email: string | null;
    }>(),
    db.prepare(
      `SELECT a.email, u.display_name, a.approved_at, approver.email AS approved_by_email
       FROM classroom_access_allowlist a
       JOIN classroom_users u ON u.id = a.user_id
       JOIN classroom_users approver ON approver.id = a.approved_by_user_id
       WHERE a.status = 'active'
       ORDER BY a.approved_at DESC`,
    ).all<{ email: string; display_name: string; approved_at: string; approved_by_email: string }>(),
  ]);
  return {
    requests: requestRows.results.map((row) => ({
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      status: row.status,
      version: row.version,
      requestedAt: row.requested_at,
      lastRequestedAt: row.last_requested_at,
      reviewedAt: row.reviewed_at,
      reviewedByEmail: row.reviewed_by_email,
    })),
    allowlist: allowlistRows.results.map((row) => ({
      email: row.email,
      displayName: row.display_name,
      approvedAt: row.approved_at,
      approvedByEmail: row.approved_by_email,
    })),
  };
}

export async function reviewClassroomAccessRequest(
  db: D1Database,
  actor: ClassroomActor,
  requestId: string,
  action: "approve" | "reject",
  expectedVersion: number,
): Promise<ClassroomAccessRequest | null> {
  if (!actor.isAdmin) throw new ClassroomAccessError("domain_not_allowed", "只有系統管理員可以審核登入申請。");
  const current = await db.prepare(
    `SELECT id, user_id, email, display_name, status, version, requested_at, last_requested_at
     FROM classroom_access_requests WHERE id = ?`,
  ).bind(requestId).first<{
    id: string; user_id: string; email: string; display_name: string; status: ClassroomAccessStatus;
    version: number; requested_at: string; last_requested_at: string;
  }>();
  if (!current || current.version !== expectedVersion) return null;

  const status: ClassroomAccessStatus = action === "approve" ? "approved" : "rejected";
  const now = classroomNow();
  const nextVersion = expectedVersion + 1;
  const updated = await db.prepare(
    `UPDATE classroom_access_requests
     SET status = ?, version = version + 1, reviewed_by_user_id = ?, reviewed_at = ?
     WHERE id = ? AND version = ?`,
  ).bind(status, actor.id, now, requestId, expectedVersion).run();
  if ((updated.meta.changes ?? 0) !== 1) return null;

  const auditId = `class-audit-access-${requestId}-${nextVersion}`;
  const followUp: D1PreparedStatement[] = action === "approve"
    ? [
        db.prepare(
          `INSERT INTO classroom_access_allowlist
            (email, user_id, status, approved_by_user_id, approved_at, updated_at)
           VALUES (?, ?, 'active', ?, ?, ?)
           ON CONFLICT(email) DO UPDATE SET
             user_id = excluded.user_id,
             status = 'active',
             approved_by_user_id = excluded.approved_by_user_id,
             approved_at = excluded.approved_at,
             updated_at = excluded.updated_at`,
        ).bind(current.email, current.user_id, actor.id, now, now),
      ]
    : [
        db.prepare("DELETE FROM classroom_access_allowlist WHERE email = ?").bind(current.email),
      ];
  followUp.push(
    db.prepare(
      `INSERT OR IGNORE INTO classroom_audit_events
        (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
       VALUES (?, ?, ?, 'access_request', ?, ?, ?)`,
    ).bind(auditId, actor.id, `access.${action}`, requestId, JSON.stringify({ email: current.email }), now),
  );
  await db.batch(followUp);

  const result = await db.prepare(
    `SELECT r.id, r.email, r.display_name, r.status, r.version, r.requested_at,
            r.last_requested_at, r.reviewed_at, reviewer.email AS reviewed_by_email
     FROM classroom_access_requests r
     LEFT JOIN classroom_users reviewer ON reviewer.id = r.reviewed_by_user_id
     WHERE r.id = ?`,
  ).bind(requestId).first<{
    id: string; email: string; display_name: string; status: ClassroomAccessStatus; version: number;
    requested_at: string; last_requested_at: string; reviewed_at: string | null; reviewed_by_email: string | null;
  }>();
  return result ? {
    id: result.id,
    email: result.email,
    displayName: result.display_name,
    status: result.status,
    version: result.version,
    requestedAt: result.requested_at,
    lastRequestedAt: result.last_requested_at,
    reviewedAt: result.reviewed_at,
    reviewedByEmail: result.reviewed_by_email,
  } : null;
}
