import assert from "node:assert/strict";

export async function verifyAddClassroomGroup(client, db, sessionId) {
  const base = `/api/classroom/sessions/${sessionId}`;
  const read = async () => (await client.request(base)).payload.data.snapshot;
  const students = async () => (await client.request(`${base}/participation`)).payload.data.report.students;
  const create = (student, statuses = [200]) => client.request(base, {
    method: "PATCH", body: JSON.stringify({ action: "move_participant", groupId: "new",
      participantId: student.participantId, expectedGroupId: student.groupId ?? "" }),
  }, statuses);
  const history = async () => {
    const result = {};
    for (const table of ["classroom_question_memberships", "classroom_question_responses", "classroom_question_ranking_submissions"]) {
      result[table] = (await db.prepare(`SELECT t.* FROM ${table} t JOIN classroom_questions q ON q.id = t.question_id
        WHERE q.session_id = ? AND q.phase IN ('published', 'archived') ORDER BY t.id`).bind(sessionId).all()).results;
    }
    return result;
  };
  const beforeHistory = await history();
  const before = await read();
  const beforeStudents = await students();
  const speaker = beforeStudents.find((student) => before.groups.some((group) => group.representativeUserId === student.userId));
  const attempts = await Promise.all([create(speaker, [200, 409]), create(speaker, [200, 409])]);
  assert.deepEqual(attempts.map((item) => item.response.status).sort(), [200, 409]);
  let snapshot = await read();
  assert.equal(snapshot.groups.length, before.groups.length + 1);
  const first = snapshot.groups.find((group) => !before.groups.some((old) => old.id === group.id));
  assert.equal(first.position, Math.max(...before.groups.map((group) => group.position)) + 1);
  assert.equal(first.label, `第 ${first.position} 組`);
  assert.equal(first.representativeUserId, speaker.userId);
  assert.equal(first.members.length, 1);
  assert.equal(snapshot.groups.find((group) => group.id === speaker.groupId).representativeUserId, null);
  assert.equal(snapshot.session.groupCount, snapshot.groups.length);
  const otherStudents = beforeStudents.filter((student) => student.userId !== speaker.userId).slice(0, 2);
  await Promise.all(otherStudents.map((student) => create(student)));
  snapshot = await read();
  assert.equal(snapshot.groups.length, before.groups.length + 3);
  assert.equal(new Set(snapshot.groups.map((group) => group.position)).size, snapshot.groups.length);
  assert.deepEqual(await history(), beforeHistory);
  await verifyNewGroupAnswering({ client, db, base, sessionId, read, students, create });
  console.log("新增組別驗證通過：編號 +1、移入及指定發言人、重複請求只新增一次、同時新增不撞號、歷史資料不變、作答與遲到資格、20 組上限。");
}

async function verifyNewGroupAnswering({ client, db, base, sessionId, read, students, create }) {
  let snapshot = (await client.request(`${base}/questions`, { method: "POST", body: JSON.stringify({
    questionText: "新增組別作答驗證", rankingCriteria: "依回答內容排序", answerDurationSeconds: 300,
  }) }, [201])).payload.data.snapshot;
  snapshot = (await client.request(base, { method: "PATCH", body: JSON.stringify({
    action: "question_advance", questionId: snapshot.question.id, expectedQuestionVersion: snapshot.question.version,
  }) })).payload.data.snapshot;
  const questionId = snapshot.question.id;
  const roster = await students();
  const eligible = roster[0];
  snapshot = (await create(eligible)).payload.data.snapshot;
  const group = snapshot.groups.find((item) => item.representativeUserId === eligible.userId);
  const member = await db.prepare("SELECT group_id FROM classroom_question_memberships WHERE question_id = ? AND user_id = ?")
    .bind(questionId, eligible.userId).first();
  assert.equal(member.group_id, group.id);
  const response = await db.prepare("SELECT status FROM classroom_question_responses WHERE question_id = ? AND group_id = ?")
    .bind(questionId, group.id).first();
  assert.equal(response.status, "draft");
  const studentView = (await client.request(`/api/classroom/courses/${snapshot.session.courseId}/session?testStudentId=${eligible.userId}`)).payload.data.snapshot;
  assert.equal(studentView.currentUser.isRepresentative, true);
  assert.equal(studentView.currentUser.groupId, group.id);
  const empty = await client.request(`${base}/response`, { method: "PUT", body: JSON.stringify({
    testStudentId: eligible.userId, questionId, expectedVersion: 1, content: "   ", submit: true,
  }) }, [400]);
  assert.equal(empty.payload.error.code, "EMPTY_GROUP_RESPONSE");
  await client.request(`${base}/response`, { method: "PUT", body: JSON.stringify({
    testStudentId: eligible.userId, questionId, expectedVersion: 1, content: "0", submit: true,
  }) });
  const late = roster[1];
  await db.batch([
    db.prepare("DELETE FROM classroom_question_memberships WHERE question_id = ? AND user_id = ?").bind(questionId, late.userId),
    db.prepare("UPDATE classroom_session_participants SET group_id = NULL WHERE id = ?").bind(late.participantId),
  ]);
  snapshot = (await create({ ...late, groupId: null })).payload.data.snapshot;
  const lateGroup = snapshot.groups.find((item) => item.representativeUserId === late.userId);
  assert.equal(lateGroup.members.length, 1);
  assert.equal(await db.prepare("SELECT id FROM classroom_question_memberships WHERE question_id = ? AND user_id = ?")
    .bind(questionId, late.userId).first(), null);
  assert.equal(await db.prepare("SELECT id FROM classroom_question_responses WHERE question_id = ? AND group_id = ?")
    .bind(questionId, lateGroup.id).first(), null);
  const now = new Date().toISOString();
  for (let position = Math.max(...snapshot.groups.map((item) => item.position)) + 1; position <= 20; position++) {
    await db.prepare("INSERT INTO classroom_groups (id, session_id, label, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(`group-limit-${position}`, sessionId, `第 ${position} 組`, position, now, now).run();
  }
  const current = (await students()).find((student) => student.userId === eligible.userId);
  const limited = await create(current, [409]);
  assert.equal(limited.payload.error.code, "GROUP_CREATE_CONFLICT");
  assert.equal((await read()).groups.length, 20);
  assert.equal((await students()).find((student) => student.userId === eligible.userId).groupId, group.id);
  await db.prepare("UPDATE classroom_sessions SET phase = 'archived' WHERE id = ?").bind(sessionId).run();
  const archived = await create(current, [409]);
  assert.equal(archived.payload.error.code, "GROUPING_LOCKED");
}
