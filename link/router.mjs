import { DESKTOP_MESSAGE_TYPES, MSG } from './messages.mjs';

/**
 * Turns sidebar messages into desktop-link operations.
 *
 * Returns null for anything it does not own, so the existing service worker listeners keep
 * working unchanged.
 *
 * Replies carry a status and a mode, never finished user-facing text. "Pending sync" and
 * "saved on the desktop" are different claims, and the difference has to survive the trip to
 * the sidebar rather than being decided by whoever formats the string.
 */
export function createRouter({ session, intents, outbox, drain, reconcile, fillRecords = null, store = null, extensionId }) {
  async function handle(message) {
    const type = message?.type;
    if (!DESKTOP_MESSAGE_TYPES.has(type)) return null;

    if (type === MSG.probe) {
      const probe = await session.probe();
      return { mode: probe.mode, extensionId };
    }

    if (type === MSG.saveJob) {
      // The mode is probed at save time, not cached: the desktop may have been opened or
      // closed since the sidebar was drawn.
      const probe = await session.probe();
      const result = await intents.save({
        fields: message.fields,
        mode: probe.mode,
        force: Boolean(message.force)
      });
      return { ...result, mode: probe.mode, extensionId };
    }

    if (type === MSG.candidates) {
      const probe = await session.probe();
      if (probe.mode !== 'ready') return { status: probe.mode };
      const intent = (await intents.list()).find(item => item.intentId === message.intentId);
      if (!intent) return { status: 'unknown_intent' };
      return outbox.queryCandidates({ identity: probe.identity, fields: intent.fields });
    }

    if (type === MSG.bind) {
      // The identity is taken from a handshake made now, not from whatever was current when
      // the candidate list was drawn. The desktop may have been restored in between, and the
      // epoch that gets stamped has to be the one the write will actually be judged against.
      const probe = await session.probe();
      if (probe.mode !== 'ready') return { status: 'pending', mode: probe.mode };
      return outbox.bindAndSend({
        intentId: message.intentId,
        applicationId: message.applicationId ?? null,
        identity: probe.identity
      });
    }

    if (type === MSG.listQueue) {
      // Bound records are shown through their outbox entry; only the waiting ones are listed.
      const waiting = fillRecords
        ? (await fillRecords.list()).filter(record => record.status === 'pending_bind')
        : [];
      return { intents: await intents.list(), outbox: await outbox.list(), fillRecords: waiting };
    }

    if (type === MSG.linkState) {
      // Answered from storage alone. Probing here would start the native host — and with it
      // the desktop application — after every single fill, for a card most users dismiss.
      return { everPaired: Boolean(await store?.hasEverPaired()) };
    }

    if (type === MSG.recordFill) {
      const probe = await session.probe();
      const created = await fillRecords.create({ raw: message.raw, mode: probe.mode });
      if (created.status !== 'recorded') return { ...created, mode: probe.mode };
      if (!message.applicationId || probe.mode !== 'ready') return { ...created, mode: probe.mode };
      const sent = await bindFill(created.record.recordId, message.applicationId, probe.identity);
      return { ...sent, record: created.record, mode: probe.mode };
    }

    if (type === MSG.bindFill) {
      // A fresh handshake, for the same reason as MSG.bind: the stamped epoch has to be the
      // one the write will be judged against, not whatever was current when the list was drawn.
      const probe = await session.probe();
      // Nothing is queued without a desktop to stamp the epoch: the record keeps waiting for a
      // choice, and saying "pending" would promise an automatic send that will not happen.
      if (probe.mode !== 'ready') return { status: 'recorded', mode: probe.mode };
      return bindFill(message.recordId, message.applicationId, probe.identity);
    }

    if (type === MSG.removeFill) {
      const removed = await fillRecords.removeWaiting(message.recordId);
      return removed ? { ok: true } : { ok: false, reason: 'not_waiting' };
    }

    if (type === MSG.retry) {
      // The user asking again is not a new decision: the same messageId and the same stamped
      // epoch go back out, so the desktop can still recognise it as a replay.
      return drain.retryNow(message.messageId);
    }

    if (type === MSG.cancel) {
      // Giving up on the bound message. The intent or fill record stays, so the user can
      // pick a different application or delete it outright.
      const entry = (await outbox.list()).find(item => item.messageId === message.messageId);
      await drain.cancel(message.messageId);
      if (entry?.recordId && fillRecords) await fillRecords.unbind(entry.recordId);
      return { ok: true };
    }

    if (type === MSG.candidatesFor) {
      const probe = await session.probe();
      if (probe.mode !== 'ready') return { status: probe.mode };
      return outbox.queryCandidates({ identity: probe.identity, fields: message.fields });
    }

    if (type === MSG.confirmSubmit) {
      const probe = await session.probe();
      if (probe.mode !== 'ready') return { status: 'pending', mode: probe.mode };
      return outbox.confirmSubmit({ applicationId: message.applicationId, identity: probe.identity });
    }

    if (type === MSG.resolve) {
      // Associate, discard or save again. Only the user gets to make this call: none of the
      // four unresolved reconcile answers authorises the plugin to decide on its own.
      const probe = message.choice === 'discard' ? { identity: null } : await session.probe();
      return reconcile.resolve(message.messageId, {
        choice: message.choice,
        applicationId: message.applicationId ?? null,
        identity: probe.identity
      });
    }

    if (type === MSG.removeIntent) {
      await intents.remove(message.intentId);
      return { ok: true };
    }

    return null;
  }

  // Claim first, then queue. The claim is what makes a second click a duplicate; a queue
  // that refuses the entry hands the record back so it is not stuck as "bound" to nothing.
  async function bindFill(recordId, applicationId, identity) {
    if (!applicationId) return { status: 'rejected', reason: 'no_application' };
    const claim = await fillRecords.claim(recordId, applicationId);
    if (claim.status === 'unknown') return { status: 'rejected', reason: 'unknown_record' };
    if (claim.status === 'duplicate') return { status: 'duplicate' };
    const result = await outbox.sendFill({ record: claim.record, applicationId, identity });
    if (result.status === 'rejected') await fillRecords.unbind(recordId);
    return result;
  }

  return { handle };
}
