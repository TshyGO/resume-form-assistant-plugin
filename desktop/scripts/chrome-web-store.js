// Chrome Web Store API v2：上传已有条目、核对上传结果、送审。
// 正式发布停在 STAGED_PUBLISH，审核通过后由维护者再决定上线。
//
//   node desktop/scripts/chrome-web-store.js zip-name
//   node desktop/scripts/chrome-web-store.js check-release --tag v0.4.0
//   node desktop/scripts/chrome-web-store.js verify-zip --zip resume-pro-v0.4.0-chrome.zip
//   node desktop/scripts/chrome-web-store.js publish --zip resume-pro-v0.4.0-chrome.zip --dry-run
//   node desktop/scripts/chrome-web-store.js publish --zip resume-pro-v0.4.0-chrome.zip
//   node desktop/scripts/chrome-web-store.js status
//   node desktop/scripts/chrome-web-store.js release-staged
//
// 凭据只从环境变量读。任何报错都不会带上私钥、refresh token 或 access token。

import { createHash, createSign, createVerify, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STORE_SCOPE = "https://www.googleapis.com/auth/chromewebstore";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_ORIGIN = "https://chromewebstore.googleapis.com/upload/v2";
const API_ORIGIN = "https://chromewebstore.googleapis.com/v2";

export const ENV = {
  extensionId: "CHROME_EXTENSION_ID",
  publisherId: "CHROME_PUBLISHER_ID",
  serviceAccount: "CHROME_WEB_STORE_CREDENTIALS",
  clientId: "CHROME_CLIENT_ID",
  clientSecret: "CHROME_CLIENT_SECRET",
  refreshToken: "CHROME_REFRESH_TOKEN",
};

const IN_PROGRESS = new Set(["IN_PROGRESS", "UPLOAD_IN_PROGRESS"]);
const SUCCEEDED = new Set(["SUCCEEDED"]);
const FAILED = new Set(["FAILED"]);
const ALREADY_SUBMITTED = new Set(["PENDING_REVIEW", "STAGED", "PUBLISHED", "PUBLISHED_TO_TESTERS"]);

export class StorePublishError extends Error {
  constructor(message) {
    super(message);
    this.name = "StorePublishError";
  }
}

export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function extensionVersion(manifest) {
  const version = manifest?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new StorePublishError(`扩展版本号必须是 1.2.3 这种三段数字，manifest 里是 ${version}`);
  }
  return version;
}

export function chromeZipName(version) {
  const checked = extensionVersion({ version });
  return `resume-pro-v${checked}-chrome.zip`;
}

/** Chrome 把公钥 SHA-256 的前 16 字节映射成 a–p，得到扩展 ID。 */
export function extensionIdFromPublicKey(key) {
  const der = Buffer.from(String(key ?? ""), "base64");
  if (der.length < 32) {
    throw new StorePublishError("manifest.json 的 key 不是合法的公钥");
  }
  const hash = createHash("sha256").update(der).digest();
  return [...hash.subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}

export function assertReleaseMatchesManifest({ tag, manifest, prerelease = false }) {
  const version = extensionVersion(manifest);
  if (prerelease) {
    throw new StorePublishError("预发布的 GitHub Release 不会上传商店。正式发布不要勾 Pre-release");
  }
  if (tag !== `v${version}`) {
    throw new StorePublishError(`Release tag 是 ${tag}，扩展版本是 ${version}。两者必须是 v${version}`);
  }
  return version;
}

export function redact(text, secrets) {
  let out = String(text);
  const values = [...secrets].filter((secret) => typeof secret === "string" && secret.length >= 6);
  values.sort((a, b) => b.length - a.length);
  for (const secret of values) {
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

export function channelVersions(revision) {
  if (!revision || !Array.isArray(revision.distributionChannels)) return [];
  return revision.distributionChannels.map((channel) => channel?.crxVersion).filter((version) => typeof version === "string");
}

/**
 * 同一版本已经在线上、审核中或待上线时，不允许再上传。
 * 进行中的上传也不许覆盖。
 */
export function assertUploadAllowed(status, version) {
  if (!status || typeof status !== "object") {
    throw new StorePublishError("商店没有返回条目状态，停止发布");
  }
  if (status.takenDown) {
    throw new StorePublishError("商店条目已被下架，停止发布");
  }
  if (IN_PROGRESS.has(status.lastAsyncUploadState)) {
    throw new StorePublishError("商店仍有进行中的上传，停止发布，避免并发覆盖");
  }
  const published = channelVersions(status.publishedItemRevisionStatus);
  if (published.includes(version)) {
    throw new StorePublishError(`版本 ${version} 已经是线上版本，拒绝重复上传`);
  }
  const submitted = channelVersions(status.submittedItemRevisionStatus);
  const state = status.submittedItemRevisionStatus?.state;
  if (submitted.includes(version) && ALREADY_SUBMITTED.has(state)) {
    throw new StorePublishError(`版本 ${version} 已在商店处于 ${state}，拒绝重复上传`);
  }
}

export function uploadErrorIsSameVersion(body, version) {
  const text = typeof body === "string" ? body : JSON.stringify(body ?? "");
  if (!text.includes(version)) return false;
  return /version|already|exist|duplicate|INVALID_VERSION|ITEM_ALREADY/i.test(text);
}

export function assertZipListing(names) {
  if (!Array.isArray(names) || names.length === 0) {
    throw new StorePublishError("ZIP 是空的，停止发布");
  }
  if (!names.includes("manifest.json")) {
    throw new StorePublishError("ZIP 里没有 manifest.json，停止发布");
  }
  for (const name of names) {
    const normalized = String(name).replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      normalized.split("/").includes("..") ||
      normalized === "desktop" ||
      normalized.startsWith("desktop/") ||
      normalized.split("/").includes("node_modules") ||
      normalized.split("/").includes(".git") ||
      normalized.includes(".env") ||
      normalized.endsWith(".pem") ||
      normalized.endsWith(".key")
    ) {
      throw new StorePublishError(`ZIP 含有不能上架的路径 ${name}，停止发布`);
    }
  }
}

export function parseUnzipListing(text) {
  const names = [];
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*\d+\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.*\S)\s*$/);
    if (match) names.push(match[1]);
  }
  return names;
}

export function itemName(publisherId, extensionId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(publisherId)) {
    throw new StorePublishError("CHROME_PUBLISHER_ID 只能包含字母、数字、下划线和连字符");
  }
  if (!/^[a-p]{32}$/.test(extensionId)) {
    throw new StorePublishError("CHROME_EXTENSION_ID 必须是 32 位 a–p 的扩展 ID");
  }
  return `publishers/${publisherId}/items/${extensionId}`;
}

export function buildServiceAccountAssertion(credentials, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!credentials || typeof credentials.client_email !== "string" || typeof credentials.private_key !== "string") {
    throw new StorePublishError("服务账号 JSON 缺少 client_email 或 private_key");
  }
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: credentials.client_email,
    scope: STORE_SCOPE,
    aud: credentials.token_uri || TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    jti: randomUUID(),
  }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(credentials.private_key).toString("base64url");
  return `${unsigned}.${signature}`;
}

export function verifyServiceAccountAssertion(assertion, publicKey) {
  const [header, payload, signature] = assertion.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  return verifier.verify(publicKey, Buffer.from(signature, "base64url"));
}

function base64url(text) {
  return Buffer.from(text).toString("base64url");
}

function secretValues(parts) {
  return [parts.accessToken, parts.privateKey, parts.clientSecret, parts.refreshToken, parts.assertion]
    .filter((value) => typeof value === "string");
}

async function request(fetchImpl, url, { method, token, body, headers, secrets }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      redirect: "error",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body,
    });
  } catch (error) {
    throw new StorePublishError(redact(error instanceof Error ? error.message : error, secrets));
  }
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const detail = parsed && typeof parsed === "object" ? JSON.stringify(parsed.error ?? parsed) : String(parsed ?? "");
    const failure = new StorePublishError(
      redact(`Chrome Web Store ${method} failed: HTTP ${response.status} ${detail}`, [...secrets, text]),
    );
    failure.status = response.status;
    failure.body = parsed;
    throw failure;
  }
  return parsed;
}

export async function accessTokenFromServiceAccount(credentials, fetchImpl, nowSeconds) {
  const assertion = buildServiceAccountAssertion(credentials, nowSeconds);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });
  const token = await request(fetchImpl, credentials.token_uri || TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    secrets: secretValues({ privateKey: credentials.private_key, assertion }),
  });
  if (!token || typeof token.access_token !== "string" || token.access_token.length < 6) {
    throw new StorePublishError("服务账号没有换到 access token");
  }
  return token.access_token;
}

export async function accessTokenFromRefreshToken({ clientId, clientSecret, refreshToken }, fetchImpl) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const token = await request(fetchImpl, TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    secrets: secretValues({ clientSecret, refreshToken }),
  });
  if (!token || typeof token.access_token !== "string" || token.access_token.length < 6) {
    throw new StorePublishError("refresh token 没有换到 access token");
  }
  return token.access_token;
}

export function credentialsFromEnv(env) {
  const extensionId = env[ENV.extensionId] ?? "";
  const publisherId = env[ENV.publisherId] ?? "";
  const serviceAccountRaw = env[ENV.serviceAccount] ?? "";
  const clientId = env[ENV.clientId] ?? "";
  const clientSecret = env[ENV.clientSecret] ?? "";
  const refreshToken = env[ENV.refreshToken] ?? "";
  if (!extensionId || !publisherId) {
    throw new StorePublishError(`缺少 ${ENV.extensionId} 或 ${ENV.publisherId}`);
  }
  if (serviceAccountRaw.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(serviceAccountRaw);
    } catch {
      throw new StorePublishError(`${ENV.serviceAccount} 不是 JSON`);
    }
    return { kind: "service-account", extensionId, publisherId, serviceAccount: parsed, clientSecret, refreshToken };
  }
  if (clientId && clientSecret && refreshToken) {
    return { kind: "refresh-token", extensionId, publisherId, clientId, clientSecret, refreshToken };
  }
  throw new StorePublishError(
    `缺少商店凭据。优先设置 ${ENV.serviceAccount}；或者同时设置 ${ENV.clientId}、${ENV.clientSecret}、${ENV.refreshToken}`,
  );
}

export async function authorize(credentials, fetchImpl, nowSeconds) {
  if (credentials.kind === "service-account") {
    return accessTokenFromServiceAccount(credentials.serviceAccount, fetchImpl, nowSeconds);
  }
  return accessTokenFromRefreshToken(credentials, fetchImpl);
}

function statusUrl(name) {
  return `${API_ORIGIN}/${name}:fetchStatus`;
}

function uploadUrl(name) {
  return `${UPLOAD_ORIGIN}/${name}:upload`;
}

function publishUrl(name) {
  return `${API_ORIGIN}/${name}:publish`;
}

async function fetchStatus(fetchImpl, name, token, secrets) {
  return request(fetchImpl, statusUrl(name), { method: "GET", token, secrets });
}

async function waitForUpload(fetchImpl, name, token, secrets, sleep, { attempts = 24, delayMs = 5000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const last = await fetchStatus(fetchImpl, name, token, secrets);
    const state = last?.lastAsyncUploadState;
    if (SUCCEEDED.has(state)) return last;
    if (FAILED.has(state)) throw new StorePublishError("商店报告上传失败，停止送审");
    if (!IN_PROGRESS.has(state)) {
      throw new StorePublishError(`无法识别的上传状态 ${state ?? "空"}，停止送审`);
    }
    await sleep(delayMs);
  }
  throw new StorePublishError("上传长时间停在进行中，停止送审");
}

/**
 * 上传 ZIP、确认 crxVersion，再以 STAGED_PUBLISH 送审。
 * 任一步失败都会抛出，调用方不得继续上线。
 */
export async function publishPackage({
  version,
  extensionId,
  expectedExtensionId,
  publisherId,
  accessToken,
  zipBytes,
  listing,
  fetchImpl,
  sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
  poll = {},
}) {
  if (extensionId !== expectedExtensionId) {
    throw new StorePublishError("CHROME_EXTENSION_ID 与 manifest.json 公钥算出的扩展 ID 不一致，停止发布");
  }
  assertZipListing(listing);
  const name = itemName(publisherId, extensionId);
  const secrets = secretValues({ accessToken });
  const status = await fetchStatus(fetchImpl, name, accessToken, secrets);
  assertUploadAllowed(status, version);

  let uploaded;
  try {
    uploaded = await request(fetchImpl, uploadUrl(name), {
      method: "POST",
      token: accessToken,
      headers: { "Content-Type": "application/zip" },
      body: zipBytes,
      secrets,
    });
  } catch (error) {
    if (error instanceof StorePublishError && uploadErrorIsSameVersion(error.body, version)) {
      uploaded = { uploadState: "SUCCEEDED", crxVersion: version, reusedDraft: true };
    } else {
      throw error;
    }
  }

  if (IN_PROGRESS.has(uploaded?.uploadState)) {
    await waitForUpload(fetchImpl, name, accessToken, secrets, sleep, poll);
  } else if (!SUCCEEDED.has(uploaded?.uploadState)) {
    throw new StorePublishError(`上传没有成功（${uploaded?.uploadState ?? "没有状态"}），停止送审`);
  } else if (uploaded?.crxVersion !== version) {
    throw new StorePublishError(`商店收到的版本是 ${uploaded?.crxVersion ?? "空"}，不是 ${version}，停止送审`);
  }

  const submitted = await request(fetchImpl, publishUrl(name), {
    method: "POST",
    token: accessToken,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publishType: "STAGED_PUBLISH", skipReview: false, blockOnWarnings: true }),
    secrets,
  });
  if (submitted?.state === "PUBLISHED" || submitted?.state === "PUBLISHED_TO_TESTERS") {
    throw new StorePublishError(`送审接口把版本直接公开成 ${submitted.state}，没有停在待上线。请到 Developer Dashboard 核对`);
  }
  if (submitted?.state !== "PENDING_REVIEW" && submitted?.state !== "STAGED") {
    throw new StorePublishError(`送审后的状态是 ${submitted?.state ?? "空"}，不是 PENDING_REVIEW 或 STAGED`);
  }

  const confirmed = await confirmSubmission(fetchImpl, name, accessToken, secrets, version, sleep, poll);
  return {
    version,
    uploadState: uploaded.uploadState,
    reusedDraft: Boolean(uploaded.reusedDraft),
    submissionState: confirmed.submittedItemRevisionStatus.state,
  };
}

async function confirmSubmission(fetchImpl, name, token, secrets, version, sleep, poll) {
  const attempts = poll.confirmAttempts ?? 6;
  const delayMs = poll.delayMs ?? 5000;
  let confirmed = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    confirmed = await fetchStatus(fetchImpl, name, token, secrets);
    const submittedVersions = channelVersions(confirmed?.submittedItemRevisionStatus);
    const confirmedState = confirmed?.submittedItemRevisionStatus?.state;
    if (submittedVersions.includes(version) && (confirmedState === "PENDING_REVIEW" || confirmedState === "STAGED")) {
      return confirmed;
    }
    await sleep(delayMs);
  }
  await cancelSubmission(fetchImpl, name, token, secrets);
  const submittedVersions = channelVersions(confirmed?.submittedItemRevisionStatus);
  const confirmedState = confirmed?.submittedItemRevisionStatus?.state;
  throw new StorePublishError(
    `送审后的商店状态对不上：版本 ${submittedVersions.join(",") || "空"}，状态 ${confirmedState ?? "空"}。已尝试取消这次送审`,
  );
}

async function cancelSubmission(fetchImpl, name, token, secrets) {
  try {
    await request(fetchImpl, `${API_ORIGIN}/${name}:cancelSubmission`, {
      method: "POST",
      token,
      secrets,
    });
  } catch {
    // 取消失败不能掩盖原来的状态错误。
  }
}

/** 审核已通过并处于 STAGED 时，由维护者显式调用，才会真正公开。 */
export async function releaseStaged({
  version,
  extensionId,
  expectedExtensionId,
  publisherId,
  accessToken,
  fetchImpl,
}) {
  if (extensionId !== expectedExtensionId) {
    throw new StorePublishError("CHROME_EXTENSION_ID 与 manifest.json 公钥算出的扩展 ID 不一致，停止上线");
  }
  const name = itemName(publisherId, extensionId);
  const secrets = secretValues({ accessToken });
  const status = await fetchStatus(fetchImpl, name, accessToken, secrets);
  const versions = channelVersions(status.submittedItemRevisionStatus);
  const state = status.submittedItemRevisionStatus?.state;
  if (state !== "STAGED" || !versions.includes(version)) {
    throw new StorePublishError(
      `不能上线：商店待发布状态是 ${state ?? "空"}，版本是 ${versions.join(",") || "空"}，本地扩展版本是 ${version}`,
    );
  }
  const released = await request(fetchImpl, publishUrl(name), {
    method: "POST",
    token: accessToken,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH", skipReview: false }),
    secrets,
  });
  if (released?.state !== "PUBLISHED") {
    throw new StorePublishError(`正式上线没有被接受，状态是 ${released?.state ?? "空"}。可以改在 Developer Dashboard 里发布已暂存的版本`);
  }
  return { version, state: released.state };
}

export function publicStatus(status) {
  return {
    publishedVersions: channelVersions(status?.publishedItemRevisionStatus),
    submittedVersions: channelVersions(status?.submittedItemRevisionStatus),
    submittedState: status?.submittedItemRevisionStatus?.state ?? null,
    uploadState: status?.lastAsyncUploadState ?? null,
    takenDown: Boolean(status?.takenDown),
    warned: Boolean(status?.warned),
  };
}

function readManifest(root) {
  return JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  return argv[index + 1] ?? "";
}

export function listZip(zipPath) {
  let listing;
  try {
    listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
  } catch (error) {
    throw new StorePublishError(`无法列出 ZIP 内容：${error instanceof Error ? error.message : error}`);
  }
  return parseUnzipListing(listing);
}

export function readZipManifest(zipPath) {
  let raw;
  try {
    raw = execFileSync("unzip", ["-p", zipPath, "manifest.json"], { encoding: "utf8" });
  } catch (error) {
    throw new StorePublishError(`无法从 ZIP 读出 manifest.json：${error instanceof Error ? error.message : error}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new StorePublishError("ZIP 里的 manifest.json 不是 JSON");
  }
}

export async function main(argv, env = process.env, io = {}) {
  const command = argv[0];
  const root = io.root ?? repoRoot();
  const manifest = io.manifest ?? readManifest(root);
  const fetchImpl = io.fetchImpl ?? globalThis.fetch;
  const log = io.log ?? console.log;
  if (command === "zip-name") {
    log(chromeZipName(extensionVersion(manifest)));
    return;
  }
  if (command === "check-release") {
    const tag = flag(argv, "--tag");
    if (!tag) throw new StorePublishError("check-release 需要 --tag");
    const prerelease = flag(argv, "--prerelease") === "true";
    const version = assertReleaseMatchesManifest({ tag, manifest, prerelease });
    log(`release ${tag} matches extension ${version}`);
    return;
  }
  if (command === "verify-zip") {
    const zipPath = flag(argv, "--zip");
    if (!zipPath) throw new StorePublishError("verify-zip 需要 --zip");
    const listing = listZip(zipPath);
    assertZipListing(listing);
    const packed = readZipManifest(zipPath);
    if (packed.version !== extensionVersion(manifest)) {
      throw new StorePublishError(`ZIP 版本是 ${packed.version}，仓库 manifest 是 ${manifest.version}`);
    }
    log(`zip ${listing.length} files, version ${packed.version}`);
    return;
  }
  if (command === "publish" && argv.includes("--dry-run")) {
    const version = extensionVersion(manifest);
    const zipPath = flag(argv, "--zip");
    if (zipPath) {
      assertZipListing(listZip(zipPath));
      const packed = readZipManifest(zipPath);
      if (packed.version !== version) {
        throw new StorePublishError(`ZIP 版本是 ${packed.version}，仓库 manifest 是 ${version}`);
      }
    }
    log(`dry-run: would upload ${chromeZipName(version)} and submit STAGED_PUBLISH. no store request sent`);
    return;
  }
  if (command === "publish" || command === "status" || command === "release-staged") {
    const credentials = credentialsFromEnv(env);
    const expectedExtensionId = extensionIdFromPublicKey(manifest.key);
    const token = await authorize(credentials, fetchImpl);
    const secrets = secretValues({
      accessToken: token,
      privateKey: credentials.serviceAccount?.private_key,
      clientSecret: credentials.clientSecret,
      refreshToken: credentials.refreshToken,
    });
    try {
      if (command === "status") {
        const status = await fetchStatus(fetchImpl, itemName(credentials.publisherId, credentials.extensionId), token, secrets);
        log(JSON.stringify(publicStatus(status)));
        return;
      }
      if (command === "release-staged") {
        const result = await releaseStaged({
          version: extensionVersion(manifest),
          extensionId: credentials.extensionId,
          expectedExtensionId,
          publisherId: credentials.publisherId,
          accessToken: token,
          fetchImpl,
        });
        log(`released ${result.version}: ${result.state}`);
        return;
      }
      const zipPath = flag(argv, "--zip");
      if (!zipPath) throw new StorePublishError("publish 需要 --zip");
      const listing = listZip(zipPath);
      const packed = readZipManifest(zipPath);
      const version = extensionVersion(manifest);
      if (packed.version !== version) {
        throw new StorePublishError(`ZIP 版本是 ${packed.version}，仓库 manifest 是 ${version}`);
      }
      const result = await publishPackage({
        version,
        extensionId: credentials.extensionId,
        expectedExtensionId,
        publisherId: credentials.publisherId,
        accessToken: token,
        zipBytes: readFileSync(zipPath),
        listing,
        fetchImpl,
        sleep: io.sleep,
      });
      log(`submitted ${result.version}: ${result.submissionState}${result.reusedDraft ? " (reused existing draft)" : ""}`);
    } catch (error) {
      throw new StorePublishError(redact(error instanceof Error ? error.message : error, secrets));
    }
  } else {
    throw new StorePublishError("用法：zip-name | check-release --tag | verify-zip --zip | publish --zip [--dry-run] | status | release-staged");
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
