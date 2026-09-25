import { buildEnvelope } from './envelope.mjs';
import { HOST_NAME } from './transport.mjs';
import { validateRequest, validateResponseForRequest } from './protocol/validate.mjs';

const wireReason = code => ({
  secret_forbidden: 'secret_in_prompt',
  payload_too_large: 'input_too_large',
  protocol_incompatible: 'incompatible'
}[code] ?? 'unavailable');

/** AI prompts stay in the worker; this module only asks the desktop to send them. */
export function createAi({ session, store, port, uuid, now }) {
  async function complete({ purpose, system, user, signal }) {
    if (signal?.aborted) return { ok: false, reason: 'cancelled' };
    let probe;
    try { probe = await session.probe(); }
    catch { return { ok: false, reason: 'unavailable' }; }
    if (probe.mode !== 'ready') return { ok: false, reason: probe.mode };
    if (signal?.aborted) return { ok: false, reason: 'cancelled' };

    let request;
    try {
      request = await buildEnvelope({
        messageType: 'ai.complete', messageId: uuid(),
        clientInstanceId: await store.clientInstanceId(),
        payload: { purpose, system, user }, now
      });
      await validateRequest(request);
    } catch (error) {
      return { ok: false, reason: wireReason(error?.code) };
    }

    let reply;
    try { reply = await port(HOST_NAME, request, { signal }); }
    catch { return { ok: false, reason: 'unavailable' }; }
    if (reply?.cancelled || signal?.aborted) return { ok: false, reason: 'cancelled' };
    if (reply?.lastError) {
      const error = reply.lastError.toLowerCase();
      return { ok: false, reason: error.includes('host not found') || error.includes('host has not been found') ? 'not_installed' : 'unavailable' };
    }
    try { validateResponseForRequest(reply?.response, request); }
    catch (error) { return { ok: false, reason: wireReason(error?.code) }; }
    if (!reply.response.ok) {
      const code = reply.response.error?.code;
      // The request already passed this plugin's copy of the schema, so a desktop that
      // rejects its payload is running an older schema (e.g. one without this purpose).
      return { ok: false, reason: code === 'invalid_payload' ? 'incompatible' : wireReason(code) };
    }
    const payload = reply.response.payload;
    if (payload.status === 'ok') return { ok: true, text: payload.text };
    return {
      ok: false, reason: payload.reason,
      ...(payload.httpStatus == null ? {} : { httpStatus: payload.httpStatus }),
      ...(payload.host == null ? {} : { host: payload.host })
    };
  }
  return { complete };
}
