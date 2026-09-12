const test = require("node:test");
const assert = require("node:assert/strict");

const { HEADER, loadPopup, makeFile } = require("./helpers/popup-harness.js");

function templateRows(count, groupName = "基本信息") {
  return Array.from({ length: count }, (_, index) => [groupName, `字段${index + 1}`, `值${index + 1}`]);
}

test("追加到 Excel 里的行会进入模板", async () => {
  const popup = loadPopup();

  await popup.importFile(makeFile("resume_parsed_20260910.xlsx", [HEADER, ...templateRows(62)]));
  const afterFirst = await popup.readState();
  assert.equal(popup.countFields(afterFirst.templates[0]), 62);

  await popup.importFile(
    makeFile("resume_parsed_20260910.xlsx", [
      HEADER,
      ...templateRows(62),
      ["基本信息", "政治面貌", "群众"],
      ["基本信息", "婚姻状况", "未婚"],
      ["其他", "期望薪资", "20k"]
    ]),
    { reimportTemplateId: afterFirst.templates[0].id }
  );

  const afterReimport = await popup.readState();
  assert.equal(afterReimport.templates.length, 1);
  assert.equal(popup.countFields(afterReimport.templates[0]), 65);
});

test("重新导入的提示写明新旧字段数量", async () => {
  const popup = loadPopup();

  await popup.importFile(makeFile("我的简历.xlsx", [HEADER, ...templateRows(62)]));
  const state = await popup.readState();

  await popup.importFile(
    makeFile("我的简历.xlsx", [HEADER, ...templateRows(62), ["其他", "期望薪资", "20k"]]),
    { reimportTemplateId: state.templates[0].id }
  );

  const message = popup.lastStatus();
  assert.match(message, /63/, "提示里应该有新的字段数量");
  assert.match(message, /62/, "提示里应该有原来的字段数量");
});

test("字段数量没有变化时提示用户确认选对了文件", async () => {
  const popup = loadPopup();

  await popup.importFile(makeFile("我的简历.xlsx", [HEADER, ...templateRows(62)]));
  const state = await popup.readState();

  await popup.importFile(makeFile("我的简历.xlsx", [HEADER, ...templateRows(62)]), {
    reimportTemplateId: state.templates[0].id
  });

  assert.match(popup.lastStatus(), /数量没有变化/);
});

test("首次导入的提示也带上字段数量", async () => {
  const popup = loadPopup();

  await popup.importFile(makeFile("我的简历.xlsx", [HEADER, ...templateRows(62)]));

  assert.match(popup.lastStatus(), /62/);
});

test("缺少字段名时说明本次导入未生效并列出所有问题行", async () => {
  const popup = loadPopup();

  await popup.importFile(makeFile("我的简历.xlsx", [HEADER, ...templateRows(62)]));
  const state = await popup.readState();

  await popup.importFile(
    makeFile("我的简历.xlsx", [
      HEADER,
      ...templateRows(62),
      ["基本信息", "", "群众"],
      ["基本信息", "婚姻状况", "未婚"],
      ["其他", "", "20k"]
    ]),
    { reimportTemplateId: state.templates[0].id }
  );

  const message = popup.lastStatus();
  assert.match(message, /64/, "应该指出第一处问题行");
  assert.match(message, /66/, "应该一次列出全部问题行，而不是只报第一处");
  assert.match(message, /未生效/, "应该说明这次导入没有生效");

  const afterFailure = await popup.readState();
  assert.equal(popup.countFields(afterFailure.templates[0]), 62, "失败后模板保持原样");
});

test("问题行较多时仍然逐个列出行号", async () => {
  const popup = loadPopup();
  const brokenRows = Array.from({ length: 20 }, () => ["基本信息", "", "群众"]);

  await popup.importFile(makeFile("我的简历.xlsx", [HEADER, ...templateRows(5), ...brokenRows]));

  const message = popup.lastStatus();
  assert.match(message, /第 7、8、/, "应该从第一处问题行开始逐个列出");
  assert.match(message, /26 行/, "最后一处问题行也要列出来，否则用户改完还会再失败一次");
});

test("整列错位时不刷屏，改成提示检查整列", async () => {
  const popup = loadPopup();
  const brokenRows = Array.from({ length: 21 }, () => ["基本信息", "", "群众"]);

  await popup.importFile(makeFile("我的简历.xlsx", [HEADER, ...templateRows(5), ...brokenRows]));

  const message = popup.lastStatus();
  assert.match(message, /共 21 行/);
  assert.match(message, /整列错位/);
  assert.doesNotMatch(message, /第 7、8、/, "行号太多时不应该整片列出来");
});

test("新建模板时同名会加上区分后缀", async () => {
  const popup = loadPopup();

  await popup.importFile(makeFile("resume_parsed_20260910.xlsx", [HEADER, ...templateRows(62)]));
  await popup.importFile(
    makeFile("resume_parsed_20260910.xlsx", [HEADER, ...templateRows(62), ["其他", "期望薪资", "20k"]])
  );

  const state = await popup.readState();
  assert.equal(state.templates.length, 2);
  const names = state.templates.map((template) => template.name);
  assert.notEqual(names[0], names[1], "两份模板不应该显示成一模一样的名字");
});
