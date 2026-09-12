const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// protocol.d.ts is generated from desktop/crates/protocol/schemas/ and committed, the
// same way schema-data.mjs is. This is the drift lock: change a schema without
// regenerating and the plugin suite goes red. Regenerate with:
//   node desktop/crates/protocol/js/gen-types.mjs
const load = () => import('../desktop/crates/protocol/js/gen-types.mjs');

// Windows checkouts may turn the committed LF into CRLF (git's autocrlf), so compare the
// content, not the line endings — the drift we care about is a schema that moved.
const withUnixNewlines = text => text.split('\r\n').join('\n');

test('protocol.d.ts is in sync with the D05 schemas', async () => {
  const { renderTypes, OUTPUT_PATH } = await load();
  const committed = withUnixNewlines(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  assert.equal(
    withUnixNewlines(renderTypes()),
    committed,
    'protocol.d.ts is stale; run: node desktop/crates/protocol/js/gen-types.mjs'
  );
});

test('every messageType resolves to a request and a response payload type', async () => {
  const { renderTypes } = await load();
  const rendered = renderTypes();
  const schemaLite = await import('../link/protocol/schema-lite.mjs');
  const messageTypes = schemaLite.envelopeSchema().properties.messageType.enum;

  // The generator throws if a mapping is missing, so reaching here already proves
  // coverage; this pins the rendered surface so a silent narrowing is visible too.
  const requestBlock = rendered.split('export interface RequestPayloadByType {')[1].split('}')[0];
  const responseBlock = rendered.split('export interface ResponsePayloadByType {')[1].split('}')[0];
  for (const type of messageTypes) {
    assert.match(requestBlock, new RegExp(`"${type.replace('.', '\.')}":`), `no request type for ${type}`);
    assert.match(responseBlock, new RegExp(`"${type.replace('.', '\.')}":`), `no response type for ${type}`);
  }
});

test('the generator does not restate the messageType mapping', async () => {
  const source = fs.readFileSync('desktop/crates/protocol/js/gen-types.mjs', 'utf8');
  // A literal "job.save" etc. in the generator would mean a second source of truth for
  // a mapping that schema-lite.mjs already owns.
  assert.ok(
    !/["']job\.save["']|["']application\.queryCandidates["']/.test(source),
    'gen-types.mjs must derive the mapping from schema-lite.mjs, not hard-code messageTypes'
  );
});
