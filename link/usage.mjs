import { buildEnvelope } from './envelope.mjs';
import { sendOnce } from './transport.mjs';
import { validateRequest } from './protocol/validate.mjs';

export function isUsageSender(api, message, sender) {
  return message?.type === 'DESKTOP_USAGE_TOUCH' && Object.keys(message).length === 1
    && sender?.id === api.runtime.id
    && [api.runtime.getURL('sidepanel.html'), api.runtime.getURL('popup.html')].includes(sender?.url);
}

// Hold the MV3 reply channel until the one-shot local operation settles. This does
// not add retries or a persistent worker; rejected origins never receive a false ACK.
export function handleUsageMessage(api, usage, message, sender, sendResponse) {
  if (message?.type !== 'DESKTOP_USAGE_TOUCH') return null;
  if (!isUsageSender(api, message, sender)) {
    sendResponse({ accepted: false });
    return false;
  }
  Promise.resolve().then(() => usage.touch()).then(
    () => sendResponse({ accepted: true }),
    () => sendResponse({ accepted: false }),
  );
  return true;
}

// Uses only an already-successful handshake; never starts a desktop or probes on its own.
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
  };
}
