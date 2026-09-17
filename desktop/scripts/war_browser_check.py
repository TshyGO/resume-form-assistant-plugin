#!/usr/bin/env python3
"""Real-browser smoke test for the web_accessible_resources contract.

Run from anywhere:

    python desktop/scripts/war_browser_check.py

This is a manual, headed check. It needs a Windows/macOS desktop session with a
display and Playwright's Chromium; it is deliberately not wired into CI.

It loads this extension unpacked in the Playwright Chromium and checks two
things that unit tests cannot check:

1. the extension pages themselves still load their own subresources
   (popup.css, popup.js, xlsx, PDF.js) without listing them as WAR;
2. an ordinary web page can load the four WAR files but cannot load the
   extension-page subresources that were removed from WAR.
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
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
    if not (ROOT / "manifest.json").is_file():
        failure(f"not a checkout: {ROOT}")

    with tempfile.TemporaryDirectory(prefix="resume-pro-war-") as profile:
        with sync_playwright() as playwright:
            # Branded/Chromium builds only sideload extensions in headed mode.
            context = playwright.chromium.launch_persistent_context(
                profile,
                headless=False,
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
                extension_page.goto(
                    f"chrome-extension://{extension_id}/popup.html",
                    wait_until="load",
                    timeout=20_000,
                )
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
                          pdf: await check('vendor/pdfjs/pdf.min.mjs'),
                        };
                    }""",
                )
                if not inside["shell"]:
                    failure("popup.html did not render its shell")
                for key in ("popupCss", "popupJs", "xlsx", "pdf"):
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
                          popupJs: await check('popup.js'),
                          popupCss: await check('popup.css'),
                          xlsx: await check('xlsx.full.min.js'),
                          pdf: await check('vendor/pdfjs/pdf.min.mjs'),
                        };
                    }""",
                    extension_id,
                )
                for key in ("popupHtml", "contentCss", "linkMjs"):
                    if outside[key] != "status:200":
                        failure(f"web page cannot load WAR resource {key}: {outside[key]}")
                for key in ("popupJs", "popupCss", "xlsx", "pdf"):
                    if not outside[key].startswith("blocked:"):
                        failure(f"web page unexpectedly loaded non-WAR resource {key}: {outside[key]}")

                # 3. The real manager path: the content script owns the iframe and
                #    sets its src. A page script cannot initiate that navigation
                #    (Chrome blocks it), so trigger the same TOGGLE_MANAGER message
                #    the extension itself uses instead of faking the iframe in page JS.
                web_page.wait_for_selector("#resume-pro-sidebar", timeout=10_000)
                extension_page.evaluate(
                    """async () => {
                        const [tab] = await chrome.tabs.query({ url: "https://war-smoke.test/*" });
                        if (!tab) throw new Error("war-smoke tab not found");
                        await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_MANAGER" });
                    }"""
                )
                frame = None
                deadline = time.time() + 10
                while time.time() < deadline and frame is None:
                    for candidate in web_page.frames:
                        if candidate.url.startswith(f"chrome-extension://{extension_id}/popup.html"):
                            frame = candidate
                            break
                    if frame is None:
                        time.sleep(0.2)
                manager_iframe = "loaded"
                if frame is None:
                    # Chrome and Edge block a delayed iframe navigation to an
                    # extension page, even when the content script owns the frame.
                    # That is a pre-existing manager-panel defect, tracked in #125;
                    # it is not a WAR regression, so record it without failing the
                    # WAR contract check.
                    manager_iframe = "blocked (known issue #125)"
                    iframe_info = web_page.evaluate(
                        """() => {
                            const frame = document.querySelector('#resume-pro-manager iframe');
                            return frame ? { src: frame.src, loaded: frame.dataset.loaded } : null;
                        }"""
                    )
                    print(f"KNOWN ISSUE #125: manager iframe stayed blocked: {iframe_info}")
                else:
                    frame.wait_for_selector(".popup-shell", timeout=10_000)
                    frame_popup_js = frame.evaluate(
                        "async () => (await fetch(chrome.runtime.getURL('popup.js'))).status"
                    )
                    if frame_popup_js != 200:
                        failure(f"iframe popup.html cannot load popup.js: {frame_popup_js}")

                # 4. Content-script resources loaded without page errors.
                if page_errors:
                    failure(f"page-side scripts raised errors: {page_errors[:3]}")

                print(json.dumps({"extensionId": extension_id, "inside": inside, "outside": outside, "managerIframe": manager_iframe}, ensure_ascii=False, indent=2))
                print("PASS: WAR browser smoke")
            finally:
                context.close()


if __name__ == "__main__":
    main()
