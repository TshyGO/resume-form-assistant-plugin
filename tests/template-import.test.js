const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const HEADER = ["一级分类", "字段名", "值"];

function loadXlsx() {
  const context = { console, window: {} };
  context.self = context;
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "xlsx.full.min.js"), "utf8"), context);
  return context.XLSX || context.window.XLSX;
}

const XLSX = loadXlsx();

function makeFile(name, aoa) {
  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "简历模板");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return { name, arrayBuffer: async () => buffer };
}

function templateRows(count, groupName = "基本信息") {
  return Array.from({ length: count }, (_, index) => [groupName, `字段${index + 1}`, `值${index + 1}`]);
}

function loadPopup() {
  const store = {};
  const statusMessages = [];
  let uuidCounter = 0;

  function createElement(id) {
    return {
      id,
      value: "",
      type: "text",
      innerHTML: "",
      className: "",
      dataset: {},
      classList: { add() {}, remove() {}, toggle: () => false, contains: () => false },
      addEventListener() {},
      click() {},
      closest: () => null,
      querySelectorAll: () => [],
      set textContent(value) {
        if (value) statusMessages.push({ id, message: value });
      },
      get textContent() {
        return "";
      }
    };
  }

  const elementsById = new Map();
  const document = {
    getElementById(id) {
      if (!elementsById.has(id)) elementsById.set(id, createElement(id));
      return elementsById.get(id);
    },
    querySelectorAll: () => [],
    addEventListener() {}
  };

  const context = {
    console,
    document,
    XLSX,
    __RESUME_PRO_TEST__: true,
    crypto: { randomUUID: () => `template-${++uuidCounter}` },
    setTimeout,
    clearTimeout,
    structuredClone,
    fetch: async () => {
      throw new Error("网络在测试中不可用");
    },
    chrome: {
      runtime: { getManifest: () => ({ version: "0.3.0" }), getURL: (value) => value },
      storage: {
        local: {
          async get(keys) {
            if (keys === null || keys === undefined) return structuredClone(store);
            const result = {};
            for (const key of [].concat(keys)) {
              if (key in store) result[key] = structuredClone(store[key]);
            }
            return result;
          },
          async set(values) {
            for (const [key, value] of Object.entries(values)) {
              store[key] = structuredClone(value);
            }
          }
        },
        onChanged: { addListener() {} }
      }
    }
  };

  context.self = context;
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8"), context, {
    filename: "popup.js"
  });

  const api = context.self.ResumeProTemplateImportTest;
  assert.ok(api, "popup.js 需要在测试模式下暴露导入相关的内部函数");
  api.cacheElements();

  return {
    api,
    statusMessages,
    lastStatus: () => statusMessages.at(-1)?.message || "",
    async importFile(file, { reimportTemplateId = "" } = {}) {
      api.popupState.reimportTemplateId = reimportTemplateId;
      await api.handleFileSelection({ target: { files: [file] } });
    },
    async readState() {
      return api.StorageService.getState();
    },
    countFields(template) {
      return api.countTemplateFields(template);
    }
  };
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
