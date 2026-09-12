import type { Invoke, RuntimeStatus } from "./api.ts";
import { input, must } from "./dom.ts";
import { createPairingController } from "./pairing-form.ts";
import { mountApplications } from "./applications-ui.ts";
import { mountInbox } from "./inbox-ui.ts";

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
  btn.addEventListener("click", () => showRoute(btn.dataset.route));
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
  if (window.confirm("退出后唯一写入者进程会结束。提醒尚未实现，退出不会保留系统通知。确定退出？")) {
    invoke?.("quit_app");
  }
});
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

if (!invoke) throw new Error("桌面宿主没有注入 __TAURI__.core.invoke");

const applications = mountApplications(invoke);

// 文件选择与拖放是宿主能力：这里注入真实实现，测试里注入假的。拖放事件带来的是用户
// 自己刚拖进来的路径，只在这一次导入里用；档案里的存储路径永远不下发到界面。
const dialog = window.__TAURI__?.dialog;
const events = window.__TAURI__?.event;
const inbox = mountInbox(invoke, {
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
