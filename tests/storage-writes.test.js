const test = require("node:test");
const assert = require("node:assert/strict");

const helpers = require("../ai-helpers.js");
const { HEADER, loadPopup, makeFile } = require("./helpers/popup-harness.js");

class FakeFileReader {
  readAsText(file) {
    Promise.resolve(file.content).then((text) => {
      this.result = text;
      this.onload();
    });
  }
}

function parsePopup(reply) {
  const sent = [];
  const popup = loadPopup({
    globals: {
      FileReader: FakeFileReader,
      ResumeProAIHelpers: helpers,
      ResumeProAIClient: {
        send: async (message) => {
          sent.push(message);
          return reply;
        }
      }
    }
  });
  popup.api.cacheParseElements();
  return { popup, sent };
}

async function seed(popup) {
  await popup.importFile(makeFile("简历.xlsx", [HEADER, ["基本信息", "姓名", "张三"]]));
  const state = await popup.readState();
  state.aiConfig = { apiUrl: "https://api.example.com/v1/chat/completions", model: "m", apiKey: "sk" };
  await popup.writeState(state);
  popup.setCalls.length = 0;
}

test("opening the settings page leaves existing data and unrelated keys alone", async () => {
  const popup = loadPopup();
  await seed(popup);
  popup.store.resumeProUpdateCache = { checkedAt: 1 };

  await popup.api.StorageService.ensureDefaults();

  assert.deepEqual(popup.setCalls, []);
  assert.deepEqual(popup.store.resumeProUpdateCache, { checkedAt: 1 });
});

test("a fresh install only gets the missing defaults written", async () => {
  const popup = loadPopup();
  popup.store.aiConfig = { apiUrl: "https://relay.example/v1/chat/completions", model: "x", apiKey: "k" };

  const state = await popup.api.StorageService.ensureDefaults();

  assert.deepEqual(popup.setCalls, [["templates", "activeTemplateId"]]);
  assert.equal(popup.store.aiConfig.apiUrl, "https://relay.example/v1/chat/completions");
  assert.equal(state.aiConfig.model, "x");
});

test("switching template writes only activeTemplateId", async () => {
  const popup = loadPopup();
  await seed(popup);
  await popup.importFile(makeFile("第二份.xlsx", [HEADER, ["基本信息", "姓名", "李四"]]));
  const { templates } = await popup.readState();
  popup.setCalls.length = 0;

  await popup.api.StorageService.setActiveTemplate(templates[1].id);

  assert.deepEqual(popup.setCalls, [["activeTemplateId"]]);
});

// 设置页打开时读到的 aiConfig 是旧的；另一处刚保存了新配置，这边再切模板不能把它盖回去。
test("a template change does not write back a stale AI config", async () => {
  const popup = loadPopup();
  await seed(popup);
  const { templates } = await popup.readState();

  await popup.api.StorageService.update((draft) => {
    popup.store.aiConfig = { apiUrl: "https://new.example/v1/chat/completions", model: "new", apiKey: "sk-new" };
    draft.templates = draft.templates.filter((template) => template.id !== templates[0].id);
    return draft;
  });

  assert.equal(popup.store.aiConfig.model, "new");
  assert.ok(popup.setCalls.every((keys) => !keys.includes("aiConfig")));
});

test("saving the AI config writes only aiConfig", async () => {
  const popup = loadPopup();
  await seed(popup);

  await popup.api.StorageService.saveAiConfig({ apiUrl: "https://api.example.com/v1/chat/completions", model: "m2", apiKey: "sk" });

  assert.deepEqual(popup.setCalls, [["aiConfig"]]);
});

test("a parsed resume is stored as the active template, with Excel as an optional download", async () => {
  const { popup, sent } = parsePopup({
    success: true,
    fields: [
      { group: "基本信息", key: "姓名", value: "王五" },
      { group: "基本信息", key: "手机", value: "13800000000" },
      { group: "教育背景", key: "学校", value: "某某大学" }
    ]
  });
  await seed(popup);
  popup.api.popupState.selectedParseFile = { name: "王五简历.txt", content: "王五 13800000000 某某大学" };

  await popup.api.handleParseResumeClick();

  assert.equal(sent.length, 1);
  const state = await popup.readState();
  const parsed = state.templates[0];
  assert.equal(parsed.name, "王五简历（AI 解析）");
  assert.equal(state.activeTemplateId, parsed.id);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed.groups)), [
    { name: "基本信息", fields: [{ key: "姓名", value: "王五" }, { key: "手机", value: "13800000000" }] },
    { name: "教育背景", fields: [{ key: "学校", value: "某某大学" }] }
  ]);
  assert.equal(state.templates.length, 2, "the existing template is kept");
  assert.equal(popup.element("parse-download-button").hidden, false);
  assert.match(popup.lastStatusFrom("parse-status"), /已存为模板「王五简历（AI 解析）」并设为当前，共 3 个字段/);

  const saved = [];
  popup.api.backup.BackupIO.saveWorkbook = (rows) => saved.push(rows);
  popup.api.handleParseDownloadClick();
  assert.equal(saved[0].length, 4);
});

test("a failed parse stores nothing", async () => {
  const { popup } = parsePopup({ success: false, error: "AI 接口请求失败" });
  await seed(popup);
  popup.api.popupState.selectedParseFile = { name: "简历.txt", content: "内容" };

  await popup.api.handleParseResumeClick();

  assert.equal((await popup.readState()).templates.length, 1);
  assert.deepEqual(popup.setCalls, []);
  assert.equal(popup.element("parse-download-button").hidden, true);
});
