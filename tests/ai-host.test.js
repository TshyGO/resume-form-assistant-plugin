const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('service worker only creates one concurrent offscreen worker host and never fetches AI', async () => {
  let complete, creates = 0;
  const context = vm.createContext({ chrome: {
    action: { onClicked: { addListener() {} } },
    runtime: { getURL: name => `chrome-extension://test/${name}`, getContexts: async () => [], onMessage: { addListener() {} } },
    offscreen: { createDocument: options => { creates++; assert.equal(options.reasons[0], 'WORKERS'); return new Promise(resolve => { complete = resolve; }); } }
  } });
  vm.runInContext(source('background.js'), context);
  const a = context.ensureAiHost(), b = context.ensureAiHost();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(creates, 1);
  complete();
  await Promise.all([a, b]);
  assert.doesNotMatch(source('background.js'), /\bfetch\s*\(/);
});

test('offscreen host forwards sender identity and correlated replies to its dedicated worker', async () => {
  let listener, worker;
  class MockWorker { constructor(url) { assert.equal(url, 'ai-worker.js'); worker = this; } postMessage(data) { this.last = data; } }
  const context = vm.createContext({ Worker: MockWorker, chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } } });
  vm.runInContext(source('ai-host.js'), context);
  let result;
  assert.equal(listener({ type: 'AI_FILL', requestId: 'a' }, { tab: { id: 3 }, frameId: 2, documentId: 'doc' }, reply => { result = reply; }), true);
  assert.equal(worker.last.sender.tab.id, 3);
  assert.equal(worker.last.sender.documentId, 'doc');
  worker.onmessage({ data: { id: worker.last.id, reply: { success: true } } });
  assert.equal(result.success, true);
  listener({ type: 'AI_FILL', requestId: 'b' }, {}, reply => { result = reply; });
  worker.onerror();
  assert.equal(result.success, false);
  listener({ type: 'AI_HOST_READY' }, {}, reply => { result = reply; });
  assert.equal(result.ready, false);
});

test('client cancellation waits for startup and original dispatch rather than racing the host', async () => {
  let ready, complete;
  const calls = [];
  const context = vm.createContext({ chrome: { runtime: { sendMessage: message => {
    calls.push(message.type);
    if (message.type === 'ENSURE_AI_HOST') return new Promise(resolve => { ready = resolve; });
    if (message.type === 'AI_HOST_READY') return Promise.resolve({ ready: true });
    if (message.type === 'AI_FILL') return new Promise(resolve => { complete = resolve; });
    complete({ success: false, error: 'cancelled' });
    return Promise.resolve({ cancelled: true });
  } } } });
  vm.runInContext(source('ai-client.js'), context);
  const result = context.ResumeProAIClient.send({ type: 'AI_FILL', requestId: 'a' });
  const cancelled = context.ResumeProAIClient.cancel('a');
  assert.deepEqual(calls, ['ENSURE_AI_HOST']);
  ready({ ready: true });
  assert.equal((await cancelled).cancelled, true);
  assert.equal((await result).success, false);
  assert.deepEqual(calls, ['ENSURE_AI_HOST', 'AI_HOST_READY', 'AI_FILL', 'CANCEL_AI_FILL']);
  assert.equal((await context.ResumeProAIClient.cancel('a')).cancelled, false);
});

test('failed startup sends no AI request and does not leave cancellation hanging', async () => {
  const calls = [];
  const context = vm.createContext({ chrome: { runtime: { sendMessage: async message => { calls.push(message.type); return { ready: false }; } } } });
  vm.runInContext(source('ai-client.js'), context);
  const result = context.ResumeProAIClient.send({ type: 'AI_FILL', requestId: 'a' });
  const cancel = context.ResumeProAIClient.cancel('a');
  await assert.rejects(result, /启动/);
  assert.equal((await cancel).cancelled, false);
  assert.deepEqual(calls, ['ENSURE_AI_HOST']);
});

test('manifest and popup load the client and packaged host dependencies exist', () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.ok(manifest.permissions.includes('offscreen'));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf('ai-client.js') < scripts.indexOf('content.js'));
  const html = source('popup.html');
  assert.ok(html.indexOf('ai-client.js') < html.indexOf('popup.js'));
  for (const file of ['ai-host.html', 'ai-host.js', 'ai-worker.js', 'ai-client.js']) assert.ok(source(file));
});
