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

const guarded = [
  "!macro NSIS_HOOK_PREUNINSTALL",
  cleanup,
  "!macroend",
  "!macro NSIS_HOOK_POSTUNINSTALL",
  "  ${If} $UpdateMode <> 1",
  "  ${AndIf} $PassiveMode <> 1",
  "  ${AndIf} $DeleteAppDataCheckboxState = 1",
  `    MessageBox MB_YESNO "还要删掉 ${ARCHIVE_DIR} 吗？" IDYES del IDNO keep`,
  "    del:",
  `      RMDir /r "${ARCHIVE_DIR}"`,
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
    cleanup,
    `  RMDir /r "${ARCHIVE_DIR}"`,
    "!macroend",
  ].join("\n");
  assert.throws(() => assertHooks(naked), /没有单独的确认框/);
});

test("确认框里必须写清楚删的是哪个目录", () => {
  const vague = guarded.replace(`"还要删掉 ${ARCHIVE_DIR} 吗？"`, '"要删除数据吗？"');
  assert.throws(() => assertHooks(vague), /没写清楚要删的是哪个目录/);
});

test("升级和静默卸载这两条路必须排除掉", () => {
  assert.throws(() => assertHooks(guarded.replace("  ${If} $UpdateMode <> 1\n", "  ${If} 1 = 1\n")), /\$UpdateMode/);
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
