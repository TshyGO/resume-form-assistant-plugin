#!/usr/bin/env python3
"""Real-browser smoke test for the web_accessible_resources contract.

Run from anywhere:

    python desktop/scripts/war_browser_check.py

This is a manual, headed check. It needs a Windows/macOS desktop session with a
display and Playwright's Chromium; it is deliberately not wired into CI.

It loads this extension unpacked in Playwright Chromium or Microsoft Edge and checks three
things that unit tests cannot check:

1. the extension pages themselves still load their own subresources
   (popup.css, popup.js, xlsx, PDF.js) without listing them as WAR;
2. an ordinary web page can load only the reviewed WAR files and cannot load
   popup.html or extension-page subresources;
3. the manager command opens popup.html as a new extension tab.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
EXPECTED_ID = "diagjmploldedipjdenmecmjokckelkl"

WEB_PAGE = """<!doctype html>
<html lang="zh-CN"><body>
  <form>
    <label>姓名 <input name="name"></label>
    <label>手机号 <input name="phone"></label>
    <label>应聘岗位 <input name="position"></label>
  </form>
</body></html>"""


def failure(message: str) -> None:
    print(f"FAIL: {message}")
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=("chromium", "edge"), default="chromium")
    args = parser.parse_args()
    if not (ROOT / "manifest.json").is_file():
        failure(f"not a checkout: {ROOT}")

    with tempfile.TemporaryDirectory(prefix="resume-pro-war-") as profile:
        with sync_playwright() as playwright:
            # Branded/Chromium builds only sideload extensions in headed mode.
            context = playwright.chromium.launch_persistent_context(
                profile,
                headless=False,
                channel="msedge" if args.browser == "edge" else None,
                args=[
                    f"--disable-extensions-except={ROOT}",
                    f"--load-extension={ROOT}",
                ],
            )
            try:
                # The manifest key fixes the id, so a successful navigation to
                # this URL also proves the unpacked build kept the store id.
                extension_id = EXPECTED_ID

                # 1. Extension page: own subresources must still load.
                extension_page = context.new_page()
                try:
                    extension_page.goto(
                        f"chrome-extension://{extension_id}/popup.html",
                        wait_until="load",
                        timeout=20_000,
                    )
                except Exception as exc:  # noqa: BLE001 - report a clean FAIL, not a stack
                    failure(f"extension page did not load at the fixed id: {exc}")
                extension_page.wait_for_selector(".popup-shell", timeout=10_000)
                inside = extension_page.evaluate(
                    """async () => {
                        const check = async (path) => {
                          try {
                            const response = await fetch(chrome.runtime.getURL(path));
                            return response.status;
                          } catch (error) {
                            return `blocked:${error.name}`;
                          }
                        };
                        return {
                          shell: Boolean(document.querySelector('.popup-shell')),
                          popupCss: await check('popup.css'),
                          popupJs: await check('popup.js'),
                          xlsx: await check('xlsx.full.min.js'),
                          mammoth: await check('mammoth.browser.min.js'),
                          pdf: await check('vendor/pdfjs/pdf.min.mjs'),
                          pdfWorker: await check('vendor/pdfjs/pdf.worker.min.mjs'),
                          cMap: await check('vendor/pdfjs/cmaps/78-H.bcmap'),
                        };
                    }""",
                )
                if not inside["shell"]:
                    failure("popup.html did not render its shell")
                for key in ("popupCss", "popupJs", "xlsx", "mammoth", "pdf", "pdfWorker", "cMap"):
                    if inside[key] != 200:
                        failure(f"extension page cannot load {key}: {inside[key]}")

                # 2. Ordinary web page: only the reviewed WAR files may load.
                web_page = context.new_page()
                page_errors: list[str] = []
                web_page.on("pageerror", lambda error: page_errors.append(str(error)))
                web_page.route("https://war-smoke.test/**", lambda route: route.fulfill(body=WEB_PAGE, content_type="text/html"))
                web_page.goto("https://war-smoke.test/", wait_until="load")
                outside = web_page.evaluate(
                    """async (extensionId) => {
                        const check = async (path) => {
                          try {
                            const response = await fetch(`chrome-extension://${extensionId}/${path}`);
                            return `status:${response.status}`;
                          } catch (error) {
                            return `blocked:${error.name}`;
                          }
                        };
                        return {
                          popupHtml: await check('popup.html'),
                          contentCss: await check('content.css'),
                          linkMjs: await check('link/chrome.mjs'),
                          linkProtocolMjs: await check('link/protocol/validate.mjs'),
                          popupJs: await check('popup.js'),
                          popupCss: await check('popup.css'),
                          xlsx: await check('xlsx.full.min.js'),
                          pdf: await check('vendor/pdfjs/pdf.min.mjs'),
                        };
                    }""",
                    extension_id,
                )
                for key in ("contentCss", "linkMjs", "linkProtocolMjs"):
                    if outside[key] != "status:200":
                        failure(f"web page cannot load WAR resource {key}: {outside[key]}")
                for key in ("popupHtml", "popupJs", "popupCss", "xlsx", "pdf"):
                    if not outside[key].startswith("blocked:"):
                        failure(f"web page unexpectedly loaded non-WAR resource {key}: {outside[key]}")

                # 3. The manager is an extension tab, not a page iframe. This keeps
                # popup.html out of WAR while preserving the sidebar/toolbar flow.
                with context.expect_page(timeout=10_000) as manager_info:
                    result = extension_page.evaluate(
                        "() => chrome.runtime.sendMessage({ type: 'OPEN_MANAGER' })"
                    )
                if not result or not result.get("opened"):
                    failure(f"manager command failed: {result}")
                manager_page = manager_info.value
                manager_page.wait_for_load_state("load")
                if not manager_page.url.startswith(
                    f"chrome-extension://{extension_id}/popup.html"
                ):
                    failure(f"manager opened the wrong URL: {manager_page.url}")
                manager_page.wait_for_selector(".popup-shell", timeout=10_000)

                # 4. Content-script resources loaded without page errors.
                if page_errors:
                    failure(f"page-side scripts raised errors: {page_errors[:3]}")
                broken_images = web_page.evaluate(
                    """() => Array.from(document.images)
                        .filter((img) => img.src.startsWith('chrome-extension://') && img.naturalWidth === 0)
                        .map((img) => img.src)"""
                )
                if broken_images:
                    failure(f"content script injected broken extension images: {broken_images[:3]}")

                print(json.dumps({"browser": args.browser, "extensionId": extension_id, "inside": inside, "outside": outside, "managerTab": manager_page.url}, ensure_ascii=False, indent=2))
                print("WAR_CONTRACT:PASS")
                print("MANAGER_TAB:PASS")
            finally:
                context.close()


if __name__ == "__main__":
    main()
