"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

function warMatches(resource, pattern) {
  if (!pattern.includes("*")) return resource === pattern;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(resource);
}

test("web_accessible_resources 保持人工审过的最小列表", () => {
  assert.deepStrictEqual(manifest.web_accessible_resources, [
    {
      resources: [
        "link/copy.mjs",
        "link/extract.mjs",
        "link/fillrecords.mjs",
        "link/limits.mjs",
        "link/redact.mjs",
        "link/secret-fields.mjs",
        "link/snapshot.mjs",
        "link/protocol/schema-data.mjs",
        "link/protocol/schema-lite.mjs",
        "link/protocol/time.mjs",
        "link/protocol/validate.mjs",
        "content.css",
      ],
      matches: ["<all_urls>"],
    },
  ]);
});

test("manifest 权限集合被锁定，没有悄悄加权限", () => {
  assert.deepStrictEqual(
    new Set(manifest.permissions),
    new Set(["offscreen", "storage", "tabs", "nativeMessaging", "alarms"]),
  );
  assert.deepStrictEqual(manifest.host_permissions, ["<all_urls>"]);
});

test("扩展页面自己的子资源不能重新对网页开放", () => {
  const exposed = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  for (const forbidden of [
    "popup.js",
    "popup.css",
    "xlsx.full.min.js",
    "mammoth.browser.min.js",
    "vendor/pdfjs",
    "icons/",
    "popup.html",
  ]) {
    assert.ok(
      !exposed.some((resource) => resource.includes(forbidden)),
      `${forbidden} 不能重新变成 web accessible`,
    );
  }
});

test("管理面板不再通过网页 iframe 暴露", () => {
  const exposed = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.equal(exposed.includes("popup.html"), false);
  assert.equal(manifest.externally_connectable, undefined);
});

test("service worker 专用模块不对网页暴露", () => {
  const exposed = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  for (const resource of ["link/worker.mjs", "link/chrome.mjs", "link/transport.mjs"]) {
    assert.equal(exposed.includes(resource), false, `${resource} 只能在 service worker 内运行`);
  }
  assert.equal(exposed.some((resource) => resource.includes("*")), false);
});

test("内容脚本及其动态模块可达的 getURL 资源全部被 WAR 覆盖", () => {
  const war = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  const found = [];
  const linkModules = fs.readdirSync(path.join(ROOT, "link"), { recursive: true })
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => path.join("link", file));
  const pageContextFiles = [
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    ...linkModules,
  ];
  for (const file of pageContextFiles) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const match of source.matchAll(/getURL\(\s*["']([^"']+)["']\s*\)/g)) {
      found.push({ file, resource: match[1] });
    }
  }
  for (const { file, resource } of found) {
    assert.ok(
      war.some((pattern) => warMatches(resource, pattern)),
      `${file} loads ${resource} but it is not covered by web_accessible_resources`,
    );
  }
});

test("内容脚本动态入口的静态 import 图全部被 WAR 覆盖", () => {
  const war = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  const roots = [];
  for (const file of manifest.content_scripts.flatMap((entry) => entry.js)) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    for (const match of source.matchAll(/getURL\(\s*["']([^"']+\.mjs)["']\s*\)/g)) {
      roots.push(match[1]);
    }
  }

  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(war.includes(file), `${file} 是页面侧 import 依赖，但不在 WAR 白名单`);
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const imports = source.matchAll(
      /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/g,
    );
    for (const match of imports) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      if (resolved.endsWith(".mjs")) queue.push(resolved);
    }
  }

  assert.ok(seen.has("link/extract.mjs"));
  assert.ok(seen.has("link/protocol/validate.mjs"));
  assert.equal(seen.has("link/worker.mjs"), false);
});

test("注入网页的 CSS 没有漏申报的扩展资源", () => {
  for (const file of manifest.content_scripts.flatMap((entry) => entry.css || [])) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(source, /url\s*\(/i, `${file} 新增 url(...) 后要同步审查 WAR`);
  }
});
