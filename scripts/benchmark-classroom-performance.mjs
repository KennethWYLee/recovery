import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Miniflare } from "miniflare";
import { verifyClassroomRefresh } from "./verify-classroom-refresh.mjs";

const root = process.cwd();
const label = process.argv[2] ?? "after";
assert.match(label, /^(before|after)$/);
const workerRoot = resolve(root, "dist/server");
async function modulesAt(dir) {
  const modules = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) modules.push(...await modulesAt(path));
    else if (/\.m?js$/.test(entry.name)) modules.push({ type: "ESModule", path });
  }
  return modules;
}
const modules = await modulesAt(workerRoot);
modules.sort((a, b) => Number(b.path === join(workerRoot, "index.js")) - Number(a.path === join(workerRoot, "index.js")));
const persistence = await mkdtemp(join(tmpdir(), "classroom-perf-"));
const mf = new Miniflare({ modules, modulesRoot: workerRoot, compatibilityDate: "2026-07-30", compatibilityFlags: ["nodejs_compat"],
  bindings: { CLASSROOM_ENVIRONMENT: "production", CLASSROOM_ADMIN_EMAILS: "benchmark@example.invalid", CLASSROOM_RELEASE: "synthetic-performance" },
  d1Databases: { DB: "synthetic-performance" }, d1Persist: persistence,
  serviceBindings: { ASSETS: async () => new Response(null, { status: 404 }) },
});
const base = "https://classroom-benchmark.invalid";
const path = "/api/classroom/courses/course-demo-classroom/session";
async function request(email, extra = {}, acceptedStatuses = [200, 304], suffix = "") {
  const started = performance.now();
  const result = await mf.dispatchFetch(`${base}${path}${suffix}`, { headers: {
    "oai-authenticated-user-email": email, "oai-authenticated-user-full-name": email, ...extra,
  } });
  const body = await result.text();
  assert.ok(acceptedStatuses.includes(result.status), `${result.status} ${body.slice(0, 150)}`);
  return { ms: performance.now() - started, bytes: Buffer.byteLength(body), status: result.status, etag: result.headers.get("etag"), body };
}
function summary(rows) {
  const times = rows.map((row) => row.ms).sort((a, b) => a - b);
  return { requests: rows.length, p50Ms: Math.round(times[Math.floor(times.length / 2)]), p95Ms: Math.round(times[Math.ceil(times.length * .95) - 1]),
    maxMs: Math.round(times.at(-1)), meanBytes: Math.round(rows.reduce((sum, row) => sum + row.bytes, 0) / rows.length),
    unchanged: rows.filter((row) => row.status === 304).length };
}
try {
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir(resolve(root, "drizzle"))).filter((file) => /\.sql$/.test(file)).sort()) {
    const sql = await readFile(resolve(root, "drizzle", file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await request("benchmark@example.invalid");
  const admin = await db.prepare("SELECT id FROM classroom_users WHERE email = ?").bind("benchmark@example.invalid").first();
  const now = new Date().toISOString();
  const students = Array.from({ length: 50 }, (_, i) => `performance-${i}@ntub.edu.tw`);
  for (const [i, email] of students.entries()) {
    const id = `class-user-performance-${i}`;
    const group = `group-demo-${i % 6 + 1}`;
    await db.batch([
      db.prepare("INSERT INTO classroom_users (id,email,display_name,role,status,created_at,last_seen_at) VALUES (?,?,?,'student','active',?,?)").bind(id, email, email, now, now),
      db.prepare("INSERT INTO classroom_access_allowlist VALUES (?,?,'active',?,?,?)").bind(email, id, admin.id, now, now),
      db.prepare("INSERT INTO classroom_course_members (id,course_id,user_id,role,status,joined_at,updated_at) VALUES (?,'course-demo-classroom',?,'student','active',?,?)").bind(`member-performance-${i}`, id, now, now),
      db.prepare("INSERT INTO classroom_session_participants (id,session_id,user_id,group_id,attendance,joined_phase,checked_in_at,updated_at) VALUES (?,'session-demo-classroom',?,?,'on_time','check_in',?,?)").bind(`participant-performance-${i}`, id, group, now, now),
      db.prepare("INSERT INTO classroom_question_memberships (id,question_id,user_id,group_id,captured_at) VALUES (?,'question-demo-3',?,?,?)").bind(`membership-performance-${i}`, id, group, now),
      db.prepare("INSERT INTO classroom_course_roster (id,course_id,student_id,email,display_name,status,source_file_name,imported_by_user_id,imported_at,updated_at) VALUES (?,'course-demo-classroom',?,?,?,'active','synthetic',?,?,?)").bind(`roster-performance-${i}`, email.split("@")[0], email, email, admin.id, now, now),
    ]);
  }
  const full = await Promise.all(students.map((email) => request(email)));
  const polling = [];
  for (let round = 0; round < 3; round++) polling.push(...await Promise.all(students.map((email, i) => request(email,
    full[i].etag ? { "if-none-match": full[i].etag } : {}))));
  const checks = label === "after" ? await verifyClassroomRefresh(db, request, now) : undefined;
  const report = { generatedAt: new Date().toISOString(), label, synthetic: true, students: 50, checks,
    setting: "Built Worker with isolated local D1; no production network latency and no real student writes", full: summary(full), polling: summary(polling) };
  const out = resolve(root, "evidence/performance");
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `${label}.json`), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await mf.dispose();
  const target = resolve(persistence);
  assert.ok(target.startsWith(resolve(tmpdir()) + "\\") && target.includes("classroom-perf-"));
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
