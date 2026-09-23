import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packPlugin } from "./pack-plugin.js";
import {
  ENV,
  StorePublishError,
  assertReleaseMatchesManifest,
  assertUploadAllowed,
  assertZipListing,
  buildServiceAccountAssertion,
  chromeZipName,
  credentialsFromEnv,
  extensionIdFromPublicKey,
  extensionVersion,
  parseUnzipListing,
  publicStatus,
  publishPackage,
  redact,
  releaseStaged,
  uploadErrorIsSameVersion,
  verifyServiceAccountAssertion,
  main,
} from "./chrome-web-store.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const manifest = JSON.parse(readFileSync(join(repo, "manifest.json"), "utf8"));
const storeId = "diagjmploldedipjdenmecmjokckelkl";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

test("扩展版本和商店 ZIP 名字只接受三段数字", () => {
  assert.equal(extensionVersion({ version: "0.4.0" }), "0.4.0");
  assert.equal(chromeZipName("0.4.1"), "resume-pro-v0.4.1-chrome.zip");
  assert.throws(() => extensionVersion({ version: "0.4.0-beta.1" }), StorePublishError);
  assert.throws(() => chromeZipName("v0.4.0"), StorePublishError);
});

test("manifest 公钥算出的 ID 就是商店那条", () => {
  assert.equal(extensionIdFromPublicKey(manifest.key), storeId);
});

test("正式 Release 的 tag 必须等于 v加扩展版本，预发布不送审", () => {
  assert.equal(assertReleaseMatchesManifest({ tag: "v0.4.0", manifest: { version: "0.4.0" } }), "0.4.0");
  assert.throws(() => assertReleaseMatchesManifest({ tag: "desktop-v0.4.0", manifest: { version: "0.4.0" } }), /v0\.4\.0/);
  assert.throws(() => assertReleaseMatchesManifest({ tag: "v0.4.1", manifest: { version: "0.4.0" } }), /v0\.4\.0/);
  assert.throws(
    () => assertReleaseMatchesManifest({ tag: "v0.4.0", manifest: { version: "0.4.0" }, prerelease: true }),
    /Pre-release/,
  );
});

test("同一版本已经在线上、审核中或上传中时拒绝再上传", () => {
  const published = {
    publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "0.4.0" }] },
  };
  assert.throws(() => assertUploadAllowed(published, "0.4.0"), /线上版本/);
  assertUploadAllowed(published, "0.4.1");
  assert.throws(() => assertUploadAllowed({
    submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: "0.4.1" }] },
  }, "0.4.1"), /PENDING_REVIEW/);
  assert.throws(() => assertUploadAllowed({
    submittedItemRevisionStatus: { state: "STAGED", distributionChannels: [{ crxVersion: "0.4.1" }] },
  }, "0.4.1"), /STAGED/);
  assert.throws(() => assertUploadAllowed({ lastAsyncUploadState: "IN_PROGRESS" }, "0.4.1"), /进行中/);
  assert.throws(() => assertUploadAllowed({ takenDown: true }, "0.4.1"), /下架/);
});

test("服务账号 JWT 用商店 scope 签名，refresh token 只在没有服务账号时使用", () => {
  const { privateKeyPem, publicKeyPem } = keyPair();
  const assertion = buildServiceAccountAssertion({
    client_email: "publisher@example.iam.gserviceaccount.com",
    private_key: privateKeyPem,
  }, 1_700_000_000);
  assert.equal(verifyServiceAccountAssertion(assertion, publicKeyPem), true);
  const payload = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString());
  assert.equal(payload.iss, "publisher@example.iam.gserviceaccount.com");
  assert.equal(payload.scope, "https://www.googleapis.com/auth/chromewebstore");
  assert.equal(payload.aud, "https://oauth2.googleapis.com/token");
  assert.equal(credentialsFromEnv({
    [ENV.extensionId]: storeId,
    [ENV.publisherId]: "pub-1",
    [ENV.serviceAccount]: JSON.stringify({ client_email: "a@b.c", private_key: privateKeyPem }),
    [ENV.refreshToken]: "should-not-be-used",
  }).kind, "service-account");
  assert.equal(credentialsFromEnv({
    [ENV.extensionId]: storeId,
    [ENV.publisherId]: "pub-1",
    [ENV.clientId]: "id",
    [ENV.clientSecret]: "secret",
    [ENV.refreshToken]: "refresh",
  }).kind, "refresh-token");
  assert.throws(() => credentialsFromEnv({ [ENV.extensionId]: storeId }), /CHROME_PUBLISHER_ID/);
  assert.throws(() => credentialsFromEnv({
    [ENV.extensionId]: storeId,
    [ENV.publisherId]: "pub-1",
  }), /缺少商店凭据/);
});

test("报错里不留下私钥、refresh token 或 access token", () => {
  const { privateKeyPem } = keyPair();
  const cleaned = redact(`token ya29.secret key ${privateKeyPem} refresh 1/refresh-token`, [
    "ya29.secret",
    privateKeyPem,
    "1/refresh-token",
  ]);
  assert.equal(cleaned.includes("ya29.secret"), false);
  assert.equal(cleaned.includes(privateKeyPem), false);
  assert.equal(cleaned.includes("1/refresh-token"), false);
});

test("ZIP 清单拒绝源码、依赖和凭据路径", () => {
  assertZipListing(["manifest.json", "background.js", "link/worker.mjs"]);
  for (const bad of ["desktop/README.md", "node_modules/leftpad/index.js", "../manifest.json", ".env", "secrets/key.pem"]) {
    assert.throws(() => assertZipListing(["manifest.json", bad]), StorePublishError);
  }
  const listing = parseUnzipListing(`
Archive:  demo.zip
  Length      Date    Time    Name
---------  ---------- -----   ----
     12  09-23-2026 10:00   manifest.json
      4  09-23-2026 10:00   link/worker.mjs
---------                     -------
  `);
  assert.deepEqual(listing, ["manifest.json", "link/worker.mjs"]);
});

test("上传成功后只送审，不直接公开；版本对不上就不再 publish", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body });
    if (String(url).endsWith(":fetchStatus") && calls.filter((call) => call.url.endsWith(":fetchStatus")).length === 1) {
      return jsonResponse({
        publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "0.3.1" }] },
      });
    }
    if (String(url).endsWith(":upload")) {
      return jsonResponse({ uploadState: "SUCCEEDED", crxVersion: "0.4.0", itemId: storeId });
    }
    if (String(url).endsWith(":publish")) {
      const body = JSON.parse(options.body);
      assert.equal(body.publishType, "STAGED_PUBLISH");
      assert.equal(body.skipReview, false);
      return jsonResponse({ state: "PENDING_REVIEW", itemId: storeId });
    }
    return jsonResponse({
      submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: "0.4.0" }] },
    });
  };
  const result = await publishPackage({
    version: "0.4.0",
    extensionId: storeId,
    expectedExtensionId: storeId,
    publisherId: "pub-1",
    accessToken: "ya29.test-token",
    zipBytes: Buffer.from("zip"),
    listing: ["manifest.json"],
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(result.submissionState, "PENDING_REVIEW");
  assert.equal(calls.some((call) => String(call.url).endsWith(":publish")), true);
  assert.equal(calls.some((call) => String(call.body ?? "").includes("ya29.test-token")), false);

  const stopped = [];
  await assert.rejects(() => publishPackage({
    version: "0.4.0",
    extensionId: storeId,
    expectedExtensionId: storeId,
    publisherId: "pub-1",
    accessToken: "ya29.test-token",
    zipBytes: Buffer.from("zip"),
    listing: ["manifest.json"],
    fetchImpl: async (url) => {
      stopped.push(url);
      if (String(url).endsWith(":fetchStatus")) {
        return jsonResponse({ publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: "0.3.1" }] } });
      }
      return jsonResponse({ uploadState: "SUCCEEDED", crxVersion: "0.3.9" });
    },
    sleep: async () => {},
  }), /不是 0\.4\.0/);
  assert.equal(stopped.some((url) => String(url).endsWith(":publish")), false);
});

test("上传还在处理时等到成功再送审；上传失败则不送审", async () => {
  let polls = 0;
  const calls = [];
  const result = await publishPackage({
    version: "0.4.0",
    extensionId: storeId,
    expectedExtensionId: storeId,
    publisherId: "pub_1",
    accessToken: "token-value",
    zipBytes: Buffer.from("zip"),
    listing: ["manifest.json"],
    poll: { attempts: 3, delayMs: 1 },
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      if (String(url).endsWith(":upload")) return jsonResponse({ uploadState: "IN_PROGRESS" });
      if (String(url).endsWith(":publish")) return jsonResponse({ state: "STAGED" });
      if (String(url).endsWith(":fetchStatus")) {
        polls += 1;
        if (polls === 1) return jsonResponse({});
        if (polls === 2) return jsonResponse({ lastAsyncUploadState: "IN_PROGRESS" });
        return jsonResponse({
          lastAsyncUploadState: polls === 3 ? "SUCCEEDED" : undefined,
          submittedItemRevisionStatus: { state: "STAGED", distributionChannels: [{ crxVersion: "0.4.0" }] },
        });
      }
      throw new Error(`unexpected ${url} ${options.method}`);
    },
  });
  assert.equal(result.submissionState, "STAGED");

  const failedCalls = [];
  await assert.rejects(() => publishPackage({
    version: "0.4.0",
    extensionId: storeId,
    expectedExtensionId: storeId,
    publisherId: "pub_1",
    accessToken: "token-value",
    zipBytes: Buffer.from("zip"),
    listing: ["manifest.json"],
    fetchImpl: async (url) => {
      failedCalls.push(String(url));
      if (String(url).endsWith(":fetchStatus")) return jsonResponse({});
      return jsonResponse({ error: { message: "bad zip" } }, 400);
    },
    sleep: async () => {},
  }), /HTTP 400/);
  assert.equal(failedCalls.some((url) => url.endsWith(":publish")), false);
});

test("草稿里已经有同一版本时不再上传一次，直接送审", async () => {
  const calls = [];
  await publishPackage({
    version: "0.4.0",
    extensionId: storeId,
    expectedExtensionId: storeId,
    publisherId: "pub-1",
    accessToken: "token-value",
    zipBytes: Buffer.from("zip"),
    listing: ["manifest.json"],
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method });
      if (String(url).endsWith(":fetchStatus") && calls.filter((call) => call.url.endsWith(":fetchStatus")).length === 1) {
        return jsonResponse({ publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: "0.3.1" }] } });
      }
      if (String(url).endsWith(":upload")) {
        return jsonResponse({
          error: { message: "version 0.4.0 already exists" },
        }, 400);
      }
      if (String(url).endsWith(":publish")) return jsonResponse({ state: "PENDING_REVIEW" });
      return jsonResponse({
        submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: "0.4.0" }] },
      });
    },
    sleep: async () => {},
  });
  assert.equal(calls.filter((call) => call.url.endsWith(":upload")).length, 1);
  assert.equal(uploadErrorIsSameVersion({ error: { message: "version 0.4.0 already exists" } }, "0.4.0"), true);
  assert.equal(uploadErrorIsSameVersion({ error: { message: "quota" } }, "0.4.0"), false);
});

test("扩展 ID 不一致或直接公开时立刻停止", async () => {
  await assert.rejects(() => publishPackage({
    version: "0.4.0",
    extensionId: "a".repeat(32),
    expectedExtensionId: storeId,
    publisherId: "pub-1",
    accessToken: "token-value",
    zipBytes: Buffer.from("zip"),
    listing: ["manifest.json"],
    fetchImpl: async () => {
      throw new Error("should not be called");
    },
  }), /不一致/);
  await assert.rejects(() => publishPackage({
    version: "0.4.0",
    extensionId: storeId,
    expectedExtensionId: storeId,
    publisherId: "pub-1",
    accessToken: "token-value",
    zipBytes: Buffer.from("zip"),
    listing: ["manifest.json"],
    fetchImpl: async (url) => {
      if (String(url).endsWith(":fetchStatus")) {
        return jsonResponse({ publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: "0.3.0" }] } });
      }
      if (String(url).endsWith(":upload")) return jsonResponse({ uploadState: "SUCCEEDED", crxVersion: "0.4.0" });
      return jsonResponse({ state: "PUBLISHED" });
    },
  }), /直接公开/);
});

test("只有 STAGED 且版本一致才允许维护者正式上线", async () => {
  const released = await releaseStaged({
    version: "0.4.0",
    extensionId: storeId,
    expectedExtensionId: storeId,
    publisherId: "pub-1",
    accessToken: "token-value",
    fetchImpl: async (url, options) => {
      if (String(url).endsWith(":fetchStatus")) {
        return jsonResponse({
          submittedItemRevisionStatus: { state: "STAGED", distributionChannels: [{ crxVersion: "0.4.0" }] },
        });
      }
      assert.equal(JSON.parse(options.body).publishType, "DEFAULT_PUBLISH");
      return jsonResponse({ state: "PUBLISHED" });
    },
  });
  assert.equal(released.state, "PUBLISHED");
  await assert.rejects(() => releaseStaged({
    version: "0.4.0",
    extensionId: storeId,
    expectedExtensionId: storeId,
    publisherId: "pub-1",
    accessToken: "token-value",
    fetchImpl: async () => jsonResponse({
      submittedItemRevisionStatus: { state: "PENDING_REVIEW", distributionChannels: [{ crxVersion: "0.4.0" }] },
    }),
  }), /不能上线/);
});

test("status 只打印版本和状态，不打印 token", async () => {
  const lines = [];
  await main(["status"], {
    [ENV.extensionId]: storeId,
    [ENV.publisherId]: "pub-1",
    [ENV.clientId]: "client",
    [ENV.clientSecret]: "super-secret-value",
    [ENV.refreshToken]: "refresh-token-value",
  }, {
    manifest,
    log: (line) => lines.push(line),
    fetchImpl: async (url, options) => {
      const raw = JSON.stringify(options.body ?? "");
      assert.equal(raw.includes("super-secret-value"), false);
      if (String(url).includes("oauth2.googleapis.com")) {
        return jsonResponse({ access_token: "ya29.status-token" });
      }
      return jsonResponse({
        publishedItemRevisionStatus: { state: "PUBLISHED", distributionChannels: [{ crxVersion: "0.3.1" }] },
        submittedItemRevisionStatus: { state: "STAGED", distributionChannels: [{ crxVersion: "0.4.0" }] },
        lastAsyncUploadState: "SUCCEEDED",
      });
    },
  });
  const printed = lines.join("\n");
  assert.match(printed, /0\.4\.0/);
  assert.equal(printed.includes("ya29.status-token"), false);
  assert.equal(printed.includes("super-secret-value"), false);
  assert.deepEqual(publicStatus({
    publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: "0.3.1" }] },
    submittedItemRevisionStatus: { state: "STAGED", distributionChannels: [{ crxVersion: "0.4.0" }] },
  }).submittedState, "STAGED");
});

test("dry-run 不访问商店，真实 ZIP 能被本地校验", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cws-zip-"));
  const zip = packPlugin(repo, join(dir, chromeZipName(manifest.version)));
  let called = false;
  const lines = [];
  await main(["publish", "--zip", zip, "--dry-run"], {}, {
    manifest,
    log: (line) => lines.push(line),
    fetchImpl: async () => {
      called = true;
      throw new Error("dry-run must not fetch");
    },
  });
  assert.equal(called, false);
  assert.match(lines.join("\n"), /STAGED_PUBLISH/);
  await main(["verify-zip", "--zip", zip], {}, { manifest, log: () => {} });
  await main(["check-release", "--tag", `v${manifest.version}`], {}, { manifest, log: () => {} });
});

test("发布工作流只在正式 GitHub Release 时送审，并且复用 pack-plugin", () => {
  const workflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8").split("\r\n").join("\n");
  const desktop = readFileSync(join(repo, ".github", "workflows", "desktop-release.yml"), "utf8");
  const testWorkflow = readFileSync(join(repo, ".github", "workflows", "test.yml"), "utf8");
  assert.match(workflow, /release:\n\s+types:\s*\[published\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /dry_run:/);
  assert.match(workflow, /release_staged:/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
  assert.match(workflow, /desktop\/scripts\/pack-plugin\.js/);
  assert.match(workflow, /desktop\/scripts\/chrome-web-store\.js publish/);
  assert.match(workflow, /desktop\/scripts\/chrome-web-store\.js release-staged/);
  assert.match(workflow, /npm run typecheck/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /check-plugin-release-allowlist\.js/);
  assert.match(workflow, /merge-base --is-ancestor/);
  assert.match(workflow, /CHROME_WEB_STORE_CREDENTIALS/);
  assert.match(workflow, /CHROME_PUBLISHER_ID/);
  assert.doesNotMatch(workflow, /pull_request:/);
  assert.doesNotMatch(workflow, /\n {2}push:\n/);
  assert.doesNotMatch(workflow, /private_key/);
  assert.doesNotMatch(workflow, /ya29\./);
  assert.match(testWorkflow, /pull_request:/);
  assert.match(testWorkflow, /push:/);
  assert.doesNotMatch(desktop, /chrome-web-store\.js/);
  assert.match(desktop, /desktop-v\*/);
});
