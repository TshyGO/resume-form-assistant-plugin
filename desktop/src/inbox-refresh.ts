/** Re-read local notifications after commits and when the desktop returns to the foreground. */
export function followInboxChanges(
  refresh: () => Promise<unknown>,
  listen?: (event: string, handler: () => void) => Promise<() => void>,
  host: { window: EventTarget; document: EventTarget & { visibilityState: string } } = { window, document },
): () => void {
  let disposed = false, dirty = false, running = false;
  const stops: Array<() => void> = [];
  const request = () => {
    if (disposed) return;
    dirty = true;
    if (running) return;
    running = true;
    void Promise.resolve().then(async () => {
      try {
        while (dirty && !disposed) {
          dirty = false;
          // The view reports read errors and retains its current content.
          try { await refresh(); } catch { /* A later focus or event can retry. */ }
        }
      } finally { running = false; }
    });
  };
  const visible = () => { if (host.document.visibilityState === "visible") request(); };
  host.window.addEventListener("focus", request);
  host.document.addEventListener("visibilitychange", visible);
  if (listen) {
    void Promise.all(["evidence-changed", "tauri://focus"].map(async event => {
      try {
        const stop = await listen(event, request);
        if (disposed) stop(); else stops.push(stop);
      } catch { /* Foreground refresh also works if native subscription fails. */ }
    })).then(request); // Close the gap between startup reads and listener registration.
  }
  request();
  return () => {
    disposed = true; dirty = false;
    host.window.removeEventListener("focus", request);
    host.document.removeEventListener("visibilitychange", visible);
    for (const stop of stops) stop();
  };
}
