"""Drive the D06 Native Messaging path from a real browser.

This is the acceptance check that code alone cannot give: a browser starts the host, the
host reaches the application, and a job reaches the archive with no desktop window ever
opened.

Run it by hand, not in CI. It needs a headed browser, it writes a real Native Messaging
registration, and it starts the desktop process.

    python scripts/nm_browser_check.py [--binary <path>] [--keep]

Everything it creates is isolated: the archive lives in a temporary RESUMEPRO_DATA_DIR
that the browser passes down to the host it starts, the browser runs on a temporary
profile, and the registration is removed again through the same receipt-based unregister
the developer scripts use.
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
PROTOCOL_JS = DESKTOP / "crates" / "protocol" / "js"
HOST_NAME = "com.resumepro.desktop"

MANIFEST = {
    "manifest_version": 3,
    "name": "Resume Pro D06 probe",
    "version": "0.0.1",
    "permissions": ["nativeMessaging"],
    "background": {"service_worker": "sw.js", "type": "module"},
}

PROBE_HTML = """<!doctype html>
<meta charset="utf-8">
<title>probe</title>
<script type="module" src="probe.js"></script>
<body><p id="state">idle</p></body>
"""

# One place builds the envelope, so the digest the desktop verifies is the digest of what
# was actually sent rather than of a second copy assembled for the test.
PROBE_JS = """
import { payloadBodySha256 } from "./validate.mjs";

const CLIENT = "11111111-1111-4111-8111-111111111111";

async function envelope(messageType, messageId, payload, identity) {
  const body = { ...payload };
  // Only the write messages carry a source epoch and a digest; the query payload forbids
  // both, and adding them would be rejected as an unexpected field.
  const isWrite = ["job.save", "fill.submit", "submit.confirm"].includes(messageType);
  if (identity && isWrite) {
    body.sourceRestoreEpoch = identity.restoreEpoch;
  }
  if (isWrite) {
    body.payloadSha256 = await payloadBodySha256(body);
  }
  const message = {
    protocolVersion: 1,
    messageId,
    clientInstanceId: CLIENT,
    messageType,
    occurredAt: new Date().toISOString().replace(/(\\.\\d{3})?Z$/, ".000Z"),
    payload: body,
  };
  if (identity) {
    message.archiveId = identity.archiveId;
    message.restoreEpoch = identity.restoreEpoch;
  }
  return message;
}

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage("__HOST_NAME__", message, (reply) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(reply);
    });
  });
}

window.runProbe = async () => {
  const steps = {};
  // Before pairing: the host must refuse this extension by origin, whatever it asks for.
  steps.unpaired = await send(
    await envelope("handshake", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa0", {
      pluginVersion: "0.0.1",
      minProtocolVersion: 1,
      maxProtocolVersion: 1,
    }),
  );
  await window.pairThisExtension();

  // A cold start is a real application launch, and the host answers `unavailable` when it
  // outlasts the connect budget. That code is retryable, and retrying is what the plugin
  // is supposed to do rather than reporting a failure to the user.
  let handshake;
  let attempts = 0;
  do {
    attempts += 1;
    handshake = await send(
      await envelope("handshake", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", {
        pluginVersion: "0.0.1",
        minProtocolVersion: 1,
        maxProtocolVersion: 1,
      }),
    );
    if (handshake?.ok) {
      break;
    }
    if (handshake?.error?.retryable !== true) {
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  } while (attempts < 10);
  steps.handshake = handshake;
  steps.handshakeAttempts = attempts;
  const identity = {
    archiveId: handshake?.payload?.archiveId,
    restoreEpoch: handshake?.payload?.restoreEpoch,
  };

  const job = {
    company: "Synthetic Ltd",
    title: "Engineer",
    sourceUrl: "https://jobs.example.test/d06",
  };
  const first = await envelope("job.save", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", job, identity);
  steps.save = await send(first);
  // The same message again: a retry after a lost answer must not make a second
  // application.
  steps.retry = await send(first);
  steps.candidates = await send(
    await envelope(
      "application.queryCandidates",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
      { company: job.company, title: job.title, sourceUrl: job.sourceUrl },
      identity,
    ),
  );
  return steps;
};
"""


def build_extension(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "manifest.json").write_text(json.dumps(MANIFEST, indent=2), encoding="utf-8")
    # An empty worker exists only so the extension id can be read before anything is
    # registered against it.
    (directory / "sw.js").write_text("// present so the extension has an id to read\n", encoding="utf-8")
    (directory / "probe.html").write_text(PROBE_HTML, encoding="utf-8")
    (directory / "probe.js").write_text(PROBE_JS.replace("__HOST_NAME__", HOST_NAME), encoding="utf-8")
    for module in ("validate.mjs", "schema-lite.mjs", "schema-data.mjs", "time.mjs"):
        shutil.copy(PROTOCOL_JS / module, directory / module)


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
    """Write the pairing draft the desktop reads when it authorises a caller.

    Written directly rather than through the settings window: the point of this check is
    that no window is needed, and the draft is the same settings.json the window writes.
    """
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
    """Ask the running application to exit.

    Done before the browser is closed. The host is a child of the browser and the
    application a child of the host, and Playwright's close waits for the browser's pipes;
    a surviving descendant holds them open, which used to make the close never return.
    """
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


def check(steps: dict, failures: list[str]) -> None:
    unpaired = steps.get("unpaired") or {}
    if unpaired.get("ok") is not False:
        failures.append(f"an unpaired extension was not refused: {unpaired}")
    elif unpaired.get("error", {}).get("code") != "identity_not_allowed":
        failures.append(f"an unpaired extension was refused for the wrong reason: {unpaired}")

    handshake = steps.get("handshake") or {}
    if handshake.get("ok") is not True:
        failures.append(f"handshake was not accepted: {handshake}")
        return
    if not handshake.get("payload", {}).get("archiveId"):
        failures.append("handshake carried no archive identity to stamp writes with")
    print(f"handshake succeeded on attempt {steps.get('handshakeAttempts')}")

    save = steps.get("save") or {}
    if save.get("ok") is not True:
        failures.append(f"job.save was not accepted: {save}")
        return
    result_id = save.get("resultId")
    if not result_id:
        failures.append("job.save did not name what it produced")

    retry = steps.get("retry") or {}
    if retry.get("resultId") != result_id:
        failures.append(
            f"a retry produced a different result: {retry.get('resultId')} != {result_id}"
        )

    candidates = steps.get("candidates") or {}
    exact = candidates.get("payload", {}).get("exact", [])
    if len(exact) != 1:
        failures.append(f"the saved job was not found again, got {exact}")
    elif exact[0].get("applicationId") != result_id:
        failures.append("the candidate query returned a different application")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=None)
    parser.add_argument(
        "--keep",
        action="store_true",
        help="leave the temporary archive in place for inspection",
    )
    args = parser.parse_args()
    binary = (args.binary or default_binary()).resolve()
    if not binary.exists():
        raise SystemExit(f"no such binary: {binary}")

    workspace = Path(tempfile.mkdtemp(prefix="resumepro-d06-"))
    data_dir = workspace / "data"
    data_dir.mkdir()
    extension = workspace / "extension"
    build_extension(extension)

    env = {**os.environ, "RESUMEPRO_DATA_DIR": str(data_dir)}
    failures: list[str] = []
    registered = False
    try:
        with sync_playwright() as p:
            context = p.chromium.launch_persistent_context(
                user_data_dir=str(workspace / "profile"),
                headless=False,
                env=env,
                args=[
                    f"--disable-extensions-except={extension}",
                    f"--load-extension={extension}",
                ],
            )
            try:
                worker = context.service_workers[0] if context.service_workers else context.wait_for_event(
                    "serviceworker", timeout=30_000
                )
                extension_id = worker.url.split("/")[2]
                print(f"extension id: {extension_id}")

                # Registered only now: the id is not known before the browser assigns it.
                result = node(
                    "register",
                    "--extension-id",
                    extension_id,
                    "--browser",
                    "chrome",
                    "--binary",
                    str(binary),
                )
                print(result.stdout.strip() or result.stderr.strip())
                if result.returncode != 0:
                    failures.append("registration failed")
                    return report(failures)
                if "skipped" in result.stdout:
                    failures.append(
                        "a registration was already present; remove it and run this again"
                    )
                    return report(failures)
                registered = True

                page = context.new_page()
                page.goto(f"chrome-extension://{extension_id}/probe.html")
                page.expose_function(
                    "pairThisExtension", lambda: pair(data_dir, extension_id)
                )
                steps = page.evaluate("() => window.runProbe()")
                print(json.dumps(steps, indent=2, ensure_ascii=False))
                check(steps, failures)
            finally:
                stop_application(binary, env)
                context.close()
    finally:
        if registered:
            print(node("unregister").stdout.strip())
        # The host started the application, and it holds the archive lock until told to
        # stop. Leaving it running would keep a process on a directory about to be deleted.
        # Also here: an early failure can leave an application running that the block
        # above never reached.
        stop_application(binary, env)
        if args.keep:
            print(f"left in place: {workspace}")
        else:
            # The application holds the archive open until it has finished exiting, and a
            # locked file cannot be removed on Windows. Retrying is therefore also the
            # check that it really stopped.
            deadline = time.monotonic() + 20
            while True:
                try:
                    shutil.rmtree(workspace)
                    break
                except OSError:
                    if time.monotonic() >= deadline:
                        print(
                            f"WARNING: {workspace} could not be removed; something is still "
                            "holding it open",
                            file=sys.stderr,
                        )
                        break
                    time.sleep(1)

    return report(failures)


def report(failures: list[str]) -> int:
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print("OK: the browser reached the archive through the host with no window open")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
