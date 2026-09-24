export type OpenViewTarget = { route: "resume" | "settings" | "applications"; settingsTab?: "ai" };

/** Map the protocol's view names onto the existing desktop navigation. */
export function targetForOpenView(view: unknown): OpenViewTarget | null {
  if (view === "resume") return { route: "resume" };
  if (view === "settings-ai") return { route: "settings", settingsTab: "ai" };
  if (view === "home") return { route: "applications" };
  return null;
}
