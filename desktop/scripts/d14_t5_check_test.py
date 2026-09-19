import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("d14_t5_check.py")
SPEC = importlib.util.spec_from_file_location("d14_t5_check", SCRIPT)
T5 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(T5)


class T5CheckTests(unittest.TestCase):
    def candidate(self):
        return {
            "fixtureVersion": "d14-v1", "testedSourceCommit": "a" * 40,
            "buildTarget": "x86_64-pc-windows-msvc", "evidencePurpose": "RELEASE_CANDIDATE",
            "desktopVersion": "0.1.0", "extensionVersion": "0.4.0", "protocolVersion": 1,
            "desktop": {"name": "setup.exe", "sha256": "b" * 64, "downloadUrl": "https://example.test/setup"},
            "extension": {"name": "extension.zip", "sha256": "c" * 64, "downloadUrl": "https://example.test/zip"},
        }

    def report(self):
        value = T5.read_json(T5.TEMPLATE)
        candidate = self.candidate()
        value.update(
            buildTarget=candidate["buildTarget"],
            evidencePurpose=candidate["evidencePurpose"],
            testedSourceCommit=candidate["testedSourceCommit"],
            desktopVersion=candidate["desktopVersion"],
            extensionVersion=candidate["extensionVersion"],
            protocolVersion=candidate["protocolVersion"],
            desktopArtifact=T5.artifact_binding(candidate, "desktop"),
            extensionArtifact=T5.artifact_binding(candidate, "extension"),
            completedAt="2026-09-19T01:00:00Z",
            environment={"accountType": "standard-user"},
            baselineT4Reports={"chrome": "../chrome/report.json", "edge": "../edge/report.json"},
        )
        return value

    def test_template_starts_entirely_not_run(self):
        report = self.report()
        self.assertEqual(len(report["checks"]), 16)
        self.assertTrue(all(check["status"] == "NOT_RUN" for check in report["checks"]))

    def test_complete_gate_requires_evidence_and_named_review(self):
        report = self.report()
        for check in report["checks"]:
            check.update(status="PASS", evidence=["evidence.json"])
        errors = T5.verify_report(report, self.candidate(), True)
        self.assertIn("T5 completion requires review.decision=APPROVED", errors)
        report["review"] = {
            "reviewer": "owner", "reviewedAt": "2026-09-19T00:00:00Z",
            "decision": "APPROVED", "blockingDefects": [],
        }
        self.assertEqual(T5.verify_report(report, self.candidate(), True), [])

        report["checks"][0]["evidence"] = [""]
        self.assertIn(
            "T5-R01: PASS requires non-empty evidence strings",
            T5.verify_report(report, self.candidate(), True),
        )
        report["checks"][0]["evidence"] = ["evidence.json"]
        report["environment"]["accountType"] = "administrator"
        self.assertIn(
            "T5 completion requires environment.accountType=standard-user",
            T5.verify_report(report, self.candidate(), True),
        )

    def test_candidate_mismatch_is_rejected(self):
        report = self.report()
        report["extensionArtifact"]["sha256"] = "d" * 64
        self.assertIn(
            "extensionArtifact does not match the candidate",
            T5.verify_report(report, self.candidate(), False),
        )

    def test_t5_baseline_requires_the_full_t4_matrix_and_smoke(self):
        candidate = self.candidate()
        baseline = {
            "buildTarget": candidate["buildTarget"],
            "evidencePurpose": candidate["evidencePurpose"],
            "fixtureVersion": candidate["fixtureVersion"],
            "testedSourceCommit": candidate["testedSourceCommit"],
            "desktopVersion": candidate["desktopVersion"],
            "extensionVersion": candidate["extensionVersion"],
            "protocolVersion": candidate["protocolVersion"],
            "desktopArtifact": T5.artifact_binding(candidate, "desktop"),
            "extensionArtifact": T5.artifact_binding(candidate, "extension"),
            "cases": [
                {"id": case_id, "status": "PASS", "evidence": ["evidence"]}
                for case_id in T5.T4_CASES
            ],
            "environment": {"accountType": "standard-user", "browser": "chrome"},
            "t4Preflight": {
                "installedRegistration": "VERIFIED",
                "installedSmoke": {"status": "PASS"},
            },
            "review": {
                "reviewer": "owner", "reviewedAt": "2026-09-19T00:00:00Z",
                "decision": "APPROVED", "blockingDefects": [],
            },
        }
        T5.validate_t4_baseline(baseline, candidate, "chrome")
        baseline["cases"].pop()
        with self.assertRaisesRegex(T5.T5Error, "J01-J08 and F01-F13"):
            T5.validate_t4_baseline(baseline, candidate, "chrome")

    def test_t5_baselines_must_name_the_expected_browser_and_candidate(self):
        candidate = self.candidate()
        baseline = {
            "buildTarget": candidate["buildTarget"],
            "evidencePurpose": candidate["evidencePurpose"],
            "fixtureVersion": candidate["fixtureVersion"],
            "testedSourceCommit": candidate["testedSourceCommit"],
            "desktopVersion": candidate["desktopVersion"],
            "extensionVersion": candidate["extensionVersion"],
            "protocolVersion": candidate["protocolVersion"],
            "desktopArtifact": T5.artifact_binding(candidate, "desktop"),
            "extensionArtifact": T5.artifact_binding(candidate, "extension"),
            "cases": [
                {"id": case_id, "status": "PASS", "evidence": ["evidence"]}
                for case_id in T5.T4_CASES
            ],
            "environment": {"accountType": "standard-user", "browser": "edge"},
            "t4Preflight": {
                "installedRegistration": "VERIFIED", "installedSmoke": {"status": "PASS"},
            },
            "review": {
                "reviewer": "owner", "reviewedAt": "2026-09-19T00:00:00Z",
                "decision": "APPROVED", "blockingDefects": [],
            },
        }
        T5.validate_t4_baseline(baseline, candidate, "edge")
        baseline["testedSourceCommit"] = "f" * 40
        with self.assertRaisesRegex(T5.T5Error, "testedSourceCommit"):
            T5.validate_t4_baseline(baseline, candidate, "edge")

    def test_equal_and_preserved_comparisons_distinguish_extra_files(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            before = root / "before.json"
            after = root / "after.json"
            payload = {"files": [{"path": "archive.db", "byteLength": 1, "sha256": "a"}]}
            T5.write_json(before, payload)
            T5.write_json(after, {"files": payload["files"] + [{"path": "new", "byteLength": 1, "sha256": "b"}]})
            left = T5.read_json(before)
            right = T5.read_json(after)
            self.assertEqual(T5.compare_snapshots(left, right, "equal")["status"], "FAIL")
            self.assertEqual(T5.compare_snapshots(left, right, "preserved")["status"], "PASS")


if __name__ == "__main__":
    unittest.main()
