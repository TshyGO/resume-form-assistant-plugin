import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkGate, REQUIRED_CASES, T5_CHECKS } from "./check-release-acceptance.mjs";

const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "d14-gate-"));
  const desktopBytes = Buffer.from("desktop candidate");
  const extensionBytes = Buffer.from("extension candidate");
  const desktopPath = join(dir, "setup.exe");
  const extensionPath = join(dir, "extension.zip");
  writeFileSync(desktopPath, desktopBytes);
  writeFileSync(extensionPath, extensionBytes);
  const artifact = (name, bytes, url) => ({
    name, byteLength: bytes.length, sha256: digest(bytes), downloadUrl: url,
  });
  const candidate = {
    schemaVersion: 1, fixtureVersion: "d14-v1", testedSourceCommit: "a".repeat(40),
    desktopVersion: "0.1.0", extensionVersion: "0.4.0", protocolVersion: 1,
    desktop: {
      ...artifact("setup.exe", desktopBytes, "https://example.test/setup"),
      signatureStatus: "NotSigned", signaturePolicy: "UNSIGNED_APPROVED",
      signerSubject: null, signerThumbprint: null, unsignedApproval: "D14 scope owner 2026-09-19",
    },
    extension: {
      ...artifact("extension.zip", extensionBytes, "https://example.test/zip"),
      extensionId: "diagjmploldedipjdenmecmjokckelkl",
      manifestSha256: "b".repeat(64), packageTreeSha256: "c".repeat(64),
    },
  };
  json(join(dir, "candidate.json"), candidate);
  const binding = {
    fixtureVersion: candidate.fixtureVersion, testedSourceCommit: candidate.testedSourceCommit,
    desktopVersion: candidate.desktopVersion, extensionVersion: candidate.extensionVersion,
    protocolVersion: candidate.protocolVersion,
    desktopArtifact: Object.fromEntries(["name", "sha256", "downloadUrl"].map((key) => [key, candidate.desktop[key]])),
    extensionArtifact: Object.fromEntries(["name", "sha256", "downloadUrl"].map((key) => [key, candidate.extension[key]])),
  };
  const review = { reviewer: "owner", reviewedAt: "2026-09-19T00:00:00Z", decision: "APPROVED", blockingDefects: [] };
  const dependencyRecords = ["D08", "D11", "D13"].map((id) => ({
    id, signedOff: true, acceptanceEvidence: ["evidence"], signedOffBy: "owner", signedOffAt: "2026-09-19",
  }));
  const reportDependencies = dependencyRecords.map((item, index) => ({
    issue: [22, 25, 29][index], acceptanceEvidence: item.acceptanceEvidence,
    signedOff: item.signedOff, signedOffBy: item.signedOffBy, signedOffAt: item.signedOffAt,
  }));
  for (const browser of ["chrome", "edge"]) {
    json(join(dir, `${browser}.json`), {
      ...binding, completedAt: "2026-09-19T00:00:00Z",
      environment: {
        browser, browserVersion: "1", osBuild: "Windows", webview2Version: "1",
        accountType: "standard-user",
      },
      t4Preflight: {
        candidateVerified: true, installedRegistration: "VERIFIED",
        installedSmoke: { status: "PASS" },
        extensionManifestSha256: candidate.extension.manifestSha256,
        extensionPackageTreeSha256: candidate.extension.packageTreeSha256,
        desktopSignatureStatus: candidate.desktop.signatureStatus,
        desktopSignaturePolicy: candidate.desktop.signaturePolicy,
      },
      cases: REQUIRED_CASES.map((id) => ({ id, status: "PASS", evidence: ["evidence"] })),
      dependencies: reportDependencies, review,
    });
  }
  json(join(dir, "t5.json"), {
    ...binding, phase: "T5", completedAt: "2026-09-19T00:00:00Z",
    checks: T5_CHECKS.map((id) => ({ id, status: "PASS", evidence: ["evidence"] })), review,
  });
  json(join(dir, "dependencies.json"), {
    dependencies: dependencyRecords,
  });
  const gate = {
    schemaVersion: 1, candidateManifest: "candidate.json", dependencies: "dependencies.json",
    reports: { chrome: "chrome.json", edge: "edge.json", t5: "t5.json" },
    releaseArtifacts: { desktop: "setup.exe", extension: "extension.zip" },
    requiredSourceCommit: candidate.testedSourceCommit, review,
  };
  const gatePath = join(dir, "gate.json");
  json(gatePath, gate);
  return { dir, gatePath, candidate, gate };
}

test("a fully signed-off gate binds reports and release bytes to one candidate", () => {
  const { gatePath, candidate } = fixture();
  assert.deepEqual(checkGate(gatePath), {
    testedSourceCommit: candidate.testedSourceCommit,
    desktopSha256: candidate.desktop.sha256,
    extensionSha256: candidate.extension.sha256,
    reports: 3,
    dependencies: 3,
  });
});

test("changed release bytes are rejected", () => {
  const { dir, gatePath } = fixture();
  writeFileSync(join(dir, "setup.exe"), "changed");
  assert.throws(() => checkGate(gatePath), /byte length differs|SHA-256 differs/);
});

test("an unsigned dependency is rejected", () => {
  const { dir, gatePath } = fixture();
  const payload = JSON.parse(readFileSync(join(dir, "dependencies.json"), "utf8"));
  payload.dependencies[1].signedOff = false;
  json(join(dir, "dependencies.json"), payload);
  assert.throws(() => checkGate(gatePath), /D11 is not signed off/);
});

test("a report for different candidate bytes is rejected", () => {
  const { dir, gatePath } = fixture();
  const payload = JSON.parse(readFileSync(join(dir, "edge.json"), "utf8"));
  payload.extensionArtifact.sha256 = "f".repeat(64);
  json(join(dir, "edge.json"), payload);
  assert.throws(() => checkGate(gatePath), /reports\.edge\.extensionArtifact/);
});

test("NOT_RUN T5 evidence and blocking review defects fail closed", () => {
  const { dir, gatePath, gate } = fixture();
  const t5 = JSON.parse(readFileSync(join(dir, "t5.json"), "utf8"));
  t5.checks[0].status = "NOT_RUN";
  json(join(dir, "t5.json"), t5);
  assert.throws(() => checkGate(gatePath), /T5-R01 must be PASS/);
  t5.checks[0].status = "PASS";
  json(join(dir, "t5.json"), t5);
  gate.review.blockingDefects = ["BLOCK-1"];
  json(gatePath, gate);
  assert.throws(() => checkGate(gatePath), /release gate has blocking defects/);
});

test("missing fault cases, admin execution, and blank evidence fail closed", () => {
  const { dir, gatePath } = fixture();
  const chrome = JSON.parse(readFileSync(join(dir, "chrome.json"), "utf8"));
  chrome.cases.pop();
  json(join(dir, "chrome.json"), chrome);
  assert.throws(() => checkGate(gatePath), /J01-J08 and F01-F13/);

  const second = fixture();
  const edge = JSON.parse(readFileSync(join(second.dir, "edge.json"), "utf8"));
  edge.environment.accountType = "administrator";
  json(join(second.dir, "edge.json"), edge);
  assert.throws(() => checkGate(second.gatePath), /standard user/);

  const third = fixture();
  const t5 = JSON.parse(readFileSync(join(third.dir, "t5.json"), "utf8"));
  t5.checks[0].evidence = [""];
  json(join(third.dir, "t5.json"), t5);
  assert.throws(() => checkGate(third.gatePath), /T5-R01 must be PASS with evidence/);
});

test("candidate URLs with credentials or query tokens fail closed", () => {
  const { dir, gatePath } = fixture();
  const candidate = JSON.parse(readFileSync(join(dir, "candidate.json"), "utf8"));
  candidate.desktop.downloadUrl = "https://example.test/setup?token=secret";
  json(join(dir, "candidate.json"), candidate);
  assert.throws(() => checkGate(gatePath), /credential-free/);
});
