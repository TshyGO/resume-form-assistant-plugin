"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"),
);

test("web_accessible_resources 保持人工审过的最小列表", () => {
  assert.deepEqual(manifest.web_accessible_resources, [
    {
      resources: ["link/*.mjs", "link/protocol/*.mjs", "popup.html", "content.css"],
      matches: ["<all_urls>"],
    },
  ]);
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
