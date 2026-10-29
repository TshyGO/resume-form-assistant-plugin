import { buildEnvelope } from './envelope.mjs';
import { sendOnce } from './transport.mjs';
import { validateRequest, decodeStandardBase64, sha256Hex } from './protocol/validate.mjs';
import { encodeBase64, planChunks } from './snapshot.mjs';

export function createMail({ session, store, sendNative, sleep, uuid, now, send = sendOnce }) {
  let busy = false;
  async function save(message) {
    if (busy) return { status: 'busy' };
    busy = true;
    try {
      if (!['eml', 'excerpt'].includes(message.kind)) return { status: 'invalid_payload' };
      const bytes = message.kind === 'eml' ? decodeStandardBase64(message.bytesBase64)
        : new TextEncoder().encode(JSON.stringify(message.excerpt));
      if (!bytes.length || bytes.length > 25 * 1024 * 1024) return { status: 'too_large' };
      const probe = await session.probe();
      if (probe.mode !== 'ready') return { status: probe.mode };
      if (!probe.capabilities?.includes('mail.import')) return { status: 'incompatible' };
      const identity = probe.identity; // Fixed for the entire upload, never rebound during a retry.
      const uploadId = uuid();
      const clientInstanceId = await store.clientInstanceId();
      const sha256 = await sha256Hex(bytes);
      const chunks = await planChunks(bytes);
      let last;
      for (const chunk of chunks) {
        const payload = { uploadId, kind: message.kind, byteSize: bytes.length, sha256,
          chunkIndex: chunk.chunkIndex, chunkCount: chunks.length, chunkSha256: chunk.chunkSha256,
          bytesBase64: encodeBase64(bytes.subarray(chunk.start, chunk.end)) };
        if (message.applicationId) payload.applicationId = message.applicationId;
        const envelope = await buildEnvelope({ messageType: 'mail.import', messageId: uuid(), clientInstanceId, identity, payload, now });
        await validateRequest(envelope);
        last = await send(envelope, { sendNative, sleep });
        if (last.status !== 'ok') return { status: last.code === 'restore_epoch_mismatch' ? 'archive_changed'
          : ['protocol_incompatible', 'unknown_message_type'].includes(last.code) ? 'incompatible' : 'unavailable' };
        const ack = last.response.payload;
        if (ack.uploadId !== uploadId || ack.chunkIndex !== chunk.chunkIndex) return { status: 'unavailable' };
        const final = chunk.chunkIndex === chunks.length - 1;
        if (final ? ack.status !== 'saved' || !ack.evidenceId || typeof ack.duplicate !== 'boolean' : ack.status !== 'chunk') {
          return { status: 'unavailable' };
        }
      }
      return { status: 'saved', evidenceId: last.response.payload.evidenceId, duplicate: last.response.payload.duplicate };
    } catch (error) {
      return { status: error?.code === 'payload_too_large' ? 'too_large' : 'unavailable' };
    } finally { busy = false; }
  }
  return { save };
}
