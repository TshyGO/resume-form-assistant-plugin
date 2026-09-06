const invoke = window.__TAURI__?.core?.invoke;

const views = {
  applications: document.getElementById("view-applications"),
  inbox: document.getElementById("view-inbox"),
  todos: document.getElementById("view-todos"),
  settings: document.getElementById("view-settings"),
};

function showRoute(name) {
  Object.entries(views).forEach(([key, el]) => {
    el.classList.toggle("hidden", key !== name);
  });
  document.querySelectorAll(".nav button[data-route]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === name);
  });
}

document.querySelectorAll(".nav button[data-route]").forEach((btn) => {
  btn.addEventListener("click", () => showRoute(btn.dataset.route));
});

function fact(label, value) {
  return `<dt>${label}</dt><dd><code>${escapeHtml(value ?? "—")}</code></dd>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function yn(flag) {
  return flag ? "是" : "否";
}

async function refresh() {
  if (!invoke) {
    document.getElementById("runtime-pill").textContent = "未连接到桌面宿主（请用 Tauri 启动，不要只打开浏览器）";
    return;
  }
  const status = await invoke("get_runtime_status");
  document.getElementById("runtime-pill").textContent = status.runtimeLabel;
  const banner = document.getElementById("banner");
  if (status.error) {
    banner.classList.remove("hidden");
    banner.textContent = `${status.error.code}: ${status.error.message}。${status.error.hint}`;
  } else {
    banner.classList.add("hidden");
  }
  document.getElementById("facts").innerHTML = [
    fact("应用版本", status.appVersion),
    fact("标识符", status.identifier),
    fact("运行状态", status.runtimeLabel),
    fact("程序目录", status.programDir),
    fact("用户数据目录", status.dataRoot),
    fact("档案目录", status.archiveDir),
    fact("日志目录", status.logsDir),
    fact("日志文件", status.logFile),
    fact("缓存目录", status.cacheDir),
    fact("current.json", status.currentPointer),
    fact("目录可写", yn(status.writable)),
    fact("唯一写入者", yn(status.uniqueWriter)),
    fact("窗口可见", yn(status.windowVisible)),
    fact("本次隐藏启动", yn(status.hiddenLaunch)),
    fact("开机启动", `${yn(status.autostartEnabled)}（D02 不会注册）`),
    fact("Native Messaging", `${yn(status.nativeMessagingRegistered)}（未注册，属 D06/D13）`),
    fact("提醒已实现", `${yn(status.remindersImplemented)}（属 D10）`),
    fact("关闭窗口", status.closeWindowMeans),
    fact("退出", status.quitMeans),
  ].join("");
  document.getElementById("chrome-id").value = status.pairing?.chromeExtensionId ?? "";
  document.getElementById("edge-id").value = status.pairing?.edgeExtensionId ?? "";
}

document.getElementById("pairing-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const msg = document.getElementById("pairing-msg");
  try {
    await invoke("save_pairing_draft", {
      chromeExtensionId: document.getElementById("chrome-id").value,
      edgeExtensionId: document.getElementById("edge-id").value,
    });
    msg.textContent = "已写入本地 settings.json 草稿，未注册 Native Messaging。";
    await refresh();
  } catch (err) {
    msg.textContent = String(err);
  }
});

document.getElementById("btn-hide").addEventListener("click", () => invoke("hide_main_window_cmd"));
document.getElementById("btn-quit").addEventListener("click", () => {
  if (window.confirm("退出后唯一写入者进程会结束。提醒尚未实现，退出不会保留系统通知。确定退出？")) {
    invoke("quit_app");
  }
});
document.getElementById("btn-diag").addEventListener("click", async () => {
  const msg = document.getElementById("diag-msg");
  try {
    const result = await invoke("export_diagnostics");
    msg.textContent = `已导出到 ${result.exportPath}`;
  } catch (err) {
    msg.textContent = String(err);
  }
});

showRoute("applications");
refresh().catch((err) => {
  document.getElementById("runtime-pill").textContent = String(err);
});
setInterval(() => {
  refresh().catch(() => {});
}, 4000);
