import { nativeSender, sleep, storageAdapter } from './chrome.mjs';
import { createStore } from './store.mjs';
import { createSession } from './session.mjs';
import { createIntents } from './intents.mjs';
import { createOutbox } from './outbox.mjs';
import { createDrain, ALARM_NAME } from './drain.mjs';
import { createRouter } from './router.mjs';
import { DESKTOP_MESSAGE_TYPES } from './messages.mjs';

/**
 * Compose the desktop link and hang it off the service worker's message port.
 *
 * Registered as its own listener rather than folded into the existing one: the AI host and
 * the manager toggle are unrelated, and a shared listener that returns the wrong value for
 * one of them breaks the other.
 */
export function installDesktopLink(api) {
  const store = createStore({
    storage: storageAdapter(api),
    uuid: () => crypto.randomUUID()
  });

  const deps = {
    store,
    sendNative: nativeSender(api),
    sleep,
    uuid: () => crypto.randomUUID(),
    now: () => new Date()
  };

  const session = createSession(deps);
  const outbox = createOutbox(deps);
  const drain = createDrain({ session, outbox, alarms: api.alarms, now: deps.now });

  const router = createRouter({
    session,
    intents: createIntents(deps),
    outbox,
    drain,
    extensionId: api.runtime.id
  });

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!DESKTOP_MESSAGE_TYPES.has(message?.type)) return false;
    router.handle(message).then(sendResponse).catch(error => {
      // The sidebar is waiting on this port. An unhandled rejection here leaves the user
      // looking at a spinner with no way to find out what happened.
      sendResponse({ error: true, code: error?.code ?? 'unavailable', message: error?.message });
    });
    return true;
  });

  api.alarms.onAlarm.addListener(alarm => {
    if (alarm?.name !== ALARM_NAME) return;
    drain.run().catch(() => {});
  });

  // A cold worker has no timers left from its previous life. Without this pass the queue
  // waits for an alarm that nothing rescheduled, which for an offline queue means forever.
  drain.run().catch(() => {});

  return router;
}
