// 桌面发版前的三件事：版本号一致、tag 归位、包里没有多余东西。
//
// 逻辑放在这里而不是 YAML 里，是为了本地能跑、也能被测试盯住：
//
//   node desktop/scripts/check-desktop-release.js desktop-v0.1.0
//
// 不给 tag 就只查版本号一致性和打包配置。

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 桌面的 tag 前缀。插件用的是 `v*.*.*`，两边不能撞。 */
export const DESKTOP_TAG_PREFIX = "desktop-v";

/** 只有这些后缀能作为 Release 资产上传。 */
export const RELEASE_ASSET_SUFFIXES = [".exe", ".dmg", ".sha256"];

/**
 * 三处版本号必须一样：`tauri.conf.json` 决定安装包文件名和「关于」页，
 * `Cargo.toml` 决定二进制自己报的版本。对不上时用户看到的版本取决于他看哪里。
 */
export function desktopVersion({ tauriConf, cargoToml }) {
  const fromConf = JSON.parse(tauriConf).version;
  const match = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargoToml);
  const fromCargo = match?.[1];
  if (!fromConf || !fromCargo) {
    throw new Error("读不出版本号：tauri.conf.json 或 Cargo.toml 里没有 version");
  }
  if (fromConf !== fromCargo) {
    throw new Error(`版本号对不上：tauri.conf.json 是 ${fromConf}，Cargo.toml 是 ${fromCargo}`);
  }
  return fromConf;
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
 * 插件的 release 工作流按 `v*.*.*` 触发。桌面的 tag 必须落在它之外，
 * 否则一次桌面发版会顺手发一个插件包出去。
 */
export function tagIsPluginShaped(tag) {
  return /^v\d+\.\d+\.\d+$/.test(tag);
}

/**
 * 打包配置里不许出现「顺手带上的文件」。`resources` / `externalBin` 一旦有值，
 * 安装包里就会多出仓库里的东西，而那正是「不含测试数据、调试 profile」这条验收
 * 最容易破的地方。
 */
export function assertNothingExtraBundled(tauriConf) {
  const bundle = JSON.parse(tauriConf).bundle ?? {};
  const extras = ["resources", "externalBin", "files"].filter((key) => {
    const value = bundle[key];
    return Array.isArray(value) ? value.length > 0 : value && Object.keys(value).length > 0;
  });
  if (extras.length > 0) {
    throw new Error(
      `bundle 里带了额外文件（${extras.join("、")}）。要加东西进安装包，先在 D13 的计划里写明白为什么。`,
    );
  }
}

/** Release 只上传安装包和它的校验值，别把整个 target 目录传上去。 */
export function assertReleaseAssets(names) {
  const bad = names.filter((name) => !RELEASE_ASSET_SUFFIXES.some((s) => name.endsWith(s)));
  if (bad.length > 0) {
    throw new Error(`这些文件不该作为 Release 资产上传：${bad.join("、")}`);
  }
  if (names.length === 0) {
    throw new Error("一个资产都没有，构建多半失败了");
  }
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "..");
  const tauriConf = readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8");
  const cargoToml = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");

  const version = desktopVersion({ tauriConf, cargoToml });
  assertNothingExtraBundled(tauriConf);

  const tag = argv[2];
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

// 路径里有空格和盘符，拼字符串比较会在 Windows 上悄悄失效（试过了，什么都不会跑）。
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
