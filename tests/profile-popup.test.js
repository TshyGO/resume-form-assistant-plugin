const test = require("node:test");
const assert = require("node:assert/strict");

const { HEADER, loadPopup: loadPopupRaw, makeFile, makeTextFile } = require("./helpers/popup-harness.js");

let secretFields;

test.before(async () => {
  secretFields = await import("../link/secret-fields.mjs");
});

function loadPopup() {
  const popup = loadPopupRaw({ globals: { ResumeProSecretFields: secretFields } });
  const saved = [];
  popup.api.backup.BackupIO.saveJson = (fileName, data) => saved.push(JSON.parse(JSON.stringify(data)));
  return { popup, saved };
}

async function seedTemplate(popup) {
  await popup.importFile(makeFile("简历.xlsx", [HEADER, ["基本信息", "姓名", "模板里的张三"]]));
}

async function restore(popup, backup, mode) {
  await popup.api.backup.handleBackupFileSelection({
    target: { files: [makeTextFile("backup.json", JSON.stringify(backup))] }
  });
  if (mode) await popup.api.backup.commitPendingBackup(mode);
  return popup.readState();
}

test("saving 我的信息 writes only the profile key and says what is still empty", async () => {
  const { popup } = loadPopup();
  await seedTemplate(popup);
  popup.setCalls.length = 0;

  await popup.api.profile.saveProfile({
    values: { name: "张三" },
    family: [],
    custom: [{ key: "是否有亲属在本行工作", value: "" }]
  });

  assert.deepEqual(JSON.parse(JSON.stringify(popup.setCalls)), [["profile"]]);
  const state = await popup.readState();
  assert.equal(state.profile.values.name, "张三");
  assert.equal(state.templates.length, 1);
  assert.match(popup.lastStatusFrom("profile-status"), /已保存 1 项，还有 1 个字段没填内容/);
});

test("a fresh install also gets an empty profile written", async () => {
  const { popup } = loadPopup();

  await popup.api.StorageService.ensureDefaults();

  assert.ok(popup.setCalls[0].includes("profile"));
  assert.deepEqual(JSON.parse(JSON.stringify(popup.store.profile)), { values: {}, family: [], custom: [] });
});

test("backups carry 我的信息, minus anything that looks like a password", async () => {
  const { popup, saved } = loadPopup();
  await seedTemplate(popup);
  await popup.api.profile.saveProfile({
    values: { name: "张三", ethnicity: "汉族" },
    family: [{ relation: "父亲", name: "张父" }],
    custom: [{ key: "网银登录密码", value: "hunter2" }, { key: "职业规划", value: "银行" }]
  });

  await popup.api.backup.handleExportBackup();

  assert.equal(saved.length, 1);
  const backup = saved[0];
  assert.equal(backup.profile.values.ethnicity, "汉族");
  assert.equal(backup.profile.family[0].name, "张父");
  assert.deepEqual(backup.profile.custom, [{ key: "职业规划", value: "银行" }]);
  assert.doesNotMatch(JSON.stringify(backup), /hunter2/);
  assert.match(popup.lastStatusFrom("backup-status"), /已导出 1 个模板和我的信息，跳过 1 个/);
});

test("with only 我的信息 and no template, a backup can still be exported and restored", async () => {
  const { popup, saved } = loadPopup();
  await popup.api.profile.saveProfile({ values: { name: "张三" }, family: [], custom: [] });

  await popup.api.backup.handleExportBackup();
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0].templates, []);

  const { popup: fresh } = loadPopup();
  const state = await restore(fresh, saved[0]);
  assert.equal(state.profile.values.name, "张三");
  assert.match(fresh.lastStatusFrom("backup-status"), /已恢复 我的信息/);
});

test("replacing with a profile-only backup keeps this machine's templates", async () => {
  const { popup } = loadPopup();
  await seedTemplate(popup);
  const before = await popup.readState();

  const state = await restore(popup, {
    format: "resume-pro.backup",
    formatVersion: 1,
    templates: [],
    profile: { values: { name: "备份里的张三" } }
  }, "replace");

  assert.equal(state.templates.length, 1);
  assert.equal(state.activeTemplateId, before.activeTemplateId);
  assert.equal(state.profile.values.name, "备份里的张三");
});

test("appending a backup only fills in what 我的信息 is missing", async () => {
  const { popup } = loadPopup();
  await seedTemplate(popup);
  await popup.api.profile.saveProfile({ values: { name: "本机" }, family: [], custom: [] });

  const state = await restore(popup, {
    format: "resume-pro.backup",
    formatVersion: 1,
    templates: [],
    profile: { values: { name: "备份", ethnicity: "汉族" } }
  }, "append");

  assert.equal(state.profile.values.name, "本机");
  assert.equal(state.profile.values.ethnicity, "汉族");
});

test("an older backup without 我的信息 leaves this machine's profile alone", async () => {
  const { popup } = loadPopup();
  await seedTemplate(popup);
  await popup.api.profile.saveProfile({ values: { name: "本机" }, family: [], custom: [] });

  const state = await restore(popup, {
    format: "resume-pro.backup",
    formatVersion: 1,
    templates: [{ id: "old", name: "旧模板", groups: [{ name: "基本信息", fields: [{ key: "姓名", value: "王五" }] }] }]
  }, "replace");

  assert.deepEqual(state.templates.map((template) => template.name), ["旧模板"]);
  assert.equal(state.profile.values.name, "本机");
});
