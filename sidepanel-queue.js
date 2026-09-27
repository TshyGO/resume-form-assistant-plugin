// The native side panel's pending list (#178): what is still waiting to reach the desktop,
// and what the user can do about each entry.
//
// Everything listed comes from the worker's existing queue (DESKTOP_LIST_QUEUE): SaveIntents,
// fill records waiting for an application, and bound messages. This file only turns that
// into rows; every action goes back through the existing DESKTOP_* messages. Wording is
// link/copy.mjs's, passed in as `copy`. Nothing here is a second queue, and a row never
// says "saved": whatever is listed has not reached the desktop yet.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ResumeProQueue = api;
})(typeof self !== "undefined" ? self : globalThis, () => {
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

  // What the desktop shows as an application's id; checked before anything typed is bound.
  const APPLICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function isApplicationId(value) {
    return typeof value === "string" && APPLICATION_ID.test(value.trim());
  }

  function queueTotal(reply) {
    return (reply?.intents?.length || 0) + (reply?.outbox?.length || 0) + (reply?.fillRecords?.length || 0);
  }

  const action = (id, label, extra = {}) => ({ action: id, label, ...extra });

  /**
   * One row per waiting item, in the order the page overlay lists them. `formatTime` turns
   * an ISO time into a clock for "下次重试".
   */
  function buildRows(reply, copy, { formatTime = null } = {}) {
    const rows = [];
    const expired = new Set(reply?.expiredSnapshots || []);

    for (const record of reply?.fillRecords || []) {
      if (!record?.recordId) continue;
      const job = [record.job?.company, record.job?.title].filter(Boolean).join(" · ");
      const row = {
        key: `fill:${record.recordId}`, kind: "fill", recordId: record.recordId,
        job: { company: record.job?.company || "", title: record.job?.title || "", sourceUrl: record.job?.sourceUrl || "" },
        title: `填写留档 · ${record.fill?.templateName || "未命名模板"}`,
        subtitle: job || "网页没有写明公司",
        state: "待同步（尚未选择申请），还没有留档到桌面",
        notes: [],
        actions: [action("choose-fill", "选择申请")]
      };
      if (record.snapshot?.snapshotId && expired.has(record.snapshot.snapshotId)) {
        row.notes.push("附带的简历快照已暂存超过 30 天。不处理会继续保留；不需要了可以丢弃，填写记录不受影响。");
        row.actions.push(action("drop-snapshot", "丢弃快照", { snapshotId: record.snapshot.snapshotId }));
      }
      row.actions.push(action("remove-fill", "删除"));
      rows.push(row);
    }

    for (const intent of reply?.intents || []) {
      if (!intent?.intentId) continue;
      rows.push({
        key: `intent:${intent.intentId}`, kind: "intent", intentId: intent.intentId,
        title: `${intent.fields?.company || ""} · ${intent.fields?.title || ""}`,
        subtitle: "保存岗位",
        state: intent.status === "pending_bind" ? "待绑定申请，还没有写入桌面" : "待同步（尚未绑定申请），还没有写入桌面",
        notes: [],
        actions: [action("continue-intent", "完成保存"), action("remove-intent", "删除")]
      });
    }

    const outbox = reply?.outbox || [];
    for (const entry of outbox.filter((item) => item?.messageType === "snapshot.upload")) {
      const described = copy.describeSnapshotUpload(entry, { expired: expired.has(entry.snapshotId) });
      const row = {
        key: `message:${entry.messageId}`, kind: "snapshot", messageId: entry.messageId, snapshotId: entry.snapshotId,
        recordId: entry.recordId || null,
        title: copy.describeQueueEntryLabel(entry), subtitle: "", state: described.text, notes: [], actions: []
      };
      if (entry.status === "paused" || entry.status === "needs_user") {
        // After a restore the only ways out are the user's: upload the kept original again
        // under a new identity, or let it go. Never a plain retry of the old chunks.
        row.notes.push(copy.describeSnapshotReconcile(entry.reconcileStatus).text);
        row.actions.push(action("resolve-resave", "重新上传到当前档案"), action("resolve-discard", "丢弃快照"));
      } else {
        if (described.retry) row.actions.push(action("retry", "立即重试"));
        row.actions.push(action("drop-snapshot", entry.status === "bytes_lost" ? "移除" : "丢弃快照", { snapshotId: entry.snapshotId }));
      }
      rows.push(row);
    }

    for (const entry of outbox.filter((item) => item && item.messageType !== "snapshot.upload")) {
      const row = {
        key: `message:${entry.messageId}`, kind: "message", messageId: entry.messageId,
        recordId: entry.recordId || null, messageType: entry.messageType,
        title: copy.describeQueueEntryLabel(entry),
        subtitle: entry.messageType === "fill.submit" ? "填写留档，已选好申请" : "",
        state: copy.describeQueueEntryState(entry, { formatTime }), notes: [], actions: []
      };
      if (entry.status === "needs_user" || entry.status === "paused") {
        // No "retry": the stamped epoch is gone, and only the user decides what happens next.
        row.notes.push(copy.describeReconcileStatus(entry.reconcileStatus).text);
        row.actions.push(action("resolve-associate", "关联到已有申请"), action("resolve-resave", "另存为新的"),
          action("resolve-discard", "丢弃"));
      } else {
        row.actions.push(action("retry", "立即重试"), action("cancel-message", "取消"));
      }
      rows.push(row);
    }
    return rows;
  }

  // A continued job save, in the same words the page overlay uses (content.js describeCommit).
  function describeContinueResult(copy, result) {
    const status = result?.status;
    if (status === "saved" || status === "pending" || status === "failed" || status === "unknown") {
      return copy.describeBindResult(result);
    }
    if (status === "duplicate" && result?.reason === "already_queued") return copy.describeBindResult(result);
    if (status === "rejected" && ["unknown_intent", "no_identity", "awaiting_reconcile", "not_paused"].includes(result.reason)) {
      return copy.describeBindResult(result);
    }
    if (status === "rejected" && result.reason === "queue_full" && result.intent) return copy.describeBindResult(result);
    return copy.describeSaveResult(result ?? { status: "error" });
  }

  /**
   * `ui` holds each row's open question: { mode: "choices" | "id" | "", candidates, busy,
   * message: { tone, text }, allowNew, idLabel }. Candidates show "公司 · 岗位（阶段）" only;
   * the application id stays in a data attribute and is never printed.
   */
  function renderRows(rows, ui = new Map(), { focusKey = "" } = {}) {
    return rows.map((row) => {
      const open = ui.get(row.key) || {};
      const busy = Boolean(open.busy);
      const buttons = row.actions.map((item) => `<button type="button" data-queue-action="${escapeHtml(item.action)}" data-key="${escapeHtml(row.key)}"${item.snapshotId ? ` data-snapshot-id="${escapeHtml(item.snapshotId)}"` : ""}${busy ? " disabled" : ""}>${escapeHtml(item.label)}</button>`).join("");
      let question = "";
      if (open.mode === "choices") {
        const choices = (open.candidates || []).map((candidate) => `<button type="button" data-queue-action="pick" data-key="${escapeHtml(row.key)}" data-application-id="${escapeHtml(candidate.applicationId)}"${busy ? " disabled" : ""}>${escapeHtml(candidate.label)}</button>`).join("");
        const extra = open.allowNew ? `<button type="button" data-queue-action="pick-new" data-key="${escapeHtml(row.key)}"${busy ? " disabled" : ""}>另存为新的岗位</button>` : "";
        question = `<div class="queue-question"><p>${escapeHtml(open.prompt || "这次填写属于哪条申请？")}</p><div class="queue-choices">${choices}${extra}</div><button type="button" class="queue-link" data-queue-action="close-question" data-key="${escapeHtml(row.key)}"${busy ? " disabled" : ""}>收起</button></div>`;
      } else if (open.mode === "id") {
        question = `<div class="queue-question"><label class="queue-id-label" for="queue-id-${escapeHtml(row.key)}">${escapeHtml(open.idLabel || "请粘贴桌面里的申请 ID")}</label><input class="queue-id" id="queue-id-${escapeHtml(row.key)}" data-key="${escapeHtml(row.key)}" type="text" autocomplete="off" spellcheck="false" value="${escapeHtml(open.typed || "")}"${busy ? " disabled" : ""}><div class="queue-choices"><button type="button" data-queue-action="submit-id" data-key="${escapeHtml(row.key)}"${busy ? " disabled" : ""}>确定</button><button type="button" data-queue-action="close-question" data-key="${escapeHtml(row.key)}"${busy ? " disabled" : ""}>取消</button></div></div>`;
      }
      const message = open.message?.text
        ? `<p class="queue-message is-${escapeHtml(open.message.tone || "info")}" role="status">${escapeHtml(open.message.text)}</p>` : "";
      const notes = row.notes.map((note) => `<p class="queue-note">${escapeHtml(note)}</p>`).join("");
      return `<div class="queue-row${row.key === focusKey ? " is-focused" : ""}" data-key="${escapeHtml(row.key)}"${row.recordId ? ` data-record-id="${escapeHtml(row.recordId)}"` : ""}>
        <p class="queue-title">${escapeHtml(row.title)}</p>
        ${row.subtitle ? `<p class="queue-subtitle">${escapeHtml(row.subtitle)}</p>` : ""}
        <p class="queue-state">${escapeHtml(row.state)}</p>${notes}${message}${question}
        <div class="queue-actions">${buttons}</div>
      </div>`;
    }).join("");
  }

  return { isApplicationId, queueTotal, buildRows, describeContinueResult, renderRows };
});
