import { bindDetailControls } from "./application-detail-controls.ts";
import type {
  ApplicationSummary,
  ApplicationView,
  CreateApplicationResult,
  EvidencePreview,
  Invoke,
  Page,
  SnapshotView,
  StoredEvent,
} from "./api.ts";
import { dialog as dialogEl, input, maybe, must, select as selectEl, valueOf } from "./dom.ts";
import {
  createApplicationsController,
  evidenceLabel,
  evidenceLine,
  evidenceNote,
  eventLabel,
  fillSummary,
  stageLabel,
  occurredLabel,
  snapshotStateLabel,
  SNAPSHOT_DISCLAIMER,
} from "./applications.ts";
import { highlightHtml } from "./search-highlight.ts";
import { STATUS_LABEL, describeDue } from "./todos.ts";

const DETAIL_PROMPT = '<p class="detail-empty muted">选择一条申请查看详情与时间线。</p>';
const DETAIL_FILTERED_OUT = '<p class="detail-empty muted">当前申请不在搜索结果中。</p>';
const SHORTCUTS = [
  ["submitted", "已投递"], ["interview", "面试"], ["offer", "Offer"],
  ["saved", "已保存"], ["filling", "填写中"], ["assessment", "测评"],
  ["rejected", "未通过"], ["withdrawn", "已撤回"], ["closed", "已关闭"],
  ["recycled", "回收站"],
] as const;
const DEFAULT_SHORTCUTS = ["submitted", "interview", "offer"];
const SHORTCUTS_KEY = "applications-shortcuts-v1";

// 列表和详情用的线条图标。只是装饰，读屏跳过。
const ICON = {
  clock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  progress: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
  edit: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  more: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>',
  back: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>',
};

// 待办的提醒登记结果，只说这条记录本身是什么状态，不推断会议、日历或结果。
const REMINDER_STATE: Record<string, string> = {
  none: "未设提醒",
  scheduled: "已登记提醒",
  fired: "已提醒",
  missed: "到点没能提醒",
  unsupported: "这台机器不能提醒",
};

/** 装饰用的首字：公司名的第一个字符（按码点取，不拆开代理对）。 */
function initialOf(name: string | null | undefined) {
  const first = Array.from(String(name ?? "").trim())[0];
  return first ? first.toUpperCase() : "?";
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  return String(value).replace("T", " ").replace(/\.\d+(?=Z$)/, "").replace("Z", " UTC");
}

function invokeError(err: unknown) {
  const detail = err as { code?: string; message?: string } | null;
  if (detail && typeof detail === "object" && detail.message) {
    return `${detail.code || "ERROR"}: ${detail.message}`;
  }
  return String(err);
}

type Listen = (
  event: string,
  handler: (event: { payload?: unknown }) => void,
) => void | Promise<unknown>;

export function mountApplications(
  invoke: Invoke,
  options: { listen?: Listen; searchDebounceMs?: number; coalesceMs?: number } = {},
) {
  const ctl = createApplicationsController();
  const msg = must("apps-msg");
  const empty = must("apps-empty");
  const noResults = must("apps-no-results");
  const layout = must("apps-layout");
  const list = must("apps-list");
  const shell = maybe("apps-shell");
  const stageChips = maybe("app-stage-chips");
  const shortcutSettings = maybe<HTMLDetailsElement>("app-shortcut-settings");
  const shortcutOptions = maybe("app-shortcut-options");
  let listLoaded = false;
  const detail = must("app-detail");
  const dialog = dialogEl("app-form-dialog");
  const form = must<HTMLFormElement>("app-form");
  const formMsg = must("app-form-msg");
  const pageEl = must("apps-page");
  const progressDialog = dialogEl("progress-dialog");
  const progressForm = must<HTMLFormElement>("progress-form");
  const correctDialog = dialogEl("correct-stage-dialog");
  const correctForm = must<HTMLFormElement>("correct-stage-form");
  let progressContext: { act: string; id: string } | null = null;
  let progressSaving = false;
  let correctContext: { id: string; from: string } | null = null;
  let correctSaving = false;
  let actionBusy = false;
  let detailToken = 0;
  let detailTab = "timeline";
  const progressKinds: Record<string, string> = { interview: "面试", assessment: "测评", offer: "Offer", rejected: "未通过", withdrawn: "撤回", closed: "结束申请" };
  const searchDebounceMs = options.searchDebounceMs ?? 250;
  const coalesceMs = options.coalesceMs ?? 80;
  let listed: ApplicationSummary[] = [];
  // 当前列表是用哪个搜索词查出来的；高亮只跟这个走，不跟输入框里还没提交的文字走。
  let listedQuery: string | null = null;
  // 上一次成功显示的列表是按哪组条件查的。只有搜索词、阶段或回收状态变了才算“被筛掉”；
  // 翻页、排序、同条件刷新导致选中项不在当前页时，它仍属于结果，只是不在这一页。
  let shownFilter: { query: string | null; stage: string; recycle: string } | null = null;
  let detailFilteredOut = false;
  let committedNotices: Array<Record<string, unknown>> = [];
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let composing = false;
  let sortDirection = { sort: "updatedAt", desc: true };
  let visibleShortcuts = [...DEFAULT_SHORTCUTS];

  try {
    const saved = JSON.parse(window.localStorage.getItem(SHORTCUTS_KEY) || "null");
    if (Array.isArray(saved)) {
      visibleShortcuts = SHORTCUTS.map(([value]) => value).filter((value) => saved.includes(value));
    }
  } catch { /* Keep the defaults when local storage is unavailable. */ }

  function renderShortcuts(updateOptions = true) {
    if (stageChips) {
      stageChips.innerHTML = `<button type="button" data-stage-chip="all" aria-pressed="false">全部</button>${SHORTCUTS.filter(([value]) => visibleShortcuts.includes(value)).map(([value, label]) => `<button type="button" data-stage-chip="${value}" aria-pressed="false">${label}</button>`).join("")}`;
      syncStageChips(selectEl("app-stage").value, selectEl("app-recycle").value);
    }
    if (shortcutOptions && updateOptions) {
      shortcutOptions.innerHTML = SHORTCUTS.map(([value, label]) => `<label><input type="checkbox" value="${value}" aria-label="${label}"${visibleShortcuts.includes(value) ? " checked" : ""}>${label}</label>`).join("");
    }
  }
  renderShortcuts();

  function setFormBusy(busy: boolean) {
    form
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input,textarea,button")
      .forEach((field) => { field.disabled = busy; });
  }
  function cancelForm(event?: Event) {
    event?.preventDefault();
    if (ctl.saving) return;
    if (ctl.formDirty && !window.confirm("有未保存的修改，确定关闭？")) return;
    dialog.close();
    ctl.clearFormDirty();
  }
  function cancelProgress(event?: Event) {
    event?.preventDefault();
    if (progressSaving) return;
    progressContext = null;
    progressDialog.close();
  }
  must("progress-cancel").addEventListener("click", cancelProgress);
  progressDialog.addEventListener("cancel", cancelProgress);
  dialog.addEventListener("cancel", cancelForm);

  function cancelCorrection(event?: Event) {
    event?.preventDefault();
    if (correctSaving) return;
    correctContext = null;
    correctDialog.close();
  }
  must("correct-stage-cancel").addEventListener("click", cancelCorrection);
  correctDialog.addEventListener("cancel", cancelCorrection);
  correctForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!correctContext || correctSaving) return;
    const { id, from } = correctContext;
    const to = selectEl("correct-stage-to").value;
    const reason = must<HTMLTextAreaElement>("correct-stage-reason").value.trim();
    const status = must("correct-stage-msg");
    if (to === from) { status.textContent = "请选择与当前阶段不同的阶段。"; return; }
    if (!reason) { status.textContent = "请填写纠正原因。"; return; }
    correctSaving = true;
    correctForm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input,select,textarea,button")
      .forEach((field) => { field.disabled = true; });
    status.textContent = "保存中…";
    try {
      await invoke("correct_stage_cmd", { args: { id, from, to, reason } });
      correctContext = null;
      correctDialog.close();
      await refreshList();
      if (ctl.selectedId === id) await loadDetail(id);
      msg.textContent = "已纠正阶段。";
    } catch (error) {
      status.textContent = invokeError(error);
    } finally {
      correctSaving = false;
      correctForm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input,select,textarea,button")
        .forEach((field) => { field.disabled = false; });
    }
  });

  progressForm.addEventListener("submit", async event => {
    event.preventDefault();
    if (!progressContext || progressSaving) return;
    const { act, id } = progressContext;
    const description = input("progress-description").value.trim();
    const date = input("progress-date").value;
    const round = input("progress-round").value;
    const args = { id, updateProgress: input("progress-update").checked,
      occurred: date ? { precision: "date", value: { date, time_zone: null } } : { precision: "unknown" },
      label: description || progressKinds[act], name: description || progressKinds[act], note: description || null, reason: description || null,
      round: act === "interview" && round ? Number(round) : null };
    progressSaving = true;
    progressForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((field) => { field.disabled = true; });
    const status = must("progress-msg");
    status.textContent = "保存中…";
    try {
      await invoke(`record_${act}_cmd`, { args });
      progressDialog.close();
      progressContext = null;
      await refreshList();
      if (ctl.selectedId === id) await loadDetail(id);
      msg.textContent = "已保存记录。";
    } catch (error) { status.textContent = invokeError(error); }
    finally { progressSaving = false; progressForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach((field) => { field.disabled = false; }); }
  });

  function filterArgs() {
    const sort = selectEl("app-sort").value;
    return {
      query: input("app-search").value.trim() || null,
      stage: selectEl("app-stage").value,
      recycle: selectEl("app-recycle").value,
      sort,
      desc: sortDirection.sort === sort ? sortDirection.desc : sort === "updatedAt",
      limit: ctl.limit,
      offset: ctl.offset,
    };
  }

  function openForm(title: string, values: Partial<ApplicationSummary>) {
    if (ctl.saving || actionBusy || progressSaving || correctSaving) return;
    must("app-form-title").textContent = title;
    input("f-company").value = values.company || "";
    input("f-title").value = values.title || "";
    input("f-url").value = values.source_url || "";
    input("f-location").value = values.location || "";
    input("f-notes").value = values.notes || "";
    formMsg.textContent = "";
    ctl.clearFormDirty();
    dialog.showModal();
    input("f-company").focus();
  }

  async function refreshList() {
    if (!invoke) {
      msg.textContent = "未连接到桌面宿主，请用 Tauri 启动。";
      return;
    }
    const token = ctl.beginList();
    const args = filterArgs();
    ctl.setFilter(args);
    syncStageChips(args.stage, args.recycle);
    if (!listLoaded) msg.textContent = "正在读取申请…";
    try {
      const page = await invoke<Page<ApplicationSummary>>("list_applications_cmd", { args });
      if (!ctl.isCurrent(token)) return;
      listed = page.items;
      listedQuery = args.query;
      const lastOffset = page.total ? Math.floor((page.total - 1) / ctl.limit) * ctl.limit : 0;
      if (ctl.offset > lastOffset) { ctl.setOffset(lastOffset); return refreshList(); }
      const filterChanged = shownFilter !== null
        && (shownFilter.query !== args.query || shownFilter.stage !== args.stage || shownFilter.recycle !== args.recycle);
      shownFilter = { query: args.query, stage: args.stage, recycle: args.recycle };
      must("apps-count").textContent = page.total ? `共 ${page.total} 条` : "";
      msg.textContent = "";
      // 三种互斥状态：档案本来就是空的 / 搜索或筛选没有结果 / 正常列表。
      const filtered = Boolean(args.query) || args.stage !== "all" || args.recycle !== "active";
      const showEmpty = page.total === 0 && !filtered;
      const showNoResults = page.total === 0 && filtered;
      empty.classList.toggle("hidden", !showEmpty);
      noResults.classList.toggle("hidden", !showNoResults);
      layout.classList.toggle("hidden", page.total === 0);
      // 档案本来就是空的时候没有可选的详情，右栏让给空状态。
      shell?.classList.toggle("is-empty", showEmpty);
      listLoaded = true;
      list.innerHTML = page.items
        .map((row) => {
          const active = row.id === ctl.selectedId ? " active" : "";
          const location = row.location ? highlightHtml("location", row.location, listedQuery) : "—";
          const recycled = row.recycle_state === "recycled" ? '<span class="recycled-tag">回收站</span>' : "";
          return `<li data-id="${escapeHtml(row.id)}" class="app-item${active}">
            <span class="app-avatar" aria-hidden="true">${escapeHtml(initialOf(row.company))}</span>
            <button type="button" class="app-select" aria-current="${ctl.selectedId === row.id ? "true" : "false"}" title="${escapeHtml(row.company)} · ${escapeHtml(row.title)}"><strong>${highlightHtml("company", row.company, listedQuery)}</strong><span>${highlightHtml("title", row.title, listedQuery)}</span></button>
            <span class="app-meta">
              <span class="app-location${row.location ? "" : " is-empty"}" title="${escapeHtml(row.location || "—")}">${location}</span>
              <span class="app-updated" title="${escapeHtml(formatTime(row.updated_at))}">更新 ${escapeHtml(row.updated_at?.slice(0, 10) || "—")}</span>
            </span>
            <span class="app-stage">${recycled}<span class="stage-badge" data-stage="${escapeHtml(row.current_stage)}">${escapeHtml(stageLabel(row.current_stage))}</span></span>
          </li>`;
        })
        .join("");
      const maxOffset = lastOffset;
      pageEl.textContent = `第 ${Math.floor(ctl.offset / ctl.limit) + 1} / ${Math.max(1, Math.ceil(page.total / ctl.limit))} 页`;
      input("btn-prev-page").disabled = ctl.offset <= 0;
      input("btn-next-page").disabled = ctl.offset >= maxOffset || page.total === 0;
      if (ctl.selectedId && !page.items.some((row) => row.id === ctl.selectedId)) {
        // 选中的申请被筛掉了：让在途的详情请求作废，并清掉旧详情，不替用户改选别的记录。
        detailToken += 1;
        ctl.setSelected(null);
        shell?.classList.remove("show-detail");
        detailFilteredOut = page.total > 0 && filterChanged;
        detail.innerHTML = detailFilteredOut ? DETAIL_FILTERED_OUT : DETAIL_PROMPT;
      } else if (!ctl.selectedId && detailFilteredOut) {
        detailFilteredOut = false;
        detail.innerHTML = DETAIL_PROMPT;
      }
      showFreshHint();
    } catch (err) {
      if (!ctl.isCurrent(token)) return;
      msg.textContent = invokeError(err);
    }
  }

  /** 快捷按钮共用同一组阶段和回收状态筛选。 */
  function syncStageChips(stage: string, recycle: string) {
    stageChips?.querySelectorAll<HTMLElement>("[data-stage-chip]").forEach((chip) => {
      const selected = recycle === "recycled"
        ? chip.dataset.stageChip === "recycled"
        : chip.dataset.stageChip === stage;
      chip.setAttribute("aria-pressed", String(selected));
    });
  }

  function showFreshHint() {
    const fresh = must("apps-fresh");
    const filters = filterArgs();
    const visible = new Set(listed.map((item) => item.id));
    const hidden = committedNotices.filter((notice) => {
      const id = String(notice.applicationId || "");
      if (!id || visible.has(id)) return false;
      const stage = String(notice.stage || "");
      const recycle = String(notice.recycleState || "active");
      const query = String(filters.query || "").toLowerCase();
      const haystack = `${notice.company || ""} ${notice.title || ""}`.toLowerCase();
      const stageMiss = filters.stage !== "all" && Boolean(stage) && filters.stage !== stage;
      const recycleMiss = filters.recycle !== "all" && filters.recycle !== recycle;
      const queryMiss = Boolean(query) && !haystack.includes(query);
      return stageMiss || recycleMiss || queryMiss;
    });
    committedNotices = hidden.slice(-10);
    fresh.hidden = hidden.length === 0;
  }

  function noteCommitted(payload: unknown) {
    const notice = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
    if (!notice || notice.reason !== "committed") return;
    // Filling or confirming an existing application still refreshes the list, but it is
    // not a newly created application and must not show the new-application hint.
    if (notice.messageType === "job.save" && notice.stage === "saved") {
      committedNotices.push(notice);
    }
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(() => {
      coalesceTimer = null;
      void refreshList();
    }, coalesceMs);
  }

  async function loadDetail(id: string) {
    const token = ++detailToken;
    if (ctl.selectedId !== id) detailTab = "timeline";
    ctl.setSelected(id);
    shell?.classList.add("show-detail");
    detailFilteredOut = false;
    detail.innerHTML = '<p class="detail-empty muted">加载中…</p>';
    list.querySelectorAll<HTMLElement>("li[data-id]").forEach((item) => {
      item.classList.toggle("active", item.dataset.id === id);
      item.querySelector(".app-select")?.setAttribute("aria-current", String(item.dataset.id === id));
    });
    try {
      const view = await invoke<ApplicationView>("get_application_cmd", { id });
      if (token !== detailToken || ctl.selectedId !== id) return;
      const app = view.application.summary || view.application;
      const notes = view.application.notes;
      const events = view.events || [];
      const snapshotStates = view.snapshotStates || {};
      const snapshots = view.snapshots || [];
      const evidence = view.evidence || [];
      const todos = view.todos || [];
      const recycled = app.recycle_state === "recycled";
      const sourceUrl = app.source_url || "";
      detail.innerHTML = `
        <button type="button" class="detail-back" data-detail-back>${ICON.back}返回申请列表</button>
        <div class="detail-head">
          <span class="detail-avatar" aria-hidden="true">${escapeHtml(initialOf(app.company))}</span>
          <div class="detail-title">
            <h2 title="${escapeHtml(app.company)}">${escapeHtml(app.company)}</h2>
            <p title="${escapeHtml(app.title)}">${escapeHtml(app.title)}</p>
          </div>
          <div class="detail-status">
            <span class="stage-badge stage-badge-lg" data-stage="${escapeHtml(app.current_stage)}">${escapeHtml(stageLabel(app.current_stage))}</span>
            ${recycled ? '<span class="recycled-tag">在回收站</span>' : ""}
          </div>
        </div>
        <dl class="detail-facts">
          <div><dt>工作地点</dt><dd title="${escapeHtml(app.location || "—")}">${escapeHtml(app.location || "—")}</dd></div>
          <div><dt>最近更新</dt><dd title="${escapeHtml(formatTime(app.updated_at))}">${escapeHtml(app.updated_at?.slice(0, 10) || "—")}</dd></div>
          <div><dt>来源网址</dt><dd class="detail-url" title="${escapeHtml(sourceUrl || "—")}">${escapeHtml(sourceUrl || "—")}</dd></div>
          <div><dt>备注</dt><dd title="${escapeHtml(notes || "—")}">${escapeHtml(notes || "—")}</dd></div>
        </dl>
        <div class="detail-actions">
          <details class="action-menu">
            <summary class="primary">${ICON.progress}记录进度</summary>
            <div class="action-menu-items">
              <button type="button" data-act="submit">确认已投递</button>
              <button type="button" data-act="interview">记录面试</button>
              <button type="button" data-act="assessment">记录测评</button>
              <button type="button" data-act="offer">记录 Offer</button>
              <button type="button" data-act="rejected">记录未通过</button>
              <button type="button" data-act="withdrawn">记录撤回</button>
              <button type="button" data-act="closed">结束申请</button>
            </div>
          </details>
          <button type="button" data-act="edit">${ICON.edit}编辑资料</button>
          <details class="action-menu action-menu-end">
            <summary aria-label="更多操作" title="更多操作">${ICON.more}</summary>
            <div class="action-menu-items">
              <button type="button" data-act="note">新增备注</button>
              <button type="button" data-act="correct">纠正阶段</button>
              <button type="button" data-act="recycle">${recycled ? "从回收站恢复" : "移到回收站"}</button>
            </div>
          </details>
        </div>
        <div class="detail-tabs" role="tablist" aria-label="申请记录">
          <button type="button" role="tab" id="detail-tab-timeline" data-detail-tab="timeline" aria-controls="detail-panel-timeline">时间线 <span class="tab-count">${events.length}</span></button>
          <button type="button" role="tab" id="detail-tab-evidence" data-detail-tab="evidence" aria-controls="detail-panel-evidence">回复证据 <span class="tab-count">${evidence.length}</span></button>
          <button type="button" role="tab" id="detail-tab-snapshots" data-detail-tab="snapshots" aria-controls="detail-panel-snapshots">简历快照 <span class="tab-count">${snapshots.length}</span></button>
        </div>
        <section id="detail-panel-evidence" class="detail-panel" role="tabpanel" aria-labelledby="detail-tab-evidence" tabindex="0" data-detail-panel="evidence" hidden>
        <h3 class="sr-only">回复证据（${evidence.length}）</h3>
        ${evidenceNote(app.reply_evidence_state)
          ? `<p class="panel-note">${escapeHtml(evidenceNote(app.reply_evidence_state))}</p>`
          : ""}
        ${evidence.length ? `
        <ul class="record-list">
          ${evidence.map((item) => `<li class="record-card">
            <div class="record-text"><strong>${escapeHtml(item.subject || item.originalFilename || "导入的证据")}</strong><span>${escapeHtml(evidenceLine(item))}</span></div>
            <div class="record-actions">
              <button type="button" data-act="evidence" data-evidence="${escapeHtml(item.id)}">查看</button>
              <button type="button" data-act="unassociate" data-evidence="${escapeHtml(item.id)}">取消关联</button>
            </div>
          </li>`).join("")}
        </ul>` : `<p class="panel-empty">收件箱里导入的证据关联到这条申请之后会出现在这里。</p>`}
        </section>
        <section id="detail-panel-snapshots" class="detail-panel" role="tabpanel" aria-labelledby="detail-tab-snapshots" tabindex="0" data-detail-panel="snapshots" hidden>
        <h3 class="sr-only">简历快照（${snapshots.length}）</h3>
        <p class="panel-note">${escapeHtml(SNAPSHOT_DISCLAIMER)}</p>
        ${snapshots.length ? `
        <ul class="record-list">
          ${snapshots.map((snap) => `<li class="record-card">
            <div class="record-text"><strong>${escapeHtml(snap.template_name)}</strong><span>拷贝于 ${escapeHtml(formatTime(snap.created_at))}</span></div>
            <div class="record-actions"><button type="button" data-act="snapshot" data-snapshot="${escapeHtml(snap.snapshot_id)}">查看</button></div>
          </li>`).join("")}
        </ul>` : `<p class="panel-empty">还没有简历快照。使用浏览器扩展填写并留档后，可以在这里回看当时的资料。</p>`}
        </section>
        <section id="detail-panel-timeline" class="detail-panel" role="tabpanel" aria-labelledby="detail-tab-timeline" tabindex="0" data-detail-panel="timeline">
        <h3 class="sr-only">时间线</h3>
        ${todos.length ? `
        <section class="detail-todos" aria-label="关联待办">
          <h4>关联待办 <span>待办是接下来的安排，不是进度历史</span></h4>
          <ul>
            ${todos.map((todo) => `<li data-status="${escapeHtml(todo.status)}">
              <strong>${escapeHtml(todo.title)}</strong>
              <span>${escapeHtml(describeDue(todo))} · ${escapeHtml(STATUS_LABEL[todo.status] ?? todo.status)} · ${escapeHtml(REMINDER_STATE[todo.reminderState] ?? todo.reminderState)}</span>
            </li>`).join("")}
          </ul>
        </section>` : ""}
        <p class="panel-note">填写事件不等于投递成功。</p>
        ${events.length ? "" : `<p class="panel-empty">还没有进度记录。</p>`}
        <ol class="timeline">
          ${events
            .slice()
            .reverse()
            .map((ev) => {
              const payload = ev.payload || {};
              const extra = payload.text || payload.note || payload.reason || payload.label || payload.name || "";
              const mode = payload.stage_update_mode || payload.stageUpdateMode;
              const modeText = mode === "update_progress" ? "更新当前进度" : mode === "history_only" ? "仅历史补录" : "";
              const fill = fillSummary(payload);
              const snapshotId = payload.snapshot_id;
              const snapshotNote = typeof snapshotId === "string" ? snapshotStateLabel(snapshotStates[snapshotId]) : null;
              const round = payload.round ? ` · 第 ${escapeHtml(payload.round)} 轮` : "";
              return `<li class="timeline-item">
                <div class="event-card">
                  <div class="event-head">
                    <strong>${escapeHtml(eventLabel(ev.event_type))}${round}</strong>
                    ${modeText && !fill ? `<span class="event-tag">${escapeHtml(modeText)}</span>` : ""}
                  </div>
                  <p class="event-time">${ICON.clock}<span>发生：${escapeHtml(occurredLabel(ev.occurred))} · 记录于：${escapeHtml(formatTime(ev.recorded_at))}</span><span class="event-seq">#${escapeHtml(ev.event_sequence)}</span></p>
                  ${extra ? `<div class="event-body break">${escapeHtml(extra)}</div>` : ""}
                  ${fill ? `<div class="event-body">${escapeHtml(fill)}</div>` : ""}
                  ${snapshotId && !snapshotNote ? `<div class="event-links"><button type="button" data-act="snapshot" data-snapshot="${escapeHtml(snapshotId)}">查看简历快照</button></div>` : ""}
                  ${snapshotNote ? `<p class="event-note">${escapeHtml(snapshotNote)}</p>` : ""}
                </div>
              </li>`;
            })
            .join("")}
        </ol>
        </section>
      `;
      bindDetailControls(detail, detailTab, (tab) => { detailTab = tab; });
      detail.querySelectorAll<HTMLElement>("button[data-act]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const act = btn.dataset.act ?? "";
          const evidenceId = btn.dataset.evidence;
          const snapshotId = btn.dataset.snapshot;
          if (act === "snapshot" && snapshotId) return void openSnapshot(snapshotId);
          if (act === "evidence" && evidenceId) return void openEvidence(evidenceId);
          if (act === "unassociate" && evidenceId) return void unassociateEvidence(evidenceId, id);
          return void handleAction(act, view);
        });
      });
    } catch (err) {
      if (token !== detailToken || ctl.selectedId !== id) return;
      detail.innerHTML = `<p class="banner detail-error">${escapeHtml(invokeError(err))}</p>`;
    }
  }

  // Read-only. The disclaimer is always shown first, and a snapshot that fails its digest
  // check is reported as unreadable rather than shown in part.
  let snapshotToken = 0;
  async function openSnapshot(snapshotId: string) {
    // Only the snapshot opened last may fill the dialog; an earlier one answering late is dropped.
    const token = ++snapshotToken;
    const snapshotDialog = dialogEl("snapshot-dialog");
    const body = must("snapshot-body");
    body.innerHTML = `<p class="banner">${escapeHtml(SNAPSHOT_DISCLAIMER)}</p><p class="muted">加载中…</p>`;
    if (!snapshotDialog.open) snapshotDialog.showModal();
    try {
      const snap = await invoke<SnapshotView>("get_snapshot_cmd", { snapshotId });
      if (token !== snapshotToken) return;
      const omitted = snap.omittedFieldCount
        ? `<p class="muted">${escapeHtml(snap.omittedFieldCount)} 个疑似密码、验证码类的字段没有保存。</p>`
        : "";
      body.innerHTML = `
        <p class="banner">${escapeHtml(SNAPSHOT_DISCLAIMER)}</p>
        <p class="muted">模板：${escapeHtml(snap.templateName)}${snap.templateVersion ? `（${escapeHtml(snap.templateVersion)}）` : ""} · 拷贝于 ${escapeHtml(formatTime(snap.capturedAt || snap.createdAt))}</p>
        ${omitted}
        ${(snap.groups || []).map((group) => `
          <h4>${escapeHtml(group.name)}</h4>
          <dl class="facts compact">
            ${(group.fields || []).map((field) => `<dt>${escapeHtml(field.key)}</dt><dd class="break">${escapeHtml(field.value)}</dd>`).join("")}
          </dl>`).join("")}
      `;
    } catch (err) {
      if (token !== snapshotToken) return;
      body.innerHTML = `<p class="banner">${escapeHtml(SNAPSHOT_DISCLAIMER)}</p><p class="banner">无法读取这份快照（${escapeHtml(invokeError(err))}）。桌面不会展示部分内容。</p>`;
    }
  }

  maybe("snapshot-close")?.addEventListener("click", () => {
    dialogEl("snapshot-dialog").close();
  });

  // 只读预览，和收件箱看到的是同一份已经清洗过的数据（正文转义、图片 data: URL、
  // PDF 不内嵌）。这里不做分类，分类在收件箱里做。
  let evidenceToken = 0;
  async function openEvidence(evidenceId: string) {
    const token = ++evidenceToken;
    const evidenceDialog = dialogEl("evidence-dialog");
    const body = must("evidence-body");
    body.innerHTML = '<p class="muted">加载中…</p>';
    if (!evidenceDialog.open) evidenceDialog.showModal();
    try {
      const item = await invoke<EvidencePreview>("get_evidence_preview_cmd", { evidenceId });
      if (token !== evidenceToken) return;
      body.innerHTML = `
        <p class="muted">${escapeHtml(evidenceLine(item))}</p>
        ${item.note ? `<p class="banner">${escapeHtml(item.note)}</p>` : ""}
        ${item.imageDataUrl ? `<img class="evidence-image" alt="导入的截图" src="${escapeHtml(item.imageDataUrl)}">` : ""}
        ${item.bodyExtract ? `<pre class="evidence-body">${escapeHtml(item.bodyExtract)}</pre>` : ""}
      `;
    } catch (err) {
      if (token !== evidenceToken) return;
      body.innerHTML = `<p class="banner">${escapeHtml(`读不出这条证据（${invokeError(err)}）。`)}</p>`;
    }
  }

  maybe("evidence-close")?.addEventListener("click", () => {
    dialogEl("evidence-dialog").close();
  });

  async function unassociateEvidence(evidenceId: string, applicationId: string) {
    try {
      await invoke("unassociate_evidence_cmd", { evidenceId });
      msg.textContent = "已取出到收件箱。这条申请的证据状态按剩下的证据重算。";
      if (ctl.selectedId === applicationId) await loadDetail(applicationId);
    } catch (err) {
      msg.textContent = invokeError(err);
    }
  }

  async function handleAction(act: string, view: ApplicationView) {
    const app = view.application.summary || view.application;
    const id = app.id;
    if (ctl.selectedId !== id || ctl.saving || actionBusy || progressSaving || correctSaving) return;
    if (progressKinds[act]) {
      progressContext = { act, id };
      must("progress-title").textContent = `记录${progressKinds[act]} · ${app.company} / ${app.title}`;
      input("progress-description").value = "";
      input("progress-date").value = "";
      input("progress-round").value = "";
      must("progress-round-label").hidden = act !== "interview";
      input("progress-update").checked = false;
      must("progress-msg").textContent = "取消或 Escape 不会保存任何记录。";
      progressDialog.showModal();
      return;
    }
    if (act === "correct") {
      const currentStage = app.current_stage || "saved";
      correctContext = { id, from: currentStage };
      must("correct-stage-from").textContent = stageLabel(currentStage);
      selectEl("correct-stage-to").value = currentStage;
      must<HTMLTextAreaElement>("correct-stage-reason").value = "";
      must("correct-stage-msg").textContent = "";
      correctDialog.showModal();
      selectEl("correct-stage-to").focus();
      return;
    }
    actionBusy = true;
    let done = "已保存。";
    try {
      if (act === "edit") {
        actionBusy = false;
        ctl.setEditing(id);
        openForm("编辑申请", {
          company: app.company,
          title: app.title,
          source_url: app.source_url,
          location: app.location,
          notes: view.application.notes,
        });
        return;
      }
      if (act === "submit") {
        if (!window.confirm("确认这条申请已经投递？填写完成不会自动变成已投递。")) return;
        await invoke("confirm_submit_cmd", { args: { id } });
      } else if (act === "note") {
        const text = window.prompt("备注", "");
        if (!text || !text.trim()) return;
        await invoke("add_note_cmd", { args: { id, text } });
      } else if (act === "recycle") {
        const recycled = app.recycle_state !== "recycled";
        // 默认快捷筛选里没有「回收站」：回收后要告诉用户去哪里找回。
        done = !recycled
          ? "已从回收站恢复。"
          : visibleShortcuts.includes("recycled")
            ? "已移到回收站。可点「回收站」查看或恢复。"
            : "已移到回收站。可在快捷筛选设置中显示「回收站」查看或恢复。";
        const ok = window.confirm(
          recycled
            ? "回收后申请离开进行中列表，历史事件仍保留，可以恢复。本次不提供永久删除。"
            : "恢复后申请重新出现在进行中列表，历史事件仍可查看。",
        );
        if (!ok) return;
        await invoke("set_recycle_cmd", { id, recycled });
      }
      await refreshList();
      if (ctl.selectedId === id) await loadDetail(id);
      msg.textContent = done;
    } catch (err) {
      msg.textContent = invokeError(err);
    } finally { actionBusy = false; }
  }

  form.addEventListener("input", () => ctl.markFormDirty());
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (ctl.saving) return;
    const payload = {
      company: input("f-company").value,
      title: input("f-title").value,
      sourceUrl: input("f-url").value || null,
      location: input("f-location").value || null,
      notes: input("f-notes").value || null,
    };
    ctl.setSaving(true);
    setFormBusy(true);
    const editingId = ctl.editingId;
    input("btn-save-app").disabled = true;
    formMsg.textContent = "保存中…";
    try {
      if (editingId) {
        await invoke("update_application_cmd", {
          args: {
            id: editingId,
            company: payload.company,
            title: payload.title,
            sourceUrl: payload.sourceUrl ?? "",
            location: payload.location ?? "",
            notes: payload.notes ?? "",
          },
        });
        formMsg.textContent = "已保存。";
        ctl.clearFormDirty();
        dialog.close();
        await refreshList();
        if (ctl.selectedId === editingId) await loadDetail(editingId);
      } else {
        const result = await invoke<CreateApplicationResult>("create_application_cmd", {
          args: { ...payload, confirmDuplicate: false },
        });
        if (!result.created && result.candidates) {
          const names = [...(result.candidates.exact || []), ...(result.candidates.sameCompany || result.candidates.same_company || [])]
            .map((c) => `${c.company} / ${c.title}`)
            .join("；");
          const ok = window.confirm(`可能已有相似申请：${names || "同公司记录"}。确定仍要新建吗？系统不会自动合并。`);
          if (!ok) {
            formMsg.textContent = "已取消。输入仍保留。";
            input("f-company").value = payload.company;
            input("f-title").value = payload.title;
            input("f-url").value = payload.sourceUrl || "";
            input("f-location").value = payload.location || "";
            input("f-notes").value = payload.notes || "";
            return;
          }
          const forced = await invoke<CreateApplicationResult>("create_application_cmd", {
            args: { ...payload, confirmDuplicate: true },
          });
          dialog.close();
          ctl.clearFormDirty();
          await refreshList();
          if (forced.application) await loadDetail(forced.application.id);
        } else {
          dialog.close();
          ctl.clearFormDirty();
          await refreshList();
          if (result.application) await loadDetail(result.application.id);
        }
      }
    } catch (err) {
      formMsg.textContent = invokeError(err);
      input("f-company").value = payload.company;
      input("f-title").value = payload.title;
      input("f-url").value = payload.sourceUrl || "";
      input("f-location").value = payload.location || "";
      input("f-notes").value = payload.notes || "";
    } finally {
      ctl.setSaving(false);
      setFormBusy(false);
      input("btn-save-app").disabled = false;
    }
  });

  must("btn-cancel-app").addEventListener("click", cancelForm);
  must("btn-new-app").addEventListener("click", () => {
    if (ctl.saving) return;
    ctl.setEditing(null);
    openForm("新增申请", {});
  });
  must("btn-empty-new").addEventListener("click", () => {
    if (ctl.saving) return;
    ctl.setEditing(null);
    openForm("新增申请", {});
  });
  list.addEventListener("click", (event) => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>("li[data-id]");
    const id = item?.dataset.id;
    if (id) void loadDetail(id);
  });
  detail.addEventListener("click", (event) => {
    if (!(event.target as HTMLElement | null)?.closest("[data-detail-back]")) return;
    shell?.classList.remove("show-detail");
    list.querySelector<HTMLElement>(".app-item.active .app-select")?.focus();
  });
  stageChips?.addEventListener("click", async (event) => {
    const chip = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-stage-chip]");
    const stage = chip?.dataset.stageChip;
    if (!stage) return;
    const nextRecycle = stage === "recycled" ? "recycled" : "active";
    const nextStage = stage === "recycled" ? "all" : stage;
    if (selectEl("app-stage").value === nextStage && selectEl("app-recycle").value === nextRecycle) return;
    selectEl("app-stage").value = nextStage;
    selectEl("app-recycle").value = nextRecycle;
    ctl.setOffset(0);
    await refreshList();
  });
  shortcutOptions?.addEventListener("change", async (event) => {
    const box = event.target as HTMLInputElement;
    if (box.type !== "checkbox") return;
    visibleShortcuts = [...shortcutOptions.querySelectorAll<HTMLInputElement>('input:checked')].map((item) => item.value);
    try { window.localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(visibleShortcuts)); } catch { /* In-memory choice still works. */ }
    if (!visibleShortcuts.includes(box.value) && box.value === "recycled" && selectEl("app-recycle").value === "recycled") {
      selectEl("app-recycle").value = "active";
      ctl.setOffset(0);
      renderShortcuts(false);
      await refreshList();
      return;
    }
    if (!visibleShortcuts.includes(box.value) && box.value === selectEl("app-stage").value) {
      selectEl("app-stage").value = "all";
      ctl.setOffset(0);
      renderShortcuts(false);
      await refreshList();
      return;
    }
    renderShortcuts(false);
  });
  shortcutSettings?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    shortcutSettings.open = false;
    shortcutSettings.querySelector<HTMLElement>("summary")?.focus();
  });
  document.addEventListener("click", (event) => {
    if (shortcutSettings?.open && !shortcutSettings.contains(event.target as Node)) {
      shortcutSettings.open = false;
    }
  });
  must("btn-prev-page").addEventListener("click", async () => {
    ctl.setOffset(Math.max(0, ctl.offset - ctl.limit));
    list.scrollTop = 0;
    await refreshList();
  });
  must("btn-next-page").addEventListener("click", async () => {
    ctl.setOffset(ctl.offset + ctl.limit);
    list.scrollTop = 0;
    await refreshList();
  });
  ["app-stage", "app-recycle"].forEach((id) => {
    must(id).addEventListener("change", async () => {
      ctl.setOffset(0);
      await refreshList();
    });
  });
  must("app-sort").addEventListener("change", async () => {
    const sort = selectEl("app-sort").value;
    sortDirection = { sort, desc: sort === "updatedAt" };
    must("app-sort-direction").setAttribute("aria-pressed", String(sortDirection.desc));
    ctl.setOffset(0);
    await refreshList();
  });
  must("app-sort-direction").addEventListener("click", async () => {
    sortDirection = { sort: selectEl("app-sort").value, desc: !filterArgs().desc };
    must("app-sort-direction").setAttribute("aria-pressed", String(sortDirection.desc));
    ctl.setOffset(0);
    await refreshList();
  });
  function queueSearch(immediate: boolean) {
    const query = input("app-search").value.trim();
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    const run = () => {
      searchTimer = null;
      ctl.setOffset(0);
      return refreshList();
    };
    if (immediate || !query) return run();
    searchTimer = setTimeout(() => { void run(); }, searchDebounceMs);
    return undefined;
  }
  const search = must("app-search");
  search.addEventListener("compositionstart", () => { composing = true; });
  search.addEventListener("compositionend", () => {
    composing = false;
    void queueSearch(false);
  });
  search.addEventListener("input", () => {
    if (composing) return;
    void queueSearch(false);
  });
  search.addEventListener("search", () => {
    if (composing) return;
    void queueSearch(true);
  });
  search.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    void queueSearch(true);
  });
  must("apps-fresh-clear").addEventListener("click", async () => {
    input("app-search").value = "";
    selectEl("app-stage").value = "all";
    selectEl("app-recycle").value = "active";
    ctl.setOffset(0);
    committedNotices = [];
    must("apps-fresh").hidden = true;
    await refreshList();
  });
  if (options.listen) {
    void Promise.resolve(options.listen("applications-changed", (event) => noteCommitted(event?.payload))).catch(() => {});
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "n" && event.target === document.body && !ctl.saving && !progressDialog.open) {
      ctl.setEditing(null);
      openForm("新增申请", {});
    }
  });

  return { refreshList, ctl };
}
