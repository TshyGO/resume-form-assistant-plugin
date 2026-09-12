// popup.js 没有构建步骤，测试用 vm 把它跑在一个最小的假 DOM 里。
// 模板导入和设置备份两组测试共用这里的加载器。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const HEADER = ["一级分类", "字段名", "值"];

function loadXlsx() {
  const context = { console, window: {} };
  context.self = context;
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "xlsx.full.min.js"), "utf8"), context);
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

function makeTextFile(name, text) {
  return { name, text: async () => text };
}

function loadPopup({ globals = {} } = {}) {
  const store = {};
  const statusMessages = [];
  let uuidCounter = 0;

  function createElement(id) {
    return {
      id,
      value: "",
      type: "text",
      checked: false,
      hidden: false,
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
    createElement: () => createElement("created"),
    querySelectorAll: () => [],
    addEventListener() {}
  };

  const context = {
    console,
    document,
    XLSX,
    // popup.html 里由 ai-models.js 提供，renderConfig 每次都会调到。
    ResumeProModels: {
      describeTransportRisk: () => null,
      normalizeApiUrlForSave: (typed) => typed
    },
    __RESUME_PRO_TEST__: true,
    crypto: { randomUUID: () => `template-${++uuidCounter}` },
    setTimeout,
    clearTimeout,
    structuredClone,
    Blob,
    URL,
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

  Object.assign(context, globals);

  context.self = context;
  context.window = context;
  context.globalThis = context;

  vm.runInNewContext(fs.readFileSync(path.join(ROOT, "popup.js"), "utf8"), context, {
    filename: "popup.js"
  });

  const api = context.self.ResumeProTemplateImportTest;
  assert.ok(api, "popup.js 需要在测试模式下暴露导入相关的内部函数");
  api.cacheElements();

  return {
    api,
    element: (id) => document.getElementById(id),
    statusMessages,
    lastStatus: () => statusMessages.at(-1)?.message || "",
    lastStatusFrom: (id) => statusMessages.filter((entry) => entry.id === id).at(-1)?.message || "",
    async importFile(file, { reimportTemplateId = "" } = {}) {
      api.popupState.reimportTemplateId = reimportTemplateId;
      await api.handleFileSelection({ target: { files: [file] } });
    },
    async readState() {
      return api.StorageService.getState();
    },
    async writeState(state) {
      return api.StorageService.saveState(state);
    },
    countFields(template) {
      return api.countTemplateFields(template);
    }
  };
}

module.exports = { HEADER, XLSX, loadPopup, loadXlsx, makeFile, makeTextFile };
