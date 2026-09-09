import { MAX_ENVELOPE_BYTES, payloadBodySha256, utf8JsonLen } from './protocol/validate.mjs';
import { LinkError } from './errors.mjs';

export const PROTOCOL_VERSION = 1;
export const MIN_PROTOCOL_VERSION = 1;
export const MAX_PROTOCOL_VERSION = 1;

// D05 splits the message types three ways and the split is not cosmetic: health and
// handshake are refused if they carry archive identity, and the rest are refused if they do
// not.
export const IDENTITY_FORBIDDEN = new Set(['health', 'handshake']);

// Every write is stamped with the epoch it was bound to.
export const WRITE_TYPES = new Set(['job.save', 'fill.submit', 'snapshot.chunk', 'submit.confirm']);

// Only three of them also carry a payload digest. `snapshot.chunk` is the exception: its
// payload schema is additionalProperties:false and declares no payloadSha256, because a
// chunk's receipt digest is the immutable chunk identity (snapshot/index/application/count/
// length/hashes), computed separately by snapshotChunkIdentitySha256. Adding the field would
// make every chunk D08 sends fail as invalid_payload.
export const DIGEST_TYPES = new Set(['job.save', 'fill.submit', 'submit.confirm']);

/**
 * Build one wire envelope.
 *
 * `identity` is the current handshake. `sourceRestoreEpoch` is the epoch stamped when the
 * user bound the message and is deliberately a separate argument: reusing `identity` for it
 * would turn a stale queue item into a silent replay against a restored archive.
 */
export async function buildEnvelope({
  messageType,
  messageId,
  clientInstanceId,
  payload,
  identity = null,
  sourceRestoreEpoch = null,
  now = () => new Date()
}) {
  const body = { ...payload };

  if (WRITE_TYPES.has(messageType)) {
    if (!sourceRestoreEpoch) {
      throw new LinkError('invalid_payload', `${messageType} needs the epoch it was bound to`);
    }
    body.sourceRestoreEpoch = sourceRestoreEpoch;
    if (DIGEST_TYPES.has(messageType)) {
      // The digest is defined over the payload without the digest field, so it has to be the
      // last thing added.
      body.payloadSha256 = await payloadBodySha256(body);
    }
  }

  const message = {
    protocolVersion: PROTOCOL_VERSION,
    messageId,
    clientInstanceId,
    messageType,
    occurredAt: toUtcSubset(now()),
    payload: body
  };

  if (!IDENTITY_FORBIDDEN.has(messageType)) {
    if (!identity?.archiveId || !identity?.restoreEpoch) {
      throw new LinkError('identity_missing', `${messageType} needs a successful handshake first`);
    }
    message.archiveId = identity.archiveId;
    message.restoreEpoch = identity.restoreEpoch;
  }

  if (utf8JsonLen(message) > MAX_ENVELOPE_BYTES) {
    throw new LinkError('payload_too_large', 'the envelope exceeds the D05 size limit');
  }

  return message;
}

// D05 accepts a UTC subset only: `Z`, no numeric offsets. `toISOString` already produces
// exactly that shape, so this exists to make the constraint visible rather than to reformat.
function toUtcSubset(date) {
  return date.toISOString();
}
