import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const removedProductCopy = new RegExp([
  "Continuity Ops",
  "incident command",
  "service recovery",
  "事件指揮",
  "營運事件",
  "服務復原",
  "Recovery Lab",
  "api/v1",
  "operations/",
  "role-selection",
].join("|"), "i");
const internalPlanningCopy = new RegExp([
  "system prompt",
  "\\bprompt\\b",
  "\\brubric\\b",
  "vibe coding",
  "AI agent",
  "AGENTS\\.md",
  "專題評分",
  "初審",
  "複審",
  "配分",
  "滿分",
  "委員",
  "評審",
  "系統手冊",
].join("|"), "i");
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

test("production bundle exposes only the classroom product and preserves security controls", async () => {
  const worker = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");

  assert.match(worker, /\/api\/classroom\/courses/);
  assert.match(worker, /\/api\/classroom\/access-requests/);
  assert.match(worker, /\/api\/classroom\/sessions/);
  assert.match(worker, /\/api\/classroom\/join/);
  assert.match(worker, /wy\.lee@ntub\.edu\.tw/);
  assert.match(worker, /kenneth\.wy\.lee21@gmail\.com/);
  assert.match(worker, /ACCESS_APPROVAL_PENDING/);
  assert.match(worker, /ntub\.edu\.tw/i);
  assert.match(worker, /x-content-type-options/);
  assert.match(worker, /content-security-policy/);
  assert.match(worker, /frame-ancestors 'none'/);
  assert.match(worker, /strict-transport-security/);
  assert.doesNotMatch(worker, removedProductCopy);
  assert.doesNotMatch(worker, internalPlanningCopy);
});

test("client bundles contain course management and access review without removed product assets", async () => {
  const assets = await readdir(new URL("../dist/client/assets/", import.meta.url));
  const coursesAsset = assets.find((name) => name.startsWith("CoursesApp-") && name.endsWith(".js"));
  const workspaceAsset = assets.find((name) => name.startsWith("CourseWorkspace-") && name.endsWith(".js"));
  const reviewAsset = assets.find((name) => name.startsWith("AccessReviewApp-") && name.endsWith(".js"));
  const cssAssets = assets.filter((name) => name.endsWith(".css"));

  assert.ok(coursesAsset, "CoursesApp client asset is missing");
  assert.ok(workspaceAsset, "CourseWorkspace client asset is missing");
  assert.ok(reviewAsset, "AccessReviewApp client asset is missing");
  assert.ok(cssAssets.length > 0, "compiled stylesheet is missing");
  assert.equal(assets.some((name) => /OperationsApp|ObservabilityView|RoleSelectionClient/i.test(name)), false);

  const scripts = await Promise.all(
    [coursesAsset, workspaceAsset, reviewAsset].map((name) =>
      readFile(new URL(`../dist/client/assets/${name}`, import.meta.url), "utf8")),
  );
  const css = (await Promise.all(
    cssAssets.map((name) => readFile(new URL(`../dist/client/assets/${name}`, import.meta.url), "utf8")),
  )).join("\n");
  const client = scripts.join("\n");

  assert.match(client, /\/api\/classroom\/courses/);
  assert.match(client, /\/api\/classroom\/access-requests/);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media/);
  assert.doesNotMatch(client, removedProductCopy);
  assert.doesNotMatch(client, internalPlanningCopy);
});

test("every textual deployment artifact excludes removed product and internal planning copy", async () => {
  const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
  const files = await collectPublicTextFiles(distDirectory);

  assert.ok(files.length > 0, "deployment output does not contain any inspectable text files");
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    const relative = path.relative(distDirectory, file);
    assert.doesNotMatch(contents, removedProductCopy, `removed product copy leaked into ${relative}`);
    assert.doesNotMatch(contents, internalPlanningCopy, `internal planning copy leaked into ${relative}`);
  }
});

test("Sites build binds D1 and packages only classroom migrations", async () => {
  const hosting = JSON.parse(await readFile(new URL("../dist/.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);
  assert.deepEqual(Object.keys(hosting).sort(), ["d1", "project_id", "r2"]);

  await access(new URL("../drizzle/0001_classroom_courses.sql", import.meta.url));
  await access(new URL("../drizzle/0002_classroom_access_approval.sql", import.meta.url));
  await access(new URL("../drizzle/0003_classroom_live_sessions.sql", import.meta.url));
  const migrations = (await readdir(new URL("../drizzle/", import.meta.url)))
    .filter((name) => name.endsWith(".sql"));
  assert.deepEqual(migrations.sort(), [
    "0001_classroom_courses.sql",
    "0002_classroom_access_approval.sql",
    "0003_classroom_live_sessions.sql",
  ]);

  await assert.rejects(
    access(new URL("../dist/server/.dev.vars", import.meta.url)),
    (error) => error && typeof error === "object" && error.code === "ENOENT",
    "Local runtime credentials must not be present in the deployable artifact",
  );
});
