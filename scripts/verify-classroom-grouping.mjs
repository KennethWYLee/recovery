import assert from "node:assert/strict";

// Exercise newly created sessions through the built API, using only isolated synthetic data.
export async function verifyClassroomGrouping(client, db) {
  const cases = [[2, 2], [7, 6], [41, 2]];
  for (const [studentCount, groupCount] of cases) {
    const created = await client.request("/api/classroom/courses", {
      method: "POST",
      body: JSON.stringify({ name: `分組驗證 ${studentCount}-${groupCount}`, academicYear: 115, term: "1", defaultGroupCount: groupCount }),
    }, [201]);
    const courseId = created.payload.data.course.id;
    const opened = await client.request(`/api/classroom/courses/${courseId}/session`, {
      method: "POST", body: JSON.stringify({ title: "分組驗證課堂", groupCount }),
    }, [201]);
    const session = opened.payload.data.session;
    const path = `/api/classroom/sessions/${session.id}`;
    const body = JSON.stringify({ action: "advance", expectedVersion: session.version });
    const rejected = await client.request(path, { method: "PATCH", body }, [409]);
    assert.equal(rejected.payload.error.code, "NOT_ENOUGH_PARTICIPANTS");
    const now = new Date().toISOString();
    for (let index = 0; index < studentCount; index += 1) {
      const userId = `grouping-${studentCount}-${groupCount}-${index}`;
      await db.batch([
        db.prepare("INSERT INTO classroom_users VALUES (?, ?, ?, 'student', 'active', ?, ?)")
          .bind(userId, `${userId}@example.invalid`, `虛擬學生 ${index}`, now, now),
        db.prepare(`INSERT INTO classroom_session_participants
          (id, session_id, user_id, group_id, attendance, joined_phase, can_rank, checked_in_at, grouped_at, updated_at)
          VALUES (?, ?, ?, NULL, 'on_time', 'check_in', 1, ?, NULL, ?)`)
          .bind(`participant-${userId}`, session.id, userId, now, now),
      ]);
    }
    const grouped = await client.request(path, { method: "PATCH", body });
    const snapshot = grouped.payload.data.snapshot;
    assert.equal(snapshot.session.phase, "grouping");
    assert.equal(snapshot.session.version, session.version + 1);
    assert.equal(snapshot.groups.length, groupCount);
    assert.equal(snapshot.completion.grouped, studentCount);
    const groups = await db.prepare(`SELECT g.id, g.representative_user_id, COUNT(p.id) AS size,
      SUM(CASE WHEN p.user_id = g.representative_user_id THEN 1 ELSE 0 END) AS representatives
      FROM classroom_groups g LEFT JOIN classroom_session_participants p ON p.group_id = g.id
      WHERE g.session_id = ? GROUP BY g.id`).bind(session.id).all();
    const sizes = groups.results.map((group) => group.size);
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), studentCount);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
    assert.ok(groups.results.every((group) => group.size > 0 && group.representatives === 1));
    const stored = await db.prepare("SELECT group_capacity, effective_group_capacity FROM classroom_sessions WHERE id = ?")
      .bind(session.id).first();
    assert.ok(stored.effective_group_capacity >= stored.group_capacity);
    assert.ok(stored.effective_group_capacity >= Math.max(...sizes));
    const repeated = await client.request(path, { method: "PATCH", body }, [409]);
    assert.equal(repeated.payload.error.code, "SESSION_VERSION_CONFLICT");
    const audits = await db.prepare("SELECT COUNT(*) AS count FROM classroom_audit_events WHERE resource_id = ? AND action = 'session.group'")
      .bind(session.id).first();
    assert.equal(audits.count, 1);
    const refreshed = await client.request(path);
    assert.equal(refreshed.payload.data.snapshot.groups.length, groupCount);
    console.log(`分組驗證通過：${studentCount} 人／${groupCount} 組，組內人數 ${sizes.join(", ")}`);
  }
}
