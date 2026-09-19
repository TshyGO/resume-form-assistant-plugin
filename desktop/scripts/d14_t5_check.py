#!/usr/bin/env python3
"""Prepare and verify D14 T5 lifecycle evidence without claiming OS actions ran."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TEMPLATE = ROOT / "docs" / "desktop-mvp" / "acceptance" / "t5-report-template.json"
VALID_STATUSES = {"PASS", "FAIL", "BLOCKED", "NOT_RUN", "NOT_APPLICABLE"}
T4_CASES = [f"J{index:02d}" for index in range(1, 9)] + [
    f"F{index:02d}" for index in range(1, 14)
]


class T5Error(RuntimeError):
    pass


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


def non_empty_strings(value) -> bool:
    return isinstance(value, list) and bool(value) and all(
        isinstance(item, str) and bool(item.strip()) for item in value
    )


def artifact_binding(candidate: dict, kind: str) -> dict:
    return {key: candidate[kind].get(key) for key in ("name", "sha256", "downloadUrl")}


def validate_t4_baseline(report: dict) -> None:
    cases = report.get("cases") or []
    if [item.get("id") for item in cases] != T4_CASES:
        raise T5Error("T5 baseline must contain J01-J08 and F01-F13 exactly once in order")
    for item in cases:
        if item.get("status") != "PASS" or not non_empty_strings(item.get("evidence")):
            raise T5Error(f"T5 baseline {item.get('id')} is not PASS with evidence")
    if report.get("environment", {}).get("accountType") != "standard-user":
        raise T5Error("T5 baseline was not run as a standard user")
    preflight = report.get("t4Preflight") or {}
    if preflight.get("installedRegistration") != "VERIFIED":
        raise T5Error("T5 baseline production registration is not verified")
    if preflight.get("installedSmoke", {}).get("status") != "PASS":
        raise T5Error("T5 baseline installed smoke did not pass")


def prepare(args) -> None:
    run_dir = args.run_dir.resolve()
    if run_dir.exists():
        raise T5Error(f"refusing to overwrite T5 evidence: {run_dir}")
    candidate = read_json(args.candidate.resolve(strict=True))
    baseline_path = args.baseline_report.resolve(strict=True)
    baseline = read_json(baseline_path)
    if baseline.get("testedSourceCommit") != candidate.get("testedSourceCommit"):
        raise T5Error("T4 baseline and candidate source commit differ")
    if baseline.get("review", {}).get("decision") != "APPROVED":
        raise T5Error("T5 requires an approved T4 baseline report")
    if baseline.get("review", {}).get("blockingDefects"):
        raise T5Error("T4 baseline still has blocking defects")
    validate_t4_baseline(baseline)

    report = deepcopy(read_json(TEMPLATE))
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    report.update(
        runId=args.run_id or run_dir.name,
        buildTarget=candidate.get("buildTarget"),
        evidencePurpose=candidate.get("evidencePurpose"),
        fixtureVersion=candidate.get("fixtureVersion"),
        testedSourceCommit=candidate.get("testedSourceCommit"),
        desktopVersion=candidate.get("desktopVersion"),
        extensionVersion=candidate.get("extensionVersion"),
        protocolVersion=candidate.get("protocolVersion"),
        startedAt=now,
        desktopArtifact=artifact_binding(candidate, "desktop"),
        extensionArtifact=artifact_binding(candidate, "extension"),
        environment={
            key: baseline.get("environment", {}).get(key)
            for key in ("osBuild", "architecture", "accountType", "timezone", "webview2Version")
        },
        baselineT4Report=os.path.relpath(baseline_path, run_dir).replace("\\", "/"),
    )
    run_dir.mkdir(parents=True)
    write_json(run_dir / "report.json", report)
    print(f"prepared T5 NOT_RUN report: {run_dir / 'report.json'}")


def snapshot(args) -> None:
    root = args.root.resolve(strict=True)
    output = args.output.resolve()
    if output.exists():
        raise T5Error(f"refusing to overwrite snapshot evidence: {output}")
    files = []
    for path in sorted(root.rglob("*")):
        metadata = path.lstat()
        is_reparse = bool(
            getattr(metadata, "st_file_attributes", 0)
            & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        )
        if path.is_symlink() or is_reparse:
            raise T5Error(f"snapshot root contains a link/reparse point: {path}")
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if any(part.startswith(".tmp-") for part in Path(rel).parts):
            continue
        files.append({"path": rel, "byteLength": path.stat().st_size, "sha256": sha256_file(path)})
    evidence = {
        "schemaVersion": 1,
        "label": args.label,
        "capturedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "fileCount": len(files),
        "totalBytes": sum(item["byteLength"] for item in files),
        "files": files,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json(output, evidence)
    print(f"captured {len(files)} files without file contents: {output}")


def compare_snapshots(before: dict, after: dict, mode: str) -> dict:
    left = {item["path"]: (item["byteLength"], item["sha256"]) for item in before["files"]}
    right = {item["path"]: (item["byteLength"], item["sha256"]) for item in after["files"]}
    missing = sorted(left.keys() - right.keys())
    changed = sorted(path for path in left.keys() & right.keys() if left[path] != right[path])
    extra = sorted(right.keys() - left.keys())
    passed = not missing and not changed and (mode == "preserved" or not extra)
    return {
        "schemaVersion": 1,
        "mode": mode,
        "status": "PASS" if passed else "FAIL",
        "missing": missing,
        "changed": changed,
        "extra": extra,
    }


def compare(args) -> None:
    output = args.output.resolve()
    if output.exists():
        raise T5Error(f"refusing to overwrite comparison evidence: {output}")
    before = read_json(args.before.resolve(strict=True))
    after = read_json(args.after.resolve(strict=True))
    result = compare_snapshots(before, after, args.mode)
    result["before"] = str(args.before)
    result["after"] = str(args.after)
    output.parent.mkdir(parents=True, exist_ok=True)
    write_json(output, result)
    if result["status"] != "PASS":
        raise T5Error(
            "snapshot comparison failed: "
            f"missing={result['missing'][:5]}, changed={result['changed'][:5]}, extra={result['extra'][:5]}"
        )
    print(f"OK: {args.mode} snapshot comparison passed: {output}")


def verify_report(report: dict, candidate: dict, require_complete: bool) -> list[str]:
    errors = []
    expected_ids = [entry["id"] for entry in read_json(TEMPLATE)["checks"]]
    checks = report.get("checks") or []
    if [entry.get("id") for entry in checks] != expected_ids:
        errors.append("T5 check ids/order do not match the template")
    for check in checks:
        status = check.get("status")
        if status not in VALID_STATUSES:
            errors.append(f"{check.get('id')}: invalid status {status}")
        if status in {"PASS", "FAIL"} and not non_empty_strings(check.get("evidence")):
            errors.append(f"{check.get('id')}: {status} requires non-empty evidence strings")
        if status == "BLOCKED" and not check.get("defect"):
            errors.append(f"{check.get('id')}: BLOCKED requires a defect")
        if require_complete and status != "PASS":
            errors.append(f"{check.get('id')}: T5 completion requires PASS, found {status}")
    bindings = {
        "fixtureVersion": candidate.get("fixtureVersion"),
        "buildTarget": candidate.get("buildTarget"),
        "evidencePurpose": candidate.get("evidencePurpose"),
        "testedSourceCommit": candidate.get("testedSourceCommit"),
        "desktopVersion": candidate.get("desktopVersion"),
        "extensionVersion": candidate.get("extensionVersion"),
        "protocolVersion": candidate.get("protocolVersion"),
        "desktopArtifact": artifact_binding(candidate, "desktop"),
        "extensionArtifact": artifact_binding(candidate, "extension"),
    }
    for field, expected in bindings.items():
        if report.get(field) != expected:
            errors.append(f"{field} does not match the candidate")
    if not re.fullmatch(r"[0-9a-f]{40}", str(report.get("testedSourceCommit", ""))):
        errors.append("testedSourceCommit must be a full Git SHA")
    if require_complete:
        review = report.get("review") or {}
        if review.get("decision") != "APPROVED":
            errors.append("T5 completion requires review.decision=APPROVED")
        if not review.get("reviewer") or not review.get("reviewedAt"):
            errors.append("T5 completion requires named and dated review")
        if review.get("blockingDefects"):
            errors.append("T5 completion rejects blocking defects")
        if report.get("environment", {}).get("accountType") != "standard-user":
            errors.append("T5 completion requires environment.accountType=standard-user")
        if not report.get("completedAt"):
            errors.append("T5 completion requires completedAt")
    return errors


def verify(args) -> None:
    candidate = read_json(args.candidate.resolve(strict=True))
    report = read_json(args.report.resolve(strict=True))
    errors = verify_report(report, candidate, args.require_complete)
    if errors:
        raise T5Error("\n".join(errors))
    print("OK: T5 report satisfies the requested gate")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    commands = result.add_subparsers(dest="command", required=True)
    item = commands.add_parser("prepare")
    item.add_argument("--candidate", type=Path, required=True)
    item.add_argument("--baseline-report", type=Path, required=True)
    item.add_argument("--run-dir", type=Path, required=True)
    item.add_argument("--run-id")
    item.set_defaults(handler=prepare)
    item = commands.add_parser("snapshot")
    item.add_argument("--root", type=Path, required=True)
    item.add_argument("--output", type=Path, required=True)
    item.add_argument("--label", required=True)
    item.set_defaults(handler=snapshot)
    item = commands.add_parser("compare")
    item.add_argument("--before", type=Path, required=True)
    item.add_argument("--after", type=Path, required=True)
    item.add_argument("--output", type=Path, required=True)
    item.add_argument("--mode", choices=("equal", "preserved"), required=True)
    item.set_defaults(handler=compare)
    item = commands.add_parser("verify")
    item.add_argument("--candidate", type=Path, required=True)
    item.add_argument("--report", type=Path, required=True)
    item.add_argument("--require-complete", action="store_true")
    item.set_defaults(handler=verify)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except (T5Error, OSError, json.JSONDecodeError, KeyError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
