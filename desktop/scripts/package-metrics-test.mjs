import { cpSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { packPlugin } from './pack-plugin.js';

// Bundles only an explicit isolated acceptance binary and a staged plugin copy.
// Does not publish, install, touch profiles or carry tokens/cloud management credentials.
const root = fileURLToPath(new URL('../..', import.meta.url));
const [platform, binaryInput, destinationInput] = process.argv.slice(2);
if (!['macos-arm64', 'windows-x64'].includes(platform) || !binaryInput || !destinationInput) {
  throw new Error('Usage: package-metrics-test.mjs macos-arm64|windows-x64 binary-or-app output-directory');
}
const destination = resolve(destinationInput);
mkdirSync(destination, { recursive: true });
const input = resolve(binaryInput);
if (!statSync(input)) throw new Error('Acceptance binary missing');
const name = platform === 'macos-arm64' ? 'Resume Metrics Test.app' : 'resume-pro-desktop.exe';
cpSync(input, join(destination, name), { recursive: true });
const pluginZip = join(destination, 'plugin-original.zip');
packPlugin(root, pluginZip);
const python = process.platform === 'win32' ? 'python' : 'python3';
execFileSync(python, ['-c', 'import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', pluginZip, join(destination, 'plugin')]);
const plugin = join(destination, 'plugin');
const transport = join(plugin, 'link/transport.mjs');
const original = readFileSync(transport, 'utf8');
if (original.split("'com.resumepro.desktop'").length !== 2) throw new Error('Unexpected Native Messaging host constant');
writeFileSync(transport, original.replace("'com.resumepro.desktop'", "'com.resumepro.metrics.test'"));
const background = join(plugin, 'background.js');
const backgroundSource = readFileSync(background, 'utf8');
if (backgroundSource.split('installFeedback(chrome);').length !== 2) throw new Error('Unexpected feedback bootstrap');
writeFileSync(background, backgroundSource.replace('installFeedback(chrome);', '// Feedback disabled in the isolated statistics acceptance package.'));
const manifestPath = join(plugin, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.name = '网申快填统计测试（仅虚构数据）';
manifest.description = '统计验收专用插件：仅在独立测试浏览器中加载，不用于真实求职资料。';
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const artifact = platform === 'macos-arm64' ? join(destination, name, 'Contents/MacOS/resume-pro-desktop') : join(destination, name);
const runtimeInfo = JSON.parse(execFileSync(artifact, ['--probe', '--metrics-test-info'], { encoding: 'utf8', timeout: 20_000 }));
if (runtimeInfo.purpose !== 'isolated-usage-metrics-acceptance'
    || runtimeInfo.identifier !== 'com.resumepro.metrics.acceptance'
    || runtimeInfo.native_host !== 'com.resumepro.metrics.test'
    || runtimeInfo.data_root_isolated !== true || runtimeInfo.feedback_disabled !== true
    || runtimeInfo.endpoint !== 'https://resume-usage-metrics-test.nebula-lab.workers.dev/v1/activity') {
  throw new Error('Binary is not the isolated TEST acceptance build; package refused');
}
const sha256 = value => createHash('sha256').update(value).digest('hex');
writeFileSync(join(destination, 'build-receipt.json'), JSON.stringify({
  source_commit: commit, platform, desktop_version: '0.4.2',
  identifier: 'com.resumepro.metrics.acceptance', native_host: 'com.resumepro.metrics.test',
  desktop_binary_sha256: sha256(readFileSync(artifact)), plugin_original_sha256: sha256(readFileSync(pluginZip)),
  plugin_staged_changes: ['manifest name/description', 'Native Messaging host', 'feedback bootstrap disabled'],
  endpoint: 'https://resume-usage-metrics-test.nebula-lab.workers.dev/v1/activity',
  test_only: true, no_secret_in_artifacts: true,
}, null, 2));
// Keep only the adapted test plugin in the deliverable, avoiding two similar ZIP choices.
rmSync(pluginZip);
writeFileSync(join(destination, '打开测试版.command'), '#!/bin/sh\ncd "$(dirname "$0")"\nexec "./Resume Metrics Test.app/Contents/MacOS/resume-pro-desktop"\n', { mode: 0o755 });
writeFileSync(join(destination, '打开测试版.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0resume-pro-desktop.exe"\r\n');
for (const [label, app, folder] of [['Chrome', 'Google Chrome', 'chrome'], ['Edge', 'Microsoft Edge', 'edge']]) {
  writeFileSync(join(destination, `打开${label}测试.command`), `#!/bin/sh\nprofile="$HOME/Library/Application Support/ResumeProUsageMetricsTest/${folder}-profile"\nmkdir -p "$profile/NativeMessagingHosts" || exit 1\nmanifest="$HOME/Library/Application Support/${folder === 'chrome' ? 'Google/Chrome' : 'Microsoft Edge'}/NativeMessagingHosts/com.resumepro.metrics.test.json"\nif [ ! -f "$manifest" ]; then\n  echo "请先打开测试版，再运行浏览器启动文件。"\n  exit 1\nfi\ncp "$manifest" "$profile/NativeMessagingHosts/com.resumepro.metrics.test.json" || exit 1\nopen -na "/Applications/${app}.app" --args --user-data-dir="$profile" --no-first-run --no-default-browser-check "${folder === 'chrome' ? 'chrome' : 'edge'}://extensions"\n`, { mode: 0o755 });
  const paths = folder === 'chrome'
    ? ['%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe', '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe', '%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe']
    : ['%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe', '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe'];
  writeFileSync(join(destination, `打开${label}测试.cmd`), `@echo off\r\nset "browser="\r\n${paths.map(path => `if exist "${path}" set "browser=${path}"`).join('\r\n')}\r\nif not defined browser (echo Browser not found & pause & exit /b 1)\r\nstart "" "%browser%" --user-data-dir="%LOCALAPPDATA%\\ResumeProUsageMetricsTest\\${folder}-profile" --no-first-run --no-default-browser-check "${folder === 'chrome' ? 'chrome' : 'edge'}://extensions"\r\n`);
}
writeFileSync(join(destination, '请先阅读.txt'), `统计验收专用包，源提交 ${commit}。\n仅使用虚构资料，禁止导入真实简历或正式备份。\n数据保存在独立 ResumeProUsageMetricsTest/usage-metrics-test-data，不读写正常 ResumePro。\nMac 双击“打开测试版.command”，Windows 双击“打开测试版.cmd”，查看窗口标题“网申快填统计测试”。\n浏览器请创建独立测试用户目录后，在扩展管理页面加载本包 plugin 文件夹。不要在日常浏览器配置中覆盖正式插件。\n测试版只连接 com.resumepro.metrics.test；自动错误反馈已禁用。\n测试云端需要由维护者在联调窗口开启；默认关闭时采集可能失败，正常功能不受影响。\n本包不是正式发行，未声称 Windows/macOS 真机验收通过。\n`);
const zip = join(destination, '..', `usage-metrics-test-${platform}.zip`);
// Archive executable modes before Actions uploads; folder artifacts lose Unix modes.
execFileSync(python, ['-c', 'import sys,pathlib,zipfile;root=pathlib.Path(sys.argv[1]);z=zipfile.ZipFile(sys.argv[2],"w",zipfile.ZIP_DEFLATED);[(z.write(p,p.relative_to(root))) for p in sorted(root.rglob("*")) if p.is_file()];z.close()', destination, zip]);
console.log(`Prepared isolated ${platform} package at ${zip}`);
