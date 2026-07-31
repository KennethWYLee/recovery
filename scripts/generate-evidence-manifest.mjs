import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { relative, resolve } from "node:path";

const PRODUCT_NAME = "Continuity Ops";
const PRODUCT_VERSION = "2.2.0";
const EVIDENCE_ID = "CO-VRF-MANIFEST-001";
const root = process.cwd();
const evidenceDirectory = resolve(root, "evidence");
const outputPath = resolve(evidenceDirectory, "continuity-ops-evidence-manifest.json");

const sourceInputs = [
  ".dev.vars.example",
  ".env.example",
  ".github",
  ".gitignore",
  ".openai",
  "PROJECT.md",
  "README.md",
  "cloudflare-env.d.ts",
  "eslint.config.mjs",
  "features",
  "next.config.ts",
  "package.json",
  "package-lock.json",
  "postcss.config.mjs",
  "tsconfig.json",
  "vite.config.ts",
  "wrangler.local.jsonc",
  "app",
  "build",
  "db",
  "docs",
  "drizzle",
  "lib",
  "public",
  "scripts",
  "tests",
  "worker",
];

const generatedEvidenceInputs = [
  { path: "evidence/continuity-ops-gherkin-acceptance.json", bindingScope: "source_files" },
  { path: "evidence/continuity-ops-gherkin-fault-injection.json", bindingScope: "source_files" },
  { path: "evidence/continuity-ops-quality-metrics.json", bindingScope: "source_files" },
  { path: "evidence/continuity-ops-fault-injection.json", bindingScope: "source_files" },
  { path: "evidence/continuity-ops-api-smoke.json", bindingScope: "current_worker_artifact" },
  { path: "evidence/continuity-ops-security-negative-tests.json", bindingScope: "current_worker_artifact" },
  { path: "evidence/continuity-ops-browser-qa.json", bindingScope: "current_worker_artifact" },
  { path: "evidence/continuity-ops-independent-blackbox-qa.json", bindingScope: "current_worker_artifact" },
  { path: "evidence/continuity-ops-local-load-smoke.json", bindingScope: "current_worker_artifact" },
  { path: "evidence/continuity-ops-local-failure-recovery.json", bindingScope: "current_worker_artifact" },
  { path: "evidence/continuity-ops-request-telemetry-analysis.json", bindingScope: "runtime_log_and_smoke_evidence" },
  { path: "evidence/continuity-ops-local-d1-restore-drill.json", bindingScope: "migration_files_and_backup" },
  { path: "evidence/continuity-ops-clean-room-verification.json", bindingScope: "isolated_source_snapshot_build" },
  { path: "evidence/continuity-ops-sbom.cdx.json", bindingScope: "dependency_inventory" },
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function normalizedPath(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function collectFiles(entry) {
  const absolutePath = resolve(root, entry);
  assert.ok(existsSync(absolutePath), `Required manifest input is missing: ${entry}`);
  const stat = statSync(absolutePath);
  if (stat.isFile()) return [absolutePath];
  assert.ok(stat.isDirectory(), `Manifest input is neither a file nor a directory: ${entry}`);
  return readdirSync(absolutePath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((item) => collectFiles(`${entry}/${item.name}`));
}

function fileRecord(absolutePath) {
  const stat = statSync(absolutePath);
  return {
    path: normalizedPath(absolutePath),
    bytes: stat.size,
    sha256: sha256File(absolutePath),
  };
}

function gitText(args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function sourceControlIdentity() {
  try {
    const repositoryRoot = gitText(["rev-parse", "--show-toplevel"]);
    const head = gitText(["rev-parse", "HEAD"]);
    const projectStatus = gitText(["status", "--short", "--", ...sourceInputs]);
    const dirtyEntries = projectStatus ? projectStatus.split(/\r?\n/u) : [];
    return {
      status: dirtyEntries.length === 0 ? "source_tree_clean" : "source_tree_has_uncommitted_changes",
      repositoryRelativePath: relative(repositoryRoot, root).replaceAll("\\", "/") || ".",
      head,
      shortHead: head.slice(0, 12),
      sourceDirtyEntryCount: dirtyEntries.length,
      limitation: dirtyEntries.length === 0
        ? "The project files resolve to this commit; CI and deployment identity remain separate evidence."
        : "The project contains uncommitted changes, so this manifest does not describe a clean commit rebuild.",
    };
  } catch (error) {
    return {
      status: "git_identity_unavailable",
      limitation: `Git identity could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
assert.equal(packageJson.name, "continuity-ops", "package.json has an unexpected package name.");
assert.equal(packageJson.version, PRODUCT_VERSION, "package.json has an unexpected product version.");
assert.equal(packageLock.name, packageJson.name, "package-lock.json name does not match package.json.");
assert.equal(packageLock.version, packageJson.version, "package-lock.json version does not match package.json.");
assert.equal(packageLock.packages?.[""]?.name, packageJson.name, "The lockfile root package name is inconsistent.");
assert.equal(packageLock.packages?.[""]?.version, packageJson.version, "The lockfile root version is inconsistent.");
const bundledRuntimeStateDirectory = "dist/server/.wrangler";
const bundledRuntimeStateDirectoryPresent = existsSync(resolve(root, bundledRuntimeStateDirectory));
const bundledRuntimeStateFiles = bundledRuntimeStateDirectoryPresent
  ? collectFiles(bundledRuntimeStateDirectory)
  : [];
assert.equal(
  bundledRuntimeStateFiles.length,
  0,
  "The build contains local Wrangler state files. Stop every preview process and rebuild before generating release evidence.",
);

const sourceFiles = [...new Set(sourceInputs.flatMap(collectFiles))]
  .sort((left, right) => normalizedPath(left).localeCompare(normalizedPath(right)))
  .map(fileRecord);
const buildFiles = collectFiles("dist")
  .sort((left, right) => normalizedPath(left).localeCompare(normalizedPath(right)))
  .map(fileRecord);
const workerBuild = buildFiles.find((file) => file.path === "dist/server/index.js");
assert.ok(workerBuild, "The Worker build artifact is missing.");
const generatedEvidence = generatedEvidenceInputs.map((definition) => {
  const { path: entry, bindingScope } = definition;
  const absolutePath = resolve(root, entry);
  if (!existsSync(absolutePath)) return { path: entry, present: false, bindingScope, bindingEvaluation: "missing" };
  const file = fileRecord(absolutePath);
  const payload = JSON.parse(readFileSync(absolutePath, "utf8"));
  const isSbom = payload.bomFormat === "CycloneDX";
  const associatedBuildSha256 = payload.buildArtifact?.sha256
    ?? payload.artifacts?.smokeEvidence?.associatedBuildArtifact?.sha256
    ?? null;
  const matchesCurrentWorkerBuild = associatedBuildSha256
    ? associatedBuildSha256 === workerBuild.sha256
    : null;
  let bindingEvaluation;
  if (bindingScope === "current_worker_artifact") {
    bindingEvaluation = matchesCurrentWorkerBuild ? "matches_current_worker" : "does_not_match_current_worker";
  } else if (bindingScope === "isolated_source_snapshot_build") {
    bindingEvaluation = associatedBuildSha256 ? "isolated_build_recorded" : "isolated_build_missing";
  } else if (bindingScope === "source_files") {
    bindingEvaluation = "source_specific_hashes_recorded";
  } else if (bindingScope === "runtime_log_and_smoke_evidence") {
    bindingEvaluation = matchesCurrentWorkerBuild ? "smoke_evidence_matches_current_worker" : "smoke_evidence_not_current";
  } else {
    bindingEvaluation = "scope_specific_evidence_recorded";
  }
  return {
    ...file,
    present: true,
    evidenceId: payload.evidenceId ?? null,
    evidenceStatus: payload.evidenceStatus ?? (isSbom ? "inventory_generated" : null),
    result: payload.result ?? (isSbom ? "not_applicable" : null),
    verificationType: payload.verificationType ?? (isSbom ? "cyclonedx_dependency_inventory" : null),
    generatedAt: payload.generatedAt ?? payload.metadata?.timestamp ?? null,
    limitationCount: Array.isArray(payload.limitations) ? payload.limitations.length : 0,
    associatedBuildSha256,
    matchesCurrentWorkerBuild,
    bindingScope,
    bindingEvaluation,
    ...(isSbom ? {
      sbom: {
        bomFormat: payload.bomFormat,
        specVersion: payload.specVersion,
        componentCount: Array.isArray(payload.components) ? payload.components.length : 0,
      },
    } : {}),
  };
});

const structuredEvidence = generatedEvidence.filter((item) => item.present && item.evidenceId);
const evidenceIds = structuredEvidence.map((item) => item.evidenceId);
assert.equal(new Set(evidenceIds).size, evidenceIds.length, "Evidence IDs must be unique.");
for (const definition of generatedEvidenceInputs) {
  const item = generatedEvidence.find((candidate) => candidate.path === definition.path);
  if (!item?.present || item.path.endsWith("continuity-ops-sbom.cdx.json")) continue;
  const payload = JSON.parse(readFileSync(resolve(root, item.path), "utf8"));
  assert.equal(payload.productVersion, PRODUCT_VERSION, `Evidence product version differs: ${item.path}`);
}

const missingEvidenceCount = generatedEvidence.filter((item) => !item.present).length;
const failedEvidenceCount = generatedEvidence.filter((item) => item.present && item.result === "failed").length;
const staleWorkerEvidenceCount = generatedEvidence.filter(
  (item) => item.bindingScope === "current_worker_artifact" && item.bindingEvaluation !== "matches_current_worker",
).length;

const buildDigestInput = buildFiles.map((file) => `${file.path}:${file.sha256}`).join("\n");
const report = {
  schemaVersion: "1.1",
  evidenceId: EVIDENCE_ID,
  product: PRODUCT_NAME,
  productVersion: PRODUCT_VERSION,
  generatedAt: new Date().toISOString(),
  evidenceStatus: "generated_local",
  verificationType: "source_and_build_integrity_manifest",
  sourceControl: sourceControlIdentity(),
  runtime: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  packageIdentity: {
    name: packageJson.name,
    version: packageJson.version,
    lockfileVersion: packageLock.lockfileVersion,
    aligned: true,
  },
  source: {
    fileCount: sourceFiles.length,
    files: sourceFiles,
  },
  build: {
    status: "local_build_present",
    fileCount: buildFiles.length,
    aggregateSha256: sha256(buildDigestInput),
    files: buildFiles,
    deploymentId: null,
    localRuntimeState: {
      directoryPresent: bundledRuntimeStateDirectoryPresent,
      regularFileCount: bundledRuntimeStateFiles.length,
      includedInManifest: false,
      note: "Empty local Wrangler runtime directories are not deployable files and are excluded; any regular file makes manifest generation fail.",
    },
  },
  verificationEvidence: generatedEvidence,
  verificationEvidenceSummary: {
    expected: generatedEvidenceInputs.length,
    present: generatedEvidenceInputs.length - missingEvidenceCount,
    missing: missingEvidenceCount,
    failed: failedEvidenceCount,
    staleCurrentWorkerBindings: staleWorkerEvidenceCount,
    uniqueStructuredEvidenceIds: evidenceIds.length,
  },
  secretHandling: {
    status: "values_excluded",
    note: "Only environment-variable templates are inventoried. Local and hosted secret values must remain outside the manifest and repository.",
  },
  releaseDecision: {
    status: "pending",
    note: "This inventory does not prove CI, staging, rollback, external use, security review, or production approval.",
  },
};

mkdirSync(evidenceDirectory, { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  evidenceId: EVIDENCE_ID,
  output: outputPath,
  sourceFileCount: sourceFiles.length,
  buildFileCount: buildFiles.length,
  buildAggregateSha256: report.build.aggregateSha256,
}, null, 2));
