import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DESKTOP_TAG_PREFIX,
  assertDistIsClean,
  verifyChecksums,
  assertNothingExtraBundled,
  assertReleaseAssets,
  assertTagMatches,
  desktopVersion,
  packageVersion,
  sha256,
  tagIsPluginShaped,
  writeChecksums,
} from "./check-desktop-release.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const desktop = resolve(here, "..");
const script = join(here, "check-desktop-release.js");

/** Windows 上 checkout 会把换行变成 CRLF，正则里的换行符就对不上了。 */
const readText = (path) => readFileSync(path, "utf8").split("\r\n").join("\n");

const conf = (version, overrides = {}) =>
  JSON.stringify({ version, build: { frontendDist: "../dist" }, bundle: {}, ...overrides });

test("版本号对不上就发不出去", () => {
  assert.equal(
    desktopVersion({ tauriConf: conf("0.2.0"), cargoToml: '[package]\nversion = "0.2.0"\n' }),
    "0.2.0",
  );
  assert.throws(
    () => desktopVersion({ tauriConf: conf("0.2.0"), cargoToml: '[package]\nversion = "0.1.0"\n' }),
    /对不上/,
  );
});

test("版本号只从 [package] 段取，依赖项排在前面也不会取错", () => {
  const cargo = [
    "[dependencies]",
    'serde = { version = "1", features = ["derive"] }',
    'regex = "1"',
    "",
    "[package]",
    'name = "resume-pro-desktop"',
    'version = "0.3.1"',
  ].join("\n");
  assert.equal(packageVersion(cargo), "0.3.1");
});

test("预发布版本号暂时不放行——怎么发还没定", () => {
  assert.throws(
    () =>
      desktopVersion({
        tauriConf: conf("0.2.0-beta.1"),
        cargoToml: '[package]\nversion = "0.2.0-beta.1"\n',
      }),
    /1\.2\.3/,
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

test("打包配置里不许夹带文件，前端产物也得指向构建输出", () => {
  assertNothingExtraBundled(conf("0.1.0"));
  assert.throws(
    () => assertNothingExtraBundled(conf("0.1.0", { bundle: { resources: ["fixtures/"] } })),
    /额外文件/,
  );
  assert.throws(
    () => assertNothingExtraBundled(conf("0.1.0", { bundle: { externalBin: ["sidecar"] } })),
    /额外文件/,
  );
  assert.throws(
    () => assertNothingExtraBundled(conf("0.1.0", { build: { frontendDist: "../src" } })),
    /frontendDist/,
  );
});

test("上传的东西必须是安装包 + 一一配套的校验和", () => {
  assertReleaseAssets(["a_0.1.0_x64-setup.exe", "a_0.1.0_x64-setup.exe.sha256"]);
  assert.throws(() => assertReleaseAssets([]), /一个资产都没有/);
  assert.throws(() => assertReleaseAssets(["resume-pro-desktop.pdb"]), /不该作为 Release 资产/);
  assert.throws(() => assertReleaseAssets(["archive.db"]), /不该作为 Release 资产/);
  // 少一个校验和，用户就没法核对下到的东西。
  assert.throws(() => assertReleaseAssets(["setup.exe"]), /没有配套的校验和/);
  // 校验和对不上任何安装包，多半是上一次构建留下的。
  assert.throws(
    () => assertReleaseAssets(["setup.exe", "setup.exe.sha256", "old.dmg.sha256"]),
    /没有对应的安装包/,
  );
});

test("校验和由 Node 算出来，写完顺手把目录验一遍", () => {
  const dir = mkdtempSync(join(tmpdir(), "d13-assets-"));
  writeFileSync(join(dir, "setup.exe"), "安装包内容");
  const written = writeChecksums(dir);

  assert.equal(written.length, 1);
  const text = readFileSync(join(dir, "setup.exe.sha256"), "utf8");
  assert.match(text, new RegExp(`^${sha256(Buffer.from("安装包内容"))}  setup\\.exe`));
});

test("目录里混进别的东西时，写校验和这一步就会拦住", () => {
  const dir = mkdtempSync(join(tmpdir(), "d13-assets-"));
  writeFileSync(join(dir, "setup.exe"), "x");
  writeFileSync(join(dir, "resume-pro-desktop.pdb"), "调试符号");
  assert.throws(() => writeChecksums(dir), /不该作为 Release 资产/);
});

test("空目录不会被当成成功", () => {
  const dir = mkdtempSync(join(tmpdir(), "d13-assets-"));
  assert.throws(() => writeChecksums(dir), /没有安装包/);
});

test("命令行真的会跑起来——入口判断错了的话这几条会静默通过", () => {
  // 版本号从仓库里读，别写死：升个版本不该让 CI 变红，报错还长得像管道坏了。
  const version = desktopVersion({
    tauriConf: readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8"),
    cargoToml: readFileSync(join(desktop, "src-tauri", "Cargo.toml"), "utf8"),
  });
  const tag = `${DESKTOP_TAG_PREFIX}${version}`;
  const ok = execFileSync("node", [script, tag], { encoding: "utf8" });
  assert.match(ok, new RegExp(`tag ${tag.replace(/\./g, "\.")} 对得上`));

  const plain = execFileSync("node", [script], { encoding: "utf8" });
  assert.match(plain, /版本号一致/);

  assert.throws(
    () => execFileSync("node", [script, "v0.1.0"], { encoding: "utf8", stdio: "pipe" }),
    /Command failed/,
  );

  const dir = mkdtempSync(join(tmpdir(), "d13-assets-"));
  writeFileSync(join(dir, "setup.exe"), "x");
  const assets = execFileSync("node", [script, "--assets", dir, "--write-checksums"], {
    encoding: "utf8",
  });
  assert.match(assets, /只有安装包和配套校验和/);
  assert.deepEqual(readdirSync(dir).sort(), ["setup.exe", "setup.exe.sha256"]);
});

test("仓库现在的配置本身就是合规的", () => {
  const tauriConf = readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8");
  const cargoToml = readFileSync(join(desktop, "src-tauri", "Cargo.toml"), "utf8");
  const version = desktopVersion({ tauriConf, cargoToml });
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assertNothingExtraBundled(tauriConf);
});

test("两个 release 工作流的 tag 触发条件不重叠", () => {
  const plugin = readText(join(repo, ".github", "workflows", "release.yml"));
  const desktopFlow = readText(join(repo, ".github", "workflows", "desktop-release.yml"));
  assert.match(plugin, /tags:\s*\n\s*-\s*['"]v\*\.\*\.\*['"]/);
  assert.match(desktopFlow, new RegExp(`tags:\\s*\\n\\s*-\\s*['"]${DESKTOP_TAG_PREFIX}\\*['"]`));
  assert.equal(tagIsPluginShaped(`${DESKTOP_TAG_PREFIX}0.1.0`), false);
});

test("发版工作流自己也要跑这个检查，并且把该说的话说清楚", () => {
  const flow = readText(join(repo, ".github", "workflows", "desktop-release.yml"));
  // 资产校验必须真的接进流程，不能只活在单测里。
  assert.match(flow, /--assets dist-release --write-checksums/);
  assert.match(flow, /--assets dist-release\n/);
  assert.match(flow, /未签名/);
  // tag 名要走 env，不能直接插值进 run：那等于把 ref 名当 shell 代码执行。
  assert.doesNotMatch(flow, /run: node desktop\/scripts\/check-desktop-release\.js "\$\{\{/);
  assert.match(flow, /TAG: \$\{\{ github\.ref_type/);
  // 拿着 contents: write 的那一步不引第三方 action。
  assert.doesNotMatch(flow, /softprops\/action-gh-release/);
});

test("发布前复算校验和：名字对不代表内容没变", () => {
  const dir = mkdtempSync(join(tmpdir(), "d13-assets-"));
  writeFileSync(join(dir, "setup.exe"), "真正的安装包");
  writeChecksums(dir);
  assert.deepEqual(verifyChecksums(dir), ["setup.exe"]);

  // artifact 传输过程中被换掉的样子。
  writeFileSync(join(dir, "setup.exe"), "被换掉的内容");
  assert.throws(() => verifyChecksums(dir), /校验和对不上/);
});

test("前端产物里不许有 sourcemap、.env 和测试夹具", () => {
  assertDistIsClean(["index.html", "assets/index-abc.js", "assets/index-abc.css"]);
  assert.throws(() => assertDistIsClean(["assets/index.js.map"]), /不该打进安装包/);
  assert.throws(() => assertDistIsClean([".env.production"]), /不该打进安装包/);
  assert.throws(() => assertDistIsClean(["fixtures/简历.docx"]), /不该打进安装包/);
  assert.throws(() => assertDistIsClean(["assets/app.test.js"]), /不该打进安装包/);
});

test("Release 说明不能同时用 --notes-file 和 --generate-notes", () => {
  // 两个一起给，要么命令失败，要么自动生成的内容把「未签名」那段盖掉。
  const flow = readText(join(repo, ".github", "workflows", "desktop-release.yml"));
  const createBlock = flow.slice(flow.indexOf("gh release create"));
  assert.doesNotMatch(createBlock, /--generate-notes/);
  assert.match(createBlock, /--notes-file release-notes\.md/);
  // 自动变更记录仍然要有，只是拼进同一个文件。
  assert.match(flow, /releases\/generate-notes/);
  assert.doesNotMatch(
    flow,
    /releases\/generate-notes[\s\S]*?\|\|\s*true/,
    "自动发布说明生成失败时必须阻止发布，不能静默吞掉错误",
  );
});

test("发版工作流会拦住过期的 Cargo.lock 和脏 dist", () => {
  const flow = readText(join(repo, ".github", "workflows", "desktop-release.yml"));
  assert.match(flow, /cargo fetch --locked/);
  assert.match(flow, /--dist desktop\/dist/);
  assert.match(flow, /d13_install_acceptance\.ps1[\s\S]*?-Installer/);
  assert.match(flow, /if: matrix\.name == 'windows-x64'/);
  assert.match(flow, /AllowElevatedDiagnostic/);
  assert.match(flow, /not acceptance/);
});

test("安装验收失败也会清理本轮安装，并给早退进程可操作的错误", () => {
  const acceptance = readText(join(desktop, "scripts", "d13_install_acceptance.ps1"));
  assert.match(acceptance, /\$installedThisRun = \$false/);
  assert.match(acceptance, /\$installedThisRun = \$true/);
  assert.match(acceptance, /exited before Native Messaging registration/);
  assert.match(acceptance, /Upgraded application exited before Native Messaging registration/);
  assert.match(acceptance, /if \(\$installedThisRun -and \(Test-Path -LiteralPath \$installDir\)\)/);
  assert.match(acceptance, /\$cleanupUninstaller/);
  assert.match(acceptance, /AcceptanceEligible = -not \$runningElevated/);
  assert.match(acceptance, /ELEVATED_DIAGNOSTIC/);
});
