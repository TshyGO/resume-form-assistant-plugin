import type { Invoke } from "../api.ts";
import { mountReact } from "../react/mount.tsx";
import { AiSettings } from "./AiSettings.tsx";

/** 设置页的 AI 一段。容器归 React 管，旧视图不往里写 innerHTML。 */
export function mountAiSettings(container: Element, invoke: Invoke | null) {
  return mountReact(container, invoke, <AiSettings />);
}
