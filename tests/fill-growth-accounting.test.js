// #301：选完某项后才出现的字段（#269）要和首轮字段一样记账——结果、状态行、诊断、留档和「加到我的信息」。
// 补填没拿到值时按首轮的口径分：AI 未匹配不算失败；请求失败、两轮用完、首轮 AI 已经失败的，请用户自己补。
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadHighlightHelpers, fakeFieldScan } = require("./helpers/content-harness");
const { createStack, until } = require("./helpers/fill-archive-harness.js");
const feedback = require("../feedback-core.js");
const aiHelpers = require("../ai-helpers.js");

const APP = "11111111-1111-4111-8111-111111111111";
const COMPANY = "金发科技股份有限公司";
const TIMEOUT = "AI 服务商等了 120 秒没有返回，请稍后重试。";
const STOPPED = "已停止后续填写，请核对网页中已填写的内容。";

function control(element, overrides = {}) {
  return { kind: "element", controlKind: "text", element, elements: [element], root: element, item: element,
    label: "", labelSource: "item", section: "", group: "", repeatIndex: 0, offerable: true, offerLabel: "",
    pickerType: "", rangePart: "", placeholder: "", ...overrides };
}

// The worker's diagnostics for one AI request (ai-worker.js handleAiFill), the AI called.
const diag = (extra = {}) => ({ ruleMatches: 0, aiFields: 1, candidateFields: 2, resumeFields: 3, apiMs: 5, promptBytes: 300,
  errorCode: "none", aiMatches: 0, skippedSecret: 0, secretFormFields: 0, skippedOversized: 0, skippedNoContext: 0, ...extra });
// AI replies in the worker's shape: `values` by field label.
const answer = (values) => (message) => {
  const matches = message.formFields.filter((field) => values[field.label] !== undefined)
    .map((field) => ({ fieldId: field.fieldId, value: values[field.label] }));
  return { success: true, matches, warning: "", error: "",
    diagnostics: diag({ aiFields: message.formFields.length, aiMatches: matches.length }) };
};
const empty = answer({});
const timedOut = (message) => ({ success: false, matches: [], warning: TIMEOUT, error: TIMEOUT,
  diagnostics: diag({ aiFields: message.formFields.length, errorCode: "timeout", apiMs: 120000 }) });

// Like grownForm in field-scan-content.test.js, with every AI reply under the test's control.
// `first` are the controls on the page from the start; choosing the first one reveals generations[0],
// and a generation led by a select reveals the next one once that select is chosen.
function grownForm({ first = [{ label: "学历", option: "本科" }], generations = [[{ label: "研究方向" }]], section = "教育经历",
  firstReply = null, catchUp = empty, onRescan = null, archive = false } = {}) {
  const h = { requests: [], location: { href: "https://jobs.example.test/apply", pathname: "/apply" } };
  const ui = { status: { textContent: "", className: "" }, offer: { hidden: true }, offerText: { textContent: "" },
    cancel: { hidden: true, disabled: false, onclick: null }, diagText: { value: "" }, recordSummary: { textContent: "" } };
  ui.status.classList = { contains: (name) => String(ui.status.className).split(/\s+/).includes(name) };
  ui.offer.querySelector = () => ui.offerText;
  const diagPanel = { hidden: true, open: false, querySelector: (s) => (s === "#resume-pro-diagnostics-text" ? ui.diagText : null) };
  const recordCard = { hidden: true, querySelector: (s) => (s === "#resume-pro-fill-record-summary" ? ui.recordSummary : null) };
  const parts = { "#resume-pro-status": ui.status, "#resume-pro-profile-offer": ui.offer, "#resume-pro-cancel-fill": ui.cancel,
    "#resume-pro-diagnostics": diagPanel, "#resume-pro-diagnostics-text": ui.diagText,
    ...(archive ? { "#resume-pro-fill-record": recordCard } : {}) };
  const firstValues = Object.fromEntries(first.filter((item) => item.option).map((item) => [item.label, item.option]));
  const sendMessage = async (message) => {
    if (message.type === "DESKTOP_LINK_STATE") return { everPaired: true };
    if (message.type === "CANCEL_AI_FILL") return { cancelled: true };
    if (message.type !== "AI_FILL") return { success: true, matches: [] };
    h.requests.push(JSON.parse(JSON.stringify(message)));
    if (h.requests.length === 1) return (firstReply || answer(firstValues))(message);
    return catchUp(message, h);
  };
  let scans = 0;
  const ctx = loadHighlightHelpers({ formElements: [], aiHelpers, feedback, sendMessage, location: h.location,
    fieldScan: { ...fakeFieldScan(), isBindingCurrent: (binding) => binding.element.isConnected !== false,
      scanPage: () => {
        scans += 1;
        if (scans > 1) onRescan?.(h);
        const controls = visible();
        return { controls, skipped: { pageChrome: 0, popup: 0, merged: 0, siteSearch: 0, outsideForm: 0, noLabel: 0 },
          sources: { item: controls.length } };
      } } });
  const select = (option) => Object.assign(new ctx.HTMLSelectElement(), { tagName: "SELECT",
    options: [{ value: "", text: "请选择" }, { value: "a", text: option }], selectedIndex: 0 });
  const node = (item, overrides) => {
    const el = item.option ? select(item.option) : new ctx.HTMLInputElement();
    return { el, ctl: control(el, { label: item.label, controlKind: item.option ? "select" : "text", ...overrides }) };
  };
  const firsts = first.map((item) => node(item, { section: "教育经历" }));
  const gens = generations.map((gen) => gen.map((item) => node(item, { section, offerLabel: item.label })));
  function visible() {
    const list = firsts.map((item) => item.ctl);
    let open = firsts[0].el.selectedIndex > 0;
    for (const gen of gens) {
      if (!open) break;
      list.push(...gen.map((item) => item.ctl));
      open = gen[0].el.tagName === "SELECT" && gen[0].el.selectedIndex > 0;
    }
    return list.filter((item) => item.element.isConnected !== false);
  }
  ctx.helpers.setCurrentStore({ templates: [{ id: "t", name: "模板", groups: [{ name: "教育经历",
    fields: [{ key: "学历", value: "本科" }, { key: "学位", value: "学士" }, { key: "研究课题", value: "示例方向" }] }] }], activeTemplateId: "t" });
  ctx.helpers.setShadowRoot({ querySelector: (s) => parts[s] || null, querySelectorAll: () => [] });
  return Object.assign(h, { ctx, ui, firsts, gens,
    // The side panel's 停止 during the fill: the same handler a real click runs.
    pressStop() { ui.cancel.onclick?.(); },
    async run() {
      const result = await ctx.helpers.handleAiFillClick({ currentTarget: { disabled: false, textContent: "" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const report = (await ctx.sendPanelMessage({ type: "RESUME_PANEL_STATUS" }))?.diagnosticsReport || "";
      const auto = ctx.desktopMessages.filter((message) => message.type === "FEEDBACK_AUTO");
      return { result, report, auto, status: ui.status.textContent, error: ui.status.classList.contains("is-error") };
    } });
}

const lineOf = (report, key) => (report.match(new RegExp(`^${key}: (.*)$`, "m")) || [])[1];

// Off screen: the highlight scrolls to the field, and `afterScroll` runs right after the write.
function afterWrite(el, action) {
  el.rect = { top: 2000, left: 0, bottom: 2032, right: 240, width: 240, height: 32 };
  el.afterScroll = action;
}

async function archiveModules(capture = null) {
  const copy = await import("../link/copy.mjs");
  const fillrecords = await import("../link/fillrecords.mjs");
  return { copy, snapshot: { templateVersionOf: async () => "" },
    extract: { extractJobFields: () => ({ company: "", title: "", sourceUrl: "" }) },
    fillrecords: { ...fillrecords, buildFillPayload: (raw) => { capture?.push(raw); return fillrecords.buildFillPayload(raw); } } };
}

test("a new field the AI leaves empty counts like a first-round AI miss, not as a failure", async () => {
  const h = grownForm();
  const { result, report, auto, status, error } = await h.run();
  assert.equal(h.requests.length, 2);
  assert.equal(h.gens[0][0].el.value, "");
  assert.equal(result.outcome, "success", JSON.stringify(result));
  assert.equal(result.unfilledCount, 0);
  assert.equal(result.fieldCount, 2);
  assert.equal(status, "已填写 1 个字段。");
  assert.equal(error, false);
  assert.equal(lineOf(report, "candidates"), "2");
  assert.equal(lineOf(report, "matched"), "1");
  assert.equal(lineOf(report, "drop_reasons"), "ai_unmatched=1");
  assert.equal(lineOf(report, "ai_fields"), "2");
  assert.equal(lineOf(report, "error_code"), "none");
  assert.equal(feedback.diagnostics(report), report, "still inside the v1 allowlist");
  assert.equal(auto.length, 0);
});

test("a partial catch-up counts the new field the AI left out", async () => {
  const h = grownForm({ generations: [[{ label: "研究方向" }, { label: "指导老师" }]], catchUp: answer({ 研究方向: "示例方向" }) });
  const { result, report, status } = await h.run();
  assert.equal(h.requests[1].formFields.length, 2);
  assert.equal(h.gens[0][0].el.value, "示例方向");
  assert.equal(result.outcome, "success");
  assert.equal(result.filledCount, 2);
  assert.equal(status, "已填写 2 个字段（其中新出现的字段补填 1 项）。");
  assert.equal(lineOf(report, "candidates"), "3");
  assert.equal(lineOf(report, "matched"), "2");
  assert.equal(lineOf(report, "filled"), "2");
  assert.equal(lineOf(report, "ai_matches"), "2");
  assert.equal(lineOf(report, "drop_reasons"), "ai_unmatched=1");
});

for (const [name, reply, warning, code] of [
  ["the provider timed out", timedOut, TIMEOUT, "timeout"],
  ["the request threw", () => { throw new Error("无法启动 AI 请求进程。"); }, "", "none"],
  ["no reply came back", () => undefined, "", "none"]
]) {
  test(`a catch-up request that fails (${name}) leaves the result partial and names the new field`, async () => {
    const h = grownForm({ catchUp: reply });
    const { result, report, auto, status, error } = await h.run();
    assert.equal(h.gens[0][0].el.value, "");
    assert.equal(result.outcome, "partial", JSON.stringify(result));
    assert.equal(result.unfilledCount, 0, "not a write failure");
    assert.equal(status, `已填写 1 个字段。新出现的 1 项没有补填：研究方向，请手动补上。${warning}`);
    assert.equal(error, true);
    assert.equal(lineOf(report, "candidates"), "2");
    assert.equal(lineOf(report, "drop_reasons"), "no_result=1");
    assert.equal(lineOf(report, "error_code"), code);
    assert.equal(auto.length, 0, "AI failures are not reported automatically, same as the first round");
  });
}

test("the catch-up keeps the first round's buckets: a secret-only batch is secret, an oversized one was not sent", async () => {
  const secret = grownForm({ generations: [[{ label: "短信验证码" }]],
    catchUp: () => ({ success: false, error: "表单里只有像密码的字段，没有发给 AI。", diagnostics: { errorCode: "secret_only", secretFormFields: 1 } }) });
  const hidden = await secret.run();
  assert.equal(hidden.result.outcome, "success");
  assert.equal(hidden.status, "已填写 1 个字段。");
  assert.equal(lineOf(hidden.report, "drop_reasons"), "secret=1");
  assert.equal(lineOf(hidden.report, "error_code"), "none");

  const large = grownForm({ catchUp: (message) => ({ success: false, matches: [], warning: "这次要发给 AI 的内容太多了。", error: "这次要发给 AI 的内容太多了。",
    diagnostics: diag({ aiFields: message.formFields.length, promptBytes: 0, apiMs: 0, skippedOversized: 1, errorCode: "input_too_large" }) }) });
  const unsent = await large.run();
  assert.equal(unsent.result.outcome, "partial");
  assert.equal(unsent.status, "已填写 1 个字段。新出现的 1 项没有补填：研究方向，请手动补上。这次要发给 AI 的内容太多了。");
  assert.equal(lineOf(unsent.report, "drop_reasons"), "not_sent=1");
  assert.equal(lineOf(unsent.report, "error_code"), "input_too_large");
});

test("new fields still waiting after two catch-up rounds are counted as not sent", async () => {
  const h = grownForm({ generations: [[{ label: "培养类别", option: "学术型" }], [{ label: "学制类别", option: "全日制" }], [{ label: "研究方向" }]],
    catchUp: answer({ 培养类别: "学术型", 学制类别: "全日制", 研究方向: "示例方向" }) });
  const { result, report, status } = await h.run();
  assert.equal(h.requests.length, 3, "two catch-up rounds at most");
  assert.equal(h.gens[2][0].el.value, "");
  assert.equal(result.outcome, "partial");
  assert.equal(result.filledCount, 3);
  assert.equal(status, "已填写 3 个字段（其中新出现的字段补填 2 项）。新出现的 1 项没有补填：研究方向，请手动补上。");
  assert.equal(lineOf(report, "candidates"), "4");
  assert.equal(lineOf(report, "drop_reasons"), "not_sent=1");
});

test("after a first-round timeout no catch-up request is sent and the new field counts as not sent", async () => {
  const h = grownForm({ first: [{ label: "学历", option: "本科" }, { label: "籍贯" }],
    // The worker's shape when its rules matched 学历 and the AI batch for 籍贯 timed out.
    firstReply: (message) => ({ success: true, matches: [{ fieldId: message.formFields[0].fieldId, value: "本科" }], warning: TIMEOUT, error: TIMEOUT,
      diagnostics: diag({ ruleMatches: 1, aiFields: 1, errorCode: "timeout", apiMs: 120000 }) }),
    catchUp: () => { throw new Error("no catch-up request expected"); } });
  const { result, report, auto, status } = await h.run();
  assert.equal(h.requests.length, 1);
  assert.equal(result.outcome, "partial");
  assert.equal(status, `本地已填写 1 项；新出现的 1 项没有补填：研究方向，请手动补上。${TIMEOUT}`);
  assert.equal(lineOf(report, "candidates"), "3");
  assert.equal(lineOf(report, "drop_reasons"), "no_result=1,not_sent=1");
  assert.equal(auto.length, 0);
});

test("a new field that left the page before the catch-up answered is not listed for the user", async () => {
  const h = grownForm({ generations: [[{ label: "研究方向" }, { label: "指导老师" }]],
    catchUp: (message, form) => { form.gens[0][1].el.isConnected = false; return timedOut(message); } });
  const { result, report, status } = await h.run();
  assert.equal(result.outcome, "partial");
  assert.equal(status, `已填写 1 个字段。新出现的 1 项没有补填：研究方向，请手动补上。${TIMEOUT}`);
  assert.equal(lineOf(report, "drop_reasons"), "no_result=2", "both were sent and got nothing back");

  const gone = grownForm({ catchUp: (message, form) => { form.gens[0][0].el.isConnected = false; return timedOut(message); } });
  const quiet = await gone.run();
  assert.equal(quiet.result.outcome, "success", "nothing is left for the user to fill");
  assert.equal(quiet.status, "已填写 1 个字段。");
});

test("a new field the user edits while the catch-up runs keeps the user's text and stops the fill", async () => {
  const h = grownForm({ catchUp: (message, form) => {
    form.gens[0][0].el.value = "我自己写的";
    return answer({ 研究方向: "示例方向" })(message);
  } });
  const { result, report, auto, status } = await h.run();
  assert.equal(h.gens[0][0].el.value, "我自己写的");
  assert.equal(result.overwriteDeclined, true);
  assert.equal(result.outcome, "partial");
  assert.match(status, /保留现有内容/);
  assert.doesNotMatch(lineOf(report, "drop_reasons"), /no_result|not_sent|ai_unmatched/);
  assert.equal(auto.length, 0);
});

test("a stop pressed after the last choice, before the page settles, ends as stopped and leaves the waiting field unsent", async () => {
  const h = grownForm({ first: [{ label: "学历", option: "本科" }, { label: "学位", option: "学士" }] });
  afterWrite(h.firsts[1].el, () => h.pressStop());
  const { result, report, auto, status, error } = await h.run();
  assert.equal(h.requests.length, 1, "no catch-up request after the stop");
  assert.equal(h.firsts[1].el.selectedIndex, 1);
  assert.equal(result.outcome, "partial", JSON.stringify(result));
  assert.equal(status, STOPPED);
  assert.equal(error, true);
  assert.equal(lineOf(report, "candidates"), "3");
  assert.equal(lineOf(report, "drop_reasons"), "not_sent=1");
  assert.equal(auto.length, 0);
});

test("a stop pressed while the catch-up request runs drops its answer and says the user stopped", async () => {
  const h = grownForm({ catchUp: (message, form) => {
    form.pressStop();
    return answer({ 研究方向: "示例方向" })(message);
  } });
  const { result, report, auto, status } = await h.run();
  assert.equal(h.gens[0][0].el.value, "", "nothing is written after the stop");
  assert.equal(result.outcome, "partial");
  assert.equal(status, STOPPED);
  assert.equal(lineOf(report, "drop_reasons"), "not_sent=1");
  assert.equal(auto.length, 0);
});

test("a stop pressed during the last re-scan ends as stopped even when nothing new appeared", async () => {
  let pressed = false;
  const h = grownForm({ generations: [], onRescan: (form) => { if (!pressed && form.ui.cancel.onclick) { pressed = true; form.pressStop(); } } });
  const { result, status, error } = await h.run();
  assert.equal(pressed, true);
  assert.equal(result.outcome, "partial", JSON.stringify(result));
  assert.equal(result.filledCount, 1);
  assert.equal(status, STOPPED);
  assert.equal(error, true);

  // The page moving on at the same moment is told apart from the user's stop.
  const moved = grownForm({ generations: [], onRescan: (form) => { form.location.href = "https://jobs.example.test/next"; } });
  const next = await moved.run();
  assert.equal(next.result.outcome, "partial");
  assert.equal(next.status, "已停止填写，页面或填写会话已变化。");
});

test("a stop pressed while the final sync waits for the text to commit ends as stopped", async () => {
  const h = grownForm({ first: [{ label: "学历", option: "本科" }, { label: "籍贯" }], generations: [],
    firstReply: answer({ 学历: "本科", 籍贯: "示例市" }) });
  // Real commit waits: the 籍贯 write waits once and the final sync once more; 停止 lands in the second.
  h.ctx.helpers.setTextCommitWaitMs(100);
  const later = h.ctx.window.setTimeout;
  let commits = 0;
  h.ctx.window.setTimeout = (callback, delay) => {
    if (delay === 100 && ++commits === 2) h.pressStop();
    return delay === 0 || delay === 100 ? setTimeout(callback, 0) : later(callback, delay);
  };
  const { result, status, error } = await h.run();
  assert.equal(commits, 2);
  assert.equal(result.outcome, "partial", JSON.stringify(result));
  assert.equal(result.filledCount, 2);
  assert.equal(status, STOPPED);
  assert.equal(error, true);
});

test("a new field the page empties again is not counted as 补填", async () => {
  const h = grownForm({ catchUp: answer({ 研究方向: "示例方向" }) });
  afterWrite(h.gens[0][0].el, () => { h.gens[0][0].el.value = ""; });
  const { result, status } = await h.run();
  assert.equal(result.filledCount, 1);
  assert.doesNotMatch(status, /补填/);
  assert.match(status, /研究方向（值被页面退回）/);
});

test("a new field in a non-experience section that the AI leaves empty is offered for 我的信息", async () => {
  const h = grownForm({ section: "附加信息" });
  await h.run();
  assert.equal(h.ui.offer.hidden, false);
  assert.equal(h.ui.offerText.textContent, "可保存到我的信息：已填 0 项，待补 1 项");
});

test("the archive offer counts a new field the AI left empty in the total", async () => {
  const h = grownForm({ archive: true });
  h.ctx.helpers.setDesktopModules(await archiveModules());
  await h.run();
  assert.match(h.ui.recordSummary.textContent, /已写入网页 1\/2 项/, h.ui.recordSummary.textContent);
});

test("a fill whose catch-up wrote a new field is archived: the desktop accepts its counts", async () => {
  const offered = [];
  const h = grownForm({ catchUp: answer({ 研究方向: "示例方向" }), archive: true });
  h.ctx.helpers.setDesktopModules(await archiveModules(offered));
  await h.run();

  // What the fill offered, through the real worker queue to a desktop that checks the shared protocol.
  const { outcome, cancelled, fieldCount, filledCount, unconfirmedCount } = offered[0];
  const { page, panel, desktop } = await createStack({ applications: [{ id: APP, company: COMPANY, title: "研发工程师", stage: "saved" }] });
  page.hooks.setPanelFillWaitMs(2000);
  await page.finishFill({ outcome, cancelled, fieldCount, filledCount, unconfirmedCount }, null);
  await panel.poll();
  panel.clickArchive("start");
  await panel.waitCard((card) => card.title === "这次填写属于哪条申请？", "the candidates");
  panel.clickCandidate(APP);
  await until(() => desktop.events.length + desktop.rejected.length > 0, { what: "the desktop's answer" });
  assert.deepEqual(desktop.rejected.map((item) => item.code), []);
  assert.equal(desktop.events[0].payload.fieldCount, 2);
  assert.equal(desktop.events[0].payload.filledCount, 2);
  await panel.waitCard((card) => /已留档到桌面/.test(card.text), "the saved answer");
  assert.match(h.ui.recordSummary.textContent, /已写入网页 2\/2 项/, h.ui.recordSummary.textContent);
});

test("fields that appeared after a choice add to the existing diagnostic keys only", () => {
  const input = { fieldCount: 2, matched: 1, filledCount: 1, requested: true, category: "none", stage: "none",
    diagnostics: diag({ aiFields: 2, aiMatches: 1, ruleMatches: 0 }) };
  const plain = feedback.fillReport(input);
  assert.equal(feedback.fillReport({ ...input, grown: {} }), plain, "an empty grown block changes nothing");
  assert.equal(lineOf(plain, "drop_reasons"), "ai_unmatched=1");
  const grown = { found: 3, local: 1, matched: 2, aiFields: 2, aiMatches: 1, errorCode: "timeout", drops: { no_result: 1, not_sent: 1, secret: 0 } };
  const report = feedback.fillReport({ ...input, fieldCount: 5, matched: 3, filledCount: 3, grown });
  const keys = (text) => text.split("\n").map((line) => line.split(":")[0]);
  assert.deepEqual(keys(report), keys(plain));
  assert.equal(feedback.diagnostics(report), report);
  assert.equal(lineOf(report, "candidates"), "5");
  // The first round's own arithmetic is unchanged: one AI miss among its two fields.
  assert.equal(lineOf(report, "drop_reasons"), "ai_unmatched=1,no_result=1,not_sent=1");
  assert.equal(lineOf(report, "local_matches"), "1");
  assert.equal(lineOf(report, "ai_fields"), "4");
  assert.equal(lineOf(report, "ai_matches"), "2");
  assert.equal(lineOf(report, "error_code"), "timeout");
  // A first-round error code is never replaced by a later one.
  const first = feedback.fillReport({ ...input, diagnostics: diag({ errorCode: "input_too_large" }), grown });
  assert.equal(lineOf(first, "error_code"), "input_too_large");
});
