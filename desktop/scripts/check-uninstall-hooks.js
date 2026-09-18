// 卸载钩子的守卫。
//
// NSIS 脚本没法单测，但「要删哪些键、哪些文件、绝对不能删哪个目录」是一份清单，
// 清单可以验。这条检查回答的是同一个问题：**卸载会不会把用户的求职档案带走。**

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

/** 卸载必须删掉的注册表键：留着就是指向不存在文件的死注册。 */
export const REGISTRY_KEYS = [
  String.raw`Software\Google\Chrome\NativeMessagingHosts\com.resumepro.desktop`,
  String.raw`Software\Microsoft\Edge\NativeMessagingHosts\com.resumepro.desktop`,
];

/** 我们写进数据目录的清单文件，卸载时一并删。 */
export const MANIFEST_FILES = [
  String.raw`$LOCALAPPDATA\ResumePro\nm\chrome-com.resumepro.desktop.json`,
  String.raw`$LOCALAPPDATA\ResumePro\nm\edge-com.resumepro.desktop.json`,
  String.raw`$LOCALAPPDATA\ResumePro\nm\receipt.json`,
];

/** 用户的求职档案。默认一个字节都不能动。 */
export const ARCHIVE_DIR = String.raw`$LOCALAPPDATA\ResumePro`;

export function assertHooks(text) {
  const lines = text.split(/\r?\n/);
  // NSIS 的注释是 `;`，也接受 `#`。注释里写什么都不算数——这条检查只看会执行的行。
  const code = lines.filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith(";") && !trimmed.startsWith("#");
  });
  const body = code.join("\n");

  for (const key of REGISTRY_KEYS) {
    if (!body.includes(`DeleteRegKey HKCU "${key}"`)) {
      throw new Error(`卸载没有删注册表键：${key}`);
    }
  }
  for (const file of MANIFEST_FILES) {
    if (!body.includes(`Delete "${file}"`)) {
      throw new Error(`卸载没有删清单文件：${file}`);
    }
  }

  // 清理注册项这一段也要避开升级。升级走的也是卸载器：那时候删了注册项，
  // 新版本装好、启动、重写清单之前，浏览器就连不上；升级中断在中间更糟。
  const cleanupAt = code.findIndex((line) => line.includes("DeleteRegKey HKCU"));
  const updateGuardedCleanup = code
    .slice(0, cleanupAt)
    .some((line) => line.includes("$UpdateMode"));
  if (!updateGuardedCleanup) {
    throw new Error("清理注册项没有避开升级（$UpdateMode）");
  }

  // 档案目录只允许出现在一处递归删除里，而且必须排在确认框后面。
  const removals = code
    .map((line, index) => ({ line: line.trim(), index }))
    .filter((entry) => /^RMDir\s+\/r/.test(entry.line) && entry.line.includes(ARCHIVE_DIR));
  if (removals.length === 0) {
    return { guardedRemovals: 0 };
  }
  if (removals.length > 1) {
    throw new Error("档案目录被递归删除了不止一次，说不清哪一次是用户同意的");
  }

  // 只看**删档案那个宏之内**的条件。整份文件里搜 `$UpdateMode` 会搜到清理注册项
  // 那一段的守卫，于是删档案这边漏了守卫也照样通过——那正是这条检查要防的事。
  const macroStart = code
    .slice(0, removals[0].index)
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.trim().startsWith("!macro"))
    .map((entry) => entry.index)
    .pop();
  const block = code.slice(macroStart ?? 0, removals[0].index);
  const guardedBy = (needle) => block.some((line) => line.includes(needle));

  if (!guardedBy("MessageBox")) {
    throw new Error("删档案之前没有单独的确认框");
  }
  if (!guardedBy("$DeleteAppDataCheckboxState")) {
    throw new Error("删档案没有挂在「删除应用数据」这个选项后面");
  }
  if (!guardedBy("$UpdateMode")) {
    throw new Error("升级走的也是卸载器，这条路径必须排除 $UpdateMode");
  }
  if (!guardedBy("$PassiveMode")) {
    throw new Error("静默卸载时没人能确认，必须排除 $PassiveMode");
  }
  const confirmAt =
    (macroStart ?? 0) + block.findIndex((line) => line.includes("MessageBox"));
  // 确认框里要写清楚删的是哪个目录，不能只说「删除数据吗」。
  const confirmText = code.slice(confirmAt, removals[0].index).join("\n");
  if (!confirmText.includes(ARCHIVE_DIR)) {
    throw new Error("确认框里没写清楚要删的是哪个目录");
  }
  // 必须是「是/否」，而且默认落在「否」上：默认按钮是「是」的话，一路回车
  // 就把档案删了。
  const confirmLine = code[confirmAt];
  if (!confirmLine.includes("MB_YESNO")) {
    throw new Error("确认框不是「是/否」");
  }
  if (!confirmLine.includes("MB_DEFBUTTON2")) {
    throw new Error("确认框的默认按钮不是「否」");
  }
  // 删除得落在「是」那条分支里，而不是跟在确认框后面照删不误。
  if (!confirmText.match(/IDYES\s+\w+/)) {
    throw new Error("删档案不在「是」那条分支里");
  }
  // 删一半（文件被占用、杀毒软件在扫）要说出来，不能让用户以为清干净了。
  const endIfAfter = code.slice(removals[0].index).findIndex((line) => line.includes("${EndIf}"));
  if (endIfAfter < 0) {
    throw new Error("删档案那段没有收在条件块里");
  }
  const afterRemoval = code.slice(removals[0].index, removals[0].index + endIfAfter).join("\n");
  if (!afterRemoval.includes("${Errors}")) {
    throw new Error("递归删除之后没有检查是否删干净");
  }
  return { guardedRemovals: removals.length };
}

/** 钩子要真的被引进去，不然写了等于没写。 */
export function assertHooksWired(tauriConf) {
  const nsis = JSON.parse(tauriConf).bundle?.windows?.nsis ?? {};
  if (!nsis.installerHooks) {
    throw new Error("tauri.conf.json 没有引入 installerHooks");
  }
  return nsis.installerHooks;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, "..");
  const conf = readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8");
  const hooksPath = assertHooksWired(conf);
  const text = readFileSync(resolve(root, "src-tauri", hooksPath), "utf8");
  const { guardedRemovals } = assertHooks(text);
  console.log(
    guardedRemovals === 0
      ? "卸载钩子：清注册项、留档案，没有任何删档案的路径。"
      : "卸载钩子：清注册项；删档案那条路挂在单独的确认框后面。",
  );
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
    main();
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
}
