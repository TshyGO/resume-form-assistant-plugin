import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
  const allowed = new Set(["manifest.json","background.js","content.js","content.css","ai-helpers.js","form-agent.js",
    "ai-worker.js","ai-host.js","ai-host.html","ai-client.js","resume-utils.js","popup.html","popup.css","popup.js",
    "xlsx.full.min.js","mammoth.browser.min.js","README.md","LICENSE",
    ...JSON.parse(readFileSync(new URL('./plugin-release-assets.json', import.meta.url), 'utf8'))]);
  const exact = new Set(entries);
  for (const entry of entries) {
    const normalized = entry.replace(/\\/g, "/");
    if (!allowed.has(normalized)) throw new Error(`release archive must not include ${entry}`);
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

// The allowlist above answers "did anything forbidden get in". It cannot answer the
// opposite question -- "is everything the extension actually loads present" -- and that
// gap shipped a real break: background.js became a module importing ./link/worker.mjs
// while release.yml still packed a file list with no link operand. The zip stayed
// allowlist-clean and the service worker would have failed to load.
const RELATIVE_FROM = /from\s*['"](\.[^'"]+)['"]/g;
const RELATIVE_DYNAMIC = /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function resolveSpecifier(importer, specifier) {
  const parts = importer.includes("/") ? importer.slice(0, importer.lastIndexOf("/")).split("/") : [];
  for (const segment of specifier.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** Every file reachable from `entries` by static or dynamic relative import. */
export function collectModuleGraph(entries, readFile) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const current = queue.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const text = readFile(current);
    if (typeof text !== "string") continue;
    for (const pattern of [RELATIVE_FROM, RELATIVE_DYNAMIC]) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        queue.push(resolveSpecifier(current, match[1]));
      }
    }
  }
  return seen;
}

/** Entry points the browser loads directly, read out of the manifest. */
export function manifestEntryPoints(manifest) {
  const entries = [];
  if (manifest.background && manifest.background.service_worker) {
    entries.push(manifest.background.service_worker);
  }
  for (const script of manifest.content_scripts || []) {
    entries.push(...(script.js || []), ...(script.css || []));
  }
  return entries;
}

export function assertRuntimeModulesPackaged(graph, leaves) {
  const packaged = new Set(leaves.map((leaf) => leaf.split("\\").join("/")));
  const missing = [...graph].filter((file) => !packaged.has(file));
  if (missing.length) {
    throw new Error(
      `release archive is missing files the extension loads at runtime: ${missing.sort().join(", ")}`
    );
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
  const entries = parseGitArchiveEntries(workflow);
  // Expand directory operands against the exact Git tree that git archive uses.
  // The reviewed asset manifest is static; newly tracked descendants fail.
  const leaves = execFileSync('git', ['ls-tree', '-r', '--name-only', 'HEAD', '--', ...entries], {cwd:root,encoding:'utf8'}).trim().split(/\r?\n/);
  assertPluginOnlyArchive(leaves);

  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  const graph = collectModuleGraph(manifestEntryPoints(manifest), (file) => {
    try {
      return readFileSync(join(root, file), "utf8");
    } catch {
      return null;
    }
  });
  assertRuntimeModulesPackaged(graph, leaves);

  console.log(`release.yml packs plugin runtime files only, and all ${graph.size} runtime files are present`);
}
