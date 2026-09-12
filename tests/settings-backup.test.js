const test = require("node:test");
const assert = require("node:assert/strict");

const { HEADER, loadPopup, makeFile, makeTextFile } = require("./helpers/popup-harness.js");

function backupApi(popup) {
  const api = popup.api.backup;
  assert.ok(api, "popup.js 需要在测试模式下暴露备份相关的内部函数");
  return api;
}

// 备份不真的下载文件，改成记在数组里，测试才看得到导出的内容。
function captureDownloads(popup) {
  const saved = [];
  const io = backupApi(popup).BackupIO;
  io.saveJson = (fileName, data) => saved.push({ kind: "json", fileName, data });
  io.saveWorkbook = (rows, fileName) => saved.push({ kind: "xlsx", fileName, rows });
  return saved;
}

async function seed(popup, { templateCount = 1, apiKey = "sk-old" } = {}) {
  for (let index = 0; index < templateCount; index += 1) {
    await popup.importFile(
      makeFile(`简历${index + 1}.xlsx`, [
        HEADER,
        ["基本信息", `姓名${index + 1}`, `张三${index + 1}`],
        ["教育经历", "学校", "某某大学"]
      ])
    );
  }

  const state = await popup.readState();
  state.aiConfig = { apiUrl: "https://api.example.com/v1", model: "gpt-4o-mini", apiKey };
  await popup.writeState(state);
  return popup.readState();
}

test("导出的备份带上模板、当前模板和 AI 配置", async () => {
  const popup = loadPopup();
  const saved = captureDownloads(popup);
  const state = await seed(popup, { templateCount: 2 });

  await backupApi(popup).handleExportBackup();

  assert.equal(saved.length, 1);
  assert.match(saved[0].fileName, /^resume-pro-backup-\d{8}\.json$/);

  const backup = saved[0].data;
  assert.equal(backup.format, "resume-pro.backup");
  assert.equal(backup.formatVersion, 1);
  assert.equal(backup.templates.length, 2);
  assert.equal(backup.activeTemplateId, state.activeTemplateId);
  assert.equal(backup.aiConfig.apiUrl, "https://api.example.com/v1");
  assert.equal(backup.aiConfig.model, "gpt-4o-mini");
});

test("API Key 默认不进备份，勾选之后才写进去", async () => {
  const popup = loadPopup();
  const saved = captureDownloads(popup);
  await seed(popup);

  await backupApi(popup).handleExportBackup();
  assert.equal("apiKey" in saved[0].data.aiConfig, false, "默认导出不应该带上 API Key");

  popup.element("backup-include-key").checked = true;
  await backupApi(popup).handleExportBackup();
  assert.equal(saved[1].data.aiConfig.apiKey, "sk-old");
});

test("没有模板时不导出空备份", async () => {
  const popup = loadPopup();
  const saved = captureDownloads(popup);

  await backupApi(popup).handleExportBackup();

  assert.equal(saved.length, 0);
  assert.match(popup.lastStatusFrom("backup-status"), /还没有/);
});

test("导入的文件不是备份时给出能看懂的提示", async () => {
  const popup = loadPopup();
  const api = backupApi(popup);

  await api.handleBackupFileSelection({ target: { files: [makeTextFile("a.json", "{ 坏掉的")] } });
  assert.match(popup.lastStatusFrom("backup-status"), /JSON/);

  await api.handleBackupFileSelection({
    target: { files: [makeTextFile("b.json", JSON.stringify({ hello: "world" }))] }
  });
  assert.match(popup.lastStatusFrom("backup-status"), /不是 Resume Pro 的备份文件/);
});

test("备份来自更新的版本时拒绝导入", async () => {
  const popup = loadPopup();
  const file = makeTextFile(
    "c.json",
    JSON.stringify({ format: "resume-pro.backup", formatVersion: 99, templates: [] })
  );

  await backupApi(popup).handleBackupFileSelection({ target: { files: [file] } });

  assert.match(popup.lastStatusFrom("backup-status"), /更新/);
});

test("空插件导入备份就是直接恢复，不用再问", async () => {
  const source = loadPopup();
  const saved = captureDownloads(source);
  const sourceState = await seed(source, { templateCount: 2 });
  source.element("backup-include-key").checked = true;
  await backupApi(source).handleExportBackup();
  const text = JSON.stringify(saved[0].data);

  const fresh = loadPopup();
  await backupApi(fresh).handleBackupFileSelection({
    target: { files: [makeTextFile("backup.json", text)] }
  });

  const restored = await fresh.readState();
  assert.equal(restored.templates.length, 2);
  assert.deepEqual(
    restored.templates.map((template) => template.name),
    sourceState.templates.map((template) => template.name)
  );
  assert.equal(restored.aiConfig.apiUrl, "https://api.example.com/v1");
  assert.equal(restored.aiConfig.apiKey, "sk-old");
  assert.equal(fresh.element("backup-confirm").hidden, true, "没有旧模板就不该弹出选择");
});

test("已经有模板时先问追加还是替换", async () => {
  const popup = loadPopup();
  const saved = captureDownloads(popup);
  await seed(popup, { templateCount: 1 });
  await backupApi(popup).handleExportBackup();
  const text = JSON.stringify(saved[0].data);

  const before = await popup.readState();
  await backupApi(popup).handleBackupFileSelection({
    target: { files: [makeTextFile("backup.json", text)] }
  });

  assert.equal(popup.element("backup-confirm").hidden, false);
  const after = await popup.readState();
  assert.equal(after.templates.length, before.templates.length, "选择之前不应该改动任何东西");
});

test("追加会保留原有模板，并给同名的加上后缀", async () => {
  const popup = loadPopup();
  const saved = captureDownloads(popup);
  await seed(popup, { templateCount: 1 });
  await backupApi(popup).handleExportBackup();
  const text = JSON.stringify(saved[0].data);

  const api = backupApi(popup);
  await api.handleBackupFileSelection({ target: { files: [makeTextFile("backup.json", text)] } });
  await api.commitPendingBackup("append");

  const state = await popup.readState();
  assert.equal(state.templates.length, 2);
  assert.equal(new Set(state.templates.map((template) => template.id)).size, 2, "id 不能重复");
  assert.notEqual(state.templates[0].name, state.templates[1].name);
  assert.equal(popup.element("backup-confirm").hidden, true);
});

test("替换会清掉现有模板", async () => {
  const popup = loadPopup();
  const saved = captureDownloads(popup);
  await seed(popup, { templateCount: 1 });
  await backupApi(popup).handleExportBackup();
  const text = JSON.stringify(saved[0].data);

  await popup.importFile(makeFile("另一份.xlsx", [HEADER, ["基本信息", "姓名", "李四"]]));
  assert.equal((await popup.readState()).templates.length, 2);

  const api = backupApi(popup);
  await api.handleBackupFileSelection({ target: { files: [makeTextFile("backup.json", text)] } });
  await api.commitPendingBackup("replace");

  const state = await popup.readState();
  assert.equal(state.templates.length, 1);
  assert.equal(state.templates[0].name, "简历1");
});

test("备份里没有 API Key 时不会把现有的 Key 清掉", async () => {
  const popup = loadPopup();
  const saved = captureDownloads(popup);
  await seed(popup, { templateCount: 1, apiKey: "sk-keep" });
  await backupApi(popup).handleExportBackup();
  const text = JSON.stringify(saved[0].data);

  const api = backupApi(popup);
  await api.handleBackupFileSelection({ target: { files: [makeTextFile("backup.json", text)] } });
  await api.commitPendingBackup("replace");

  assert.equal((await popup.readState()).aiConfig.apiKey, "sk-keep");
});

test("导出的 Excel 能被导入原样解析回来", async () => {
  const popup = loadPopup();
  const saved = captureDownloads(popup);
  await popup.importFile(
    makeFile("我的简历.xlsx", [
      HEADER,
      ["基本信息", "姓名", "张三"],
      ["基本信息", "手机", "13800000000"],
      ["教育经历", "学校", "某某大学"]
    ])
  );
  const before = await popup.readState();

  await popup.api.handleTemplateListClick({
    target: {
      closest: (selector) =>
        selector === ".template-item"
          ? { dataset: { templateId: before.templates[0].id } }
          : { dataset: { action: "export" } }
    }
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0].fileName, "我的简历.xlsx", "文件名要能直接再导入回同一个模板名");

  const roundTrip = loadPopup();
  await roundTrip.importFile(makeFile(saved[0].fileName, saved[0].rows));

  const after = await roundTrip.readState();
  // 两份状态来自不同的 vm 上下文，原型对不上，比字符串。
  assert.equal(
    JSON.stringify(after.templates[0].groups),
    JSON.stringify(before.templates[0].groups)
  );
  assert.equal(after.templates[0].name, before.templates[0].name);
});

test("模板名里的非法字符不会进文件名", async () => {
  const popup = loadPopup();
  const api = backupApi(popup);

  assert.equal(api.templateExportFileName("研发/后端:2026?"), "研发后端2026.xlsx");
  assert.equal(api.templateExportFileName("   "), "简历模板.xlsx");
});
