import { buildEnvelope } from './envelope.mjs';
import { sendOnce } from './transport.mjs';
import { MAX_OUTBOX } from './limits.mjs';
import { nextDelayMs } from './drain.mjs';

/**
 * Bound messages: the queue that exists once the user has chosen what to bind to.
 *
 * Two rules shape everything here:
 *
 *  - The entry is persisted before it is sent. If the worker dies between the send and the
 *    reply, the same messageId has to be there to retry with; minting a new one on the way
 *    back is how one job becomes two applications.
 *  - `sourceRestoreEpoch` is stamped at bind time and never rewritten. The envelope follows
 *    the current handshake, the payload remembers what the user actually chose. Refreshing
 *    the payload would silently replay the job into an archive the user never saw.
 */
export function createOutbox({ store, uuid, now, sendNative, sleep }) {
  const wire = { sendNative, sleep };

  async function queryCandidates({ identity, fields }) {
    if (!identity) return { status: 'rejected', reason: 'no_identity' };

    const payload = { company: fields.company, title: fields.title };
    if (fields.sourceUrl) payload.sourceUrl = fields.sourceUrl;

    const message = await buildEnvelope({
      messageType: 'application.queryCandidates',
      messageId: uuid(),
      clientInstanceId: await store.clientInstanceId(),
      payload,
      identity,
      now
    });

    const result = await sendOnce(message, wire);
    if (result.status !== 'ok') {
      // An empty list would read as "nothing matches", which pushes the user into creating a
      // duplicate. An unreachable desktop has to say so.
      return { status: result.status, code: result.code };
    }
    return {
      status: 'ok',
      exact: result.response.payload.exact ?? [],
      sameCompany: result.response.payload.sameCompany ?? []
    };
  }

  async function bindAndSend({ intentId, applicationId = null, identity }) {
    if (!identity) return { status: 'rejected', reason: 'no_identity' };

    const intents = await store.getIntents();
    const intent = intents.find(item => item.intentId === intentId);
    if (!intent) return { status: 'rejected', reason: 'unknown_intent' };

    const payload = { company: intent.fields.company, title: intent.fields.title };
    if (intent.fields.sourceUrl) payload.sourceUrl = intent.fields.sourceUrl;
    if (intent.fields.location) payload.location = intent.fields.location;
    if (applicationId) payload.applicationId = applicationId;

    const entry = {
      messageId: uuid(),
      intentId,
      clientInstanceId: await store.clientInstanceId(),
      messageType: 'job.save',
      archiveId: identity.archiveId,
      sourceRestoreEpoch: identity.restoreEpoch,
      applicationId,
      payload,
      createdAt: now().toISOString(),
      bytes: new TextEncoder().encode(JSON.stringify(payload)).length,
      status: 'pending',
      attempts: 0,
      // Due immediately. Every later attempt gets a time from the backoff ladder.
      nextAttemptAt: now().toISOString(),
      lastError: null
    };

    // Both guards live in the same queued step as the append.
    //
    // The intent guard is what makes a double-clicked bind button harmless: two entries for
    // one intent carry two messageIds, and two messageIds are two applications, because the
    // desktop can only recognise a replay by identity. Checked outside the callback, both
    // clicks see a queue without the other's entry in it.
    let outcome = null;
    await store.updateOutbox(list => {
      if (intentId && list.some(item => item.intentId === intentId)) {
        outcome = { status: 'duplicate', reason: 'already_queued' };
        return list;
      }
      if (list.length >= MAX_OUTBOX) {
        outcome = { status: 'rejected', reason: 'queue_full' };
        return list;
      }
      return [...list, entry];
    });
    if (outcome) return outcome;

    return deliver(entry, identity);
  }

  /**
   * One pass over the pending entries.
   *
   * Serial on purpose: parallel sends race for the same cold start, and the host answers all
   * but one of them with `unavailable` for no reason.
   */
  async function drainOnce({ identity }) {
    const saved = [];
    const pending = [];
    const failed = [];

    for (const entry of await store.getOutbox()) {
      if (entry.status !== 'pending') continue;
      if (!isDue(entry)) continue;
      const result = await deliver(entry, identity);
      if (result.status === 'saved') saved.push(result);
      else if (result.status === 'failed') failed.push(result);
      else pending.push(result);
    }

    return { saved, pending, failed };
  }

  async function deliver(entry, identity) {
    if (!identity) return { status: 'pending', entry };

    const message = await buildEnvelope({
      messageType: entry.messageType,
      messageId: entry.messageId,
      clientInstanceId: entry.clientInstanceId,
      payload: entry.payload,
      identity,
      sourceRestoreEpoch: entry.sourceRestoreEpoch,
      now
    });

    const result = await sendOnce(message, wire);

    if (result.status === 'ok') {
      // The desktop has committed. Only now may the intent and the queue entry go, and only
      // now may the sidebar say the desktop has it.
      await store.updateOutbox(list => list.filter(item => item.messageId !== entry.messageId));
      if (entry.intentId) {
        await store.updateIntents(list => list.filter(item => item.intentId !== entry.intentId));
      }
      return {
        status: 'saved',
        messageId: entry.messageId,
        resultId: result.resultId,
        applicationId: entry.applicationId ?? result.resultId
      };
    }

    if (result.status === 'fatal') {
      await patch(entry.messageId, item => ({
        ...item,
        status: 'failed',
        attempts: item.attempts + 1,
        lastError: result.code
      }));
      return { status: 'failed', messageId: entry.messageId, code: result.code };
    }

    const attempts = entry.attempts + 1;
    const delay = nextDelayMs(attempts);
    await patch(entry.messageId, item => ({
      ...item,
      attempts,
      // No rung left: stop retrying and say so. The entry is not lost and not failed — it is
      // waiting for the user to retry it or give up on it.
      status: delay === null ? 'stalled' : 'pending',
      nextAttemptAt: delay === null ? null : new Date(now().getTime() + delay).toISOString(),
      lastError: result.code ?? result.status
    }));
    return {
      status: delay === null ? 'stalled' : 'pending',
      messageId: entry.messageId,
      code: result.code ?? result.status
    };
  }

  function isDue(entry) {
    if (!entry.nextAttemptAt) return false;
    return Date.parse(entry.nextAttemptAt) <= now().getTime();
  }

  // A message that is only waiting for the retry ladder. A paused or needs_user entry is
  // waiting for something else entirely: its stamped epoch no longer exists on the desktop,
  // so sending it again is not a retry, it is a write the desktop has to refuse.
  const RETRYABLE_STATES = new Set(['pending', 'stalled', 'failed']);

  /**
   * Used by a manual retry: clear the wait and un-stall the entry.
   *
   * The identity, the messageId and the stamped epoch are untouched — this is the same
   * message, sent again. Refuses anything the reconcile flow owns.
   */
  async function markDue(messageId, at) {
    const entry = (await store.getOutbox()).find(item => item.messageId === messageId);
    if (!entry) return { status: 'rejected', reason: 'unknown_message' };
    if (!RETRYABLE_STATES.has(entry.status)) {
      return { status: 'rejected', reason: 'awaiting_reconcile' };
    }
    await patch(messageId, item => ({ ...item, status: 'pending', nextAttemptAt: at.toISOString() }));
    return { status: 'ok' };
  }

  async function deliverOne(messageId, identity) {
    const entry = (await store.getOutbox()).find(item => item.messageId === messageId);
    if (!entry) return { status: 'rejected', reason: 'unknown_message' };
    return deliver(entry, identity);
  }

  const patch = (messageId, change) => store.updateOutbox(list =>
    list.map(item => (item.messageId === messageId ? change(item) : item))
  );

  return {
    queryCandidates,
    bindAndSend,
    drainOnce,
    deliverOne,
    markDue,
    list: () => store.getOutbox(),
    remove: messageId => store.updateOutbox(list => list.filter(item => item.messageId !== messageId))
  };
}
