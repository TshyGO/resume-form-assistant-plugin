// D09「招聘通知」视图（原「证据收件箱」，#262 改版）：拖入 / 选择 / 粘贴 → 列表 → 预览 →
// 关联与分类。左侧只列还没关联申请的材料，关联之后材料进对应申请的详情。
//
// 这里不解析任何东西，也不碰路径：拿到的就是命令层已经清洗过的文本、`data:` 图片和说明。
// 正文一律经 escapeHtml 写入，邮件里的标签只会以字面文本出现。

import type {
  ApplicationSummary,
  EvidencePreview,
  EvidenceSummary,
  ImportReport,
  Invoke,
  Page,
} from "./api.ts";
import { maybe, must, select as selectEl, textarea } from "./dom.ts";
import type { Message } from "./inbox.ts";
import {
  CHOOSE_APPLICATION_HINT,
  EMPTY_INBOX,
  PRIVACY_NOTE,
  REPLY_CLASS_OPTIONS,
  SEND_MODE_OPTIONS,
  describeAssociation,
  describeClassification,
  describeEvidenceMeta,
  describeImport,
  describeUnassociation,
  duplicateNote,
  evidenceTitle,
  importedAtLabel,
  kindLabel,
  replyClassLabel,
  sendModeLabel,
} from "./inbox.ts";

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function invokeError(error: unknown) {
  const detail = error as { message?: string; code?: string } | null;
  return detail?.message || detail?.code || "未知错误";
}

// 线条图标，只是装饰，读屏跳过。
const KIND_ICON: Record<string, string> = {
  eml: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></svg>',
  screenshot: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>',
  pdf: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  text: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9zM9 12h6M9 16h4"/></svg>',
};
const ICON = {
  open: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
  upload: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4m-4.5 4.5L12 4l4.5 4.5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
  download: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>',
  paste: KIND_ICON.text,
  lock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  link: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  tag: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12V4h8l9 9-8 8z"/><circle cx="7.5" cy="8.5" r="1.3"/></svg>',
};

function kindIcon(kind: string | undefined) {
  if (kind === "eml" || kind === "screenshot" || kind === "pdf") return KIND_ICON[kind];
  return KIND_ICON.text;
}

/** 宿主注入的几件事：打开文件对话框、监听窗口拖放、挂 AI 整理面板。测试里换成假的。 */
export interface InboxHost {
  pickFiles?: (() => Promise<string[]>) | null;
  listenDrop?: ((handle: (paths: string[]) => void) => void) | null;
  /**
   * 把 AI 整理面板挂到预览里的挂载点上。真实实现是 React（`ai/mount.tsx`），
   * 这里只给容器和证据 id：**面板的状态不回流到这个旧视图**。
   */
  mountAi?:
    | ((
        container: Element,
        evidenceId: string,
        onConfirmed: (message: string) => void,
      ) => { unmount(): void })
    | null;
}

export function mountInbox(
  invoke: Invoke,
  { pickFiles = null, listenDrop = null, mountAi = null }: InboxHost = {},
) {
  const shell = maybe("inbox-shell");
  const list = must("inbox-list");
  const preview = must("inbox-preview");
  const status = must("inbox-status");
  const count = maybe("inbox-count");
  const pasteBox = textarea("inbox-paste");
  const pasteDialog = maybe<HTMLDialogElement>("inbox-paste-dialog");
  const pasteStatus = maybe("inbox-paste-status");

  let items: EvidenceSummary[] = [];
  let loaded = false;
  let aiPanel: { unmount(): void } | null = null;
  let selectedId: string | null = null;
  let previewToken = 0;
  let applications: ApplicationSummary[] = [];
  /** 导入正在进行：再点一次导入或再拖一批进来，等这一批说完结果再说。 */
  let importing = false;
  /** 关联 / 分类 / 打开正在路上：同一个按钮连点只发一次。 */
  let acting = false;
  let pasteOpener: HTMLElement | null = null;
  const emptyPreview =
    '<div class="pane-empty"><h2>选择一条通知</h2><p>预览原文，再关联申请或整理分类。</p></div>';

  /** 重画预览之前先把上一块 React 卸掉，不然它会跟着 innerHTML 一起被丢掉却没收工。 */
  function clearAiPanel() {
    aiPanel?.unmount();
    aiPanel = null;
  }

  function say(message: Message | null) {
    status.textContent = message?.text ?? "";
    status.dataset.tone = message?.tone ?? "info";
  }

  async function refresh() {
    try {
      items = await invoke<EvidenceSummary[]>("list_inbox_cmd");
    } catch (error) {
      items = [];
      say({ tone: "warn", text: `读不到招聘通知：${invokeError(error)}` });
    }
    loaded = true;
    renderList();
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      selectedId = null;
      previewToken += 1;
      clearAiPanel();
      preview.innerHTML = items.length ? emptyPreview : emptyState();
    } else if (!items.length) {
      clearAiPanel();
      preview.innerHTML = emptyState();
    } else if (!selectedId && preview.querySelector?.(".workspace-empty")) {
      preview.innerHTML = emptyPreview;
    }
  }

  /** 一条都没有：整页给空状态，导入入口就在眼前。 */
  function emptyState() {
    return `
      <div class="workspace-empty inbox-empty">
        <span class="workspace-empty-icon">${ICON.upload}</span>
        <h2>没有待整理的招聘通知</h2>
        <p>${escapeHtml(EMPTY_INBOX)}</p>
        <div class="workspace-empty-actions">
          <button type="button" class="primary" data-empty-act="pick">${ICON.download}导入文件</button>
          <button type="button" data-empty-act="paste">${ICON.paste}粘贴文本</button>
        </div>
        <ul class="format-chips" aria-label="支持的格式">
          <li>${KIND_ICON.eml}.eml 邮件</li><li>${KIND_ICON.screenshot}PNG / JPEG 截图</li><li>${KIND_ICON.pdf}PDF 文档</li><li>${KIND_ICON.text}粘贴文本</li>
        </ul>
        <p class="privacy-note">${ICON.lock}<span>${escapeHtml(PRIVACY_NOTE)}</span></p>
      </div>`;
  }

  function renderList() {
    shell?.classList.toggle("is-empty", loaded && !items.length);
    if (count) count.textContent = loaded ? String(items.length) : "";
    if (!loaded) {
      list.innerHTML = '<p class="todo-list-note muted">正在读取…</p>';
      return;
    }
    if (!items.length) {
      list.innerHTML = `<div class="pane-empty"><h3>没有待整理的通知</h3><p>${escapeHtml(EMPTY_INBOX)}</p></div>`;
      return;
    }
    list.innerHTML = `<ul class="inbox-list">${items
      .map((item) => {
        const active = item.id === selectedId;
        const badge = item.sameBytesAs?.length ? '<span class="evidence-duplicate">内容重复</span>' : "";
        const classified = item.replyClass
          ? `<span class="evidence-chip">${escapeHtml(replyClassLabel(item.replyClass))}</span>`
          : "";
        return `<li${active ? ' class="active"' : ""}>
          <button type="button" data-evidence="${escapeHtml(item.id)}" aria-current="${active}">
            <span class="evidence-icon" data-kind="${escapeHtml(item.kind)}">${kindIcon(item.kind)}</span>
            <span class="evidence-list-main">
              <span class="evidence-list-title">${escapeHtml(evidenceTitle(item))}</span>
              <span class="evidence-list-meta"><span class="evidence-chip" data-kind="${escapeHtml(item.kind)}">${escapeHtml(kindLabel(item.kind))}</span>${classified}${badge}</span>
            </span>
            <small>${escapeHtml(importedAtLabel(item.importedAt))}</small>
          </button>
        </li>`;
      })
      .join("")}</ul>`;
    list.querySelectorAll<HTMLElement>("button[data-evidence]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.evidence;
        if (id) void select(id);
      });
    });
  }

  async function select(evidenceId: string) {
    selectedId = evidenceId;
    const token = ++previewToken;
    clearAiPanel();
    preview.innerHTML = '<p class="pane-loading muted" role="status">正在读取这条通知…</p>';
    renderList();
    let data: EvidencePreview;
    try {
      data = await invoke<EvidencePreview>("get_evidence_preview_cmd", { evidenceId });
    } catch (error) {
      if (token !== previewToken) return;
      preview.innerHTML = `<div class="pane-error"><p class="banner">${escapeHtml(`读不出这条通知：${invokeError(error)}`)}</p><button type="button" data-act="retry-preview">再读一次</button></div>`;
      preview.querySelector<HTMLElement>('[data-act="retry-preview"]')?.addEventListener("click", () => void select(evidenceId));
      return;
    }
    if (token !== previewToken) return;
    await loadApplications();
    if (token !== previewToken) return;
    renderPreview(data);
  }

  async function loadApplications() {
    try {
      const page = await invoke<Page<ApplicationSummary>>("list_applications_cmd", {
        args: { stage: "all", recycle: "active", desc: true, limit: 100, offset: 0 },
      });
      applications = page?.items ?? [];
    } catch {
      applications = [];
    }
  }

  function mailFacts(item: EvidencePreview) {
    const rows: Array<[string, string]> = [];
    if (item.fromAddr) rows.push(["发件人", item.fromAddr]);
    if (item.sentAt) rows.push(["发送时间", importedAtLabel(item.sentAt)]);
    if (item.subject && item.kind === "eml") rows.push(["主题", item.subject]);
    if (!rows.length) return "";
    return `<dl class="evidence-mail">${rows
      .map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`)
      .join("")}</dl>`;
  }

  function renderPreview(data: EvidencePreview) {
    // 谁调 renderPreview 都先把上一块 React 卸掉：漏掉这一步，旧面板的清理
    // （取消进行中的请求）就永远不会跑。
    clearAiPanel();
    const item = data;
    const duplicate = duplicateNote(item);
    // 正文经过转义写入：邮件里的 <script> 只会作为字面文本出现。
    const body = item.bodyExtract
      ? `<pre class="evidence-body">${escapeHtml(item.bodyExtract)}</pre>`
      : "";
    const image = item.imageDataUrl
      ? `<img class="evidence-image" alt="导入的截图" src="${escapeHtml(item.imageDataUrl)}">`
      : "";
    const note = item.note ? `<p class="evidence-note">${escapeHtml(item.note)}</p>` : "";
    const openable = item.kind === "pdf" || (item.kind === "screenshot" && !item.imageDataUrl);
    const nothing = !body && !image && !note
      ? '<p class="evidence-note">这条材料没有可以在应用里显示的正文。</p>'
      : "";

    preview.innerHTML = `
      <article class="evidence-view">
        <header class="evidence-preview-heading">
          <span class="evidence-icon is-large" data-kind="${escapeHtml(item.kind)}">${kindIcon(item.kind)}</span>
          <div class="evidence-heading-text">
            <p class="evidence-kind">${escapeHtml(kindLabel(item.kind))}</p>
            <h2>${escapeHtml(evidenceTitle(item))}</h2>
            <p class="muted">${escapeHtml(describeEvidenceMeta({ ...item, fromAddr: null, sentAt: null }))}</p>
          </div>
          ${openable ? `<button type="button" data-act="open">${ICON.open}用系统程序打开本机副本</button>` : ""}
        </header>
        <section class="evidence-section" aria-labelledby="evidence-original-heading">
          <h3 id="evidence-original-heading">原文</h3>
          ${duplicate ? `<p class="evidence-duplicate-note">${escapeHtml(duplicate)}</p>` : ""}
          ${mailFacts(item)}
          ${note}
          ${image}
          ${body}
          ${nothing}
        </section>
        <section class="evidence-section evidence-organize" aria-labelledby="evidence-organize-heading">
          <h3 id="evidence-organize-heading">手动整理</h3>
          <p class="evidence-section-hint">关联和分类由你确认，不会改变申请阶段。</p>
          <div class="organize-grid">
            <div class="organize-block">
              <h4>${ICON.link}关联申请</h4>
              <p class="muted">${escapeHtml(CHOOSE_APPLICATION_HINT)}</p>
              <select id="inbox-application" aria-label="关联申请">
                <option value="">请选择一条申请…</option>
                ${applications
                  .map(
                    (app) =>
                      `<option value="${escapeHtml(app.id)}">${escapeHtml(app.company)} · ${escapeHtml(app.title)}</option>`,
                  )
                  .join("")}
              </select>
              ${applications.length ? "" : '<p class="muted">还没有在办的申请。先到「申请」页新增一条，再回来关联。</p>'}
              <div class="organize-actions">
                ${item.applicationId ? '<button type="button" data-act="unassociate">取消关联</button>' : ""}
                <button type="button" data-act="associate" class="primary">关联</button>
              </div>
            </div>
            <div class="organize-block">
              <h4>${ICON.tag}分类</h4>
              <div class="organize-fields evidence-classification">
                <label>通知类型
                  <select id="inbox-reply-class">
                    ${REPLY_CLASS_OPTIONS.map(
                      (option) =>
                        `<option value="${escapeHtml(option.value)}"${option.value === (item.replyClass ?? "") ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
                    ).join("")}
                  </select>
                </label>
                <label>发送方式
                  <select id="inbox-send-mode">
                    ${SEND_MODE_OPTIONS.map(
                      (option) =>
                        `<option value="${escapeHtml(option.value)}"${option.value === (item.sendMode ?? "unknown") ? " selected" : ""}>${escapeHtml(option.label)}</option>`,
                    ).join("")}
                  </select>
                </label>
              </div>
              <p class="muted">现在记为「${escapeHtml(replyClassLabel(item.replyClass))}」，发送方式「${escapeHtml(sendModeLabel(item.sendMode))}」。</p>
              <div class="organize-actions">
                <button type="button" data-act="classify" class="primary">保存分类</button>
              </div>
            </div>
          </div>
        </section>
        <section class="evidence-section evidence-ai-section" aria-labelledby="evidence-ai-heading">
          <h3 id="evidence-ai-heading">AI 整理<span class="section-tag">可选</span></h3>
          <div id="inbox-ai"></div>
        </section>
      </article>
    `;
    const slot = maybe("inbox-ai");
    if (mountAi && slot) {
      // 确认成功那句话由状态栏说：面板本身马上会随着重画被卸掉。
      aiPanel = mountAi(slot as unknown as Element, item.id, (message) => {
        say({ tone: "success", text: message });
        void refresh().then(() => {
          if (items.some((entry) => entry.id === item.id)) {
            if (selectedId === item.id) void select(item.id);
            return;
          }
          // 确认会把材料关联到申请上，它就不在这个列表里了：说清楚去了哪儿。
          say({ tone: "success", text: `${message}这条通知已移到所选申请详情的「招聘通知」里。` });
        });
      });
    }
    preview.querySelectorAll<HTMLElement>("button[data-act]").forEach((button) => {
      button.addEventListener("click", () => {
        const action = button.dataset.act;
        if (action) void act(action, item);
      });
    });
  }

  function setActing(busy: boolean) {
    acting = busy;
    preview.querySelectorAll<HTMLButtonElement>(".evidence-view header button[data-act], .evidence-organize button[data-act]").forEach((button) => {
      button.disabled = busy;
    });
  }

  async function act(action: string, item: EvidencePreview) {
    if (acting) return;
    try {
      if (action === "open") {
        setActing(true);
        await invoke("open_evidence_cmd", { evidenceId: item.id });
        say({ tone: "info", text: "已交给系统默认程序打开本机副本——那会离开这个应用。" });
        return;
      }
      if (action === "associate") {
        const applicationId = selectEl("inbox-application").value;
        if (!applicationId) {
          say({ tone: "warn", text: "请先选中一条申请。" });
          maybe("inbox-application")?.focus();
          return;
        }
        setActing(true);
        const chosen = applications.find((app) => app.id === applicationId);
        await invoke("associate_evidence_cmd", { evidenceId: item.id, applicationId });
        say(describeAssociation({ id: item.id }, chosen ? `${chosen.company} · ${chosen.title}` : undefined));
        await refresh();
        return;
      }
      if (action === "unassociate") {
        setActing(true);
        await invoke("unassociate_evidence_cmd", { evidenceId: item.id });
        say(describeUnassociation());
        await refresh();
        return;
      }
      if (action === "classify") {
        setActing(true);
        const replyClass = selectEl("inbox-reply-class").value || "unknown";
        const sendMode = selectEl("inbox-send-mode").value || "unknown";
        const updated = await invoke<EvidenceSummary>("classify_evidence_cmd", {
          evidenceId: item.id,
          replyClass,
          sendMode,
        });
        say(describeClassification(updated ?? ({ replyClass, sendMode } as Partial<EvidenceSummary>)));
        acting = false;
        await refresh();
        await select(item.id);
      }
    } catch (error) {
      say({ tone: "warn", text: `没能完成这一步：${invokeError(error)}` });
    } finally {
      if (acting) setActing(false);
    }
  }

  async function importPaths(paths: string[] | null | undefined) {
    if (!paths?.length) return;
    await runImport({ paths });
  }

  /** 导入一批。返回是否真的交给了命令层并拿到了结果（失败时调用方保留输入）。 */
  async function runImport(args: { paths?: string[]; text?: string }): Promise<boolean> {
    if (importing) {
      say({ tone: "warn", text: "上一批还在导入，等它完成再导入下一批。" });
      return false;
    }
    importing = true;
    say({ tone: "pending", text: "正在导入…" });
    try {
      const report = await invoke<ImportReport>("import_evidence_cmd", { args });
      say(describeImport(report));
      await refresh();
      // 只导入了一条新的：直接打开它，省得再去列表里找。
      const fresh = report?.imported ?? [];
      if (fresh.length === 1 && fresh[0] && items.some((item) => item.id === fresh[0]!.id)) {
        await select(fresh[0].id);
      }
      return true;
    } catch (error) {
      say({ tone: "warn", text: `导入失败：${invokeError(error)}` });
      return false;
    } finally {
      importing = false;
    }
  }

  async function pick() {
    if (!pickFiles) {
      say({ tone: "warn", text: "这个环境里打不开文件选择框，可以把文件拖进窗口。" });
      return;
    }
    let paths: string[] = [];
    try {
      paths = await pickFiles();
    } catch (error) {
      say({ tone: "warn", text: `打不开文件选择框：${invokeError(error)}` });
      return;
    }
    await importPaths(paths);
  }

  function sayInPaste(text: string) {
    if (!pasteStatus) return;
    pasteStatus.textContent = text;
    pasteStatus.className = text ? "note warn" : "note";
  }

  function openPaste() {
    sayInPaste("");
    const active = document.activeElement;
    pasteOpener = active && "focus" in active ? (active as HTMLElement) : null;
    if (pasteDialog && !pasteDialog.open) pasteDialog.showModal();
    pasteBox.focus();
  }

  function closePaste() {
    pasteDialog?.close();
    sayInPaste("");
    if (pasteOpener?.isConnected) pasteOpener.focus();
    pasteOpener = null;
  }

  async function submitPaste() {
    const text = pasteBox.value ?? "";
    if (!text.trim()) {
      sayInPaste("先粘贴一段文本再导入。");
      say({ tone: "warn", text: "先粘贴一段文本再导入。" });
      pasteBox.focus();
      return;
    }
    const save = maybe<HTMLButtonElement>("inbox-paste-save");
    if (save) {
      save.disabled = true;
      save.textContent = "正在导入…";
    }
    pasteBox.readOnly = true;
    const ok = await runImport({ text });
    pasteBox.readOnly = false;
    if (save) {
      save.disabled = false;
      save.textContent = "导入这段文本";
    }
    if (ok) {
      // 成功才清空：失败时用户粘贴的那一大段还在框里，改一改就能再导入。
      pasteBox.value = "";
      closePaste();
    } else {
      sayInPaste(status.textContent || "导入失败，内容还在框里，可以再试一次。");
    }
  }

  maybe("inbox-pick")?.addEventListener("click", () => void pick());
  maybe("inbox-refresh")?.addEventListener("click", async () => {
    await refresh();
    say({ tone: "info", text: "已刷新。" });
  });
  maybe("inbox-paste-open")?.addEventListener("click", openPaste);
  maybe("inbox-paste-cancel")?.addEventListener("click", () => {
    if (importing) return;
    closePaste();
  });
  pasteDialog?.addEventListener("cancel", (event) => {
    event.preventDefault();
    if (importing) return;
    closePaste();
  });
  maybe<HTMLFormElement>("inbox-paste-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitPaste();
  });
  preview.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement | null)?.closest?.<HTMLElement>("button[data-empty-act]");
    if (!button) return;
    if (button.dataset.emptyAct === "pick") void pick();
    else openPaste();
  });

  if (listenDrop) listenDrop((paths) => void importPaths(paths));

  return { refresh, importPaths, submitPaste };
}
