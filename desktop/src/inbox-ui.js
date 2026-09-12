// D09 收件箱视图：拖入 / 选择 / 粘贴 → 列表 → 预览 → 关联与分类。
//
// 这里不解析任何东西，也不碰路径：拿到的就是命令层已经清洗过的文本、`data:` 图片和说明。
// 正文一律经 escapeHtml 写入，邮件里的标签只会以字面文本出现。

import {
  CHOOSE_APPLICATION_HINT,
  EMPTY_INBOX,
  REPLY_CLASS_OPTIONS,
  SEND_MODE_OPTIONS,
  describeAssociation,
  describeClassification,
  describeEvidenceMeta,
  describeImport,
  describeUnassociation,
  duplicateNote,
  evidenceTitle,
  kindLabel,
  replyClassLabel,
  sendModeLabel,
} from "./inbox.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function invokeError(error) {
  return error?.message || error?.code || "未知错误";
}

/**
 * 挂载收件箱。`pickFiles` 与 `listenDrop` 由宿主注入（真实实现是 Tauri 的文件对话框与
 * 拖放事件），测试里可以换成假的。
 */
export function mountInbox(invoke, { pickFiles = null, listenDrop = null } = {}) {
  const list = document.getElementById("inbox-list");
  const preview = document.getElementById("inbox-preview");
  const status = document.getElementById("inbox-status");
  const pasteBox = document.getElementById("inbox-paste");

  let items = [];
  let selectedId = null;
  let previewToken = 0;
  let applications = [];

  function say(message) {
    status.textContent = message?.text ?? "";
    status.dataset.tone = message?.tone ?? "info";
  }

  async function refresh() {
    try {
      items = await invoke("list_inbox_cmd");
    } catch (error) {
      items = [];
      say({ tone: "warn", text: `读不到收件箱：${invokeError(error)}` });
    }
    renderList();
    if (selectedId && !items.some((item) => item.id === selectedId)) {
      selectedId = null;
      preview.innerHTML = "";
    }
  }

  function renderList() {
    if (!items.length) {
      list.innerHTML = `<p class="muted">${escapeHtml(EMPTY_INBOX)}</p>`;
      return;
    }
    list.innerHTML = `<ul class="inbox-list">${items
      .map((item) => {
        const active = item.id === selectedId ? " class=\"active\"" : "";
        const badge = item.sameBytesAs?.length ? "<em>内容重复</em>" : "";
        return `<li${active}>
          <button type="button" data-evidence="${escapeHtml(item.id)}">
            <span>${escapeHtml(evidenceTitle(item))}</span>
            <small>${escapeHtml(kindLabel(item.kind))} · ${escapeHtml(item.importedAt)}</small>
          </button>${badge}
        </li>`;
      })
      .join("")}</ul>`;
    list.querySelectorAll("button[data-evidence]").forEach((button) => {
      button.addEventListener("click", () => select(button.dataset.evidence));
    });
  }

  async function select(evidenceId) {
    selectedId = evidenceId;
    const token = ++previewToken;
    preview.innerHTML = '<p class="muted">加载中…</p>';
    renderList();
    let data;
    try {
      data = await invoke("get_evidence_preview_cmd", { evidenceId });
    } catch (error) {
      if (token !== previewToken) return;
      preview.innerHTML = `<p class="banner">${escapeHtml(`读不出这条证据：${invokeError(error)}`)}</p>`;
      return;
    }
    if (token !== previewToken) return;
    await loadApplications();
    if (token !== previewToken) return;
    renderPreview(data);
  }

  async function loadApplications() {
    try {
      const page = await invoke("list_applications_cmd", {
        args: { stage: "all", recycle: "active", desc: true, limit: 100, offset: 0 },
      });
      applications = page?.items ?? [];
    } catch {
      applications = [];
    }
  }

  function renderPreview(data) {
    const item = data;
    const duplicate = duplicateNote(item);
    // 正文经过转义写入：邮件里的 <script> 只会作为字面文本出现。
    const body = item.bodyExtract
      ? `<pre class="evidence-body">${escapeHtml(item.bodyExtract)}</pre>`
      : "";
    const image = item.imageDataUrl
      ? `<img class="evidence-image" alt="导入的截图" src="${escapeHtml(item.imageDataUrl)}">`
      : "";
    const note = item.note ? `<p class="banner">${escapeHtml(item.note)}</p>` : "";
    const openable = item.kind === "pdf" || (item.kind === "screenshot" && !item.imageDataUrl);

    preview.innerHTML = `
      <h3>${escapeHtml(evidenceTitle(item))}</h3>
      <p class="muted">${escapeHtml(describeEvidenceMeta(item))}</p>
      ${duplicate ? `<p class="muted">${escapeHtml(duplicate)}</p>` : ""}
      ${note}
      ${image}
      ${body}
      ${openable ? '<button type="button" data-act="open">用系统程序打开本机副本</button>' : ""}
      <h4>关联申请</h4>
      <p class="muted">${escapeHtml(CHOOSE_APPLICATION_HINT)}</p>
      <div class="row">
        <select id="inbox-application">
          <option value="">请选择一条申请…</option>
          ${applications
            .map(
              (app) =>
                `<option value="${escapeHtml(app.id)}">${escapeHtml(app.company)} · ${escapeHtml(app.title)}</option>`,
            )
            .join("")}
        </select>
        <button type="button" data-act="associate">关联</button>
        ${item.applicationId ? '<button type="button" data-act="unassociate">取消关联</button>' : ""}
      </div>
      <h4>分类</h4>
      <div class="row">
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
        <button type="button" data-act="classify">保存分类</button>
      </div>
      <p class="muted">现在记为「${escapeHtml(replyClassLabel(item.replyClass))}」，发送方式「${escapeHtml(sendModeLabel(item.sendMode))}」。</p>
    `;
    preview.querySelectorAll("button[data-act]").forEach((button) => {
      button.addEventListener("click", () => act(button.dataset.act, item));
    });
  }

  async function act(action, item) {
    try {
      if (action === "open") {
        await invoke("open_evidence_cmd", { evidenceId: item.id });
        say({ tone: "info", text: "已交给系统默认程序打开——那会离开这个应用。" });
        return;
      }
      if (action === "associate") {
        const applicationId = document.getElementById("inbox-application").value;
        if (!applicationId) {
          say({ tone: "warn", text: "请先选中一条申请。" });
          return;
        }
        const chosen = applications.find((app) => app.id === applicationId);
        await invoke("associate_evidence_cmd", { evidenceId: item.id, applicationId });
        say(describeAssociation({ id: item.id }, chosen?.company));
        await refresh();
        return;
      }
      if (action === "unassociate") {
        await invoke("unassociate_evidence_cmd", { evidenceId: item.id });
        say(describeUnassociation());
        await refresh();
        return;
      }
      if (action === "classify") {
        const replyClass = document.getElementById("inbox-reply-class").value || "unknown";
        const sendMode = document.getElementById("inbox-send-mode").value || "unknown";
        const updated = await invoke("classify_evidence_cmd", {
          evidenceId: item.id,
          replyClass,
          sendMode,
        });
        say(describeClassification(updated ?? { replyClass, sendMode }));
        await select(item.id);
      }
    } catch (error) {
      say({ tone: "warn", text: `没能完成这一步：${invokeError(error)}` });
    }
  }

  async function importPaths(paths) {
    if (!paths?.length) return;
    await runImport({ paths });
  }

  async function runImport(args) {
    try {
      const report = await invoke("import_evidence_cmd", { args });
      say(describeImport(report));
      await refresh();
    } catch (error) {
      say({ tone: "warn", text: `导入失败：${invokeError(error)}` });
    }
  }

  document.getElementById("inbox-pick")?.addEventListener("click", async () => {
    if (!pickFiles) {
      say({ tone: "warn", text: "这个环境里打不开文件选择框，可以把文件拖进窗口。" });
      return;
    }
    const paths = await pickFiles();
    await importPaths(paths);
  });

  document.getElementById("inbox-refresh")?.addEventListener("click", () => refresh());

  document.getElementById("inbox-paste-save")?.addEventListener("click", async () => {
    const text = pasteBox?.value ?? "";
    if (!text.trim()) {
      say({ tone: "warn", text: "先粘贴一段文本再导入。" });
      return;
    }
    await runImport({ text });
    if (pasteBox) pasteBox.value = "";
  });

  if (listenDrop) listenDrop((paths) => importPaths(paths));

  return { refresh, importPaths };
}
