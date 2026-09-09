const test = require('node:test');
const assert = require('node:assert/strict');

async function load() {
  return {
    redact: await import('../link/redact.mjs'),
    validate: await import('../link/protocol/validate.mjs')
  };
}

// The three worked examples in data-privacy.md §7.1, verbatim.
test('a job URL keeps its tracking parameter but loses the credential ones', async () => {
  const { redact } = await load();

  const result = redact.redactUrl('https://jobs.example.com/apply?code=REQ42&utm_source=mail&access_token=abc');

  assert.equal(result.sourceUrl, 'https://jobs.example.com/apply?utm_source=mail');
  assert.equal(result.dedupeUrl, 'https://jobs.example.com/apply');
});

test('an OAuth callback loses its one and only parameter', async () => {
  const { redact } = await load();

  const result = redact.redactUrl('https://auth.example.com/callback?code=ONE_TIME_SECRET');

  assert.equal(result.sourceUrl, 'https://auth.example.com/callback');
  assert.equal(result.dedupeUrl, 'https://auth.example.com/callback');
});

test('a password reset link loses its key', async () => {
  const { redact } = await load();

  const result = redact.redactUrl('https://portal.example.com/reset?key=RESET_SECRET');

  assert.equal(result.sourceUrl, 'https://portal.example.com/reset');
  assert.equal(result.dedupeUrl, 'https://portal.example.com/reset');
});

test('userinfo and fragment never survive', async () => {
  const { redact } = await load();

  const result = redact.redactUrl('https://user:pass@jobs.example.com/apply?ref=1#section-2');

  assert.equal(result.sourceUrl, 'https://jobs.example.com/apply?ref=1');
  assert.equal(result.sourceUrl.includes('user'), false);
  assert.equal(result.sourceUrl.includes('#'), false);
});

test('a percent-encoded credential name is still a credential', async () => {
  const { redact } = await load();
  // The desktop decodes the name before matching, so a plugin that matched the raw string
  // would hand over a URL the desktop then refuses — or worse, would keep the token.
  const result = redact.redactUrl('https://jobs.example.com/apply?access%5Ftoken=abc&role=backend');

  assert.equal(result.sourceUrl, 'https://jobs.example.com/apply?role=backend');
});

test('case and separator variations of a credential name are stripped', async () => {
  const { redact } = await load();

  const result = redact.redactUrl('https://jobs.example.com/apply?Access-Token=a&API_KEY=b&SID=c&job=42');

  assert.equal(result.sourceUrl, 'https://jobs.example.com/apply?job=42');
});

test('a repeated credential parameter is stripped in every position', async () => {
  const { redact } = await load();

  const result = redact.redactUrl('https://jobs.example.com/apply?token=a&job=42&token=b');

  assert.equal(result.sourceUrl, 'https://jobs.example.com/apply?job=42');
});

test('a very long credential value does not survive by being awkward', async () => {
  const { redact } = await load();

  const result = redact.redactUrl(`https://jobs.example.com/apply?secret=${'x'.repeat(5000)}&job=42`);

  assert.equal(result.sourceUrl, 'https://jobs.example.com/apply?job=42');
});

test('every redacted URL passes the desktop URL check', async () => {
  const { redact, validate } = await load();
  const inputs = [
    'https://jobs.example.com/apply?code=REQ42&utm_source=mail&access_token=abc',
    'https://auth.example.com/callback?code=ONE_TIME_SECRET',
    'https://portal.example.com/reset?key=RESET_SECRET',
    'https://user:pass@jobs.example.com/apply?ref=1#/callback?access_token=abc',
    'https://jobs.example.com/apply?access%5Ftoken=abc',
    'https://JOBS.Example.COM/Apply?Signature=abc'
  ];

  for (const input of inputs) {
    const result = redact.redactUrl(input);
    // If this ever throws, the plugin believed a URL was clean while the desktop refused it.
    validate.checkUrl(result.sourceUrl);
    validate.checkUrl(result.dedupeUrl);
  }
});

test('a plain http page yields no URL at all', async () => {
  const { redact } = await load();
  // D05 accepts https only. Sending http would be refused as secret_forbidden, so the field
  // is simply left out rather than downgraded or rewritten.
  assert.equal(redact.redactUrl('http://jobs.example.com/apply'), null);
});

test('something that is not a URL yields nothing rather than throwing', async () => {
  const { redact } = await load();

  assert.equal(redact.redactUrl('not a url'), null);
  assert.equal(redact.redactUrl(''), null);
  assert.equal(redact.redactUrl(undefined), null);
});

test('dedupe drops tracking parameters that source keeps', async () => {
  const { redact } = await load();

  const result = redact.redactUrl('https://jobs.example.com/apply?utm_source=mail&utm_campaign=x&gclid=y&job=42');

  assert.equal(result.sourceUrl, 'https://jobs.example.com/apply?utm_source=mail&utm_campaign=x&gclid=y&job=42');
  assert.equal(result.dedupeUrl, 'https://jobs.example.com/apply?job=42');
});

test('the shipped allowlist is empty and is the desktop copy', async () => {
  const { redact } = await load();
  // §7.1 requires a reviewed, versioned rule with the site's own positive and negative
  // examples before any job number survives. None exists, so none ships; and the list comes
  // from the vendored rules so the plugin can never keep a parameter the desktop refuses.
  assert.deepEqual(redact.URL_ALLOWLIST, []);
});

test('a credential in a routed fragment does not slip through', async () => {
  const { redact, validate } = await load();

  const result = redact.redactUrl('https://jobs.example.com/apply#/callback?access_token=abc');

  assert.equal(result.sourceUrl, 'https://jobs.example.com/apply');
  validate.checkUrl(result.sourceUrl);
});
