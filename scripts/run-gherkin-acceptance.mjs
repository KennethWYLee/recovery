import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const EVIDENCE_ID = "CO-VRF-GHERKIN-001";
const featurePath = resolve("features/core-reliability.feature");
const stepsPath = resolve("features/step_definitions/core-reliability.steps.mjs");
const domainPath = resolve("lib/operations-domain.ts");
const outputPath = resolve("evidence/continuity-ops-gherkin-acceptance.json");
const temporaryRoot = resolve(".wrangler");
mkdirSync(temporaryRoot, { recursive: true });
const temporaryDirectory = mkdtempSync(join(temporaryRoot, "continuity-ops-gherkin-"));
const cucumberOutput = join(temporaryDirectory, "cucumber.json");
const cucumberOutputArgument = cucumberOutput.slice(process.cwd().length + 1);

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

try {
  const execution = spawnSync(process.execPath, [
    "node_modules/@cucumber/cucumber/bin/cucumber.js",
    "features/core-reliability.feature",
    "--import",
    "features/step_definitions/core-reliability.steps.mjs",
    "--format",
    "progress",
    "--format",
    `json:${cucumberOutputArgument}`,
    "--strict",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--experimental-strip-types" },
    windowsHide: true,
  });
  assert.equal(execution.error, undefined, execution.error?.message);
  assert.equal(execution.status, 0, `${execution.stdout ?? ""}\n${execution.stderr ?? ""}`);

  const features = JSON.parse(readFileSync(cucumberOutput, "utf8"));
  assert.ok(Array.isArray(features) && features.length > 0, "Cucumber did not produce a feature result.");
  const scenarios = features.flatMap((feature) => feature.elements ?? []);
  const steps = scenarios.flatMap((scenario) => scenario.steps ?? []);
  const failedSteps = steps.filter((step) => step.result?.status !== "passed");
  assert.equal(failedSteps.length, 0, "At least one executable Gherkin step did not pass.");

  const report = {
    schemaVersion: "1.0",
    evidenceId: EVIDENCE_ID,
    product: "Continuity Ops",
    productVersion: "2.2.0",
    generatedAt: new Date().toISOString(),
    evidenceStatus: "verified_local",
    verificationType: "executable_gherkin_domain_acceptance",
    result: "passed_with_documented_limits",
    tool: {
      name: "@cucumber/cucumber",
      version: JSON.parse(readFileSync(resolve("node_modules/@cucumber/cucumber/package.json"), "utf8")).version,
      runtime: process.version,
    },
    summary: {
      features: features.length,
      scenarios: scenarios.length,
      steps: steps.length,
      passedSteps: steps.length,
      failedSteps: 0,
    },
    inputs: [
      { path: "features/core-reliability.feature", sha256: sha256File(featurePath) },
      { path: "features/step_definitions/core-reliability.steps.mjs", sha256: sha256File(stepsPath) },
      { path: "lib/operations-domain.ts", sha256: sha256File(domainPath) },
    ],
    scenarioNames: scenarios.map((scenario) => scenario.name),
    limitations: [
      "These scenarios make selected core reliability rules readable and executable; they do not replace API, D1, browser, security, or external-user testing.",
      "The suite intentionally covers a risk-selected subset. Gherkin quantity and a passing result are not a quality score.",
      "The step definitions and product code are in the same repository, so this is not an independent holdout or third-party oracle.",
    ],
  };
  mkdirSync(resolve("evidence"), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(execution.stdout ?? "");
  process.stderr.write(execution.stderr ?? "");
  console.log(JSON.stringify({ ok: true, evidenceId: EVIDENCE_ID, output: outputPath, summary: report.summary }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
