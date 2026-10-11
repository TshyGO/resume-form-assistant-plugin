// D12 设置页里的「数据与备份」：备份与恢复、回滚点、回收站、附件清理（#265 改为卡片 + 弹窗）。
//
// 恢复是这个程序里唯一一个会把现有档案整个换掉的操作，所以它是**两步**：
// 先选文件看预览（只读，一个字节都不往盘上写），再在预览弹窗里确认一次。
// 换回回滚点、永久删除、删除附件同样先在弹窗里讲清楚影响，再执行。

import type {
  ApplicationSummary,
  ExportReport,
  Invoke,
  OrphanReport,
  PurgePreview,
  PurgeResult,
  RestorePreview,
  RestoreReport,
  RollbackPoint,
} from "./api.ts";
import { must } from "./dom.ts";
import type { Message } from "./backup.ts";
import {
  EMPTY_RECYCLE,
  EMPTY_ROLLBACK,
  EXPORT_POINTS,
  PURGE_WARNING,
  RESTORE_NOTE,
  defaultBackupName,
  describeExport,
  describeOrphans,
  describeRemindersAfterRestore,
  describeRestore,
  formatTimestamp,
  purgeRows,
  restoreRows,
  rollbackTime,
} from "./backup.ts";
import { factList, fragment, openSettingsDialog, paragraph } from "./settings-dialog.ts";

function invokeError(error: unknown) {
  const detail = error as { message?: string; code?: string } | null;
  return detail?.message || detail?.code || "未知错误";
}

/** 挑文件 / 挑保存位置。没有对话框插件时（浏览器里）就是 null。 */
export interface FilePickers {
  save: ((suggested: string) => Promise<string | null>) | null;
  open: (() => Promise<string | null>) | null;
}

type Tone = Message["tone"] | "error";

function show(element: HTMLElement, message: { tone: Tone; text: string } | null) {
  element.textContent = message?.text ?? "";
  if (message) element.dataset.tone = message.tone;
  else delete element.dataset.tone;
  element.hidden = !message;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function button(label: string, attrs: Record<string, string>, className?: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function emptyItem(text: string, tone?: "error"): HTMLLIElement {
  const li = document.createElement("li");
  li.className = tone === "error" ? "settings-list-empty is-error" : "settings-list-empty";
  li.textContent = text;
  return li;
}

/** 恢复预览弹窗的正文：来源、时间、六类前后对比、替换说明。 */
function restoreBody(path: string, preview: RestorePreview): Node {
  const warnings: Node[] = [];
  if (!preview.sameArchive) {
    warnings.push(paragraph("这份备份来自另一个档案，不是这台机器上这份档案的历史版本。请确认没有拿错文件。", "settings-dialog-warn"));
  }
  const table = document.createElement("table");
  table.className = "settings-compare";
  table.innerHTML = "<thead><tr><th scope=\"col\">类别</th><th scope=\"col\">当前</th><th scope=\"col\">恢复后</th></tr></thead>";
  const body = document.createElement("tbody");
  for (const row of restoreRows(preview)) {
    const tr = document.createElement("tr");
    if (row.changed) tr.className = "is-changed";
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = row.label;
    const current = document.createElement("td");
    current.textContent = String(row.current);
    const incoming = document.createElement("td");
    incoming.textContent = String(row.incoming);
    tr.append(th, current, incoming);
    body.append(tr);
  }
  table.append(body);
  const rollbackWarning = preview.tooManyRollbackPoints
    ? paragraph(`已经有 ${preview.existingRollbackPoints} 个回滚点。程序不会自动删它们，占地方的话请自己清理。`, "settings-dialog-warn")
    : null;
  return fragment(
    factList([
      ["备份文件", fileName(path)],
      ["创建时间", formatTimestamp(preview.createdAt)],
    ]),
    ...warnings,
    table,
    paragraph(RESTORE_NOTE, "settings-dialog-note"),
    rollbackWarning,
  );
}

/**
 * `onRestored`：恢复或换回成功、档案已被整个换掉之后调。别的页面（比如「简历」）
 * 手里还拿着旧档案读出来的内容，靠它重新读取。
 */
export function mountBackup(
  invoke: Invoke,
  pickers: FilePickers,
  now: () => Date = () => new Date(),
  onRestored: () => void = () => {},
) {
  const status = must("backup-status");
  const exportNote = must("backup-export-note");
  const restoreNote = must("backup-restore-note");
  const rollbackList = must("backup-rollback-list");
  const rollbackCount = must("backup-rollback-count");
  const rollbackStatus = must("rollback-status");
  const recycleList = must("recycle-list");
  const recycleCount = must("recycle-count");
  const recycleStatus = must("recycle-status");
  const orphanBox = must("orphan-report");
  const exportButton = must("backup-export") as HTMLButtonElement;
  const restoreButton = must("backup-choose-restore") as HTMLButtonElement;

  exportNote.replaceChildren(
    ...EXPORT_POINTS.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
  restoreNote.textContent = RESTORE_NOTE;

  let busy = false;

  /**
   * 同一时间只做一件事；做的时候把触发它的按钮标成忙。不禁用按钮：禁用会把焦点弄丢，
   * 弹窗关掉后就回不到触发它的那个按钮了。重复点击由 busy 挡掉。
   */
  async function guarded(trigger: HTMLButtonElement | null, work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    trigger?.setAttribute("aria-busy", "true");
    try {
      await work();
    } finally {
      busy = false;
      trigger?.removeAttribute("aria-busy");
    }
  }

  exportButton.addEventListener("click", () =>
    guarded(exportButton, async () => {
      if (!pickers.save) {
        show(status, { tone: "warn", text: "浏览器里没有文件对话框，请在桌面程序里导出。" });
        return;
      }
      const destination = await pickers.save(defaultBackupName(now()));
      if (!destination) return;
      show(status, { tone: "pending", text: "正在导出……" });
      try {
        const report = await invoke<ExportReport>("export_archive_cmd", { destination });
        show(status, describeExport(report.path, report.sizeBytes, report.skipped));
      } catch (error) {
        show(status, { tone: "error", text: `导出失败：${invokeError(error)}` });
      }
    }),
  );

  restoreButton.addEventListener("click", () =>
    guarded(restoreButton, async () => {
      if (!pickers.open) {
        show(status, { tone: "warn", text: "浏览器里没有文件对话框，请在桌面程序里恢复。" });
        return;
      }
      const path = await pickers.open();
      if (!path) return;
      show(status, { tone: "pending", text: "正在检查备份……" });
      let preview: RestorePreview;
      try {
        // 预览只读清单，不往盘上写东西。用户点确认之前什么都没发生。
        preview = await invoke<RestorePreview>("preview_restore_cmd", { package: path });
      } catch (error) {
        show(status, { tone: "error", text: `这个备份用不了：${invokeError(error)}` });
        return;
      }
      show(status, { tone: "info", text: `已选择备份 ${fileName(path)}（创建于 ${formatTimestamp(preview.createdAt)}），等待确认。` });
      let report: RestoreReport | null = null;
      const confirmed = await openSettingsDialog({
        title: "恢复这份备份？",
        intro: "核对下面的对比。确认后，当前档案会被整个替换（不是合并）。",
        body: restoreBody(path, preview),
        confirmLabel: "恢复并替换当前档案",
        busyLabel: "正在恢复…",
        size: "lg",
        action: async () => {
          show(status, { tone: "pending", text: "正在恢复……" });
          try {
            report = await invoke<RestoreReport>("restore_archive_cmd", { package: path });
          } catch (error) {
            show(status, { tone: "error", text: `恢复失败：${invokeError(error)}` });
            throw new Error(`恢复失败：${invokeError(error)}`);
          }
        },
      });
      if (!confirmed || !report) {
        // 恢复失败后用户取消：失败原因已经在状态行里，不要用「已取消」盖掉。
        if (status.dataset.tone !== "error") show(status, { tone: "info", text: "已取消恢复，当前档案没有改动。" });
        return;
      }
      const done = report as RestoreReport;
      const lines = [describeRestore(done.counts, done.rollbackPoint)];
      const reminders = describeRemindersAfterRestore(done.remindersCleared);
      if (reminders) lines.push(reminders);
      show(status, { tone: "success", text: lines.map((line) => line.text).join(" ") });
      onRestored();
      await refreshRollback();
    }),
  );

  // --- 回滚点 -----------------------------------------------------------------------

  async function refreshRollback() {
    try {
      const points = await invoke<RollbackPoint[]>("list_rollback_points_cmd", {});
      rollbackCount.textContent = `（${points.length} 个）`;
      rollbackList.replaceChildren(
        ...(points.length
          ? points.map((point) => {
              const li = document.createElement("li");
              const info = document.createElement("div");
              const when = document.createElement("strong");
              when.textContent = rollbackTime(point);
              const id = document.createElement("code");
              id.textContent = point.id;
              info.append(when, id);
              li.append(info, button("换回这一份", { "data-rollback": point.id, "data-when": rollbackTime(point) }));
              return li;
            })
          : [emptyItem(EMPTY_ROLLBACK)]),
      );
    } catch (error) {
      rollbackCount.textContent = "";
      rollbackList.replaceChildren(emptyItem(`读取回滚点失败：${invokeError(error)}`, "error"));
    }
  }

  rollbackList.addEventListener("click", (event) => {
    const trigger = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-rollback]");
    if (!trigger) return;
    void guarded(trigger, async () => {
      const id = trigger.dataset.rollback ?? "";
      let report: RestoreReport | null = null;
      show(rollbackStatus, null);
      const confirmed = await openSettingsDialog({
        title: "换回这个回滚点？",
        body: fragment(
          factList([
            ["存档时间", trigger.dataset.when ?? ""],
            ["标识", id],
          ]),
          paragraph("当前档案会被整个换成这一份。当前这份不会删掉，会另存为一个新的回滚点，之后还能换回来。", "settings-dialog-note"),
        ),
        confirmLabel: "换回这一份",
        busyLabel: "正在换回…",
        size: "md",
        action: async () => {
          try {
            report = await invoke<RestoreReport>("rollback_to_cmd", { id });
          } catch (error) {
            show(rollbackStatus, { tone: "error", text: `换回失败：${invokeError(error)}` });
            throw new Error(`换回失败：${invokeError(error)}`);
          }
        },
      });
      if (!confirmed || !report) return;
      const done = report as RestoreReport;
      const lines = [describeRestore(done.counts, done.rollbackPoint)];
      const reminders = describeRemindersAfterRestore(done.remindersCleared);
      if (reminders) lines.push(reminders);
      show(rollbackStatus, { tone: "success", text: lines.map((line) => line.text).join(" ") });
      onRestored();
      await refreshRollback();
    });
  });

  // --- 回收站 -------------------------------------------------------------------------

  async function refreshRecycle() {
    try {
      const items = await invoke<ApplicationSummary[]>("list_recycled_cmd", {});
      recycleCount.textContent = `（${items.length} 条）`;
      recycleList.replaceChildren(
        ...(items.length
          ? items.map((item) => {
              const li = document.createElement("li");
              const info = document.createElement("div");
              const company = document.createElement("strong");
              company.textContent = item.company;
              const title = document.createElement("span");
              title.textContent = item.title;
              info.append(company, title);
              const actions = document.createElement("div");
              actions.className = "settings-list-actions";
              actions.append(
                button("恢复", { "data-recycle-restore": item.id }),
                button("永久删除", { "data-purge": item.id }, "settings-danger"),
              );
              li.append(info, actions);
              return li;
            })
          : [emptyItem(EMPTY_RECYCLE)]),
      );
    } catch (error) {
      recycleCount.textContent = "";
      recycleList.replaceChildren(emptyItem(`读取回收站失败：${invokeError(error)}`, "error"));
    }
  }

  recycleList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const restore = target?.closest<HTMLButtonElement>("button[data-recycle-restore]");
    const purge = target?.closest<HTMLButtonElement>("button[data-purge]");
    if (restore) {
      void guarded(restore, async () => {
        try {
          await invoke("set_recycled_cmd", { id: restore.dataset.recycleRestore, recycled: false });
          show(recycleStatus, { tone: "success", text: "已从回收站恢复，可以在「申请」里看到它。" });
          await refreshRecycle();
        } catch (error) {
          show(recycleStatus, { tone: "error", text: `恢复失败：${invokeError(error)}` });
        }
      });
      return;
    }
    if (!purge) return;
    void guarded(purge, async () => {
      const id = purge.dataset.purge ?? "";
      show(recycleStatus, null);
      let preview: PurgePreview;
      try {
        // 先让用户看清会连带删掉什么，再问一次。
        preview = await invoke<PurgePreview>("purge_preview_cmd", { id });
      } catch (error) {
        show(recycleStatus, { tone: "error", text: `读不到要删除的内容：${invokeError(error)}` });
        return;
      }
      let result: PurgeResult | null = null;
      const confirmed = await openSettingsDialog({
        title: "永久删除这条申请？",
        intro: `${preview.company} · ${preview.title}`,
        body: fragment(
          paragraph("会连带删除：", "settings-dialog-label"),
          factList(purgeRows(preview)),
          paragraph(PURGE_WARNING, "settings-dialog-warn"),
        ),
        confirmLabel: "永久删除",
        busyLabel: "正在删除…",
        tone: "danger",
        size: "md",
        action: async () => {
          try {
            result = await invoke<PurgeResult>("purge_application_cmd", { id });
          } catch (error) {
            show(recycleStatus, { tone: "error", text: `删除失败：${invokeError(error)}` });
            throw new Error(`删除失败：${invokeError(error)}`);
          }
        },
      });
      if (!confirmed || !result) return;
      const done = result as PurgeResult;
      const left = done.attachmentFilesLeft.length
        ? ` 另有 ${done.attachmentFilesLeft.length} 份附件的记录已删，但文件没找到或没删掉。`
        : "";
      show(recycleStatus, {
        tone: "success",
        text: `已永久删除「${preview.company} · ${preview.title}」，同时清理了 ${done.attachmentFilesRemoved} 份没人引用的附件。${left}`,
      });
      await refreshRecycle();
    });
  });

  // --- 附件清理 -----------------------------------------------------------------------

  const orphanCheck = must("orphan-check") as HTMLButtonElement;
  const orphanStatus = document.createElement("p");
  orphanStatus.className = "settings-inline-msg";
  orphanStatus.setAttribute("role", "status");
  orphanStatus.hidden = true;

  orphanCheck.addEventListener("click", () =>
    guarded(orphanCheck, async () => {
      show(orphanStatus, null);
      let report: OrphanReport;
      try {
        report = await invoke<OrphanReport>("orphan_report_cmd", {});
      } catch (error) {
        orphanBox.replaceChildren(orphanStatus);
        show(orphanStatus, { tone: "error", text: `检查失败：${invokeError(error)}` });
        return;
      }
      const message = describeOrphans(report);
      const summary = document.createElement("div");
      summary.className = "settings-callout";
      summary.dataset.tone = message.tone;
      summary.textContent = message.text;
      const nodes: Node[] = [summary];
      // 只报告：每一项都要用户自己点。有悬空引用时一个都不给删。
      if (report.zeroRefBlobs.length && !report.danglingEvidence.length) {
        const list = document.createElement("ul");
        list.className = "settings-list orphan-list";
        list.append(
          ...report.zeroRefBlobs.map((sha) => {
            const li = document.createElement("li");
            const info = document.createElement("div");
            const label = document.createElement("span");
            label.textContent = "附件标识（SHA-256）";
            const code = document.createElement("code");
            code.textContent = sha;
            info.append(label, code);
            li.append(info, button("删除这份附件", { "data-orphan": sha }, "settings-danger"));
            return li;
          }),
        );
        nodes.push(list);
      }
      nodes.push(orphanStatus);
      orphanBox.replaceChildren(...nodes);
    }),
  );

  orphanBox.addEventListener("click", (event) => {
    const trigger = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-orphan]");
    if (!trigger) return;
    void guarded(trigger, async () => {
      const sha = trigger.dataset.orphan ?? "";
      show(orphanStatus, null);
      const confirmed = await openSettingsDialog({
        title: "删除这份未引用的附件？",
        body: fragment(
          factList([["附件标识（SHA-256）", sha]]),
          paragraph("检查时它没有被任何证据引用。删除后无法恢复；如果在这之后它又被证据引用，桌面会拒绝删除。", "settings-dialog-warn"),
        ),
        confirmLabel: "删除这份附件",
        busyLabel: "正在删除…",
        tone: "danger",
        size: "md",
        action: async () => {
          await invoke("remove_orphan_cmd", { sha256: sha });
        },
        describeError: (error) => `没有删除：${invokeError(error)}`,
      });
      if (!confirmed) return;
      const item = trigger.closest("li");
      const list = item?.parentElement;
      item?.remove();
      const remaining = list?.children.length ?? 0;
      if (list && remaining === 0) list.remove();
      show(orphanStatus, {
        tone: "success",
        text: remaining ? `已删除这份附件，还剩 ${remaining} 份未引用的附件。` : "已删除这份附件。未引用的附件都处理完了。",
      });
    });
  });

  return async function refresh() {
    await refreshRollback();
    await refreshRecycle();
  };
}
