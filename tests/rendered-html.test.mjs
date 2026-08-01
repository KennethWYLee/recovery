import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const forbiddenProductCopy = /Recovery Lab|ACE Next|活動協作|classroom beta|system prompt|\bprompt\b|\brubric\b|vibe coding|AI agent|AGENTS\.md|課堂|課程|教學|老師|教師|學生|專題|初審|複審|評分|配分|滿分|委員|評審|作業|系統手冊|北商|資管專題評分/i;
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

test("production bundle exposes the professional operations product and security headers", async () => {
  const worker = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");

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
  assert.doesNotMatch(worker, /FACILITATOR_KEY_NOT_CONFIGURED|trust-competence-draft/);
  assert.doesNotMatch(worker, /Building your site|react-loading-skeleton/);
  assert.doesNotMatch(worker, forbiddenProductCopy);
});

test("client bundle contains the incident command workspace without teaching or grading copy", async () => {
  const assets = await readdir(new URL("../dist/client/assets/", import.meta.url));
  const operationsAsset = assets.find((name) => name.startsWith("OperationsApp-") && name.endsWith(".js"));
  const roleSelectionAsset = assets.find((name) => name.startsWith("RoleSelectionClient-") && name.endsWith(".js"));
  const cssAssets = assets.filter((name) => name.endsWith(".css"));

  assert.ok(operationsAsset, "OperationsApp client asset is missing");
  assert.ok(roleSelectionAsset, "RoleSelectionClient client asset is missing");
  assert.ok(cssAssets.length > 0, "compiled stylesheet is missing");

  const [operations, roleSelection, css] = await Promise.all([
    readFile(new URL(`../dist/client/assets/${operationsAsset}`, import.meta.url), "utf8"),
    readFile(new URL(`../dist/client/assets/${roleSelectionAsset}`, import.meta.url), "utf8"),
    Promise.all(cssAssets.map((name) => readFile(new URL(`../dist/client/assets/${name}`, import.meta.url), "utf8")))
      .then((parts) => parts.join("\n")),
  ]);

  assert.match(operations, /事件指揮中心/);
  assert.match(operations, /營運總覽/);
  assert.match(operations, /服務目錄/);
  assert.match(operations, /稽核紀錄/);
  assert.match(operations, /事後檢討/);
  assert.match(operations, /\/api\/v1\/overview/);
  assert.match(operations, /Idempotency-Key|idempotencyKey/);
  assert.doesNotMatch(operations, forbiddenProductCopy);
  assert.match(roleSelection, /事件指揮/);
  assert.match(roleSelection, /應變人員/);
  assert.match(roleSelection, /觀察者/);
  assert.match(roleSelection, /稽核人員/);
  assert.match(roleSelection, /\/api\/v1\/session\/role/);
  assert.match(roleSelection, /系統管理員.*不會出現在選項中/u);
  assert.doesNotMatch(roleSelection, forbiddenProductCopy);
  assert.match(css, /focus-visible/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /@media/);
});

test("every textual deployment artifact excludes prompts, grading language, and classroom framing", async () => {
  const distDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
  const files = await collectPublicTextFiles(distDirectory);

  assert.ok(files.length > 0, "deployment output does not contain any inspectable text files");
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    assert.doesNotMatch(contents, forbiddenProductCopy, `non-product copy leaked into ${path.relative(distDirectory, file)}`);
  }
});

test("Sites artifact binds D1 without deployment-time SQL migrations", async () => {
  const hosting = JSON.parse(await readFile(new URL("../dist/.openai/hosting.json", import.meta.url), "utf8"));
  assert.equal(hosting.d1, "DB");
  assert.equal(hosting.r2, null);
  assert.deepEqual(Object.keys(hosting).sort(), ["d1", "project_id", "r2"]);

  await assert.rejects(
    access(new URL("../dist/.openai/drizzle", import.meta.url)),
    (error) => error && typeof error === "object" && error.code === "ENOENT",
    "The Sites artifact must use the verified runtime schema path instead of deployment-time SQL migrations",
  );
  await assert.rejects(
    access(new URL("../dist/server/.dev.vars", import.meta.url)),
    (error) => error && typeof error === "object" && error.code === "ENOENT",
    "Local runtime credentials must not be present in the deployable artifact",
  );

  const worker = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
  assert.match(worker, /ops_runtime_schema_state/);
  assert.match(worker, /DATABASE_INITIALIZING/);
});
