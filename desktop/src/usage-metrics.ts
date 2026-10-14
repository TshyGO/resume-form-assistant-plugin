import type { Invoke } from "./api.ts";

export interface UsageStatus {
  enabled: boolean;
  notice_required: boolean;
  available: boolean;
  outbound_enabled: boolean;
  deletion: "none" | "pending" | "deleted" | "unconfirmed";
  revision: number;
}
export type UsageSubscription = (changed: () => void) => Promise<() => void>;

/** Only trusted visible UI input is a signal. No content or event metadata crosses IPC.
 * Rust checks the native main window and persisted send conditions again. */
export function installUsageSignals(invoke: Invoke | null, target: Document = document) {
  const signal = (event: Event) => {
    if (!invoke || !event.isTrusted || target.visibilityState !== "visible" || !target.hasFocus()) return;
    // Disclosure/settings gestures are choices, not activity to upload after the choice.
    if (event.target instanceof Element && event.target.closest("[data-usage-settings]")) return;
    void invoke("telemetry_touch").catch(() => {});
  };
  target.addEventListener("pointerdown", signal, { capture: true });
  target.addEventListener("keydown", signal, { capture: true });
  return () => {
    target.removeEventListener("pointerdown", signal, { capture: true });
    target.removeEventListener("keydown", signal, { capture: true });
  };
}
