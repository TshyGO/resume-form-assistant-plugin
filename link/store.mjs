// The four keys D01 allocated to the desktop link. Nothing else in chrome.storage.local
// belongs to it.
export const KEYS = {
  intents: 'desktopSaveIntents',
  outbox: 'desktopOutbox',
  clientInstanceId: 'desktopClientInstanceId',
  pairing: 'desktopPairing'
};

// Keys the existing plugin owns. Listed so the boundary is testable, not just documented.
export const RESERVED_KEYS = [
  'templates',
  'activeTemplateId',
  'aiConfig',
  'resumeProUpdateCache',
  'resumeProDismissedVersion'
];

/**
 * Queue storage over an injected chrome.storage.local.
 *
 * Every read-modify-write runs through one promise chain. The service worker handles
 * sidebar messages concurrently, and two unserialised appends lose one of the entries —
 * which the user was already told is pending.
 */
export function createStore({ storage, uuid }) {
  let tail = Promise.resolve();

  const serialise = work => {
    const next = tail.then(work, work);
    // Keep the chain alive after a failed step so one bad write does not wedge the queue.
    tail = next.then(() => {}, () => {});
    return next;
  };

  const readList = async key => {
    const stored = await storage.get([key]);
    const value = stored[key];
    return Array.isArray(value) ? value : [];
  };

  const updateList = (key, change) => serialise(async () => {
    const next = change(await readList(key));
    await storage.set({ [key]: next });
    return next;
  });

  return {
    async clientInstanceId() {
      return serialise(async () => {
        const stored = await storage.get([KEYS.clientInstanceId]);
        const existing = stored[KEYS.clientInstanceId];
        if (typeof existing === 'string' && existing) return existing;
        const minted = uuid();
        await storage.set({ [KEYS.clientInstanceId]: minted });
        return minted;
      });
    },

    getIntents: () => readList(KEYS.intents),
    updateIntents: change => updateList(KEYS.intents, change),

    getOutbox: () => readList(KEYS.outbox),
    updateOutbox: change => updateList(KEYS.outbox, change),

    async getPairing() {
      const stored = await storage.get([KEYS.pairing]);
      return stored[KEYS.pairing] ?? null;
    },

    setPairing: pairing => serialise(() => storage.set({ [KEYS.pairing]: pairing })),

    // "Has this profile ever reached a paired desktop?" is the only question the pairing
    // record answers. It is a hint for the degraded-mode copy, never a credential: a stored
    // epoch does not authorise a write, only a fresh handshake does.
    async hasEverPaired() {
      const stored = await storage.get([KEYS.pairing]);
      return Boolean(stored[KEYS.pairing]?.archiveId);
    }
  };
}
