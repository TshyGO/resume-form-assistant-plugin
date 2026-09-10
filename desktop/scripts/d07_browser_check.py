"""Drive the real Resume Pro extension against a real desktop, in a real browser.

This is the D07 acceptance that unit tests cannot give: the actual plugin, loaded unpacked,
talking to the actual host over Native Messaging, with the archive on disk afterwards
holding exactly one application.

It loads the shipped extension rather than a probe, and it drives it through the same
messages the sidebar sends, so what is exercised is the plugin's own envelope building,
transport, queues and idempotency — not a second implementation written for the test.

Run it by hand, not in CI. It needs a headed browser, it writes a real Native Messaging
registration, and it starts the desktop process.

    python scripts/d07_browser_check.py [--binary <path>] [--keep]

Everything it creates is isolated: a temporary RESUMEPRO_DATA_DIR the browser passes down
to the host, a temporary browser profile, a temporary copy of the extension, and a
registration removed again through the same receipt-based unregister the dev scripts use.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

DESKTOP = Path(__file__).resolve().parent.parent
PLUGIN = DESKTOP.parent
HOST_NAME = "com.resumepro.desktop"

# Everything the extension does not ship. The desktop tree in particular is large and would
# only slow the unpacked load down.
EXCLUDE = {
    ".git", ".github", ".playwright-cli", ".secrets", ".edge-icon-profile",
    "desktop", "docs", "archive", "output", "tests", "node_modules",
}

JOB = {
    "company": "合成科技有限公司",
    "title": "后端开发工程师",
    "location": "上海",
    "sourceUrl": "https://jobs.example.test/d07/apply",
    "dedupeUrl": "https://jobs.example.test/d07/apply",
}


def copy_extension(destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for entry in PLUGIN.iterdir():
        if entry.name in EXCLUDE or entry.name.startswith("."):
            continue
        target = destination / entry.name
        if entry.is_dir():
            shutil.copytree(entry, target)
        else:
            shutil.copy2(entry, target)


def default_binary() -> Path:
    name = "resume-pro-desktop.exe" if sys.platform == "win32" else "resume-pro-desktop"
    for profile in ("debug", "release"):
        candidate = DESKTOP / "src-tauri" / "target" / profile / name
        if candidate.exists():
            return candidate
    raise SystemExit(
        "no desktop binary found; run: cargo build --manifest-path src-tauri/Cargo.toml"
    )


def pair(data_root: Path, extension_id: str) -> None:
    """The same settings.json the desktop's own settings window writes."""
    (data_root / "settings.json").write_text(
        json.dumps(
            {
                "chromeExtensionId": extension_id,
                "edgeExtensionId": "",
                "nativeMessagingRegistered": False,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def stop_application(binary: Path, env: dict) -> None:
    """Ask the application to exit before the browser closes.

    The host is a child of the browser and the application a child of the host. Closing the
    browser first waits on pipes a surviving grandchild still holds.
    """
    if not binary.exists():
        return
    subprocess.run(
        [str(binary), "--quit"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=60,
    )


def node(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(DESKTOP / "scripts" / "nm-dev-register.mjs"), *args],
        cwd=DESKTOP,
        capture_output=True,
        text=True,
        check=False,
    )


def ask(page, message: dict, tries: int = 1) -> dict:
    """Send one message to the service worker from an extension page.

    This is the sidebar's own path: a content script cannot open a native port, so every
    desktop operation is a runtime message. Retrying is what the plugin itself does on a
    cold start, and D06 measured starts that exceed the host's ten second budget.
    """
    last = None
    for attempt in range(tries):
        last = page.evaluate(
            "message => new Promise(resolve => chrome.runtime.sendMessage(message, resolve))",
            message,
        )
        if last and last.get("mode") != "unavailable" and not last.get("error"):
            return last
        if attempt + 1 < tries:
            time.sleep(3)
    return last or {}


def storage(worker) -> dict:
    return worker.evaluate("() => chrome.storage.local.get(null)")


def launch(playwright, workspace: Path, extension: Path, env: dict):
    return playwright.chromium.launch_persistent_context(
        user_data_dir=str(workspace / "profile"),
        headless=False,
        env=env,
        args=[
            f"--disable-extensions-except={extension}",
            f"--load-extension={extension}",
        ],
    )


def worker_of(context):
    return context.service_workers[0] if context.service_workers else context.wait_for_event(
        "serviceworker", timeout=30_000
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=None)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    source_binary = (args.binary or default_binary()).resolve()
    if not source_binary.exists():
        raise SystemExit(f"no such binary: {source_binary}")

    workspace = Path(tempfile.mkdtemp(prefix="resumepro-d07-"))
    data_dir = workspace / "data"
    data_dir.mkdir()
    extension = workspace / "extension"
    copy_extension(extension)

    # Registered against a copy so the last phase can take the application away without
    # touching the build tree.
    binary = workspace / source_binary.name
    shutil.copy2(source_binary, binary)

    env = {**os.environ, "RESUMEPRO_DATA_DIR": str(data_dir)}
    failures: list[str] = []
    registered = False
    results: dict = {}

    try:
        with sync_playwright() as playwright:
            # Phase 1: registered, not paired. Also the only way to learn the id Chrome
            # assigns to this unpacked directory.
            context = launch(playwright, workspace, extension, env)
            try:
                extension_id = worker_of(context).url.split("/")[2]
                print(f"extension id: {extension_id}")

                outcome = node(
                    "register", "--extension-id", extension_id,
                    "--browser", "chrome", "--binary", str(binary),
                )
                print(outcome.stdout.strip() or outcome.stderr.strip())
                if outcome.returncode != 0 or "skipped" in outcome.stdout:
                    failures.append("registration did not happen; remove any existing one first")
                    return report(failures, results)
                registered = True

                page = context.new_page()
                page.goto(f"chrome-extension://{extension_id}/popup.html")
                results["unpaired_save"] = ask(page, {"type": "DESKTOP_SAVE_JOB", "fields": JOB}, tries=3)
                results["unpaired_storage"] = storage(worker_of(context))
            finally:
                stop_application(binary, env)
                context.close()

            # Pairing is only picked up by a browser that starts afterwards, which is the
            # reload the plugin's own copy tells the user about.
            pair(data_dir, extension_id)

            context = launch(playwright, workspace, extension, env)
            try:
                page = context.new_page()
                page.goto(f"chrome-extension://{extension_id}/popup.html")

                results["probe"] = ask(page, {"type": "DESKTOP_PROBE"}, tries=6)
                first = ask(page, {"type": "DESKTOP_SAVE_JOB", "fields": JOB}, tries=3)
                results["save"] = first
                intent_id = (first.get("intent") or {}).get("intentId")
                results["candidates_before"] = ask(page, {"type": "DESKTOP_CANDIDATES", "intentId": intent_id}, tries=3)
                results["bind"] = ask(page, {"type": "DESKTOP_BIND", "intentId": intent_id}, tries=3)
                application_id = results["bind"].get("applicationId")

                # The same posting again, bound to the application that now exists. Two
                # saves, one application.
                second = ask(page, {"type": "DESKTOP_SAVE_JOB", "fields": JOB}, tries=3)
                results["save_again"] = second
                second_intent = (second.get("intent") or {}).get("intentId")
                results["candidates_after"] = ask(page, {"type": "DESKTOP_CANDIDATES", "intentId": second_intent}, tries=3)
                results["bind_existing"] = ask(
                    page,
                    {"type": "DESKTOP_BIND", "intentId": second_intent, "applicationId": application_id},
                    tries=3,
                )
                results["applications"] = ask(page, {"type": "DESKTOP_CANDIDATES_FOR", "fields": JOB}, tries=3)
                results["confirm"] = ask(
                    page, {"type": "DESKTOP_CONFIRM_SUBMIT", "applicationId": application_id}, tries=3
                )
                results["storage_after"] = storage(worker_of(context))
            finally:
                stop_application(binary, env)
                context.close()

            # Phase 3: the desktop is gone. A profile that has paired before must keep the
            # fields as an intent and must not claim anything was saved.
            deadline = time.monotonic() + 20
            while binary.exists():
                try:
                    binary.unlink()
                except OSError:
                    if time.monotonic() >= deadline:
                        failures.append("could not take the application away for the offline phase")
                        break
                    time.sleep(1)

            context = launch(playwright, workspace, extension, env)
            try:
                page = context.new_page()
                page.goto(f"chrome-extension://{extension_id}/popup.html")
                results["offline_save"] = ask(
                    page, {"type": "DESKTOP_SAVE_JOB", "fields": {**JOB, "title": "测试开发工程师"}}
                )
                results["offline_storage"] = storage(worker_of(context))
            finally:
                context.close()
    finally:
        if registered:
            print(node("unregister").stdout.strip())
        stop_application(binary, env)
        if args.keep:
            print(f"left in place: {workspace}")
        else:
            deadline = time.monotonic() + 20
            while True:
                try:
                    shutil.rmtree(workspace)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        print(f"WARNING: {workspace} still held open", file=sys.stderr)
                        break
                    time.sleep(1)

    check(results, failures)
    return report(failures, results)


def check(results: dict, failures: list[str]) -> None:
    unpaired = results.get("unpaired_save") or {}
    if unpaired.get("mode") != "not_paired":
        failures.append(f"an unpaired extension was not told to pair: {unpaired}")
    if not unpaired.get("extensionId"):
        failures.append("the pairing message did not carry the id the user has to paste")
    if (results.get("unpaired_storage") or {}).get("desktopSaveIntents"):
        failures.append("an unpaired profile queued an intent nothing could ever drain")

    probe = results.get("probe") or {}
    if probe.get("mode") != "ready":
        failures.append(f"the paired extension did not reach the desktop: {probe}")
        return

    save = results.get("save") or {}
    if save.get("status") != "queued":
        failures.append(f"the first save was not queued: {save}")
        return

    bind = results.get("bind") or {}
    if bind.get("status") != "saved":
        failures.append(f"binding did not reach the archive: {bind}")
        return
    application_id = bind.get("applicationId")
    if not application_id:
        failures.append("the desktop did not name the application it wrote")

    before = results.get("candidates_before") or {}
    if before.get("exact"):
        failures.append(f"a brand new archive already had an exact candidate: {before}")

    after = results.get("candidates_after") or {}
    exact = after.get("exact") or []
    if len(exact) != 1 or exact[0].get("applicationId") != application_id:
        failures.append(f"the saved job was not offered as the exact candidate: {after}")

    if (results.get("bind_existing") or {}).get("status") != "saved":
        failures.append(f"binding to the existing application failed: {results.get('bind_existing')}")

    applications = results.get("applications") or {}
    total = len(applications.get("exact") or []) + len(applications.get("sameCompany") or [])
    if total != 1:
        failures.append(f"two saves of one posting produced {total} applications, expected 1")

    if (results.get("confirm") or {}).get("status") != "saved":
        failures.append(f"confirming the submission failed: {results.get('confirm')}")

    settled = results.get("storage_after") or {}
    if settled.get("desktopOutbox"):
        failures.append(f"the outbox did not empty: {settled.get('desktopOutbox')}")
    if settled.get("desktopSaveIntents"):
        failures.append(f"an intent survived a persisted write: {settled.get('desktopSaveIntents')}")
    if not settled.get("desktopPairing", {}).get("archiveId"):
        failures.append("a successful handshake was not remembered")

    offline = results.get("offline_save") or {}
    if offline.get("status") != "queued" or offline.get("mode") != "unavailable":
        failures.append(f"a save with the desktop gone was not queued as an intent: {offline}")
    intents = (results.get("offline_storage") or {}).get("desktopSaveIntents") or []
    if len(intents) != 1 or intents[0].get("status") != "pending_desktop":
        failures.append(f"the offline intent was not persisted as pending: {intents}")
    if any("restoreEpoch" in intent for intent in intents):
        failures.append("an intent was stamped with an epoch it never had")

    for key in ("templates", "activeTemplateId", "aiConfig"):
        if key in settled and key not in (results.get("unpaired_storage") or {}):
            failures.append(f"the desktop link wrote {key}, which belongs to the rest of the plugin")


def report(failures: list[str], results: dict) -> int:
    print(json.dumps(results, indent=2, ensure_ascii=False))
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print("OK: the real extension saved, bound, confirmed and queued offline through the host")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
