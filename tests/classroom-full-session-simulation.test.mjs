import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { performance } from "node:perf_hooks";
import {
  completeClassroomRankingOrder,
  rankResults,
  rankingPosition,
  rankingsExcludingOwnGroup,
} from "../lib/classroom-domain.ts";

const migrationUrls = [
  "0001_classroom_courses.sql",
  "0002_classroom_access_approval.sql",
  "0003_classroom_live_sessions.sql",
  "0004_multi_question_classrooms.sql",
  "0005_course_roster.sql",
  "0006_course_question_bank.sql",
  "0007_student_live_flow.sql",
  "0008_classroom_schema_state.sql",
  "0009_classroom_observability.sql",
].map((name) => new URL(`../drizzle/${name}`, import.meta.url));

const NOW = "2026-08-19T02:00:00.000Z";
const DEADLINE = "2026-08-19T02:10:00.000Z";
const GROUP_IDS = Array.from({ length: 6 }, (_, index) => `group-${index + 1}`);
const STUDENT_IDS = Array.from({ length: 50 }, (_, index) => `student-${index + 1}`);
const GROUP_MEMBERS = GROUP_IDS.map((_, groupIndex) =>
  STUDENT_IDS.filter((_, studentIndex) => studentIndex % GROUP_IDS.length === groupIndex));
const LATE_STUDENT_ID = "student-late";
const PREFERRED_ORDER = [...GROUP_IDS].reverse();

async function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const migrationUrl of migrationUrls) {
    const migration = await readFile(migrationUrl, "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
      db.prepare(statement).run();
    }
  }
  return db;
}

function seedPeopleAndCourse(db) {
  db.prepare("INSERT INTO classroom_users VALUES ('teacher-1', 'teacher@ntub.edu.tw', '教師', 'teacher', 'active', ?, ?)")
    .run(NOW, NOW);
  for (const [index, studentId] of [...STUDENT_IDS, LATE_STUDENT_ID].entries()) {
    db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'student', 'active', ?, ?)")
      .run(studentId, `${studentId}@ntub.edu.tw`, `學生 ${index + 1}`, NOW, NOW);
  }
  db.prepare(`INSERT INTO classroom_courses
    (id, owner_user_id, name, name_key, academic_year, term, default_group_capacity,
     default_group_count, is_demo, status, version, created_at, updated_at, deleted_at)
    VALUES ('course-1', 'teacher-1', '資料庫', '資料庫', 115, '1', 5, 6, 0, 'active', 1, ?, ?, NULL)`)
    .run(NOW, NOW);
  db.prepare(`INSERT INTO classroom_sessions
    (id, course_id, title, question, ranking_criteria, join_code, phase, group_capacity,
     effective_group_capacity, anonymous_groups, allow_ranking_edits, group_count,
     admission_open, qr_enabled, version, created_by_user_id, created_at, updated_at)
    VALUES ('session-1', 'course-1', '完整課堂演練', '尚未建立問題', '尚未設定排序判準',
      'SIM246', 'answering', 5, 5, 1, 0, 6, 1, 1, 3, 'teacher-1', ?, ?)`)
    .run(NOW, NOW);
}

function seedBalancedGroups(db) {
  for (const [groupIndex, groupId] of GROUP_IDS.entries()) {
    const representative = GROUP_MEMBERS[groupIndex][0];
    db.prepare(`INSERT INTO classroom_groups
      (id, session_id, label, position, representative_user_id, created_at, updated_at)
      VALUES (?, 'session-1', ?, ?, ?, ?, ?)`)
      .run(groupId, `第 ${groupIndex + 1} 組`, groupIndex + 1, representative, NOW, NOW);
    for (const studentId of GROUP_MEMBERS[groupIndex]) {
      db.prepare(`INSERT INTO classroom_session_participants
        (id, session_id, user_id, group_id, attendance, joined_phase, can_rank,
         checked_in_at, grouped_at, updated_at)
        VALUES (?, 'session-1', ?, ?, 'on_time', 'check_in', 1, ?, ?, ?)`)
        .run(`participant-${studentId}`, studentId, groupId, NOW, NOW, NOW);
    }
  }
}

function openFirstQuestion(db) {
  db.prepare(`INSERT INTO classroom_questions
    (id, session_id, question_text, ranking_criteria, source_question_bank_id, phase,
     answer_duration_seconds, answer_deadline_at, position, version, opened_at,
     responses_locked_at, ranking_locked_at, published_at, created_by_user_id, created_at, updated_at)
    VALUES ('question-1', 'session-1', '哪一個資料模型最能支持需求？',
      '請依正確性、解釋力及理由充分程度完整排序。', NULL, 'answering', 600, ?, 1, 2, ?,
      NULL, NULL, NULL, 'teacher-1', ?, ?)`)
    .run(DEADLINE, NOW, NOW, NOW);
  for (const studentId of STUDENT_IDS) {
    const groupId = GROUP_IDS[(Number(studentId.split("-")[1]) - 1) % GROUP_IDS.length];
    db.prepare(`INSERT INTO classroom_question_memberships
      (id, question_id, user_id, group_id, can_rank, captured_at)
      VALUES (?, 'question-1', ?, ?, 1, ?)`)
      .run(`membership-q1-${studentId}`, studentId, groupId, NOW);
  }
  for (const groupId of GROUP_IDS) {
    db.prepare(`INSERT INTO classroom_question_responses
      (id, question_id, group_id, content, status, version, updated_by_user_id, submitted_at, updated_at)
      VALUES (?, 'question-1', ?, '', 'draft', 1, NULL, NULL, NULL)`)
      .run(`response-q1-${groupId}`, groupId);
  }
}

function joinLateStudent(db) {
  db.prepare(`INSERT INTO classroom_session_participants
    (id, session_id, user_id, group_id, attendance, joined_phase, can_rank,
     checked_in_at, grouped_at, updated_at)
    VALUES ('participant-late', 'session-1', ?, 'group-1', 'late', 'answering', 1, ?, ?, ?)`)
    .run(LATE_STUDENT_ID, NOW, NOW, NOW);
}

function writeResponse(db, { actorId, groupId, expectedVersion, content, submit }) {
  const action = submit ? "response.submit" : "response.save";
  db.exec("BEGIN");
  try {
    const result = db.prepare(`UPDATE classroom_question_responses
      SET content = ?, status = ?, version = version + 1, updated_by_user_id = ?,
          submitted_at = CASE WHEN ? = 1 THEN ? ELSE NULL END, updated_at = ?
      WHERE question_id = 'question-1' AND group_id = ? AND version = ? AND status = 'draft'
        AND EXISTS (SELECT 1 FROM classroom_questions q
          WHERE q.id = classroom_question_responses.question_id AND q.session_id = 'session-1'
            AND q.phase = 'answering' AND q.answer_deadline_at > ?)
        AND EXISTS (SELECT 1 FROM classroom_question_memberships m
          JOIN classroom_groups g ON g.id = m.group_id
          WHERE m.question_id = classroom_question_responses.question_id
            AND m.group_id = classroom_question_responses.group_id
            AND m.user_id = ? AND g.representative_user_id = ?)`)
      .run(content, submit ? "submitted" : "draft", actorId, submit ? 1 : 0, NOW, NOW,
        groupId, expectedVersion, NOW, actorId, actorId);
    db.prepare(`INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
      SELECT ?, ?, ?, 'classroom_question', 'question-1', '{}', ? WHERE changes() = 1`)
      .run(`audit-${action}-${actorId}-${expectedVersion}`, actorId, action, NOW);
    db.exec("COMMIT");
    return result.changes;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function lockResponsesAndOpenRanking(db) {
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM classroom_question_responses
    WHERE question_id = 'question-1' AND status = 'submitted' AND length(trim(content)) > 0`).get().count, 6);
  db.exec("BEGIN");
  db.prepare(`UPDATE classroom_question_responses
    SET status = 'locked', version = version + 1, updated_at = ? WHERE question_id = 'question-1'`)
    .run(NOW);
  db.prepare(`UPDATE classroom_questions SET phase = 'ranking', version = version + 2,
    responses_locked_at = ?, updated_at = ? WHERE id = 'question-1' AND phase = 'answering'`)
    .run(NOW, NOW);
  db.exec("COMMIT");
}

function saveRanking(db, userId, order, kind = "student") {
  const submissionId = `ranking-${userId}`;
  db.exec("BEGIN");
  try {
    db.prepare(`INSERT INTO classroom_question_ranking_submissions
      (id, question_id, user_id, version, is_current, status, invalid_reason, submitted_at)
      VALUES (?, (SELECT id FROM classroom_questions WHERE id = 'question-1' AND phase = 'ranking'),
        ?, 1, 1, 'valid', NULL, ?)`)
      .run(submissionId, userId, NOW);
    order.forEach((groupId, index) => db.prepare(`INSERT INTO classroom_question_ranking_items
      (id, submission_id, group_id, rank) VALUES (?, ?, ?, ?)`)
      .run(`item-${userId}-${index + 1}`, submissionId, groupId, index + 1));
    db.prepare(`INSERT INTO classroom_audit_events
      (id, actor_user_id, action, resource_type, resource_id, details_json, occurred_at)
      VALUES (?, ?, 'ranking.submit', 'classroom_question', 'question-1', ?, ?)`)
      .run(`audit-ranking-${userId}`, userId, JSON.stringify({ kind, rankedGroups: order.length }), NOW);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function studentRankingRows(db) {
  return db.prepare(`SELECT s.user_id, m.group_id AS own_group_id, i.group_id, i.rank
    FROM classroom_question_ranking_items i
    JOIN classroom_question_ranking_submissions s ON s.id = i.submission_id
    JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id
    WHERE s.question_id = 'question-1' AND s.is_current = 1 AND s.status = 'valid'
    ORDER BY s.user_id, i.rank`).all();
}

function captureSecondQuestionMemberships(db) {
  db.prepare(`INSERT INTO classroom_questions
    (id, session_id, question_text, ranking_criteria, source_question_bank_id, phase,
     answer_duration_seconds, answer_deadline_at, position, version, opened_at,
     responses_locked_at, ranking_locked_at, published_at, created_by_user_id, created_at, updated_at)
    VALUES ('question-2', 'session-1', '第二題：如何驗證此設計？', '請依證據充分程度排序。',
      NULL, 'answering', 600, ?, 2, 2, ?, NULL, NULL, NULL, 'teacher-1', ?, ?)`)
    .run(DEADLINE, NOW, NOW, NOW);
  db.prepare(`INSERT INTO classroom_question_memberships
    (id, question_id, user_id, group_id, can_rank, captured_at)
    SELECT 'membership-q2-' || user_id, 'question-2', user_id, group_id, can_rank, ?
    FROM classroom_session_participants WHERE session_id = 'session-1' AND group_id IS NOT NULL`)
    .run(NOW);
}

test("完整課堂模擬：50位準時學生、6組與1位遲到學生", async (t) => {
  const startedAt = performance.now();
  const db = await migratedDatabase();
  try {
    seedPeopleAndCourse(db);
    seedBalancedGroups(db);
    openFirstQuestion(db);
    joinLateStudent(db);

    const sizes = db.prepare(`SELECT group_id, COUNT(*) AS count FROM classroom_session_participants
      WHERE session_id = 'session-1' AND attendance = 'on_time' GROUP BY group_id ORDER BY group_id`).all();
    assert.deepEqual(sizes.map((row) => row.count), GROUP_MEMBERS.map((members) => members.length));
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM classroom_question_memberships
      WHERE question_id = 'question-1'`).get().count, STUDENT_IDS.length);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM classroom_question_memberships
      WHERE question_id = 'question-1' AND user_id = ?`).get(LATE_STUDENT_ID).count, 0);

    assert.equal(writeResponse(db, {
      actorId: "student-1", groupId: "group-2", expectedVersion: 1,
      content: "一般組員不應寫入", submit: false,
    }), 0, "一般組員不能修改共同回答");
    assert.equal(writeResponse(db, {
      actorId: "student-2", groupId: "group-2", expectedVersion: 1,
      content: "第二組裝置A草稿", submit: false,
    }), 1);
    assert.equal(writeResponse(db, {
      actorId: "student-2", groupId: "group-2", expectedVersion: 1,
      content: "第二組裝置B的舊草稿", submit: false,
    }), 0, "舊版本不能覆寫較新的草稿");

    for (const [index, groupId] of GROUP_IDS.entries()) {
      const representative = GROUP_MEMBERS[index][0];
      const expectedVersion = groupId === "group-2" ? 2 : 1;
      assert.equal(writeResponse(db, {
        actorId: representative, groupId, expectedVersion,
        content: `第 ${index + 1} 組的完整回答與理由`, submit: true,
      }), 1);
    }
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM classroom_audit_events
      WHERE action IN ('response.save', 'response.submit')`).get().count, 7,
    "只有成功的回答操作會留下稽核紀錄");
    lockResponsesAndOpenRanking(db);

    assert.equal(completeClassroomRankingOrder(PREFERRED_ORDER, GROUP_IDS)?.length, 6);
    assert.equal(completeClassroomRankingOrder(PREFERRED_ORDER.slice(0, 5), GROUP_IDS), null);
    assert.equal(completeClassroomRankingOrder(["group-1", "group-1", ...GROUP_IDS.slice(2)], GROUP_IDS), null);
    for (const studentId of STUDENT_IDS) saveRanking(db, studentId, PREFERRED_ORDER);
    const teacherOrder = ["group-4", "group-6", "group-5", "group-3", "group-2", "group-1"];
    saveRanking(db, "teacher-1", teacherOrder, "teacher");

    assert.equal(db.prepare(`SELECT COUNT(DISTINCT s.user_id) AS count
      FROM classroom_question_ranking_submissions s
      JOIN classroom_question_memberships m ON m.question_id = s.question_id AND m.user_id = s.user_id
      WHERE s.question_id = 'question-1' AND s.is_current = 1 AND s.status = 'valid'`).get().count, STUDENT_IDS.length);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM classroom_question_ranking_items
      WHERE submission_id = 'ranking-teacher-1'`).get().count, 6);

    assert.throws(() => saveRanking(db, "student-1", PREFERRED_ORDER), /UNIQUE constraint failed/iu,
      "同一學生不能同時存在兩份有效的目前排序");
    const results = rankResults(
      GROUP_IDS.map((groupId, index) => ({ id: groupId, label: `回答 ${String.fromCharCode(65 + index)}` })),
      rankingsExcludingOwnGroup(studentRankingRows(db).map((row) => ({
        userId: row.user_id, ownGroupId: row.own_group_id, groupId: row.group_id, rank: row.rank,
      }))),
    );
    assert.equal(results[0].groupId, "group-6");
    assert.equal(results[0].averageScore, 5);
    assert.ok(results.every((result) => {
      const groupIndex = GROUP_IDS.indexOf(result.groupId);
      return result.ratingCount === STUDENT_IDS.length - GROUP_MEMBERS[groupIndex].length;
    }), "每組都排除本組學生的評價");
    assert.equal(rankingPosition(teacherOrder, results[0].groupId), 2,
      "教師排序獨立保存，不會改變全班共識第一名");

    db.prepare(`UPDATE classroom_questions SET phase = 'locked', ranking_locked_at = ?, version = version + 1
      WHERE id = 'question-1' AND phase = 'ranking'`).run(NOW);
    assert.throws(() => saveRanking(db, LATE_STUDENT_ID, PREFERRED_ORDER), /NOT NULL constraint failed/iu,
      "排序鎖定後的新資料不會被保存");
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM classroom_question_ranking_submissions
      WHERE question_id = 'question-1'`).get().count, STUDENT_IDS.length + 1);
    db.prepare(`UPDATE classroom_questions SET phase = 'published', published_at = ?, version = version + 1
      WHERE id = 'question-1' AND phase = 'locked'`).run(NOW);

    captureSecondQuestionMemberships(db);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM classroom_question_memberships
      WHERE question_id = 'question-2'`).get().count, STUDENT_IDS.length + 1);
    assert.equal(db.prepare(`SELECT can_rank FROM classroom_question_memberships
      WHERE question_id = 'question-2' AND user_id = ?`).get(LATE_STUDENT_ID).can_rank, 1);
    const lateParticipation = db.prepare(`SELECT q.id AS question_id,
        MAX(CASE WHEN m.user_id IS NOT NULL AND m.can_rank = 1 THEN 1 ELSE 0 END) AS eligible
      FROM classroom_questions q
      LEFT JOIN classroom_question_memberships m ON m.question_id = q.id AND m.user_id = ?
      WHERE q.session_id = 'session-1' GROUP BY q.id ORDER BY q.position`).all(LATE_STUDENT_ID);
    assert.deepEqual(lateParticipation.map((row) => [row.question_id, row.eligible]), [
      ["question-1", 0], ["question-2", 1],
    ]);

    t.diagnostic(`教師1人、準時學生${STUDENT_IDS.length}人、遲到學生1人、6組、學生排序${STUDENT_IDS.length}份、教師排序1份`);
    t.diagnostic(`全班共識第一名：${results[0].label}；模擬耗時 ${Math.round(performance.now() - startedAt)} ms`);
  } finally {
    db.close();
  }
});
