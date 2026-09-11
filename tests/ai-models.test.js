const test = require("node:test");
const assert = require("node:assert/strict");
const models = require("../ai-models.js");

// --- resolveEndpoints -------------------------------------------------------

test("a full chat endpoint is kept verbatim and models replaces the last segment", () => {
  assert.deepEqual(models.resolveEndpoints("https://api.openai.com/v1/chat/completions"), {
    chatUrl: "https://api.openai.com/v1/chat/completions",
    modelsUrl: "https://api.openai.com/v1/models"
  });
});

test("a base URL gets both paths appended", () => {
  assert.deepEqual(models.resolveEndpoints("https://api.siliconflow.cn/v1"), {
    chatUrl: "https://api.siliconflow.cn/v1/chat/completions",
    modelsUrl: "https://api.siliconflow.cn/v1/models"
  });
});

test("trailing slashes do not change the shape", () => {
  assert.deepEqual(models.resolveEndpoints("https://api.siliconflow.cn/v1/"), {
    chatUrl: "https://api.siliconflow.cn/v1/chat/completions",
    modelsUrl: "https://api.siliconflow.cn/v1/models"
  });
  assert.deepEqual(models.resolveEndpoints("https://relay.example/v1/chat/completions/"), {
    chatUrl: "https://relay.example/v1/chat/completions/",
    modelsUrl: "https://relay.example/v1/models"
  });
});

test("versioned and vendor base paths are recognised as bases", () => {
  const chat = (input) => models.resolveEndpoints(input).chatUrl;
  assert.equal(chat("https://openrouter.ai/api/v1"), "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(chat("https://open.bigmodel.cn/api/paas/v4"), "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(
    chat("https://generativelanguage.googleapis.com/v1beta/openai"),
    "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
  );
});

test("a bare host is treated as a base with /v1", () => {
  assert.deepEqual(models.resolveEndpoints("https://api.openai.com"), {
    chatUrl: "https://api.openai.com/v1/chat/completions",
    modelsUrl: "https://api.openai.com/v1/models"
  });
});

test("query strings survive on both endpoints", () => {
  assert.deepEqual(models.resolveEndpoints("https://relay.example/v1/chat/completions?api-version=2024-10-21"), {
    chatUrl: "https://relay.example/v1/chat/completions?api-version=2024-10-21",
    modelsUrl: "https://relay.example/v1/models?api-version=2024-10-21"
  });
  assert.deepEqual(models.resolveEndpoints("https://relay.example/v1?key=x"), {
    chatUrl: "https://relay.example/v1/chat/completions?key=x",
    modelsUrl: "https://relay.example/v1/models?key=x"
  });
});

test("an unrecognised path is kept as the chat endpoint and has no models URL", () => {
  assert.deepEqual(models.resolveEndpoints("https://proxy.example/custom/openai-chat"), {
    chatUrl: "https://proxy.example/custom/openai-chat",
    modelsUrl: null
  });
});

test("unparseable or non-http input yields null", () => {
  assert.equal(models.resolveEndpoints(""), null);
  assert.equal(models.resolveEndpoints("not a url"), null);
  assert.equal(models.resolveEndpoints("ftp://example.com/v1"), null);
});

// --- describeTransportRisk --------------------------------------------------

test("https and unparseable addresses carry no transport warning", () => {
  assert.equal(models.describeTransportRisk("https://api.siliconflow.cn/v1"), null);
  assert.equal(models.describeTransportRisk("not a url"), null);
  assert.equal(models.describeTransportRisk(""), null);
});

test("plain http to this machine carries no transport warning", () => {
  for (const url of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:8000/v1/chat/completions",
    "http://127.8.9.10/v1",
    "http://[::1]:8080/v1",
    "http://ollama.localhost/v1"
  ]) {
    assert.equal(models.describeTransportRisk(url), null, url);
  }
});

test("plain http to a private network address is a mild warning", () => {
  for (const url of [
    "http://192.168.1.20:3000/v1",
    "http://10.0.0.5/v1",
    "http://172.20.1.1/v1",
    "http://100.101.102.103:3000/v1",
    "http://nas.local:3000/v1",
    "http://nas:3000/v1",
    "http://[fd12:3456::1]/v1"
  ]) {
    const risk = models.describeTransportRisk(url);
    assert.equal(risk?.scope, "private", url);
    assert.match(risk.message, /局域网/u);
  }
});

test("plain http to a public address is a strong warning that suggests https", () => {
  for (const url of ["http://api.example-relay.com/v1", "http://8.8.8.8/v1", "http://172.32.0.1/v1"]) {
    const risk = models.describeTransportRisk(url);
    assert.equal(risk?.scope, "public", url);
    assert.match(risk.message, /未加密/u);
    assert.match(risk.message, /https:\/\//u);
  }
});

// --- normalizeApiUrlForSave -------------------------------------------------

test("an unchanged stored URL is saved verbatim even when it looks like a base", () => {
  assert.equal(
    models.normalizeApiUrlForSave("https://legacy.example/v1", "https://legacy.example/v1"),
    "https://legacy.example/v1"
  );
});

test("a newly typed base URL is completed to the chat endpoint", () => {
  assert.equal(
    models.normalizeApiUrlForSave("https://api.siliconflow.cn/v1", "https://api.openai.com/v1/chat/completions"),
    "https://api.siliconflow.cn/v1/chat/completions"
  );
});

test("a newly typed full endpoint or unknown shape is saved as typed", () => {
  const previous = "https://api.openai.com/v1/chat/completions";
  assert.equal(
    models.normalizeApiUrlForSave("https://relay.example/v1/chat/completions/", previous),
    "https://relay.example/v1/chat/completions/"
  );
  assert.equal(
    models.normalizeApiUrlForSave("https://proxy.example/custom/openai-chat", previous),
    "https://proxy.example/custom/openai-chat"
  );
  assert.equal(models.normalizeApiUrlForSave("not a url", previous), "not a url");
});

// --- filterChatModels -------------------------------------------------------

test("non-chat models are hidden and chat models are kept", () => {
  const ids = [
    "gpt-4o-mini",
    "gpt-4o-audio-preview",
    "gpt-4o-realtime-preview",
    "o3-mini",
    "Qwen/Qwen2.5-VL-72B-Instruct",
    "deepseek-ai/DeepSeek-V3",
    "text-embedding-3-small",
    "BAAI/bge-m3",
    "BAAI/bge-reranker-v2-m3",
    "netease-youdao/bce-embedding-base_v1",
    "tts-1-hd",
    "gpt-4o-mini-tts",
    "whisper-1",
    "gpt-4o-transcribe",
    "dall-e-3",
    "gpt-image-1",
    "omni-moderation-latest",
    "black-forest-labs/FLUX.1-schnell",
    "stabilityai/stable-diffusion-3-5-large",
    "Kwai-Kolors/Kolors",
    "FunAudioLLM/CosyVoice2-0.5B",
    "FunAudioLLM/SenseVoiceSmall",
    "fishaudio/fish-speech-1.5",
    "Wan-AI/Wan2.1-T2V-14B"
  ];

  const { chat, hidden } = models.filterChatModels(ids);

  assert.deepEqual(chat, [
    "gpt-4o-mini",
    "gpt-4o-audio-preview",
    "gpt-4o-realtime-preview",
    "o3-mini",
    "Qwen/Qwen2.5-VL-72B-Instruct",
    "deepseek-ai/DeepSeek-V3"
  ]);
  assert.equal(hidden.length, ids.length - chat.length);
});

test("chat models that merely contain audio, voice or vision words are not hidden", () => {
  const ids = [
    "gpt-4o-audio-preview",
    "qwen-omni-voice-chat",
    "Qwen/Qwen3-VL-8B-Instruct",
    "zai-org/GLM-4.5V",
    "Qwen/Qwen3-Omni-30B-A3B-Instruct",
    "tencent/Hunyuan-MT-7B",
    "deepseek-ai/DeepSeek-V4-Flash"
  ];
  assert.deepEqual(models.filterChatModels(ids).chat, ids);
});

// Taken from a live SiliconFlow /v1/models response: these slipped past the first filter.
test("image, speech-recognition and dialogue-TTS models from SiliconFlow are hidden", () => {
  const ids = [
    "Qwen/Qwen-Image",
    "Qwen/Qwen-Image-Edit-2509",
    "Tongyi-MAI/Z-Image-Turbo",
    "baidu/ERNIE-Image-Turbo",
    "Qwen/Qwen3-ASR-1.7B",
    "XingChenAGI/XingChenASR-V3.2-Ultra",
    "XingChenAGI/XingChenASR-Diarize-V3.0",
    "fnlp/MOSS-TTSD-v0.5"
  ];
  assert.deepEqual(models.filterChatModels(ids).chat, []);
});

// --- matchModels ------------------------------------------------------------

test("an empty query matches every model in order", () => {
  const list = ["b-model", "a-model"];
  assert.deepEqual(models.matchModels(list, ""), list);
  assert.deepEqual(models.matchModels(list, "   "), list);
});

test("matching is a case-insensitive substring match", () => {
  const list = ["deepseek-ai/DeepSeek-V3", "gpt-4o", "Qwen/Qwen2.5-72B-Instruct"];
  assert.deepEqual(models.matchModels(list, "QWEN"), ["Qwen/Qwen2.5-72B-Instruct"]);
  assert.deepEqual(models.matchModels(list, "v3"), ["deepseek-ai/DeepSeek-V3"]);
});

test("exact, then prefix (including after the vendor slash), then substring matches", () => {
  const list = ["chat-gpt-4o-latest", "gpt-4o-mini", "openai/gpt-4o-audio", "gpt-4o"];
  assert.deepEqual(models.matchModels(list, "gpt-4o"), [
    "gpt-4o",
    "gpt-4o-mini",
    "openai/gpt-4o-audio",
    "chat-gpt-4o-latest"
  ]);
});

test("a query with no match yields an empty list", () => {
  assert.deepEqual(models.matchModels(["gpt-4o"], "claude"), []);
});

// --- parseModelList ---------------------------------------------------------

test("an OpenAI-shaped list is reduced to sorted unique ids", () => {
  const body = { object: "list", data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "gpt-4o" }, { id: "  " }, {}] };
  assert.deepEqual(models.parseModelList(body), ["gpt-4o", "gpt-4o-mini"]);
});

test("a bare array of strings or objects is accepted", () => {
  assert.deepEqual(models.parseModelList(["b", { id: "a" }]), ["a", "b"]);
});

test("a body that is not a model list yields null", () => {
  assert.equal(models.parseModelList({ error: "nope" }), null);
  assert.equal(models.parseModelList("<html></html>"), null);
  assert.equal(models.parseModelList(null), null);
});

// --- fetchModelList ---------------------------------------------------------

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body))
  };
}

test("a successful fetch returns chat models, hidden count and sends the key", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return jsonResponse(200, { data: [{ id: "gpt-4o-mini" }, { id: "text-embedding-3-small" }] });
  };

  const result = await models.fetchModelList({
    apiUrl: "https://api.openai.com/v1/chat/completions",
    apiKey: "sk-test",
    fetchImpl
  });

  assert.deepEqual(result, { ok: true, models: ["gpt-4o-mini"], hiddenCount: 1, allModels: ["gpt-4o-mini", "text-embedding-3-small"] });
  assert.equal(seen.url, "https://api.openai.com/v1/models");
  assert.equal(seen.init.method, "GET");
  assert.equal(seen.init.headers.Authorization, "Bearer sk-test");
});

test("a missing key fails before any request", async () => {
  let called = false;
  const result = await models.fetchModelList({
    apiUrl: "https://api.openai.com/v1",
    apiKey: "  ",
    fetchImpl: async () => { called = true; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing-key");
  assert.equal(called, false);
});

test("an address with no derivable models URL fails as unsupported-address", async () => {
  const result = await models.fetchModelList({
    apiUrl: "https://proxy.example/custom/openai-chat",
    apiKey: "k",
    fetchImpl: async () => { throw new Error("should not be called"); }
  });
  assert.equal(result.reason, "unknown-shape");
});

test("an invalid URL fails as invalid-url", async () => {
  const result = await models.fetchModelList({ apiUrl: "nope", apiKey: "k", fetchImpl: async () => {} });
  assert.equal(result.reason, "invalid-url");
});

test("401 and 403 are reported as a rejected key", async () => {
  for (const status of [401, 403]) {
    const result = await models.fetchModelList({
      apiUrl: "https://api.openai.com/v1",
      apiKey: "k",
      fetchImpl: async () => jsonResponse(status, { error: { message: "Incorrect API key" } })
    });
    assert.equal(result.reason, "auth", `status ${status}`);
    assert.match(result.message, /Key/u);
  }
});

test("404 is reported as wrong address or no model list, never just 'failed'", async () => {
  const result = await models.fetchModelList({
    apiUrl: "https://relay.example/v1",
    apiKey: "k",
    fetchImpl: async () => jsonResponse(404, "Not Found")
  });
  assert.equal(result.reason, "not-found");
  assert.match(result.message, /地址/u);
  assert.match(result.message, /手填/u);
});

test("a 200 that is not a model list is reported as a wrong address", async () => {
  const result = await models.fetchModelList({
    apiUrl: "https://relay.example/v1",
    apiKey: "k",
    fetchImpl: async () => jsonResponse(200, "<!doctype html><title>Home</title>")
  });
  assert.equal(result.reason, "not-a-list");
  assert.match(result.message, /地址/u);
});

test("a network error is reported as unreachable", async () => {
  const result = await models.fetchModelList({
    apiUrl: "https://nowhere.invalid/v1",
    apiKey: "k",
    fetchImpl: async () => { throw new TypeError("Failed to fetch"); }
  });
  assert.equal(result.reason, "network");
  assert.match(result.message, /连不上/u);
});

test("a request that outlives the timeout is aborted and reported as unreachable", async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const result = await models.fetchModelList({
    apiUrl: "https://slow.example/v1",
    apiKey: "k",
    fetchImpl,
    timeoutMs: 20
  });
  assert.equal(result.reason, "timeout");
  assert.match(result.message, /超时/u);
});

test("the three headline failures carry distinct messages", async () => {
  const run = (fetchImpl) => models.fetchModelList({ apiUrl: "https://x.example/v1", apiKey: "k", fetchImpl });
  const auth = await run(async () => jsonResponse(401, {}));
  const address = await run(async () => jsonResponse(404, ""));
  const network = await run(async () => { throw new TypeError("Failed to fetch"); });
  assert.equal(new Set([auth.message, address.message, network.message]).size, 3);
});

test("other HTTP errors include the status and the provider's message", async () => {
  const result = await models.fetchModelList({
    apiUrl: "https://x.example/v1",
    apiKey: "k",
    fetchImpl: async () => jsonResponse(429, { error: { message: "slow down" } })
  });
  assert.equal(result.reason, "http");
  assert.match(result.message, /429/u);
  assert.match(result.message, /slow down/u);
});
