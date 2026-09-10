import { DEDUPE_WINDOW_MS, MAX_INTENTS } from './limits.mjs';
import { normalizeTriple } from './normalize.mjs';

// Modes in which a long-lived intent may exist at all. §5.2.3 is explicit that a profile
// which never reached a paired desktop gets no queue: there would be nothing to drain it,
// and the user would be told their job is "pending" forever.
const MAY_QUEUE = new Set(['ready', 'unavailable', 'incompatible']);

/**
 * SaveIntent lifecycle.
 *
 * An intent records that the user confirmed these fields. It is deliberately not a message:
 * no messageId, no application id, no epoch. Those exist only once the user has chosen what
 * to bind to, against a desktop that answered.
 */
export function createIntents({ store, uuid, now }) {
  async function save({ fields, mode, force = false }) {
    if (!String(fields?.company ?? '').trim() || !String(fields?.title ?? '').trim()) {
      // The company and the job title are the two things nothing else can supply. Refusing
      // here is what keeps "do not fabricate" from turning into "save a blank record".
      return { status: 'rejected', reason: 'missing_fields' };
    }

    if (!MAY_QUEUE.has(mode)) {
      return { status: 'not_queued', reason: mode };
    }

    const triple = normalizeTriple(fields);
    // Read outside the transaction only what does not depend on the queue: these two are
    // stable for the life of the profile, and awaiting inside the callback is not possible.
    const pairing = await store.getPairing();
    const clientInstanceId = await store.clientInstanceId();

    const intent = {
      intentId: uuid(),
      clientInstanceId,
      fields: {
        company: fields.company.trim(),
        title: fields.title.trim(),
        location: String(fields.location ?? '').trim(),
        sourceUrl: String(fields.sourceUrl ?? ''),
        dedupeUrl: String(fields.dedupeUrl ?? '')
      },
      triple,
      createdAt: now().toISOString(),
      // A hint for the sidebar only. The epoch is deliberately not copied: an epoch on an
      // intent reads as a stamp, and an intent has never been stamped.
      lastSeenArchiveId: pairing?.archiveId ?? null,
      status: mode === 'ready' ? 'pending_bind' : 'pending_desktop'
    };

    // Deciding and appending happen in one queued step. As separate steps, two sidebar
    // clicks handled in the same worker turn both read a queue without their posting in it,
    // both conclude they are new, and the duplicate guard is defeated by timing alone.
    let outcome;
    await store.updateIntents(list => {
      if (!force) {
        const duplicate = list.find(item => item.triple === triple && isPending(item));
        if (duplicate) {
          const age = now().getTime() - Date.parse(duplicate.createdAt);
          outcome = { status: 'duplicate', intent: duplicate, recent: age <= DEDUPE_WINDOW_MS };
          return list;
        }
      }
      if (list.length >= MAX_INTENTS) {
        outcome = { status: 'rejected', reason: 'queue_full' };
        return list;
      }
      outcome = { status: 'queued', intent };
      return [...list, intent];
    });

    return outcome;
  }

  return {
    save,
    list: () => store.getIntents(),
    remove: intentId => store.updateIntents(list => list.filter(item => item.intentId !== intentId))
  };
}

function isPending(intent) {
  return intent.status === 'pending_desktop' || intent.status === 'pending_bind';
}
