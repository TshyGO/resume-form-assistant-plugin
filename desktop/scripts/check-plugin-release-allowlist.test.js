import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertPluginOnlyArchive,
  assertRuntimeModulesPackaged,
  collectModuleGraph,
  manifestEntryPoints,
  parseGitArchiveEntries,
} from "./check-plugin-release-allowlist.js";

const sample = `
        run: |
          git archive --format=zip --output="$ZIP_NAME" HEAD \\
            manifest.json background.js content.js content.css \\
            LICENSE
          echo "ZIP_NAME=$ZIP_NAME" >> $GITHUB_ENV
`;

test("parses exact git archive entries", () => {
  const entries = parseGitArchiveEntries(sample);
  assert.deepEqual(entries, [
    "manifest.json",
    "background.js",
    "content.js",
    "content.css",
    "LICENSE",
  ]);
});

test("desktop without slash is rejected", () => {
  assert.throws(
    () => assertPluginOnlyArchive(["manifest.json", "desktop", "content.js", "content.css", "background.js", "LICENSE"]),
    /desktop/,
  );
});

test("desktop/ prefix is rejected", () => {
  assert.throws(
    () => assertPluginOnlyArchive(["manifest.json", "desktop/README.md", "content.js", "content.css", "background.js", "LICENSE"]),
    /desktop/,
  );
});

test("content.js.map does not satisfy content.js", () => {
  assert.throws(
    () => assertPluginOnlyArchive(["manifest.json", "background.js", "content.js.map", "content.css", "LICENSE"]),
    /content\.js/,
  );
});

test('unknown files and forbidden subdirectories are not allowed',()=>{
 for(const extra of ['private.key','src-tauri/src/main.rs','target/debug/app.exe','vendor','icons','vendor/private.key','icons/private.key','icons/icon16.png/private.key']) {
   assert.throws(()=>assertPluginOnlyArchive(['manifest.json','background.js','content.js','content.css','LICENSE',extra]));
 }
});

// --- runtime module packaging -------------------------------------------------
// Regression cover for the break these functions exist to catch: background.js
// became a module importing ./link/worker.mjs, while release.yml still packed a
// file list with no link operand. The archive stayed allowlist-clean, so nothing
// failed, and the shipped service worker could not have loaded.

test("manifest entry points cover the service worker and content scripts", () => {
  const entries = manifestEntryPoints({
    background: { service_worker: "background.js", type: "module" },
    content_scripts: [{ js: ["a.js", "content.js"], css: ["content.css"] }],
  });
  assert.deepEqual(entries, ["background.js", "a.js", "content.js", "content.css"]);
});

test("module graph follows relative imports transitively", () => {
  const files = {
    "background.js": `import { installDesktopLink } from "./link/worker.mjs";`,
    "link/worker.mjs": `import { createStore } from './store.mjs';\nimport { RULES } from './protocol/schema-lite.mjs';`,
    "link/store.mjs": `export const x = 1;`,
    "link/protocol/schema-lite.mjs": `import { isUtcTimestamp } from "./time.mjs";`,
    "link/protocol/time.mjs": `export const t = 1;`,
  };
  const graph = collectModuleGraph(["background.js"], (f) => files[f] ?? null);
  assert.deepEqual(
    [...graph].sort(),
    [
      "background.js",
      "link/protocol/schema-lite.mjs",
      "link/protocol/time.mjs",
      "link/store.mjs",
      "link/worker.mjs",
    ],
  );
});

test("module graph resolves parent-relative specifiers and dynamic imports", () => {
  const files = {
    "link/worker.mjs": `const m = await import('../shared/util.mjs');`,
    "shared/util.mjs": `export const u = 1;`,
  };
  const graph = collectModuleGraph(["link/worker.mjs"], (f) => files[f] ?? null);
  assert.ok(graph.has("shared/util.mjs"));
});

test("module graph tolerates entries with no imports and missing files", () => {
  const graph = collectModuleGraph(["content.css", "gone.js"], () => null);
  assert.deepEqual([...graph].sort(), ["content.css", "gone.js"]);
});

test("an imported module missing from the archive is rejected", () => {
  const graph = new Set(["background.js", "link/worker.mjs"]);
  assert.throws(
    () => assertRuntimeModulesPackaged(graph, ["manifest.json", "background.js"]),
    /missing files the extension loads at runtime: link\/worker\.mjs/,
  );
});

test("a fully packaged graph passes", () => {
  const graph = new Set(["background.js", "link/worker.mjs"]);
  assert.doesNotThrow(() =>
    assertRuntimeModulesPackaged(graph, ["background.js", "link/worker.mjs", "manifest.json"]),
  );
});
