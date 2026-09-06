import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
const archiveMatch = workflow.match(/git archive[\s\S]*?(?:\n\s*echo)/);
if (!archiveMatch) {
  throw new Error("Could not find git archive file list in release.yml");
}
const block = archiveMatch[0];
const forbidden = ["desktop/", "target/", "node_modules/", "src-tauri/", ".cargo-cache"];
for (const item of forbidden) {
  if (block.includes(item)) {
    throw new Error(`release.yml git archive must not include ${item}`);
  }
}
for (const required of ["manifest.json", "background.js", "content.js", "LICENSE"]) {
  if (!block.includes(required)) {
    throw new Error(`release.yml git archive missing ${required}`);
  }
}
console.log("release.yml still packs plugin runtime files only");
