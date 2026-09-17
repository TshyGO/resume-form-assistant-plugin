import { test } from "node:test";
import assert from "node:assert/strict";
import type { RuntimeStatus } from "./api.ts";
import { runtimeFacts } from "./runtime-facts.ts";

function status(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    runtimeLabel: "开发",
    appVersion: "0.1.0",
    identifier: "com.resumepro.desktop",
    programDir: "C:/prog",
    dataRoot: "C:/data",
    archiveDir: "C:/data/archive",
    logsDir: "C:/data/logs",
    logFile: "C:/data/logs/app.log",
    cacheDir: "C:/cache",
    webviewDataDir: null,
    webviewDataManaged: false,
    webviewDataNote: "由系统托管",
    currentPointer: "C:/data/current.json",
    writable: true,
    uniqueWriter: true,
    windowVisible: true,
    hiddenLaunch: false,
    autostartEnabled: false,
    nativeMessagingRegistered: false,
    remindersImplemented: true,
    closeWindowMeans: "隐藏到托盘",
    quitMeans: "提醒也会停",
    ...overrides,
  } as RuntimeStatus;
}

test("布尔值显示成是/否，不显示 true/false", () => {
  const facts = runtimeFacts(status({ writable: true, uniqueWriter: false }));
  const byLabel = new Map(facts.map((fact) => [fact.label, fact.value]));
  assert.equal(byLabel.get("启动时目录可写"), "是");
  assert.equal(byLabel.get("唯一写入者"), "否");
  assert.equal(byLabel.get("开机启动"), "否（D02 不会注册）");
});

test("空值显示成破折号，不显示 undefined", () => {
  const facts = runtimeFacts(status({ logFile: "", programDir: undefined as unknown as string }));
  const byLabel = new Map(facts.map((fact) => [fact.label, fact.value]));
  assert.equal(byLabel.get("日志文件"), "—");
  assert.equal(byLabel.get("程序目录"), "—");
  assert.equal(byLabel.get("WebView 数据目录"), "未由本应用托管");
});

test("Native Messaging 没注册成时说清楚是哪个浏览器、为什么", () => {
  const rows = runtimeFacts(
    status({
    nativeMessagingRegistered: false,
    nativeMessaging: [
      { browser: "chrome", label: "Chrome", registered: true },
      { browser: "edge", label: "Edge", registered: false, note: "写不了注册表键：被策略挡住了" },
    ],
  }),
  );
  const row = rows.find((item) => item.label === "Native Messaging")!;
  assert.match(row.value, /Edge 未注册/);
  assert.match(row.value, /策略/);
});

test("两个浏览器都注册好了就只说一句", () => {
  const rows = runtimeFacts(
    status({
      nativeMessagingRegistered: true,
      nativeMessaging: [
        { browser: "chrome", label: "Chrome", registered: true },
        { browser: "edge", label: "Edge", registered: true },
      ],
    }),
  );
  const row = rows.find((item) => item.label === "Native Messaging")!;
  assert.equal(row.value, "已注册（Chrome、Edge）");
});

test("还没核对过时不假装已注册", () => {
  const rows = runtimeFacts(status({ nativeMessagingRegistered: false }));
  const row = rows.find((item) => item.label === "Native Messaging")!;
  assert.match(row.value, /还没核对过/);
});

test("升级过数据库时把迁移备份指给用户看", () => {
  const rows = runtimeFacts(
    status({ migrationBackup: "C:/data/archive/backups/archive-v3-2026-09-17.db" }),
  );
  const row = rows.find((item) => item.label === "本次升级的迁移备份")!;
  assert.match(row.value, /archive-v3/);
  assert.match(row.value, /可以从它恢复/);
});

test("没升级就直说没升级，不留一个空格子", () => {
  const rows = runtimeFacts(status());
  const row = rows.find((item) => item.label === "本次升级的迁移备份")!;
  assert.equal(row.value, "本次启动没有升级数据库");
});

test("读不到档案状态时不冒充「没有升级」", () => {
  const rows = runtimeFacts(status({ migrationBackupUnknown: true }));
  const row = rows.find((item) => item.label === "本次升级的迁移备份")!;
  assert.match(row.value, /读取失败/);
  assert.doesNotMatch(row.value, /没有升级/);
});
