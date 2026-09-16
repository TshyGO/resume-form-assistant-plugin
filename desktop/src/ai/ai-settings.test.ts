import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiSettingsView } from "../api.ts";
import {
  describeCommandError,
  describeKeyState,
  describeSaved,
  describeTransportRisk,
} from "./ai-settings.ts";

const view = (overrides: Partial<AiSettingsView> = {}): AiSettingsView => ({
  apiUrl: "https://api.deepseek.com/v1/chat/completions",
  model: "deepseek-chat",
  host: "api.deepseek.com",
  keyConfigured: false,
  credentialError: null,
  ...overrides,
});

test("没配 Key 时说清楚手动分类还能用", () => {
  const message = describeKeyState(view());
  assert.equal(message.tone, "warn");
  assert.match(message.text, /手动分类照常可用/);
});

test("配过 Key 只说配过，不显示它", () => {
  const message = describeKeyState(view({ keyConfigured: true }));
  assert.equal(message.tone, "ok");
  assert.match(message.text, /不会显示/);
});

test("凭据库用不了时报凭据库的错，不说成没配过", () => {
  const message = describeKeyState(view({ credentialError: "系统凭据库用不了，Key 没有保存：被策略禁用" }));
  assert.equal(message.tone, "error");
  assert.match(message.text, /凭据库/);
});

test("明文 http：本机温和提示，公网明确警告，https 不提示", () => {
  assert.equal(describeTransportRisk("https://api.deepseek.com/v1/chat/completions"), null);
  assert.equal(describeTransportRisk("http://127.0.0.1:8000/v1")?.tone, "warn");
  assert.equal(describeTransportRisk("http://192.168.1.9:8000/v1")?.tone, "warn");
  const publicRisk = describeTransportRisk("http://relay.example/v1");
  assert.equal(publicRisk?.tone, "error");
  assert.match(publicRisk?.text ?? "", /明文/);
});

test("地址被补全过就说补成了什么", () => {
  const saved = describeSaved("https://api.deepseek.com", view());
  assert.match(saved.text, /补全为 https:\/\/api\.deepseek\.com\/v1\/chat\/completions/);
  assert.equal(describeSaved("https://api.deepseek.com/v1/chat/completions", view()).text, "已保存。");
});

test("命令报错时把错误码留在文案里", () => {
  const message = describeCommandError({ code: "CREDENTIAL_STORE_UNAVAILABLE", message: "凭据库用不了" });
  assert.equal(message.tone, "error");
  assert.match(message.text, /CREDENTIAL_STORE_UNAVAILABLE/);
  assert.match(describeCommandError(null).text, /UNKNOWN/);
});
