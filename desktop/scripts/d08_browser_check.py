"""D08 end to end: the real extension, the real desktop, a real browser.

What unit tests cannot show: a fill archived through the published plugin, its snapshot
staged in extension IndexedDB, uploaded chunk by chunk over Native Messaging, and sitting in
the archive afterwards as a file whose bytes are the ones captured — through an interrupted
upload, a closed desktop and a changed template.

    python scripts/d08_browser_check.py [--binary <path>] [--keep]

Run it by hand, not in CI: it needs a headed browser, it writes a real Native Messaging
registration (removed again through the dev script's receipt), and it starts the desktop.
Everything else is isolated in a temporary directory, as in d07_browser_check.py.

Phases
  1. Learn the extension id, register the host, pair.
  2. Desktop up: save a job to get an application. Archive a large fill with its snapshot and
     quit the desktop mid-upload (walkthrough 10.14).
  3. Desktop gone: archive a small fill with its snapshot, then change the template
     (walkthrough 10.10).
  4. Desktop back: the interrupted upload resumes on its own; bind the waiting fill; wait
     until the queue and IndexedDB are empty.
  5. Read the archive: two fill events, two snapshots, each file hashing to the digest the
     plugin recorded when it staged it, the 10.10 snapshot holding v1 and not v2 — and none
     of the synthetic secrets anywhere under the desktop's data directory (acceptance 5).

Closing order is the D06 one: quit the application, then close the browser.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

from d07_browser_check import (
    JOB,
    ask,
    copy_extension,
    default_binary,
    launch,
    node,
    pair,
    stop_application,
    storage,
    worker_of,
)

SECRETS = {
    "password": "hunter2-d08-synthetic",
    "otp": "481516-d08-synthetic",
    "url_token": "tok-d08-synthetic-url",
}

V1_MARK = "第一版合成经历"
V2_MARK = "第二版合成经历"


def template(mark: str, fields: int) -> dict:
    return {
        "id": "d08-template",
        "name": "合成模板",
        "groups": [
            {"name": "基本信息", "fields": [
                {"key": "姓名", "value": "合成姓名"},
                {"key": "登录密码", "value": SECRETS["password"]},
                {"key": "短信验证码", "value": SECRETS["otp"]},
            ]},
            {"name": "经历", "fields": [
                {"key": f"项目{i}", "value": f"{mark}{i} " * 30} for i in range(fields)
            ]},
        ],
    }


def raw_fill(outcome: str = "partial") -> dict:
    # The sidebar's own vocabulary (success / partial / failed); link/fillrecords.mjs maps it.
    return {
        "outcome": outcome, "cancelled": False, "fieldCount": 8, "filledCount": 6, "unconfirmedCount": 1,
        "timing": {"scanMs": 10, "roundTripMs": 20, "fillMs": 30, "totalMs": 60},
        "urlRedacted": f"{JOB['sourceUrl']}?access_token={SECRETS['url_token']}&role=backend",
        "templateName": "合成模板", "pluginVersion": "d08-check",
        "job": {"company": JOB["company"], "title": JOB["title"], "sourceUrl": JOB["sourceUrl"]},
    }


IDB_COUNT = """async () => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open('resume-pro-desktop'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  if (!db.objectStoreNames.contains('snapshots')) { db.close(); return 0; }
  const n = await new Promise((ok, no) => { const q = db.transaction('snapshots').objectStore('snapshots').count(); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); });
  db.close();
  return n;
}"""


def upload_entry(state: dict) -> dict | None:
    return next((e for e in state.get("desktopOutbox") or [] if e.get("messageType") == "snapshot.upload"), None)


def wait_for(predicate, timeout: float, step: float = 0.5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    return None


def scan_for_secrets(root: Path) -> list[str]:
    found = []
    needles = {name: value.encode("utf-8") for name, value in SECRETS.items()}
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        try:
            data = path.read_bytes()
        except OSError:
            continue
        for name, needle in needles.items():
            if needle in data:
                found.append(f"{name} in {path.relative_to(root)}")
    return found


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, default=None)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()
    source_binary = (args.binary or default_binary()).resolve()

    workspace = Path(tempfile.mkdtemp(prefix="resumepro-d08-"))
    data_dir = workspace / "data"
    data_dir.mkdir()
    extension = workspace / "extension"
    copy_extension(extension)
    binary = workspace / source_binary.name
    shutil.copy2(source_binary, binary)
    parked = workspace / (source_binary.name + ".parked")
    env = {**os.environ, "RESUMEPRO_DATA_DIR": str(data_dir)}
    # The workspace goes on every exit, early returns and exceptions included, unless kept.
    try:
        return run(workspace, data_dir, extension, binary, parked, env)
    finally:
        if args.keep:
            print(f"left in place: {workspace}")
        else:
            shutil.rmtree(workspace, ignore_errors=True)


def run(workspace: Path, data_dir: Path, extension: Path, binary: Path, parked: Path, env: dict) -> int:
    failures: list[str] = []
    results: dict = {}
    registered = False

    try:
        with sync_playwright() as playwright:
            # Phase 1 — the id Chrome assigns, a registration, a pairing.
            # Playwright's bundled browser is Chrome for Testing (1.49+), which reads Google
            # Chrome's Native Messaging location, hence --browser chrome below.
            context = launch(playwright, workspace, extension, env)
            try:
                extension_id = worker_of(context).url.split("/")[2]
                outcome = node("register", "--extension-id", extension_id, "--browser", "chrome", "--binary", str(binary))
                print(outcome.stdout.strip() or outcome.stderr.strip())
                if outcome.returncode != 0 or "skipped" in outcome.stdout:
                    failures.append("registration did not happen; remove any existing one first")
                    return report(failures, results)
                registered = True
            finally:
                stop_application(binary, env)
                context.close()
            pair(data_dir, extension_id)

            # Phase 2 — desktop up: an application, then a large upload cut off halfway.
            context = launch(playwright, workspace, extension, env)
            try:
                page = context.new_page()
                page.goto(f"chrome-extension://{extension_id}/popup.html")
                results["probe"] = ask(page, {"type": "DESKTOP_PROBE"}, tries=6)
                if results["probe"].get("mode") != "ready":
                    failures.append(f"the paired extension did not reach the desktop: {results['probe']}")
                    return report(failures, results)
                saved = ask(page, {"type": "DESKTOP_SAVE_JOB", "fields": JOB}, tries=3)
                intent_id = (saved.get("intent") or {}).get("intentId")
                bound = ask(page, {"type": "DESKTOP_BIND", "intentId": intent_id}, tries=3)
                application_id = bound.get("applicationId")
                results["application"] = application_id
                if not application_id:
                    failures.append(f"no application to archive against: {bound}")
                    return report(failures, results)

                large = ask(page, {"type": "DESKTOP_RECORD_FILL", "raw": raw_fill("success"),
                                   "applicationId": application_id, "snapshotTemplate": template("大快照", 1500)})
                results["large_record"] = {k: large.get(k) for k in ("status", "uploadQueued", "snapshotIssue")}
                worker = worker_of(context)
                # Quit the desktop as soon as a couple of chunks are through (walkthrough 10.14).
                partial = wait_for(lambda: (lambda e: e if e and e.get("chunkCursor", 0) >= 2 else None)(upload_entry(storage(worker))), 60, 0.2)
                results["interrupted_at_cursor"] = partial.get("chunkCursor") if partial else None
                results["large_snapshot"] = {"snapshotId": partial["snapshotId"], "sha256": partial["sha256"], "chunkCount": partial["chunkCount"]} if partial else None
            finally:
                # Take the binary away first: the host starts the desktop on demand, so a quit
                # alone would be undone by the next chunk. Windows allows renaming a running
                # executable; the quit is then sent through the parked copy, and only then is
                # the browser closed (D06: a surviving grandchild holds the browser's pipes).
                wait_for(lambda: not binary.exists() or _park(binary, parked), 20)
                stop_application(parked if parked.exists() else binary, env)
                context.close()

            # Phase 3 — desktop gone: archive offline, then change the template (10.10).
            context = launch(playwright, workspace, extension, env)
            try:
                page = context.new_page()
                page.goto(f"chrome-extension://{extension_id}/popup.html")
                worker = worker_of(context)
                worker.evaluate("t => chrome.storage.local.set({ templates: [t], activeTemplateId: t.id })", template(V1_MARK, 20))
                offline = ask(page, {"type": "DESKTOP_RECORD_FILL", "raw": raw_fill(), "snapshotTemplate": template(V1_MARK, 20)})
                results["offline_record"] = {k: offline.get(k) for k in ("status", "mode", "snapshotIssue")}
                state = storage(worker)
                records = state.get("desktopFillRecords") or []
                results["offline_record_snapshot"] = records[0].get("snapshot") if records else None
                worker.evaluate("t => chrome.storage.local.set({ templates: [t] })", template(V2_MARK, 20))
                results["idb_while_offline"] = worker.evaluate(IDB_COUNT)
            finally:
                context.close()

            # Phase 4 — desktop back: resume, bind, drain to empty.
            shutil.move(str(parked), str(binary))
            context = launch(playwright, workspace, extension, env)
            try:
                page = context.new_page()
                page.goto(f"chrome-extension://{extension_id}/popup.html")
                worker = worker_of(context)
                ask(page, {"type": "DESKTOP_PROBE"}, tries=6)
                record_id = (storage(worker).get("desktopFillRecords") or [{}])[0].get("recordId")
                bound_fill = ask(page, {"type": "DESKTOP_BIND_FILL", "recordId": record_id, "applicationId": application_id})
                results["bind_offline_record"] = {k: bound_fill.get(k) for k in ("status", "uploadQueued", "snapshotIssue")}

                def settled():
                    state = storage(worker)
                    if state.get("desktopOutbox") or state.get("desktopFillRecords"):
                        # Nudge the drain the way the sidebar's retry button would.
                        entry = upload_entry(state)
                        if entry and entry.get("status") == "pending":
                            ask(page, {"type": "DESKTOP_RETRY", "messageId": entry["messageId"]})
                        return None
                    return worker.evaluate(IDB_COUNT) == 0
                results["settled"] = bool(wait_for(settled, 180, 2))
                final = storage(worker)
                results["final_outbox"] = final.get("desktopOutbox")
                results["final_records"] = final.get("desktopFillRecords")
                results["final_idb"] = worker.evaluate(IDB_COUNT)
            finally:
                stop_application(binary, env)
                context.close()
    finally:
        if registered:
            print(node("unregister").stdout.strip())
        stop_application(binary, env)

    inspect_archive(data_dir, results)
    results["secrets_found"] = scan_for_secrets(data_dir)

    check(results, failures)
    return report(failures, results)


def _park(binary: Path, parked: Path) -> bool:
    try:
        shutil.move(str(binary), str(parked))
        return True
    except OSError:
        return False


def inspect_archive(data_dir: Path, results: dict) -> None:
    archive = data_dir / "archive"
    db = sqlite3.connect(f"file:{archive / 'archive.db'}?mode=ro", uri=True)
    try:
        results["fill_events"] = [
            {"type": row[0], "payload": json.loads(row[1])}
            for row in db.execute("SELECT event_type, payload FROM events WHERE event_type LIKE 'fill_%' ORDER BY recorded_at")
        ]
        snapshots = []
        for snapshot_id, sha, rel, name, size in db.execute(
            "SELECT snapshot_id, sha256, stored_rel_path, template_name, byte_size FROM resume_snapshots"
        ):
            data = (archive / rel).read_bytes() if (archive / rel).exists() else b""
            snapshots.append({
                "snapshotId": snapshot_id, "sha256": sha, "templateName": name, "byteSize": size,
                "fileSha256": hashlib.sha256(data).hexdigest() if data else None,
                "hasV1": V1_MARK.encode() in data, "hasV2": V2_MARK.encode() in data,
            })
        results["snapshots"] = snapshots
        results["staged_chunk_bytes_left"] = db.execute("SELECT COUNT(*) FROM snapshot_chunk_bytes").fetchone()[0]
    finally:
        db.close()


def check(results: dict, failures: list[str]) -> None:
    if (results.get("large_record") or {}).get("status") != "saved":
        failures.append(f"the online fill was not archived: {results.get('large_record')}")
    if not results.get("interrupted_at_cursor"):
        failures.append("the large upload was never seen part-way; the 10.14 interruption did not happen")
    if (results.get("offline_record") or {}).get("status") != "recorded":
        failures.append(f"the offline fill was not kept as a waiting record: {results.get('offline_record')}")
    if not (results.get("offline_record_snapshot") or {}).get("snapshotId"):
        failures.append("the offline fill has no staged snapshot")
    if results.get("idb_while_offline", 0) < 2:
        failures.append(f"expected both snapshots staged while the desktop was gone: {results.get('idb_while_offline')}")
    if (results.get("bind_offline_record") or {}).get("status") != "saved":
        failures.append(f"binding the waiting fill failed: {results.get('bind_offline_record')}")
    if not results.get("settled"):
        failures.append(f"the queue never drained: outbox={results.get('final_outbox')} idb={results.get('final_idb')}")

    events = results.get("fill_events") or []
    if len(events) != 2:
        failures.append(f"expected exactly two fill events, found {len(events)}")
    if sorted(event["type"] for event in events) != ["fill_completed", "fill_partial"]:
        failures.append(f"fill outcomes did not survive the trip: {[event['type'] for event in events]}")
    for event in events:
        if "access_token" in json.dumps(event["payload"]):
            failures.append("a URL token reached a fill event")

    snapshots = {s["snapshotId"]: s for s in results.get("snapshots") or []}
    if len(snapshots) != 2:
        failures.append(f"expected two snapshots in the archive, found {len(snapshots)}")
    expected = {}
    if results.get("large_snapshot"):
        expected[results["large_snapshot"]["snapshotId"]] = results["large_snapshot"]["sha256"]
    if results.get("offline_record_snapshot"):
        expected[results["offline_record_snapshot"]["snapshotId"]] = results["offline_record_snapshot"]["sha256"]
    for snapshot_id, sha in expected.items():
        stored = snapshots.get(snapshot_id)
        if not stored:
            failures.append(f"snapshot {snapshot_id} never reached the archive")
            continue
        if stored["sha256"] != sha or stored["fileSha256"] != sha:
            failures.append(f"snapshot {snapshot_id} is not the bytes the plugin staged")
        if stored["templateName"] != "合成模板":
            failures.append(f"snapshot {snapshot_id} lost its template name: {stored['templateName']}")
    offline = snapshots.get((results.get("offline_record_snapshot") or {}).get("snapshotId"))
    if offline and (not offline["hasV1"] or offline["hasV2"]):
        failures.append("walkthrough 10.10: the archived snapshot is not the v1 captured at confirmation")
    if results.get("staged_chunk_bytes_left"):
        failures.append("staged chunk bytes were left in the archive after completion")
    if results.get("secrets_found"):
        failures.append(f"synthetic secrets reached the desktop data directory: {results['secrets_found']}")


def report(failures: list[str], results: dict) -> int:
    print(json.dumps(results, indent=2, ensure_ascii=False))
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print("OK: fills archived, snapshots uploaded through interruption and offline, bytes intact, no secrets")
    return 0


if __name__ == "__main__":
    sys.exit(main())
