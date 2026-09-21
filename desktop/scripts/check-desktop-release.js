// 桌面发版前的门禁：版本号一致、tag 归位、包里没有多余东西、上传的东西是对的。
//
// 逻辑放在这里而不是 YAML 里，是为了本地能跑、也能被测试盯住：
//
//   node desktop/scripts/check-desktop-release.js desktop-v0.1.0
//   node desktop/scripts/check-desktop-release.js --assets dist-release --write-checksums
//
// 校验和也由这里算：`sha256sum` 在 macOS runner 上不一定有，而 Node 到处都有。

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 桌面的 tag 前缀。插件用的是 `v*.*.*`，两边不能撞。 */
export const DESKTOP_TAG_PREFIX = "desktop-v";

/** 能作为安装包上传的后缀。以后加 `.msi` 之类改这里，配套校验和的规则自动跟上。 */
export const INSTALLER_SUFFIXES = [".exe", ".dmg", ".msi"];

/** 除了安装包，只允许它们的校验和。 */
export const CHECKSUM_SUFFIX = ".sha256";

/** 正式版 1.2.3。 */
export const isStableVersion = (version) => /^\d+\.\d+\.\d+$/.test(version);

/**
 * 测试版 1.2.3-beta.N：N 从 1 起、不带前导零。
 * 只认 beta：别的后缀多半是手滑，放行的话会以一个没定义过的发布类别发出去。
 */
export const isBetaVersion = (version) => /^\d+\.\d+\.\d+-beta\.[1-9]\d*$/.test(version);

/**
 * 三处版本号必须一样：`tauri.conf.json` 决定安装包文件名和「关于」页，
 * `Cargo.toml` 决定二进制自己报的版本。对不上时用户看到的版本取决于他看哪里。
 */
export function desktopVersion({ tauriConf, cargoToml }) {
  const fromConf = JSON.parse(tauriConf).version;
  const fromCargo = packageVersion(cargoToml);
  if (!fromConf || !fromCargo) {
    throw new Error("读不出版本号：tauri.conf.json 或 Cargo.toml 里没有 version");
  }
  if (fromConf !== fromCargo) {
    throw new Error(`版本号对不上：tauri.conf.json 是 ${fromConf}，Cargo.toml 是 ${fromCargo}`);
  }
  if (!isStableVersion(fromConf) && !isBetaVersion(fromConf)) {
    throw new Error(`版本号要写成 1.2.3 或 1.2.3-beta.N 的样子，拿到的是 ${fromConf}。`);
  }
  return fromConf;
}

/**
 * 只认 `[package]` 段里的 `version`。整文件抓第一个 `version = "..."`，
 * 会在依赖项排在前面时取到别人的版本号。
 */
export function packageVersion(cargoToml) {
  let inPackage = false;
  for (const line of cargoToml.split(/\r?\n/)) {
    const section = /^\s*\[([^\]]+)\]/.exec(line);
    if (section) {
      inPackage = section[1].trim() === "package";
      continue;
    }
    if (!inPackage) continue;
    const match = /^\s*version\s*=\s*"([^"]+)"/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** tag 与版本号的对应关系。写错一个字就别发版，不然下载下来的文件名对不上。 */
export function assertTagMatches(tag, version) {
  if (!tag.startsWith(DESKTOP_TAG_PREFIX)) {
    throw new Error(`桌面的 tag 要以 ${DESKTOP_TAG_PREFIX} 开头，拿到的是 ${tag}`);
  }
  const tagged = tag.slice(DESKTOP_TAG_PREFIX.length);
  if (tagged !== version) {
    throw new Error(`tag 是 ${tag}，但版本号是 ${version}`);
  }
}

/**
 * 这个 tag 发的是测试版还是正式版。工作流靠它决定要不要建成预发布，
 * 不在 YAML 里自己猜：认不出的后缀（rc、alpha……）若被当成正式版，
 * 就会以「最新版」的身份发出去，所以直接报错。
 */
export function releaseKind(tag) {
  if (!tag.startsWith(DESKTOP_TAG_PREFIX)) {
    throw new Error(`桌面的 tag 要以 ${DESKTOP_TAG_PREFIX} 开头，拿到的是 ${tag}`);
  }
  const version = tag.slice(DESKTOP_TAG_PREFIX.length);
  if (isStableVersion(version)) return "stable";
  if (isBetaVersion(version)) return "beta";
  throw new Error(`认不出 ${tag} 的版本后缀：只有 1.2.3 和 1.2.3-beta.N 两种写法`);
}

/**
 * 插件的 release 工作流按 `v*.*.*` 触发。桌面的 tag 必须落在它之外，
 * 否则一次桌面发版会顺手发一个插件包出去。
 */
export function tagIsPluginShaped(tag) {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

/**
 * 打包配置里不许出现「顺手带上的文件」。`resources` / `externalBin` 一旦有值，
 * 安装包里就会多出仓库里的东西，而那正是「不含测试数据、调试 profile」这条验收
 * 最容易破的地方。前端产物目录也看一眼：指到源码或测试目录上同样是把不该发的
 * 东西打进包里。
 */
export function assertNothingExtraBundled(tauriConf) {
  const config = JSON.parse(tauriConf);
  const bundle = config.bundle ?? {};
  const extras = ["resources", "externalBin", "files"].filter((key) => {
    const value = bundle[key];
    return Array.isArray(value) ? value.length > 0 : value && Object.keys(value).length > 0;
  });
  if (extras.length > 0) {
    throw new Error(
      `bundle 里带了额外文件（${extras.join("、")}）。要加东西进安装包，先在 D13 的计划里写明白为什么。`,
    );
  }
  const frontend = config.build?.frontendDist;
  if (frontend !== "../dist") {
    throw new Error(`frontendDist 应该指向构建产物 ../dist，现在指向 ${frontend}`);
  }
}

/**
 * 没有 Apple Developer ID 时也必须完整地 ad-hoc 签整个 app bundle。
 * 只让 Apple Silicon 链接器给主二进制留下临时签名，会让从浏览器下载的 `.app`
 * 被 Gatekeeper 报成“已损坏”。Tauri 用伪 identity `-` 生成完整 bundle 签名。
 */
export function assertMacOsAdHocSigning(tauriConf) {
  const identity = JSON.parse(tauriConf).bundle?.macOS?.signingIdentity;
  if (identity !== "-") {
    throw new Error(
      `macOS 无 Developer ID 的构建必须设置 bundle.macOS.signingIdentity 为 "-"，现在是 ${String(identity)}`,
    );
  }
}

/**
 * 上传前的最后一道：目录里只能有安装包和它们各自的校验和，而且一一配对。
 * 少一个校验和，用户就没法核对自己下到的东西。
 */
export function assertReleaseAssets(names) {
  if (names.length === 0) {
    throw new Error("一个资产都没有，构建多半失败了");
  }
  const installers = names.filter((name) => INSTALLER_SUFFIXES.some((s) => name.endsWith(s)));
  const checksums = names.filter((name) => name.endsWith(CHECKSUM_SUFFIX));
  const strays = names.filter((name) => !installers.includes(name) && !checksums.includes(name));
  if (strays.length > 0) {
    throw new Error(`这些文件不该作为 Release 资产上传：${strays.join("、")}`);
  }
  if (installers.length === 0) {
    throw new Error("只有校验和，没有安装包");
  }
  const missing = installers.filter((name) => !checksums.includes(`${name}${CHECKSUM_SUFFIX}`));
  if (missing.length > 0) {
    throw new Error(`这些安装包没有配套的校验和：${missing.join("、")}`);
  }
  const orphan = checksums.filter(
    (name) => !installers.includes(name.slice(0, -CHECKSUM_SUFFIX.length)),
  );
  if (orphan.length > 0) {
    throw new Error(`这些校验和没有对应的安装包：${orphan.join("、")}`);
  }
}

/**
 * 复算一遍校验和。构建机写的和发布机手里的是两份文件（中间过了一次 artifact），
 * 只比文件名对不对说明不了它们是同一个东西。
 */
export function verifyChecksums(dir, io = { readdirSync, readFileSync }) {
  const names = io.readdirSync(dir);
  assertReleaseAssets(names);
  const checked = [];
  for (const name of names.filter((n) => n.endsWith(CHECKSUM_SUFFIX))) {
    const installer = name.slice(0, -CHECKSUM_SUFFIX.length);
    const recorded = io.readFileSync(join(dir, name), "utf8").trim().split(/\s+/)[0];
    const actual = sha256(io.readFileSync(join(dir, installer)));
    if (recorded !== actual) {
      throw new Error(`${installer} 的校验和对不上：文件里写着 ${recorded}，实际是 ${actual}`);
    }
    checked.push(installer);
  }
  return checked;
}

/**
 * 前端产物里不该出现的东西。`resources`/`externalBin` 那道检查只看配置，
 * 真把 `.env`、sourcemap、测试夹具构建进 `dist` 的话它是看不见的。
 */
export const DIST_FORBIDDEN = [/\.map$/i, /^\.env/i, /fixture/i, /\.test\./i, /\.spec\./i];

export function assertDistIsClean(names) {
  const bad = names.filter((name) => DIST_FORBIDDEN.some((pattern) => pattern.test(name)));
  if (bad.length > 0) {
    throw new Error(`前端产物里有不该打进安装包的文件：${bad.join("、")}`);
  }
}

function listFiles(dir, io, prefix = "") {
  const entries = io.readdirSync(dir, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      names.push(...listFiles(join(dir, entry.name), io, name));
    } else {
      names.push(name);
    }
  }
  return names;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 给目录里每个安装包写一份校验和，再把整个目录按上面的规则验一遍。
 * 用 Node 算而不是 `sha256sum`：后者在 macOS runner 上不一定存在。
 */
export function writeChecksums(dir, io = { readdirSync, readFileSync, writeFileSync }) {
  const installers = io
    .readdirSync(dir)
    .filter((name) => INSTALLER_SUFFIXES.some((s) => name.endsWith(s)));
  if (installers.length === 0) {
    throw new Error(`${dir} 里没有安装包，构建多半失败了`);
  }
  const written = [];
  for (const name of installers) {
    const digest = sha256(io.readFileSync(join(dir, name)));
    io.writeFileSync(join(dir, `${name}${CHECKSUM_SUFFIX}`), `${digest}  ${name}\n`);
    written.push({ name, digest });
  }
  assertReleaseAssets(io.readdirSync(dir));
  return written;
}

function main(argv) {
  // 只看 tag 的形状，不读仓库里的版本号：工作流拿它决定发布类别。
  const kindAt = argv.indexOf("--release-kind");
  if (kindAt >= 0) {
    const kindTag = argv[kindAt + 1];
    if (!kindTag || kindTag.startsWith("--")) {
      throw new Error("--release-kind 后面要跟 tag");
    }
    console.log(releaseKind(kindTag));
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "..");
  const tauriConf = readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8");
  const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");

  const version = desktopVersion({ tauriConf, cargoToml });
  assertNothingExtraBundled(tauriConf);
  assertMacOsAdHocSigning(tauriConf);

  const assetsAt = argv.indexOf("--assets");
  if (assetsAt >= 0) {
    const dir = argv[assetsAt + 1];
    if (!dir || dir.startsWith("--")) {
      throw new Error("--assets 后面要跟目录");
    }
    if (argv.includes("--write-checksums")) {
      for (const { name, digest } of writeChecksums(dir)) {
        console.log(`${digest}  ${name}`);
      }
    } else {
      // 发布前复算一遍：artifact 传过一次，名字对不代表内容没变。
      for (const name of verifyChecksums(dir)) {
        console.log(`校验和对得上：${name}`);
      }
    }
    console.log(`桌面 ${version}：${dir} 里只有安装包和配套校验和。`);
    return;
  }

  const distAt = argv.indexOf("--dist");
  if (distAt >= 0) {
    const dir = argv[distAt + 1];
    if (!dir || dir.startsWith("--")) {
      throw new Error("--dist 后面要跟目录");
    }
    assertDistIsClean(listFiles(dir, { readdirSync }));
    console.log(`桌面 ${version}：${dir} 里没有 sourcemap、.env、测试夹具。`);
    return;
  }

  const tag = argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (tag) {
    if (tagIsPluginShaped(tag)) {
      throw new Error(`${tag} 是插件的 tag 形状，桌面要用 ${DESKTOP_TAG_PREFIX}${version}`);
    }
    assertTagMatches(tag, version);
    console.log(`桌面 ${version}：tag ${tag} 对得上，打包配置没有多余文件。`);
    return;
  }
  console.log(`桌面 ${version}：版本号一致，打包配置没有多余文件。`);
}

/**
 * 入口判断按 realpath 比：符号链接和相对路径都能对上。
 * 判断错了的后果是「什么都不做但 exit 0」，CI 照样绿——所以不能只靠字符串相等。
 */
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
    main(process.argv);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
