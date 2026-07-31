import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, relative, resolve } from "node:path";

import { ESLint } from "eslint";

const PRODUCT_NAME = "Continuity Ops";
const PRODUCT_VERSION = "2.2.0";
const EVIDENCE_ID = "CO-VRF-QUALITY-001";
const root = process.cwd();
const node = process.execPath;
const evidencePath = resolve(root, "evidence/continuity-ops-quality-metrics.json");
const thresholds = {
  linePercent: 90,
  branchPercent: 80,
  functionPercent: 80,
};
const complexityThreshold = 15;
const unitSuites = [
  "tests/operations-domain.test.ts",
  "tests/operations-authorization.test.ts",
  "tests/operations-time.test.ts",
  "tests/service-lifecycle-cursor.test.ts",
  "tests/operations-input.test.ts",
  "tests/operations-bootstrap.test.mjs",
];
const measuredSources = [
  "lib/operations-domain.ts",
  "lib/operations-auth.ts",
  "lib/operations-time.ts",
  "lib/service-lifecycle-cursor.ts",
  "lib/operations-input.ts",
  "db/operations-bootstrap-core.ts",
];
const coverageArgs = [
  "--experimental-strip-types",
  "--experimental-test-coverage",
  "--test",
  ...unitSuites,
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function commandOutput(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}

function parseCount(output, label) {
  const match = stripAnsi(output).match(new RegExp(`(?:^|\\n)\\s*[ℹ#]?\\s*${label}\\s+(\\d+)`, "u"));
  assert.ok(match, `Unable to parse the Node test ${label} count.`);
  return Number(match[1]);
}

function metricResult(actual, minimum) {
  return {
    actual,
    minimum,
    passed: actual >= minimum,
  };
}

function parseCoverage(output) {
  const expectedByBasename = new Map(measuredSources.map((path) => [basename(path), path]));
  const perFile = [];
  let aggregate = null;

  for (const rawLine of stripAnsi(output).split(/\r?\n/u)) {
    const line = rawLine.replace(/^\s*[ℹ#]\s*/u, "").trim();
    const match = line.match(
      /^(.+?)\s+\|\s*(\d+(?:\.\d+)?)\s+\|\s*(\d+(?:\.\d+)?)\s+\|\s*(\d+(?:\.\d+)?)\s+\|\s*(.*)$/u,
    );
    if (!match) continue;
    const [, label, lineValue, branchValue, functionValue, uncovered] = match;
    const metrics = {
      linePercent: Number(lineValue),
      branchPercent: Number(branchValue),
      functionPercent: Number(functionValue),
    };
    if (label.trim() === "all files") {
      aggregate = metrics;
      continue;
    }
    const sourcePath = expectedByBasename.get(label.trim());
    if (!sourcePath) continue;
    perFile.push({
      path: sourcePath,
      ...metrics,
      uncoveredLineRanges: uncovered.trim() ? uncovered.trim().split(/\s+/u) : [],
      comparisonToAggregateThresholds: {
        line: metricResult(metrics.linePercent, thresholds.linePercent),
        branch: metricResult(metrics.branchPercent, thresholds.branchPercent),
        function: metricResult(metrics.functionPercent, thresholds.functionPercent),
      },
      thresholdRole: "diagnostic_only",
    });
  }

  assert.ok(aggregate, "Unable to parse the aggregate Node coverage result.");
  assert.equal(perFile.length, measuredSources.length, "Coverage output did not contain every measured source file.");
  perFile.sort((left, right) => left.path.localeCompare(right.path));
  return { aggregate, perFile };
}

async function collectComplexityDiagnostics() {
  const eslint = new ESLint({
    overrideConfig: [{
      files: ["**/*.ts"],
      rules: { complexity: ["warn", { max: complexityThreshold }] },
    }],
  });
  const results = await eslint.lintFiles(measuredSources);
  return results
    .flatMap((result) => result.messages
      .filter((message) => message.ruleId === "complexity")
      .map((message) => {
        const parsed = message.message.match(/complexity of (\d+)/u);
        assert.ok(parsed, `Unable to parse ESLint complexity diagnostic: ${message.message}`);
        return {
          path: relative(root, result.filePath).replaceAll("\\", "/"),
          line: message.line,
          column: message.column,
          measuredComplexity: Number(parsed[1]),
          threshold: complexityThreshold,
          message: message.message,
        };
      }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
}

const coverageRun = spawnSync(node, coverageArgs, { cwd: root, encoding: "utf8" });
const coverageOutput = commandOutput(coverageRun);
assert.equal(
  coverageRun.status,
  0,
  `All ${unitSuites.length} unit suites must pass before quality metrics are accepted.\n${coverageOutput}`,
);

const coverage = parseCoverage(coverageOutput);
const aggregateGate = {
  line: metricResult(coverage.aggregate.linePercent, thresholds.linePercent),
  branch: metricResult(coverage.aggregate.branchPercent, thresholds.branchPercent),
  function: metricResult(coverage.aggregate.functionPercent, thresholds.functionPercent),
};
const coveragePassed = Object.values(aggregateGate).every((metric) => metric.passed);
const complexityFindings = await collectComplexityDiagnostics();
const report = {
  schemaVersion: "1.0",
  evidenceId: EVIDENCE_ID,
  product: PRODUCT_NAME,
  productVersion: PRODUCT_VERSION,
  generatedAt: new Date().toISOString(),
  evidenceStatus: "verified_local",
  verificationType: "unit_coverage_and_static_complexity_diagnostics",
  result: coveragePassed
    ? complexityFindings.length > 0 ? "coverage_passed_with_complexity_findings" : "passed"
    : "coverage_threshold_failed",
  environment: {
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  unitTestRun: {
    command: `node ${coverageArgs.join(" ")}`,
    suites: unitSuites,
    tests: parseCount(coverageOutput, "tests"),
    passed: parseCount(coverageOutput, "pass"),
    failed: parseCount(coverageOutput, "fail"),
    exitCode: coverageRun.status,
  },
  coverage: {
    provider: "Node.js built-in test coverage",
    gateScope: "aggregate_of_the_named_unit_suites_and_their_measured_domain_and_bootstrap_sources",
    thresholds,
    result: coveragePassed ? "passed" : "failed",
    aggregate: {
      ...coverage.aggregate,
      gate: aggregateGate,
    },
    perFile: coverage.perFile,
  },
  complexity: {
    provider: "ESLint complexity rule",
    threshold: complexityThreshold,
    role: "diagnostic_only_not_a_functional_acceptance_gate",
    result: complexityFindings.length > 0 ? "findings_present" : "no_findings",
    findingCount: complexityFindings.length,
    findings: complexityFindings,
  },
  crapMetric: {
    status: "not_calculated",
    reason: "Node's built-in text report does not provide a stable function-by-function mapping between cyclomatic complexity and function coverage. A CRAP value would therefore be fabricated rather than reproducible.",
  },
  sourceBinding: measuredSources.map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(root, path), "utf8")),
  })),
  interpretation: [
    "The 90% line, 80% branch, and 80% function thresholds apply to the aggregate measured unit-test scope; per-file comparisons identify gaps but are not separate pass/fail gates.",
    "Coverage and cyclomatic complexity are risk indicators. Passing coverage thresholds or remaining below a complexity threshold does not prove functional correctness, security, usability, or release readiness.",
    "Complexity findings above 15 identify review and refactoring candidates; they do not by themselves fail a feature or the product.",
  ],
  limitations: [
    `This report covers only the ${unitSuites.length} named unit suites and ${measuredSources.length} domain or bootstrap sources they exercise; it excludes Worker handlers, React UI, migration execution, browser paths, and external integrations.`,
    "Line, branch, and function percentages do not measure the quality of assertions or the correctness of the test oracle.",
    "CRAP is intentionally not reported without credible function-level coverage joined to the same functions measured for complexity.",
  ],
};

mkdirSync(resolve(root, "evidence"), { recursive: true });
writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: coveragePassed,
  evidenceId: EVIDENCE_ID,
  coverage: coverage.aggregate,
  complexityFindings: complexityFindings.length,
  crap: "not_calculated",
  output: evidencePath,
}, null, 2));
if (!coveragePassed) process.exitCode = 1;
