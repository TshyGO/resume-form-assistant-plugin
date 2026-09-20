import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nextBetaVersion } from "./release-beta.js";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "release-beta.js");

test("还没有 beta 时从 beta.1 开始", () => {
  assert.equal(nextBetaVersion("0.1.0", []), "0.1.0-beta.1");
});

test("按数字而不是按字母顺序取下一个：beta.10 之后是 beta.11", () => {
  const tags = ["desktop-v0.1.0-beta.1", "desktop-v0.1.0-beta.2", "desktop-v0.1.0-beta.10"];
  assert.equal(nextBetaVersion("0.1.0", tags), "0.1.0-beta.11");
});

test("别的基础版本、插件的 tag、更早的正式版，都不影响这一版的编号", () => {
  const tags = ["desktop-v0.1.1-beta.7", "v0.4.0", "desktop-v0.0.9", "desktop-v0.1.0-beta.3"];
  assert.equal(nextBetaVersion("0.1.0", tags), "0.1.0-beta.4");
  assert.equal(nextBetaVersion("0.1.1", tags), "0.1.1-beta.8");
});

test("这一版已经正式发布过，就不再出它的 beta", () => {
  assert.throws(() => nextBetaVersion("0.1.0", ["desktop-v0.1.0"]), /已经正式发布/);
});

test("main 上的版本号本身要是正式版本号", () => {
  assert.throws(() => nextBetaVersion("0.1.0-beta.2", []), /1\.2\.3/);
});

// ---------- 下面用真实的 git 仓库走一遍：这个脚本会打 tag 并推送，不能只靠单测对字符串 ----------

const identity = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...identity } }).trim();

const CONF = '{\n  "productName": "X",\n  "version": "0.1.0"\n}\n';
const TOML = '[package]\nname = "resume-pro-desktop"\nversion = "0.1.0"\n';
const LOCK = '[[package]]\nname = "resume-pro-desktop"\nversion = "0.1.0"\n';

/** 造一个远端 + 一份工作副本，里面只有改版本号会碰的三个文件。 */
function makeRepos() {
  const base = mkdtempSync(join(tmpdir(), "release-beta-"));
  const origin = join(base, "origin.git");
  git(base, "init", "--bare", "-b", "main", origin);
  const work = join(base, "work");
  git(base, "clone", origin, work);
  // 空仓库克隆下来，HEAD 停在哪个未出生的分支取决于 git 版本；-B 两种情况都成立。
  git(work, "checkout", "-B", "main");
  const dir = join(work, "desktop", "src-tauri");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "tauri.conf.json"), CONF);
  writeFileSync(join(dir, "Cargo.toml"), TOML);
  writeFileSync(join(dir, "Cargo.lock"), LOCK);
  git(work, "add", "-A");
  git(work, "commit", "-m", "init");
  git(work, "push", "-u", "origin", "main");
  return { base, origin, work };
}

function run(work, ...args) {
  try {
    const stdout = execFileSync("node", [script, ...args], {
      cwd: work,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, ...identity },
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const remoteTags = (origin) => git(origin, "tag", "-l");

test("默认只演示：说清楚要打什么，但不改任何东西", () => {
  const { origin, work } = makeRepos();
  const result = run(work);
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /desktop-v0\.1\.0-beta\.1/);
  assert.match(result.out, /--push/);
  assert.equal(remoteTags(origin), "");
  assert.equal(git(work, "tag", "-l"), "");
  assert.equal(git(work, "status", "--porcelain"), "");
});

test("--push：tag 指向改过版本号的提交，main 原封不动，本地不留临时分支；再跑一次编号顺延", () => {
  const { origin, work } = makeRepos();
  const mainBefore = git(origin, "rev-parse", "main");

  const first = run(work, "--push");
  assert.equal(first.code, 0, first.out);
  assert.equal(remoteTags(origin), "desktop-v0.1.0-beta.1");
  // tag 上的三个文件都是 beta 版本号，且这个提交就在 main 之上一步。
  const tagged = (file) => git(origin, "show", `desktop-v0.1.0-beta.1:desktop/src-tauri/${file}`);
  assert.match(tagged("tauri.conf.json"), /"version": "0\.1\.0-beta\.1"/);
  assert.match(tagged("Cargo.toml"), /version = "0\.1\.0-beta\.1"/);
  assert.match(tagged("Cargo.lock"), /version = "0\.1\.0-beta\.1"/);
  assert.equal(git(origin, "rev-parse", "desktop-v0.1.0-beta.1^"), mainBefore);
  // main 没有被动：远端的 main 还是原来那个提交，本地也回到了 main、工作区干净。
  assert.equal(git(origin, "rev-parse", "main"), mainBefore);
  assert.equal(git(work, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(git(work, "rev-parse", "main"), mainBefore);
  assert.equal(git(work, "status", "--porcelain"), "");
  assert.equal(git(work, "branch", "--list", "beta/*"), "");
  assert.match(readFileSync(join(work, "desktop", "src-tauri", "tauri.conf.json"), "utf8"), /"version": "0\.1\.0"/);

  const second = run(work, "--push");
  assert.equal(second.code, 0, second.out);
  assert.equal(remoteTags(origin).split("\n").sort().join(","), "desktop-v0.1.0-beta.1,desktop-v0.1.0-beta.2");
});

test("工作区有没提交的改动时拒绝，而且什么都没打", () => {
  const { origin, work } = makeRepos();
  writeFileSync(join(work, "notes.txt"), "还没提交");
  const result = run(work, "--push");
  assert.notEqual(result.code, 0);
  assert.match(result.out, /未提交/);
  assert.equal(remoteTags(origin), "");
});

test("这一版已经正式发布过就拒绝，并提示先升 main 的版本号", () => {
  const { origin, work } = makeRepos();
  git(work, "tag", "desktop-v0.1.0");
  git(work, "push", "origin", "desktop-v0.1.0");
  const result = run(work, "--push");
  assert.notEqual(result.code, 0);
  assert.match(result.out, /已经正式发布/);
  assert.equal(remoteTags(origin), "desktop-v0.1.0");
});

test("以远端的 main 为准：本地 main 落后时，beta 仍然基于远端最新的提交", () => {
  const { base, origin, work } = makeRepos();
  // 另一个人往远端 main 推了一个新提交，本地这份没更新。
  const other = join(base, "other");
  git(base, "clone", origin, other);
  writeFileSync(join(other, "later.txt"), "别人后来加的");
  git(other, "add", "-A");
  git(other, "commit", "-m", "later");
  git(other, "push", "origin", "main");
  const latest = git(origin, "rev-parse", "main");
  assert.notEqual(git(work, "rev-parse", "main"), latest);

  const result = run(work, "--push");
  assert.equal(result.code, 0, result.out);
  assert.equal(git(origin, "rev-parse", "desktop-v0.1.0-beta.1^"), latest);
});
