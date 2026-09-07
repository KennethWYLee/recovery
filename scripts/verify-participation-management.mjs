import assert from "node:assert/strict";
import { verifyAddClassroomGroup } from "./verify-add-classroom-group.mjs";

export async function verifyParticipationManagement(client, db, sessionId) {
  const base = `/api/classroom/sessions/${sessionId}`;
  const read = async () => (await client.request(`${base}/participation`)).payload.data.report;
  let report = await read();
  assert.equal(report.sessionPhase, "answering");
  const source = report.groups.find((group) => group.representativeUserId);
  const target = report.groups.find((group) => group.id !== source.id);
  const student = report.students.find((item) => item.userId === source.representativeUserId);
  assert.equal(student.groupId, source.id);
  assert.ok(student.participantId);
  const historical = async () => (await db.prepare(
    `SELECT m.question_id, m.user_id, m.group_id FROM classroom_question_memberships m
     JOIN classroom_questions q ON q.id = m.question_id
     WHERE q.session_id = ? AND q.phase IN ('published', 'archived') ORDER BY m.question_id, m.user_id`,
  ).bind(sessionId).all()).results;
  const before = await historical();
  const patch = (body, statuses = [200]) => client.request(base, { method: "PATCH", body: JSON.stringify(body) }, statuses);
  await patch({ action: "move_participant", participantId: student.participantId, groupId: target.id });
  report = await read();
  assert.equal(report.students.find((item) => item.userId === student.userId).groupId, target.id);
  assert.equal(report.groups.find((group) => group.id === source.id).representativeUserId, null);
  await patch({ action: "set_representative", groupId: target.id, userId: student.userId });
  report = await read();
  assert.equal(report.groups.find((group) => group.id === target.id).representativeUserId, student.userId);
  assert.equal(report.groups.filter((group) => group.representativeUserId === student.userId).length, 1);
  const invalid = await patch({ action: "set_representative", groupId: source.id, userId: student.userId }, [400]);
  assert.equal(invalid.payload.error.code, "REPRESENTATIVE_NOT_IN_GROUP");
  assert.deepEqual(await historical(), before);
  console.log("學生表格管理驗證通過：換組、更新發言人、清除原組發言人、拒絕跨組指定，已公布題目分組不變。");
  await verifyAddClassroomGroup(client, db, sessionId);
}
