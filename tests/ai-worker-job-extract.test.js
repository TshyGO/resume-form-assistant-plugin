const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const FRAGMENTS = [
  { id: 1, source: 'jobposting-company', role: 'company', text: '星河科技' },
  { id: 2, source: 'jobposting-title', role: 'job-title', text: '工艺工程师' }
];

// Runs ai-worker.js the way the offscreen host does: a dedicated worker with no chrome.runtime,
// whose only way out is posting desktop-complete back to the host.
function startWorker() {
  const script = path.join(__dirname, '..', 'ai-worker.js');
  const worker = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const { pathToFileURL } = require('node:url');
    globalThis.self = globalThis;
    self.location = { href: pathToFileURL(${JSON.stringify(script)}).href };
    self.postMessage = value => parentPort.postMessage(value);
    globalThis.importScripts = () => {};
    globalThis.fetch = async () => {
      parentPort.postMessage({ kind: 'fetch-called' });
      throw new Error('the worker must not reach an AI service itself');
    };
    vm.runInThisContext(fs.readFileSync(${JSON.stringify(script)}, 'utf8'), {
      filename: ${JSON.stringify(script)},
      importModuleDynamically: specifier => import(specifier)
    });
    parentPort.on('message', data => self.onmessage({ data }));
  `, { eval: true, execArgv: ['--experimental-vm-modules'] });

  const seen = [];
  const waiters = [];
  worker.on('message', message => {
    seen.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.match(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const next = match => {
    const found = seen.find(match);
    if (found) return Promise.resolve(found);
    return new Promise(resolve => waiters.push({ match, resolve }));
  };
  return { worker, seen, next };
}

function ask(env, id, message) {
  env.worker.postMessage({ id, sender: { frameId: 0 }, message });
  return env.next(item => item.id === id);
}

test('job extraction asks the desktop with extract_job and sends only the fragments', async () => {
  const env = startWorker();
  try {
    const reply = ask(env, 1, {
      type: 'AI_EXTRACT_JOB', requestId: 'job-1', fragments: FRAGMENTS,
      aiConfig: { apiUrl: 'https://ai.example.test/v1', model: 'old', apiKey: 'sk-should-never-leave' }
    });
    const call = await env.next(item => item.kind === 'desktop-complete');
    assert.equal(call.purpose, 'extract_job');
    assert.deepEqual(JSON.parse(call.user), FRAGMENTS);
    assert.equal(JSON.stringify(call).includes('sk-should-never-leave'), false);
    assert.equal(JSON.stringify(call).includes('ai.example.test'), false);
    env.worker.postMessage({ kind: 'desktop-result', callId: call.callId, reply: { ok: true, text: JSON.stringify({
      company: '星河科技', title: '工艺工程师', location: '',
      companyFragment: 1, titleFragment: 2, locationFragment: null
    }) } });

    const { reply: result } = await reply;
    assert.equal(result.status, 'ok');
    assert.equal(result.fields.company, '星河科技');
    assert.equal(result.fields.title, '工艺工程师');
    assert.equal(env.seen.some(item => item.kind === 'fetch-called'), false);
  } finally {
    await env.worker.terminate();
  }
});

test('a desktop without AI settings gets the fill wording, a settings link and no retry', async () => {
  const env = startWorker();
  try {
    const reply = ask(env, 1, { type: 'AI_EXTRACT_JOB', requestId: 'job-2', fragments: FRAGMENTS });
    const call = await env.next(item => item.kind === 'desktop-complete');
    env.worker.postMessage({ kind: 'desktop-result', callId: call.callId, reply: { ok: false, reason: 'not_configured' } });

    const { reply: result } = await reply;
    assert.equal(result.status, 'manual');
    assert.equal(result.reason, 'not_configured');
    assert.equal(result.note, '桌面还没有配置 AI 服务商，或当前服务商没有 Key。');
    assert.equal(result.openView, 'settings-ai');
    assert.equal('failure' in result, false);
    assert.equal(env.seen.filter(item => item.kind === 'desktop-complete').length, 1);
  } finally {
    await env.worker.terminate();
  }
});

test('an old desktop that rejects extract_job is reported as too old, not as offline', async () => {
  const env = startWorker();
  try {
    const reply = ask(env, 1, { type: 'AI_EXTRACT_JOB', requestId: 'job-3', fragments: FRAGMENTS });
    const call = await env.next(item => item.kind === 'desktop-complete');
    env.worker.postMessage({ kind: 'desktop-result', callId: call.callId, reply: { ok: false, reason: 'incompatible' } });

    const { reply: result } = await reply;
    assert.equal(result.note, '桌面程序版本太旧，请更新桌面。');
    assert.equal('openView' in result, false);
  } finally {
    await env.worker.terminate();
  }
});

test('cancelling job extraction closes the desktop call the same way fill does', async () => {
  const env = startWorker();
  try {
    const reply = ask(env, 1, { type: 'AI_EXTRACT_JOB', requestId: 'job-4', fragments: FRAGMENTS });
    const call = await env.next(item => item.kind === 'desktop-complete');
    const cancelled = ask(env, 2, { type: 'CANCEL_AI_FILL', requestId: 'job-4' });

    const cancel = await env.next(item => item.kind === 'desktop-cancel');
    assert.equal(cancel.callId, call.callId);
    assert.equal((await cancelled).reply.cancelled, true);
    const { reply: result } = await reply;
    assert.equal(result.status, 'manual');
    assert.equal(result.reason, 'cancelled');

    // The desktop's answer can still arrive after the port closed; it changes nothing.
    env.worker.postMessage({ kind: 'desktop-result', callId: call.callId, reply: { ok: true, text: '{}' } });
    assert.equal(env.seen.filter(item => item.kind === 'desktop-complete').length, 1);
  } finally {
    await env.worker.terminate();
  }
});
