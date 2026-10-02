import type { Invoke } from "./api.ts";

const ERROR_NAMES = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError", "EvalError", "AggregateError"]);
/** Neither raw messages nor exception objects cross IPC. Rust filters locations again. */
export function reportFrontendError(error: unknown, invoke: Invoke | null, fallbackStack = "") {
  if (!invoke) return;
  try {
    const candidate = error as { name?: unknown; stack?: unknown } | null;
    const name = typeof candidate?.name === "string" && ERROR_NAMES.has(candidate.name) ? candidate.name : "Error";
    const raw = typeof candidate?.stack === "string" ? candidate.stack : fallbackStack;
    const stack = raw.slice(0, 20000).split("\n").map(line => {
      const match = /(?:tauri:\/\/localhost\/|https?:\/\/tauri\.localhost\/|http:\/\/(?:localhost|127\.0\.0\.1):1420\/)(?:assets|src)\/[A-Za-z0-9_./-]+\.(?:js|tsx?|jsx):\d{1,6}:\d{1,6}(?=\)|\s|$)/.exec(line);
      return match?.[0] || "";
    }).filter(Boolean).slice(0, 20).join("\n");
    void invoke("report_frontend_error", { error: { name, stack } }).catch(() => {});
  } catch { /* feedback must never cause another exception */ }
}
export function installFrontendErrors(invoke: Invoke | null, target: Window = window) {
  const onError = (event: ErrorEvent) => reportFrontendError(event.error, invoke, `${event.filename}:${event.lineno}:${event.colno}`);
  const onRejection = (event: PromiseRejectionEvent) => reportFrontendError(event.reason, invoke);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => { target.removeEventListener("error", onError); target.removeEventListener("unhandledrejection", onRejection); };
}
