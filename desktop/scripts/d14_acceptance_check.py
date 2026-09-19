#!/usr/bin/env python3
"""Prepare and verify D14 installed-browser acceptance runs.

This helper deliberately does not install software or mark cases as PASS.  It binds a
run to exact installer/extension bytes, creates separate Chrome and Edge reports, and
can inspect the production Native Messaging registration after the operator installs
the candidate.  Human-visible journeys remain human decisions in report.json.
"""

from __future__ import annotations

import argparse
import base64
import ctypes
import hashlib
import json
import os
import platform
import re
import subprocess
import sys
import tempfile
import time
import zipfile
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[2]
ACCEPTANCE = ROOT / "docs" / "desktop-mvp" / "acceptance"
REPORT_TEMPLATE = ACCEPTANCE / "report-template.json"
REVIEWED_ASSETS = Path(__file__).with_name("plugin-release-assets.json")
EXPECTED_EXTENSION_ID = "diagjmploldedipjdenmecmjokckelkl"
EXPECTED_ORIGIN = f"chrome-extension://{EXPECTED_EXTENSION_ID}/"
HOST_NAME = "com.resumepro.desktop"
VALID_STATUSES = {"PASS", "FAIL", "BLOCKED", "NOT_RUN", "NOT_APPLICABLE"}
JOURNEYS = {f"J{i:02d}" for i in range(1, 9)}
CORE_EXTENSION_FILES = {
    "manifest.json", "background.js", "content.js", "content.css", "sidebar-state.js",
    "ai-helpers.js", "form-agent.js", "ai-worker.js", "ai-host.js", "ai-host.html",
    "ai-client.js", "ai-models.js", "resume-utils.js", "profile-fields.js",
    "popup.html", "popup.css", "popup.js", "xlsx.full.min.js",
    "mammoth.browser.min.js", "README.md", "LICENSE",
}
TEXT_SUFFIXES = {".json", ".js", ".mjs", ".cjs", ".html", ".css", ".md", ".txt"}
SYNTHETIC_MARKER = b"D14_SYNTHETIC_"


class AcceptanceError(RuntimeError):
    """A candidate or report is not safe to accept."""


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extension_id_from_key(encoded_key: str) -> str:
    try:
        key = base64.b64decode(encoded_key, validate=True)
    except (ValueError, TypeError) as exc:
        raise AcceptanceError("manifest key is not valid base64") from exc
    first = hashlib.sha256(key).digest()[:16]
    return "".join(chr(ord("a") + nibble) for byte in first for nibble in (byte >> 4, byte & 15))


def safe_zip_name(name: str) -> str:
    if "\\" in name:
        raise AcceptanceError(f"extension ZIP contains a backslash path: {name}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise AcceptanceError(f"extension ZIP contains an unsafe path: {name}")
    return path.as_posix()


def inspect_extension_zip(path: Path) -> dict:
    expected = CORE_EXTENSION_FILES | set(read_json(REVIEWED_ASSETS))
    with zipfile.ZipFile(path) as archive:
        files: dict[str, zipfile.ZipInfo] = {}
        for info in archive.infolist():
            name = safe_zip_name(info.filename.rstrip("/"))
            if info.is_dir():
                continue
            if name in files:
                raise AcceptanceError(f"extension ZIP contains a duplicate entry: {name}")
            unix_mode = (info.external_attr >> 16) & 0o170000
            if unix_mode == 0o120000:
                raise AcceptanceError(f"extension ZIP contains a symbolic link: {name}")
            files[name] = info

        names = set(files)
        missing = sorted(expected - names)
        extra = sorted(names - expected)
        if missing or extra:
            details = []
            if missing:
                details.append(f"missing {len(missing)} files: {', '.join(missing[:8])}")
            if extra:
                details.append(f"unexpected {len(extra)} files: {', '.join(extra[:8])}")
            raise AcceptanceError("extension ZIP does not match the reviewed release allowlist; " + "; ".join(details))

        manifest = json.loads(archive.read("manifest.json"))
        extension_id = extension_id_from_key(manifest.get("key", ""))
        if extension_id != EXPECTED_EXTENSION_ID:
            raise AcceptanceError(
                f"extension key resolves to {extension_id}, expected {EXPECTED_EXTENSION_ID}"
            )
        for name, info in files.items():
            if PurePosixPath(name).suffix.lower() in TEXT_SUFFIXES:
                if SYNTHETIC_MARKER in archive.read(info):
                    raise AcceptanceError(f"extension ZIP contains a D14 synthetic marker: {name}")

    return {
        "version": manifest.get("version"),
        "extensionId": extension_id,
        "fileCount": len(files),
    }


def assert_extracted_matches_zip(archive_path: Path, directory: Path) -> None:
    with zipfile.ZipFile(archive_path) as archive:
        expected = {
            safe_zip_name(info.filename.rstrip("/")): hashlib.sha256(archive.read(info)).hexdigest()
            for info in archive.infolist()
            if not info.is_dir()
        }
    actual = {
        file.relative_to(directory).as_posix(): sha256_file(file)
        for file in directory.rglob("*")
        if file.is_file()
    }
    if actual != expected:
        missing = sorted(expected.keys() - actual.keys())
        extra = sorted(actual.keys() - expected.keys())
        changed = sorted(name for name in expected.keys() & actual.keys() if expected[name] != actual[name])
        raise AcceptanceError(
            "extracted extension does not match the candidate ZIP; "
            f"missing={missing[:5]}, extra={extra[:5]}, changed={changed[:5]}"
        )


def assert_chrome_profile_has_candidate(profile: Path, extension_dir: Path, version: str) -> None:
    matches = []
    for preferences in sorted(profile.glob("*/Preferences")) + sorted(profile.glob("*/Secure Preferences")):
        try:
            payload = read_json(preferences)
        except (OSError, json.JSONDecodeError):
            continue
        setting = payload.get("extensions", {}).get("settings", {}).get(EXPECTED_EXTENSION_ID)
        if not isinstance(setting, dict):
            continue
        manifest = setting.get("manifest") if isinstance(setting.get("manifest"), dict) else {}
        configured_path = setting.get("path")
        if not isinstance(configured_path, str) or not configured_path:
            continue
        candidate = Path(configured_path)
        if not candidate.is_absolute():
            candidate = (preferences.parent / candidate).resolve()
        else:
            candidate = candidate.resolve()
        if candidate == extension_dir.resolve() and manifest.get("version") == version:
            matches.append(preferences)
    if not matches:
        raise AcceptanceError(
            "the isolated Chrome profile does not point the fixed extension id and version "
            f"at the extracted candidate directory: {extension_dir}"
        )


def powershell_value(script: str) -> str | None:
    if sys.platform != "win32":
        return None
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )
    value = completed.stdout.strip()
    return value or None


def file_version(path: Path) -> str | None:
    escaped = str(path).replace("'", "''")
    return powershell_value(
        f"[Diagnostics.FileVersionInfo]::GetVersionInfo('{escaped}').ProductVersion"
    )


def authenticode_status(path: Path) -> str | None:
    escaped = str(path.resolve(strict=True)).replace("'", "''")
    return powershell_value(f"(Get-AuthenticodeSignature -LiteralPath '{escaped}').Status")


def browser_candidates() -> dict[str, list[Path]]:
    local = Path(os.environ.get("LOCALAPPDATA", ""))
    program = Path(os.environ.get("ProgramFiles", ""))
    program_x86 = Path(os.environ.get("ProgramFiles(x86)", ""))
    return {
        "chrome": [
            local / "Google/Chrome/Application/chrome.exe",
            program / "Google/Chrome/Application/chrome.exe",
            program_x86 / "Google/Chrome/Application/chrome.exe",
        ],
        "edge": [
            program_x86 / "Microsoft/Edge/Application/msedge.exe",
            program / "Microsoft/Edge/Application/msedge.exe",
        ],
    }


def evidence_path(path: Path) -> str:
    value = str(path)
    roots = [
        ("LOCALAPPDATA", os.environ.get("LOCALAPPDATA")),
        ("PROGRAMFILES(X86)", os.environ.get("ProgramFiles(x86)")),
        ("PROGRAMFILES", os.environ.get("ProgramFiles")),
    ]
    for name, root in roots:
        if not root:
            continue
        prefix = root.rstrip("\\/")
        if value.casefold() == prefix.casefold():
            return f"%{name}%"
        if any(value.casefold().startswith((prefix + separator).casefold()) for separator in ("\\", "/")):
            return f"%{name}%" + value[len(prefix):]
    return value


def browser_environment(name: str) -> dict:
    matches = []
    for path in browser_candidates()[name]:
        try:
            exists = path.is_file()
        except OSError:
            escaped = str(path).replace("'", "''")
            exists = powershell_value(f"Test-Path -LiteralPath '{escaped}' -PathType Leaf") == "True"
        if exists and path not in matches:
            matches.append(path)
    if len(matches) != 1:
        raise AcceptanceError(
            f"expected one installed {name} executable, found {len(matches)}: {matches}"
        )
    executable = matches[0]
    version = file_version(executable)
    if not version:
        parent = str(executable.parent).replace("'", "''")
        version = powershell_value(
            f"Get-ChildItem -LiteralPath '{parent}' -Directory -ErrorAction SilentlyContinue | "
            "Where-Object { $_.Name -match '^\\d+(\\.\\d+)+$' } | "
            "Sort-Object { [version]$_.Name } | Select-Object -Last 1 -ExpandProperty Name"
        )
    return {"browser": name, "path": evidence_path(executable), "version": version}


def windows_environment(browser: str) -> dict:
    if sys.platform != "win32":
        raise AcceptanceError("T4 installed-browser acceptance must be prepared on Windows")
    current_version = powershell_value(
        "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').DisplayVersion"
    )
    build = powershell_value(
        "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').CurrentBuildNumber"
    )
    webview_root = Path(os.environ.get("ProgramFiles(x86)", "")) / "Microsoft/EdgeWebView/Application"
    webview_versions = sorted(
        (entry.name for entry in webview_root.iterdir() if entry.is_dir() and re.fullmatch(r"\d+(?:\.\d+)+", entry.name)),
        key=lambda value: tuple(int(part) for part in value.split(".")),
    ) if webview_root.is_dir() else []
    browser_info = browser_environment(browser)
    return {
        "osBuild": f"Windows {current_version or platform.release()} build {build or platform.version()}",
        "architecture": platform.machine(),
        "accountType": "administrator" if ctypes.windll.shell32.IsUserAnAdmin() else "standard-user",
        "timezone": datetime.now().astimezone().tzname(),
        "browser": browser,
        "browserVersion": browser_info["version"],
        "browserExecutable": browser_info["path"],
        "webview2Version": webview_versions[-1] if webview_versions else None,
    }


def artifact(path: Path, download_url: str | None) -> dict:
    resolved = path.resolve(strict=True)
    return {
        "name": resolved.name,
        "byteLength": resolved.stat().st_size,
        "sha256": sha256_file(resolved),
        "downloadUrl": download_url,
    }


def verify_artifact_path(path: Path, expected: dict, label: str) -> Path:
    resolved = path.resolve(strict=True)
    if resolved.name != expected.get("name"):
        raise AcceptanceError(f"{label} file name changed: {resolved.name} != {expected.get('name')}")
    if resolved.stat().st_size != expected.get("byteLength"):
        raise AcceptanceError(f"{label} byte length changed after prepare: {resolved}")
    if sha256_file(resolved) != expected.get("sha256"):
        raise AcceptanceError(f"{label} bytes changed after prepare: {resolved}")
    return resolved


def prepare(args) -> None:
    run_dir = args.run_dir.resolve()
    if run_dir.exists():
        raise AcceptanceError(f"run directory already exists; refusing to overwrite evidence: {run_dir}")
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_commit.lower()):
        raise AcceptanceError("--source-commit must be a full 40-character Git commit")
    for label, value in (("desktop", args.desktop_url), ("extension", args.extension_url)):
        parsed = urlparse(value)
        if parsed.scheme != "https" or not parsed.netloc:
            raise AcceptanceError(f"--{label}-url must be an https candidate download URL")
    extension_details = inspect_extension_zip(args.extension_zip.resolve(strict=True))
    if not extension_details.get("version"):
        raise AcceptanceError("extension manifest has no version")

    environments = {browser: windows_environment(browser) for browser in ("chrome", "edge")}
    if any(env["accountType"] != "standard-user" for env in environments.values()):
        raise AcceptanceError("T4 must be prepared from a non-elevated standard-user session")
    for browser, environment in environments.items():
        if not environment.get("browserVersion"):
            raise AcceptanceError(f"could not determine the installed {browser} version")
        if not environment.get("webview2Version"):
            raise AcceptanceError("could not determine the installed WebView2 version")

    desktop = artifact(args.installer, args.desktop_url)
    extension = artifact(args.extension_zip, args.extension_url)
    desktop["signatureStatus"] = authenticode_status(args.installer)
    if not desktop["signatureStatus"]:
        raise AcceptanceError("could not determine the installer Authenticode status")
    extension["distributionChannel"] = "candidate-zip"
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    run_id = args.run_id or run_dir.name
    candidate = {
        "schemaVersion": 1,
        "runId": run_id,
        "fixtureVersion": "d14-v1",
        "testedSourceCommit": args.source_commit.lower(),
        "desktopVersion": args.desktop_version,
        "extensionVersion": extension_details["version"],
        "protocolVersion": args.protocol_version,
        "generatedAt": generated_at,
        "desktop": desktop,
        "extension": {**extension, **extension_details},
    }

    run_dir.mkdir(parents=True)
    write_json(run_dir / "artifacts.json", candidate)
    template = read_json(REPORT_TEMPLATE)
    for browser, environment in environments.items():
        browser_dir = run_dir / browser
        browser_dir.mkdir()
        report = deepcopy(template)
        report.update(
            runId=f"{run_id}-{browser}",
            testedSourceCommit=args.source_commit.lower(),
            startedAt=generated_at,
            desktopVersion=args.desktop_version,
            extensionVersion=extension_details["version"],
            protocolVersion=args.protocol_version,
            desktopArtifact={key: desktop[key] for key in ("name", "sha256", "downloadUrl")},
            extensionArtifact={key: extension[key] for key in ("name", "sha256", "downloadUrl")},
            environment=environment,
        )
        report["t4Preflight"] = {
            "candidateVerified": True,
            "extensionId": extension_details["extensionId"],
            "extensionFileCount": extension_details["fileCount"],
            "desktopSignatureStatus": desktop["signatureStatus"],
            "installedRegistration": "NOT_INSPECTED",
        }
        write_json(browser_dir / "report.json", report)
    print(f"prepared immutable candidate evidence and two NOT_RUN reports in {run_dir}")


def registry_manifest(browser: str) -> tuple[str, Path, dict]:
    if sys.platform != "win32":
        raise AcceptanceError("Native Messaging registry inspection is Windows-only")
    import winreg

    vendor = "Google\\Chrome" if browser == "chrome" else "Microsoft\\Edge"
    subkey = f"Software\\{vendor}\\NativeMessagingHosts\\{HOST_NAME}"
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, subkey) as key:
            value, _ = winreg.QueryValueEx(key, "")
    except OSError as exc:
        raise AcceptanceError(f"missing HKCU Native Messaging registration: {subkey}") from exc
    manifest_path = Path(value).resolve(strict=True)
    payload = read_json(manifest_path)
    return subkey, manifest_path, payload


def inspect_installed(args) -> None:
    report_path = args.run_dir.resolve() / args.browser / "report.json"
    report = read_json(report_path)
    artifacts = read_json(args.run_dir.resolve() / "artifacts.json")
    verify_artifact_path(args.installer, artifacts["desktop"], "desktop")
    verify_artifact_path(args.extension_zip, artifacts["extension"], "extension")

    installed_exe = args.installed_exe.resolve(strict=True)
    subkey, manifest_path, payload = registry_manifest(args.browser)
    registered_exe = Path(payload.get("path", "")).resolve(strict=True)
    if registered_exe != installed_exe:
        raise AcceptanceError(f"manifest points at {registered_exe}, expected {installed_exe}")
    if payload.get("name") != HOST_NAME:
        raise AcceptanceError(f"manifest host name is {payload.get('name')}, expected {HOST_NAME}")
    if payload.get("type") != "stdio":
        raise AcceptanceError("Native Messaging manifest is not stdio")
    if payload.get("allowed_origins") != [EXPECTED_ORIGIN]:
        raise AcceptanceError(f"production allowlist is not exact: {payload.get('allowed_origins')}")

    report["desktopVersion"] = file_version(installed_exe) or report.get("desktopVersion")
    report["environment"] = windows_environment(args.browser)
    report["t4Preflight"]["installedRegistration"] = "VERIFIED"
    report["t4Preflight"]["installedExecutable"] = evidence_path(installed_exe)
    report["t4Preflight"]["registryKey"] = f"HKCU\\{subkey}"
    report["t4Preflight"]["nativeManifest"] = evidence_path(manifest_path)
    report["t4Preflight"]["allowedOrigins"] = payload["allowed_origins"]
    write_json(report_path, report)
    print(f"verified installed production registration for {args.browser}: {installed_exe}")


def stop_application(binary: Path) -> None:
    flags = 0x08000000 if sys.platform == "win32" else 0
    subprocess.run(
        [str(binary), "--quit"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
        timeout=30,
        creationflags=flags,
    )


def installed_smoke(args) -> None:
    if sys.platform != "win32":
        raise AcceptanceError("installed browser smoke is Windows-only")
    run_dir = args.run_dir.resolve()
    browser_dir = run_dir / args.browser
    result_path = browser_dir / "installed-smoke.json"
    if result_path.exists():
        raise AcceptanceError(f"refusing to overwrite existing smoke evidence: {result_path}")
    report_path = browser_dir / "report.json"
    report = read_json(report_path)
    if report.get("t4Preflight", {}).get("installedRegistration") != "VERIFIED":
        raise AcceptanceError("run inspect-installed before the installed browser smoke")
    artifacts = read_json(run_dir / "artifacts.json")
    archive_path = verify_artifact_path(args.extension_zip, artifacts["extension"], "extension")
    extension_dir = args.extension_dir.resolve(strict=True)
    assert_extracted_matches_zip(archive_path, extension_dir)
    extension_version = artifacts["extension"].get("version")

    installed_exe = args.installed_exe.resolve(strict=True)
    _, _, native_manifest = registry_manifest(args.browser)
    if Path(native_manifest.get("path", "")).resolve(strict=True) != installed_exe:
        raise AcceptanceError("production registration no longer points at the installed executable")

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise AcceptanceError("Playwright is required: python -m pip install playwright==1.58.0") from exc

    results = {
        "browser": args.browser,
        "browserVersion": report["environment"].get("browserVersion"),
        "extensionId": EXPECTED_EXTENSION_ID,
        "installedExecutable": evidence_path(installed_exe),
        "startedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "probe": None,
        "save": None,
        "bind": None,
        "confirm": None,
        "outboxEmpty": False,
        "status": "FAIL",
        "failures": [],
    }
    failures = results["failures"]
    with tempfile.TemporaryDirectory(prefix=f"resumepro-d14-{args.browser}-") as temp:
        workspace = Path(temp)
        data_dir = workspace / "data"
        data_dir.mkdir()
        if args.browser == "chrome":
            if args.browser_profile is None:
                raise AcceptanceError(
                    "stable Chrome requires --browser-profile with the candidate already loaded; "
                    "command-line extension loading is not supported"
                )
            profile = args.browser_profile.resolve(strict=True)
            assert_chrome_profile_has_candidate(profile, extension_dir, extension_version)
            browser_args = []
        else:
            profile = workspace / "profile"
            browser_args = [
                f"--disable-extensions-except={extension_dir}",
                f"--load-extension={extension_dir}",
            ]
        env = {**os.environ, "RESUMEPRO_DATA_DIR": str(data_dir)}
        stop_application(installed_exe)
        try:
            with sync_playwright() as playwright:
                context = playwright.chromium.launch_persistent_context(
                    user_data_dir=str(profile),
                    headless=False,
                    channel="chrome" if args.browser == "chrome" else "msedge",
                    env=env,
                    args=browser_args,
                    ignore_default_args=["--disable-extensions"] if args.browser == "chrome" else None,
                )
                try:
                    worker = context.service_workers[0] if context.service_workers else context.wait_for_event(
                        "serviceworker", timeout=30_000
                    )
                    actual_id = worker.url.split("/")[2]
                    if actual_id != EXPECTED_EXTENSION_ID:
                        failures.append(f"browser loaded extension id {actual_id}")
                    page = context.new_page()
                    page.goto(f"chrome-extension://{EXPECTED_EXTENSION_ID}/popup.html")

                    def ask(message: dict, tries: int = 1) -> dict:
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

                    results["probe"] = ask({"type": "DESKTOP_PROBE"}, tries=8)
                    job = {
                        "company": "D14 合成科技有限公司",
                        "title": f"{args.browser} 安装验收工程师",
                        "location": "上海",
                        "sourceUrl": f"https://jobs.example.test/d14/{args.browser}",
                        "dedupeUrl": f"https://jobs.example.test/d14/{args.browser}",
                    }
                    results["save"] = ask({"type": "DESKTOP_SAVE_JOB", "fields": job}, tries=3)
                    intent_id = (results["save"].get("intent") or {}).get("intentId")
                    results["bind"] = ask({"type": "DESKTOP_BIND", "intentId": intent_id}, tries=3)
                    application_id = results["bind"].get("applicationId")
                    results["confirm"] = ask(
                        {"type": "DESKTOP_CONFIRM_SUBMIT", "applicationId": application_id}, tries=3
                    )
                    state = worker.evaluate("() => chrome.storage.local.get(null)")
                    results["outboxEmpty"] = not state.get("desktopOutbox") and not state.get("desktopSaveIntents")
                finally:
                    stop_application(installed_exe)
                    context.close()
        finally:
            stop_application(installed_exe)

    if (results["probe"] or {}).get("mode") != "ready":
        failures.append(f"installed host handshake failed: {results['probe']}")
    if (results["save"] or {}).get("status") != "queued":
        failures.append(f"job save was not queued: {results['save']}")
    if (results["bind"] or {}).get("status") != "saved":
        failures.append(f"job bind was not saved: {results['bind']}")
    if (results["confirm"] or {}).get("status") != "saved":
        failures.append(f"submission confirmation was not saved: {results['confirm']}")
    if not results["outboxEmpty"]:
        failures.append("extension outbox/intents did not drain")
    results["completedAt"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    results["status"] = "PASS" if not failures else "FAIL"
    write_json(result_path, results)
    report["t4Preflight"]["installedSmoke"] = {
        "status": results["status"],
        "evidence": str(result_path.relative_to(run_dir).as_posix()),
        "note": "supplemental automation; human-visible J01-J08 remain unchanged",
    }
    write_json(report_path, report)
    if failures:
        raise AcceptanceError("\n".join(failures))
    print(f"OK: installed {args.browser} host smoke passed; J01-J08 were not auto-promoted")


def verify_report(path: Path, require_complete: bool, candidate: dict | None = None) -> list[str]:
    report = read_json(path)
    errors = []
    cases = report.get("cases") or []
    ids = [case.get("id") for case in cases]
    if not JOURNEYS.issubset(ids):
        errors.append("report is missing one or more J01-J08 journeys")
    for case in cases:
        status = case.get("status")
        if status not in VALID_STATUSES:
            errors.append(f"{case.get('id')}: invalid status {status}")
            continue
        if status in {"PASS", "FAIL"} and not case.get("evidence"):
            errors.append(f"{case.get('id')}: {status} requires evidence")
        if status == "BLOCKED" and not case.get("defect"):
            errors.append(f"{case.get('id')}: BLOCKED requires a blocker/defect")
        if status == "NOT_APPLICABLE" and not report.get("scopeDecision"):
            errors.append(f"{case.get('id')}: NOT_APPLICABLE requires a scopeDecision")
        if require_complete and case.get("id") in JOURNEYS and status != "PASS":
            errors.append(f"{case.get('id')}: T4 completion requires PASS, found {status}")
    if require_complete:
        review = report.get("review") or {}
        if review.get("decision") != "APPROVED":
            errors.append("T4 completion requires review.decision=APPROVED")
        if not review.get("reviewer"):
            errors.append("T4 completion requires a named review.reviewer")
        if not review.get("reviewedAt"):
            errors.append("T4 completion requires review.reviewedAt")
        if review.get("blockingDefects"):
            errors.append("T4 completion rejects non-empty review.blockingDefects")
    for field in ("testedSourceCommit", "desktopVersion", "extensionVersion", "protocolVersion"):
        if report.get(field) in (None, ""):
            errors.append(f"missing {field}")
    for kind in ("desktopArtifact", "extensionArtifact"):
        for field in ("name", "sha256", "downloadUrl"):
            if not report.get(kind, {}).get(field):
                errors.append(f"missing {kind}.{field}")
    environment = report.get("environment") or {}
    for field in ("osBuild", "architecture", "accountType", "browser", "browserVersion", "webview2Version"):
        if not environment.get(field):
            errors.append(f"missing environment.{field}")
    if report.get("t4Preflight", {}).get("installedRegistration") != "VERIFIED":
        errors.append("installed production Native Messaging registration was not verified")
    if candidate is not None:
        bindings = {
            "fixtureVersion": candidate.get("fixtureVersion"),
            "testedSourceCommit": candidate.get("testedSourceCommit"),
            "protocolVersion": candidate.get("protocolVersion"),
            "desktopArtifact": {
                key: candidate.get("desktop", {}).get(key)
                for key in ("name", "sha256", "downloadUrl")
            },
            "extensionArtifact": {
                key: candidate.get("extension", {}).get(key)
                for key in ("name", "sha256", "downloadUrl")
            },
        }
        for field, expected in bindings.items():
            if report.get(field) != expected:
                errors.append(f"{field} does not match artifacts.json")
    return errors


def verify(args) -> None:
    run_dir = args.run_dir.resolve()
    errors = []
    artifacts = read_json(run_dir / "artifacts.json")
    for kind, path in (("desktop", args.installer), ("extension", args.extension_zip)):
        try:
            verify_artifact_path(path, artifacts[kind], kind)
        except (AcceptanceError, OSError) as exc:
            errors.append(str(exc))
    for browser in ("chrome", "edge"):
        errors.extend(f"{browser}: {error}" for error in verify_report(
            run_dir / browser / "report.json", args.require_complete, artifacts
        ))
    if errors:
        raise AcceptanceError("\n".join(errors))
    print("OK: candidate hashes and both installed-browser reports satisfy the requested gate")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)

    prepare_parser = commands.add_parser("prepare", help="bind a run to exact candidate bytes")
    prepare_parser.add_argument("--installer", type=Path, required=True)
    prepare_parser.add_argument("--extension-zip", type=Path, required=True)
    prepare_parser.add_argument("--run-dir", type=Path, required=True)
    prepare_parser.add_argument("--run-id")
    prepare_parser.add_argument("--source-commit", required=True)
    prepare_parser.add_argument("--desktop-version", required=True)
    prepare_parser.add_argument("--protocol-version", type=int, default=1)
    prepare_parser.add_argument("--desktop-url", required=True)
    prepare_parser.add_argument("--extension-url", required=True)
    prepare_parser.set_defaults(handler=prepare)

    inspect_parser = commands.add_parser("inspect-installed", help="verify production NM registration")
    inspect_parser.add_argument("--run-dir", type=Path, required=True)
    inspect_parser.add_argument("--browser", choices=("chrome", "edge"), required=True)
    inspect_parser.add_argument("--installed-exe", type=Path, required=True)
    inspect_parser.add_argument("--installer", type=Path, required=True)
    inspect_parser.add_argument("--extension-zip", type=Path, required=True)
    inspect_parser.set_defaults(handler=inspect_installed)

    smoke_parser = commands.add_parser("installed-smoke", help="exercise the installed host in real Chrome/Edge")
    smoke_parser.add_argument("--run-dir", type=Path, required=True)
    smoke_parser.add_argument("--browser", choices=("chrome", "edge"), required=True)
    smoke_parser.add_argument("--installed-exe", type=Path, required=True)
    smoke_parser.add_argument("--extension-dir", type=Path, required=True)
    smoke_parser.add_argument("--extension-zip", type=Path, required=True)
    smoke_parser.add_argument(
        "--browser-profile",
        type=Path,
        help="dedicated stable-Chrome profile with the candidate already loaded (required for chrome)",
    )
    smoke_parser.set_defaults(handler=installed_smoke)

    verify_parser = commands.add_parser("verify", help="check report integrity and optional completion")
    verify_parser.add_argument("--run-dir", type=Path, required=True)
    verify_parser.add_argument("--installer", type=Path, required=True)
    verify_parser.add_argument("--extension-zip", type=Path, required=True)
    verify_parser.add_argument("--require-complete", action="store_true")
    verify_parser.set_defaults(handler=verify)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except (AcceptanceError, OSError, json.JSONDecodeError, zipfile.BadZipFile) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
