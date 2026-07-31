import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const sourceVariables = resolve(root, ".dev.vars");
const generatedConfig = resolve(root, "dist/server/wrangler.json");
const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const forwardedArguments = process.argv.slice(2);
const reservedArguments = new Set(["--config", "--cwd", "--env-file", "--local", "--persist-to", "--var"]);

assert.ok(existsSync(generatedConfig), "Build output is missing. Run npm run build before npm start.");
assert.ok(existsSync(sourceVariables), "Local variables are missing. Copy .dev.vars.example to .dev.vars first.");
for (const argument of forwardedArguments) {
  assert.ok(!reservedArguments.has(argument), `${argument} is managed by the local preview launcher.`);
}

const child = spawn(process.execPath, [
  wrangler,
  "dev",
  "--config",
  generatedConfig,
  "--env-file",
  sourceVariables,
  "--local",
  "--persist-to",
  resolve(root, ".wrangler/state"),
  "--show-interactive-dev-session=false",
  ...forwardedArguments,
], {
  cwd: root,
  env: {
    ...process.env,
    WRANGLER_LOG_PATH: resolve(root, ".wrangler/wrangler.log"),
  },
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    child.kill(signal);
  });
}

const [code, signal] = await once(child, "exit");
if (signal) {
  process.kill(process.pid, signal);
} else {
  process.exitCode = code ?? 1;
}
