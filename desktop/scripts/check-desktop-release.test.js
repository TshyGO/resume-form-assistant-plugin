import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_TAG_PREFIX,
  assertNothingExtraBundled,
  assertReleaseAssets,
  assertTagMatches,
  desktopVersion,
  tagIsPluginShaped,
} from "./check-desktop-release.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const desktop = resolve(here, "..");

const conf = (version, bundle = {}) => JSON.stringify({ version, bundle });

test("版本号对不上就发不出去", () => {
  assert.equal(
    desktopVersion({ tauriConf: conf("0.2.0"), cargoToml: 'name = "x"\nversion = "0.2.0"\n' }),
    "0.2.0",
  );
  assert.throws(
    () => desktopVersion({ tauriConf: conf("0.2.0"), cargoToml: 'version = "0.1.0"\n' }),
    /对不上/,
  );
});

test("tag 必须是 desktop-v<版本号>", () => {
  assertTagMatches("desktop-v0.2.0", "0.2.0");
  assert.throws(() => assertTagMatches("v0.2.0", "0.2.0"), /desktop-v/);
  assert.throws(() => assertTagMatches("desktop-v0.2.1", "0.2.0"), /但版本号是/);
});

test("桌面的 tag 不能长成插件那个样子——一次发版不该顺手发两个包", () => {
  assert.equal(tagIsPluginShaped("v0.4.0"), true);
  assert.equal(tagIsPluginShaped("desktop-v0.1.0"), false);
});

test("打包配置里不许夹带文件", () => {
  assertNothingExtraBundled(conf("0.1.0"));
  assertNothingExtraBundled(conf("0.1.0", { targets: "all" }));
  assert.throws(() => assertNothingExtraBundled(conf("0.1.0", { resources: ["fixtures/"] })), /额外文件/);
  assert.throws(() => assertNothingExtraBundled(conf("0.1.0", { externalBin: ["sidecar"] })), /额外文件/);
});

test("Release 只收安装包和校验值", () => {
  assertReleaseAssets(["Resume Pro Desktop_0.1.0_x64-setup.exe", "SHA256SUMS.sha256"]);
  assert.throws(() => assertReleaseAssets([]), /一个资产都没有/);
  assert.throws(() => assertReleaseAssets(["resume-pro-desktop.pdb"]), /不该作为 Release 资产/);
  assert.throws(() => assertReleaseAssets(["archive.db"]), /不该作为 Release 资产/);
});

test("仓库现在的配置本身就是合规的", () => {
  const tauriConf = readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8");
  const cargoToml = readFileSync(join(desktop, "src-tauri", "Cargo.toml"), "utf8");
  const version = desktopVersion({ tauriConf, cargoToml });
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assertNothingExtraBundled(tauriConf);
});

test("两个 release 工作流的 tag 触发条件不重叠", () => {
  const plugin = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");
  const desktopFlow = readFileSync(join(repo, ".github", "workflows", "desktop-release.yml"), "utf8");
  assert.match(plugin, /tags:\s*\n\s*-\s*'v\*\.\*\.\*'/);
  assert.match(desktopFlow, new RegExp(`tags:\\s*\\n\\s*-\\s*['"]${DESKTOP_TAG_PREFIX}\\*['"]`));
  // 插件那条 glob 匹配不到桌面的 tag：`v*.*.*` 要求以 v 开头。
  assert.equal(tagIsPluginShaped(`${DESKTOP_TAG_PREFIX}0.1.0`), false);
});

test("发版工作流自己也要跑这个检查，并且不上传别的东西", () => {
  const flow = readFileSync(join(repo, ".github", "workflows", "desktop-release.yml"), "utf8");
  assert.match(flow, /check-desktop-release\.js/);
  // 未签名这件事必须写在 Release 说明里，不能等用户自己撞上 SmartScreen。
  assert.match(flow, /未签名/);
  assert.match(flow, /sha256|SHA256/i);
});
