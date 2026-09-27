// #178: "留档到桌面" runs entirely in the native side panel. The panel, the page controller
// and the worker's real desktop link run together (tests/helpers/fill-archive-harness.js);
// only the native host and the DOM are scripted.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStack, settle, until, TEMPLATE, EXTENSION_ID } = require("./helpers/fill-archive-harness.js");

const APP_A = "11111111-1111-4111-8111-111111111111";
const APP_B = "22222222-2222-4222-8222-222222222222";
const COMPANY = "金发科技股份有限公司";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const one = [{ id: APP_A, company: COMPANY, title: "研发工程师", stage: "saved" }];
const two = [...one, { id: APP_B, company: COMPANY, title: "测试工程师", stage: "submitted" }];
const PENDING_BIND = /^已记入待同步，尚未选择申请。现在还没有留档到桌面。/;

const records = (storage) => storage.data.desktopFillRecords || [];
const outbox = (storage) => storage.data.desktopOutbox || [];
const recordFills = (worker) => worker.handled.filter((message) => message.type === "DESKTOP_RECORD_FILL");
const choosing = (card) => card.title === "这次填写属于哪条申请？";
const shows = (pattern) => (card) => pattern.test(card.text);

async function offered(options = {}) {
  const stack = await createStack(options);
  stack.page.hooks.setPanelFillWaitMs(2000);
  await stack.page.finishFill(options.raw, options.template === undefined ? TEMPLATE() : options.template);
  await stack.panel.poll();
  return stack;
}

test("the offer is drawn in the panel with the snapshot box ticked and no desktop call yet", async () => {
  const { panel, worker } = await offered({ applications: one });
  const card = panel.card();
  assert.equal(card.hidden, false);
  assert.match(card.text, /已写入网页 5\/5 项/);
  assert.equal(card.checkbox, true);
  assert.equal(panel.get("fill-offer-snapshot").checked, true);
  assert.deepEqual(card.actions.map((item) => item.action), ["start", "cancel"]);
  assert.equal(worker.handled.some((message) => message.type === "DESKTOP_CANDIDATES_FOR"), false);
});

test("clicking 留档到桌面 enters querying at once and locks every other action", async () => {
  const { panel, desktop, page } = await offered({ applications: one });
  let release;
  desktop.gate = new Promise((resolve) => { release = resolve; });
  panel.clickArchive("start");
  // Before the page has answered: the lookup is already on screen and nothing can be clicked twice.
  let card = panel.card();
  assert.equal(card.text, "正在查找对应的投递记录……");
  assert.deepEqual(card.actions.map((item) => item.action), ["cancel"]);
  await until(() => desktop.lookups === 1, { what: "the lookup" });
  await panel.poll();
  card = panel.card();
  assert.equal(card.text, "正在查找对应的投递记录……");
  assert.equal(card.checkbox, false, "the snapshot choice is made once the lookup starts");
  assert.deepEqual(card.actions, [{ action: "cancel", label: "取消留档", disabled: false }]);
  // The page overlay's offer is gone: the fill is the panel's now.
  assert.equal(page.card.hidden, true);
  release();
  await panel.waitCard(choosing, "the candidates");
});

test("a single candidate still waits for the user; nothing is recorded until a choice", async () => {
  const { panel, storage, worker } = await offered({ applications: one });
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  await settle(10);
  await panel.poll();
  const card = panel.card();
  assert.equal(card.candidates.length, 1);
  assert.equal(card.candidates[0].label, `${COMPANY} · 研发工程师（已保存）`);
  assert.deepEqual(card.actions.map((item) => item.label), ["稍后处理", "取消留档"]);
  assert.equal(recordFills(worker).length, 0, "not bound on the user's behalf");
  assert.equal(records(storage).length, 0);
});

test("every candidate is listed in the panel with company, title and stage, and no UUID is shown", async () => {
  const { panel, page } = await offered({ applications: two });
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  const card = panel.card();
  assert.deepEqual(card.candidates.map((item) => item.label), [
    `${COMPANY} · 研发工程师（已保存）`, `${COMPANY} · 测试工程师（已投递）`
  ]);
  const visible = [card.title, card.text, card.hint, ...card.candidates.map((item) => item.label), ...card.actions.map((item) => item.label)].join("\n");
  assert.doesNotMatch(visible, UUID);
  // The page overlay's candidate box was never opened.
  assert.equal(page.legacyCandidates.hidden, true);
  assert.equal(page.legacyPanel.classList.contains("is-legacy-open"), false);
});

test("choosing sends one record, and the desktop gets exactly one fill.submit", async () => {
  const { panel, storage, worker, desktop } = await offered({ applications: two, template: null });
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  panel.clickCandidate(APP_A);
  // The write is on screen at once, instead of a card of greyed-out candidates.
  assert.equal(panel.card().candidates.length, 0);
  assert.match(panel.card().text, /正在留档/);
  // A double click that lands before the redraw: refused by the panel lock and by the page.
  panel.clickCandidateAgain(APP_A);
  await panel.waitCard(shows(/已留档到桌面/), "the saved answer");
  assert.equal(recordFills(worker).length, 1);
  assert.equal(recordFills(worker)[0].applicationId, APP_A);
  assert.equal(desktop.events.length, 1);
  assert.equal(desktop.events[0].payload.applicationId, APP_A);
  const card = panel.card();
  assert.equal(card.text, `已留档到桌面：这次填写的结果记在「${COMPANY} · 研发工程师」下。`);
  assert.match(card.className, /is-success/);
  assert.deepEqual(card.actions.map((item) => item.label), ["知道了"]);
  // Written: nothing is left waiting, and the pending list says so.
  assert.equal(records(storage).length, 0);
  assert.equal(outbox(storage).length, 0);
  await until(() => panel.queue().count === "0 条", { what: "the pending count" });
});

test("a doubled start and a repeated choose message still make one record and one event", async () => {
  const { panel, page, worker, desktop, storage } = await offered({ applications: one, template: null });
  panel.clickArchive("start");
  panel.clickArchiveAgain("start");
  // The same start arriving twice at the page is the same question, not a second lookup.
  const archiveId = page.hooks.panelFillSnapshot().archiveId;
  await page.deliver({ type: "RESUME_PANEL_ARCHIVE_START", archiveId, withSnapshot: false });
  await until(() => page.hooks.panelFillSnapshot().phase === "choosing", { what: "the candidates" });
  // The panel's own start found the lookup already running; the next status poll draws it.
  await panel.poll();
  await panel.waitCard(choosing, "the candidates");
  assert.equal(desktop.lookups, 1, "one lookup, not two");
  // The same choice arriving twice at the page (a replayed message) is refused the second time.
  const [first, second] = await Promise.all([
    page.deliver({ type: "RESUME_PANEL_ARCHIVE_CHOOSE", archiveId, applicationId: APP_A }),
    page.deliver({ type: "RESUME_PANEL_ARCHIVE_CHOOSE", archiveId, applicationId: APP_A })
  ]);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(recordFills(worker).length, 1);
  assert.equal(desktop.events.length, 1);
  assert.equal(records(storage).length, 0);
  // And once it is saved, the same record id cannot be archived again.
  const again = await page.deliver({ type: "RESUME_PANEL_ARCHIVE_CHOOSE", archiveId, applicationId: APP_A });
  assert.equal(again.ok, false);
  assert.equal(desktop.events.length, 1);
});

test("稍后处理 keeps exactly one waiting record and says plainly it is not archived", async () => {
  const { panel, storage, desktop } = await offered({ applications: one });
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  panel.clickArchive("later");
  panel.clickArchiveAgain("later");
  await panel.waitCard(shows(PENDING_BIND), "the pending answer");
  await settle(10);
  assert.equal(records(storage).length, 1);
  assert.equal(records(storage)[0].status, "pending_bind");
  assert.equal(desktop.events.length, 0);
  const card = panel.card();
  assert.doesNotMatch(card.text, /已留档到桌面/);
  assert.deepEqual(card.actions.map((item) => item.label), ["去待同步选择申请", "删除这条待同步记录", "知道了"]);
  // It stays on screen: several polls later it is still there.
  await panel.poll();
  await panel.poll();
  assert.match(panel.card().text, PENDING_BIND);
});

test("去待同步选择申请 opens the list on that very record", async () => {
  const { panel, storage } = await offered({ applications: one });
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  panel.clickArchive("later");
  await panel.waitCard(shows(PENDING_BIND), "the pending answer");
  const recordId = records(storage)[0].recordId;
  panel.clickArchive("openqueue");
  await until(() => panel.queue().rows.some((row) => row.focused), { what: "the focused row" });
  const queue = panel.queue();
  assert.equal(queue.open, true);
  assert.equal(queue.count, "1 条");
  const focused = queue.rows.find((row) => row.focused);
  assert.equal(focused.key, `fill:${recordId}`);
  assert.match(focused.text, /待同步（尚未选择申请）/);
});

test("取消留档 creates no record, stages no snapshot and sends nothing", async () => {
  const { panel, storage, kv, worker, desktop } = await offered({ applications: one });
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  panel.clickArchive("cancel");
  await panel.waitCard((card) => card.hidden, "the card to close");
  await settle(10);
  assert.equal(recordFills(worker).length, 0);
  assert.equal(records(storage).length, 0);
  assert.equal(kv.map.size, 0, "no snapshot staged");
  assert.equal(desktop.events.length, 0);
  assert.ok(panel.toasts.includes("已取消留档，没有创建任何记录。"));
});

test("不留档 on the offer also leaves nothing behind", async () => {
  const { panel, storage, kv, worker } = await offered({ applications: one });
  panel.clickArchive("cancel");
  await panel.waitCard((card) => card.hidden, "the card to close");
  assert.equal(recordFills(worker).length, 0);
  assert.equal(records(storage).length, 0);
  assert.equal(kv.map.size, 0);
});

test("no candidates: save the job, look again, keep for later or cancel — never a new application", async () => {
  const { panel, worker, storage, desktop } = await offered({ applications: [{ id: APP_B, company: "别的公司", title: "研发工程师", stage: "saved" }] });
  panel.clickArchive("start");
  await panel.waitCard(shows(/还没有这家公司/), "the empty answer");
  let card = panel.card();
  assert.equal(card.text, "桌面里还没有这家公司的投递记录。");
  assert.deepEqual(card.actions.map((item) => item.label), ["保存岗位到桌面端", "重新查找", "稍后在待同步中选择", "取消留档"]);
  assert.equal(card.candidates.length, 0);
  panel.clickArchive("savejob");
  await settle(6);
  // #172's own review in the panel, the same as its 保存岗位到桌面端 button; never the page overlay.
  assert.ok(panel.pageMessages.includes("RESUME_PANEL_SAVE_DRAFT"), "hands over to the panel's job-save flow");
  assert.equal(panel.overlayTools.clicked, 0, "the page overlay's tools are never opened");
  assert.equal(worker.handled.some((message) => message.type === "DESKTOP_SAVE_JOB"), false, "nothing is saved from here");
  assert.equal(recordFills(worker).length, 0);
  // The job gets saved elsewhere; looking again now finds it, and the user still chooses.
  desktop.applications.push({ id: APP_A, company: COMPANY, title: "研发工程师", stage: "saved" });
  panel.clickArchive("requery");
  await panel.waitCard(choosing, "the candidates");
  card = panel.card();
  assert.equal(card.candidates.length, 1);
  assert.equal(records(storage).length, 0);
});

test("a page that names no company shows no empty candidate list and offers the pending list", async () => {
  const { panel, worker, storage } = await offered({ applications: one, job: { company: "", title: "", sourceUrl: "" } });
  panel.clickArchive("start");
  await panel.waitCard(shows(/看不出是哪家公司/), "the unrecognised answer");
  const card = panel.card();
  assert.equal(card.candidates.length, 0);
  assert.equal(card.title, "");
  assert.doesNotMatch(card.text, /还没有这家公司/);
  assert.deepEqual(card.actions.map((item) => item.label), ["记入待同步，稍后选择", "重新查找", "取消留档"]);
  assert.equal(worker.handled.some((message) => message.type === "DESKTOP_CANDIDATES_FOR"), false);
  panel.clickArchive("later");
  await panel.waitCard(shows(PENDING_BIND), "the pending answer");
  assert.equal(records(storage).length, 1);
});

test("desktop closed, not paired or incompatible: the fixed wording, and no pending record for the unpaired", async () => {
  const closed = await offered({ applications: one, mode: "closed" });
  closed.panel.clickArchive("start");
  await closed.panel.waitCard(shows(/桌面暂时连不上/), "the unavailable answer");
  let card = closed.panel.card();
  assert.equal(card.text, "桌面暂时连不上，没法查找对应的申请。");
  assert.match(card.hint, /现在还没有留档到桌面/);
  assert.deepEqual(card.actions.map((item) => item.label), ["记入待同步，稍后选择", "重新查找", "取消留档"]);
  closed.panel.clickArchive("later");
  await closed.panel.waitCard(shows(PENDING_BIND), "the pending answer");
  assert.equal(records(closed.storage).length, 1);

  const unpaired = await offered({ applications: one, mode: "not_paired" });
  unpaired.panel.clickArchive("start");
  await unpaired.panel.waitCard(shows(/还没有配对这个插件，这次没有留档/), "the unpaired answer");
  card = unpaired.panel.card();
  assert.equal(card.extensionId, EXTENSION_ID);
  assert.deepEqual(card.actions.map((item) => item.label), ["复制扩展 ID", "知道了"]);
  unpaired.panel.clickArchive("cancel");
  await unpaired.panel.waitCard((next) => next.hidden, "the card to close");
  assert.equal(records(unpaired.storage).length, 0);

  const { describeFillArchiveBlocked } = await import("../link/copy.mjs");
  assert.match(describeFillArchiveBlocked("incompatible").text, /协议版本和插件对不上/);
  assert.equal(describeFillArchiveBlocked("incompatible").canQueue, true);
  assert.equal(describeFillArchiveBlocked("not_installed").canQueue, false);
  assert.equal(describeFillArchiveBlocked("never_paired").canQueue, false);
});

test("a lookup answered after 取消留档 does not reopen the question", async () => {
  const { panel, desktop, storage, worker } = await offered({ applications: one });
  let release;
  desktop.gate = new Promise((resolve) => { release = resolve; });
  panel.clickArchive("start");
  await until(() => desktop.lookups === 1, { what: "the lookup" });
  await panel.poll();
  panel.clickArchive("cancel");
  await panel.waitCard((card) => card.hidden, "the card to close");
  release();
  await settle(20);
  await panel.poll();
  assert.equal(panel.card().hidden, true, "the late candidates are dropped");
  assert.equal(recordFills(worker).length, 0);
  assert.equal(records(storage).length, 0);
});

test("switching tabs drops the old page's question, and its late answer never draws on the new tab", async () => {
  const stack = await offered({ applications: one });
  const { panel, desktop, pages } = stack;
  pages[2] = await stack.createPage({ job: { company: "另一家", title: "岗位", sourceUrl: "" } });
  let release;
  desktop.gate = new Promise((resolve) => { release = resolve; });
  panel.clickArchive("start");
  await until(() => desktop.lookups === 1, { what: "the lookup" });
  await panel.switchTab(2);
  assert.equal(panel.card().hidden, true, "the new tab has no fill to archive");
  release();
  await settle(20);
  await panel.poll();
  assert.equal(panel.card().hidden, true, "tab 1's candidates do not appear on tab 2");
  // Back on tab 1 the page still holds its own question.
  await panel.switchTab(1);
  await panel.waitCard(choosing, "tab 1's question");
});

test("the template snapshot is attached only when ticked, and its upload state is real", async () => {
  const ticked = await offered({ applications: one });
  ticked.panel.clickArchive("start");
  await ticked.panel.waitCard(choosing, "the candidates");
  ticked.panel.clickCandidate(APP_A);
  await ticked.panel.waitCard(shows(/已留档到桌面/), "the saved answer");
  const event = ticked.desktop.events[0];
  assert.ok(event.payload.snapshotId, "the event names its snapshot");
  assert.match(ticked.panel.card().snapshotLine, /简历快照/);
  // The upload finishes in the background; once it has left the queue the card says so.
  await until(() => !(ticked.storage.data.desktopOutbox || []).length, { what: "the upload" });
  await ticked.panel.waitCard((card) => card.snapshotLine === "简历快照已上传到桌面。", "the uploaded line");

  const unticked = await offered({ applications: one });
  unticked.panel.get("fill-offer-snapshot").checked = false;
  unticked.panel.clickArchive("start");
  await unticked.panel.waitCard(choosing, "the candidates");
  unticked.panel.clickCandidate(APP_A);
  await unticked.panel.waitCard(shows(/已留档到桌面/), "the saved answer");
  assert.equal(unticked.desktop.events[0].payload.snapshotId, undefined);
  assert.equal(unticked.kv.map.size, 0);
  assert.equal(unticked.panel.card().snapshotLine, "");
});

test("no field value of the page or the template reaches the panel, storage or the desktop event", async () => {
  const { panel, page, storage, desktop } = await offered({ applications: one });
  const snapshot = JSON.stringify(page.hooks.panelFillSnapshot());
  assert.doesNotMatch(snapshot, /机密姓名甲|13800000000/);
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  panel.clickArchive("later");
  await panel.waitCard(shows(PENDING_BIND), "the pending answer");
  assert.doesNotMatch(JSON.stringify(storage.data), /机密姓名甲|13800000000/);
  const html = [panel.card().html, panel.queue().html].join("\n");
  assert.doesNotMatch(html, /机密姓名甲|13800000000/);
  assert.equal(desktop.events.length, 0);
});

test("the page overlay is never opened for archiving while the native panel runs it", async () => {
  const { panel, page } = await offered({ applications: two });
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  panel.clickArchive("later");
  await panel.waitCard(shows(PENDING_BIND), "the pending answer");
  assert.equal(page.legacyCandidates.hidden, true);
  assert.equal(page.legacyPanel.classList.contains("is-legacy-open"), false);
  assert.equal(page.received.some((message) => message.type === "RESUME_PANEL_OFFER"), false);
});

test("a waiting record made from the card can be deleted there, and it leaves the pending list", async () => {
  const { panel, storage } = await offered({ applications: one });
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  panel.clickArchive("later");
  await panel.waitCard(shows(PENDING_BIND), "the pending answer");
  assert.equal(records(storage).length, 1);
  panel.clickArchive("remove");
  await panel.waitCard((card) => card.hidden, "the card to close");
  assert.equal(records(storage).length, 0);
  assert.ok(panel.toasts.includes("已删除这条待同步记录，这次填写没有留档。"));
  await until(() => panel.queue().count === "0 条", { what: "the pending count" });
});

// The desktop takes the fill event but not the snapshot's chunks, so the upload stays queued.
function holdSnapshotUploads(desktop) {
  const answer = desktop.answer;
  desktop.answer = async (message) => (message.messageType === "snapshot.chunk"
    ? { lastError: "Error when communicating with the native messaging host." }
    : answer(message));
}

test("a snapshot the user drops never reads as uploaded, and a failed drop does not claim success", async () => {
  const { panel, desktop, worker, storage } = await offered({ applications: one });
  holdSnapshotUploads(desktop);
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  panel.clickCandidate(APP_A);
  await panel.waitCard(shows(/已留档到桌面/), "the saved answer");
  const upload = () => outbox(storage).find((entry) => entry.messageType === "snapshot.upload");
  await until(() => Boolean(upload()), { what: "the queued upload" });
  await panel.toggleQueue();
  await until(() => panel.queue().rows.some((row) => row.buttons.some((b) => b.action === "drop-snapshot")), { what: "the snapshot row" });
  const row = panel.queue().rows.find((item) => item.buttons.some((b) => b.action === "drop-snapshot"));
  const { snapshotId } = row.buttons.find((b) => b.action === "drop-snapshot");
  await panel.waitCard((card) => card.snapshotLine !== "" && card.snapshotLine !== "简历快照已上传到桌面。", "the upload line");

  // The worker cannot drop it: nothing is said to have happened.
  const handle = worker.handle;
  worker.handle = async (message) => (message.type === "DESKTOP_DROP_SNAPSHOT" ? null : handle(message));
  await panel.clickQueue(row.key, "drop-snapshot", { snapshotId });
  assert.ok(!panel.toasts.some((text) => text.startsWith("已丢弃")), "no success toast for a failed drop");
  assert.match(panel.queue().html, /没能丢弃这份简历快照/);
  assert.ok(upload(), "the upload is still there");
  worker.handle = handle;

  await panel.clickQueue(row.key, "drop-snapshot", { snapshotId });
  await until(() => !upload(), { what: "the upload to go" });
  assert.ok(panel.toasts.some((text) => text.startsWith("已丢弃这份简历快照")));
  await panel.waitCard((card) => card.snapshotLine === "简历快照已丢弃，没有上传到桌面。", "the dropped line");
  assert.equal(desktop.events.length, 1, "the fill itself stays archived");
});

test("去待同步查看 lands on the fill, not on the snapshot bound with it", async () => {
  const { panel, desktop, storage } = await offered({ applications: one });
  const answer = desktop.answer;
  desktop.answer = async (message) => (message.messageType === "fill.submit" || message.messageType === "snapshot.chunk"
    ? { lastError: "Error when communicating with the native messaging host." }
    : answer(message));
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  panel.clickCandidate(APP_A);
  await panel.waitCard((card) => card.actions.some((item) => item.action === "openqueue"), "the queued answer");
  await until(() => outbox(storage).some((entry) => entry.messageType === "snapshot.upload")
    && outbox(storage).some((entry) => entry.messageType === "fill.submit"), { what: "both rows queued" });
  panel.clickArchive("openqueue");
  await until(() => panel.queue().rows.some((row) => row.focused), { what: "the focused row" });
  const focused = panel.queue().rows.find((row) => row.focused);
  const fillSubmit = outbox(storage).find((entry) => entry.messageType === "fill.submit");
  assert.equal(focused.key, `message:${fillSubmit.messageId}`);
  assert.match(focused.text, /^填写留档/);
});

test("a snapshot dropped in another window is never reported here as uploaded", async () => {
  const stack = await offered({ applications: one });
  const { panel, desktop, storage } = stack;
  holdSnapshotUploads(desktop);
  panel.clickArchive("start");
  await panel.waitCard(choosing, "the candidates");
  panel.clickCandidate(APP_A);
  await panel.waitCard(shows(/已留档到桌面/), "the saved answer");
  // The card's text no longer repeats the upload; the live line below is the only one.
  assert.doesNotMatch(panel.card().text, /快照/);
  const upload = () => outbox(storage).find((entry) => entry.messageType === "snapshot.upload");
  await until(() => Boolean(upload()), { what: "the queued upload" });
  await panel.waitCard((card) => /上传/.test(card.snapshotLine) && card.snapshotLine !== "简历快照已上传到桌面。", "the upload line");
  const other = await stack.openPanel();
  await other.toggleQueue();
  await until(() => other.queue().rows.some((row) => row.buttons.some((b) => b.action === "drop-snapshot")), { what: "the snapshot row there" });
  const row = other.queue().rows.find((item) => item.buttons.some((b) => b.action === "drop-snapshot"));
  await other.clickQueue(row.key, "drop-snapshot", { snapshotId: row.buttons.find((b) => b.action === "drop-snapshot").snapshotId });
  await until(() => !upload(), { what: "the upload to go" });
  await panel.waitCard((card) => /没有收到上传完成的确认/.test(card.snapshotLine), "the neutral line");
  assert.doesNotMatch(panel.card().snapshotLine, /已上传/);
});

test("a desktop with no shared protocol version: the fixed wording, a waiting record on request, and nothing sent", async () => {
  const { panel, desktop, storage } = await offered({ applications: one, mode: "incompatible" });
  panel.clickArchive("start");
  await panel.waitCard(shows(/协议版本和插件对不上/), "the incompatible answer");
  const card = panel.card();
  assert.equal(card.text, "桌面程序的协议版本和插件对不上，没法查找对应的申请，升级之后才能留档。");
  assert.match(card.hint, /现在还没有留档到桌面/);
  assert.deepEqual(card.actions.map((item) => item.label), ["记入待同步，稍后选择", "重新查找", "取消留档"]);
  assert.equal(desktop.lookups, 0, "nothing is looked up on a desktop that cannot be spoken to");
  panel.clickArchive("later");
  await panel.waitCard(shows(PENDING_BIND), "the pending answer");
  assert.equal(records(storage).length, 1);
  assert.equal(desktop.events.length, 0, "no fill.submit to an incompatible desktop");
});

test("two requests for one fill arriving together stage its snapshot once", async () => {
  const { page, worker, kv, desktop } = await offered({ applications: one });
  const raw = page.hooks.getPendingFill();
  const staged = new Set();
  const put = kv.put.bind(kv);
  kv.put = async (key, value) => { staged.add(key); return put(key, value); };
  const request = () => worker.handle({ type: "DESKTOP_RECORD_FILL", raw, recordId: raw.recordId, applicationId: APP_A, snapshotTemplate: TEMPLATE() });
  const results = await Promise.all([request(), request()]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["duplicate", "saved"]);
  assert.equal(staged.size, 1, "the second request waited for the first instead of staging its own copy");
  assert.equal(desktop.events.length, 1);
});
