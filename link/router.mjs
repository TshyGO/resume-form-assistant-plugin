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
export function createRouter({ session, intents, extensionId }) {
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

    if (type === MSG.listQueue) {
      return { intents: await intents.list() };
    }

    if (type === MSG.removeIntent) {
      await intents.remove(message.intentId);
      return { ok: true };
    }

    return null;
  }

  return { handle };
}
