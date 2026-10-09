import type { Invoke, RuntimeStatus } from "../api.ts";
import { mountReact } from "./mount.tsx";
import { RuntimeStatusFacts } from "./RuntimeStatus.tsx";

/**
 * 旧视图（main.ts）拿到状态后调 `update`，读失败时调 `fail`。容器从此归 React 管：
 * 旧视图不再往里写 innerHTML。
 */
export function mountRuntimeStatus(container: Element, invoke: Invoke | null) {
  let last: RuntimeStatus | null = null;
  const mounted = mountReact(container, invoke, <RuntimeStatusFacts status={null} />);
  return {
    update(status: RuntimeStatus) {
      last = status;
      mounted.update(<RuntimeStatusFacts status={status} />);
    },
    fail(error: string) {
      mounted.update(<RuntimeStatusFacts status={last} error={error} />);
    },
  };
}
