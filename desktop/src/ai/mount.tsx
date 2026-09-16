import type { Invoke } from "../api.ts";
import { mountReact } from "../react/mount.tsx";
import { AiReview } from "./AiReview.tsx";
import { AiSettings } from "./AiSettings.tsx";

/** 设置页的 AI 一段。容器归 React 管，旧视图不往里写 innerHTML。 */
export function mountAiSettings(container: Element, invoke: Invoke | null) {
  return mountReact(container, invoke, <AiSettings />);
}

/**
 * 收件箱里一条证据的「AI 整理」。容器归 React 管：旧视图只给挂载点和证据 id，
 * 拿不到面板里的状态，也不往里写 innerHTML。
 */
export function mountAiReview(
  container: Element,
  invoke: Invoke | null,
  evidenceId: string,
  onConfirmed?: () => void,
) {
  return mountReact(container, invoke, <AiReview evidenceId={evidenceId} onConfirmed={onConfirmed} />);
}
