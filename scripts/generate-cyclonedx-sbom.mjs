import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseOutput(arguments_) {
  if (arguments_.length === 0) {
    return path.join(projectRoot, "evidence", "continuity-ops-sbom.cdx.json");
  }
  if (arguments_.length === 2 && arguments_[0] === "--output") {
    return path.resolve(arguments_[1]);
  }
  throw new Error("Usage: node scripts/generate-cyclonedx-sbom.mjs [--output <file>]");
}

function runNpmSbom() {
  const npmEntryPoint = process.env.npm_execpath;
  if (!npmEntryPoint) {
    throw new Error("npm_execpath is unavailable; run this generator through npm run sbom:generate");
  }
  const result = spawnSync(
    process.execPath,
    [
      npmEntryPoint,
      "sbom",
      "--package-lock-only",
      "--sbom-format",
      "cyclonedx",
      "--sbom-type",
      "application",
    ],
    {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw new Error(`npm sbom could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm sbom exited with status ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function normalizeAndVerifyCycloneDx(text, packageIdentity) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new Error(`npm sbom returned invalid JSON: ${error.message}`);
  }

  if (document.bomFormat !== "CycloneDX") {
    throw new Error(`Unexpected SBOM format: ${document.bomFormat ?? "missing"}`);
  }
  if (typeof document.specVersion !== "string" || !Array.isArray(document.components)) {
    throw new Error("CycloneDX output is missing specVersion or components");
  }
  if (document.metadata?.component?.purl !== `pkg:npm/${packageIdentity.name}@${packageIdentity.version}`) {
    throw new Error("CycloneDX metadata does not identify the Continuity Ops package");
  }
  // npm derives this display field from the checkout directory. Normalize it
  // to the immutable package identity so the SBOM remains stable after a clone
  // or workspace rename; the package URL and bom-ref remain npm-generated.
  document.metadata.component.name = packageIdentity.name;
  if (document.metadata.component.name !== "continuity-ops") {
    throw new Error("CycloneDX metadata has an unexpected root component name");
  }

  return `${JSON.stringify(document, null, 2)}\n`;
}

async function main() {
  const outputPath = parseOutput(process.argv.slice(2));
  const outputDirectory = path.dirname(outputPath);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await mkdir(outputDirectory, { recursive: true });

  try {
    const packageIdentity = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
    const verified = normalizeAndVerifyCycloneDx(runNpmSbom(), packageIdentity);
    await writeFile(temporaryPath, verified, { encoding: "utf8", flag: "wx" });
    await rm(outputPath, { force: true });
    await rename(temporaryPath, outputPath);
    console.log(`Verified CycloneDX SBOM written to ${path.relative(projectRoot, outputPath) || outputPath}.`);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error(`CycloneDX SBOM generation failed: ${error.message}`);
  process.exitCode = 1;
});
