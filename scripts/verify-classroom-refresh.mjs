import assert from "node:assert/strict";

export async function verifyConditionalWorkspaceRead(client) {
  const path = "/api/classroom/courses/course-demo-classroom/session?questionId=question-demo-3";
  const studentPath = `${path}&testStudentId=demo-user-1`;
  const first = await client.request(studentPath);
  const etag = first.response.headers.get("etag");
  assert.match(etag, /^W\//);
  assert.equal(first.payload.data.actor.isAdmin, false);
  for (const header of [etag, etag.slice(2), `"old", ${etag}`, "*"]) {
    const unchanged = await client.request(studentPath, { headers: { "if-none-match": header } }, [304]);
    assert.equal(unchanged.payload, null);
    assert.equal(unchanged.response.headers.get("etag"), etag);
    assert.equal(unchanged.response.headers.get("cache-control"), "no-store");
  }
  for (const header of ['W/"old"', '"wrong,part"']) {
    await client.request(studentPath, { headers: { "if-none-match": header } });
  }
  const teacher = await client.request(path, { headers: { "if-none-match": etag } });
  assert.equal(teacher.payload.data.actor.isAdmin, true);
  await client.request(`${path}&testStudentId=demo-user-2`, { headers: { "if-none-match": etag } });
  await client.request(studentPath.replace("question-demo-3", "question-demo-1"), { headers: { "if-none-match": etag } });
}

// This helper runs only against the benchmark's isolated Miniflare database.
export async function verifyClassroomRefresh(db, request, joinedAt) {
  const email = "performance-0@ntub.edu.tw";
  const view = await request(email);
  let revision = view.etag;
  assert.ok(revision);
  const data = JSON.parse(view.body).data;
  assert.deepEqual(data.snapshot.results, []);
  assert.deepEqual(data.snapshot.rawRankings, []);
  assert.equal(data.snapshot.teacherRanking, null);
  assert.deepEqual(data.snapshot.participants, []);
  const member = await db.prepare("SELECT updated_at FROM classroom_course_members WHERE id = 'member-performance-0'").first();
  assert.equal(member.updated_at, joinedAt, "polling must not rewrite an already active membership");
  const unchanged = await request(email, { "if-none-match": revision });
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.bytes, 0);
  const strongRevision = revision.replace(/^W\//, "");
  for (const header of [strongRevision, `W/${strongRevision}`, `"stale", W/${strongRevision}`, "*"]) {
    const cached = await request(email, { "if-none-match": header });
    assert.equal(cached.status, 304, header);
    assert.equal(cached.bytes, 0);
    assert.equal(cached.etag, revision);
  }
  assert.equal((await request(email, { "if-none-match": 'W/"outdated"' })).status, 200);
  const otherActor = await request("performance-1@ntub.edu.tw", { "if-none-match": revision });
  assert.equal(otherActor.status, 200);
  assert.notEqual(otherActor.etag, revision);
  const history = await request(email, { "if-none-match": revision }, [200], "?questionId=question-demo-1");
  assert.equal(JSON.parse(history.body).data.snapshot.question.id, "question-demo-1");
  assert.notEqual(history.etag, revision);
  const changes = [
    ["draft", "UPDATE classroom_question_responses SET content = '最新共同回答', version = version + 1 WHERE question_id = 'question-demo-3' AND group_id = 'group-demo-1'",
      (s) => assert.equal(s.groups.find((g) => g.id === 'group-demo-1').response.content, '最新共同回答')],
    ["speaker", "UPDATE classroom_groups SET representative_user_id = 'class-user-performance-0' WHERE id = 'group-demo-1'",
      (s) => assert.equal(s.currentUser.isRepresentative, true)],
    ["membership", "UPDATE classroom_question_memberships SET group_id = 'group-demo-2' WHERE id = 'membership-performance-0'",
      (s) => assert.equal(s.currentUser.groupId, 'group-demo-2')],
    ["attendance", "UPDATE classroom_session_participants SET group_id = 'group-demo-2' WHERE id = 'participant-performance-0'"],
    ["saved ranking", "UPDATE classroom_question_ranking_submissions SET version = version + 1 WHERE question_id = 'question-demo-1' AND user_id = 'demo-user-1' AND is_current = 1"],
    ["phase", "UPDATE classroom_questions SET phase = 'presenting', version = version + 1 WHERE id = 'question-demo-3'",
      (s) => assert.equal(s.question.phase, 'presenting')],
    ["session", "UPDATE classroom_sessions SET qr_enabled = 1 - qr_enabled, version = version + 1 WHERE id = 'session-demo-classroom'"],
    ["course", "UPDATE classroom_courses SET version = version + 1 WHERE id = 'course-demo-classroom'"],
  ];
  for (const [name, sql, verify] of changes) {
    const mutation = await db.prepare(sql).run();
    assert.ok(mutation.meta.changes > 0, name);
    const changed = await request(email, { "if-none-match": revision });
    assert.equal(changed.status, 200, name);
    assert.notEqual(changed.etag, revision, name);
    verify?.(JSON.parse(changed.body).data.snapshot);
    revision = changed.etag;
    assert.equal((await request(email, { "if-none-match": revision })).status, 304, name);
  }
  await db.batch([
    db.prepare("DELETE FROM classroom_course_roster WHERE id = 'roster-performance-0'"),
    db.prepare("DELETE FROM classroom_course_members WHERE id = 'member-performance-0'"),
  ]);
  await request(email, { "if-none-match": revision }, [404]);
  await db.batch([
    db.prepare("DELETE FROM classroom_course_roster WHERE id = 'roster-performance-1'"),
    db.prepare("DELETE FROM classroom_access_allowlist WHERE email = 'performance-1@ntub.edu.tw'"),
  ]);
  await request("performance-1@ntub.edu.tw", { "if-none-match": otherActor.etag }, [403]);
  await db.prepare("UPDATE classroom_courses SET status = 'deleted', deleted_at = ? WHERE id = 'course-demo-classroom'").bind(new Date().toISOString()).run();
  await request("benchmark@example.invalid", { "if-none-match": revision }, [404]);
  return { unchangedBody: "passed", weakAndStrongEntityTags: "passed", activeMembershipNotRewritten: "passed", actorAndQuestionIsolation: "passed",
    draftAndSpeakerUpdates: "passed", membershipAndRankingUpdates: "passed", phaseAndCourseUpdates: "passed", freshAuthorization: "passed", deletedCourseNotRestored: "passed" };
}
