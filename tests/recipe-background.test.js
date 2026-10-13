// #226：后台是配方唯一的写入方。所有保存、删除、更新最近使用排成一队；只接受本扩展内容脚本（网页顶层）
// 发来的请求，并且只能写它自己所在网页的那一条。配方不转发、不上传，也不交给桌面。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const recipes = require("../page-recipe.js");

const source = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const KEY = recipes.STORAGE_KEY;

function loadBackground({ failSet = false } = {}) {
  const listeners = [];
  const data = {};
  const sent = [];
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: { id: "ext", getURL: (name) => `chrome-extension://ext/${name}`, getContexts: async () => [], onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: async (message) => { sent.push(message); } },
    storage: { local: {
      get: async (keys) => Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, JSON.parse(JSON.stringify(data[key]))])),
      set: async (values) => { if (failSet) throw new Error("quota"); Object.assign(data, JSON.parse(JSON.stringify(values))); }
    } }
  };
  const context = vm.createContext({ chrome, TextEncoder, URL, console, fetch: () => { throw new Error("no network"); } });
  context.self = context;
  for (const file of ["page-outline.js", "deep-analysis.js", "page-recipe.js"]) vm.runInContext(source(file), context);
  const background = source("background.js")
    .replace(/^import \{ installDesktopLink \} from "\.\/link\/worker\.mjs";$/m, "const installDesktopLink = () => {};")
    .replace(/^import \{ installFeedback \} from "\.\/link\/feedback\.mjs";$/m, "const installFeedback = () => {};")
    .replace(/^import "\.\/[\w-]+\.js";$/gm, "");
  vm.runInContext(background, context);
  // 和 chrome.runtime 一样，回包按 JSON 传回。
  const send = (message, sender) => new Promise((resolve) => {
    const reply = (value) => resolve(value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
    for (const listener of listeners) {
      if (listener(JSON.parse(JSON.stringify(message)), sender, reply) === true) return;
    }
    resolve(undefined);
  });
  return { data, send, sent };
}

function recipe() {
  return { v: 1, created: 1, updated: 1, used: 1, tier: "strong", fp: "0123456789abcdef",
    fields: [{ loc: { s: "", k: "text", sec: "基本信息", t: "姓名" }, control: "text", label: "姓名" }] };
}
const tab = (url, extra = {}) => ({ id: "ext", tab: { id: 3 }, frameId: 0, url, ...extra });
const PAGE = "https://jobs.example.test/apply/2024001?x=1#y";

test("a content script saves, replaces and deletes the recipe of its own page only", async () => {
  const bg = loadBackground();
  const saved = await bg.send({ type: "RECIPE_SAVE", host: "jobs.example.test", path: "/apply/*", recipe: recipe() }, tab(PAGE));
  assert.deepEqual(saved, { ok: true, replaced: false });
  assert.ok(bg.data[KEY].sites["jobs.example.test"]["/apply/*"]);
  assert.deepEqual(await bg.send({ type: "RECIPE_SAVE", host: "jobs.example.test", path: "/apply/*", recipe: recipe() }, tab(PAGE)), { ok: true, replaced: true });
  // 另一个网站、另一条路径、iframe 里、别的扩展、不是网页发来的：一律拒绝。
  for (const [message, sender] of [
    [{ type: "RECIPE_SAVE", host: "other.example.test", path: "/apply/*", recipe: recipe() }, tab(PAGE)],
    [{ type: "RECIPE_SAVE", host: "jobs.example.test", path: "/other", recipe: recipe() }, tab(PAGE)],
    [{ type: "RECIPE_DELETE", host: "jobs.example.test", path: "/apply/*" }, tab(PAGE, { frameId: 2 })],
    [{ type: "RECIPE_DELETE", host: "jobs.example.test", path: "/apply/*" }, tab(PAGE, { id: "someone-else" })],
    [{ type: "RECIPE_DELETE", host: "jobs.example.test", path: "/apply/*" }, { id: "ext", url: PAGE }]
  ]) assert.deepEqual(await bg.send(message, sender), { ok: false, error: "forbidden" });
  assert.deepEqual(Object.keys(bg.data[KEY].sites), ["jobs.example.test"]);
  assert.deepEqual(await bg.send({ type: "RECIPE_DELETE", host: "jobs.example.test", path: "/apply/*" }, tab(PAGE)), { ok: true });
  assert.deepEqual(bg.data[KEY].sites, {});
  assert.deepEqual(bg.sent, [], "nothing is forwarded anywhere");
});

test("concurrent saves from two tabs keep both sites; a storage failure is reported, not hidden", async () => {
  const bg = loadBackground();
  const [a, b] = await Promise.all([
    bg.send({ type: "RECIPE_SAVE", host: "a.example.test", path: "/apply", recipe: recipe() }, tab("https://a.example.test/apply")),
    bg.send({ type: "RECIPE_SAVE", host: "b.example.test", path: "/apply", recipe: recipe() }, tab("https://b.example.test/apply"))
  ]);
  assert.equal(a.ok && b.ok, true);
  assert.deepEqual(Object.keys(bg.data[KEY].sites).sort(), ["a.example.test", "b.example.test"]);
  const broken = loadBackground({ failSet: true });
  assert.deepEqual(await broken.send({ type: "RECIPE_SAVE", host: "a.example.test", path: "/apply", recipe: recipe() }, tab("https://a.example.test/apply")),
    { ok: false, error: "storage_failed", replaced: false });
  // 格式不对的配方（带了别的东西也会被丢掉，缺东西就整份不收）。
  assert.deepEqual(await bg.send({ type: "RECIPE_SAVE", host: "a.example.test", path: "/apply", recipe: { v: 1, fields: [] } }, tab("https://a.example.test/apply")),
    { ok: false, error: "invalid", replaced: true });
});

test("other messages are left to the other listeners", async () => {
  const bg = loadBackground();
  assert.equal(await bg.send({ type: "AI_FILL" }, tab(PAGE)), undefined);
});
