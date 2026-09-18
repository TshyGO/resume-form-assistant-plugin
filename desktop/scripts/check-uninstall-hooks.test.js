import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCHIVE_DIR,
  MANIFEST_FILES,
  REGISTRY_KEYS,
  assertHooks,
  assertHooksWired,
} from "./check-uninstall-hooks.js";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");

const cleanup = [
  ...REGISTRY_KEYS.map((key) => `  DeleteRegKey HKCU "${key}"`),
  ...MANIFEST_FILES.map((file) => `  Delete "${file}"`),
].join("\n");

/** 一份合规的钩子长什么样。每条断言都是从这里挖掉一块。 */
const guarded = [
  "!macro NSIS_HOOK_PREUNINSTALL",
  "  ${If} $UpdateMode <> 1",
  cleanup,
  "  ${EndIf}",
  "!macroend",
  "!macro NSIS_HOOK_POSTUNINSTALL",
  "  ${If} $UpdateMode <> 1",
  "  ${AndIf} $PassiveMode <> 1",
  "  ${AndIf} $DeleteAppDataCheckboxState = 1",
  `    MessageBox MB_YESNO|MB_DEFBUTTON2 "还要删掉 ${ARCHIVE_DIR} 吗？" IDYES del IDNO keep`,
  "    del:",
  "      ClearErrors",
  `      RMDir /r "${ARCHIVE_DIR}"`,
  "      ${If} ${Errors}",
  '        MessageBox MB_OK "没删干净"',
  "      ${EndIf}",
  "    keep:",
  "  ${EndIf}",
  "!macroend",
].join("\n");

test("仓库里的钩子本身是合规的", () => {
  const conf = readFileSync(join(desktop, "src-tauri", "tauri.conf.json"), "utf8");
  const hooksPath = assertHooksWired(conf);
  const text = readFileSync(resolve(desktop, "src-tauri", hooksPath), "utf8");
  assert.deepEqual(assertHooks(text), { guardedRemovals: 1 });
});

test("钩子没被引进去就等于没写", () => {
  assert.throws(
    () => assertHooksWired(JSON.stringify({ bundle: { windows: { nsis: {} } } })),
    /installerHooks/,
  );
});

test("少删一个注册表键就会红——留着它，扩展会一直连一个不存在的文件", () => {
  const missing = guarded.replace(`  DeleteRegKey HKCU "${REGISTRY_KEYS[1]}"\n`, "");
  assert.throws(() => assertHooks(missing), /没有删注册表键/);
});

test("少删一份清单也会红", () => {
  const missing = guarded.replace(`  Delete "${MANIFEST_FILES[0]}"\n`, "");
  assert.throws(() => assertHooks(missing), /没有删清单文件/);
});

test("裸删档案目录直接拦住", () => {
  const naked = [
    "!macro NSIS_HOOK_PREUNINSTALL",
    "  ${If} $UpdateMode <> 1",
    cleanup,
    `  RMDir /r "${ARCHIVE_DIR}"`,
    "  ${EndIf}",
    "!macroend",
  ].join("\n");
  assert.throws(() => assertHooks(naked), /没有单独的确认框/);
});

test("升级时清理注册项会把扩展连接弄断，所以那一段也得避开 $UpdateMode", () => {
  // 升级走的也是卸载器：删了注册项，新版本重写清单之前浏览器就连不上。
  const unguarded = guarded.replace(
    "!macro NSIS_HOOK_PREUNINSTALL\n  ${If} $UpdateMode <> 1\n",
    "!macro NSIS_HOOK_PREUNINSTALL\n",
  );
  assert.throws(() => assertHooks(unguarded), /清理注册项没有避开升级/);
});

test("确认框必须是「是/否」且默认落在「否」上", () => {
  const noDefault = guarded.replace("MB_YESNO|MB_DEFBUTTON2", "MB_YESNO");
  assert.throws(() => assertHooks(noDefault), /默认按钮不是「否」/);
  const notYesNo = guarded.replace("MB_YESNO|MB_DEFBUTTON2", "MB_OK");
  assert.throws(() => assertHooks(notYesNo), /不是「是\/否」/);
});

test("删除必须落在「是」那条分支里", () => {
  const noBranch = guarded.replace(" IDYES del IDNO keep", "");
  assert.throws(() => assertHooks(noBranch), /不在「是」那条分支里/);
});

test("删一半要说出来，不能让用户以为清干净了", () => {
  const silent = guarded
    .replace("      ${If} ${Errors}\n", "")
    .replace('        MessageBox MB_OK "没删干净"\n', "")
    .replace("      ${EndIf}\n    keep:", "    keep:");
  assert.throws(() => assertHooks(silent), /没有检查是否删干净/);
});

test("确认框里必须写清楚删的是哪个目录", () => {
  const vague = guarded.replace(`"还要删掉 ${ARCHIVE_DIR} 吗？"`, '"要删除数据吗？"');
  assert.throws(() => assertHooks(vague), /没写清楚要删的是哪个目录/);
});

test("升级和静默卸载这两条路必须排除掉", () => {
  // 两个宏里各有一处 $UpdateMode，这里换掉删档案那一段的那处。
  const noUpdateGuard = guarded.replace(
    "!macro NSIS_HOOK_POSTUNINSTALL\n  ${If} $UpdateMode <> 1",
    "!macro NSIS_HOOK_POSTUNINSTALL\n  ${If} 1 = 1",
  );
  assert.throws(() => assertHooks(noUpdateGuard), /\$UpdateMode/);
  assert.throws(
    () => assertHooks(guarded.replace("  ${AndIf} $PassiveMode <> 1\n", "")),
    /\$PassiveMode/,
  );
  assert.throws(
    () => assertHooks(guarded.replace("  ${AndIf} $DeleteAppDataCheckboxState = 1\n", "")),
    /删除应用数据/,
  );
});

test("注释里提到档案目录不算数——只看会执行的那几行", () => {
  const commented = [
    "; 这里说一句 RMDir /r \"$LOCALAPPDATA\\ResumePro\" 只是举例",
    "# NSIS 也认 # 开头的注释",
    "#   RMDir /r \"$LOCALAPPDATA\\ResumePro\"",
    guarded,
  ].join("\n");
  assert.deepEqual(assertHooks(commented), { guardedRemovals: 1 });
});

test("删两次说不清哪一次是用户同意的", () => {
  const twice = guarded.replace(
    `      RMDir /r "${ARCHIVE_DIR}"`,
    `      RMDir /r "${ARCHIVE_DIR}"\n      RMDir /r "${ARCHIVE_DIR}"`,
  );
  assert.throws(() => assertHooks(twice), /不止一次/);
});

test("守卫写在宏外面不算数——`!macroend` 也以 !macro 开头，边界得算准", () => {
  // 把 $UpdateMode 挪到清理注册项那个宏的外面，检查必须红。
  const outside = guarded.replace(
    "!macro NSIS_HOOK_PREUNINSTALL\n  ${If} $UpdateMode <> 1\n",
    "${If} $UpdateMode <> 1\n!macro NSIS_HOOK_PREUNINSTALL\n",
  );
  assert.throws(() => assertHooks(outside), /清理注册项没有避开升级/);
});

test("MessageBox 续行时，默认按钮那一段也要认出来", () => {
  // NSIS 的续行符是一个反斜杠；这里避开在源码里再转义一层。
  const continuation = String.fromCharCode(92);
  const wrapped = guarded.replace(
    `    MessageBox MB_YESNO|MB_DEFBUTTON2 "还要删掉 ${ARCHIVE_DIR} 吗？" IDYES del IDNO keep`,
    [
      `    MessageBox MB_YESNO|MB_DEFBUTTON2 ${continuation}`,
      `      "还要删掉 ${ARCHIVE_DIR} 吗？" ${continuation}`,
      "      IDYES del IDNO keep",
    ].join("\n"),
  );
  assert.deepEqual(assertHooks(wrapped), { guardedRemovals: 1 });
});

test("完全没有清理注册项那一段时说得出是缺了什么", () => {
  const empty = ["!macro NSIS_HOOK_PREUNINSTALL", "!macroend"].join("\n");
  assert.throws(() => assertHooks(empty), /没有删注册表键/);
});
