import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_DIRECTORIES = new Set([
  ".github",
  ".openai",
  "app",
  "build",
  "db",
  "docs",
  "lib",
  "public",
  "scripts",
  "tests",
  "worker",
]);

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".vinext",
  ".wrangler",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "outputs",
  "work",
]);

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".ps1",
  ".scss",
  ".sh",
  ".sql",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

const ROOT_TEXT_FILES = new Set([
  ".dev.vars.example",
  ".env.example",
  ".gitignore",
  "CLAUDE.md",
  "AGENTS.md",
  "PROJECT.md",
  "README.md",
]);

export const SECRET_PATTERNS = Object.freeze([
  {
    id: "private-key",
    label: "private-key material",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/gu,
  },
  {
    id: "github-token",
    label: "GitHub access token",
    regex: /(?:gh[opusr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{82,255})/gu,
  },
  {
    id: "gitlab-token",
    label: "GitLab access token",
    regex: /glpat-[A-Za-z0-9_-]{20,255}/gu,
  },
  {
    id: "slack-token",
    label: "Slack token",
    regex: /xox[baprs]-[A-Za-z0-9-]{10,255}/gu,
  },
  {
    id: "aws-access-key",
    label: "AWS access key identifier",
    regex: /(?:AKIA|ASIA)[0-9A-Z]{16}/gu,
  },
  {
    id: "google-api-key",
    label: "Google API key",
    regex: /AIza[0-9A-Za-z_-]{35}/gu,
  },
  {
    id: "stripe-live-secret",
    label: "Stripe live secret key",
    regex: /sk_live_[0-9A-Za-z]{20,255}/gu,
  },
  {
    id: "sendgrid-api-key",
    label: "SendGrid API key",
    regex: /SG\.[0-9A-Za-z_-]{22}\.[0-9A-Za-z_-]{43}/gu,
  },
  {
    id: "npm-token",
    label: "npm access token",
    regex: /npm_[A-Za-z0-9]{36}/gu,
  },
  {
    id: "twilio-api-key",
    label: "Twilio API key",
    regex: /SK[0-9a-fA-F]{32}/gu,
  },
  {
    id: "discord-webhook",
    label: "Discord webhook URL",
    regex: /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{17,20}\/[A-Za-z0-9_-]{60,255}/gu,
  },
  {
    id: "named-provider-secret",
    label: "provider secret assigned in source",
    regex:
      /(?:CLOUDFLARE_API_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|STRIPE_SECRET_KEY)\s*[:=]\s*["']?([A-Za-z0-9_+\/=.-]{20,255})/gu,
    secretGroup: 1,
  },
]);

function isExampleEnvironmentFile(relativePath) {
  const name = path.basename(relativePath);
  return name === ".env.example" || name === ".dev.vars.example";
}

function isRealEnvironmentFile(relativePath) {
  const name = path.basename(relativePath);
  return (
    (name === ".env" || name.startsWith(".env.")) &&
      !isExampleEnvironmentFile(relativePath)
  ) || (
    (name === ".dev.vars" || name.startsWith(".dev.vars.")) &&
      !isExampleEnvironmentFile(relativePath)
  );
}

function isTextSource(relativePath) {
  const name = path.basename(relativePath);
  return ROOT_TEXT_FILES.has(name) || TEXT_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function isExplicitPlaceholder(value) {
  const normalized = value.toLowerCase();
  return [
    "changeme",
    "dummy",
    "example",
    "placeholder",
    "replace-with",
    "test-only",
    "your-",
  ].some((marker) => normalized.includes(marker));
}

export function scanText(text, relativePath = "<memory>") {
  const findings = [];

  for (const pattern of SECRET_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    for (const match of text.matchAll(regex)) {
      const candidate = match[pattern.secretGroup ?? 0] ?? match[0];
      if (isExplicitPlaceholder(candidate)) continue;

      findings.push({
        patternId: pattern.id,
        label: pattern.label,
        path: relativePath,
        line: lineNumberAt(text, match.index ?? 0),
      });
    }
  }

  return findings;
}

async function collectTextFiles(rootDirectory) {
  const files = [];

  async function visit(directory, relativeDirectory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`Cannot enumerate ${relativeDirectory || "."}: ${error.message}`);
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Refusing to skip symbolic link inside scan scope: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
          await visit(path.join(directory, entry.name), relativePath);
        }
        continue;
      }
      if (entry.isFile() && !isRealEnvironmentFile(relativePath) && isTextSource(relativePath)) {
        files.push(relativePath);
      }
    }
  }

  const rootEntries = await readdir(rootDirectory, { withFileTypes: true });
  rootEntries.sort((left, right) => left.name.localeCompare(right.name, "en"));

  for (const entry of rootEntries) {
    if (entry.isSymbolicLink()) {
      if (SOURCE_DIRECTORIES.has(entry.name) || ROOT_TEXT_FILES.has(entry.name)) {
        throw new Error(`Refusing to skip symbolic link inside scan scope: ${entry.name}`);
      }
      continue;
    }
    if (entry.isDirectory() && SOURCE_DIRECTORIES.has(entry.name)) {
      await visit(path.join(rootDirectory, entry.name), entry.name);
    } else if (
      entry.isFile() &&
      !isRealEnvironmentFile(entry.name) &&
      (ROOT_TEXT_FILES.has(entry.name) || isTextSource(entry.name))
    ) {
      files.push(entry.name);
    }
  }

  return files;
}

export async function scanRepository(rootDirectory) {
  const resolvedRoot = path.resolve(rootDirectory);
  const files = await collectTextFiles(resolvedRoot);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const findings = [];

  for (const relativePath of files) {
    let bytes;
    try {
      bytes = await readFile(path.join(resolvedRoot, relativePath));
    } catch (error) {
      throw new Error(`Cannot read ${relativePath}: ${error.message}`);
    }

    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      throw new Error(`Expected UTF-8 text but could not decode ${relativePath}`);
    }
    findings.push(...scanText(text, relativePath.split(path.sep).join("/")));
  }

  findings.sort((left, right) =>
    left.path.localeCompare(right.path, "en") ||
    left.line - right.line ||
    left.patternId.localeCompare(right.patternId, "en"),
  );

  return { filesScanned: files.length, findings };
}
