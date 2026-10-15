import { buildEnvelope } from './envelope.mjs';
import { sendOnce } from './transport.mjs';
import { validateRequest } from './protocol/validate.mjs';

const PAGE_URLS = api => [api.runtime.getURL('sidepanel.html'), api.runtime.getURL('popup.html')];
export function isUsageSender(api, message, sender) {
  const touch = message?.type === 'DESKTOP_USAGE_TOUCH' && Object.keys(message).length === 1;
  const settings = message?.type === 'DESKTOP_USAGE_SETTINGS'
    && Object.keys(message).length === 2
    && ['status', 'enable', 'disable', 'acknowledge'].includes(message.action);
  return (touch || settings) && sender?.id === api.runtime.id && PAGE_URLS(api).includes(sender?.url);
}

// Hold the MV3 reply channel until the one-shot local operation settles. This does
// not add retries or a persistent worker; rejected origins never receive a false ACK.
export function handleUsageMessage(api, usage, message, sender, sendResponse) {
  if (!['DESKTOP_USAGE_TOUCH', 'DESKTOP_USAGE_SETTINGS'].includes(message?.type)) return null;
  if (!isUsageSender(api, message, sender)) {
    sendResponse(message?.type === 'DESKTOP_USAGE_TOUCH' ? { accepted: false } : { ok: false, code: 'forbidden' });
    return false;
  }
  const task = message.type === 'DESKTOP_USAGE_TOUCH' ? usage.touch() : usage.settings(message.action);
  Promise.resolve(task).then(
    result => sendResponse(message.type === 'DESKTOP_USAGE_TOUCH' ? { accepted: true } : result),
    () => sendResponse(message.type === 'DESKTOP_USAGE_TOUCH' ? { accepted: false } : { ok: false, code: 'unavailable' }),
  );
  return true;
}

// Activity uses only an already-successful handshake. Settings make a one-shot request,
// and the native host only connects to an already-running desktop. Neither path cold-starts it.
// In-memory quota bounds browser calls; durable cross-browser quota is owned by Rust.
export function createUsage({ store, sendNative, uuid, now, send = sendOnce }) {
  let supported = false;
  let attemptedDay = null;
  let busy = false;
  return {
    observe(probe) { supported = probe?.mode === 'ready' && probe.capabilities?.includes('usage.touch') === true; },
    async touch() {
      if (!supported || busy) return;
      const date = now().toISOString().slice(0, 10);
      if (attemptedDay && attemptedDay >= date) return;
      busy = true; attemptedDay = date;
      try {
        const message = await buildEnvelope({ messageType: 'usage.touch', payload: {},
          messageId: uuid(), clientInstanceId: await store.clientInstanceId(), now });
        message.protocolVersion = 3;
        await validateRequest(message);
        await send(message, { sendNative, retry: false });
      } catch { /* no log, queue, retry or user-visible error */ }
      finally { busy = false; }
    },
    async settings(action) {
      if (!['status', 'enable', 'disable', 'acknowledge'].includes(action)) return { ok: false, code: 'invalid_payload' };
      try {
        const message = await buildEnvelope({ messageType: 'usage.settings', payload: { action },
          messageId: uuid(), clientInstanceId: await store.clientInstanceId(), now });
        message.protocolVersion = 3;
        await validateRequest(message);
        const result = await send(message, { sendNative, retry: false });
        if (result.status === 'ok') return { ok: true, status: result.response.payload };
        return { ok: false, code: result.code ?? result.status };
      } catch { return { ok: false, code: 'unavailable' }; }
    },
  };
}
