import { idbStore, nativePort, nativeSender, sleep, storageAdapter } from './chrome.mjs';
import { createStore } from './store.mjs';
import { createSession } from './session.mjs';
import { createResume } from './resume.mjs';
import { createAi } from './ai.mjs';
import { createLegacy, LEGACY_ALARM } from './legacy.mjs';
import '../profile-fields.js';
import { createIntents } from './intents.mjs';
import { createOutbox } from './outbox.mjs';
import { createReconcile } from './reconcile.mjs';
import { createDrain, ALARM_NAME } from './drain.mjs';
import { createRouter } from './router.mjs';
import { createFillRecords } from './fillrecords.mjs';
import { createStaging } from './staging.mjs';
import { createUploads } from './uploads.mjs';
import { DESKTOP_MESSAGE_TYPES } from './messages.mjs';

/**
 * Compose the desktop link and hang it off the service worker's message port.
 *
 * Registered as its own listener rather than folded into the existing one: the AI host and
 * the manager toggle are unrelated, and a shared listener that returns the wrong value for
 * one of them breaks the other.
 */
const EXTENSION_PAGE_ONLY = new Set(['DESKTOP_LEGACY_DISCARD', 'DESKTOP_LEGACY_DROP_KEY', 'DESKTOP_LEGACY_UNMIGRATED']);

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
    now: () => new Date(),
    getManifest: () => api.runtime.getManifest()
  };

  const staging = createStaging({ kv: idbStore(), now: deps.now, uuid: deps.uuid });
  const uploads = createUploads({ ...deps, staging });
  const session = createSession(deps);
  const resume = createResume({ ...deps, session });
  const ai = createAi({ ...deps, session, port: nativePort(api) });
  const legacy = createLegacy({
    ...deps, session, storage: storageAdapter(api), alarms: api.alarms,
    profileApi: globalThis.ResumeProProfile
  });
  const outbox = createOutbox({ ...deps, uploads });
  const reconcile = createReconcile({ ...deps, outbox, uploads });
  const drain = createDrain({ session, outbox, reconcile, alarms: api.alarms, now: deps.now });

  const router = createRouter({
    session,
    resume,
    ai,
    legacy,
    intents: createIntents(deps),
    outbox,
    drain,
    reconcile,
    fillRecords: createFillRecords(deps),
    store,
    uploads,
    extensionId: api.runtime.id
  });

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!DESKTOP_MESSAGE_TYPES.has(message?.type)) return false;
    // Deleting old data or handing out whole templates is for the extension's own pages
    // (the status page), never for a content script running inside a web page.
    if (EXTENSION_PAGE_ONLY.has(message.type) && !sender?.url?.startsWith(api.runtime.getURL(''))) {
      sendResponse({ error: true, code: 'forbidden' });
      return false;
    }
    if (message.type === 'DESKTOP_AI_COMPLETE' || message.type === 'DESKTOP_AI_CANCEL') {
      if (sender?.id !== api.runtime.id || sender?.url !== api.runtime.getURL('ai-host.html')) {
        sendResponse(message.type === 'DESKTOP_AI_CANCEL' ? { cancelled: false } : { ok: false, reason: 'unavailable' });
        return false;
      }
    }
    router.handle(message).then(result => {
      sendResponse(result);
      // A bound snapshot starts uploading once the sidebar has its answer, not before it.
      if (result?.uploadQueued) drain.run().catch(() => {});
    }).catch(error => {
      // The sidebar is waiting on this port. An unhandled rejection here leaves the user
      // looking at a spinner with no way to find out what happened.
      sendResponse({ error: true, code: error?.code ?? 'unavailable', message: error?.message });
    });
    return true;
  });

  api.alarms.onAlarm.addListener(alarm => {
    if (alarm?.name === LEGACY_ALARM) { legacy.run().catch(() => {}); return; }
    if (alarm?.name !== ALARM_NAME) return;
    drain.run().catch(() => {});
  });

  // After an update, and at browser start: move 0.4.0 data over if there is any. With no
  // old data and nothing in flight this reads storage and stops, without a native call.
  api.runtime.onInstalled?.addListener(() => { legacy.run().catch(() => {}); });
  api.runtime.onStartup?.addListener(() => { legacy.run().catch(() => {}); });

  // A cold worker has no timers left from its previous life. Without this pass the queue
  // waits for an alarm that nothing rescheduled, which for an offline queue means forever.
  // Repair first: IndexedDB and the queue share no transaction (§8.5), and a snapshot bound
  // just before the last worker died may only exist on the IndexedDB side.
  uploads.repair().catch(() => {}).then(() => drain.run()).catch(() => {});

  return router;
}
