import importlib.util
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("d14_acceptance_check.py")
SPEC = importlib.util.spec_from_file_location("d14_acceptance_check", SCRIPT)
D14 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(D14)


class D14AcceptanceCheckTests(unittest.TestCase):
    def test_store_key_resolves_to_fixed_extension_id(self):
        manifest = json.loads((D14.ROOT / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(D14.extension_id_from_key(manifest["key"]), D14.EXPECTED_EXTENSION_ID)

    def test_unsafe_zip_path_is_rejected(self):
        for value in ("../manifest.json", "/manifest.json", "folder\\manifest.json"):
            with self.subTest(value=value), self.assertRaises(D14.AcceptanceError):
                D14.safe_zip_name(value)

    def test_evidence_paths_do_not_persist_the_windows_username(self):
        with patch.dict(os.environ, {"LOCALAPPDATA": r"C:\Users\alice\AppData\Local"}):
            self.assertEqual(
                D14.evidence_path(Path(r"C:\Users\alice\AppData\Local\Resume Pro Desktop\app.exe")),
                r"%LOCALAPPDATA%\Resume Pro Desktop\app.exe",
            )

    def test_stable_chrome_profile_must_point_at_the_exact_candidate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            candidate = root / "candidate"
            candidate.mkdir()
            default = root / "profile" / "Default"
            default.mkdir(parents=True)
            D14.write_json(default / "Secure Preferences", {
                "extensions": {"settings": {D14.EXPECTED_EXTENSION_ID: {
                    "path": str(candidate),
                    "manifest": {"version": "0.4.0"},
                }}}
            })
            D14.assert_chrome_profile_has_candidate(root / "profile", candidate, "0.4.0")
            with self.assertRaises(D14.AcceptanceError):
                D14.assert_chrome_profile_has_candidate(root / "profile", candidate, "0.4.1")

    def test_extension_zip_requires_exact_reviewed_file_set(self):
        expected = D14.CORE_EXTENSION_FILES | set(D14.read_json(D14.REVIEWED_ASSETS))
        with tempfile.TemporaryDirectory() as temp:
            archive_path = Path(temp) / "extension.zip"
            manifest = json.loads((D14.ROOT / "manifest.json").read_text(encoding="utf-8"))
            with zipfile.ZipFile(archive_path, "w") as archive:
                for name in expected:
                    content = json.dumps(manifest).encode() if name == "manifest.json" else b"safe"
                    archive.writestr(name, content)
            details = D14.inspect_extension_zip(archive_path)
            self.assertEqual(details["extensionId"], D14.EXPECTED_EXTENSION_ID)
            self.assertEqual(details["fileCount"], len(expected))

            with zipfile.ZipFile(archive_path, "a") as archive:
                archive.writestr("tests/secret.txt", b"D14_SYNTHETIC_SECRET")
            with self.assertRaisesRegex(D14.AcceptanceError, "allowlist"):
                D14.inspect_extension_zip(archive_path)

    def test_pass_requires_evidence_and_complete_gate_requires_all_journeys(self):
        template = D14.read_json(D14.REPORT_TEMPLATE)
        template.update(
            testedSourceCommit="a" * 40,
            desktopVersion="0.1.0",
            extensionVersion="0.4.0",
            protocolVersion=1,
            desktopArtifact={"name": "setup.exe", "sha256": "a" * 64, "downloadUrl": "https://example.test/setup"},
            extensionArtifact={"name": "extension.zip", "sha256": "b" * 64, "downloadUrl": "https://example.test/zip"},
            environment={
                "osBuild": "Windows test", "architecture": "AMD64", "accountType": "standard-user",
                "timezone": "UTC", "browser": "chrome", "browserVersion": "1", "webview2Version": "1",
            },
        )
        template["t4Preflight"] = {"installedRegistration": "VERIFIED"}
        template["cases"][0]["status"] = "PASS"
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp) / "report.json"
            D14.write_json(report, template)
            errors = D14.verify_report(report, require_complete=False)
            self.assertIn("J01: PASS requires evidence", errors)
            complete = D14.verify_report(report, require_complete=True)
            self.assertTrue(any("J02: T4 completion requires PASS" in error for error in complete))
            self.assertIn("T4 completion requires review.decision=APPROVED", complete)

    def test_report_must_match_candidate_and_named_review(self):
        report = D14.read_json(D14.REPORT_TEMPLATE)
        candidate = {
            "fixtureVersion": "d14-v1",
            "testedSourceCommit": "a" * 40,
            "protocolVersion": 1,
            "desktop": {"name": "setup.exe", "sha256": "b" * 64, "downloadUrl": "https://example.test/setup"},
            "extension": {"name": "extension.zip", "sha256": "c" * 64, "downloadUrl": "https://example.test/zip"},
        }
        report.update(
            fixtureVersion=candidate["fixtureVersion"],
            testedSourceCommit=candidate["testedSourceCommit"],
            desktopVersion="0.1.0",
            extensionVersion="0.4.0",
            protocolVersion=candidate["protocolVersion"],
            desktopArtifact=dict(candidate["desktop"]),
            extensionArtifact=dict(candidate["extension"]),
            environment={
                "osBuild": "Windows test", "architecture": "AMD64", "accountType": "standard-user",
                "timezone": "UTC", "browser": "chrome", "browserVersion": "1", "webview2Version": "1",
            },
            review={
                "reviewer": "acceptance-owner", "reviewedAt": "2026-09-19T00:00:00Z",
                "decision": "APPROVED", "blockingDefects": [],
            },
        )
        report["t4Preflight"] = {"installedRegistration": "VERIFIED"}
        for case in report["cases"]:
            if case["id"] in D14.JOURNEYS:
                case.update(status="PASS", evidence=["evidence.json"])
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "report.json"
            D14.write_json(path, report)
            self.assertEqual(D14.verify_report(path, True, candidate), [])
            report["desktopArtifact"]["sha256"] = "d" * 64
            D14.write_json(path, report)
            self.assertIn(
                "desktopArtifact does not match artifacts.json",
                D14.verify_report(path, True, candidate),
            )


if __name__ == "__main__":
    unittest.main()
