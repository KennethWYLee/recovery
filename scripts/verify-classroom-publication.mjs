import assert from "node:assert/strict";

export async function verifyClassroomPublication(client, db, sessionId) {
  const base = `/api/classroom/sessions/${sessionId}`;
  for (const count of [1, 2]) {
    let snapshot = (await client.request(`${base}/questions`, {
      method: "POST", body: JSON.stringify({ questionText: `少量排序公布驗證 ${count}`, rankingCriteria: "依回答內容排序", answerDurationSeconds: 300 }),
    }, [201])).payload.data.snapshot;
    const questionId = snapshot.question.id;
    const advance = async (acceptedStatuses = [200]) => {
      const result = await client.request(base, { method: "PATCH", body: JSON.stringify({
        action: "question_advance", questionId, expectedQuestionVersion: snapshot.question.version,
      }) }, acceptedStatuses);
      if (result.payload.data) snapshot = result.payload.data.snapshot;
      return result;
    };
    await advance();
    await db.prepare("UPDATE classroom_question_responses SET content = '虛擬回答內容', status = 'submitted' WHERE question_id = ?").bind(questionId).run();
    await advance();
    await advance();
    const empty = await advance([409]);
    assert.equal(empty.payload.error.code, "NO_RANKINGS");
    const order = snapshot.groups.map((group) => group.id);
    const submit = async (testStudentId) => client.request(`${base}/ranking`, {
      method: "PUT", body: JSON.stringify({ questionId, orderedGroupIds: order, ...(testStudentId ? { testStudentId } : {}) }),
    });
    await submit("demo-user-1");
    const noTeacher = await advance([409]);
    assert.equal(noTeacher.payload.error.code, "TEACHER_RANKING_REQUIRED");
    await submit();
    await advance();
    assert.equal(snapshot.question.phase, "locked");
    const before = snapshot.rawRankings;
    const reopenPath = `${base}/questions/${questionId}/reopen-ranking`;
    const stale = await client.request(reopenPath, { method: "POST", body: JSON.stringify({ expectedQuestionVersion: snapshot.question.version - 1 }) }, [409]);
    assert.equal(stale.payload.error.code, "QUESTION_VERSION_CONFLICT");
    snapshot = (await client.request(reopenPath, { method: "POST", body: JSON.stringify({ expectedQuestionVersion: snapshot.question.version }) })).payload.data.snapshot;
    assert.equal(snapshot.question.phase, "ranking");
    const saved = await client.request(`/api/classroom/courses/course-demo-classroom/session?questionId=${questionId}&testStudentId=demo-user-1`);
    assert.deepEqual(saved.payload.data.snapshot.currentUser.orderedGroupIds, before[0].orderedGroupIds);
    if (count === 2) await submit("demo-user-2");
    await advance();
    await advance();
    assert.equal(snapshot.question.phase, "published");
    assert.equal(snapshot.completion.rankedStudents, count);
    assert.equal(snapshot.rawRankings.length, count);
    const invalidReopen = await client.request(reopenPath, { method: "POST", body: JSON.stringify({ expectedQuestionVersion: snapshot.question.version }) }, [409]);
    assert.equal(invalidReopen.payload.error.code, "RANKING_REOPEN_NOT_ALLOWED");
    const audit = await db.prepare("SELECT COUNT(*) AS count FROM classroom_audit_events WHERE resource_id = ? AND action = 'question.reopen_ranking'").bind(questionId).first();
    assert.equal(audit.count, 1);
    const report = (await client.request(`${base}/participation`)).payload.data.report;
    const states = report.students.map((student) => student.questions.find((question) => question.questionId === questionId));
    assert.equal(states.filter((state) => state?.rankingCompleted).length, count);
    console.log(`公布驗證通過：${count} 份有效學生排序；重新開放保留原排序，已公布問題禁止重開。`);
  }
}
