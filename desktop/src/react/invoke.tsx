import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import type { Invoke } from "../api.ts";

/**
 * 组件一律经这里调命令，不直接摸 `window.__TAURI__`。
 * 测试里换成假的 invoke；浏览器里直接打开 index.html 时是 null，
 * 组件要如实显示「没连上桌面宿主」而不是崩掉。
 */
const InvokeContext = createContext<Invoke | null>(null);

export function InvokeProvider({
  invoke,
  children,
}: {
  invoke: Invoke | null;
  children: ReactNode;
}) {
  return <InvokeContext.Provider value={invoke}>{children}</InvokeContext.Provider>;
}

export function useInvoke(): Invoke | null {
  return useContext(InvokeContext);
}
