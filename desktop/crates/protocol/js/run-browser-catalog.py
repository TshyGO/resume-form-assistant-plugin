"""Run D05 catalog fixtures in a real Chromium/Edge page."""

from __future__ import annotations

import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError, sync_playwright

ROOT = Path(__file__).resolve().parent.parent


class Handler(SimpleHTTPRequestHandler):
    # Do not let the OS decide. SimpleHTTPRequestHandler resolves types through
    # `mimetypes`, which on Windows reads the registry, and a runner without ".mjs"
    # registered serves modules as text/plain -- which browsers refuse to load under
    # strict MIME checking, so the page never runs and only looks slow.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".json": "application/json",
        ".html": "text/html",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):  # noqa: A003
        return


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{port}/js/browser.html"
    with sync_playwright() as p:
        last_error = None
        for launch in (
            lambda: p.chromium.launch(headless=True),
            lambda: p.chromium.launch(channel="msedge", headless=True),
        ):
            try:
                browser = launch()
                break
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                browser = None
        if browser is None:
            print(f"browser launch failed: {last_error}", file=sys.stderr)
            return 1
        page = browser.new_page()
        # Surface anything the page reports; a silent page error used to look like a
        # plain timeout, which says nothing about what actually broke.
        notes: list[str] = []
        page.on("pageerror", lambda exc: notes.append(f"pageerror: {exc}"))
        page.on("console", lambda msg: notes.append(f"console.{msg.type}: {msg.text}")
                if msg.type in ("error", "warning") else None)
        page.goto(url, wait_until="networkidle")
        try:
            # Generous: a cold CI runner serving ~90 fixture fetches is far slower than
            # a developer machine, and a real failure now reports itself rather than
            # waiting this out.
            page.wait_for_function("window.__D05_DONE__ === true", timeout=180_000)
        except PlaywrightTimeoutError:
            print("timed out waiting for the catalog page", file=sys.stderr)
            for note in notes:
                print(f"  {note}", file=sys.stderr)
            partial = page.evaluate("window.__D05_RESULT__ || null")
            print(f"  partial result: {json.dumps(partial, ensure_ascii=False)}", file=sys.stderr)
            browser.close()
            server.shutdown()
            return 1
        result = page.evaluate("window.__D05_RESULT__")
        for note in notes:
            print(f"note: {note}", file=sys.stderr)
        browser.close()
    server.shutdown()
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result or not result.get("ok"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
