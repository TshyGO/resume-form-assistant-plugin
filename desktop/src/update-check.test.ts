import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  describeCheckFailure,
  describeUpdate,
  shouldCheck,
} from "./update-check.ts";

test("版本号按三段数字比，不按字符串比", () => {
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("0.10.0", "0.9.0"), 1, "字符串比会说 0.9 更大");
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
});

test("认不出的版本号就当一样，不乱提示升级", () => {
  assert.equal(compareVersions("nightly", "1.0.0"), 0);
});

test("关了就不查；今天查过也不查", () => {
  const now = "2026-09-17T10:00:00Z";
  assert.equal(shouldCheck({ enabled: false }, now), false);
  assert.equal(shouldCheck({ enabled: true }, now), true);
  assert.equal(shouldCheck({ enabled: true, lastCheckedAt: "2026-09-17T01:00:00Z" }, now), false);
  assert.equal(shouldCheck({ enabled: true, lastCheckedAt: "2026-09-16T23:59:00Z" }, now), true);
});

test("有新版本时说清楚新旧两个号，并说明是手动安装", () => {
  const message = describeUpdate("0.1.0", { version: "0.2.0", url: "https://example.test/r" });
  assert.equal(message.available, true);
  assert.match(message.text, /0\.2\.0/);
  assert.match(message.text, /0\.1\.0/);
  assert.match(message.text, /手动安装/);
});

test("服务器上的版本更旧或一样时，不制造「有更新」的错觉", () => {
  assert.equal(describeUpdate("0.2.0", { version: "0.2.0", url: "u" }).available, false);
  assert.equal(describeUpdate("0.3.0", { version: "0.2.0", url: "u" }).available, false);
  assert.equal(describeUpdate("0.1.0", null).available, false);
});

test("查不到是「没查成」，不是「已经最新」", () => {
  const offline = describeCheckFailure({ code: "UPDATE_OFFLINE" });
  assert.equal(offline.available, false);
  assert.match(offline.text, /连不上/);
  assert.doesNotMatch(offline.text, /最新/);

  assert.match(describeCheckFailure({ code: "UPDATE_RATE_LIMITED" }).text, /限流/);
  assert.match(describeCheckFailure({ message: "说不清" }).text, /说不清/);
});
