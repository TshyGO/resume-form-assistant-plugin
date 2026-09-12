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

test('the handshake reports the same version the manifest declares', async () => {
  // PLUGIN_VERSION is what the desktop app is told during the handshake, and it is a
  // second copy of a number manifest.json already owns. A silent bump of one and not
  // the other makes the desktop record the wrong plugin version against every write.
  const { PLUGIN_VERSION } = await import('../link/session.mjs');
  assert.equal(
    PLUGIN_VERSION,
    manifest().version,
    'link/session.mjs PLUGIN_VERSION must match manifest.json version'
  );
});

test('the sidebar offers archiving a fill and leaves the wording to link/copy.mjs', async () => {
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  assert.match(source, /resume-pro-fill-record/);
  assert.match(source, /DESKTOP_RECORD_FILL/);
  assert.match(source, /DESKTOP_LINK_STATE/);
  assert.match(source, /describeFillRecordResult/);
  // Claiming the desktop has the record is copy.mjs's call alone, after a persisted reply.
  assert.equal(source.includes('已留档到桌面'), false);
});

test('a hidden sidebar panel stays hidden even when its class sets a display', async () => {
  // The save form, the candidate box and the fill-record card are flex boxes toggled with
  // the `hidden` attribute. An author `display` rule beats the browser's [hidden] rule, so
  // without this override every one of them shows, empty, on every page.
  const css = fs.readFileSync(path.join(root, 'content.css'), 'utf8');
  assert.match(css, /\.resume-pro \[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('a finished fill is filed under the page it ran on, not the one the user moved to', async () => {
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const body = source.slice(source.indexOf('async function offerFillRecord'), source.indexOf('function closeFillRecord'));
  assert.ok(body.indexOf('extractJobFields(') > 0);
  assert.ok(body.indexOf('extractJobFields(') < body.indexOf('DESKTOP_LINK_STATE'), 'read the page before waiting on the worker');
  assert.match(body, /location\.href !== pageUrl/);
});

test('queue rows describe a retried or resolved entry in the words of its own kind', async () => {
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const describe = source.slice(source.indexOf('function describeQueueResult'));
  assert.match(describe, /fill\.submit[\s\S]*describeFillRecordResult/);
  const retry = source.slice(source.indexOf('"立即重试"'), source.indexOf('"立即重试"') + 400);
  assert.match(retry, /describeQueueResult\(/);
  const resolve = source.slice(source.indexOf('async function resolvePaused'), source.indexOf('function describeOutboxState'));
  assert.match(resolve, /describeQueueResult\(/);
  assert.equal(resolve.includes('describeBindResult('), false);
});

test('an application id typed by hand is checked before anything is bound', async () => {
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const body = source.slice(source.indexOf('async function chooseFillApplication'), source.indexOf('async function chooseFillApplication') + 900);
  assert.match(body, /APPLICATION_ID_PATTERN\.test\(/);
  const { describeFillRecordResult } = await import('../link/copy.mjs');
  assert.match(describeFillRecordResult({ status: 'rejected', reason: 'invalid_application_id' }).text, /申请 ID/);
});
