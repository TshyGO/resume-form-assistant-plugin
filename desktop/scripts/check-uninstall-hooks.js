// 卸载钩子的守卫。
//
// NSIS 脚本没法单测，但「要删哪些键、哪些文件、绝对不能删哪个目录」是一份清单，
// 清单可以验。这条检查回答的是同一个问题：**卸载会不会把用户的求职档案带走。**

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

/** 「这一段不在升级时执行」和「不在静默卸载时执行」长什么样。极性写反了不算数。 */
const SKIPS_UPDATE = /\$UpdateMode\s*<>\s*1/;
const SKIPS_PASSIVE = /\$PassiveMode\s*<>\s*1/;

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

/**
 * 去掉 `/* ... *\/` 块注释。
 *
 * 不剥的话，注释里写一句 `${If} $UpdateMode <> 1` 就能把守卫检查糊弄过去。
 * 这里不认字符串里的 `/*`——真出现了，会多删掉一些内容，然后某一行找不到、
 * 直接报错。方向是安全的。
 */
function stripBlockComments(lines) {
  const out = [];
  let inside = false;
  for (const line of lines) {
    let text = line;
    if (inside) {
      const end = text.indexOf("*" + "/");
      if (end < 0) {
        out.push("");
        continue;
      }
      text = text.slice(end + 2);
      inside = false;
    }
    for (;;) {
      const start = text.indexOf("/" + "*");
      if (start < 0) break;
      const end = text.indexOf("*" + "/", start + 2);
      if (end < 0) {
        text = text.slice(0, start);
        inside = true;
        break;
      }
      text = text.slice(0, start) + text.slice(end + 2);
    }
    out.push(text);
  }
  return out;
}

/** 把 `\` 续行拼回一行。 */
function joinContinuations(lines) {
  const joined = [];
  let buffer = null;
  for (const line of lines) {
    const text = buffer === null ? line : `${buffer} ${line.trim()}`;
    if (text.trimEnd().endsWith("\\")) {
      buffer = text.trimEnd().slice(0, -1);
      continue;
    }
    joined.push(text);
    buffer = null;
  }
  if (buffer !== null) joined.push(buffer);
  return joined;
}

/**
 * 某一行所在的宏体（从最近的 `!macro` 之后到这一行）。
 *
 * `!macroend` 也以 `!macro` 开头，所以要连空格一起比——不然宏的边界会算错，
 * 而这整套检查的前提就是「守卫必须和被守的那行在同一个宏里」。
 */
function blockOf(code, index) {
  let start = 0;
  for (let i = 0; i < index; i += 1) {
    if (/^!macro\s/.test(code[i].trim())) {
      start = i;
    }
  }
  return code.slice(start, index);
}

/**
 * 某一行真正被哪些条件包着（只在它所在的宏之内算）。
 *
 * 光看「守卫在这一行之前出现过」不够：`${EndIf}` 之后的行也满足那个说法，
 * 而它已经在守卫外面了。这里按 `${If}` / `${EndIf}` 维护一个栈，`${Else}`
 * 把当前这层的条件清掉（那正是「升级时」走的那条路），`${OrIf}` 会让整层
 * 失效——条件可以由另一半满足，守卫就不成立了。
 *
 * 只认 `${If}` 这一族。`${Unless}`、`${While}` 之类不建模：用了它们，这里会
 * 认为那一行没被守住而报错。方向是对的——宁可拦下来让人看一眼，也不要放过去。
 */
function enclosingConditions(code, index) {
  const stack = [];
  let open = null;
  for (const raw of blockOf(code, index)) {
    const line = raw.trim();
    if (/^\$\{If\}/.test(line)) {
      open = { text: line, weak: false };
      stack.push(open);
      continue;
    }
    if (open && /^\$\{AndIf\}/.test(line)) {
      open.text += `\n${line}`;
      continue;
    }
    if (open && /^\$\{OrIf\}/.test(line)) {
      open.weak = true;
      continue;
    }
    open = null;
    if (/^\$\{ElseIf\}/.test(line)) {
      const frame = stack[stack.length - 1];
      if (frame) {
        frame.text = line;
        frame.weak = false;
        open = frame;
      }
      continue;
    }
    if (/^\$\{Else\}/.test(line)) {
      const frame = stack[stack.length - 1];
      if (frame) {
        frame.text = "";
        frame.weak = false;
      }
      continue;
    }
    if (/^\$\{EndIf\}/.test(line)) {
      stack.pop();
    }
  }
  return stack;
}

/** 这一行是不是真的被某个符合 `pattern` 的条件包着。 */
function enclosedBy(code, index, pattern) {
  return enclosingConditions(code, index).some((frame) => !frame.weak && pattern.test(frame.text));
}

export function assertHooks(text) {
  // NSIS 的注释是 `;`，也接受 `#`。注释里写什么都不算数——这条检查只看会执行的行。
  //
  // 顺序要紧：先滤注释，再拼续行。反过来的话，一条以 `\` 结尾的注释会把下一行
  // 真代码并进注释里，然后整行被当注释扔掉——那一行就再也没人检查了。
  const lines = stripBlockComments(text.split(/\r?\n/)).filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith(";") && !trimmed.startsWith("#");
  });
  // NSIS 用 `\` 续行。`MessageBox` 的参数常常跨好几行，不拼起来的话
  // 「默认按钮是不是「否」」这类判断会看错行。
  const code = joinContinuations(lines);
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
  //
  // **每一条**都要单独看。只看第一条的话，把另一个键或某个清单文件挪到守卫
  // 外面，检查照样通过——那正是这类静态检查最容易被绕开的方式。
  const cleanupAt = code.findIndex((line) => line.includes("DeleteRegKey HKCU"));
  if (cleanupAt < 0) {
    throw new Error("找不到清理注册项那一段");
  }
  const cleanupLines = [
    ...REGISTRY_KEYS.map((key) => `DeleteRegKey HKCU "${key}"`),
    ...MANIFEST_FILES.map((file) => `Delete "${file}"`),
    String.raw`RMDir "${ARCHIVE_DIR}\nm"`,
  ];
  for (const needle of cleanupLines) {
    // 每一处都要看。只看第一处的话，把同一行复制一份到守卫外面就检查不出来。
    const found = code
      .map((line, index) => ({ line, index }))
      .filter((entry) => entry.line.includes(needle));
    if (found.length === 0) {
      throw new Error(`找不到这一行：${needle}`);
    }
    for (const { index } of found) {
      // 只在**同一个宏之内**、而且真的在 `${If}` 里边才算数；顺便看极性：
      // `${If} $UpdateMode = 1` 也含 `$UpdateMode`，但意思正好相反。
      if (!enclosedBy(code, index, SKIPS_UPDATE)) {
        throw new Error(`清理注册项没有避开升级（$UpdateMode）：${needle}`);
      }
    }
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
  const block = blockOf(code, removals[0].index);
  const macroStart = removals[0].index - block.length;
  const guardedBy = (needle) => block.some((line) => line.includes(needle));
  const guardedByPattern = (pattern) => enclosedBy(code, removals[0].index, pattern);

  if (!guardedBy("MessageBox")) {
    throw new Error("删档案之前没有单独的确认框");
  }
  if (!guardedByPattern(/\$DeleteAppDataCheckboxState\s*=\s*1/)) {
    throw new Error("删档案没有挂在「删除应用数据」这个选项后面");
  }
  if (!guardedByPattern(SKIPS_UPDATE)) {
    throw new Error("升级走的也是卸载器，这条路径必须排除 $UpdateMode");
  }
  if (!guardedByPattern(SKIPS_PASSIVE)) {
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
  // `MB_YESNOCANCEL` 也含 `MB_YESNO`，但它多一个「取消」；取消的返回值没人接，
  // 就会直接落到下一行——下一行正好是删除。
  if (!/MB_YESNO(?!CANCEL)/.test(confirmLine)) {
    throw new Error("确认框不是「是/否」");
  }
  if (!confirmLine.includes("MB_DEFBUTTON2")) {
    throw new Error("确认框的默认按钮不是「否」");
  }
  // 删除得落在「是」那条分支里，而不是跟在确认框后面照删不误。
  const yes = confirmLine.match(/IDYES\s+(\w+)/);
  const no = confirmLine.match(/IDNO\s+(\w+)/);
  if (!yes || !no) {
    throw new Error("删档案不在「是」那条分支里");
  }
  // 确认框紧跟着要有一行 `Goto <保留标签>`。`MB_YESNO` 文档上只返回是/否，但
  // 没被接住的返回值会顺着往下走——而往下一行正是删除。兜底成本一行。
  if ((code[confirmAt + 1] ?? "").trim() !== `Goto ${no[1]}`) {
    throw new Error("确认框后面没有兜底跳到保留分支");
  }
  // 两个标签定义在哪儿也要看。只读 `IDYES`/`IDNO` 的话，把两个标签对调一下，
  // 删除就落到「否」那条分支上，而上面每一条检查都还是绿的。
  const labelAt = (label) => code.findIndex((line) => line.trim() === `${label}:`);
  const yesAt = labelAt(yes[1]);
  const noAt = labelAt(no[1]);
  if (yesAt < 0 || noAt < 0) {
    throw new Error("确认框指向的标签没有定义");
  }
  if (!(yesAt < removals[0].index && removals[0].index < noAt)) {
    throw new Error("删档案没有落在「是」那条分支里");
  }
  // 递归删除之前要 `ClearErrors`。NSIS 的 error flag 是全局的，不清掉的话
  // 前面任何一步的残留都会让下面那句「没删干净」冤枉一次。
  if (!confirmText.includes("ClearErrors")) {
    throw new Error("递归删除之前没有 ClearErrors");
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
