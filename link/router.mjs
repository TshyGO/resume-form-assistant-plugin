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
export function createRouter({ session, intents, outbox, drain, reconcile, extensionId }) {
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
      return { intents: await intents.list(), outbox: await outbox.list() };
    }

    if (type === MSG.retry) {
      // The user asking again is not a new decision: the same messageId and the same stamped
      // epoch go back out, so the desktop can still recognise it as a replay.
      return drain.retryNow(message.messageId);
    }

    if (type === MSG.cancel) {
      // Giving up on the bound message. The intent stays, so the user can pick a different
      // application or delete it outright.
      await drain.cancel(message.messageId);
      return { ok: true };
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

  return { handle };
}
