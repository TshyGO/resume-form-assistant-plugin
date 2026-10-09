import { useEffect, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEvent, ReactNode, SyntheticEvent } from "react";

/**
 * 设置页的应用内弹窗（#265）。与 `settings-dialog.ts` 共用 `.settings-dialog` 样式：
 * 标题与说明在上、正文滚动、按钮栏在下；打开时焦点进入，关闭后回到打开它的按钮。
 * Esc 与「取消」都走 onCancel；正在执行命令时传 cancelDisabled，不让半途关掉。
 */
export interface SettingsDialogProps {
  open: boolean;
  title: ReactNode;
  intro?: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  onCancel(): void;
  cancelDisabled?: boolean;
  tone?: "default" | "danger";
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function SettingsDialog(props: SettingsDialogProps) {
  // 挂到 body 上：设置页某个分类被切走（比如插件要求打开别的页面）时，
  // 弹窗不会因为祖先被隐藏而看不见、却仍然挡住整个窗口。
  return props.open ? createPortal(<DialogPanel {...props} />, document.body) : null;
}

const FOCUSABLE = "[data-autofocus]:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])";

function DialogPanel({ title, intro, children, footer, onCancel, cancelDisabled = false, tone = "default", size = "sm", className }: SettingsDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const introId = useId();
  const latest = useRef({ onCancel, cancelDisabled });
  latest.current = { onCancel, cancelDisabled };

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    } else {
      dialog.setAttribute("open", "");
    }
    const preferred = dialog.querySelector<HTMLElement>("[data-autofocus]:not([disabled])");
    (preferred ?? dialog.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // 执行中禁用了焦点所在的按钮时，焦点会掉到 body；结束后把它放回弹窗里。
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || cancelDisabled) return;
    if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [cancelDisabled]);

  const requestCancel = () => {
    if (!latest.current.cancelDisabled) latest.current.onCancel();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    requestCancel();
  };
  const onNativeCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    requestCancel();
  };

  return (
    <dialog
      ref={ref}
      className={`settings-dialog size-${size}${tone === "danger" ? " tone-danger" : ""}${className ? ` ${className}` : ""}`}
      aria-labelledby={titleId}
      aria-describedby={intro ? introId : undefined}
      aria-busy={cancelDisabled || undefined}
      onKeyDown={onKeyDown}
      onCancel={onNativeCancel}
    >
      <div className="settings-dialog-head">
        <h2 id={titleId}>{title}</h2>
        {intro ? <p id={introId}>{intro}</p> : null}
      </div>
      {children ? <div className="settings-dialog-body">{children}</div> : null}
      <div className="settings-dialog-actions">{footer}</div>
    </dialog>
  );
}
