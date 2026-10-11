#!/usr/bin/env node
// #224 深度分析的手动模型评测。读 tests/fixtures/sites/ 下的脱敏大纲和人工标注，
// 用插件同一份系统提示词请求模型，再用插件同一套校验规则打分。
//
// 模拟模型：node scripts/eval-deep-analysis.mjs --mock expected|empty|invalid|forbidden
// 真实模型（会产生费用，不进 CI）：
//   RESUME_PRO_EVAL_API_KEY=... node scripts/eval-deep-analysis.mjs --base-url https://host/v1 --model name --confirm-paid [--runs 1] [--out result.json]
// Key 只从环境变量读；结果文件只有计数、耗时和 token 数，不含模型原文。
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const deep = require("../deep-analysis.js");
const outlineApi = require("../page-outline.js");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KIND_TO_DOM = {
  select: "native-select", "select[multiple]": "native-select", textarea: "textarea", checkbox: "checkbox", "radio-group": "radio",
  "date-picker": "date", combobox: "custom-select", cascader: "cascader", contenteditable: "contenteditable"
};

// 从大纲文字还原校验需要的候选信息：编号、按钮还是控件、DOM 控件类型、按钮文字和标记。
export function parseOutline(text) {
  const nodes = new Map();
  for (const line of String(text).split("\n")) {
    const match = line.match(/^\s+(e\d+) (\S+)(.*)$/);
    if (!match) continue;
    const [, ref, kind, rest] = match;
    if (kind === "button" || kind === "button[submit]" || kind === "link") {
      nodes.set(ref, { type: "button", text: (rest.match(/"([^"]*)"/) || [])[1] || "", submit: kind === "button[submit]", leaves: /跨页/.test(rest) });
      continue;
    }
    let domKind = KIND_TO_DOM[kind];
    if (!domKind && kind.startsWith("input[")) {
      const type = kind.slice(6, -1);
      domKind = ["date", "month", "datetime-local", "time", "week"].includes(type) ? "date" : type === "checkbox" ? "checkbox" : "text";
    }
    nodes.set(ref, { type: "control", domKind: domKind || "unsupported" });
  }
  return nodes;
}

export function loadCorpus(dir = join(ROOT, "tests", "fixtures", "sites")) {
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => {
    const base = join(dir, entry.name);
    if (!existsSync(join(base, "outline.txt")) || !existsSync(join(base, "expected.json"))) return null;
    return { name: entry.name, outline: readFileSync(join(base, "outline.txt"), "utf8"), expected: JSON.parse(readFileSync(join(base, "expected.json"), "utf8")) };
  }).filter(Boolean);
}

// 一份说明书和人工标注比：字段召回、准确、控件类型对不对、有没有碰禁止的按钮。
export function scoreSpec(raw, page) {
  const nodes = parseOutline(page.outline);
  const checked = deep.validateSpec(raw, { nodes, refs: new Set(nodes.keys()), redact: outlineApi.createRedactor([]) });
  const expected = new Map((page.expected.fields || []).map((field) => [field.ref, field]));
  const forbidden = new Set(page.expected.forbiddenRefs || []);
  const touchedForbidden = raw && typeof raw === "object" ? JSON.stringify(raw).match(/"e\d+"/g)?.map((ref) => ref.slice(1, -1)).filter((ref) => forbidden.has(ref)).length || 0 : 0;
  if (!checked.ok) {
    return { valid: false, reason: checked.reason, expected: expected.size, predicted: 0, matched: 0, controlCorrect: 0,
      preActionsExpected: (page.expected.preActions || []).length, preActionsMatched: 0, touchedForbidden };
  }
  const predicted = checked.spec.fields;
  const matched = predicted.filter((field) => expected.has(field.ref));
  const controlCorrect = matched.filter((field) => field.control === expected.get(field.ref).control).length;
  const wantedActions = new Set((page.expected.preActions || []).map((action) => action.ref));
  const preActionsMatched = checked.spec.preActions.filter((action) => wantedActions.has(action.ref)).length;
  return { valid: true, reason: "", expected: expected.size, predicted: predicted.length, matched: matched.length, controlCorrect,
    preActionsExpected: wantedActions.size, preActionsMatched, touchedForbidden };
}

const ratio = (a, b) => (b ? Math.round((a / b) * 1000) / 1000 : null);

export function summarize(rows) {
  const sum = (key) => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const latencies = rows.map((row) => row.ms).filter((ms) => Number.isFinite(ms));
  const tokens = rows.map((row) => row.tokens).filter(Boolean);
  return {
    runs: rows.length,
    fieldRecall: ratio(sum("matched"), sum("expected")),
    fieldPrecision: ratio(sum("matched"), sum("predicted")),
    controlAccuracy: ratio(sum("controlCorrect"), sum("matched")),
    preActionRecall: ratio(sum("preActionsMatched"), sum("preActionsExpected")),
    invalidRate: ratio(rows.filter((row) => !row.valid).length, rows.length),
    touchedForbidden: sum("touchedForbidden"),
    avgMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    promptTokens: tokens.length ? tokens.reduce((total, item) => total + (item.prompt || 0), 0) : null,
    completionTokens: tokens.length ? tokens.reduce((total, item) => total + (item.completion || 0), 0) : null
  };
}

// 模拟模型：expected 原样给出标注；empty 什么都没认出；invalid 编造编号；forbidden 把提交按钮放进前置动作。
export function mockModel(kind) {
  return async (page) => {
    const nodes = parseOutline(page.outline);
    if (kind === "empty") return { text: JSON.stringify({ pageState: page.expected.pageState, fields: [] }) };
    if (kind === "invalid") return { text: JSON.stringify({ pageState: "editing", fields: [{ ref: "e9999", control: "text" }] }) };
    if (kind === "forbidden") {
      const target = [...nodes.entries()].find(([, node]) => node.type === "button" && node.submit)?.[0] || "e1";
      return { text: JSON.stringify({ pageState: "viewing", preActions: [{ ref: target, kind: "edit" }] }) };
    }
    return { text: JSON.stringify({ pageState: page.expected.pageState, preActions: page.expected.preActions || [], fields: page.expected.fields }) };
  };
}

// OpenAI 兼容接口，与桌面发出的请求同形（system + user，非流式）。
export function realModel({ baseUrl, model, apiKey, fetchImpl = fetch }) {
  return async (page) => {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, temperature: 0, messages: [
        { role: "system", content: deep.ANALYZE_SYSTEM_PROMPT },
        { role: "user", content: deep.analyzeUserPrompt(page.outline, 1, 1) }
      ] })
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const body = await response.json();
    const usage = body.usage ? { prompt: body.usage.prompt_tokens || 0, completion: body.usage.completion_tokens || 0 } : null;
    return { text: body.choices?.[0]?.message?.content || "", tokens: usage };
  };
}

export async function evaluate(corpus, model, { runs = 1, now = () => performance.now() } = {}) {
  const rows = [];
  for (const page of corpus) {
    for (let run = 0; run < runs; run++) {
      const started = now();
      let reply;
      try {
        reply = await model(page);
      } catch (error) {
        rows.push({ page: page.name, run, valid: false, reason: String(error?.message || "request_failed").slice(0, 40), expected: (page.expected.fields || []).length,
          predicted: 0, matched: 0, controlCorrect: 0, preActionsExpected: 0, preActionsMatched: 0, touchedForbidden: 0, ms: now() - started, tokens: null });
        continue;
      }
      const ms = now() - started;
      let raw = null;
      try { raw = deep.parseSpecText(reply.text); } catch { raw = null; }
      const score = raw ? scoreSpec(raw, page) : { valid: false, reason: "bad_json", expected: (page.expected.fields || []).length,
        predicted: 0, matched: 0, controlCorrect: 0, preActionsExpected: 0, preActionsMatched: 0, touchedForbidden: 0 };
      rows.push({ page: page.name, run, ...score, ms: Math.round(ms), tokens: reply.tokens || null });
    }
  }
  const byPage = Object.fromEntries(corpus.map((page) => [page.name, summarize(rows.filter((row) => row.page === page.name))]));
  return { total: summarize(rows), byPage, rows };
}

async function main(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : "";
  };
  const corpus = loadCorpus(option("--corpus") || undefined);
  const runs = Math.max(1, Math.min(10, Number(option("--runs")) || 1));
  let model;
  let label;
  if (option("--mock")) {
    model = mockModel(option("--mock"));
    label = `mock:${option("--mock")}`;
  } else {
    const baseUrl = option("--base-url");
    const name = option("--model");
    const apiKey = process.env.RESUME_PRO_EVAL_API_KEY || "";
    if (!baseUrl || !name || !apiKey) {
      console.error("真实模型评测需要 --base-url、--model 和环境变量 RESUME_PRO_EVAL_API_KEY；只想检查流程请用 --mock expected。");
      process.exit(2);
    }
    if (!argv.includes("--confirm-paid")) {
      console.error(`这会向 ${new URL(baseUrl).host} 发送 ${corpus.length * runs} 次请求并产生费用。确认后加上 --confirm-paid 再运行。`);
      process.exit(2);
    }
    model = realModel({ baseUrl, model: name, apiKey });
    label = `${new URL(baseUrl).host} / ${name}`;
  }
  const result = await evaluate(corpus, model, { runs });
  const output = { model: label, at: new Date().toISOString(), corpus: corpus.map((page) => page.name), runs, ...result };
  console.log(`模型：${label}；语料 ${corpus.length} 份 × ${runs} 次`);
  console.table(Object.fromEntries([...Object.entries(result.byPage), ["合计", result.total]].map(([name, summary]) => [name, {
    召回: summary.fieldRecall, 准确: summary.fieldPrecision, 控件类型: summary.controlAccuracy, 前置动作: summary.preActionRecall,
    非法输出: summary.invalidRate, 碰禁止按钮: summary.touchedForbidden, 平均毫秒: summary.avgMs,
    输入token: summary.promptTokens, 输出token: summary.completionTokens
  }])));
  if (option("--out")) writeFileSync(option("--out"), `${JSON.stringify(output, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`评测没有完成：${error?.message || error}`);
    process.exit(1);
  });
}
