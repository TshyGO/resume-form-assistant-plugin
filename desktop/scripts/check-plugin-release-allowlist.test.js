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

// Three further ways a file enters the running extension, none of which the first
// version of collectModuleGraph followed. link/extract.mjs and link/copy.mjs are
// reached only by getURL, so the guard passed while they could have gone unpackaged.

test("side-effect imports with no bindings are followed", () => {
  const files = {
    "a.mjs": `import './setup.mjs';\nimport { x } from './other.mjs';`,
    "setup.mjs": ``,
    "other.mjs": ``,
  };
  const graph = collectModuleGraph(["a.mjs"], (f) => files[f] ?? null);
  assert.ok(graph.has("setup.mjs"), "bare `import './setup.mjs'` must be followed");
  assert.ok(graph.has("other.mjs"));
});

test("chrome.runtime.getURL imports resolve against the extension root", () => {
  const files = {
    "content.js": `const [e, c] = await Promise.all([
      import(chrome.runtime.getURL("link/extract.mjs")),
      import(chrome.runtime.getURL("link/copy.mjs"))
    ]);`,
    "link/extract.mjs": `import { redactUrl } from './redact.mjs';`,
    "link/copy.mjs": ``,
    "link/redact.mjs": ``,
  };
  const graph = collectModuleGraph(["content.js"], (f) => files[f] ?? null);
  // Root-relative, not resolved against content.js's directory, and transitive.
  assert.ok(graph.has("link/extract.mjs"));
  assert.ok(graph.has("link/copy.mjs"));
  assert.ok(graph.has("link/redact.mjs"));
});

test("HTML script and link references are followed", () => {
  const files = {
    "ai-host.html": `<!doctype html><script src="ai-host.js"></script>`,
    "ai-host.js": ``,
    "popup.html": `<link rel="stylesheet" href="popup.css">\n<script src="popup.js"></script>`,
    "popup.css": ``,
    "popup.js": ``,
  };
  const a = collectModuleGraph(["ai-host.html"], (f) => files[f] ?? null);
  assert.ok(a.has("ai-host.js"));
  const p = collectModuleGraph(["popup.html"], (f) => files[f] ?? null);
  assert.ok(p.has("popup.css") && p.has("popup.js"));
});

test("directory references are kept as prefixes and absolute URLs are dropped", () => {
  const files = {
    "popup.js": `const base = chrome.runtime.getURL("vendor/pdfjs/cmaps/");
      const w = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");`,
    "index.html": `<script src="https://cdn.example.com/x.js"></script><script src="//cdn/y.js"></script>`,
    "vendor/pdfjs/pdf.worker.min.mjs": ``,
  };
  const graph = collectModuleGraph(["popup.js", "index.html"], (f) => files[f] ?? null);
  assert.ok(graph.has("vendor/pdfjs/pdf.worker.min.mjs"));
  assert.ok(graph.has("vendor/pdfjs/cmaps/"), "a directory reference is kept, to be checked as a prefix");
  assert.ok(!graph.has("https://cdn.example.com/x.js"), "absolute URLs are not ours to package");
  assert.ok(!graph.has("//cdn/y.js"));
});

// Workers and directory references, both raised in review on the previous revision.

test("worker constructors and their importScripts are followed", () => {
  const files = {
    "ai-host.html": `<script src="ai-host.js"></script>`,
    "ai-host.js": `const worker = new Worker("ai-worker.js");`,
    "ai-worker.js": `importScripts("ai-helpers.js", "resume-utils.js", "form-agent.js");`,
    "ai-helpers.js": ``,
    "resume-utils.js": ``,
    "form-agent.js": ``,
  };
  const graph = collectModuleGraph(["ai-host.html"], (f) => files[f] ?? null);
  assert.ok(graph.has("ai-worker.js"), "new Worker(...) must be followed");
  // importScripts takes several scripts in one call; all of them count.
  assert.ok(graph.has("ai-helpers.js") && graph.has("resume-utils.js") && graph.has("form-agent.js"));
});

test("a directory reference requires at least one packaged file beneath it", () => {
  const graph = new Set(["popup.js", "vendor/pdfjs/cmaps/"]);
  assert.throws(
    () => assertRuntimeModulesPackaged(graph, ["popup.js", "vendor/pdfjs/pdf.min.mjs"]),
    /vendor\/pdfjs\/cmaps\/\* \(no packaged files under this directory\)/,
    "packaging pdf.js but not the CMaps must fail, not pass silently",
  );
  assert.doesNotThrow(() =>
    assertRuntimeModulesPackaged(graph, ["popup.js", "vendor/pdfjs/cmaps/78-EUC-H.bcmap"]),
  );
});
