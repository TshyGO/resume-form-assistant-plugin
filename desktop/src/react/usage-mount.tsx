import type { Invoke } from "../api.ts";
import type { UsageSubscription } from "../usage-metrics.ts";
import { mountReact } from "./mount.tsx";
import { UsageSettings } from "./UsageSettings.tsx";

export function mountUsageSettings(container: Element, noticeContainer: Element, invoke: Invoke | null, subscribe?: UsageSubscription) {
  return mountReact(container, invoke, <UsageSettings invoke={invoke} noticeContainer={noticeContainer} subscribe={subscribe} />);
}
