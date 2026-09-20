#!/usr/bin/env python3
"""Create and validate pristine D14 macOS acceptance evidence scaffolds."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import plistlib
import re
import subprocess
import sys
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ACCEPTANCE = ROOT / "docs" / "desktop-mvp" / "acceptance"
ENVIRONMENT_TEMPLATE = ACCEPTANCE / "macos-environment-template.json"
T4_TEMPLATE = ACCEPTANCE / "macos-report-template.json"
T5_TEMPLATE = ACCEPTANCE / "t5-macos-report-template.json"
CANDIDATE_TEMPLATE = ACCEPTANCE / "macos-candidate-template.json"
CASES = [f"J{index:02d}" for index in range(1, 9)] + [
    f"F{index:02d}" for index in range(1, 14)
]
VALID_STATUSES = {"PASS", "FAIL", "BLOCKED", "NOT_RUN", "NOT_APPLICABLE"}
PLATFORM = "macos-arm64"
BUILD_TARGET = "aarch64-apple-darwin"

D14_SCRIPT = Path(__file__).with_name("d14_acceptance_check.py")
D14_SPEC = importlib.util.spec_from_file_location("d14_acceptance_check_for_macos", D14_SCRIPT)
D14 = importlib.util.module_from_spec(D14_SPEC)
D14_SPEC.loader.exec_module(D14)


class MacAcceptanceError(RuntimeError):
    pass


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_https_url(value: str, label: str) -> None:
    try:
        D14.validate_candidate_url(value, label)
    except D14.AcceptanceError as error:
        raise MacAcceptanceError(str(error)) from error


def inspect_extension_zip(path: Path) -> dict:
    try:
        return D14.inspect_extension_zip(path)
    except (D14.AcceptanceError, json.JSONDecodeError) as error:
        raise MacAcceptanceError(str(error)) from error


def verify_dmg_integrity(path: Path) -> None:
    completed = subprocess.run(
        ["hdiutil", "verify", str(path)], capture_output=True, text=True, check=False
    )
    if completed.returncode != 0:
        details = (completed.stderr or completed.stdout).strip()
        raise MacAcceptanceError(f"DMG failed hdiutil verify: {details}")


def inspect_dmg_bundle(path: Path) -> dict:
    attached = subprocess.run(
        ["hdiutil", "attach", "-readonly", "-nobrowse", "-plist", str(path)],
        capture_output=True,
        check=False,
    )
    if attached.returncode != 0:
        raise MacAcceptanceError(
            "could not mount DMG read-only: "
            + attached.stderr.decode(errors="replace").strip()
        )
    mount_points: list[str] = []
    try:
        attach_info = plistlib.loads(attached.stdout)
        mount_points = [
            entity["mount-point"]
            for entity in attach_info.get("system-entities", [])
            if entity.get("mount-point")
        ]
        if len(mount_points) != 1:
            raise MacAcceptanceError("DMG must mount exactly one filesystem")
        mount = Path(mount_points[0])
        apps = sorted(mount.glob("*.app"))
        if len(apps) != 1:
            raise MacAcceptanceError("DMG must contain exactly one top-level .app")
        app = apps[0]
        info_path = app / "Contents" / "Info.plist"
        with info_path.open("rb") as stream:
            info = plistlib.load(stream)
        executable = app / "Contents" / "MacOS" / str(info.get("CFBundleExecutable") or "")
        if not executable.is_file():
            raise MacAcceptanceError("DMG app bundle is missing its declared executable")
        arch = subprocess.run(
            ["lipo", "-archs", str(executable)], capture_output=True, text=True, check=False
        )
        if arch.returncode != 0:
            raise MacAcceptanceError("could not inspect DMG executable architecture")
        architectures = arch.stdout.strip().split()
        signature = subprocess.run(
            ["codesign", "-dv", "--verbose=4", str(app)],
            capture_output=True,
            text=True,
            check=False,
        )
        signature_detail = "\n".join(
            part.strip() for part in (signature.stdout, signature.stderr) if part.strip()
        )
        if "Signature=adhoc" in signature_detail or "flags=0x20002(adhoc,linker-signed)" in signature_detail:
            signature_status = "ADHOC_LINKER_SIGNED"
        elif "Authority=" in signature_detail and "TeamIdentifier=not set" not in signature_detail:
            signature_status = "DEVELOPER_ID_SIGNED"
        elif "code object is not signed at all" in signature_detail:
            signature_status = "UNSIGNED"
        else:
            signature_status = "UNKNOWN"
        strict = subprocess.run(
            ["codesign", "--verify", "--deep", "--strict", "--verbose=4", str(app)],
            capture_output=True,
            text=True,
            check=False,
        )
        strict_detail = "\n".join(
            part.strip() for part in (strict.stdout, strict.stderr) if part.strip()
        )
        return {
            "bundleIdentifier": info.get("CFBundleIdentifier"),
            "version": info.get("CFBundleShortVersionString"),
            "minimumSystemVersion": info.get("LSMinimumSystemVersion"),
            "architecture": architectures[0] if architectures == ["arm64"] else " ".join(architectures),
            "signatureStatus": signature_status,
            "codesignVerifyStatus": "PASS" if strict.returncode == 0 else "FAIL",
            "codesignVerifyDetail": strict_detail or None,
        }
    finally:
        for mount_point in reversed(mount_points):
            detached = subprocess.run(
                ["hdiutil", "detach", mount_point], capture_output=True, text=True, check=False
            )
            if detached.returncode != 0:
                raise MacAcceptanceError(f"could not detach inspected DMG mount: {mount_point}")


def artifact_identity(path: Path) -> dict:
    return {
        "name": path.name,
        "byteLength": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def validate_candidate(candidate: dict, dmg: Path | None = None, extension_zip: Path | None = None) -> list[str]:
    errors: list[str] = []
    validate_platform(candidate, "macOS candidate", errors)
    if candidate.get("status") != "REGISTERED":
        errors.append("macOS candidate: status must be REGISTERED")
    if candidate.get("evidencePurpose") != "RELEASE_CANDIDATE":
        errors.append("macOS candidate: evidencePurpose must be RELEASE_CANDIDATE")
    if not re.fullmatch(r"[0-9a-f]{40}", str(candidate.get("testedSourceCommit") or "")):
        errors.append("macOS candidate: testedSourceCommit must be a full lowercase SHA-1")
    for key in ("workflowRunUrl",):
        try:
            validate_https_url(candidate.get(key), key)
        except (MacAcceptanceError, TypeError):
            errors.append(f"macOS candidate: {key} must be a stable HTTPS URL")
    for kind in ("desktop", "extension"):
        artifact = candidate.get(kind) or {}
        for key in ("name", "byteLength", "sha256", "downloadUrl"):
            if artifact.get(key) in (None, ""):
                errors.append(f"macOS candidate: {kind}.{key} is required")
        if not re.fullmatch(r"[0-9a-f]{64}", str(artifact.get("sha256") or "")):
            errors.append(f"macOS candidate: {kind}.sha256 must be lowercase SHA-256")
        try:
            validate_https_url(artifact.get("downloadUrl"), f"{kind}-url")
        except (MacAcceptanceError, TypeError):
            errors.append(f"macOS candidate: {kind}.downloadUrl must be stable HTTPS")
    desktop = candidate.get("desktop") or {}
    extension = candidate.get("extension") or {}
    if desktop.get("distributionFormat") != "dmg" or not str(desktop.get("name") or "").endswith(".dmg"):
        errors.append("macOS candidate: desktop artifact must be a DMG")
    if desktop.get("signatureStatus") not in {"UNSIGNED", "ADHOC_LINKER_SIGNED"}:
        errors.append("macOS candidate: current unsigned policy permits only UNSIGNED or ADHOC_LINKER_SIGNED")
    if desktop.get("notarizationStatus") != "NOT_NOTARIZED":
        errors.append("macOS candidate: current policy requires explicit NOT_NOTARIZED status")
    if desktop.get("bundleIdentifier") != "com.resumepro.desktop":
        errors.append("macOS candidate: desktop bundleIdentifier must be com.resumepro.desktop")
    if desktop.get("architecture") != "arm64":
        errors.append("macOS candidate: desktop architecture must be arm64")
    if desktop.get("minimumSystemVersion") != "11.0":
        errors.append("macOS candidate: minimumSystemVersion must match the declared 11.0")
    if not str(desktop.get("unsignedApproval") or "").strip():
        errors.append("macOS candidate: unsignedApproval is required")
    if extension.get("distributionFormat") != "zip" or not str(extension.get("name") or "").endswith(".zip"):
        errors.append("macOS candidate: extension artifact must be a ZIP")
    if extension.get("extensionId") != D14.EXPECTED_EXTENSION_ID:
        errors.append("macOS candidate: extensionId does not match the fixed manifest key")
    if dmg is not None and desktop:
        actual = artifact_identity(dmg)
        for key, value in actual.items():
            if desktop.get(key) != value:
                errors.append(f"macOS candidate: desktop.{key} does not match the supplied DMG")
    if extension_zip is not None and extension:
        actual = artifact_identity(extension_zip)
        for key, value in actual.items():
            if extension.get(key) != value:
                errors.append(f"macOS candidate: extension.{key} does not match the supplied ZIP")
        try:
            details = inspect_extension_zip(extension_zip)
            for key in ("extensionId", "fileCount", "manifestSha256", "packageTreeSha256"):
                if extension.get(key) != details.get(key):
                    errors.append(f"macOS candidate: extension.{key} does not match ZIP contents")
        except MacAcceptanceError as error:
            errors.append(str(error))
    return errors


def validate_platform(value: dict, label: str, errors: list[str]) -> None:
    if value.get("platform") != PLATFORM:
        errors.append(f"{label}: platform must be {PLATFORM}")
    if value.get("buildTarget") != BUILD_TARGET:
        errors.append(f"{label}: buildTarget must be {BUILD_TARGET}")
    if value.get("overallD14Status") not in (None, "PARTIAL_PLATFORM_ACCEPTANCE"):
        errors.append(f"{label}: macOS evidence cannot mark overall D14 complete")
    if value.get("windowsStatus") not in (None, "NOT_RUN"):
        errors.append(f"{label}: Windows status must remain NOT_RUN")


def validate_t4_report(report: dict, browser: str | None, pristine: bool) -> list[str]:
    errors: list[str] = []
    validate_platform(report, "T4 macOS report", errors)
    if report.get("phase") != "T4_MACOS":
        errors.append("T4 macOS report: phase must be T4_MACOS")
    if browser is not None and report.get("browser") != browser:
        errors.append(f"T4 macOS report: browser must be {browser}")
    cases = report.get("cases") or []
    ids = [entry.get("id") for entry in cases]
    if ids != CASES:
        errors.append("T4 macOS report must contain J01-J08 and F01-F13 exactly once in order")
    for entry in cases:
        status = entry.get("status")
        if status not in VALID_STATUSES:
            errors.append(f"{entry.get('id')}: invalid status {status}")
        if status == "PASS" and not (
            isinstance(entry.get("actual"), str)
            and entry["actual"].strip()
            and isinstance(entry.get("evidence"), list)
            and entry["evidence"]
            and all(isinstance(item, str) and item.strip() for item in entry["evidence"])
        ):
            errors.append(f"{entry.get('id')}: PASS requires actual and non-empty evidence")
        if pristine and (status != "NOT_RUN" or entry.get("evidence") != []):
            errors.append(f"{entry.get('id')}: pristine scaffold must remain NOT_RUN without evidence")
    if pristine and report.get("review", {}).get("decision") != "NOT_REVIEWED":
        errors.append("T4 macOS pristine scaffold must remain NOT_REVIEWED")
    return errors


def validate_t5_report(report: dict, pristine: bool) -> list[str]:
    errors: list[str] = []
    validate_platform(report, "T5 macOS report", errors)
    if report.get("phase") != "T5_MACOS":
        errors.append("T5 macOS report: phase must be T5_MACOS")
    checks = report.get("checks") or []
    ids = [entry.get("id") for entry in checks]
    if len(ids) != 17 or len(set(ids)) != 17:
        errors.append("T5 macOS report must contain 17 unique lifecycle checks")
    for entry in checks:
        status = entry.get("status")
        if status not in VALID_STATUSES:
            errors.append(f"{entry.get('id')}: invalid status {status}")
        case_ids = entry.get("caseIds") or []
        if not case_ids or any(case_id not in CASES for case_id in case_ids):
            errors.append(f"{entry.get('id')}: caseIds must reference the D14 catalog")
        if status == "PASS" and not (
            isinstance(entry.get("evidence"), list)
            and entry["evidence"]
            and all(isinstance(item, str) and item.strip() for item in entry["evidence"])
        ):
            errors.append(f"{entry.get('id')}: PASS requires non-empty evidence")
        if pristine and (status != "NOT_RUN" or entry.get("evidence") != []):
            errors.append(f"{entry.get('id')}: pristine scaffold must remain NOT_RUN without evidence")
    if pristine and report.get("review", {}).get("decision") != "NOT_REVIEWED":
        errors.append("T5 macOS pristine scaffold must remain NOT_REVIEWED")
    return errors


def validate_environment(environment: dict, pristine: bool) -> list[str]:
    errors: list[str] = []
    validate_platform(environment, "macOS environment", errors)
    if environment.get("hardware", {}).get("architecture") != "arm64":
        errors.append("macOS environment: hardware.architecture must be arm64")
    if environment.get("account", {}).get("type") != "standard-user":
        errors.append("macOS environment: account.type must be standard-user")
    if environment.get("installation", {}).get("bundleIdentifier") != "com.resumepro.desktop":
        errors.append("macOS environment: unexpected bundle identifier")
    if pristine:
        if environment.get("installation", {}).get("gatekeeperExperience") != "NOT_RUN":
            errors.append("macOS pristine environment must not claim Gatekeeper ran")
        if environment.get("nativeMessaging", {}).get("installedRegistration") != "NOT_VERIFIED":
            errors.append("macOS pristine environment must not claim registration verification")
    return errors


def init_run(args) -> None:
    run_dir = args.run_dir.resolve()
    if run_dir.exists():
        raise MacAcceptanceError(f"refusing to overwrite macOS evidence: {run_dir}")
    run_id = args.run_id or run_dir.name
    timestamp = now_utc()
    environment = deepcopy(read_json(ENVIRONMENT_TEMPLATE))
    environment["capturedAt"] = timestamp
    t4_template = read_json(T4_TEMPLATE)
    t5_report = deepcopy(read_json(T5_TEMPLATE))
    t5_report.update(runId=run_id, startedAt=timestamp, environmentRef="../macos-environment.json")
    t5_report["baselineT4Reports"] = {
        "chrome": "../chrome/report.json",
        "edge": "../edge/report.json",
    }

    for directory in (run_dir / "chrome", run_dir / "edge", run_dir / "lifecycle"):
        directory.mkdir(parents=True, exist_ok=False)
    write_json(run_dir / "macos-environment.json", environment)
    for browser in ("chrome", "edge"):
        report = deepcopy(t4_template)
        report.update(
            runId=run_id,
            browser=browser,
            startedAt=timestamp,
            environmentRef="../macos-environment.json",
        )
        write_json(run_dir / browser / "report.json", report)
    write_json(run_dir / "lifecycle" / "report.json", t5_report)
    print(f"prepared pristine macOS acceptance scaffold: {run_dir}")


def prepare_candidate(args) -> None:
    dmg = args.dmg.resolve(strict=True)
    extension_zip = args.extension_zip.resolve(strict=True)
    output = args.output.resolve()
    if output.exists():
        raise MacAcceptanceError(f"refusing to overwrite macOS candidate evidence: {output}")
    if dmg.suffix.lower() != ".dmg":
        raise MacAcceptanceError("--dmg must point to a .dmg file")
    if extension_zip.suffix.lower() != ".zip":
        raise MacAcceptanceError("--extension-zip must point to a .zip file")
    if not re.fullmatch(r"[0-9a-f]{40}", args.source_commit):
        raise MacAcceptanceError("--source-commit must be a full lowercase 40-character SHA-1")
    for value, label in (
        (args.workflow_run_url, "workflow-run-url"),
        (args.dmg_url, "desktop-url"),
        (args.extension_url, "extension-url"),
    ):
        validate_https_url(value, label)
    verify_dmg_integrity(dmg)
    dmg_details = inspect_dmg_bundle(dmg)
    if dmg_details.get("version") != args.desktop_version:
        raise MacAcceptanceError(
            f"DMG app version is {dmg_details.get('version')}, expected {args.desktop_version}"
        )
    extension_details = inspect_extension_zip(extension_zip)
    if extension_details.get("version") != args.extension_version:
        raise MacAcceptanceError(
            f"extension ZIP version is {extension_details.get('version')}, expected {args.extension_version}"
        )

    candidate = deepcopy(read_json(CANDIDATE_TEMPLATE))
    candidate.update(
        status="REGISTERED",
        testedSourceCommit=args.source_commit,
        workflowRunUrl=args.workflow_run_url,
        desktopVersion=args.desktop_version,
        extensionVersion=args.extension_version,
        protocolVersion=args.protocol_version,
        registeredBy=args.registered_by,
        registeredAt=now_utc(),
    )
    candidate["desktop"].update(
        **artifact_identity(dmg),
        **{key: value for key, value in dmg_details.items() if key != "version"},
        downloadUrl=args.dmg_url,
        notarizationStatus="NOT_NOTARIZED",
        unsignedApproval=args.unsigned_approval,
    )
    candidate["extension"].update(
        **artifact_identity(extension_zip),
        downloadUrl=args.extension_url,
        extensionId=extension_details["extensionId"],
        manifestSha256=extension_details["manifestSha256"],
        packageTreeSha256=extension_details["packageTreeSha256"],
        fileCount=extension_details["fileCount"],
    )
    errors = validate_candidate(candidate, dmg, extension_zip)
    if errors:
        raise MacAcceptanceError("\n".join(errors))
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json(output, candidate)
    print(f"registered macOS candidate without claiming installation acceptance: {output}")


def verify_candidate(args) -> None:
    candidate_path = args.candidate.resolve(strict=True)
    dmg = args.dmg.resolve(strict=True)
    extension_zip = args.extension_zip.resolve(strict=True)
    verify_dmg_integrity(dmg)
    errors = validate_candidate(read_json(candidate_path), dmg, extension_zip)
    if errors:
        raise MacAcceptanceError("\n".join(errors))
    print(f"macOS candidate bytes and manifest match: {candidate_path}")


def verify_scaffold(args) -> None:
    run_dir = args.run_dir.resolve(strict=True)
    errors = validate_environment(read_json(run_dir / "macos-environment.json"), args.require_pristine)
    for browser in ("chrome", "edge"):
        errors.extend(
            validate_t4_report(
                read_json(run_dir / browser / "report.json"), browser, args.require_pristine
            )
        )
    errors.extend(
        validate_t5_report(read_json(run_dir / "lifecycle" / "report.json"), args.require_pristine)
    )
    if errors:
        raise MacAcceptanceError("\n".join(errors))
    print(f"macOS acceptance scaffold is valid: {run_dir}")


CHROME_APP_NAME = "Google Chrome.app"
EDGE_APP_NAME = "Microsoft Edge.app"
ARCHIVE_REL = Path("Library/Application Support/ResumePro")
CHROME_NM_REL = Path(
    "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.resumepro.desktop.json"
)
EDGE_NM_REL = Path(
    "Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.resumepro.desktop.json"
)
PROBE_NOTES = [
    "This probe does not install a DMG, write Native Messaging manifests, or mark J/F cases PASS.",
    "Gatekeeper first-launch still requires a later T4 install on a machine with assessments enabled.",
]


def default_run_command(argv: list[str]) -> tuple[int, str]:
    completed = subprocess.run(argv, capture_output=True, text=True, check=False)
    streamed = completed.stdout if (completed.stdout or "").strip() else completed.stderr
    return completed.returncode, streamed or ""


def version_tuple(value: str) -> tuple[int, ...]:
    parts: list[int] = []
    for item in str(value).split("."):
        if not item.isdigit():
            break
        parts.append(int(item))
    return tuple(parts) or (0,)


def find_app(name: str, application_dirs: list[Path]) -> Path | None:
    for directory in application_dirs:
        candidate = directory / name
        if (candidate / "Contents" / "Info.plist").is_file():
            return candidate
    return None


def read_app_version(app: Path | None) -> str | None:
    if app is None:
        return None
    info_path = app / "Contents" / "Info.plist"
    if not info_path.is_file():
        return None
    with info_path.open("rb") as stream:
        info = plistlib.load(stream)
    version = str(info.get("CFBundleShortVersionString") or "").strip()
    return version or None


def inspect_browser(name: str, application_dirs: list[Path]) -> dict:
    app = find_app(name, application_dirs)
    return {
        "installed": app is not None,
        "path": str(app) if app is not None else None,
        "version": read_app_version(app),
        "profileIsolation": "NOT_VERIFIED",
    }


def collect_host_probe(
    *,
    dedicated_test_account: bool,
    run_command=default_run_command,
    home: Path | None = None,
    application_dirs: list[Path] | None = None,
    environ: dict | None = None,
) -> dict:
    home = home or Path.home()
    application_dirs = application_dirs or [Path("/Applications"), home / "Applications"]
    environ = environ if environ is not None else dict(os.environ)

    def text(argv: list[str]) -> str:
        _code, output = run_command(argv)
        return (output or "").strip()

    architecture = text(["uname", "-m"])
    model = text(["sysctl", "-n", "hw.model"])
    chip = text(["sysctl", "-n", "machdep.cpu.brand_string"])
    product_version = text(["sw_vers", "-productVersion"])
    build_version = text(["sw_vers", "-buildVersion"])
    spctl_status = text(["spctl", "--status"])
    sip_status = text(["csrutil", "status"])
    groups = text(["id", "-Gn"]).split()
    timezone = text(["date", "+%Z"])
    locale = str(environ.get("LANG") or "").strip() or None
    assessments_enabled = spctl_status == "assessments enabled"
    is_admin = "admin" in groups
    chrome = inspect_browser(CHROME_APP_NAME, application_dirs)
    edge = inspect_browser(EDGE_APP_NAME, application_dirs)
    archive_exists = (home / ARCHIVE_REL).exists()
    chrome_nm_exists = (home / CHROME_NM_REL).is_file()
    edge_nm_exists = (home / EDGE_NM_REL).is_file()

    blockers: list[str] = []
    warnings: list[str] = []
    if architecture != "arm64":
        blockers.append(f"hardware.architecture is {architecture or 'unknown'}, need arm64")
    if not assessments_enabled:
        blockers.append(
            "Gatekeeper assessments are disabled; this Mac cannot produce official T4/T5 evidence"
        )
    if version_tuple(product_version) < (11, 0):
        blockers.append(f"macOS {product_version or 'unknown'} is below the declared 11.0 minimum")
    if not chrome["installed"]:
        blockers.append("Google Chrome is not installed")
    if not edge["installed"]:
        blockers.append("Microsoft Edge is not installed")
    if is_admin:
        blockers.append("current account is an admin user; official evidence needs a standard user")
    if not dedicated_test_account:
        blockers.append(
            "operator did not attest --dedicated-test-account (isolated profile, d14-v1 only)"
        )
    if archive_exists:
        blockers.append(
            "existing ResumePro archive found; official evidence needs a clean test account"
        )
    if chrome_nm_exists or edge_nm_exists:
        warnings.append(
            "Native Messaging manifests already exist; T4 must still verify production registration"
        )
    if sip_status and "enabled" not in sip_status.lower():
        warnings.append(f"SIP status is not enabled: {sip_status}")

    ready = not blockers
    probe = {
        "schemaVersion": 1,
        "phase": "STEP0_HOST_PRECHECK",
        "platform": PLATFORM,
        "buildTarget": BUILD_TARGET,
        "capturedAt": now_utc(),
        "verdict": "READY" if ready else "BLOCKED",
        "suitableForOfficialEvidence": ready,
        "hardware": {
            "modelIdentifier": model or None,
            "chip": chip or None,
            "architecture": architecture or None,
        },
        "operatingSystem": {
            "productVersion": product_version or None,
            "buildVersion": build_version or None,
            "declaredMinimumVersion": "11.0",
            "sipStatus": sip_status or None,
        },
        "gatekeeper": {
            "spctlStatus": spctl_status or None,
            "assessmentsEnabled": assessments_enabled,
        },
        "account": {
            "type": "admin" if is_admin else "standard-user",
            "isAdmin": is_admin,
            "isDedicatedTestAccount": dedicated_test_account,
            "timezone": timezone or None,
            "locale": locale,
        },
        "browsers": {"chrome": chrome, "edge": edge},
        "existingData": {
            "archiveDirExists": archive_exists,
            "chromeNativeMessagingExists": chrome_nm_exists,
            "edgeNativeMessagingExists": edge_nm_exists,
        },
        "blockers": blockers,
        "warnings": warnings,
        "notes": list(PROBE_NOTES),
        "overallD14Status": "PARTIAL_PLATFORM_ACCEPTANCE",
        "windowsStatus": "NOT_RUN",
    }
    errors = validate_host_probe(probe)
    if errors:
        raise MacAcceptanceError("\n".join(errors))
    return probe


def validate_host_probe(probe: dict) -> list[str]:
    errors: list[str] = []
    validate_platform(probe, "macOS host probe", errors)
    if probe.get("phase") != "STEP0_HOST_PRECHECK":
        errors.append("macOS host probe: phase must be STEP0_HOST_PRECHECK")
    if probe.get("verdict") not in {"READY", "BLOCKED"}:
        errors.append("macOS host probe: verdict must be READY or BLOCKED")
    blockers = probe.get("blockers") or []
    if probe.get("verdict") == "READY":
        if blockers:
            errors.append("macOS host probe: READY cannot keep blockers")
        if probe.get("suitableForOfficialEvidence") is not True:
            errors.append("macOS host probe: READY must set suitableForOfficialEvidence")
        if probe.get("gatekeeper", {}).get("assessmentsEnabled") is not True:
            errors.append("macOS host probe: READY requires assessments enabled")
        if probe.get("account", {}).get("isDedicatedTestAccount") is not True:
            errors.append("macOS host probe: READY requires a dedicated test account attestation")
        if probe.get("account", {}).get("isAdmin") is not False:
            errors.append("macOS host probe: READY requires a standard user")
        if probe.get("existingData", {}).get("archiveDirExists"):
            errors.append("macOS host probe: READY cannot reuse an existing archive")
        browsers = probe.get("browsers") or {}
        if not browsers.get("chrome", {}).get("installed") or not browsers.get("edge", {}).get(
            "installed"
        ):
            errors.append("macOS host probe: READY requires Chrome and Edge")
    elif probe.get("suitableForOfficialEvidence"):
        errors.append("macOS host probe: BLOCKED cannot claim suitableForOfficialEvidence")
    if probe.get("browsers", {}).get("chrome", {}).get("profileIsolation") != "NOT_VERIFIED":
        errors.append("macOS host probe must not claim browser profile isolation")
    if probe.get("browsers", {}).get("edge", {}).get("profileIsolation") != "NOT_VERIFIED":
        errors.append("macOS host probe must not claim browser profile isolation")
    return errors


def probe_host(args) -> None:
    probe = collect_host_probe(dedicated_test_account=args.dedicated_test_account)
    if args.output is not None:
        output = args.output.resolve()
        if output.exists():
            raise MacAcceptanceError(f"refusing to overwrite host probe: {output}")
        output.parent.mkdir(parents=True, exist_ok=True)
        write_json(output, probe)
        print(f"wrote macOS host precheck: {output}", flush=True)
    else:
        print(json.dumps(probe, ensure_ascii=False, indent=2))
        print()
    if probe["verdict"] != "READY":
        raise MacAcceptanceError(
            "host is BLOCKED for official T4/T5 evidence:\n- " + "\n- ".join(probe["blockers"])
        )
    print("host is READY for official macOS T4/T5 evidence collection")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init-run", help="create an empty macOS evidence scaffold")
    init.add_argument("--run-dir", type=Path, required=True)
    init.add_argument("--run-id")
    init.set_defaults(func=init_run)
    verify = commands.add_parser("verify-scaffold", help="validate a macOS evidence scaffold")
    verify.add_argument("--run-dir", type=Path, required=True)
    verify.add_argument("--require-pristine", action="store_true")
    verify.set_defaults(func=verify_scaffold)
    prepare_candidate_parser = commands.add_parser(
        "prepare-candidate", help="bind exact macOS DMG and extension ZIP bytes"
    )
    prepare_candidate_parser.add_argument("--dmg", type=Path, required=True)
    prepare_candidate_parser.add_argument("--extension-zip", type=Path, required=True)
    prepare_candidate_parser.add_argument("--output", type=Path, required=True)
    prepare_candidate_parser.add_argument("--source-commit", required=True)
    prepare_candidate_parser.add_argument("--workflow-run-url", required=True)
    prepare_candidate_parser.add_argument("--desktop-version", required=True)
    prepare_candidate_parser.add_argument("--extension-version", required=True)
    prepare_candidate_parser.add_argument("--protocol-version", type=int, required=True)
    prepare_candidate_parser.add_argument("--dmg-url", required=True)
    prepare_candidate_parser.add_argument("--extension-url", required=True)
    prepare_candidate_parser.add_argument("--unsigned-approval", required=True)
    prepare_candidate_parser.add_argument("--registered-by", required=True)
    prepare_candidate_parser.set_defaults(func=prepare_candidate)
    verify_candidate_parser = commands.add_parser(
        "verify-candidate", help="recompute and compare registered macOS candidate bytes"
    )
    verify_candidate_parser.add_argument("--candidate", type=Path, required=True)
    verify_candidate_parser.add_argument("--dmg", type=Path, required=True)
    verify_candidate_parser.add_argument("--extension-zip", type=Path, required=True)
    verify_candidate_parser.set_defaults(func=verify_candidate)
    probe = commands.add_parser(
        "probe-host",
        help="check whether this Mac can produce official T4/T5 evidence",
    )
    probe.add_argument("--output", type=Path)
    probe.add_argument(
        "--dedicated-test-account",
        action="store_true",
        help="attest this is an isolated test account using only d14-v1 synthetic data",
    )
    probe.set_defaults(func=probe_host)
    return parser


def main() -> int:
    try:
        args = build_parser().parse_args()
        args.func(args)
        return 0
    except (MacAcceptanceError, FileNotFoundError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
