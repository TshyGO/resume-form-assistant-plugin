// #178: the side panel's "待同步 N 条" list. It is the worker's existing queue
// (DESKTOP_LIST_QUEUE) and every action goes through the existing DESKTOP_* messages.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStack, settle, until, TEMPLATE } = require("./helpers/fill-archive-harness.js");
const Queue = require("../sidepanel-queue.js");

const APP_A = "11111111-1111-4111-8111-111111111111";
const APP_B = "22222222-2222-4222-8222-222222222222";
const COMPANY = "金发科技股份有限公司";
const one = [{ id: APP_A, company: COMPANY, title: "研发工程师", stage: "saved" }];
const records = (storage) => storage.data.desktopFillRecords || [];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// A fill kept for later from the side panel, with the desktop in the given mode.
async function waitingFill(options = {}) {
  const stack = await createStack({ applications: one, ...options });
  stack.page.hooks.setPanelFillWaitMs(2000);
  await stack.page.finishFill({}, options.template === undefined ? TEMPLATE() : options.template);
  await stack.panel.poll();
  stack.panel.clickArchive("start");
  await stack.panel.waitCard((card) => card.actions.some((item) => item.action === "later"), "the question");
  stack.panel.clickArchive("later");
  await stack.panel.waitCard((card) => /尚未选择申请/.test(card.text), "the pending answer");
  await until(() => stack.panel.queue().count === "1 条", { what: "the pending count" });
  return stack;
}

test("the pending entry is always on the fill tab and counts what is waiting", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "sidepanel.html"), "utf8");
  const fillView = html.slice(html.indexOf('id="fill-view"'), html.indexOf('id="fields-view"'));
  assert.match(fillView, /id="queue-center"/);
  assert.match(fillView, /id="queue-toggle"[^>]*>[\s\S]*待同步[\s\S]*id="queue-count"/);
  assert.ok(html.indexOf("sidepanel-queue.js") < html.indexOf("sidepanel.js"), "the list helper loads before the panel");
  const stack = await createStack({ applications: one });
  await until(() => stack.panel.queue().count === "0 条", { what: "the empty count" });
  assert.equal(stack.panel.get("queue-center").hidden, false);
});

test("a waiting fill can be bound to an application from the list, and then leaves it", async () => {
  const { panel, storage, desktop, worker } = await waitingFill();
  await panel.toggleQueue();
  await until(() => panel.queue().rows.length === 1, { what: "the row" });
  let [row] = panel.queue().rows;
  assert.match(row.text, /填写留档 · 测试模板/);
  assert.match(row.text, new RegExp(`${COMPANY} · 研发工程师`));
  assert.deepEqual(row.buttons.map((item) => item.label), ["选择申请", "删除"]);
  await panel.clickQueue(row.key, "choose-fill");
  await until(() => panel.queue().rows[0].buttons.some((item) => item.action === "pick"), { what: "the candidates" });
  row = panel.queue().rows[0];
  const pick = row.buttons.find((item) => item.action === "pick");
  assert.equal(pick.label, `${COMPANY} · 研发工程师（已保存）`);
  assert.doesNotMatch(row.text, UUID);
  await panel.clickQueue(row.key, "pick", { applicationId: pick.applicationId });
  await until(() => panel.queue().count === "0 条" && !panel.queue().rows.length, { what: "the row to leave" });
  assert.equal(desktop.events.length, 1);
  assert.equal(desktop.events[0].payload.applicationId, APP_A);
  assert.equal(records(storage).length, 0);
  assert.ok(panel.toasts.some((text) => text.startsWith(`已留档到桌面：这次填写的结果记在「${COMPANY} · 研发工程师」下。`)));
  assert.equal(worker.handled.filter((message) => message.type === "DESKTOP_BIND_FILL").length, 1);
});

test("a waiting fill can be deleted from the list", async () => {
  const { panel, storage } = await waitingFill();
  await panel.toggleQueue();
  await until(() => panel.queue().rows.length === 1, { what: "the row" });
  await panel.clickQueue(panel.queue().rows[0].key, "remove-fill");
  await until(() => panel.queue().count === "0 条", { what: "the empty count" });
  assert.equal(records(storage).length, 0);
});

test("a fill bound while the desktop was away is retried from the list and then leaves it", async () => {
  const { panel, desktop, storage } = await waitingFill();
  // Bound to an application, but the desktop drops out before the event gets through.
  const recordId = records(storage)[0].recordId;
  desktop.gate = null;
  const originalAnswer = desktop.answer;
  let failFill = true;
  desktop.answer = async (message) => {
    if (message.messageType === "fill.submit" && failFill) return { lastError: "Error when communicating with the native messaging host." };
    return originalAnswer(message);
  };
  await panel.toggleQueue();
  await until(() => panel.queue().rows.length === 1, { what: "the row" });
  await panel.clickQueue(`fill:${recordId}`, "choose-fill");
  await until(() => panel.queue().rows[0]?.buttons.some((item) => item.action === "pick"), { what: "the candidates" });
  await panel.clickQueue(`fill:${recordId}`, "pick", { applicationId: APP_A });
  // Now it is a bound message waiting to be sent, with its real state.
  const fillMessage = () => panel.queue().rows.find((item) => item.key.startsWith("message:") && /^填写留档/.test(item.text));
  await until(() => Boolean(fillMessage()), { what: "the queued message" });
  const row = fillMessage();
  assert.match(row.text, /填写留档 · 测试模板/);
  assert.match(row.text, /待同步（已尝试 1 次/);
  assert.deepEqual(row.buttons.map((item) => item.label), ["立即重试", "取消"]);
  assert.equal(desktop.events.length, 0);
  failFill = false;
  await panel.clickQueue(row.key, "retry");
  await until(() => desktop.events.length === 1 && !panel.queue().rows.some((item) => item.key === row.key), { what: "the retry" });
  assert.equal(desktop.events[0].payload.applicationId, APP_A);
  assert.equal((storage.data.desktopOutbox || []).filter((entry) => entry.messageType === "fill.submit").length, 0);
});

test("the list survives the job page closing and the panel being reopened", async () => {
  const stack = await waitingFill();
  // The job page is gone: the tab now holds nothing the panel can talk to.
  const reopened = await stack.openPanel({});
  await until(() => reopened.queue().count === "1 条", { what: "the count after reopening" });
  await reopened.toggleQueue();
  await until(() => reopened.queue().rows.length === 1, { what: "the row" });
  assert.match(reopened.queue().rows[0].text, /待同步（尚未选择申请）/);
  assert.equal(reopened.card().hidden, true, "no page, no archive card");
});

test("a fill with no company takes a pasted application id, checked before anything is bound", async () => {
  const stack = await waitingFill({ job: { company: "", title: "", sourceUrl: "" } });
  const { panel, desktop, worker } = stack;
  await panel.toggleQueue();
  await until(() => panel.queue().rows.length === 1, { what: "the row" });
  const key = panel.queue().rows[0].key;
  await panel.clickQueue(key, "choose-fill");
  assert.match(panel.queue().html, /请粘贴桌面里对应申请的 ID/);
  assert.equal(worker.handled.filter((message) => message.type === "DESKTOP_CANDIDATES_FOR").length, 0);
  panel.get("queue-list").querySelector = () => ({ value: "not-an-id" });
  await panel.clickQueue(key, "submit-id");
  assert.match(panel.queue().html, /这不是桌面里的申请 ID/);
  // What was pasted stays in the box after the redraw, so one wrong character is one fix.
  assert.match(panel.queue().html, /class="queue-id"[^>]*value="not-an-id"/);
  assert.equal(worker.handled.filter((message) => message.type === "DESKTOP_BIND_FILL").length, 0);
  panel.get("queue-list").querySelector = () => ({ value: APP_B });
  await panel.clickQueue(key, "submit-id");
  await until(() => desktop.events.length === 1, { what: "the event" });
  assert.equal(desktop.events[0].payload.applicationId, APP_B);
});

test("an expired template snapshot is shown and can be dropped without losing the fill", () => {
  const copy = { describeSnapshotUpload: () => ({ text: "", retry: false }) };
  const reply = {
    intents: [], outbox: [], expiredSnapshots: ["snap-1"],
    fillRecords: [{ recordId: "r1", status: "pending_bind", fill: { templateName: "模板" }, job: { company: "甲", title: "乙" }, snapshot: { snapshotId: "snap-1" } }]
  };
  const [row] = Queue.buildRows(reply, copy);
  assert.match(row.notes[0], /超过 30 天/);
  assert.deepEqual(row.actions.map((item) => item.action), ["choose-fill", "drop-snapshot", "remove-fill"]);
  assert.equal(row.actions[1].snapshotId, "snap-1");
});

test("rows are escaped and never print an application id", async () => {
  const copy = await import("../link/copy.mjs");
  const reply = {
    intents: [{ intentId: "i1", status: "pending", fields: { company: "<b>甲</b>", title: "乙" } }],
    outbox: [{ messageId: "m1", messageType: "fill.submit", recordId: "r2", applicationId: APP_A, status: "stalled", attempts: 6, lastError: "unavailable", payload: { applicationId: APP_A, templateName: "模板" } }],
    fillRecords: [], expiredSnapshots: []
  };
  const rows = Queue.buildRows(reply, copy);
  const html = Queue.renderRows(rows);
  assert.doesNotMatch(html, /<b>甲<\/b>/);
  assert.match(html, /&lt;b&gt;甲&lt;\/b&gt;/);
  assert.doesNotMatch(html.replace(/data-[\w-]+="[^"]*"/g, ""), UUID);
  assert.match(html, /重试多次仍未成功，等你决定（桌面暂时不可用）/);
  assert.equal(Queue.queueTotal(reply), 2);
});

test("the panel only listens for the queue's keys and always reads them through the worker", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "sidepanel.js"), "utf8");
  assert.match(source, /DESKTOP_LIST_QUEUE/);
  assert.doesNotMatch(source, /storage\.local\.get\(\[?"desktop/);
  // One queue: the panel never writes the desktop keys itself.
  assert.doesNotMatch(source, /storage\.local\.set/);
});

test("Chrome and Edge run the same panel code: nothing branches on the browser", () => {
  for (const file of ["sidepanel.js", "sidepanel-queue.js", "content.js", "background.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.doesNotMatch(source, /userAgent|\bEdg\/|navigator\.vendor|userAgentData/, file);
  }
  // Only the side panel API's presence decides between the panel and the page overlay.
  const background = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  assert.match(background, /chrome\.sidePanel\?\.setPanelBehavior/);
});

test("without a native side panel the page overlay still archives the same fill, once", async () => {
  const stack = await createStack({ applications: one });
  const { page, worker, storage } = stack;
  await page.finishFill({}, null);
  const recordId = page.hooks.getPendingFill().recordId;
  assert.match(recordId, UUID);
  assert.equal(page.hooks.panelFillSnapshot().phase, "offer");
  // The overlay's own button (the fallback path): the side panel's copy of the offer closes.
  await page.hooks.handleRecordFillClick();
  await settle(10);
  assert.equal(page.hooks.panelFillSnapshot().phase, "idle");
  assert.equal(page.hooks.getPendingFill(), null);
  // A side panel message for the same fill now finds nothing to archive.
  const late = await page.deliver({ type: "RESUME_PANEL_ARCHIVE_START", archiveId: recordId });
  assert.equal(late.ok, false);
  assert.equal(worker.handled.filter((message) => message.type === "DESKTOP_RECORD_FILL").length, 0);
  assert.equal(records(storage).length, 0);
});
