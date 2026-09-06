"""Run D05 catalog fixtures in a real Chromium/Edge page."""

from __future__ import annotations

import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


class Handler(SimpleHTTPRequestHandler):
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
        page.goto(url, wait_until="networkidle")
        page.wait_for_function("window.__D05_DONE__ === true", timeout=30000)
        result = page.evaluate("window.__D05_RESULT__")
        browser.close()
    server.shutdown()
    print(json.dumps(result, indent=2, ensure_ascii=False))
    if not result or not result.get("ok"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
