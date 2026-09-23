const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { once } = require('node:events');

test('job extraction runs inside a dedicated worker without chrome.runtime', async () => {
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
    globalThis.fetch = async () => ({
      ok: true,
      async json() { return { choices: [{ message: { content: JSON.stringify({
        company: '星河科技', title: '工艺工程师', location: '',
        companyFragment: 1, titleFragment: 2, locationFragment: null
      }) } }] }; }
    });
    vm.runInThisContext(fs.readFileSync(${JSON.stringify(script)}, 'utf8'), {
      filename: ${JSON.stringify(script)},
      importModuleDynamically: specifier => import(specifier)
    });
    parentPort.on('message', data => self.onmessage({ data }));
  `, { eval: true, execArgv: ['--experimental-vm-modules'] });

  try {
    const response = once(worker, 'message');
    worker.postMessage({
      id: 1,
      sender: {},
      message: {
        type: 'AI_EXTRACT_JOB', requestId: 'worker-test',
        aiConfig: { apiUrl: 'https://ai.example.test/v1/chat/completions', model: 'test', apiKey: 'sk-test' },
        fragments: [
          { id: 1, source: 'jobposting-company', role: 'company', text: '星河科技' },
          { id: 2, source: 'jobposting-title', role: 'job-title', text: '工艺工程师' }
        ]
      }
    });
    const [reply] = await response;
    assert.equal(reply.id, 1);
    assert.equal(reply.reply.status, 'ok');
    assert.equal(reply.reply.fields.company, '星河科技');
    assert.equal(reply.reply.fields.title, '工艺工程师');
  } finally {
    await worker.terminate();
  }
});
