#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const JOURNEYS = Array.from({ length: 8 }, (_, index) => `J${String(index + 1).padStart(2, "0")}`);
export const T5_CHECKS = [
  "T5-R01", "T5-R02", "T5-R03", "T5-R04", "T5-R05",
  "T5-B01", "T5-B02", "T5-B03", "T5-B04", "T5-F01", "T5-F02",
  "T5-U01", "T5-U02", "T5-U03", "T5-U04", "T5-P01",
];
const EXPECTED_EXTENSION_ID = "diagjmploldedipjdenmecmjokckelkl";

export class GateError extends Error {}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function required(value, label) {
  if (value === null || value === undefined || value === "") throw new GateError(`missing ${label}`);
  return value;
}

function httpsUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new GateError(`${label} is not a URL`); }
  if (parsed.protocol !== "https:") throw new GateError(`${label} must use https`);
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function artifactBinding(candidate, kind) {
  return Object.fromEntries(["name", "sha256", "downloadUrl"].map((key) => [key, candidate[kind]?.[key]]));
}

function assertReview(review, label) {
  if (review?.decision !== "APPROVED") throw new GateError(`${label} review is not APPROVED`);
  required(review.reviewer, `${label}.reviewer`);
  required(review.reviewedAt, `${label}.reviewedAt`);
  if (review.blockingDefects?.length) throw new GateError(`${label} has blocking defects`);
}

export function assertCandidate(candidate) {
  if (candidate.fixtureVersion !== "d14-v1") throw new GateError("candidate fixtureVersion must be d14-v1");
  if (!/^[0-9a-f]{40}$/.test(candidate.testedSourceCommit ?? "")) {
    throw new GateError("candidate testedSourceCommit must be a full Git SHA");
  }
  required(candidate.desktopVersion, "candidate.desktopVersion");
  required(candidate.extensionVersion, "candidate.extensionVersion");
  if (!Number.isInteger(candidate.protocolVersion)) throw new GateError("candidate.protocolVersion must be an integer");
  for (const kind of ["desktop", "extension"]) {
    const artifact = candidate[kind] ?? {};
    required(artifact.name, `candidate.${kind}.name`);
    if (!Number.isInteger(artifact.byteLength) || artifact.byteLength <= 0) {
      throw new GateError(`candidate.${kind}.byteLength must be positive`);
    }
    if (!/^[0-9a-f]{64}$/.test(artifact.sha256 ?? "")) {
      throw new GateError(`candidate.${kind}.sha256 must be lowercase SHA-256`);
    }
    httpsUrl(artifact.downloadUrl, `candidate.${kind}.downloadUrl`);
  }
  required(candidate.desktop.signatureStatus, "candidate.desktop.signatureStatus");
  if (candidate.extension.extensionId !== EXPECTED_EXTENSION_ID) {
    throw new GateError("candidate extension id is not the fixed production id");
  }
}

function assertBindings(report, candidate, label) {
  const expected = {
    fixtureVersion: candidate.fixtureVersion,
    testedSourceCommit: candidate.testedSourceCommit,
    desktopVersion: candidate.desktopVersion,
    extensionVersion: candidate.extensionVersion,
    protocolVersion: candidate.protocolVersion,
    desktopArtifact: artifactBinding(candidate, "desktop"),
    extensionArtifact: artifactBinding(candidate, "extension"),
  };
  for (const [field, value] of Object.entries(expected)) {
    if (JSON.stringify(report[field]) !== JSON.stringify(value)) {
      throw new GateError(`${label}.${field} does not match the candidate`);
    }
  }
}

export function assertT4Report(report, browser, candidate) {
  const label = `reports.${browser}`;
  assertBindings(report, candidate, label);
  if (report.environment?.browser !== browser) throw new GateError(`${label} has the wrong browser`);
  required(report.environment?.browserVersion, `${label}.environment.browserVersion`);
  required(report.environment?.osBuild, `${label}.environment.osBuild`);
  required(report.environment?.webview2Version, `${label}.environment.webview2Version`);
  required(report.completedAt, `${label}.completedAt`);
  const byId = new Map((report.cases ?? []).map((item) => [item.id, item]));
  for (const id of JOURNEYS) {
    const item = byId.get(id);
    if (item?.status !== "PASS" || !item.evidence?.length) {
      throw new GateError(`${label}.${id} must be PASS with evidence`);
    }
  }
  if (report.t4Preflight?.installedRegistration !== "VERIFIED") {
    throw new GateError(`${label} production Native Messaging registration is not verified`);
  }
  assertReview(report.review, label);
}

export function assertT5Report(report, candidate) {
  const label = "reports.t5";
  if (report.phase !== "T5") throw new GateError("reports.t5 phase is not T5");
  assertBindings(report, candidate, label);
  required(report.completedAt, `${label}.completedAt`);
  const checks = report.checks ?? [];
  if (JSON.stringify(checks.map((item) => item.id)) !== JSON.stringify(T5_CHECKS)) {
    throw new GateError("reports.t5 check ids/order do not match the T5 template");
  }
  for (const check of checks) {
    if (check.status !== "PASS" || !check.evidence?.length) {
      throw new GateError(`${label}.${check.id} must be PASS with evidence`);
    }
  }
  assertReview(report.review, label);
}

export function assertDependencies(payload) {
  const dependencies = payload.dependencies ?? [];
  if (JSON.stringify(dependencies.map((item) => item.id)) !== JSON.stringify(["D08", "D11", "D13"])) {
    throw new GateError("dependencies must contain D08, D11 and D13 exactly");
  }
  for (const dependency of dependencies) {
    if (dependency.signedOff !== true) throw new GateError(`${dependency.id} is not signed off`);
    if (!dependency.acceptanceEvidence?.length) throw new GateError(`${dependency.id} has no acceptance evidence`);
    required(dependency.signedOffBy, `${dependency.id}.signedOffBy`);
    required(dependency.signedOffAt, `${dependency.id}.signedOffAt`);
  }
}

function resolveReference(gatePath, reference, label) {
  required(reference, label);
  return isAbsolute(reference) ? reference : resolve(dirname(gatePath), reference);
}

function assertReleaseFile(path, expected, label) {
  const stats = statSync(path);
  if (!stats.isFile()) throw new GateError(`${label} is not a file`);
  if (stats.size !== expected.byteLength) throw new GateError(`${label} byte length differs from candidate`);
  if (sha256File(path) !== expected.sha256) throw new GateError(`${label} SHA-256 differs from candidate`);
  if (path.replaceAll("\\", "/").split("/").at(-1) !== expected.name) {
    throw new GateError(`${label} file name differs from candidate`);
  }
}

export function checkGate(gatePath) {
  const absoluteGate = resolve(gatePath);
  const gate = readJson(absoluteGate);
  if (gate.schemaVersion !== 1) throw new GateError("unsupported release gate schemaVersion");
  const candidate = readJson(resolveReference(absoluteGate, gate.candidateManifest, "candidateManifest"));
  assertCandidate(candidate);
  if (gate.requiredSourceCommit !== candidate.testedSourceCommit) {
    throw new GateError("requiredSourceCommit does not match the candidate")
  }
  const dependencies = readJson(resolveReference(absoluteGate, gate.dependencies, "dependencies"));
  assertDependencies(dependencies);
  const chrome = readJson(resolveReference(absoluteGate, gate.reports?.chrome, "reports.chrome"));
  const edge = readJson(resolveReference(absoluteGate, gate.reports?.edge, "reports.edge"));
  const t5 = readJson(resolveReference(absoluteGate, gate.reports?.t5, "reports.t5"));
  assertT4Report(chrome, "chrome", candidate);
  assertT4Report(edge, "edge", candidate);
  assertT5Report(t5, candidate);
  assertReleaseFile(
    resolveReference(absoluteGate, gate.releaseArtifacts?.desktop, "releaseArtifacts.desktop"),
    candidate.desktop,
    "releaseArtifacts.desktop",
  );
  assertReleaseFile(
    resolveReference(absoluteGate, gate.releaseArtifacts?.extension, "releaseArtifacts.extension"),
    candidate.extension,
    "releaseArtifacts.extension",
  );
  assertReview(gate.review, "release gate");
  return {
    testedSourceCommit: candidate.testedSourceCommit,
    desktopSha256: candidate.desktop.sha256,
    extensionSha256: candidate.extension.sha256,
    reports: 3,
    dependencies: 3,
  };
}

const isMain = process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  try {
    const gatePath = process.argv[2];
    if (!gatePath) throw new GateError("usage: node check-release-acceptance.mjs <release-gate.json>");
    const result = checkGate(gatePath);
    console.log(`release acceptance passed for ${result.testedSourceCommit}; desktop=${result.desktopSha256}; extension=${result.extensionSha256}`);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
