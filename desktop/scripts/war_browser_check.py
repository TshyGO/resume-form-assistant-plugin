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
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Inter, "Microsoft YaHei", sans-serif; color: #182033; background: #f4f6fb; }
  header { height: 72px; display: flex; align-items: center; justify-content: space-between; padding: 0 54px; background: #17213a; color: white; }
  header strong { font-size: 20px; letter-spacing: .04em; }
  header span { color: #b8c2db; font-size: 13px; }
  main { width: 760px; margin: 34px 0 60px 70px; padding: 30px 34px 38px; border: 1px solid #e1e5ef; border-radius: 18px; background: white; box-shadow: 0 16px 45px rgba(32, 47, 84, .08); }
  h1 { margin: 0 0 8px; font-size: 25px; }
  .lead { margin: 0 0 28px; color: #687189; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 19px 22px; }
  label { display: grid; gap: 7px; color: #414b63; font-size: 13px; font-weight: 650; }
  input, select { width: 100%; height: 42px; padding: 0 12px; border: 1px solid #d7dce8; border-radius: 9px; background: #fbfcff; font: inherit; }
  .wide { grid-column: 1 / -1; }
  button { margin-top: 28px; border: 0; border-radius: 10px; padding: 12px 24px; background: #3156d3; color: white; font-weight: 700; }
</style></head><body>
  <header><strong>Northstar Careers</strong><span>软件工程师 · 在线申请</span></header>
  <main>
    <h1>候选人信息</h1>
    <p class="lead">请填写以下信息。截图中的公司、岗位和简历数据均为合成示例。</p>
    <form>
      <div class="grid">
        <label>姓名 <input name="name" placeholder="请输入姓名"></label>
        <label>手机号 <input name="phone" placeholder="请输入手机号"></label>
        <label>电子邮箱 <input name="email" placeholder="name@example.com"></label>
        <label>应聘岗位 <input name="position" value="软件工程师"></label>
        <label>最高学历 <select name="degree"><option>请选择</option><option>本科</option><option>硕士</option></select></label>
        <label>期望城市 <input name="city" placeholder="请输入城市"></label>
        <label class="wide">个人简介 <input name="summary" placeholder="请简要介绍相关经历"></label>
      </div>
      <button type="button">下一步</button>
    </form>
  </main>
</body></html>"""


def failure(message: str) -> None:
    print(f"FAIL: {message}")
    sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=("chromium", "edge"), default="chromium")
    parser.add_argument("--screenshot-dir", type=Path)
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
                viewport={"width": 1280, "height": 800},
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
                web_page.route(
                    "https://war-smoke.test/**",
                    lambda route: route.fulfill(body=WEB_PAGE, content_type="text/html; charset=utf-8"),
                )
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

                if args.screenshot_dir:
                    screenshot_dir = args.screenshot_dir.resolve()
                    screenshot_dir.mkdir(parents=True, exist_ok=True)
                    extension_page.evaluate(
                        """() => chrome.storage.local.set({
                          templates: [{
                            id: 'store-demo',
                            name: '演示简历（合成数据）',
                            groups: [{ name: '基本信息', fields: [
                              { key: '姓名', value: '林晓然' },
                              { key: '手机号', value: '13800000000' },
                              { key: '电子邮箱', value: 'demo@example.com' },
                              { key: '最高学历', value: '硕士' },
                              { key: '期望城市', value: '上海' }
                            ] }]
                          }],
                          activeTemplateId: 'store-demo',
                          aiConfig: { apiUrl: '', apiKey: '', model: '' },
                          profile: { values: {}, family: [], custom: [] }
                        })"""
                    )
                    web_page.reload(wait_until="load")
                    web_page.wait_for_selector("#resume-pro-sidebar", timeout=10_000)
                    web_page.screenshot(path=str(screenshot_dir / "store-sidebar-1280x800.png"))
                    manager_page.reload(wait_until="load")
                    manager_page.wait_for_selector(".popup-shell", timeout=10_000)
                    manager_page.screenshot(path=str(screenshot_dir / "store-manager-1280x800.png"))

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
