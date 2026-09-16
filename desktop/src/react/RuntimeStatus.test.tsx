import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import type { RuntimeStatus } from "../api.ts";
import { RuntimeStatusFacts } from "./RuntimeStatus.tsx";

const status = {
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
} as RuntimeStatus;

test("画出来的 dt/dd 是 .facts 的直接子元素，两列 grid 才不会塌", () => {
  const { container } = render(<RuntimeStatusFacts status={status} />);
  const list = container.querySelector("dl.facts");
  expect(list).not.toBeNull();
  const tags = [...(list?.children ?? [])].map((child) => child.tagName);
  expect(new Set(tags)).toEqual(new Set(["DT", "DD"]));
  expect(screen.getByText("应用版本")).toBeTruthy();
  expect(screen.getByText("com.resumepro.desktop")).toBeTruthy();
});

test("还没拿到状态时如实说，不画一张空表", () => {
  render(<RuntimeStatusFacts status={null} />);
  expect(screen.getByText("还没有拿到运行状态。")).toBeTruthy();
});
