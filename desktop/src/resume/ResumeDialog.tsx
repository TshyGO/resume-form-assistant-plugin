import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode, SyntheticEvent } from "react";

/**
 * 简历页的弹窗（#257）。几块各管各的流程（模板、AI 解析、旧数据导入、我的信息），
 * 但界面上一次只能有一个弹窗：都想打开时按先来后到排队，前一个关掉后一个才出现，
 * 不会叠在一起抢焦点。没有外层排队器时（单独测试某个组件）直接打开。
 */
interface DialogQueue {
  queue: string[];
  claim(id: string): void;
  release(id: string): void;
}

const DialogQueueContext = createContext<DialogQueue | null>(null);

export function DialogQueueProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<string[]>([]);
  const claim = useCallback((id: string) => setQueue((current) => (current.includes(id) ? current : [...current, id])), []);
  const release = useCallback((id: string) => setQueue((current) => current.filter((item) => item !== id)), []);
  const value = useMemo(() => ({ queue, claim, release }), [queue, claim, release]);
  return <DialogQueueContext.Provider value={value}>{children}</DialogQueueContext.Provider>;
}

function useDialogTurn(id: string, open: boolean): boolean {
  const context = useContext(DialogQueueContext);
  const claim = context?.claim;
  const release = context?.release;
  useEffect(() => {
    if (!open || !claim || !release) return undefined;
    claim(id);
    return () => release(id);
  }, [claim, release, id, open]);
  if (!context) return open;
  return open && context.queue[0] === id;
}

export interface ResumeDialogProps {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  footer: ReactNode;
  /** Escape 与「取消」类按钮走这里；正在执行命令时传 cancelDisabled，不让半途关掉。 */
  onCancel(): void;
  cancelDisabled?: boolean;
  tone?: "default" | "warn" | "danger";
  /** 旧数据预览、逐项冲突这类内容多的用宽版。 */
  wide?: boolean;
  /** 同一个弹窗里换了一屏内容（比如从冲突列表进到二次确认）时换个值，焦点重新落到 data-autofocus 上。 */
  focusKey?: string;
}

export function ResumeDialog(props: ResumeDialogProps) {
  const id = useId();
  const shown = useDialogTurn(id, props.open);
  return shown ? <DialogPanel {...props} /> : null;
}

const FOCUSABLE = "[data-autofocus], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])";

function focusInitial(dialog: HTMLDialogElement) {
  const preferred = dialog.querySelector<HTMLElement>("[data-autofocus]:not([disabled])");
  const target = preferred ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
  target?.focus();
}

function DialogPanel({ title, children, footer, onCancel, cancelDisabled = false, tone = "default", wide = false, focusKey }: ResumeDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const cancelRef = useRef({ onCancel, cancelDisabled });
  cancelRef.current = { onCancel, cancelDisabled };

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
    focusInitial(dialog);
    return () => {
      if (typeof dialog.close === "function" && dialog.open) dialog.close();
      // 关掉后把焦点还给打开它的那个按钮；按钮已经不在了（比如模板被删）就不强求。
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (focusKey !== undefined && ref.current) focusInitial(ref.current);
  }, [focusKey]);

  const requestCancel = () => {
    if (!cancelRef.current.cancelDisabled) cancelRef.current.onCancel();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    requestCancel();
  };
  const onNativeCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    // 浏览器自己的关闭请求也不能直接关：状态由 React 决定，关不关交给 onCancel。
    event.preventDefault();
    requestCancel();
  };

  return (
    <dialog
      ref={ref}
      className={`resume-dialog${wide ? " is-wide" : ""}${tone !== "default" ? ` tone-${tone}` : ""}`}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onCancel={onNativeCancel}
    >
      <div className="resume-dialog-head">
        <h2 id={titleId}>{title}</h2>
      </div>
      {children ? <div className="resume-dialog-body">{children}</div> : null}
      <div className="resume-dialog-actions">{footer}</div>
    </dialog>
  );
}
