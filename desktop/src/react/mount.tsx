import { StrictMode } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import type { Invoke } from "../api.ts";
import { InvokeProvider } from "./invoke.tsx";

export interface Mounted {
  /** 用新的内容重画。旧视图拿到新数据时调它，不要自己去改 React 画出来的 DOM。 */
  update(node: ReactNode): void;
  unmount(): void;
}

/**
 * 把一个组件挂到旧页面的某个节点上。
 *
 * 边界：这个节点从此归 React 管，旧视图只负责提供容器和数据；
 * 反过来 React 也不去改容器外面的东西。
 */
export function mountReact(container: Element, invoke: Invoke | null, node: ReactNode): Mounted {
  const root: Root = createRoot(container);
  const render = (next: ReactNode) => {
    root.render(
      <StrictMode>
        <InvokeProvider invoke={invoke}>{next}</InvokeProvider>
      </StrictMode>,
    );
  };
  render(node);
  return {
    update: render,
    unmount: () => root.unmount(),
  };
}
