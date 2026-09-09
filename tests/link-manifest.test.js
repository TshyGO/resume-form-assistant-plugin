const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = () => JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const background = () => fs.readFileSync(path.join(root, 'background.js'), 'utf8');

test('the extension may open a native messaging port', async () => {
  assert.ok(manifest().permissions.includes('nativeMessaging'));
});

test('the extension may schedule work that outlives the service worker', async () => {
  // The worker is evicted while a job sits in the outbox. Without alarms the retry only
  // happens if the user happens to open a page again.
  assert.ok(manifest().permissions.includes('alarms'));
});

test('the service worker loads as a module so it can import the D05 validator', async () => {
  assert.equal(manifest().background.type, 'module');
  assert.equal(manifest().background.service_worker, 'background.js');
});

test('the toolbar button still toggles the manager', async () => {
  // README.md calls this out by name: the desktop link must not take over onClicked.
  const source = background();
  assert.match(source, /chrome\.action\.onClicked\.addListener/);
  assert.match(source, /TOGGLE_MANAGER/);
});

test('the offscreen AI host is still created on demand', async () => {
  const source = background();
  assert.match(source, /ENSURE_AI_HOST/);
  assert.match(source, /chrome\.offscreen\.createDocument/);
  assert.match(source, /ai-host\.html/);
});

test('the service worker installs the desktop link', async () => {
  const source = background();
  assert.match(source, /import \{ installDesktopLink \} from ['"]\.\/link\/worker\.mjs['"]/);
  assert.match(source, /installDesktopLink\(chrome\)/);
});

test('the sidebar can import the extraction and copy modules', async () => {
  // A content script reaches them through chrome.runtime.getURL, which only resolves for
  // web-accessible resources. Without this the save button fails with an opaque import
  // error at the moment the user clicks it.
  const resources = manifest().web_accessible_resources[0].resources;
  assert.ok(resources.includes('link/*.mjs'));
  assert.ok(resources.includes('link/protocol/*.mjs'));
});

test('the sidebar offers saving a job and never formats desktop copy itself', async () => {
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.match(source, /resume-pro-save-job/);
  assert.match(source, /DESKTOP_SAVE_JOB/);
  // The wording table lives in link/copy.mjs so the §9 distinctions stay testable.
  assert.match(source, /describeSaveResult/);
  assert.equal(source.includes('桌面已保存'), false);
});

test('the sidebar offers confirming a submission separately from saving', async () => {
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  // §5.2 rule 5: this is its own button, unrelated to whether the AI fill worked.
  assert.match(source, /resume-pro-confirm-submit/);
  assert.match(source, /DESKTOP_CONFIRM_SUBMIT/);
});

test('the desktop link is documented where a maintainer will look', async () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /link\/ +桌面程序连接/);
  assert.match(readme, /sourceRestoreEpoch/);
});

test('the desktop link ships every file it imports', async () => {
  const files = [
    'link/protocol/validate.mjs',
    'link/protocol/schema-lite.mjs',
    'link/protocol/schema-data.mjs',
    'link/protocol/time.mjs',
    'link/errors.mjs',
    'link/envelope.mjs',
    'link/transport.mjs',
    'link/store.mjs',
    'link/session.mjs',
    'link/intents.mjs',
    'link/outbox.mjs',
    'link/drain.mjs',
    'link/reconcile.mjs',
    'link/router.mjs',
    'link/worker.mjs',
    'link/messages.mjs',
    'link/limits.mjs',
    'link/copy.mjs',
    'link/redact.mjs',
    'link/normalize.mjs',
    'link/extract.mjs',
    'link/chrome.mjs'
  ];
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing from the extension root`);
  }
});
