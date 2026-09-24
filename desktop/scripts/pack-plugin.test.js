import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ARCHIVE_OPERANDS, packPlugin } from "./pack-plugin.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");

test("清单覆盖插件运行文件，不含 desktop", () => {
  for (const required of ["manifest.json", "background.js", "content.js", "sidepanel.html", "sidepanel.css", "sidepanel.js", "link", "icons"]) {
    assert.ok(PLUGIN_ARCHIVE_OPERANDS.includes(required), required);
  }
  assert.equal(
    PLUGIN_ARCHIVE_OPERANDS.some((entry) => entry === "desktop" || entry.startsWith("desktop/")),
    false,
  );
  const leaves = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", "HEAD", "--", ...PLUGIN_ARCHIVE_OPERANDS],
    { cwd: repo, encoding: "utf8" },
  )
    .trim()
    .split(/\r?\n/);
  assert.ok(leaves.includes("manifest.json"));
  assert.ok(leaves.some((name) => name.startsWith("link/")));
  assert.equal(
    leaves.some((name) => name === "desktop" || name.startsWith("desktop/")),
    false,
  );
});

test("打出来的是一份真正的 zip", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-pack-"));
  const zip = join(dir, "resume-pro-plugin-0.4.0.zip");
  const packed = packPlugin(repo, zip);
  assert.equal(packed, zip);
  assert.ok(statSync(zip).size > 0);
  // PK\x03\x04：不依赖 unzip，Windows runner 上也过。
  assert.equal(readFileSync(zip).subarray(0, 2).toString("utf8"), "PK");
});

test("输出不是 zip 就拒绝", () => {
  assert.throws(() => packPlugin(repo, join(tmpdir(), "plugin.tar")), /\.zip/);
});
