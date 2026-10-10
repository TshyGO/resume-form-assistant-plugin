import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeStatus } from "./api.ts";
import {
  AFTER_INSTALL_HINT,
  CONFLICT_HINT,
  STORE_PENDING_HINT,
  describeLink,
  describeProtocolMismatch,
  describeRegistration,
  registrationCompleted,
} from "./browser-link.ts";

const status = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus =>
  ({
    nativeMessagingRegistered: false,
    ...overrides,
  }) as RuntimeStatus;

test("还没核对过时不说「未连接」，安装入口仍然在", () => {
  const state = describeLink(status());
  assert.equal(state.status, "尚未核对注册");
  assert.match(state.next, /还没核对过/);
  assert.equal(state.showRetry, true);
  assert.equal(state.showInstall, true);
});

test("两个浏览器都注册好了就请用户去装扩展", () => {
  const state = describeLink(
    status({
      nativeMessagingRegistered: true,
      nativeMessaging: [
        { browser: "chrome", label: "Chrome", registered: true },
        { browser: "edge", label: "Edge", registered: true },
      ],
    }),
  );
  assert.equal(state.tone, "ok");
  assert.equal(state.status, "已注册 Chrome、Edge");
  assert.equal(state.text, "");
  assert.deepEqual(state.problems, []);
  assert.equal(state.showInstall, true);
  assert.equal(state.showRetry, true);
});

test("一个成一个没成：照样能装，但要说清楚哪个没成、为什么", () => {
  const state = describeLink(
    status({
      nativeMessaging: [
        { browser: "chrome", label: "Chrome", registered: true },
        { browser: "edge", label: "Edge", registered: false, note: "写不了注册表键 HKCU\\Edge" },
      ],
    }),
  );
  assert.equal(state.tone, "warn");
  assert.equal(state.status, "已注册 Chrome · Edge 注册失败");
  assert.match(state.text, /Edge 注册失败：写不了注册表键/);
  assert.deepEqual(state.problems, [{ label: "Edge", note: "写不了注册表键 HKCU\\Edge", conflict: false }]);
  assert.doesNotMatch(state.text, /同名清单/, "权限之类的错不能说成同名清单冲突");
  assert.equal(state.showRetry, true);
});

test("一个都没注册上时仍能看到安装入口，但要把连不上的原因说清楚", () => {
  const state = describeLink(
    status({
      nativeMessaging: [
        { browser: "chrome", label: "Chrome", registered: false, note: "Chrome 已经有一份别的同名清单，没有动它。要用本程序请先删掉 /a/chrome.json" },
        { browser: "edge", label: "Edge", registered: false, note: "Edge 已经有一份别的同名清单，没有动它。要用本程序请先删掉 /a/edge.json" },
      ],
    }),
  );
  assert.equal(state.tone, "error");
  assert.equal(state.status, "浏览器注册失败");
  assert.match(state.text, /Chrome、Edge 注册失败：已经有一份别的同名清单/);
  assert.ok(state.problems.every((problem) => problem.conflict));
  assert.match(state.problems[1].note, /\/a\/edge\.json/, "完整路径要原样留给用户");
  assert.equal(state.showInstall, true);
  assert.match(state.next, /先处理上面的问题/);
});

test("两个浏览器原因不同时各说各的，不一律写成冲突", () => {
  const state = describeLink(
    status({
      nativeMessaging: [
        { browser: "chrome", label: "Chrome", registered: false, note: "Chrome 已经有一份别的同名清单，没有动它。" },
        { browser: "edge", label: "Edge", registered: false, note: "写不了 /b/edge.json：Permission denied" },
      ],
    }),
  );
  assert.match(state.text, /原因各不相同/);
  assert.deepEqual(state.problems.map((problem) => problem.conflict), [true, false]);
});

test("读不到状态时不假装知道，安装入口仍在", () => {
  const state = describeLink(null);
  assert.equal(state.tone, "pending");
  assert.equal(state.showInstall, true);
  assert.equal(state.showRetry, false);
  assert.match(state.status, /正在读取/);
});

test("读取失败时如实说失败，不沿用旧状态", () => {
  const state = describeLink(status({ nativeMessaging: [{ browser: "chrome", label: "Chrome", registered: true }] }), "IPC 断了");
  assert.equal(state.tone, "error");
  assert.equal(state.status, "读取注册状态失败");
  assert.match(state.text, /IPC 断了/);
  assert.equal(state.showRetry, true);
});

test("同名清单的处理说明只给冲突用", () => {
  assert.match(CONFLICT_HINT, /同名清单/);
  assert.match(CONFLICT_HINT, /重新检查注册/);
});

test("商店审核期间的提示要指向同一发布页里的插件 zip", () => {
  assert.match(STORE_PENDING_HINT, /下载插件包/);
  assert.match(STORE_PENDING_HINT, /开发者模式/);
});

test("侧边栏、空状态和设置页都有安装入口，按钮默认不 hidden", () => {
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "index.html"), "utf8");
  assert.match(html, /id="nav-install-extension"/);
  assert.match(html, /id="btn-empty-install"/);
  assert.match(html, /id="link-install"/);
  assert.match(html, /id="link-download"/);
  assert.doesNotMatch(html, /id="link-install"[^>]*\bhidden\b/);
  assert.doesNotMatch(html, /id="link-download"[^>]*\bhidden\b/);
});

test("装完扩展的提示里要写「重新加载扩展或重启浏览器」", () => {
  // 清单变了，浏览器不一定马上重读（D01 的 V3）。
  assert.match(AFTER_INSTALL_HINT, /重新加载|重启浏览器/);
});

test("协议版本对不上时说清楚该升哪一边", () => {
  assert.equal(describeProtocolMismatch(2, 2), null);
  assert.equal(describeProtocolMismatch(null, 2), null);
  assert.match(describeProtocolMismatch(1, 2) ?? "", /升级桌面/);
  assert.match(describeProtocolMismatch(3, 2) ?? "", /升级扩展/);
});

test("只有命令返回了目标且每个浏览器都注册成功时才显示成功", () => {
  assert.equal(registrationCompleted([]), false);
  assert.equal(registrationCompleted([{ registered: true }, { registered: false }]), false);
  assert.equal(registrationCompleted([{ registered: true }, { registered: true }]), true);
});

test("顶栏只说注册结果，从不说扩展已连接", () => {
  const chrome = { browser: "chrome" as const, label: "Chrome", registered: true };
  const edge = { browser: "edge" as const, label: "Edge", registered: false, note: "目录不可写" };
  const cases = [
    [describeRegistration(null), "pending", /正在读取/],
    [describeRegistration(status({ nativeMessaging: [] })), "warn", /未核对/],
    [describeRegistration(status({ nativeMessaging: [{ ...edge }] })), "error", /未注册/],
    [describeRegistration(status({ nativeMessaging: [chrome, edge] })), "warn", /已注册 Chrome · Edge 未注册/],
    [describeRegistration(status({ nativeMessaging: [chrome, { ...edge, registered: true }] })), "ok", /^已注册 Chrome、Edge$/],
  ] as const;
  for (const [pill, tone, text] of cases) {
    assert.equal(pill.tone, tone);
    assert.match(pill.text, text);
    assert.doesNotMatch(pill.text, /连接|连上/);
    assert.match(pill.title, /不代表扩展已安装或已经连上/);
  }
});
