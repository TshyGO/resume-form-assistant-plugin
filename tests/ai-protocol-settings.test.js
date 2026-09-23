const test = require("node:test");
const assert = require("node:assert/strict");
const { HEADER, loadPopup, makeFile } = require("./helpers/popup-harness.js");
const models = require("../ai-models.js");

test("plugin settings switch a saved chat URL to Anthropic and persist the protocol", async () => {
  const popup = loadPopup({ globals: { ResumeProModels: models } });
  popup.element("api-url-input").value = "https://relay.example/v1/chat/completions";
  popup.element("ai-protocol-input").value = "anthropic";
  popup.element("model-input").value = "claude-test";
  popup.element("api-key-input").value = "synthetic";
  await popup.api.handleConfigSubmit({ preventDefault() {} });
  const saved = (await popup.readState()).aiConfig;
  assert.equal(saved.protocol, "anthropic");
  assert.equal(saved.apiUrl, "https://relay.example/v1/messages");
  assert.equal(saved.model, "claude-test");
});

test("backup records non-Chat protocol and requires a reader that supports it", async () => {
  const secretFields = await import("../link/secret-fields.mjs");
  const popup = loadPopup({ globals: { ResumeProModels: models, ResumeProSecretFields: secretFields } });
  await popup.importFile(makeFile("resume.xlsx", [HEADER, ["基本信息", "姓名", "张三"]]));
  const state = await popup.readState();
  state.aiConfig.protocol = "responses";
  state.aiConfig.apiUrl = "https://relay.example/v1/responses";
  const { backup } = popup.api.backup.buildBackup(state);
  assert.equal(backup.formatVersion, 3);
  assert.equal(backup.aiConfig.protocol, "responses");
  const restored = popup.api.backup.parseBackup(JSON.stringify(backup));
  assert.equal(restored.aiConfig.protocol, "responses");
});
