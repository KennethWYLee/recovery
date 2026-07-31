import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";

import { analyzeRequestTelemetry, decodeTelemetryInput } from "./request-telemetry-analysis-lib.mjs";

function usage() {
  return [
    "Usage:",
    "  node scripts/analyze-request-telemetry.mjs --input <wrangler-output.log>",
    "    [--smoke evidence/continuity-ops-api-smoke.json]",
    "    [--output evidence/continuity-ops-request-telemetry-analysis.json]",
    "    [--expected-api 2.2.0] [--expected-schema 0004]",
    "    [--expected-deployment <immutable-local-build-label>]",
    "",
    "The generated evidence is always labeled local and controlled.",
  ].join("\n");
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === "--help" || current === "-h") return { help: true };
    assert.match(current, /^--(?:input|smoke|output|expected-api|expected-schema|expected-deployment)$/u, `Unknown argument: ${current}`);
    const value = argv[index + 1];
    assert.ok(value && !value.startsWith("--"), `${current} requires a value.`);
    result[current.slice(2)] = value;
    index += 1;
  }
  assert.ok(result.input, "--input is required.");
  return result;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function displayPath(path) {
  const fromRoot = relative(process.cwd(), path);
  return fromRoot && !fromRoot.startsWith("..") && !resolve(fromRoot).startsWith("\\\\")
    ? fromRoot.replaceAll("\\", "/")
    : basename(path);
}

const args = parseArguments(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const inputPath = resolve(args.input);
const smokePath = args.smoke ? resolve(args.smoke) : null;
const outputPath = resolve(args.output ?? "evidence/continuity-ops-request-telemetry-analysis.json");
assert.ok(existsSync(inputPath) && statSync(inputPath).isFile(), `Telemetry input file does not exist: ${args.input}`);
assert.notEqual(outputPath, inputPath, "Output path must differ from the telemetry input path.");
if (smokePath) assert.ok(existsSync(smokePath) && statSync(smokePath).isFile(), `Smoke evidence file does not exist: ${args.smoke}`);
for (const argument of ["expected-api", "expected-schema", "expected-deployment"]) {
  if (args[argument]) assert.match(args[argument], /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u, `--${argument} is invalid.`);
}

const input = decodeTelemetryInput(readFileSync(inputPath));
const smokeEvidence = smokePath ? JSON.parse(readFileSync(smokePath, "utf8")) : null;
const productPackage = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const report = analyzeRequestTelemetry(input, {
  expectedApiVersion: args["expected-api"] ?? null,
  expectedSchemaVersion: args["expected-schema"] ?? null,
  expectedDeploymentVersion: args["expected-deployment"] ?? null,
  smokeEvidence,
});
report.productVersion = productPackage.version;
report.artifacts = {
  telemetry: {
    path: displayPath(inputPath),
    bytes: statSync(inputPath).size,
    sha256: sha256File(inputPath),
    rawContentRetained: false,
  },
  smokeEvidence: smokePath ? {
    path: displayPath(smokePath),
    bytes: statSync(smokePath).size,
    sha256: sha256File(smokePath),
    evidenceId: smokeEvidence?.evidenceId ?? null,
    associatedBuildArtifact: smokeEvidence?.buildArtifact ?? null,
    rawRequestIdsRetained: false,
  } : null,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: report.result === "passed",
  evidenceId: report.evidenceId,
  result: report.result,
  output: displayPath(outputPath),
  validTelemetryRecords: report.validation.validRecords.numerator,
  telemetryCandidateCount: report.validation.validRecords.denominator,
  smokeCorrelation: report.smokeCorrelation?.coverage ?? null,
}, null, 2));
if (report.result !== "passed") process.exitCode = 1;
