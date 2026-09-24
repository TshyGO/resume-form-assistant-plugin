// 打一份只含插件运行文件的 zip。桌面发版和插件发版共用这一份清单，
// 避免两个工作流各写一份 git archive，漏了 link/ 之类的目录。
//
//   node desktop/scripts/pack-plugin.js --output dist/resume-pro-plugin-0.4.0.zip

import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * 交给 `git archive` 的路径。目录会按 Git 树展开。
 * 增删这里时，`check-plugin-release-allowlist.js` 会核对运行时引用是否都在包里。
 */
export const PLUGIN_ARCHIVE_OPERANDS = [
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "sidebar-state.js",
  "ai-helpers.js",
  "form-agent.js",
  "ai-worker.js",
  "ai-host.js",
  "ai-host.html",
  "ai-client.js",
  "ai-models.js",
  "resume-utils.js",
  "profile-fields.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "sidepanel.html",
  "sidepanel.css",
  "sidepanel.js",
  "xlsx.full.min.js",
  "mammoth.browser.min.js",
  "link",
  "vendor",
  "icons",
  "README.md",
  "LICENSE",
];

export function packPlugin(root, output, treeish = "HEAD") {
  if (!output.endsWith(".zip")) {
    throw new Error(`插件包必须是 .zip，拿到的是 ${output}`);
  }
  const absolute = resolve(output);
  mkdirSync(dirname(absolute), { recursive: true });
  execFileSync(
    "git",
    ["archive", "--format=zip", `--output=${absolute}`, treeish, ...PLUGIN_ARCHIVE_OPERANDS],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  return absolute;
}

function main(argv) {
  const outAt = argv.indexOf("--output");
  const output = outAt >= 0 ? argv[outAt + 1] : "";
  if (!output || output.startsWith("--")) {
    throw new Error("--output 后面要跟 zip 路径");
  }
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  }).trim();
  const packed = packPlugin(root, output);
  console.log(packed);
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
