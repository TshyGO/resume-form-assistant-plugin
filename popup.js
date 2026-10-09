// 插件状态页（#130 PR 5）。模板、「我的信息」和 AI 配置都搬到了桌面，这一页只说明
// 桌面连没连上，以及 0.4.0 留下的旧数据迁到哪一步了，并提供取回与删除。
(() => {
  self.ResumeProFeedback?.install(report => chrome.runtime.sendMessage({ type: "FEEDBACK_AUTO", report }), { origin: chrome.runtime.getURL("") });
  const TEMPLATE_REASON = { too_large: "超过 24 KB", over_limit: "超过 25 个" };

  /** 桌面连接状态的文案与按钮。模式来自 service worker 的握手。 */
  function describeDesktop(mode, copy) {
    if (mode === "ready") return { text: "已连接桌面程序。", action: null, canOpen: true };
    const view = copy(mode);
    return { text: view.message, action: { label: view.action, kind: view.kind }, canOpen: false };
  }

  /** 迁移区：按阶段给说明、附注与操作。phase 为 none 且没有要取回的模板时整块不显示。 */
  function describeMigration(status) {
    const notes = [];
    const skipped = status?.skipped;
    if (skipped?.profileSecrets) notes.push(`「我的信息」里有 ${skipped.profileSecrets} 项像密码或验证码，按规则不迁移，迁移完成后会随旧数据一起删除。`);
    if (skipped?.profileTooLarge) notes.push("「我的信息」超过 24 KB，没有迁移，仍保留在插件里。");
    if (status?.unmigratedTemplates) {
      const reasons = [...new Set((skipped?.templates || []).map((item) => TEMPLATE_REASON[item.reason]).filter(Boolean))];
      notes.push(`有 ${status.unmigratedTemplates} 个模板没能迁移${reasons.length ? `（${reasons.join("、")}）` : ""}，可以下载 CSV，再到桌面「简历」页导入。`);
    }
    const csv = status?.unmigratedTemplates ? [{ id: "csv", label: "下载未迁移的模板（CSV）" }] : [];
    const resend = { id: "resend", label: "重新发送到桌面", primary: true };
    const discard = { id: "discard", label: "删除插件里的旧数据", danger: true };

    switch (status?.phase) {
      case "sending":
        return { show: true, text: "正在把插件里的旧数据发到桌面…", notes, actions: csv };
      case "waiting":
        return { show: true, text: "旧数据已发到桌面，请到桌面「简历」页确认导入。确认之前，插件里的数据不会删除。", notes, actions: [{ id: "open-resume", label: "打开桌面简历页", primary: true }, ...csv] };
      case "imported":
        return { show: true, text: "旧数据已迁到桌面，插件里的那一份已清理。", notes, actions: csv };
      case "imported_ai_dropped":
        return {
          show: true,
          text: "模板和「我的信息」已按你在桌面的选择迁过去，AI 配置没有导入。请到桌面「设置 → AI 设置」添加服务商；需要的话可以从这里复制旧 API Key。",
          notes,
          actions: status.hasOldKey
            ? [{ id: "copy-key", label: "复制旧 API Key" }, { id: "drop-key", label: "删除旧 Key", danger: true }, ...csv]
            : csv
        };
      case "rejected":
        return { show: true, text: "你在桌面选择了不导入，旧数据仍在插件里。", notes, actions: [resend, ...csv, discard] };
      case "failed":
        return { show: true, text: `桌面没有接受这批数据：${status.error || "原因未知"}`, notes, actions: [resend, ...csv, discard] };
      case "expired":
        return { show: true, text: "上次发送没有在 24 小时内收齐，旧数据仍在插件里。", notes, actions: [resend, ...csv, discard] };
      case "discarded":
        return { show: true, text: "插件里的旧数据已删除。", notes: [], actions: [] };
      default:
        return csv.length ? { show: true, text: "", notes, actions: csv } : { show: false, text: "", notes: [], actions: [] };
    }
  }

  const exported = { describeDesktop, describeMigration };
  if (typeof self !== "undefined" && self.__RESUME_PRO_TEST__) {
    self.ResumeProStatusPage = exported;
    return;
  }

  const $ = (id) => document.getElementById(id);
  // Results are reported in the card that started them, not in a passing toast (#261).
  function report(id, text, tone = "info") {
    $(id).textContent = text;
    $(id).dataset.tone = tone;
    $(id).hidden = !text;
  }

  const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);

  // The connection in short, for the header pill. Same modes as the card below.
  const PILL = {
    ready: ["桌面已连接", "ok"], not_installed: ["桌面未安装", "error"], not_paired: ["桌面未配对", "warn"],
    never_paired: ["桌面未配对", "warn"], incompatible: ["桌面版本不兼容", "error"], unavailable: ["桌面未响应", "warn"]
  };

  /**
   * The one confirmation box for what cannot be undone. Nothing happens before 「主动作」;
   * 取消, Escape and closing change nothing. 取消 has the focus, never the dangerous button.
   */
  function confirmDanger({ title, body, action }) {
    const dialog = $("confirm-dialog");
    $("confirm-title").textContent = title;
    $("confirm-body").replaceChildren(...body.map((line) => {
      if (Array.isArray(line)) {
        const list = document.createElement("ul");
        list.replaceChildren(...line.map((text) => Object.assign(document.createElement("li"), { textContent: text })));
        return list;
      }
      return Object.assign(document.createElement("p"), { textContent: line });
    }));
    $("confirm-ok").textContent = action;
    dialog.returnValue = "";
    return new Promise((resolve) => {
      // Decided by the button that submitted the form; Escape or anything else closing it is a cancel.
      let settled = false;
      const settle = (confirmed) => { if (!settled) { settled = true; resolve(confirmed); } };
      dialog.querySelector("form").addEventListener("submit", (event) => settle(event.submitter?.value === "confirm"), { once: true });
      dialog.addEventListener("close", () => settle(dialog.returnValue === "confirm"), { once: true });
      dialog.showModal();
      $("confirm-cancel").focus();
    });
  }

  async function openView(view, resultId = "desktop-result") {
    const result = await send({ type: "DESKTOP_OPEN_VIEW", view });
    if (result?.status !== "ok") report(resultId, "桌面程序暂时无法打开，请检查连接。", "warn");
    else { report(resultId, ""); await renderDesktop(); }
  }

  async function renderDesktop() {
    const probe = await send({ type: "DESKTOP_PROBE" });
    const mode = probe?.mode || "unavailable";
    const view = describeDesktop(mode, self.ResumeProResumeData.modeCopy);
    $("desktop-text").textContent = view.text;
    const [pill, tone] = PILL[mode] || PILL.unavailable;
    $("desktop-pill").textContent = pill;
    $("desktop-pill").dataset.tone = tone;
    $("desktop-chip").textContent = mode === "ready" ? "已连接桌面程序" : pill;
    $("desktop-chip").dataset.tone = tone;
    $("hero-dot").dataset.tone = tone;
    const action = $("desktop-action");
    action.hidden = !view.action;
    if (view.action) {
      action.textContent = view.action.label;
      action.dataset.kind = view.action.kind;
    }
    $("desktop-open").hidden = !view.canOpen;
  }

  async function renderMigration() {
    const status = await send({ type: "DESKTOP_LEGACY_STATUS" });
    const view = describeMigration(status);
    $("migration").hidden = !view.show;
    $("migration-text").textContent = view.text;
    $("migration-text").hidden = !view.text;
    $("migration-notes").replaceChildren(...view.notes.map((note) => {
      const item = document.createElement("li");
      item.textContent = note;
      return item;
    }));
    $("migration-actions").replaceChildren(...view.actions.map((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.dataset.action = action.id;
      if (action.primary) button.className = "primary";
      if (action.danger) button.className = "danger";
      return button;
    }));
  }

  async function downloadCsv() {
    const result = await send({ type: "DESKTOP_LEGACY_UNMIGRATED" });
    if (!result?.csv) { report("migration-result", "没有需要下载的模板。"); return; }
    const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "网申快填-未迁移模板.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    report("migration-result", "已开始下载 CSV，可以到桌面「简历」页导入。", "ok");
  }

  async function copyOldKey() {
    const { aiConfig } = await chrome.storage.local.get(["aiConfig"]);
    const key = String(aiConfig?.apiKey ?? "").trim();
    if (!key) { report("migration-result", "插件里没有旧 Key。"); return; }
    try {
      await navigator.clipboard.writeText(key);
      report("migration-result", "旧 API Key 已复制。粘贴到桌面后，建议在这里删除旧 Key。", "ok");
    } catch {
      report("migration-result", "复制失败，请重试。", "warn");
    }
  }

  const handlers = {
    "open-resume": () => openView("resume", "migration-result"),
    csv: downloadCsv,
    "copy-key": copyOldKey,
    "drop-key": async () => {
      if (!await confirmDanger({
        title: "删除插件中的旧 API Key？",
        body: ["删除后无法从插件取回。如果还没有粘贴到桌面「设置 → AI 设置」，请先取消并复制旧 Key。"],
        action: "删除旧 Key"
      })) return;
      const result = await send({ type: "DESKTOP_LEGACY_DROP_KEY" });
      report("migration-result", result ? "旧 Key 已删除。" : "没有删除成功，旧 Key 仍在插件里，请稍后重试。", result ? "ok" : "warn");
    },
    resend: async () => {
      const result = await send({ type: "DESKTOP_LEGACY_RESEND" });
      report("migration-result", result ? "已重新发送，请到桌面「简历」页确认。" : "没有发送成功，请确认桌面已打开后重试。", result ? "ok" : "warn");
    },
    discard: async () => {
      if (!await confirmDanger({
        title: "删除插件里的旧数据？",
        body: ["将从插件中删除：", ["旧简历模板", "「我的信息」", "AI 配置（含旧 API Key）"], "桌面里已有的数据不受影响；插件内删除后无法取回。"],
        action: "删除旧数据"
      })) return;
      const result = await send({ type: "DESKTOP_LEGACY_DISCARD" });
      report("migration-result", result ? "删除完成，桌面里已有的数据不受影响。" : "没有删除成功，旧数据仍在插件里，请稍后重试。", result ? "ok" : "warn");
    }
  };

  $("migration-actions").addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    const id = button?.dataset.action;
    if (!handlers[id]) return;
    button.disabled = true;
    try { await handlers[id](); } finally {
      await renderMigration();
      // The buttons were redrawn: keep the keyboard in this card.
      const same = $("migration-actions").querySelector(`[data-action="${id}"]`);
      (same || $("migration-actions").querySelector("button") || $("migration-title"))?.focus?.();
    }
  });

  $("desktop-action").addEventListener("click", async (event) => {
    const kind = event.currentTarget.dataset.kind;
    if (kind === "download") window.open(self.ResumeProResumeData.DOWNLOAD_URL, "_blank", "noopener");
    else if (kind === "pair") {
      const copied = await navigator.clipboard.writeText(chrome.runtime.id).then(() => true, () => false);
      report("desktop-result", copied ? "扩展 ID 已复制，请在桌面「设置 → 浏览器连接」里粘贴完成配对。" : `复制失败，请手动复制扩展 ID：${chrome.runtime.id}`, copied ? "ok" : "warn");
    } else if (kind === "resume") await openView("resume");
    else if (kind === "home") await openView("home");
    else await renderDesktop();
  });
  $("desktop-open").addEventListener("click", () => openView("home"));
  $("desktop-recheck").addEventListener("click", async (event) => {
    event.currentTarget.disabled = true;
    report("desktop-result", "");
    try { await renderDesktop(); } finally { $("desktop-recheck").disabled = false; }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.legacyImport) renderMigration().catch(() => {});
  });

  $("plugin-version").textContent = chrome.runtime.getManifest().version;
  $("plugin-version-top").textContent = chrome.runtime.getManifest().version;
  renderDesktop().catch(() => {});
  renderMigration().catch(() => {});
})();
