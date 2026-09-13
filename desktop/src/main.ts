import type { Invoke, RuntimeStatus } from "./api.ts";
import { input, must } from "./dom.ts";
import { createPairingController } from "./pairing-form.ts";
import { mountApplications } from "./applications-ui.ts";
import { mountInbox } from "./inbox-ui.ts";
import { mountTodos } from "./todos-ui.ts";
import { mountBackup } from "./backup-ui.ts";
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
const edgeInput = input("edge-id");

const views: Record<string, HTMLElement> = {
  applications: must("view-applications"),
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
  });
}

document.querySelectorAll<HTMLElement>(".nav button[data-route]").forEach((btn) => {
  btn.addEventListener("click", () => {
    showRoute(btn.dataset.route);
    // 待办的逾期汇总要在进入视图时算一次，不能在启动时就把它消费掉。
    if (btn.dataset.route === "todos") void showTodos().catch(() => {});
    if (btn.dataset.route === "settings") void showBackup().catch(() => {});
  });
});

chromeInput.addEventListener("input", () => pairing.markChromeDirty());
edgeInput.addEventListener("input", () => pairing.markEdgeDirty());

function fact(label: string, value: unknown) {
  return `<dt>${label}</dt><dd><code>${escapeHtml(value ?? "—")}</code></dd>`;
}

function escapeHtml(value: unknown) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function yn(flag: unknown) {
  return flag ? "是" : "否";
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
    return;
  }
  const token = pairing.beginRefresh();
  const status = await invoke<RuntimeStatus>("get_runtime_status");
  must("runtime-pill").textContent = status.runtimeLabel;
  const banner = must("banner");
  if (status.error) {
    banner.classList.remove("hidden");
    banner.textContent = `${status.error.code}: ${status.error.message}。${status.error.hint}`;
  } else {
    banner.classList.add("hidden");
  }
  must("facts").innerHTML = [
    fact("应用版本", status.appVersion),
    fact("标识符", status.identifier),
    fact("运行状态", status.runtimeLabel),
    fact("程序目录", status.programDir),
    fact("用户数据目录", status.dataRoot),
    fact("档案目录", status.archiveDir),
    fact("日志目录", status.logsDir),
    fact("日志文件", status.logFile),
    fact("应用缓存目录", status.cacheDir),
    fact("WebView 数据目录", status.webviewDataDir || "未由本应用托管"),
    fact("WebView 由本应用指定", yn(status.webviewDataManaged)),
    fact("WebView 说明", status.webviewDataNote),
    fact("current.json", status.currentPointer),
    fact("启动时目录可写", yn(status.writable)),
    fact("唯一写入者", yn(status.uniqueWriter)),
    fact("窗口可见", yn(status.windowVisible)),
    fact("本次隐藏启动", yn(status.hiddenLaunch)),
    fact("开机启动", `${yn(status.autostartEnabled)}（D02 不会注册）`),
    fact("Native Messaging", `${yn(status.nativeMessagingRegistered)}（未注册，属 D06/D13）`),
    fact("提醒已实现", `${yn(status.remindersImplemented)}（属 D10）`),
    fact("关闭窗口", status.closeWindowMeans),
    fact("退出", status.quitMeans),
  ].join("");
  applyPairingFields(pairing.applyStatus(token, status.pairing));
}

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
    msg.textContent = "已写入本地 settings.json 草稿，未注册 Native Messaging。";
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

const applications = mountApplications(command);

// 文件选择与拖放是宿主能力：这里注入真实实现，测试里注入假的。拖放事件带来的是用户
// 自己刚拖进来的路径，只在这一次导入里用；档案里的存储路径永远不下发到界面。
const dialog = window.__TAURI__?.dialog;
const events = window.__TAURI__?.event;
const inbox = mountInbox(command, {
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
        void events.listen?.("tauri://drag-drop", (event) => handle(event?.payload?.paths ?? []));
      }
    : null,
});

const showTodos = mountTodos(command);

// 备份与恢复要用原生文件对话框。浏览器里跑（没有 Tauri）时两个都是 null，
// 界面会如实说「请在桌面程序里导出」，而不是给一个点了没反应的按钮。
const showBackup = mountBackup(command, {
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
});
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
