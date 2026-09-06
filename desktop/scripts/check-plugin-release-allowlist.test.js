import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertPluginOnlyArchive,
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
