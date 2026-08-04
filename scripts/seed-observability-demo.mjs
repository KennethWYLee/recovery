import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateObservabilityDemoRows, observabilityDemoSql } from "./observability-demo-data.mjs";

const anchorArgument = process.argv.find((value) => value.startsWith("--anchor="));
const anchor = anchorArgument?.slice("--anchor=".length) ?? new Date().toISOString();
const rows = generateObservabilityDemoRows({ anchor });
const tempDirectory = await mkdtemp(join(tmpdir(), "continuity-ops-observability-"));
const sqlFile = join(tempDirectory, "observability-demo.sql");

try {
  await writeFile(sqlFile, observabilityDemoSql(rows), "utf8");
  const result = spawnSync(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc",
    "--persist-to", ".wrangler/state", "--file", sqlFile,
  ], { cwd: process.cwd(), encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || "");
    throw new Error(`wrangler exited with status ${result.status}`);
  }
  process.stdout.write(`Inserted ${rows.length} simulated request records ending at ${anchor}.\n`);
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
