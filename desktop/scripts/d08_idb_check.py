"""Prove that a staged snapshot survives the two things D08 depends on it surviving.

Risk V12 in docs/desktop-mvp/downstream-decisions.md: D01 §8.5 promises that a confirmed
snapshot kept in extension-origin IndexedDB is still there, byte for byte, after the service
worker is evicted and after the browser restarts. Every retry sends those original bytes, so
if either loses them the offline snapshot story in D08 is false and §8.5 has to change before
any upload code is written.

The check loads the shipped extension, stages a multi-chunk snapshot through the plugin's own
modules (link/snapshot.mjs, link/staging.mjs, and the IndexedDB adapter in link/chrome.mjs)
from an extension page, then:

  1. reads the record from inside the service worker with nothing but the raw IndexedDB API,
     proving the worker sees what another extension context staged;
  2. closes the browser, starts it again on the same profile, and reads it from the new
     worker instance, then reassembles every chunk through the plugin's own staging module.

Every read must hash to the digest computed at staging time.

Why there is no "stop the worker" phase: IndexedDB data lives in the browser process's
storage backend, not in the worker's renderer, so an idle eviction only ever loses the
renderer. A full browser restart loses every process and has to read the bytes back from
disk, which is strictly the harder case. It is also the only one that can be forced here:
Playwright attaches a debugger to the worker, Chrome does not evict a worker under a
debugger, CDP's ServiceWorker.stopAllWorkers leaves it running, closing its target takes the
whole automation session down, and chrome.runtime.reload() unloads a command-line extension.

Run it by hand, not in CI (it needs a headed browser):

    python scripts/d08_idb_check.py [--keep]

No desktop binary and no Native Messaging registration are involved.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

DESKTOP = Path(__file__).resolve().parent.parent
PLUGIN = DESKTOP.parent

EXCLUDE = {
    ".git", ".github", ".playwright-cli", ".secrets", ".edge-icon-profile",
    "desktop", "docs", "archive", "output", "tests", "node_modules",
}

# Large enough to span several 32 KiB chunks, synthetic throughout.
STAGE = """async () => {
  const { idbStore } = await import('/link/chrome.mjs');
  const { createStaging } = await import('/link/staging.mjs');
  const { buildSnapshot, planChunks } = await import('/link/snapshot.mjs');
  const template = {
    name: '合成模板',
    groups: [{ name: '经历', fields: Array.from({ length: 400 }, (_, i) => ({
      key: `项目${i}`, value: `合成项目描述 ${i} `.repeat(20)
    })) }]
  };
  const snapshot = await buildSnapshot(template);
  snapshot.chunks = await planChunks(snapshot.bytes);
  const staging = createStaging({ kv: idbStore(), uuid: () => crypto.randomUUID() });
  const result = await staging.stage(snapshot);
  return { status: result.status, reason: result.reason ?? null,
           snapshotId: result.record?.snapshotId ?? null,
           sha256: snapshot.sha256, byteSize: snapshot.byteSize, chunkCount: snapshot.chunks.length };
}"""

# Deliberately free of the plugin's own modules: this is what any later reader in the worker
# will be able to see, independent of the adapter that wrote it.
READ_RAW = """async (snapshotId) => {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('resume-pro-desktop');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const record = await new Promise((resolve, reject) => {
    const tx = db.transaction('snapshots', 'readonly');
    const request = tx.objectStore('snapshots').get(snapshotId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  if (!record) return null;
  const digest = await crypto.subtle.digest('SHA-256', record.bytes);
  return { sha256: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join(''),
           chunkCount: record.chunkCount, byteSize: record.byteSize };
}"""

READ_CHUNKS = """async (snapshotId) => {
  const { idbStore } = await import('/link/chrome.mjs');
  const { createStaging } = await import('/link/staging.mjs');
  const { sha256Hex } = await import('/link/snapshot.mjs');
  const staging = createStaging({ kv: idbStore(), uuid: () => crypto.randomUUID() });
  const record = await staging.get(snapshotId);
  if (!record) return null;
  const parts = [];
  for (let i = 0; i < record.chunkCount; i += 1) parts.push(await staging.readChunk(snapshotId, i));
  const joined = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }
  return { sha256: await sha256Hex(joined), chunks: parts.length };
}"""


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


def launch(playwright, workspace: Path, extension: Path):
    return playwright.chromium.launch_persistent_context(
        user_data_dir=str(workspace / "profile"),
        headless=False,
        args=[
            f"--disable-extensions-except={extension}",
            f"--load-extension={extension}",
        ],
    )


def extension_worker(context, extension_id: str | None = None):
    for worker in context.service_workers:
        if extension_id is None or extension_id in worker.url:
            return worker
    return context.wait_for_event("serviceworker", timeout=30_000)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()

    workspace = Path(tempfile.mkdtemp(prefix="resumepro-d08-idb-"))
    extension = workspace / "extension"
    copy_extension(extension)
    results: dict = {}
    failures: list[str] = []

    try:
        with sync_playwright() as playwright:
            context = launch(playwright, workspace, extension)
            try:
                worker = extension_worker(context)
                extension_id = worker.url.split("/")[2]
                results["extensionId"] = extension_id

                page = context.new_page()
                page.goto(f"chrome-extension://{extension_id}/popup.html")
                staged = page.evaluate(STAGE)
                results["staged"] = staged
                if staged.get("status") != "staged":
                    failures.append(f"staging failed before any restart: {staged}")
                    return report(failures, results)
                snapshot_id = staged["snapshotId"]

                results["worker_same_session"] = worker.evaluate(READ_RAW, snapshot_id)
                # Mark this instance so the read after the restart provably ran in another one.
                worker.evaluate("() => { self.__d08Instance = 'first-session'; }")
            finally:
                context.close()

            context = launch(playwright, workspace, extension)
            try:
                worker = extension_worker(context, extension_id)
                results["new_worker_instance"] = worker.evaluate("() => self.__d08Instance ?? null") is None
                results["worker_after_browser_restart"] = worker.evaluate(READ_RAW, snapshot_id)
                page = context.new_page()
                page.goto(f"chrome-extension://{extension_id}/popup.html")
                results["chunks_after_browser_restart"] = page.evaluate(READ_CHUNKS, snapshot_id)
            finally:
                context.close()
    finally:
        if args.keep:
            print(f"left in place: {workspace}")
        else:
            shutil.rmtree(workspace, ignore_errors=True)

    expected = results.get("staged", {}).get("sha256")
    if results.get("staged", {}).get("chunkCount", 0) < 2:
        failures.append("the synthetic snapshot did not span several chunks")
    if not results.get("new_worker_instance"):
        failures.append("the read after the restart did not run in a new worker instance")
    for phase in ("worker_same_session", "worker_after_browser_restart"):
        read = results.get(phase)
        if not read or read.get("sha256") != expected:
            failures.append(f"{phase}: expected {expected}, got {read}")
    chunks = results.get("chunks_after_browser_restart") or {}
    if chunks.get("sha256") != expected:
        failures.append(f"reassembled chunks after the browser restart do not match: {chunks}")
    return report(failures, results)


def report(failures: list[str], results: dict) -> int:
    print(json.dumps(results, indent=2, ensure_ascii=False))
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1
    print("OK: staged snapshot bytes were visible to the worker and survived a browser restart")
    return 0


if __name__ == "__main__":
    sys.exit(main())
