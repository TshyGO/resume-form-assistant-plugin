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
      resources: ["link/*.mjs", "link/protocol/*.mjs", "popup.html", "content.css"],
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
  ]) {
    assert.ok(
      !exposed.some((resource) => resource.includes(forbidden)),
      `${forbidden} 不能重新变成 web accessible`,
    );
  }
});

test("内容脚本可达的 getURL 资源全部被 WAR 覆盖", () => {
  const war = manifest.web_accessible_resources.flatMap((entry) => entry.resources);
  const found = [];
  for (const file of manifest.content_scripts.flatMap((entry) => entry.js)) {
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
