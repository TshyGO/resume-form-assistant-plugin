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
