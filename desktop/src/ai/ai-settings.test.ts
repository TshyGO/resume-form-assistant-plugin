import { test } from "node:test";
import assert from "node:assert/strict";
import type { AiSettingsView } from "../api.ts";
import {
  describeCommandError,
  describeKeyState,
  describeModelsResult,
  describeSaved,
  describeTransportRisk,
  describeUrlSecrets,
  matchModels,
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
  assert.equal(describeTransportRisk("http://localhost?tenant=private")?.tone, "warn");
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

test("地址里夹带凭据要当场说：Key 只该在 Authorization 头里", () => {
  assert.equal(describeUrlSecrets("https://api.deepseek.com/v1/chat/completions"), null);
  assert.equal(describeUrlSecrets(""), null);
  assert.equal(describeUrlSecrets("https://relay.example?email=user@example.com"), null);

  const userinfo = describeUrlSecrets("https://someone:sk-123@relay.example/v1/chat/completions");
  assert.equal(userinfo?.tone, "error");
  assert.match(userinfo!.text, /用户名或密码/);

  const query = describeUrlSecrets("https://relay.example/v1/chat/completions?api-key=sk-123");
  assert.equal(query?.tone, "warn");
  assert.match(query!.text, /api-key/);

  // fragment 里的也看，口径和命令层的 credential_in_url 一致。
  assert.equal(
    describeUrlSecrets("https://relay.example/v1?api-version=1#api-key=sk-1")?.tone,
    "warn",
  );
  // 按分段比，不按子串比：这几个不该被当成 Key。
  for (const fine of [
    "https://relay.example/v1/chat/completions?monkey=1",
    "https://relay.example/v1/chat/completions?keynote=x",
  ]) {
    assert.equal(describeUrlSecrets(fine), null, fine);
  }

  // 正常的版本参数不该被当成 Key。
  assert.equal(describeUrlSecrets("https://relay.example/v1/chat/completions?api-version=2024-10-21"), null);
});

test("模型拉回来后说清几个能填、几个藏了、问的哪台主机", () => {
  const ok = describeModelsResult({
    models: ["a-chat", "b-chat"],
    hiddenCount: 3,
    host: "relay.example",
  });
  assert.equal(ok.tone, "ok");
  assert.match(ok.text, /relay\.example/);
  assert.match(ok.text, /2 个模型/);
  assert.match(ok.text, /3 个非对话模型/);

  const empty = describeModelsResult({ models: [], hiddenCount: 0, host: "relay.example" });
  assert.equal(empty.tone, "warn");
  assert.match(empty.text, /手填/);
});

test("候选按完全一致、前缀、子串排序，对不上的不要", () => {
  const ids = ["zzz-gpt", "gpt-4o", "vendor/gpt-4o-mini", "my-gpt-x"];
  assert.deepEqual(matchModels(ids, "gpt-4o"), ["gpt-4o", "vendor/gpt-4o-mini"]);
  assert.deepEqual(matchModels(ids, "mini"), ["vendor/gpt-4o-mini"]);
  assert.deepEqual(matchModels(ids, ""), ids);
  assert.deepEqual(matchModels(ids, "claude"), []);
});
