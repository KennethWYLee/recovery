import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanRepository, scanText } from "../scripts/repository-secret-scan-lib.mjs";

function sampleSecrets() {
  return [
    ["-----BEGIN ", "PRIVATE KEY-----"].join(""),
    ["gh", "p_", "A".repeat(36)].join(""),
    ["gl", "pat-", "b".repeat(24)].join(""),
    ["xo", "xb-", "1234567890-", "c".repeat(24)].join(""),
    ["AK", "IA", "D".repeat(16)].join(""),
    ["AI", "za", "e".repeat(35)].join(""),
    ["sk_", "live_", "f".repeat(24)].join(""),
    ["SG", ".", "g".repeat(22), ".", "h".repeat(43)].join(""),
    ["np", "m_", "i".repeat(36)].join(""),
    ["S", "K", "a".repeat(32)].join(""),
    ["OPENAI_API", "_KEY=", "j".repeat(32)].join(""),
  ];
}

test("known-bad provider credentials and private-key material are detected", () => {
  const findings = scanText(sampleSecrets().join("\n"), "app/known-bad.ts");
  assert.deepEqual(
    new Set(findings.map((finding) => finding.patternId)),
    new Set([
      "aws-access-key",
      "github-token",
      "gitlab-token",
      "google-api-key",
      "named-provider-secret",
      "npm-token",
      "private-key",
      "sendgrid-api-key",
      "slack-token",
      "stripe-live-secret",
      "twilio-api-key",
    ]),
  );
});

test("known-good identifiers and explicit placeholders do not trigger entropy guesses", () => {
  const source = [
    "const deploymentId = '01JY3KAM2RJD4Q8WZ6ZP9N2X5C';",
    "const checksum = '7f4b6bb8d6cb067320f2fb667585aae4f479650cad9e9a0e40b401152a4bc552';",
    "OPENAI_API_KEY=replace-with-provider-secret",
  ].join("\n");
  assert.deepEqual(scanText(source, "app/known-good.ts"), []);
});

test("repository scan inspects owned text and excludes dependencies, build output, and real env files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classroom-secret-scan-"));
  try {
    await mkdir(path.join(root, "app"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "dependency"), { recursive: true });
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "app", "clean.ts"), "export const ready = true;\n");
    await writeFile(path.join(root, ".dev.vars"), sampleSecrets()[1]);
    await writeFile(path.join(root, "node_modules", "dependency", "index.js"), sampleSecrets()[2]);
    await writeFile(path.join(root, "dist", "bundle.js"), sampleSecrets()[3]);

    const clean = await scanRepository(root);
    assert.equal(clean.findings.length, 0);
    assert.equal(clean.filesScanned, 1);

    await writeFile(path.join(root, "app", "unsafe.ts"), sampleSecrets()[4]);
    const unsafe = await scanRepository(root);
    assert.equal(unsafe.findings.length, 1);
    assert.equal(unsafe.findings[0].path, "app/unsafe.ts");
    assert.equal(unsafe.findings[0].patternId, "aws-access-key");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository scan fails closed when a scoped text file is not valid UTF-8", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "classroom-secret-scan-"));
  try {
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(path.join(root, "scripts", "invalid.mjs"), Buffer.from([0xc3, 0x28]));
    await assert.rejects(scanRepository(root), /could not decode scripts[\\/]invalid\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository scan fails closed when the requested root is unavailable", async () => {
  const unavailable = path.join(os.tmpdir(), `missing-secret-scan-root-${process.pid}-${Date.now()}`);
  await assert.rejects(scanRepository(unavailable), /ENOENT/);
});
