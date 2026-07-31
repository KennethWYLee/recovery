import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PRODUCT_NAME = "Continuity Ops";
const PRODUCT_VERSION = "2.2.0";
const EVIDENCE_ID = "CO-VRF-GHERKIN-FAULT-001";
const root = process.cwd();
const node = process.execPath;
const featurePath = "features/core-reliability.feature";
const stepsPath = "features/step_definitions/core-reliability.steps.mjs";
const sourcePath = "lib/operations-domain.ts";
const authorizationSourcePath = "lib/operations-auth.ts";
const evidencePath = resolve(root, "evidence/continuity-ops-gherkin-fault-injection.json");
const cucumberPath = resolve(root, "node_modules/@cucumber/cucumber/bin/cucumber.js");
const temporaryRoot = resolve(root, ".wrangler");

const mutants = [
  {
    id: "gherkin-responder-resolution",
    target: "incident transition authorization",
    original: 'if (["resolved", "closed"].includes(from) || ["resolved", "closed", "cancelled"].includes(to)) {',
    replacement: 'if (["resolved", "closed"].includes(from) || ["closed", "cancelled"].includes(to)) {',
    change: "Allow an assigned responder to resolve a monitored incident.",
    expectedScenario: "A responder cannot resolve an incident",
  },
  {
    id: "gherkin-observer-escalation",
    target: "organization and incident role compatibility",
    original: '  observer: ["observer"],',
    replacement: '  observer: ["observer", "responder"],',
    change: "Allow an organization observer to hold a responder assignment.",
    expectedScenario: "An observer cannot be assigned operational response duties",
  },
  {
    id: "gherkin-insecure-evidence",
    target: "durable task evidence URL",
    original: '    return url.protocol === "https:"',
    replacement: '    return ["https:", "http:"].includes(url.protocol)',
    change: "Accept an HTTP URL as completion evidence.",
    expectedScenario: "Completed work rejects insecure evidence",
  },
  {
    id: "gherkin-deprecated-service",
    target: "service lifecycle eligibility",
    original: '  return status === "active";',
    replacement: "  return true;",
    change: "Allow a deprecated service to receive a new incident.",
    expectedScenario: "A deprecated service cannot receive a new incident",
  },
  {
    id: "gherkin-cancelled-open-queue",
    target: "open incident filtering",
    original: '  if (filter === "open") return status !== "closed" && status !== "cancelled";',
    replacement: '  if (filter === "open") return status !== "closed";',
    change: "Treat a cancelled incident as open.",
    expectedScenario: "The open queue excludes closed and cancelled incidents",
  },
  {
    id: "gherkin-final-marker",
    target: "explicit final communication marker",
    original: '  return /^\\[final\\](?:[ \\t\\r\\n]|$)/i.test(message);',
    replacement: '  return /^\\[final\\]$/i.test(message);',
    change: "Reject a valid final marker when explanatory text follows it.",
    expectedScenario: "Only an explicit final marker removes the next-update requirement",
  },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function occurrences(value, search) {
  return value.split(search).length - 1;
}

function sanitize(value, temporaryDirectory) {
  const temporaryDirectoryUrl = pathToFileURL(temporaryDirectory).href;
  const rootUrl = pathToFileURL(root).href;
  return String(value ?? "")
    .replaceAll(temporaryDirectoryUrl, "<TEMP_DIR_URL>")
    .replaceAll(rootUrl, "<PROJECT_ROOT_URL>")
    .replaceAll(temporaryDirectory, "<TEMP_DIR>")
    .replaceAll(temporaryDirectory.replaceAll("\\", "/"), "<TEMP_DIR>")
    .replaceAll(root, "<PROJECT_ROOT>")
    .replaceAll(root.replaceAll("\\", "/"), "<PROJECT_ROOT>")
    .slice(-3000);
}

function runCucumber(cwd) {
  const resultPath = join(cwd, ".cucumber-result.json");
  rmSync(resultPath, { force: true });
  const execution = spawnSync(node, [
    cucumberPath,
    featurePath,
    "--import",
    stepsPath,
    "--format",
    "progress",
    "--format",
    "json:.cucumber-result.json",
    "--strict",
  ], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--experimental-strip-types"].filter(Boolean).join(" "),
    },
    windowsHide: true,
  });
  assert.equal(execution.error, undefined, execution.error?.message);
  const features = existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, "utf8"))
    : [];
  const scenarios = features.flatMap((feature) => feature.elements ?? []);
  const failedScenarios = scenarios.filter((scenario) => (
    (scenario.steps ?? []).some((step) => step.result?.status === "failed")
  ));
  return {
    execution,
    features,
    scenarios,
    failedScenarios,
    output: `${execution.stdout ?? ""}\n${execution.stderr ?? ""}`.trim(),
  };
}

const source = readFileSync(resolve(root, sourcePath), "utf8");
const sourceSha256 = sha256(source);
for (const mutant of mutants) {
  assert.equal(
    occurrences(source, mutant.original),
    1,
    `The ${mutant.id} source fragment must occur exactly once.`,
  );
}

mkdirSync(temporaryRoot, { recursive: true });
const temporaryDirectory = mkdtempSync(join(temporaryRoot, "continuity-ops-gherkin-fault-"));

try {
  mkdirSync(join(temporaryDirectory, "features/step_definitions"), { recursive: true });
  mkdirSync(join(temporaryDirectory, "lib"), { recursive: true });
  writeFileSync(
    join(temporaryDirectory, featurePath),
    readFileSync(resolve(root, featurePath), "utf8"),
    "utf8",
  );
  writeFileSync(
    join(temporaryDirectory, stepsPath),
    readFileSync(resolve(root, stepsPath), "utf8"),
    "utf8",
  );
  const temporarySourcePath = join(temporaryDirectory, sourcePath);
  writeFileSync(temporarySourcePath, source, "utf8");
  writeFileSync(
    join(temporaryDirectory, authorizationSourcePath),
    readFileSync(resolve(root, authorizationSourcePath), "utf8"),
    "utf8",
  );

  const baseline = runCucumber(temporaryDirectory);
  assert.equal(
    baseline.execution.status,
    0,
    `The Gherkin baseline must pass before fault injection.\n${sanitize(baseline.output, temporaryDirectory)}`,
  );
  assert.equal(baseline.failedScenarios.length, 0, "The Gherkin baseline contains failed scenarios.");

  const injectedFaults = [];
  for (const mutant of mutants) {
    writeFileSync(
      temporarySourcePath,
      source.replace(mutant.original, mutant.replacement),
      "utf8",
    );
    const mutationRun = runCucumber(temporaryDirectory);
    writeFileSync(temporarySourcePath, source, "utf8");
    assert.notEqual(
      mutationRun.execution.status,
      0,
      `The Gherkin suite passed after injecting ${mutant.id}.`,
    );
    const failedScenarioNames = mutationRun.failedScenarios.map((scenario) => scenario.name);
    assert.ok(
      failedScenarioNames.includes(mutant.expectedScenario),
      `${mutant.id} did not fail its expected scenario. Failed: ${failedScenarioNames.join(", ") || "none"}`,
    );
    injectedFaults.push({
      id: mutant.id,
      target: mutant.target,
      change: mutant.change,
      expectedScenario: mutant.expectedScenario,
      observedResult: "failed_as_expected",
      failedScenarioNames,
      exitCode: mutationRun.execution.status,
      outputExcerpt: sanitize(mutationRun.output, temporaryDirectory),
    });
  }

  const sourceSha256After = sha256(readFileSync(resolve(root, sourcePath)));
  assert.equal(sourceSha256After, sourceSha256, "Gherkin fault injection changed repository source.");

  const report = {
    schemaVersion: "1.0",
    evidenceId: EVIDENCE_ID,
    product: PRODUCT_NAME,
    productVersion: PRODUCT_VERSION,
    generatedAt: new Date().toISOString(),
    evidenceStatus: "verified_local",
    verificationType: "risk_oriented_gherkin_fault_injection",
    result: "passed",
    tool: {
      name: "@cucumber/cucumber",
      version: JSON.parse(readFileSync(resolve(root, "node_modules/@cucumber/cucumber/package.json"), "utf8")).version,
      runtime: process.version,
    },
    baseline: {
      features: baseline.features.length,
      scenarios: baseline.scenarios.length,
      result: "passed",
    },
    injectedFaults,
    summary: {
      total: injectedFaults.length,
      detected: injectedFaults.length,
      survived: 0,
    },
    inputs: [
      { path: featurePath, sha256: sha256(readFileSync(resolve(root, featurePath))) },
      { path: stepsPath, sha256: sha256(readFileSync(resolve(root, stepsPath))) },
      { path: sourcePath, sha256: sourceSha256 },
    ],
    repositorySourceUnchanged: sourceSha256After === sourceSha256,
    limitations: [
      "This is a six-case, risk-oriented Gherkin fault-injection check; it is not an exhaustive mutation campaign or mutation score.",
      "The selected changes are hand-designed around the eight current scenarios and do not prove that every requirement has a discriminating Gherkin scenario.",
      "The feature, step definitions, and product source remain in one repository, so this is not independent human QA or an external oracle.",
    ],
  };
  mkdirSync(resolve(root, "evidence"), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    evidenceId: EVIDENCE_ID,
    output: evidencePath,
    summary: report.summary,
  }, null, 2));
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
