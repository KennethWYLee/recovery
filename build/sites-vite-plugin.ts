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
// The hosted fresh-D1 schema is initialized by the authenticated runtime
// bootstrap. This avoids relying on deployment-time SQL parsing after two
// Sites attempts failed while processing these trigger-heavy migrations.
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
      await rm(localVariables, { force: true });
      await rm(outputDirectory, { recursive: true, force: true });
      await mkdir(outputDirectory, { recursive: true });
      if (await exists(hostingConfig)) await cp(hostingConfig, resolve(outputDirectory, "hosting.json"));
    },
  };
}
