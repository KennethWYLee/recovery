import { access, cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Packages only the Sites binding metadata after Vite finishes compiling.
// Database migrations live in drizzle/ and are applied during deployment;
// the runtime verifies the schema and fails clearly when it is incomplete.
export function sites(): Plugin {
  let root = process.cwd();
  return {
    name: "sites",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    async closeBundle() {
      const outputDirectory = resolve(root, "dist", ".openai");
      const localVariables = resolve(root, "dist", "server", ".dev.vars");
      const hostingConfig = resolve(root, ".openai", "hosting.json");
      const migrations = resolve(root, "drizzle");
      await rm(localVariables, { force: true });
      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });
      if (await exists(hostingConfig)) await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
      if (await exists(migrations)) await cp(migrations, resolve(outputDirectory, "drizzle"), { recursive: true });
    },
  };
}
