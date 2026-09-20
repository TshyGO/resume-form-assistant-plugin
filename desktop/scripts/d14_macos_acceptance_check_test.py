import importlib.util
import json
import plistlib
import tempfile
import unittest
import zipfile
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("d14_macos_acceptance_check.py")
SPEC = importlib.util.spec_from_file_location("d14_macos_acceptance_check", SCRIPT)
MAC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MAC)


class MacAcceptanceCheckTests(unittest.TestCase):
    def write_extension_zip(self, path):
        expected = MAC.D14.CORE_EXTENSION_FILES | set(MAC.D14.read_json(MAC.D14.REVIEWED_ASSETS))
        manifest = json.loads((MAC.ROOT / "manifest.json").read_text(encoding="utf-8"))
        with zipfile.ZipFile(path, "w") as archive:
            for name in sorted(expected):
                content = json.dumps(manifest).encode() if name == "manifest.json" else b"safe"
                archive.writestr(name, content)

    def candidate_args(self, root):
        dmg = root / "Resume Pro Desktop_0.1.0_aarch64.dmg"
        extension = root / "resume-pro-v0.4.0.zip"
        dmg.write_bytes(b"synthetic-dmg-for-unit-test")
        self.write_extension_zip(extension)
        return Namespace(
            dmg=dmg,
            extension_zip=extension,
            output=root / "artifacts.json",
            source_commit="a" * 40,
            workflow_run_url="https://github.com/example/repo/actions/runs/1",
            desktop_version="0.1.0",
            extension_version="0.4.0",
            protocol_version=1,
            dmg_url="https://downloads.example.test/desktop.dmg",
            extension_url="https://downloads.example.test/extension.zip",
            unsigned_approval="owner approved in issue #1",
            registered_by="owner",
        )

    def dmg_details(self):
        return {
            "bundleIdentifier": "com.resumepro.desktop",
            "version": "0.1.0",
            "minimumSystemVersion": "11.0",
            "architecture": "arm64",
            "signatureStatus": "ADHOC_LINKER_SIGNED",
            "codesignVerifyStatus": "FAIL",
            "codesignVerifyDetail": "code has no resources but signature indicates they must be present",
        }

    def test_templates_are_pristine_and_platform_scoped(self):
        t4 = MAC.read_json(MAC.T4_TEMPLATE)
        t5 = MAC.read_json(MAC.T5_TEMPLATE)
        environment = MAC.read_json(MAC.ENVIRONMENT_TEMPLATE)
        self.assertEqual(MAC.validate_t4_report(t4, None, True), [])
        self.assertEqual(MAC.validate_t5_report(t5, True), [])
        self.assertEqual(MAC.validate_environment(environment, True), [])
        self.assertEqual(t4["overallD14Status"], "PARTIAL_PLATFORM_ACCEPTANCE")
        self.assertEqual(t4["windowsStatus"], "NOT_RUN")

    def test_init_run_creates_independent_browser_and_lifecycle_reports(self):
        with tempfile.TemporaryDirectory() as temp:
            run_dir = Path(temp) / "macos-rc1"
            MAC.init_run(Namespace(run_dir=run_dir, run_id="macos-rc1"))
            MAC.verify_scaffold(Namespace(run_dir=run_dir, require_pristine=True))
            chrome = MAC.read_json(run_dir / "chrome" / "report.json")
            edge = MAC.read_json(run_dir / "edge" / "report.json")
            lifecycle = MAC.read_json(run_dir / "lifecycle" / "report.json")
            self.assertEqual(chrome["browser"], "chrome")
            self.assertEqual(edge["browser"], "edge")
            self.assertEqual(len(lifecycle["checks"]), 17)
            self.assertTrue(all(case["status"] == "NOT_RUN" for case in chrome["cases"]))

    def test_init_run_refuses_to_overwrite_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            run_dir = Path(temp) / "existing"
            run_dir.mkdir()
            with self.assertRaisesRegex(MAC.MacAcceptanceError, "refusing to overwrite"):
                MAC.init_run(Namespace(run_dir=run_dir, run_id=None))

    def test_pass_requires_actual_and_evidence(self):
        report = MAC.read_json(MAC.T4_TEMPLATE)
        report["cases"][0]["status"] = "PASS"
        errors = MAC.validate_t4_report(report, None, False)
        self.assertIn("J01: PASS requires actual and non-empty evidence", errors)

    def test_macos_evidence_cannot_promote_windows_or_overall_status(self):
        report = MAC.read_json(MAC.T4_TEMPLATE)
        report["overallD14Status"] = "APPROVED"
        report["windowsStatus"] = "PASS"
        errors = MAC.validate_t4_report(report, None, False)
        self.assertIn("T4 macOS report: macOS evidence cannot mark overall D14 complete", errors)
        self.assertIn("T4 macOS report: Windows status must remain NOT_RUN", errors)

    def test_prepare_candidate_binds_exact_bytes_without_claiming_acceptance(self):
        with tempfile.TemporaryDirectory() as temp:
            args = self.candidate_args(Path(temp))
            with patch.object(MAC, "verify_dmg_integrity"), patch.object(
                MAC, "inspect_dmg_bundle", return_value=self.dmg_details()
            ):
                MAC.prepare_candidate(args)
            candidate = MAC.read_json(args.output)
            self.assertEqual(candidate["status"], "REGISTERED")
            self.assertEqual(candidate["desktop"]["sha256"], MAC.sha256_file(args.dmg))
            self.assertEqual(candidate["extension"]["extensionId"], MAC.D14.EXPECTED_EXTENSION_ID)
            self.assertEqual(candidate["desktop"]["signatureStatus"], "ADHOC_LINKER_SIGNED")
            self.assertEqual(candidate["desktop"]["codesignVerifyStatus"], "FAIL")
            self.assertEqual(candidate["review"]["decision"], "NOT_REVIEWED")
            self.assertEqual(MAC.validate_candidate(candidate, args.dmg, args.extension_zip), [])

    def test_prepare_candidate_rejects_overwrite_and_unstable_url(self):
        with tempfile.TemporaryDirectory() as temp:
            args = self.candidate_args(Path(temp))
            args.dmg_url = "https://downloads.example.test/desktop.dmg?token=secret"
            with self.assertRaisesRegex(MAC.MacAcceptanceError, "stable credential-free URL"):
                MAC.prepare_candidate(args)
            args.dmg_url = "https://downloads.example.test/desktop.dmg"
            args.output.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(MAC.MacAcceptanceError, "refusing to overwrite"):
                MAC.prepare_candidate(args)

    def test_candidate_byte_change_is_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            args = self.candidate_args(Path(temp))
            with patch.object(MAC, "verify_dmg_integrity"), patch.object(
                MAC, "inspect_dmg_bundle", return_value=self.dmg_details()
            ):
                MAC.prepare_candidate(args)
            candidate = MAC.read_json(args.output)
            args.dmg.write_bytes(b"changed")
            errors = MAC.validate_candidate(candidate, args.dmg, args.extension_zip)
            self.assertTrue(any("desktop.byteLength" in error for error in errors))
            self.assertTrue(any("desktop.sha256" in error for error in errors))

    def write_app(self, directory, name, version):
        info = directory / name / "Contents" / "Info.plist"
        info.parent.mkdir(parents=True)
        with info.open("wb") as stream:
            plistlib.dump({"CFBundleShortVersionString": version}, stream)

    def ready_commands(self, overrides=None):
        mapping = {
            ("uname", "-m"): (0, "arm64"),
            ("sysctl", "-n", "hw.model"): (0, "Mac17,3"),
            ("sysctl", "-n", "machdep.cpu.brand_string"): (0, "Apple M5"),
            ("sw_vers", "-productVersion"): (0, "15.0"),
            ("sw_vers", "-buildVersion"): (0, "24A335"),
            ("spctl", "--status"): (0, "assessments enabled"),
            ("csrutil", "status"): (0, "System Integrity Protection status: enabled."),
            ("id", "-Gn"): (0, "staff everyone localaccounts"),
            ("date", "+%Z"): (0, "CST"),
        }
        mapping.update(overrides or {})
        def run_command(argv):
            key = tuple(argv)
            if key not in mapping:
                raise AssertionError(f"unexpected command {argv}")
            return mapping[key]
        return run_command

    def collect_probe(self, home, apps, run_command, dedicated=True):
        return MAC.collect_host_probe(
            dedicated_test_account=dedicated,
            run_command=run_command,
            home=home,
            application_dirs=[apps],
            environ={"LANG": "zh_CN.UTF-8"},
        )

    def test_probe_host_ready_requires_isolated_standard_arm64_machine(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apps = root / "Applications"
            self.write_app(apps, "Google Chrome.app", "140.0.0.0")
            self.write_app(apps, "Microsoft Edge.app", "140.0.0.0")
            probe = self.collect_probe(root, apps, self.ready_commands())
            self.assertEqual(probe["verdict"], "READY")
            self.assertTrue(probe["suitableForOfficialEvidence"])
            self.assertEqual(probe["blockers"], [])
            self.assertEqual(probe["browsers"]["chrome"]["profileIsolation"], "NOT_VERIFIED")
            self.assertEqual(probe["windowsStatus"], "NOT_RUN")
            self.assertEqual(probe["overallD14Status"], "PARTIAL_PLATFORM_ACCEPTANCE")
            self.assertEqual(MAC.validate_host_probe(probe), [])

    def test_probe_host_blocks_disabled_gatekeeper_even_with_attestation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apps = root / "Applications"
            self.write_app(apps, "Google Chrome.app", "140.0.0.0")
            self.write_app(apps, "Microsoft Edge.app", "140.0.0.0")
            probe = self.collect_probe(
                root,
                apps,
                self.ready_commands({("spctl", "--status"): (1, "assessments disabled")}),
            )
            self.assertEqual(probe["verdict"], "BLOCKED")
            self.assertFalse(probe["suitableForOfficialEvidence"])
            self.assertTrue(any("assessments are disabled" in item for item in probe["blockers"]))

    def test_probe_host_blocks_admin_missing_chrome_and_missing_attestation(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apps = root / "Applications"
            self.write_app(apps, "Microsoft Edge.app", "140.0.0.0")
            probe = self.collect_probe(
                root,
                apps,
                self.ready_commands({("id", "-Gn"): (0, "staff admin _appserveradm")}),
                dedicated=False,
            )
            self.assertEqual(probe["verdict"], "BLOCKED")
            joined = " ".join(probe["blockers"])
            self.assertIn("Google Chrome is not installed", joined)
            self.assertIn("admin user", joined)
            self.assertIn("--dedicated-test-account", joined)
            self.assertNotIn("_appserveradm", joined)

    def test_probe_host_blocks_existing_archive_and_intel(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apps = root / "Applications"
            self.write_app(apps, "Google Chrome.app", "140.0.0.0")
            self.write_app(apps, "Microsoft Edge.app", "140.0.0.0")
            (root / "Library/Application Support/ResumePro").mkdir(parents=True)
            probe = self.collect_probe(
                root,
                apps,
                self.ready_commands({("uname", "-m"): (0, "x86_64")}),
            )
            joined = " ".join(probe["blockers"])
            self.assertIn("need arm64", joined)
            self.assertIn("existing ResumePro archive", joined)

    def test_probe_host_writes_blocked_result_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            output = root / "host-probe.json"
            with patch.object(
                MAC,
                "collect_host_probe",
                return_value={
                    "schemaVersion": 1,
                    "phase": "STEP0_HOST_PRECHECK",
                    "platform": "macos-arm64",
                    "buildTarget": "aarch64-apple-darwin",
                    "verdict": "BLOCKED",
                    "suitableForOfficialEvidence": False,
                    "gatekeeper": {"assessmentsEnabled": False},
                    "account": {"isAdmin": True, "isDedicatedTestAccount": False},
                    "browsers": {
                        "chrome": {"installed": False, "profileIsolation": "NOT_VERIFIED"},
                        "edge": {"installed": True, "profileIsolation": "NOT_VERIFIED"},
                    },
                    "existingData": {"archiveDirExists": False},
                    "blockers": ["Gatekeeper assessments are disabled"],
                    "overallD14Status": "PARTIAL_PLATFORM_ACCEPTANCE",
                    "windowsStatus": "NOT_RUN",
                },
            ):
                with self.assertRaisesRegex(MAC.MacAcceptanceError, "host is BLOCKED"):
                    MAC.probe_host(Namespace(output=output, dedicated_test_account=False))
            saved = MAC.read_json(output)
            self.assertEqual(saved["verdict"], "BLOCKED")
            self.assertFalse(saved["suitableForOfficialEvidence"])
            with patch.object(MAC, "collect_host_probe", return_value=saved):
                with self.assertRaisesRegex(MAC.MacAcceptanceError, "refusing to overwrite"):
                    MAC.probe_host(Namespace(output=output, dedicated_test_account=False))

    def test_probe_host_does_not_mark_acceptance_cases_pass(self):
        t4 = MAC.read_json(MAC.T4_TEMPLATE)
        t5 = MAC.read_json(MAC.T5_TEMPLATE)
        environment = MAC.read_json(MAC.ENVIRONMENT_TEMPLATE)
        self.assertTrue(all(entry["status"] == "NOT_RUN" for entry in t4["cases"]))
        self.assertTrue(all(entry["status"] == "NOT_RUN" for entry in t5["checks"]))
        self.assertEqual(environment["installation"]["gatekeeperExperience"], "NOT_RUN")


if __name__ == "__main__":
    unittest.main()
