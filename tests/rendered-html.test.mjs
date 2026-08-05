import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const forbiddenInternalCopy = /Recovery Lab|ACE Next|活動協作|classroom beta|system prompt|\bprompt\b|\brubric\b|vibe coding|AI agent|AGENTS\.md|專題評分|初審|複審|配分|滿分|委員|評審|系統手冊|資管專題評分/i;
const publicTextExtensions = new Set([".css", ".html", ".js", ".json", ".sql", ".txt", ".xml"]);

async function collectPublicTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectPublicTextFiles(entryPath));
    } else if (entry.isFile() && publicTextExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }

  return files;
}

test("production bundle exposes the classroom course product and preserves security headers", async () => {
  const worker = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");

  assert.match(worker, /課堂小組回應與排序系統/);
  assert.match(worker, /\/api\/classroom\/courses/);
  assert.match(worker, /資料庫/);
  assert.match(worker, /AI量化交易/);
  assert.match(worker, /Continuity Ops/);
  assert.match(worker, /\/api\/v1\/incidents/);
  assert.match(worker, /\/api\/v1\/session\/role/);
  assert.match(worker, /access\.self_role\.select/);
  assert.match(worker, /ADMIN_ROLE_MANAGED/);
  assert.match(worker, /x-content-type-options/);
  assert.match(worker, /content-security-policy/);
  assert.match(worker, /frame-ancestors 'none'/);
  assert.match(worker, /strict-transport-security/);
  assert.match(worker, /ntub\.edu\.tw/i);
  assert.match(worker, /Continuity Ops 手機登入 QR Code/);
  assert.match(worker, /\/role-selection/);
  assert.doesNotMatch(worker, /FACILITATOR_KEY_NOT_CONFIGURED|trust-competence-draft/);
  assert.doesNotMatch(worker, /Building your site|react-loading-skeleton/);
  assert.doesNotMatch(worker, forbiddenInternalCopy);
});

test("client bundles contain the course entry and retained operations workspace without internal planning copy", async () => {
  const assets = await readdir(new URL("../dist/client/assets/", import.meta.url));
  const coursesAsset = assets.find((name) => name.startsWith("CoursesApp-") && name.endsWith(".js"));
  const courseWorkspaceAsset = assets.find((name) => name.startsWith("CourseWorkspace-") && name.endsWith(".js"));
  const operationsAsset = assets.find((name) => name.startsWith("OperationsApp-") && name.endsWith(".js"));
  const observabilityAsset = assets.find((name) => name.startsWith("ObservabilityView-") && name.endsWith(".js"));
  const roleSelectionAsset = assets.find((name) => name.startsWith("RoleSelectionClient-") && name.endsWith(".js"));
  const cssAssets = assets.filter((name) => name.endsWith(".css"));

  assert.ok(coursesAsset, "CoursesApp client asset is missing");
  assert.ok(courseWorkspaceAsset, "CourseWorkspace client asset is missing");
  assert.ok(operationsAsset, "OperationsApp client asset is missing");
  assert.ok(observabilityAsset, "ObservabilityView client asset is missing");
  assert.ok(roleSelectionAsset, "RoleSelectionClient client asset is missing");
  assert.ok(cssAssets.length > 0, "compiled stylesheet is missing");

  const [courses, operations, roleSelection, css] = await Promise.all([
    Promise.all([coursesAsset, courseWorkspaceAsset].map((name) => readFile(new URL(`../dist/client/assets/${name}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n")),
    Promise.all([operationsAsset, observabilityAsset].map((name) => readFile(new URL(`../dist/client/assets/${name}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n")),
    readFile(new URL(`../dist/client/assets/${roleSelectionAsset}`, import.meta.url), "utf8"),
    Promise.all(cssAssets.map((name) => readFile(new URL(`../dist/client/assets/${name}`, import.meta.url), "utf8")))
      .then((parts) => parts.join("\n")),
  ]);

  assert.match(courses, /我的課程/);
  assert.match(courses, /新增課程/);
  assert.match(courses, /修改課程名稱/);
  assert.match(courses, /刪除課程/);
  assert.match(courses, /\/api\/classroom\/courses/);
  assert.doesNotMatch(courses, forbiddenInternalCopy);
  assert.match(operations, /事件指揮中心/);
  assert.match(operations, /營運總覽/);
  assert.match(operations, /服務目錄/);
  assert.match(operations, /稽核紀錄/);
  assert.match(operations, /系統觀測/);
  assert.match(operations, /請求與錯誤趨勢/);
  assert.match(operations, /包含模擬資料/);
  assert.match(operations, /選擇導覽情境/);
  assert.match(operations, /系統更新後，部分功能變慢或出錯/);
  assert.match(operations, /完成導覽/);
  assert.match(operations, /事後檢討/);
  assert.match(operations, /\/api\/v1\/overview/);
  assert.match(operations, /\/api\/v1\/observability/);
  assert.match(operations, /Idempotency-Key|idempotencyKey/);
  assert.doesNotMatch(operations, forbiddenInternalCopy);
  assert.match(roleSelection, /事件指揮/);
  assert.match(roleSelection, /應變人員/);
  assert.match(roleSelection, /觀察者/);
  assert.match(roleSelection, /稽核人員/);
  assert.match(roleSelection, /\/api\/v1\/session\/role/);
  assert.match(roleSelection, /系統管理員.*不會出現在選項中/u);
  assert.doesNotMatch(roleSelection, forbiddenInternalCopy);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /continuity-tour-popover/);
  assert.match(css, /@media/);
});

test("every textual deployment artifact excludes prompts, grading language, and internal planning framing", async () => {
  const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
  const files = await collectPublicTextFiles(distDirectory);

  assert.ok(files.length > 0, "deployment output does not contain any inspectable text files");
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    assert.doesNotMatch(contents, forbiddenInternalCopy, `non-product copy leaked into ${path.relative(distDirectory, file)}`);
  }
});

test("Sites build binds D1 and keeps deployment migration packaging separate", async () => {
  const hosting = JSON.parse(await readFile(new URL("../dist/.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);
  assert.deepEqual(Object.keys(hosting).sort(), ["d1", "project_id", "r2"]);

  await access(new URL("../drizzle/0005_request_observability.sql", import.meta.url));
  await access(new URL("../drizzle/0006_adopt_observability_state.sql", import.meta.url));
  await access(new URL("../drizzle/0007_classroom_courses.sql", import.meta.url));
  await assert.rejects(
    access(new URL("../dist/server/.dev.vars", import.meta.url)),
    (error) => error && typeof error === "object" && error.code === "ENOENT",
    "Local runtime credentials must not be present in the deployable artifact",
  );

  const worker = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
  assert.match(worker, /ops_runtime_schema_state/);
  assert.match(worker, /DATABASE_INITIALIZING/);
});

test("operations polling cannot cancel an in-flight initial load", async () => {
  const source = await readFile(new URL("../app/operations/OperationsApp.tsx", import.meta.url), "utf8");
  assert.match(source, /overviewAbortRef\.current && !overviewAbortRef\.current\.signal\.aborted\) return false/);
  assert.match(source, /detailRequestIncidentRef\.current === incidentId\) return false/);
  assert.equal((source.match(/if \(!selectedIncidentId \|\| !snapshot\) return;/g) ?? []).length, 2);
});
