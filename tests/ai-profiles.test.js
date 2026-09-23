const test = require("node:test");
const assert = require("node:assert/strict");

const models = require("../ai-models.js");
const { loadPopup } = require("./helpers/popup-harness.js");

function load() {
  return loadPopup({ globals: { ResumeProModels: models } });
}

function profilesApi(popup) {
  return popup.api.aiProfiles;
}

function submitEvent() {
  return { preventDefault() {} };
}

async function fillAndSave(popup, { name = "", apiUrl, model, apiKey }) {
  popup.element("ai-profile-name").value = name;
  popup.element("api-url-input").value = apiUrl;
  popup.element("model-input").value = model;
  popup.element("api-key-input").value = apiKey;
  await profilesApi(popup).handleConfigSubmit(submitEvent());
  return popup.readState();
}

test("旧的一份完整配置升级后仍是当前配置，aiConfig 读出来和原来一样", async () => {
  const popup = load();
  popup.store.aiConfig = {
    apiUrl: "https://old.example/v1/chat/completions",
    model: "old-model",
    apiKey: "sk-legacy"
  };

  const state = await popup.readState();

  assert.equal(state.aiProfiles.length, 1);
  assert.equal(state.activeAiProfileId, state.aiProfiles[0].id);
  assert.equal(state.aiConfig.apiUrl, "https://old.example/v1/chat/completions");
  assert.equal(state.aiConfig.model, "old-model");
  assert.equal(state.aiConfig.apiKey, "sk-legacy");
  assert.equal(JSON.stringify({
    apiUrl: state.aiProfiles[0].apiUrl,
    model: state.aiProfiles[0].model,
    apiKey: state.aiProfiles[0].apiKey
  }), JSON.stringify(state.aiConfig));
});

test("没配过的默认配置不会变成一条已启用的配置", async () => {
  const popup = load();
  const state = await popup.readState();

  assert.equal(state.aiProfiles.length, 0);
  assert.equal(state.activeAiProfileId, "");
  assert.equal(state.aiConfig.apiKey, "");
});

test("旧配置只有地址、没有 Key 时会留下，但不会自动启用", async () => {
  const popup = load();
  popup.store.aiConfig = {
    apiUrl: "https://custom.example/v1/chat/completions",
    model: "custom-model",
    apiKey: ""
  };

  const state = await popup.readState();

  assert.equal(state.aiProfiles.length, 1);
  assert.equal(state.aiProfiles[0].apiUrl, "https://custom.example/v1/chat/completions");
  assert.equal(state.activeAiProfileId, "");
  assert.equal(state.aiConfig.apiKey, "");
});

test("保存第二份不会覆盖第一份，也不会带走第一份的 Key", async () => {
  const popup = load();
  await fillAndSave(popup, {
    name: "A",
    apiUrl: "https://a.example/v1",
    model: "model-a",
    apiKey: "sk-a"
  });
  profilesApi(popup).beginNewAiProfile();
  assert.equal(popup.element("api-key-input").value, "");

  const state = await fillAndSave(popup, {
    name: "B",
    apiUrl: "https://b.example/v1/chat/completions",
    model: "model-b",
    apiKey: "sk-b"
  });

  const byName = Object.fromEntries(state.aiProfiles.map((profile) => [profile.name, profile]));
  assert.equal(byName.A.apiKey, "sk-a");
  assert.equal(byName.A.apiUrl, "https://a.example/v1/chat/completions");
  assert.equal(byName.B.apiKey, "sk-b");
  assert.equal(byName.B.apiUrl, "https://b.example/v1/chat/completions");
  assert.equal(state.aiConfig.apiKey, "sk-b");
  assert.equal(state.activeAiProfileId, byName.B.id);
});

test("没填完不能保存，当前配置保持不变", async () => {
  const popup = load();
  const before = await fillAndSave(popup, {
    name: "A",
    apiUrl: "https://a.example/v1",
    model: "model-a",
    apiKey: "sk-a"
  });
  profilesApi(popup).beginNewAiProfile();
  popup.element("api-url-input").value = "https://b.example/v1";
  popup.element("model-input").value = "";
  popup.element("api-key-input").value = "sk-b";

  await profilesApi(popup).handleConfigSubmit(submitEvent());

  const state = await popup.readState();
  assert.equal(state.aiProfiles.length, 1);
  assert.equal(state.activeAiProfileId, before.activeAiProfileId);
  assert.equal(state.aiConfig.apiKey, "sk-a");
  assert.match(popup.lastStatusFrom("config-status"), /未完成/);
});

test("编辑只更新那一份，切换后 aiConfig 用的是对应的 Key", async () => {
  const popup = load();
  const first = await fillAndSave(popup, {
    name: "A",
    apiUrl: "https://a.example/v1",
    model: "model-a",
    apiKey: "sk-a"
  });
  profilesApi(popup).beginNewAiProfile();
  await fillAndSave(popup, {
    name: "B",
    apiUrl: "https://b.example/v1",
    model: "model-b",
    apiKey: "sk-b"
  });
  const profileA = first.aiProfiles[0];

  await profilesApi(popup).beginEditAiProfile(profileA.id);
  assert.equal(popup.element("api-key-input").value, "sk-a");
  popup.element("model-input").value = "model-a2";
  popup.element("api-key-input").value = "sk-a2";
  await profilesApi(popup).handleConfigSubmit(submitEvent());

  let state = await popup.readState();
  const edited = state.aiProfiles.find((profile) => profile.id === profileA.id);
  const other = state.aiProfiles.find((profile) => profile.name === "B");
  assert.equal(edited.model, "model-a2");
  assert.equal(edited.apiKey, "sk-a2");
  assert.equal(other.apiKey, "sk-b");
  assert.equal(other.model, "model-b");
  assert.equal(state.aiConfig.apiKey, "sk-a2");

  await profilesApi(popup).activateAiProfile(other.id);
  state = await popup.readState();
  assert.equal(state.aiConfig.apiUrl, "https://b.example/v1/chat/completions");
  assert.equal(state.aiConfig.apiKey, "sk-b");
  assert.equal(state.aiProfiles.find((profile) => profile.id === profileA.id).apiKey, "sk-a2");
});

test("重命名不改地址和 Key", async () => {
  const popup = load();
  const state = await fillAndSave(popup, {
    name: "A",
    apiUrl: "https://a.example/v1",
    model: "model-a",
    apiKey: "sk-a"
  });

  await profilesApi(popup).renameAiProfile(state.activeAiProfileId, "公司中转");
  const next = await popup.readState();
  assert.equal(next.aiProfiles[0].name, "公司中转");
  assert.equal(next.aiConfig.apiKey, "sk-a");
  assert.equal(next.aiConfig.apiUrl, "https://a.example/v1/chat/completions");
});

test("删除当前配置时必须明确选择；选未配置后不再持有任何 Key", async () => {
  const popup = load();
  const first = await fillAndSave(popup, {
    name: "A",
    apiUrl: "https://a.example/v1",
    model: "model-a",
    apiKey: "sk-a"
  });
  profilesApi(popup).beginNewAiProfile();
  const second = await fillAndSave(popup, {
    name: "B",
    apiUrl: "https://b.example/v1",
    model: "model-b",
    apiKey: "sk-b"
  });
  const profileA = first.aiProfiles[0];
  const profileB = second.aiProfiles.find((profile) => profile.name === "B");

  await assert.rejects(() => profilesApi(popup).deleteAiProfile(profileB.id));
  let state = await popup.readState();
  assert.equal(state.aiProfiles.length, 2);
  assert.equal(state.aiConfig.apiKey, "sk-b");

  await profilesApi(popup).deleteAiProfile(profileB.id, "");
  state = await popup.readState();
  assert.equal(state.aiProfiles.length, 1);
  assert.equal(state.activeAiProfileId, "");
  assert.equal(state.aiConfig.apiKey, "");
  assert.equal(state.aiProfiles[0].apiKey, "sk-a");
  assert.equal(profileA.apiKey, "sk-a");
});

test("删除当前配置时可以改用另一份，用的是那一份自己的 Key", async () => {
  const popup = load();
  const first = await fillAndSave(popup, {
    name: "A",
    apiUrl: "https://a.example/v1",
    model: "model-a",
    apiKey: "sk-a"
  });
  profilesApi(popup).beginNewAiProfile();
  const second = await fillAndSave(popup, {
    name: "B",
    apiUrl: "https://b.example/v1",
    model: "model-b",
    apiKey: "sk-b"
  });
  const profileA = first.aiProfiles[0];
  const profileB = second.aiProfiles.find((profile) => profile.name === "B");

  await profilesApi(popup).deleteAiProfile(profileB.id, profileA.id);
  const state = await popup.readState();
  assert.equal(state.activeAiProfileId, profileA.id);
  assert.equal(state.aiConfig.apiKey, "sk-a");
  assert.equal(state.aiConfig.apiUrl, "https://a.example/v1/chat/completions");
  assert.equal(state.aiProfiles.some((profile) => profile.apiKey === "sk-b"), false);
});

test("删除的不是当前配置时，当前 Key 保持不变", async () => {
  const popup = load();
  const first = await fillAndSave(popup, {
    name: "A",
    apiUrl: "https://a.example/v1",
    model: "model-a",
    apiKey: "sk-a"
  });
  profilesApi(popup).beginNewAiProfile();
  await fillAndSave(popup, {
    name: "B",
    apiUrl: "https://b.example/v1",
    model: "model-b",
    apiKey: "sk-b"
  });

  await profilesApi(popup).deleteAiProfile(first.aiProfiles[0].id);
  const state = await popup.readState();
  assert.equal(state.aiProfiles.length, 1);
  assert.equal(state.aiConfig.apiKey, "sk-b");
});
