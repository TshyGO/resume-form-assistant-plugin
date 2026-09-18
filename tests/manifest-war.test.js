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
      resources: ["link/*.mjs", "link/protocol/*.mjs", "content.css"],
      matches: ["<all_urls>"],
    },
  ]);
});

test("申报权限与隐私政策逐条对应，没有悄悄加权限", () => {
  assert.deepStrictEqual(
    new Set(manifest.permissions),
    new Set(["offscreen", "storage", "scripting", "activeTab", "tabs", "nativeMessaging", "alarms"]),
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

test("注入网页的 CSS 没有漏申报的扩展资源", () => {
  for (const file of manifest.content_scripts.flatMap((entry) => entry.css || [])) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.doesNotMatch(source, /url\s*\(/i, `${file} 新增 url(...) 后要同步审查 WAR`);
  }
});
