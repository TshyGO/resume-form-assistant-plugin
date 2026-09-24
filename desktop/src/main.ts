import type { Invoke, RuntimeStatus } from "./api.ts";
import { input, must } from "./dom.ts";
import { createPairingController } from "./pairing-form.ts";
import {
  AFTER_INSTALL_HINT,
  STORE_PENDING_HINT,
  describeLink,
  registrationCompleted,
} from "./browser-link.ts";
import type { NativeMessagingRegistrationOutcome } from "./browser-link.ts";
import { describeCheckFailure, describeUpdate, shouldCheck } from "./update-check.ts";
import type { UpdateInfo, UpdatePreference } from "./update-check.ts";
import { mountApplications } from "./applications-ui.ts";
import { mountInbox } from "./inbox-ui.ts";
import { mountTodos } from "./todos-ui.ts";
import { mountBackup } from "./backup-ui.ts";
import { mountSettingsNavigation } from "./settings-navigation.ts";
import { mountRuntimeStatus } from "./react/runtime-status-mount.tsx";
import { mountAiReview, mountAiSettings } from "./ai/mount.tsx";
import { mountResume } from "./resume/mount.tsx";
import { targetForOpenView } from "./open-view.ts";
import type { ReminderCapability } from "./api.ts";
import {
  DELIVERY_WINDOW_NOTE,
  LIFECYCLE_STATES,
  QUIT_WARNING,
  describeCapability,
} from "./todos.ts";

const invoke: Invoke | undefined = window.__TAURI__?.core?.invoke;
const pairing = createPairingController();
const chromeInput = input("chrome-id");
const runtimeStatusView = mountRuntimeStatus(must("facts"), invoke ?? null);
mountAiSettings(must("ai-settings"), invoke ?? null);
const edgeInput = input("edge-id");
const settingsNavigation = mountSettingsNavigation(must("view-settings"), (name) => {
  if (name === "data") void showBackup(true).catch(() => {});
});

const views: Record<string, HTMLElement> = {
  applications: must("view-applications"),
  resume: must("view-resume"),
  inbox: must("view-inbox"),
  todos: must("view-todos"),
  settings: must("view-settings"),
};

function showRoute(name: string | undefined) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== name);
  });
  document.querySelectorAll<HTMLElement>(".nav button[data-route]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === name);
    if (btn.dataset.route === name) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
}

document.querySelectorAll<HTMLElement>(".nav button[data-route]").forEach((btn) => {
  btn.addEventListener("click", () => {
    // 从别的页切进「简历」时重新读取：插件或恢复备份可能在这期间改过档案。
    // 已经在「简历」页时再点不刷新，免得把正在填的「我的信息」冲掉。
    const enteringResume = btn.dataset.route === "resume" && views.resume.classList.contains("hidden");
    showRoute(btn.dataset.route);
    if (enteringResume) resumeView.refresh();
    // 待办的逾期汇总要在进入视图时算一次，不能在启动时就把它消费掉。
    if (btn.dataset.route === "todos") void showTodos().catch(() => {});
    if (btn.dataset.route === "settings" && !must("settings-data").hidden) void showBackup(true).catch(() => {});
  });
});

chromeInput.addEventListener("input", () => pairing.markChromeDirty());
edgeInput.addEventListener("input", () => pairing.markEdgeDirty());

function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function applyPairingFields(result: { applied: boolean; chrome?: string; edge?: string }) {
  if (!result.applied) {
    return;
  }
  if (result.chrome !== undefined) {
    chromeInput.value = result.chrome;
  }
  if (result.edge !== undefined) {
    edgeInput.value = result.edge;
  }
}

async function refreshStatus() {
  if (!invoke) {
    must("runtime-pill").textContent = "未连接到桌面宿主（请用 Tauri 启动，不要只打开浏览器）";
    must("settings-version").textContent = "请在桌面应用中查看版本";
    return;
  }
  const token = pairing.beginRefresh();
  const status = await invoke<RuntimeStatus>("get_runtime_status");
  must("runtime-pill").textContent = status.runtimeLabel;
  must("settings-version").textContent = `版本 ${status.appVersion}`;
  const banner = must("banner");
  if (status.error) {
    banner.classList.remove("hidden");
    banner.textContent = `${status.error.code}: ${status.error.message}。${status.error.hint}`;
  } else {
    banner.classList.add("hidden");
  }
  runtimeStatusView.update(status);
  applyPairingFields(pairing.applyStatus(token, status.pairing));
  applyLinkState(status);
  void maybeAutoCheck(status);
}

function goToExtensionInstall() {
  showRoute("settings");
  settingsNavigation.select("browser");
  const target = must("link-install-section");
  target.scrollIntoView({ block: "nearest" });
  (must("link-install") as HTMLButtonElement).focus();
}

/** 「连接浏览器」这一段：状态、下一步、重试按钮显不显示。商店/下载入口始终在。 */
function applyLinkState(status: RuntimeStatus | null) {
  const state = describeLink(status);
  const line = must("link-state");
  line.textContent = state.text;
  line.className = `note ${state.tone}`;
  must("link-next").textContent = state.next;
  (must("link-install") as HTMLButtonElement).hidden = false;
  (must("link-download") as HTMLButtonElement).hidden = false;
  (must("link-retry") as HTMLButtonElement).hidden = !state.showRetry;
  must("link-after-install").textContent = AFTER_INSTALL_HINT;
}

must("link-store-pending").textContent = STORE_PENDING_HINT;

must("nav-install-extension").addEventListener("click", () => goToExtensionInstall());
must("btn-empty-install").addEventListener("click", () => goToExtensionInstall());

must("link-install").addEventListener("click", async () => {
  if (!invoke) return;
  const msg = must("link-next");
  try {
    await invoke("open_extension_store_cmd");
  } catch (err: unknown) {
    const detail = err as { message?: string } | null;
    msg.textContent = `打不开商店页：${detail?.message ?? "未知错误"}。${STORE_PENDING_HINT}`;
  }
});

must("link-download").addEventListener("click", async () => {
  if (!invoke) return;
  const msg = must("link-next");
  try {
    await invoke("open_plugin_release_cmd");
  } catch (err: unknown) {
    const detail = err as { message?: string } | null;
    msg.textContent = `打不开插件下载页：${detail?.message ?? "未知错误"}。${STORE_PENDING_HINT}`;
  }
});

must("link-retry").addEventListener("click", async () => {
  if (!invoke) return;
  const button = must("link-retry") as HTMLButtonElement;
  button.disabled = true;
  try {
    await invoke("register_native_messaging_cmd");
    await refreshStatus();
  } finally {
    button.disabled = false;
  }
});

let pairingSaving = false;
must("pairing-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (pairingSaving) return;
  pairingSaving = true;
  const fields = must("pairing-form").querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button");
  fields.forEach((field) => { field.disabled = true; });
  const msg = must("pairing-msg");
  if (!invoke) {
    msg.textContent = "未连接到桌面宿主，草稿没有保存。";
    pairingSaving = false;
    fields.forEach((field) => { field.disabled = false; });
    return;
  }
  const typed = {
    chrome: chromeInput.value,
    edge: edgeInput.value,
  };
  try {
    const saved = await invoke<{ chromeExtensionId?: string | null; edgeExtensionId?: string | null }>("save_pairing_draft", {
      chromeExtensionId: typed.chrome,
      edgeExtensionId: typed.edge,
    });
    const applied = pairing.onSaveSuccess(saved);
    chromeInput.value = applied.chrome;
    edgeInput.value = applied.edge;
    // 手填的 ID 要进 host 清单才有意义，所以保存完顺手重写一次。
    let registrationOk = false;
    try {
      const outcomes = await invoke<NativeMessagingRegistrationOutcome[]>(
        "register_native_messaging_cmd",
      );
      registrationOk = registrationCompleted(outcomes);
    } catch {
      // 重写失败不影响草稿本身，状态刷新之后界面会说清楚。
    }
    msg.textContent = registrationOk
      ? "已保存，并把这几个 ID 一起写进了 host 清单。"
      : "ID 已保存，但 host 清单没有全部更新成功。请按上面的“重新检查注册”。";
    await refreshStatus();
  } catch (err: unknown) {
    pairing.onSaveFailure();
    chromeInput.value = typed.chrome;
    edgeInput.value = typed.edge;
    msg.textContent = String(err);
  } finally { pairingSaving = false; fields.forEach((field) => { field.disabled = false; }); }
});

must("btn-hide").addEventListener("click", () => invoke?.("hide_main_window_cmd"));
must("btn-quit").addEventListener("click", () => {
  // §5.4：退出前必须告知提醒会停。关窗不会，退出会——这两件事用户分不清，
  // 所以在这里说，而不是指望他记得设置页写过。
  if (window.confirm(QUIT_WARNING)) {
    invoke?.("quit_app");
  }
});

/** 设置页的「提醒」一段：现在能不能响、为什么、五种状态各是什么结果。 */
async function renderReminderSettings() {
  const line = must("settings-reminder");
  const window_ = must("settings-reminder-window");
  const table = must("settings-lifecycle");

  let capability: ReminderCapability = { available: false, reason: "未连接到桌面宿主。" };
  if (invoke) {
    try {
      capability = await invoke<ReminderCapability>("reminder_capability_cmd", {});
    } catch {
      capability = { available: false, reason: "读不到系统通知的状态。" };
    }
  }

  const message = describeCapability(capability);
  line.textContent = message.text;
  line.className = `note ${message.tone}`;
  window_.textContent = DELIVERY_WINDOW_NOTE;
  table.innerHTML = LIFECYCLE_STATES.map(
    (state) => `<tr><th>${state.when}</th><td>${state.what}</td></tr>`,
  ).join("");
}
must("btn-diag").addEventListener("click", async () => {
  const msg = must("diag-msg");
  if (!invoke) {
    msg.textContent = "未连接到桌面宿主，没有导出。";
    return;
  }
  try {
    const result = await invoke<{ exportPath: string }>("export_diagnostics");
    msg.textContent = `已导出到 ${result.exportPath}`;
  } catch (err: unknown) {
    msg.textContent = String(err);
  }
});

// 在普通浏览器里打开（`npm run dev` / `preview`）时没有宿主。界面照常挂载，只是每个命令
// 都会用同一句话失败——比整页停在半初始化状态强，也让上面那些「未连接」提示真的看得到。
const notConnected: Invoke = async () => {
  throw { code: "NO_HOST", message: "未连接到桌面宿主（请用 Tauri 启动，不要只打开浏览器）" };
};
const command: Invoke = invoke ?? notConnected;

// 文件选择与拖放是宿主能力：这里注入真实实现，测试里注入假的。拖放事件带来的是用户
// 自己刚拖进来的路径，只在这一次导入里用；档案里的存储路径永远不下发到界面。
const dialog = window.__TAURI__?.dialog;
const events = window.__TAURI__?.event;
const applications = mountApplications(command, {
  listen: events?.listen
    ? (name, handler) => events.listen?.(name, (event) => handler({ payload: event?.payload }))
    : undefined,
});

// 简历模板只收 .xlsx / .csv；导出默认用模板名。没有 Tauri 时为 null，界面会如实说明。
const resumePickers =
  dialog?.open && dialog?.save
    ? {
        open: async () => {
          const chosen = await dialog.open?.({
            multiple: false,
            filters: [{ name: "Excel / CSV", extensions: ["xlsx", "csv"] }],
          });
          return typeof chosen === "string" ? chosen : null;
        },
        save: async (suggested: string) =>
          (await dialog.save?.({ defaultPath: suggested, filters: [{ name: "Excel", extensions: ["xlsx"] }] })) ?? null,
      }
    : null;
const resumeView = mountResume(
  must("resume-root"),
  invoke ?? null,
  resumePickers,
  events?.listen ? (name, handler) => events.listen?.(name, () => handler()) : undefined,
);

void events?.listen?.("resume-pro://navigate", (event) => {
  const target = targetForOpenView(event.payload);
  if (!target) return;
  const enteringResume = target.route === "resume" && views.resume.classList.contains("hidden");
  showRoute(target.route);
  if (target.settingsTab) settingsNavigation.select(target.settingsTab);
  if (enteringResume) resumeView.refresh();
});

const inbox = mountInbox(command, {
  mountAi: (container, evidenceId, onConfirmed) =>
    mountAiReview(container, invoke ?? null, evidenceId, onConfirmed),
  pickFiles: dialog?.open
    ? async () => {
        const chosen = await dialog.open?.({
          multiple: true,
          filters: [{ name: "回复证据", extensions: ["eml", "txt", "png", "jpg", "jpeg", "pdf"] }],
        });
        if (!chosen) return [];
        return Array.isArray(chosen) ? chosen : [chosen];
      }
    : null,
  listenDrop: events?.listen
    ? (handle: (paths: string[]) => void) => {
        void events.listen?.("tauri://drag-drop", (event) => {
          const payload = event?.payload;
          handle(typeof payload === "object" && payload !== null ? payload.paths ?? [] : []);
        });
      }
    : null,
});

const showTodos = mountTodos(command);

// 备份与恢复要用原生文件对话框。浏览器里跑（没有 Tauri）时两个都是 null，
// 界面会如实说「请在桌面程序里导出」，而不是给一个点了没反应的按钮。
const backupPickers = {
  save: dialog?.save
    ? async (suggested: string) => (await dialog.save?.({ defaultPath: suggested })) ?? null
    : null,
  open: dialog?.open
    ? async () => {
        const chosen = await dialog.open?.({
          multiple: false,
          filters: [{ name: "Resume Pro 备份", extensions: ["zip"] }],
        });
        if (!chosen) return null;
        return Array.isArray(chosen) ? (chosen[0] ?? null) : chosen;
      }
    : null,
};
// 恢复 / 换回会把档案整个换掉，「简历」页手里的模板列表和「我的信息」版本号都过时了。
const showBackup = mountBackup(command, backupPickers, undefined, () => resumeView.refresh());
void renderReminderSettings().catch(() => {});

showRoute("applications");
refreshStatus().catch((err: unknown) => {
  must("runtime-pill").textContent = String(err);
});
applications.refreshList().catch((err: unknown) => {
  must("apps-msg").textContent = String(err);
});
inbox.refresh().catch(() => {});
setInterval(() => {
  refreshStatus().catch(() => {});
}, 4000);

// --- 版本与更新 ---------------------------------------------------------------------------

let pendingUpdate: UpdateInfo | null = null;

function showUpdate(message: { tone: string; text: string; available: boolean }) {
  const line = must("update-msg");
  line.textContent = message.text;
  line.className = `note ${message.tone}`;
  (must("update-open") as HTMLButtonElement).hidden = !message.available;
}

async function checkUpdate(currentVersion: string) {
  if (!invoke) return;
  const button = must("update-check") as HTMLButtonElement;
  button.disabled = true;
  showUpdate({ tone: "ok", text: "正在查…", available: false });
  try {
    pendingUpdate = (await invoke<UpdateInfo | null>("check_update_cmd")) ?? null;
    showUpdate(describeUpdate(currentVersion, pendingUpdate));
  } catch (error) {
    pendingUpdate = null;
    showUpdate(describeCheckFailure(error));
  } finally {
    button.disabled = currentAppVersion.length === 0;
  }
}

must("update-check").addEventListener("click", () => {
  if (!currentAppVersion) {
    showUpdate({ tone: "warn", text: "正在读取应用版本，请稍后再查。", available: false });
    return;
  }
  void checkUpdate(currentAppVersion);
});

must("update-open").addEventListener("click", async () => {
  if (!invoke || !pendingUpdate) return;
  try {
    await invoke("open_update_page_cmd");
  } catch {
    showUpdate({ tone: "warn", text: `打不开下载页，手动去：${pendingUpdate.url}`, available: true });
  }
});

must("update-auto").addEventListener("change", async (event) => {
  if (!invoke) return;
  const enabled = (event.target as HTMLInputElement).checked;
  try {
    await invoke<UpdatePreference>("set_update_preference_cmd", { enabled });
  } catch {
    // 存不上就把勾选还原，免得界面说的和实际不一样。
    (must("update-auto") as HTMLInputElement).checked = !enabled;
  }
});

let currentAppVersion = "";
/** 状态每隔几秒刷一次；自动检查每次启动只做一次。 */
let autoCheckDone = false;

/** 启动时按偏好查一次。查不到就安静退回，不打扰。 */
async function maybeAutoCheck(status: { appVersion: string }) {
  currentAppVersion = status.appVersion;
  (must("update-check") as HTMLButtonElement).disabled = currentAppVersion.length === 0;
  if (!invoke || autoCheckDone) return;
  autoCheckDone = true;
  let pref: UpdatePreference;
  try {
    pref = await invoke<UpdatePreference>("get_update_preference_cmd");
  } catch {
    return;
  }
  (must("update-auto") as HTMLInputElement).checked = pref.enabled;
  if (!shouldCheck(pref, new Date().toISOString())) return;
  await checkUpdate(status.appVersion);
}
