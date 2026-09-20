// 出一个桌面测试版：一条命令，不往 main 上提交任何东西。
//
//   node desktop/scripts/release-beta.js           只演示：说清楚会打哪个 tag
//   node desktop/scripts/release-beta.js --push    真的打 tag 并推送（会触发发布流水线）
//
// 做法：从远端 main 切一个临时分支，把版本号改成 <main 的版本>-beta.N，提交，
// 打 tag 并推送，然后切回原来的地方、删掉临时分支。main 永远停在正式版本号上，
// 所以频繁出 beta 不会在 main 上留下一串改版本号的提交，也不会和别人的提交冲突。
//
// 推送 tag 会让 desktop-release.yml 跑起来，并公开发布一个预发布——所以默认只演示。

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DESKTOP_TAG_PREFIX, desktopVersion, isStableVersion } from "./check-desktop-release.js";
import { applyVersion } from "./set-version.js";

/**
 * 这一版的下一个 beta 编号。tags 是远端已有的全部 tag 名。
 * 按数字取最大再加一：字母顺序会把 beta.10 排在 beta.2 前面。
 */
export function nextBetaVersion(baseVersion, tags) {
  if (!isStableVersion(baseVersion)) {
    throw new Error(`main 上的版本号是 ${baseVersion}，要先是正式版本号（1.2.3 的样子）才能出它的 beta`);
  }
  if (tags.includes(`${DESKTOP_TAG_PREFIX}${baseVersion}`)) {
    throw new Error(`${baseVersion} 已经正式发布过了：先把 main 的版本号升到下一个版本，再出 beta`);
  }
  const prefix = `${DESKTOP_TAG_PREFIX}${baseVersion}-beta.`;
  let highest = 0;
  for (const tag of tags) {
    if (!tag.startsWith(prefix)) continue;
    const number = tag.slice(prefix.length);
    if (/^[1-9]\d*$/.test(number)) highest = Math.max(highest, Number(number));
  }
  return `${baseVersion}-beta.${highest + 1}`;
}

function git(cwd, ...args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    const detail = String(error.stderr ?? "").trim() || String(error.message);
    throw new Error(`git ${args.join(" ")} 失败：${detail}`);
  }
}

/** ls-remote 的输出里取 tag 名；带 ^{} 的是同一个 tag 指向的提交，不是另一个 tag。 */
function tagNames(lsRemote) {
  return lsRemote
    .split(/\r?\n/)
    .map((line) => line.split("\t")[1] ?? "")
    .filter((ref) => ref.startsWith("refs/tags/") && !ref.endsWith("^{}"))
    .map((ref) => ref.slice("refs/tags/".length));
}

function main(argv) {
  const push = argv.includes("--push");
  const root = git(process.cwd(), "rev-parse", "--show-toplevel");
  const g = (...args) => git(root, ...args);

  if (g("status", "--porcelain")) {
    throw new Error("工作区有未提交的改动：先提交或放一边再出 beta（临时分支要在干净的工作区上切）");
  }

  // 以远端为准：本地 main 落后或者没有，都不该影响 beta 基于哪个提交。
  g("fetch", "origin", "main");
  const baseSha = g("rev-parse", "origin/main");
  const base = desktopVersion({
    tauriConf: g("show", "origin/main:desktop/src-tauri/tauri.conf.json"),
    cargoToml: g("show", "origin/main:desktop/src-tauri/Cargo.toml"),
  });
  const tags = tagNames(g("ls-remote", "--tags", "origin", `${DESKTOP_TAG_PREFIX}*`));
  const version = nextBetaVersion(base, tags);
  const tag = `${DESKTOP_TAG_PREFIX}${version}`;

  console.log(`基于 origin/main（${baseSha.slice(0, 7)}），正式版本号 ${base}`);
  console.log(`将打 tag：${tag}（版本号 ${version}）`);
  if (!push) {
    console.log("这只是演示，什么都没改。要真的打 tag 并推送，加 --push（会触发发布流水线，公开发布一个预发布）。");
    return;
  }

  const branch = `beta/${version}`;
  if (g("branch", "--list", branch)) {
    throw new Error(`本地已经有分支 ${branch}，先删掉它再来`);
  }
  const head = g("rev-parse", "--abbrev-ref", "HEAD");
  const back = head === "HEAD" ? ["switch", "--detach", g("rev-parse", "HEAD")] : ["switch", head];

  g("switch", "-c", branch, "origin/main");
  let tagged = false;
  try {
    applyVersion(root, version);
    g(
      "add",
      "desktop/src-tauri/tauri.conf.json",
      "desktop/src-tauri/Cargo.toml",
      "desktop/src-tauri/Cargo.lock",
    );
    g("commit", "-m", `chore(beta): ${version}`);
    g("tag", tag);
    tagged = true;
    g("push", "origin", tag);
  } catch (error) {
    // 推送没成功就别留着本地 tag，否则下一次会以为这个编号已经用掉了。
    if (tagged) {
      try {
        g("tag", "-d", tag);
      } catch {
        /* 删不掉也不能盖住原来的错误 */
      }
    }
    throw error;
  } finally {
    // 无论成败都回到原来的地方；临时分支上只有我们自己的改动，丢掉是安全的。
    try {
      g("reset", "--hard");
    } catch {
      /* 继续往下清理 */
    }
    g(...back);
    g("branch", "-D", branch);
  }
  console.log(`已推送 ${tag}。发布流水线会在几分钟后把它建成预发布，进度看 Actions 里的 Release Desktop。`);
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
