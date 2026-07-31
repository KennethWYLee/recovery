import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { scanRepository } from "./repository-secret-scan-lib.mjs";

function parseRoot(arguments_) {
  if (arguments_.length === 0) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  }
  if (arguments_.length === 2 && arguments_[0] === "--root") {
    return path.resolve(arguments_[1]);
  }
  throw new Error("Usage: node scripts/scan-repository-secrets.mjs [--root <directory>]");
}

function trackedRealEnvironmentFiles(root) {
  const result = spawnSync(
    "git",
    ["-C", root, "ls-files", "--", ".env", ".env.*", ".dev.vars", ".dev.vars.*"],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Git tracked-file inventory is unavailable; refusing to skip the environment-file check");
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((file) => file.trim())
    .filter(Boolean)
    .filter((file) => ![".env.example", ".dev.vars.example"].includes(path.basename(file)));
}

async function main() {
  const root = parseRoot(process.argv.slice(2));
  const trackedEnvironmentFiles = trackedRealEnvironmentFiles(root);
  if (trackedEnvironmentFiles.length > 0) {
    console.error("Repository secret scan found tracked runtime environment file(s):");
    for (const file of trackedEnvironmentFiles) console.error(`- ${file}`);
    console.error("Values are intentionally not printed. Remove these files from version control and rotate exposed credentials.");
    process.exitCode = 1;
    return;
  }
  const result = await scanRepository(root);

  if (result.findings.length > 0) {
    console.error(`Repository secret scan found ${result.findings.length} potential secret(s):`);
    for (const finding of result.findings) {
      console.error(`- ${finding.path}:${finding.line} [${finding.patternId}] ${finding.label}`);
    }
    console.error("Secret values are intentionally redacted.");
    process.exitCode = 1;
    return;
  }

  console.log(`Repository secret scan passed (${result.filesScanned} project text files inspected).`);
}

main().catch((error) => {
  console.error(`Repository secret scan could not complete: ${error.message}`);
  process.exitCode = 2;
});
