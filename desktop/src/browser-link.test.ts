import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeStatus } from "./api.ts";
import {
  AFTER_INSTALL_HINT,
  STORE_PENDING_HINT,
  describeLink,
  describeProtocolMismatch,
  registrationCompleted,
} from "./browser-link.ts";

const status = (overrides: Partial<RuntimeStatus> = {}): RuntimeStatus =>
  ({
    nativeMessagingRegistered: false,
    ...overrides,
  }) as RuntimeStatus;

test("还没核对过时不说「未连接」，安装入口仍然在", () => {
  const state = describeLink(status());
  assert.match(state.text, /还没核对过/);
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
  assert.match(state.text, /Chrome、Edge/);
  assert.equal(state.showInstall, true);
  assert.equal(state.showRetry, true);
});

test("一个成一个没成：照样能装，但要说清楚哪个没成", () => {
  const state = describeLink(
    status({
      nativeMessaging: [
        { browser: "chrome", label: "Chrome", registered: true },
        { browser: "edge", label: "Edge", registered: false, note: "写不了注册表键" },
      ],
    }),
  );
  assert.equal(state.tone, "warn");
  assert.match(state.text, /Edge没注册上/);
  assert.equal(state.showInstall, true);
  assert.equal(state.showRetry, true);
});

test("一个都没注册上时仍能看到安装入口，但要把连不上的原因说清楚", () => {
  const state = describeLink(
    status({
      nativeMessaging: [
        { browser: "chrome", label: "Chrome", registered: false, note: "写不了清单" },
        { browser: "edge", label: "Edge", registered: false, note: "写不了清单" },
      ],
    }),
  );
  assert.equal(state.tone, "error");
  assert.equal(state.showInstall, true);
  assert.match(state.next, /先解决上面的问题/);
});

test("读不到状态时不假装知道，安装入口仍在", () => {
  const state = describeLink(null);
  assert.equal(state.showInstall, true);
  assert.match(state.text, /还没读到/);
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
