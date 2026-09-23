// D12 设置页里的「备份与恢复」和「回收站」。
//
// 恢复是这个程序里唯一一个会把现有档案整个换掉的操作，所以它是**两步**：
// 先选文件看预览，再点确认。预览阶段一个字节都不往盘上写。

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
  EXPORT_NOTE,
  PURGE_WARNING,
  RESTORE_NOTE,
  defaultBackupName,
  describeExport,
  describeOrphans,
  describePreview,
  describePurgePreview,
  describeRemindersAfterRestore,
  describeRestore,
} from "./backup.ts";

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

/** 挑文件 / 挑保存位置。没有对话框插件时（浏览器里）就是 null。 */
export interface FilePickers {
  save: ((suggested: string) => Promise<string | null>) | null;
  open: (() => Promise<string | null>) | null;
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
  const previewBox = must("backup-preview");
  const previewText = must("backup-preview-text");
  const rollbackList = must("backup-rollback-list");
  const recycleList = must("recycle-list");
  const orphanBox = must("orphan-report");

  /** 已经通过预览、等着用户点确认的那个包。 */
  let pending: { path: string; preview: RestorePreview } | null = null;
  let busy = false;

  function say(message: Message | null) {
    status.textContent = message?.text ?? "";
    status.className = message ? `note ${message.tone}` : "note";
  }

  function clearPending() {
    pending = null;
    previewBox.hidden = true;
    previewText.innerHTML = "";
  }

  async function guarded(work: () => Promise<void>) {
    if (busy) return;
    busy = true;
    try {
      await work();
    } finally {
      busy = false;
    }
  }

  must("backup-export").addEventListener("click", () =>
    guarded(async () => {
      if (!pickers.save) {
        say({ tone: "warn", text: "浏览器里没有文件对话框，请在桌面程序里导出。" });
        return;
      }
      const destination = await pickers.save(defaultBackupName(now()));
      if (!destination) return;
      say({ tone: "pending", text: "正在导出……" });
      try {
        const report = await invoke<ExportReport>("export_archive_cmd", { destination });
        say(describeExport(report.path, report.sizeBytes, report.skipped));
      } catch (error) {
        say({ tone: "warn", text: `导出失败：${invokeError(error)}` });
      }
    }),
  );

  must("backup-choose-restore").addEventListener("click", () =>
    guarded(async () => {
      clearPending();
      if (!pickers.open) {
        say({ tone: "warn", text: "浏览器里没有文件对话框，请在桌面程序里恢复。" });
        return;
      }
      const path = await pickers.open();
      if (!path) return;
      say({ tone: "pending", text: "正在检查备份……" });
      try {
        // 预览只读清单，不往盘上写东西。用户点确认之前什么都没发生。
        const preview = await invoke<RestorePreview>("preview_restore_cmd", { package: path });
        pending = { path, preview };
        previewText.innerHTML = describePreview(preview)
          .map((line) => `<p class="note ${line.tone}">${escapeHtml(line.text)}</p>`)
          .join("");
        previewBox.hidden = false;
        say({ tone: "info", text: `备份创建于 ${preview.createdAt}。看一眼下面的对比再确认。` });
      } catch (error) {
        say({ tone: "warn", text: `这个备份用不了：${invokeError(error)}` });
      }
    }),
  );

  must("backup-confirm-restore").addEventListener("click", () =>
    guarded(async () => {
      if (!pending) return;
      const path = pending.path;
      say({ tone: "pending", text: "正在恢复……" });
      try {
        const report = await invoke<RestoreReport>("restore_archive_cmd", { package: path });
        clearPending();
        const lines = [describeRestore(report.counts, report.rollbackPoint)];
        const reminders = describeRemindersAfterRestore(report.remindersCleared);
        if (reminders) lines.push(reminders);
        say({ tone: "success", text: lines.map((line) => line.text).join(" ") });
        onRestored();
        await refreshRollback();
      } catch (error) {
        say({ tone: "warn", text: `恢复失败：${invokeError(error)}` });
      }
    }),
  );

  must("backup-cancel-restore").addEventListener("click", () => {
    clearPending();
    say(null);
  });

  async function refreshRollback() {
    try {
      const points = await invoke<RollbackPoint[]>("list_rollback_points_cmd", {});
      rollbackList.innerHTML = points.length
        ? points
            .map(
              (point) =>
                `<li>${escapeHtml(point.retiredAt)}<button type="button" data-rollback="${escapeHtml(point.id)}">换回这一份</button></li>`,
            )
            .join("")
        : `<li class="muted">${EMPTY_ROLLBACK}</li>`;
    } catch {
      rollbackList.innerHTML = `<li class="muted">${EMPTY_ROLLBACK}</li>`;
    }
  }

  rollbackList.addEventListener("click", (event) =>
    guarded(async () => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("button[data-rollback]");
      if (!button) return;
      const id = button.dataset.rollback ?? "";
      say({ tone: "pending", text: "正在换回……" });
      try {
        const report = await invoke<RestoreReport>("rollback_to_cmd", { id });
        say(describeRestore(report.counts, report.rollbackPoint));
        onRestored();
        await refreshRollback();
      } catch (error) {
        say({ tone: "warn", text: `换回失败：${invokeError(error)}` });
      }
    }),
  );

  // --- 回收站 -------------------------------------------------------------------------

  async function refreshRecycle() {
    try {
      const items = await invoke<ApplicationSummary[]>("list_recycled_cmd", {});
      recycleList.innerHTML = items.length
        ? items
            .map(
              (item) => `
                <li>
                  ${escapeHtml(item.company)} · ${escapeHtml(item.title)}
                  <button type="button" data-recycle-restore="${escapeHtml(item.id)}">恢复</button>
                  <button type="button" class="danger" data-purge="${escapeHtml(item.id)}">永久删除</button>
                </li>`,
            )
            .join("")
        : `<li class="muted">${EMPTY_RECYCLE}</li>`;
    } catch {
      recycleList.innerHTML = `<li class="muted">${EMPTY_RECYCLE}</li>`;
    }
  }

  recycleList.addEventListener("click", (event) =>
    guarded(async () => {
      const target = event.target as HTMLElement | null;
      const restoreButton = target?.closest<HTMLElement>("button[data-recycle-restore]");
      const purgeButton = target?.closest<HTMLElement>("button[data-purge]");

      if (restoreButton) {
        try {
          await invoke("set_recycled_cmd", { id: restoreButton.dataset.recycleRestore, recycled: false });
          say({ tone: "success", text: "已从回收站恢复。" });
          await refreshRecycle();
        } catch (error) {
          say({ tone: "warn", text: `恢复失败：${invokeError(error)}` });
        }
        return;
      }

      if (purgeButton) {
        const id = purgeButton.dataset.purge ?? "";
        try {
          // 先让用户看清会连带删掉什么，再问一次。
          const preview = await invoke<PurgePreview>("purge_preview_cmd", { id });
          if (!window.confirm(`${describePurgePreview(preview)}\n\n${PURGE_WARNING}`)) return;
          const result = await invoke<PurgeResult>("purge_application_cmd", { id });
          say({
            tone: "success",
            text: `已永久删除，同时清理了 ${result.attachmentFilesRemoved} 份没人引用的附件。`,
          });
          await refreshRecycle();
        } catch (error) {
          say({ tone: "warn", text: `删除失败：${invokeError(error)}` });
        }
      }
    }),
  );

  must("orphan-check").addEventListener("click", () =>
    guarded(async () => {
      try {
        const report = await invoke<OrphanReport>("orphan_report_cmd", {});
        const message = describeOrphans(report);
        orphanBox.innerHTML = `<p class="note ${message.tone}">${escapeHtml(message.text)}</p>`;
        // 只报告：每一项都要用户自己点。
        if (report.zeroRefBlobs.length && !report.danglingEvidence.length) {
          orphanBox.innerHTML += report.zeroRefBlobs
            .map(
              (sha) =>
                `<div class="row"><code>${escapeHtml(sha.slice(0, 16))}</code><button type="button" data-orphan="${escapeHtml(sha)}">删除这一份</button></div>`,
            )
            .join("");
        }
      } catch (error) {
        say({ tone: "warn", text: `检查失败：${invokeError(error)}` });
      }
    }),
  );

  orphanBox.addEventListener("click", (event) =>
    guarded(async () => {
      const button = (event.target as HTMLElement | null)?.closest<HTMLElement>("button[data-orphan]");
      if (!button) return;
      try {
        await invoke("remove_orphan_cmd", { sha256: button.dataset.orphan });
        say({ tone: "success", text: "已删除这份附件。" });
      } catch (error) {
        say({ tone: "warn", text: `没有删除：${invokeError(error)}` });
      }
    }),
  );

  return async function show(preservePending = false) {
    exportNote.textContent = EXPORT_NOTE;
    restoreNote.textContent = RESTORE_NOTE;
    if (!preservePending) clearPending();
    await refreshRollback();
    await refreshRecycle();
  };
}
