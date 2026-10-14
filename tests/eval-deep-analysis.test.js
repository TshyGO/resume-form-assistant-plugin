// #224 评测脚本与语料：模拟模型下的打分要对，真实模式的请求只把 Key 放在请求头，
// 结果不带模型原文；语料本身不能含联系方式、证件号、网址或凭据。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const outline = require("../page-outline.js");

const load = () => import("../scripts/eval-deep-analysis.mjs");

test("mock runs: perfect, empty, invented-ref and forbidden-button outputs score as they should", async () => {
  const evalApi = await load();
  const corpus = evalApi.loadCorpus();
  assert.ok(corpus.length >= 4);
  const perfect = await evalApi.evaluate(corpus, evalApi.mockModel("expected"));
  assert.deepEqual([perfect.total.fieldRecall, perfect.total.fieldPrecision, perfect.total.controlAccuracy, perfect.total.invalidRate],
    [1, 1, 1, 0], "every human annotation passes the plugin's own validation");
  const empty = await evalApi.evaluate(corpus, evalApi.mockModel("empty"));
  assert.equal(empty.total.fieldRecall, 0);
  assert.equal(empty.total.invalidRate, 0);
  const invented = await evalApi.evaluate(corpus, evalApi.mockModel("invalid"));
  assert.equal(invented.total.invalidRate, 1);
  const forbidden = await evalApi.evaluate(corpus, evalApi.mockModel("forbidden"));
  assert.equal(forbidden.total.invalidRate, 1);
  assert.ok(forbidden.total.touchedForbidden >= 1);
});

test("the real-model client sends the plugin's prompt, keeps the key in the header and returns only counts", async () => {
  const evalApi = await load();
  const corpus = evalApi.loadCorpus().slice(0, 1);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    const expected = corpus[0].expected;
    return { ok: true, json: async () => ({ usage: { prompt_tokens: 900, completion_tokens: 120 },
      choices: [{ message: { content: JSON.stringify({ pageState: expected.pageState, fields: expected.fields.slice(0, 2) }) } }] }) };
  };
  const model = evalApi.realModel({ baseUrl: "https://llm.example.test/v1/", model: "m", apiKey: "sk-test-not-real", fetchImpl });
  const result = await evalApi.evaluate(corpus, model);
  assert.equal(requests[0].url, "https://llm.example.test/v1/chat/completions");
  assert.equal(requests[0].init.headers.authorization, "Bearer sk-test-not-real");
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.messages[0].content, require("../deep-analysis.js").ANALYZE_SYSTEM_PROMPT);
  assert.ok(!requests[0].init.body.includes("sk-test-not-real"), "the key is never in the body");
  assert.equal(result.total.promptTokens, 900);
  assert.equal(result.total.fieldPrecision, 1);
  assert.ok(!JSON.stringify(result).includes("sk-test") && !JSON.stringify(result).includes("pageState"), "no key and no model text in the result");
});

test("the corpus outlines carry no contact details, IDs, links, credentials or the synthetic resume values", () => {
  const dir = path.join(__dirname, "fixtures", "sites");
  for (const name of fs.readdirSync(dir).filter((entry) => fs.statSync(path.join(dir, entry)).isDirectory())) {
    const text = fs.readFileSync(path.join(dir, name, "outline.txt"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      for (const quoted of line.match(/"[^"]*"|← .*$/g) || []) {
        assert.equal(outline.sensitiveShape(quoted.replace(/^← |"/g, "")), false, `${name}: ${line}`);
      }
    }
    for (const value of ["林测试", "13900001234", "lin.test@example.com", "示例理工大学"]) assert.ok(!text.includes(value), `${name} leaks ${value}`);
  }
});

test("outlines checked out with CRLF line endings (Windows) parse the same as LF", async () => {
  // PR #271 windows-x64：行尾的 \r 让每一行都解析失败，所有标注都被判为非法。
  const evalApi = await load();
  const lf = "[区块] 基本信息\n  e1 input[text] ← 姓名\n  e2 button \"添加 / Add\"\n";
  const crlf = lf.replace(/\n/g, "\r\n");
  assert.deepEqual([...evalApi.parseOutline(crlf).entries()], [...evalApi.parseOutline(lf).entries()]);
  assert.equal(evalApi.parseOutline(crlf).size, 2);
  const page = { name: "crlf", outline: crlf, expected: { pageState: "editing", fields: [{ ref: "e1", label: "姓名", group: "", control: "text" }] } };
  const result = await evalApi.evaluate([page], evalApi.mockModel("expected"));
  assert.deepEqual([result.total.fieldRecall, result.total.invalidRate], [1, 0]);
});
