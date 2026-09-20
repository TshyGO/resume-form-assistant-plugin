// 把桌面的版本号一次改齐：tauri.conf.json、Cargo.toml，以及 Cargo.lock 里本应用那一条。
//
//   node desktop/scripts/set-version.js 0.1.0-beta.2
//
// 三处对不上，发版守卫会拦；Cargo.lock 那一条不跟着改，`cargo fetch --locked` 会失败。
// 所以这里一次改齐，而不是让人记得改哪几处。
//
// 全部算好再写盘：算的时候任何一处出错，磁盘上一个字节都不动；写盘中途失败会还原。
//
// desktop/package.json 和它的 lock 不在这里：它们的 version 不参与构建（界面和 --help
// 报的版本来自 tauri.conf.json / Cargo.toml），随 main 一起写正式版本号，beta 提交里不改。

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBetaVersion, isStableVersion } from "./check-desktop-release.js";

function assertVersion(version) {
  if (!isStableVersion(version) && !isBetaVersion(version)) {
    throw new Error(`版本号要写成 1.2.3 或 1.2.3-beta.N 的样子，拿到的是 ${version}`);
  }
}

/** 偶数位是内容、奇数位是换行符：改完原样拼回去，CRLF 文件不会被整份改成 LF。 */
const splitLines = (text) => text.split(/(\r?\n)/);

export function setTauriConfVersion(text, version) {
  assertVersion(version);
  const before = JSON.parse(text);
  if (typeof before.version !== "string") {
    throw new Error("tauri.conf.json 里没有顶层 version");
  }
  const pattern = /^(\s*"version"\s*:\s*")([^"]*)(")/m;
  const first = pattern.exec(text);
  // 第一处 "version" 若不是顶层那个（别的配置块排在前面），宁可报错也不改错地方。
  if (!first || first[2] !== before.version) {
    throw new Error('tauri.conf.json 里第一处 "version" 不是顶层那一个，请手动改');
  }
  const out = text.replace(pattern, (_, head, _old, tail) => `${head}${version}${tail}`);
  const after = JSON.parse(out);
  const same = JSON.stringify({ ...after, version: 0 }) === JSON.stringify({ ...before, version: 0 });
  if (after.version !== version || !same) {
    throw new Error("tauri.conf.json 改完除了 version 还有别的变化，已放弃");
  }
  return out;
}

export function setCargoTomlVersion(text, version) {
  assertVersion(version);
  const parts = splitLines(text);
  let inPackage = false;
  for (let i = 0; i < parts.length; i += 2) {
    const section = /^\s*\[([^\]]+)\]/.exec(parts[i]);
    if (section) {
      inPackage = section[1].trim() === "package";
      continue;
    }
    if (!inPackage) continue;
    const match = /^(\s*version\s*=\s*")([^"]*)(".*)$/.exec(parts[i]);
    if (match) {
      parts[i] = `${match[1]}${version}${match[3]}`;
      return parts.join("");
    }
  }
  throw new Error("Cargo.toml 的 [package] 段里没有 version");
}

export function setCargoLockVersion(text, packageName, version) {
  assertVersion(version);
  const parts = splitLines(text);
  const nameLine = `name = "${packageName}"`;
  const hits = [];
  for (let i = 0; i < parts.length; i += 2) {
    if (parts[i] === nameLine) hits.push(i);
  }
  if (hits.length === 0) throw new Error(`Cargo.lock 里找不到 ${packageName}`);
  if (hits.length > 1) throw new Error(`Cargo.lock 里 ${packageName} 不止一条`);
  const at = hits[0] + 2;
  if (!/^version = "[^"]*"$/.test(parts[at] ?? "")) {
    throw new Error(`Cargo.lock 里 ${packageName} 的下一行不是 version`);
  }
  parts[at] = `version = "${version}"`;
  return parts.join("");
}

function packageName(cargoToml) {
  let inPackage = false;
  for (const line of cargoToml.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      inPackage = section[1].trim() === "package";
      continue;
    }
    const match = inPackage ? /^\s*name\s*=\s*"([^"]+)"/.exec(line) : null;
    if (match) return match[1];
  }
  throw new Error("Cargo.toml 的 [package] 段里没有 name");
}

/**
 * root 是仓库根目录。返回被改过的文件路径。
 *
 * 先全部算好再写；写盘中途失败（磁盘满、权限）时，把试过写的文件还原成原样，
 * 不留下三处版本号不一致的状态。还原也失败就把这件事一并报出来，让人手动处理。
 * write 可以替换，测试靠它模拟写盘失败。
 */
export function applyVersion(root, version, { write = writeFileSync } = {}) {
  assertVersion(version);
  const dir = join(root, "desktop", "src-tauri");
  const paths = {
    conf: join(dir, "tauri.conf.json"),
    toml: join(dir, "Cargo.toml"),
    lock: join(dir, "Cargo.lock"),
  };
  const conf = readFileSync(paths.conf, "utf8");
  const toml = readFileSync(paths.toml, "utf8");
  const lock = readFileSync(paths.lock, "utf8");
  // 先全部算好再写：任何一处报错，磁盘上一个字节都不动。
  const next = {
    conf: setTauriConfVersion(conf, version),
    toml: setCargoTomlVersion(toml, version),
    lock: setCargoLockVersion(lock, packageName(toml), version),
  };
  const jobs = [
    [paths.conf, conf, next.conf],
    [paths.toml, toml, next.toml],
    [paths.lock, lock, next.lock],
  ];
  const attempted = [];
  try {
    for (const job of jobs) {
      attempted.push(job);
      write(job[0], job[2]);
    }
  } catch (error) {
    // 失败的那一个也要还原：写到一半的文件可能只剩半截。
    const failures = [];
    for (const [path, before] of attempted) {
      try {
        write(path, before);
      } catch (restoreError) {
        failures.push(`${path}：${restoreError.message}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `写盘失败（${error.message}），而且还原时又出错：${failures.join("；")}。请用 git checkout 还原这三个文件`,
      );
    }
    throw error;
  }
  return Object.values(paths);
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
    const version = process.argv[2];
    if (!version) throw new Error("用法：node desktop/scripts/set-version.js <版本号>");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    for (const file of applyVersion(root, version)) console.log(`已改：${file}`);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
