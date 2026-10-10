// 设置页的应用内确认弹窗（#265）。退出、恢复预览、换回回滚点、永久删除、删除附件都走这里，
// 样式与 React 那边的 SettingsDialog 共用 `.settings-dialog` 一套类名。
//
// 约定：取消在左、具体动作在右；动作执行中按钮全部禁用、Esc 不关；执行失败时弹窗不关，
// 原因显示在弹窗里，用户可以重试或取消；关掉之后焦点回到打开它的那个按钮。

export interface SettingsDialogOptions {
  title: string;
  /** 标题下的一句说明。 */
  intro?: string;
  /** 正文。内容多时正文区域滚动，按钮栏始终可见。 */
  body?: Node | null;
  confirmLabel: string;
  cancelLabel?: string;
  /** 永久删除、清除、退出这类动作用 danger。 */
  tone?: "primary" | "danger";
  size?: "sm" | "md" | "lg";
  /** 执行中的按钮文字。 */
  busyLabel?: string;
  /**
   * 点确认后执行。抛错时弹窗保持打开并显示原因；正常返回才关闭并 resolve(true)。
   * 不传就是单纯的确认：点确认直接关闭。
   */
  action?: () => Promise<void>;
  describeError?: (error: unknown) => string;
}

let sequence = 0;

export function describeDialogError(error: unknown): string {
  if (typeof error === "string") return error;
  const detail = error as { message?: string; code?: string } | null;
  return detail?.message || detail?.code || "未知错误";
}

export function openSettingsDialog(options: SettingsDialogOptions): Promise<boolean> {
  const id = `settings-dialog-${++sequence}`;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = document.createElement("dialog");
  dialog.className = `settings-dialog size-${options.size ?? "sm"}${options.tone === "danger" ? " tone-danger" : ""}`;
  dialog.setAttribute("aria-labelledby", `${id}-title`);

  const head = document.createElement("div");
  head.className = "settings-dialog-head";
  const title = document.createElement("h2");
  title.id = `${id}-title`;
  title.textContent = options.title;
  head.append(title);
  if (options.intro) {
    const intro = document.createElement("p");
    intro.id = `${id}-intro`;
    intro.textContent = options.intro;
    head.append(intro);
    dialog.setAttribute("aria-describedby", intro.id);
  }
  dialog.append(head);

  if (options.body) {
    const body = document.createElement("div");
    body.className = "settings-dialog-body";
    body.append(options.body);
    dialog.append(body);
  }

  const error = document.createElement("p");
  error.className = "settings-dialog-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  dialog.append(error);

  const actions = document.createElement("div");
  actions.className = "settings-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = options.cancelLabel ?? "取消";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = options.tone === "danger" ? "settings-danger-solid" : "primary";
  confirm.textContent = options.confirmLabel;
  actions.append(cancel, confirm);
  dialog.append(actions);

  document.body.append(dialog);

  return new Promise<boolean>((resolve) => {
    let busy = false;
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      dialog.remove();
      if (previous?.isConnected) previous.focus();
      resolve(result);
    };

    const setBusy = (next: boolean) => {
      busy = next;
      cancel.disabled = next;
      confirm.disabled = next;
      confirm.textContent = next && options.busyLabel ? options.busyLabel : options.confirmLabel;
      dialog.setAttribute("aria-busy", String(next));
    };

    const requestCancel = () => {
      if (!busy) finish(false);
    };

    cancel.addEventListener("click", requestCancel);
    dialog.addEventListener("cancel", (event) => {
      // 浏览器自己的关闭请求（Esc）也由这里决定：执行中不让关。
      event.preventDefault();
      requestCancel();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      requestCancel();
    });
    confirm.addEventListener("click", async () => {
      if (busy) return;
      if (!options.action) {
        finish(true);
        return;
      }
      error.hidden = true;
      setBusy(true);
      try {
        await options.action();
        finish(true);
      } catch (problem) {
        setBusy(false);
        error.textContent = (options.describeError ?? describeDialogError)(problem);
        error.hidden = false;
        confirm.focus();
      }
    });

    // WebView 都支持 showModal；jsdom 没有，退回成普通打开，测试里照样能操作。
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }
    // 危险动作默认停在「取消」上，免得回车直接执行。
    (options.tone === "danger" ? cancel : confirm).focus();
  });
}

/** 弹窗正文里常用的小块：一段文字。 */
export function paragraph(text: string, className?: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.textContent = text;
  if (className) p.className = className;
  return p;
}

/** 弹窗正文里的标签值列表。值可以很长（路径、标识），会换行而不是撑出视口。 */
export function factList(rows: Array<[string, string]>): HTMLDListElement {
  const list = document.createElement("dl");
  list.className = "settings-dialog-facts";
  for (const [label, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    list.append(dt, dd);
  }
  return list;
}

export function fragment(...nodes: Array<Node | null | undefined | false>): DocumentFragment {
  const out = document.createDocumentFragment();
  for (const node of nodes) if (node) out.append(node);
  return out;
}
