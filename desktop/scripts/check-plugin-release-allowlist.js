import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED = [
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "LICENSE",
];

const FORBIDDEN = new Set([
  "desktop",
  "desktop/",
  "src-tauri",
  "src-tauri/",
  "target",
  "target/",
  "node_modules",
  "node_modules/",
  ".cargo-cache",
]);

export function parseGitArchiveEntries(workflowText) {
  const match = workflowText.match(/git archive[\s\S]*?\bHEAD\b([\s\S]*?)(?:\n\s*echo|\n\s*$)/);
  if (!match) {
    throw new Error("Could not find git archive file list");
  }
  return match[1]
    .replace(/\\\s*\n/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^['"]|['"]$/g, ""))
    .filter((token) => token && !token.startsWith("--") && token !== "HEAD");
}

export function assertPluginOnlyArchive(entries) {
  const exact = new Set(entries);
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    if (
      FORBIDDEN.has(entry) ||
      FORBIDDEN.has(normalized) ||
      normalized === "desktop" ||
      normalized.startsWith("desktop/")
    ) {
      throw new Error(`release archive must not include ${entry}`);
    }
  }
  for (const required of REQUIRED) {
    if (!exact.has(required)) {
      throw new Error(`release archive missing exact entry ${required}`);
    }
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const entries = parseGitArchiveEntries(workflow);
  assertPluginOnlyArchive(entries);
  console.log("release.yml still packs plugin runtime files only");
}
