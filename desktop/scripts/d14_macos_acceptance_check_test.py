import importlib.util
import json
import plistlib
import tempfile
import unittest
import zipfile
from argparse import Namespace
from copy import deepcopy
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
        # The synthetic ZIP carries the repository manifest, so expect whatever version it says.
        plugin_version = json.loads((MAC.ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
        dmg = root / "Resume.Pro.Desktop_0.4.0-beta.3_aarch64.dmg"
        extension = root / f"resume-pro-v{plugin_version}.zip"
        dmg.write_bytes(b"synthetic-dmg-for-unit-test")
        self.write_extension_zip(extension)
        return Namespace(
            dmg=dmg,
            extension_zip=extension,
            output=root / "artifacts.json",
            source_commit="a" * 40,
            workflow_run_url="https://github.com/example/repo/actions/runs/1",
            desktop_version="0.4.0-beta.3",
            extension_version=plugin_version,
            protocol_version=1,
            dmg_url="https://downloads.example.test/desktop.dmg",
            extension_url="https://downloads.example.test/extension.zip",
            unsigned_approval="owner approved in issue #1",
            registered_by="owner",
        )

    def dmg_details(self):
        return {
            "bundleIdentifier": "com.resumepro.desktop",
            "version": "0.4.0-beta.3",
            "minimumSystemVersion": "11.0",
            "architecture": "arm64",
            "signatureStatus": "ADHOC_SIGNED",
            "codesignVerifyStatus": "PASS",
            "codesignVerifyDetail": "valid on disk; satisfies its Designated Requirement",
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
            self.assertEqual([item["id"] for item in lifecycle["checks"]], MAC.T5_CHECKS)
            self.assertTrue(all(case["status"] == "NOT_RUN" for case in chrome["cases"]))

    def test_init_run_refuses_to_overwrite_evidence(self):
        with tempfile.TemporaryDirectory() as temp:
            run_dir = Path(temp) / "existing"
            run_dir.mkdir()
            (run_dir / "artifacts.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(MAC.MacAcceptanceError, "refusing to overwrite"):
                MAC.init_run(Namespace(run_dir=run_dir, run_id=None))

    def test_init_run_reuses_directory_that_only_has_host_probe(self):
        with tempfile.TemporaryDirectory() as temp:
            run_dir = Path(temp) / "macos-rc1"
            run_dir.mkdir()
            (run_dir / "host-probe.json").write_text("{}", encoding="utf-8")
            MAC.init_run(Namespace(run_dir=run_dir, run_id="macos-rc1"))
            self.assertTrue((run_dir / "host-probe.json").is_file())
            self.assertTrue((run_dir / "chrome" / "report.json").is_file())
            self.assertTrue((run_dir / "lifecycle" / "report.json").is_file())

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
            self.assertEqual(candidate["desktop"]["signatureStatus"], "ADHOC_SIGNED")
            self.assertEqual(candidate["desktop"]["codesignVerifyStatus"], "PASS")
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

    def test_candidate_rejects_old_linker_only_signature(self):
        with tempfile.TemporaryDirectory() as temp:
            args = self.candidate_args(Path(temp))
            details = self.dmg_details()
            details.update(
                signatureStatus="ADHOC_LINKER_SIGNED",
                codesignVerifyStatus="FAIL",
                codesignVerifyDetail="code has no resources but signature indicates they must be present",
            )
            with patch.object(MAC, "verify_dmg_integrity"), patch.object(
                MAC, "inspect_dmg_bundle", return_value=details
            ):
                with self.assertRaisesRegex(MAC.MacAcceptanceError, "complete ADHOC_SIGNED"):
                    MAC.prepare_candidate(args)

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
            ("ps", "-axo", "comm="): (0, "launchd\nFinder\n"),
        }
        mapping.update(overrides or {})
        def run_command(argv):
            key = tuple(argv)
            if key not in mapping:
                raise AssertionError(f"unexpected command {argv}")
            return mapping[key]
        return run_command

    def collect_probe(self, home, apps, run_command):
        return MAC.collect_host_probe(
            run_command=run_command,
            home=home,
            application_dirs=[apps],
            environ={"LANG": "zh_CN.UTF-8"},
        )

    def test_probe_host_ready_allows_current_admin_on_clean_arm64_machine(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apps = root / "Applications"
            self.write_app(apps, "Google Chrome.app", "140.0.0.0")
            self.write_app(apps, "Microsoft Edge.app", "140.0.0.0")
            probe = self.collect_probe(
                root,
                apps,
                self.ready_commands({("id", "-Gn"): (0, "staff admin _appserveradm")}),
            )
            self.assertEqual(probe["verdict"], "READY")
            self.assertTrue(probe["suitableForOfficialEvidence"])
            self.assertEqual(probe["blockers"], [])
            self.assertTrue(probe["account"]["isAdmin"])
            self.assertFalse(probe["existingData"]["runningProcessExists"])
            self.assertFalse(probe["existingData"]["cacheRootExists"])
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

    def test_probe_host_blocks_missing_chrome_but_not_admin_account(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apps = root / "Applications"
            self.write_app(apps, "Microsoft Edge.app", "140.0.0.0")
            probe = self.collect_probe(
                root,
                apps,
                self.ready_commands({("id", "-Gn"): (0, "staff admin _appserveradm")}),
            )
            self.assertEqual(probe["verdict"], "BLOCKED")
            joined = " ".join(probe["blockers"])
            self.assertIn("Google Chrome is not installed", joined)
            self.assertNotIn("admin user", joined)
            self.assertNotIn("dedicated-test-account", joined)

    def test_probe_host_blocks_existing_app_data_registration_and_intel(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apps = root / "Applications"
            self.write_app(apps, "Google Chrome.app", "140.0.0.0")
            self.write_app(apps, "Microsoft Edge.app", "140.0.0.0")
            self.write_app(apps, "Resume Pro Desktop.app", "0.4.0-beta.3")
            (root / "Library/Application Support/ResumePro").mkdir(parents=True)
            manifest = root / MAC.CHROME_NM_REL
            manifest.parent.mkdir(parents=True)
            manifest.write_text("{}", encoding="utf-8")
            probe = self.collect_probe(
                root,
                apps,
                self.ready_commands({("uname", "-m"): (0, "x86_64")}),
            )
            joined = " ".join(probe["blockers"])
            self.assertIn("need arm64", joined)
            self.assertIn("existing Resume Pro Desktop app", joined)
            self.assertIn("existing ResumePro data root", joined)
            self.assertIn("existing Native Messaging manifests", joined)

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
                    "account": {"isAdmin": True},
                    "browsers": {
                        "chrome": {"installed": False, "profileIsolation": "NOT_VERIFIED"},
                        "edge": {"installed": True, "profileIsolation": "NOT_VERIFIED"},
                    },
                    "existingData": {
                        "desktopAppExists": False,
                        "dataRootExists": False,
                        "chromeNativeMessagingExists": False,
                        "edgeNativeMessagingExists": False,
                    },
                    "blockers": ["Gatekeeper assessments are disabled"],
                    "overallD14Status": "PARTIAL_PLATFORM_ACCEPTANCE",
                    "windowsStatus": "NOT_RUN",
                },
            ):
                with self.assertRaisesRegex(MAC.MacAcceptanceError, "host is BLOCKED"):
                    MAC.probe_host(Namespace(output=output))
            saved = MAC.read_json(output)
            self.assertEqual(saved["verdict"], "BLOCKED")
            self.assertFalse(saved["suitableForOfficialEvidence"])
            with patch.object(MAC, "collect_host_probe", return_value=saved):
                with self.assertRaisesRegex(MAC.MacAcceptanceError, "refusing to overwrite"):
                    MAC.probe_host(Namespace(output=output))

    def test_probe_host_does_not_mark_acceptance_cases_pass(self):
        t4 = MAC.read_json(MAC.T4_TEMPLATE)
        t5 = MAC.read_json(MAC.T5_TEMPLATE)
        environment = MAC.read_json(MAC.ENVIRONMENT_TEMPLATE)
        self.assertTrue(all(entry["status"] == "NOT_RUN" for entry in t4["cases"]))
        self.assertTrue(all(entry["status"] == "NOT_RUN" for entry in t5["checks"]))
        self.assertEqual(environment["installation"]["gatekeeperExperience"], "NOT_RUN")

    def test_parse_codesign_details_complete_adhoc_bundle(self):
        detail = "\n".join(
            [
                "Identifier=com.resumepro.desktop",
                "Format=app bundle with Mach-O thin (arm64)",
                "CodeDirectory v=20400 size=219 flags=0x2(adhoc) hashes=5+3",
                "Signature=adhoc",
                "TeamIdentifier=not set",
                "Sealed Resources version=2 rules=13 files=8",
            ]
        )
        self.assertEqual(MAC.parse_codesign_details(detail), "ADHOC_SIGNED")

    def test_parse_codesign_details_linker_signed(self):
        detail = "\n".join(
            [
                "Identifier=com.resumepro.desktop",
                "Format=Mach-O thin (arm64)",
                "CodeDirectory v=20400 size=142 flags=0x20002(adhoc,linker-signed) hashes=3+0",
                "Signature=adhoc",
                "Info.plist=not bound",
                "TeamIdentifier=not set",
            ]
        )
        self.assertEqual(MAC.parse_codesign_details(detail), "ADHOC_LINKER_SIGNED")

    def test_parse_codesign_details_developer_id(self):
        detail = "\n".join(
            [
                "Identifier=com.resumepro.desktop",
                "Format=app bundle with Mach-O thin (arm64)",
                "Authority=Developer ID Application: Example Inc (ABCD1234)",
                "Authority=Developer ID Certification Authority",
                "Authority=Apple Root CA",
                "TeamIdentifier=ABCD1234",
            ]
        )
        self.assertEqual(MAC.parse_codesign_details(detail), "DEVELOPER_ID_SIGNED")

    def test_parse_codesign_details_unsigned(self):
        self.assertEqual(
            MAC.parse_codesign_details("/tmp/app: code object is not signed at all"),
            "UNSIGNED",
        )

    def test_parse_codesign_details_unknown(self):
        self.assertEqual(MAC.parse_codesign_details("Identifier=com.example.other"), "UNKNOWN")
        self.assertEqual(MAC.parse_codesign_details(""), "UNKNOWN")

    def test_inspect_running_processes_absent_and_present(self):
        def none_running(argv):
            self.assertEqual(argv, ["ps", "-axo", "comm="])
            return 0, "launchd\nFinder\nGoogle Chrome\n"

        absent = MAC.inspect_running_processes(none_running)
        self.assertFalse(absent["runningProcessExists"])
        self.assertEqual(absent["runningProcessDetails"], [])

        def desktop_running(argv):
            return 0, "launchd\nresume-pro-deskto\nresume-pro-deskto\nFinder\n"

        present = MAC.inspect_running_processes(desktop_running)
        self.assertTrue(present["runningProcessExists"])
        self.assertEqual(
            present["runningProcessDetails"],
            [{"processName": "resume-pro-deskto", "pidCount": 2}],
        )
        self.assertNotIn("--", str(present["runningProcessDetails"]))

    def test_probe_host_blocks_running_process(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apps = root / "Applications"
            self.write_app(apps, "Google Chrome.app", "140.0.0.0")
            self.write_app(apps, "Microsoft Edge.app", "140.0.0.0")
            probe = self.collect_probe(
                root,
                apps,
                self.ready_commands({("ps", "-axo", "comm="): (0, "launchd\nResume Pro Deskt\n")}),
            )
            self.assertEqual(probe["verdict"], "BLOCKED")
            self.assertTrue(probe["existingData"]["runningProcessExists"])
            self.assertEqual(probe["existingData"]["runningProcessDetails"][0]["pidCount"], 1)
            self.assertTrue(any("process still running" in item for item in probe["blockers"]))
            self.assertNotIn("apiKey", json.dumps(probe["existingData"]["runningProcessDetails"]))

    def test_probe_host_records_cache_as_warning_and_unconfirmed_residue(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            apps = root / "Applications"
            self.write_app(apps, "Google Chrome.app", "140.0.0.0")
            self.write_app(apps, "Microsoft Edge.app", "140.0.0.0")
            (root / MAC.CACHE_ROOT_REL).mkdir(parents=True)
            (root / "Library/WebKit/com.resumepro.desktop").mkdir(parents=True)
            (root / "Library/Preferences").mkdir(parents=True)
            (root / "Library/Preferences/com.resumepro.desktop.plist").write_bytes(b"plist")
            (root / "Library/Saved Application State/com.resumepro.desktop.savedState").mkdir(
                parents=True
            )
            probe = self.collect_probe(root, apps, self.ready_commands())
            self.assertEqual(probe["verdict"], "READY")
            self.assertTrue(probe["existingData"]["cacheRootExists"])
            self.assertTrue(any("Caches/ResumePro" in item for item in probe["warnings"]))
            unconfirmed = {item["path"]: item for item in probe["existingData"]["unconfirmedResidue"]}
            self.assertEqual(len(unconfirmed), 3)
            self.assertTrue(
                all(item["sourceStatus"] == "UNCONFIRMED" for item in unconfirmed.values())
            )
            self.assertTrue(
                all(item["exists"] for item in unconfirmed.values()),
            )
            self.assertFalse(any("WebKit" in item for item in probe["blockers"]))
            self.assertFalse(any("Preferences" in item for item in probe["blockers"]))
            self.assertFalse(any("savedState" in item for item in probe["blockers"]))

    def test_probe_host_blocks_each_confirmed_first_start_residue_path(self):
        cases = [
            ("app", lambda root, apps: self.write_app(apps, "Resume Pro Desktop.app", "0.4.0-beta.3"), "existing Resume Pro Desktop app"),
            ("data", lambda root, apps: (root / MAC.DATA_ROOT_REL).mkdir(parents=True), "existing ResumePro data root"),
            (
                "chrome-nm",
                lambda root, apps: (
                    (root / MAC.CHROME_NM_REL).parent.mkdir(parents=True),
                    (root / MAC.CHROME_NM_REL).write_text("{}", encoding="utf-8"),
                ),
                "existing Native Messaging manifests",
            ),
            (
                "edge-nm",
                lambda root, apps: (
                    (root / MAC.EDGE_NM_REL).parent.mkdir(parents=True),
                    (root / MAC.EDGE_NM_REL).write_text("{}", encoding="utf-8"),
                ),
                "existing Native Messaging manifests",
            ),
        ]
        for _name, seed, expected in cases:
            with self.subTest(path=_name):
                with tempfile.TemporaryDirectory() as temp:
                    root = Path(temp)
                    apps = root / "Applications"
                    self.write_app(apps, "Google Chrome.app", "140.0.0.0")
                    self.write_app(apps, "Microsoft Edge.app", "140.0.0.0")
                    seed(root, apps)
                    probe = self.collect_probe(root, apps, self.ready_commands())
                    self.assertEqual(probe["verdict"], "BLOCKED")
                    self.assertTrue(any(expected in item for item in probe["blockers"]))

    def test_environment_account_types(self):
        environment = MAC.read_json(MAC.ENVIRONMENT_TEMPLATE)
        self.assertEqual(MAC.validate_environment(environment, True), [])
        environment["account"]["type"] = "admin"
        self.assertTrue(any("must not claim an account type" in item for item in MAC.validate_environment(environment, True)))
        filled = MAC.read_json(MAC.ENVIRONMENT_TEMPLATE)
        filled["account"]["type"] = "admin"
        self.assertEqual(MAC.validate_environment(filled, False), [])
        filled["account"]["type"] = "standard-user"
        self.assertEqual(MAC.validate_environment(filled, False), [])
        filled["account"]["type"] = "root"
        self.assertTrue(
            any("admin or standard-user" in item for item in MAC.validate_environment(filled, False))
        )

    def test_t5_report_rejects_missing_extra_reordered_pass_without_evidence_and_false_approved(self):
        report = MAC.read_json(MAC.T5_TEMPLATE)
        missing = deepcopy(report)
        missing["checks"] = missing["checks"][1:]
        self.assertTrue(any("16 shared T5 checks" in item for item in MAC.validate_t5_report(missing, False)))

        extra = deepcopy(report)
        extra["checks"] = extra["checks"] + [
            {"id": "M5-K01", "caseIds": ["J06"], "name": "old keychain", "status": "NOT_RUN", "evidence": []}
        ]
        self.assertTrue(any("16 shared T5 checks" in item for item in MAC.validate_t5_report(extra, False)))

        reordered = deepcopy(report)
        reordered["checks"] = [reordered["checks"][1], reordered["checks"][0], *reordered["checks"][2:]]
        self.assertTrue(any("exactly once in order" in item for item in MAC.validate_t5_report(reordered, False)))

        no_evidence = deepcopy(report)
        no_evidence["checks"][0]["status"] = "PASS"
        no_evidence["checks"][0]["evidence"] = []
        self.assertIn("T5-R01: PASS requires non-empty evidence", MAC.validate_t5_report(no_evidence, False))

        approved = deepcopy(report)
        approved["review"]["decision"] = "APPROVED"
        self.assertTrue(
            any("APPROVED requires every check to be PASS" in item for item in MAC.validate_t5_report(approved, False))
        )
        self.assertTrue(
            any("must remain NOT_REVIEWED" in item for item in MAC.validate_t5_report(approved, True))
        )

    def test_t5_check_ids_match_the_shared_windows_template(self):
        windows = MAC.read_json(MAC.ACCEPTANCE / "t5-report-template.json")
        self.assertEqual([item["id"] for item in windows["checks"]], MAC.T5_CHECKS)
        self.assertEqual(len(MAC.T5_CHECKS), 16)

    def test_verify_candidate_reinspects_live_dmg_signature(self):
        with tempfile.TemporaryDirectory() as temp:
            args = self.candidate_args(Path(temp))
            with patch.object(MAC, "verify_dmg_integrity"), patch.object(
                MAC, "inspect_dmg_bundle", return_value=self.dmg_details()
            ):
                MAC.prepare_candidate(args)
            candidate = MAC.read_json(args.output)
            candidate["desktop"]["signatureStatus"] = "ADHOC_LINKER_SIGNED"
            MAC.write_json(args.output, candidate)
            live = self.dmg_details()
            with patch.object(MAC, "verify_dmg_integrity"), patch.object(
                MAC, "inspect_dmg_bundle", return_value=live
            ):
                with self.assertRaisesRegex(MAC.MacAcceptanceError, "live DMG inspection"):
                    MAC.verify_candidate(
                        Namespace(candidate=args.output, dmg=args.dmg, extension_zip=args.extension_zip)
                    )

    def test_prepare_candidate_rejects_unsigned_unknown_and_failed_strict_verify(self):
        with tempfile.TemporaryDirectory() as temp:
            args = self.candidate_args(Path(temp))
            for status in ("UNSIGNED", "UNKNOWN", "DEVELOPER_ID_SIGNED"):
                details = self.dmg_details()
                details["signatureStatus"] = status
                with patch.object(MAC, "verify_dmg_integrity"), patch.object(
                    MAC, "inspect_dmg_bundle", return_value=details
                ):
                    with self.assertRaisesRegex(MAC.MacAcceptanceError, "complete ADHOC_SIGNED"):
                        MAC.prepare_candidate(args)
            details = self.dmg_details()
            details["codesignVerifyStatus"] = "FAIL"
            with patch.object(MAC, "verify_dmg_integrity"), patch.object(
                MAC, "inspect_dmg_bundle", return_value=details
            ):
                with self.assertRaisesRegex(MAC.MacAcceptanceError, "codesign --verify --deep --strict"):
                    MAC.prepare_candidate(args)


if __name__ == "__main__":
    unittest.main()
