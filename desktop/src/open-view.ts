export type OpenViewTarget = { route: "resume" | "settings" | "applications"; settingsTab?: "ai" };

/** Map the protocol's view names onto the existing desktop navigation. */
export function targetForOpenView(view: unknown): OpenViewTarget | null {
  if (view === "resume") return { route: "resume" };
  if (view === "settings-ai") return { route: "settings", settingsTab: "ai" };
  if (view === "home") return { route: "applications" };
  return null;
}

export const NAVIGATE_EVENT = "resume-pro://navigate";

export interface FollowRequestedViews {
  listen: (event: string, handler: () => void) => Promise<unknown>;
  /** The view waiting to be shown, which taking clears. */
  take: () => Promise<unknown>;
  show: (target: OpenViewTarget) => void;
}

/**
 * Show the views the browser asks the window for.
 *
 * The desktop keeps the latest request until the page takes it, and announces each one with
 * an event. An event reaches only a page that is already listening, and on a cold start the
 * request comes before the page has loaded, so the page also takes whatever is waiting once
 * it listens. Taking clears the request, so each one is shown once.
 */
export async function followRequestedViews({ listen, take, show }: FollowRequestedViews): Promise<void> {
  const showWaiting = async () => {
    const target = targetForOpenView(await take().catch(() => null));
    if (target) show(target);
  };
  await listen(NAVIGATE_EVENT, () => void showWaiting());
  await showWaiting();
}
