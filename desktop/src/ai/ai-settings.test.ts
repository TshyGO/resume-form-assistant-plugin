import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeCommandError,
  describeModelsResult,
  describeProviderKey,
  describeTransportRisk,
  describeUrlSecrets,
  matchModels,
  PRESETS,
} from "./ai-settings.ts";

test("预设都是 https 的 Base URL，名字不重复", () => {
  const names = new Set(PRESETS.map((p) => p.name));
  assert.equal(names.size, PRESETS.length);
  for (const preset of PRESETS) {
    if (preset.id === "custom") continue;
    assert.match(preset.apiUrl, /^https:\/\//);
    assert.match(preset.keyPage, /^https:\/\//);
  }
  assert.ok(PRESETS.some((p) => p.id === "custom" && p.apiUrl === ""));
});

test("每个服务商的 Key 状态", () => {
  assert.equal(describeProviderKey({ keyConfigured: true }, null).tone, "ok");
  assert.equal(describeProviderKey({ keyConfigured: false }, null).tone, "warn");
  assert.equal(describeProviderKey({ keyConfigured: false }, "钥匙串锁了").tone, "error");
});

test("模型候选：完全一致 > 前缀（含 vendor/ 之后） > 子串", () => {
  assert.deepEqual(matchModels(["a/deepseek-chat", "deepseek-chat", "x-deepseek"], "deepseek-chat"), [
    "deepseek-chat",
    "a/deepseek-chat",
  ]);
  assert.deepEqual(matchModels(["qwen-plus", "qwen-max"], ""), ["qwen-plus", "qwen-max"]);
});

test("获取模型的结果提示", () => {
  assert.match(describeModelsResult({ models: ["a"], hiddenCount: 2, host: "h" }).text, /拿到 1 个模型.*另有 2 个非对话模型已隐藏/);
  assert.equal(describeModelsResult({ models: [], hiddenCount: 0, host: "h" }).tone, "warn");
});

test("明文 http：本机温和提示，公网明确警告，https 不提示", () => {
  assert.equal(describeTransportRisk("https://api.deepseek.com/v1/chat/completions"), null);
  assert.equal(describeTransportRisk("http://127.0.0.1:8000/v1")?.tone, "warn");
  assert.equal(describeTransportRisk("http://192.168.1.9:8000/v1")?.tone, "warn");
  const publicRisk = describeTransportRisk("http://relay.example/v1");
  assert.equal(publicRisk?.tone, "error");
  assert.match(publicRisk?.text ?? "", /明文/);
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
