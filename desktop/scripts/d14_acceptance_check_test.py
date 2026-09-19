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
            self.assertRegex(details["manifestSha256"], r"^[0-9a-f]{64}$")
            self.assertRegex(details["packageTreeSha256"], r"^[0-9a-f]{64}$")

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
            self.assertIn("J01: PASS requires non-empty evidence strings", errors)
            complete = D14.verify_report(report, require_complete=True)
            self.assertTrue(any("J02: completion requires PASS" in error for error in complete))
            self.assertIn("T4 completion requires review.decision=APPROVED", complete)

    def test_report_must_match_candidate_and_named_review(self):
        report = D14.read_json(D14.REPORT_TEMPLATE)
        candidate = {
            "fixtureVersion": "d14-v1",
            "buildTarget": "x86_64-pc-windows-msvc",
            "evidencePurpose": "RELEASE_CANDIDATE",
            "testedSourceCommit": "a" * 40,
            "desktopVersion": "0.1.0",
            "extensionVersion": "0.4.0",
            "protocolVersion": 1,
            "desktop": {
                "name": "setup.exe", "sha256": "b" * 64,
                "downloadUrl": "https://example.test/setup",
                "signatureStatus": "NotSigned", "signaturePolicy": "UNSIGNED_APPROVED",
            },
            "extension": {
                "name": "extension.zip", "sha256": "c" * 64,
                "downloadUrl": "https://example.test/zip",
                "manifestSha256": "d" * 64, "packageTreeSha256": "e" * 64,
            },
        }
        artifact_fields = ("name", "sha256", "downloadUrl")
        report.update(
            fixtureVersion=candidate["fixtureVersion"],
            buildTarget=candidate["buildTarget"],
            evidencePurpose=candidate["evidencePurpose"],
            testedSourceCommit=candidate["testedSourceCommit"],
            desktopVersion="0.1.0",
            extensionVersion="0.4.0",
            protocolVersion=candidate["protocolVersion"],
            completedAt="2026-09-19T01:00:00Z",
            desktopArtifact={key: candidate["desktop"][key] for key in artifact_fields},
            extensionArtifact={key: candidate["extension"][key] for key in artifact_fields},
            environment={
                "osBuild": "Windows test", "architecture": "AMD64", "accountType": "standard-user",
                "timezone": "UTC", "browser": "chrome", "browserVersion": "1", "webview2Version": "1",
            },
            review={
                "reviewer": "acceptance-owner", "reviewedAt": "2026-09-19T00:00:00Z",
                "decision": "APPROVED", "blockingDefects": [],
            },
        )
        report["t4Preflight"] = {
            "candidateVerified": True,
            "installedRegistration": "VERIFIED",
            "installedSmoke": {"status": "PASS"},
            "extensionManifestSha256": candidate["extension"]["manifestSha256"],
            "extensionPackageTreeSha256": candidate["extension"]["packageTreeSha256"],
            "desktopSignatureStatus": candidate["desktop"]["signatureStatus"],
            "desktopSignaturePolicy": candidate["desktop"]["signaturePolicy"],
        }
        report["dependencies"] = [
            {
                "issue": issue, "implementationPrs": [], "acceptanceEvidence": ["evidence"],
                "signedOff": True, "signedOffBy": "owner", "signedOffAt": "2026-09-19",
            }
            for issue in (22, 25, 29)
        ]
        for case in report["cases"]:
            if case["id"] in D14.REQUIRED_CASES:
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

    def test_signature_policy_rejects_ambiguous_or_mismatched_signatures(self):
        signed = {"status": "Valid", "signerSubject": "CN=Resume Pro", "signerThumbprint": "AB12"}
        self.assertEqual(
            D14.apply_signature_policy(signed, "ab 12", None)["policy"],
            "SIGNED",
        )
        with self.assertRaisesRegex(D14.AcceptanceError, "thumbprint"):
            D14.apply_signature_policy(signed, "FFFF", None)
        unsigned = {"status": "NotSigned", "signerSubject": None, "signerThumbprint": None}
        with self.assertRaisesRegex(D14.AcceptanceError, "unsigned-approval"):
            D14.apply_signature_policy(unsigned, None, None)
        self.assertEqual(
            D14.apply_signature_policy(unsigned, None, "owner approved")["policy"],
            "UNSIGNED_APPROVED",
        )

    def test_candidate_url_rejects_credentials_query_and_fragment(self):
        D14.validate_candidate_url("https://downloads.example.test/setup.exe", "desktop")
        for value in (
            "https://user:secret@example.test/setup.exe",
            "https://example.test/setup.exe?token=secret",
            "https://example.test/setup.exe#fragment",
        ):
            with self.subTest(value=value), self.assertRaises(D14.AcceptanceError):
                D14.validate_candidate_url(value, "desktop")

    def test_source_versions_are_derived_from_the_candidate_commit(self):
        blobs = {
            "desktop/src-tauri/tauri.conf.json": b'{"version":"0.1.0"}',
            "link/envelope.mjs": b"export const PROTOCOL_VERSION = 7;",
        }
        with patch.object(D14, "git_blob", side_effect=lambda _commit, name: blobs[name]):
            self.assertEqual(D14.source_candidate_versions("a" * 40), ("0.1.0", 7))

    def test_git_object_id_matches_the_standard_empty_blob(self):
        self.assertEqual(
            D14.git_object_id(b"", "sha1"),
            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
        )

    def test_complete_report_rejects_duplicate_case_blank_evidence_and_failed_smoke(self):
        report = D14.read_json(D14.REPORT_TEMPLATE)
        report["cases"].append(dict(report["cases"][0]))
        report["cases"][0].update(status="PASS", evidence=[""])
        report["t4Preflight"] = {"installedRegistration": "VERIFIED", "installedSmoke": {"status": "FAIL"}}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "report.json"
            D14.write_json(path, report)
            errors = D14.verify_report(path, True)
        self.assertTrue(any("duplicate case ids" in error for error in errors))
        self.assertTrue(any("non-empty evidence strings" in error for error in errors))
        self.assertIn("T4 completion requires installedSmoke.status=PASS", errors)

    def test_gnu_candidate_requires_diagnostic_mode_and_cannot_complete(self):
        report = D14.read_json(D14.REPORT_TEMPLATE)
        candidate = {
            "buildTarget": "x86_64-pc-windows-gnu",
            "evidencePurpose": "LOCAL_DIAGNOSTIC",
        }
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "report.json"
            D14.write_json(path, report)
            errors = D14.verify_report(path, True, candidate)
        self.assertIn("T4 completion requires an x86_64-pc-windows-msvc candidate", errors)


if __name__ == "__main__":
    unittest.main()
