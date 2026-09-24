import { DESKTOP_MESSAGE_TYPES, MSG } from './messages.mjs';
import { mayRecord } from './fillrecords.mjs';
import { SNAPSHOT_UPLOAD } from './uploads.mjs';
import { MAX_OUTBOX } from './limits.mjs';
import { templatesToCsv } from './legacy.mjs';

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
export function createRouter({ session, intents, outbox, drain, reconcile, resume = null, ai = null, legacy = null, fillRecords = null, store = null, uploads = null, extensionId }) {
  const aiCalls = new Map();
  const earlyAiCancels = new Set();
  async function handle(message) {
    const type = message?.type;
    if (!DESKTOP_MESSAGE_TYPES.has(type)) return null;

    if (type === MSG.probe) {
      const probe = await session.probe();
      return { mode: probe.mode, extensionId };
    }

    if (type === MSG.resumeRead) return resume.read();
    if (type === MSG.resumeUpdate) {
      return message.op === 'setActiveTemplate'
        ? resume.setActiveTemplate(message.templateId)
        : message.op === 'saveProfile'
          ? resume.saveProfile(message.profile, message.expectedRevision)
          : { status: 'invalid_payload' };
    }
    if (type === MSG.openView) return resume.openView(message.view);
    if (type === MSG.legacyStatus) {
      // Opening the status page or the side panel nudges a stalled migration along.
      await legacy.run();
      return legacy.status();
    }
    if (type === MSG.legacyResend) { await legacy.resend(); return legacy.status(); }
    if (type === MSG.legacyDiscard) { await legacy.discard(); return legacy.status(); }
    if (type === MSG.legacyDropKey) return legacy.dropOldKey();
    if (type === MSG.legacyUnmigrated) {
      const templates = await legacy.unmigratedTemplates();
      return { count: templates.length, csv: templates.length ? templatesToCsv(templates) : '' };
    }
    if (type === MSG.aiCancel) {
      const controller = aiCalls.get(message.requestId);
      controller?.abort();
      // Runtime messages from the offscreen page may reach this listener in a
      // different order. A cancel that arrives first must stop the later request.
      if (!controller && message.requestId != null) {
        earlyAiCancels.add(message.requestId);
      }
      return { cancelled: Boolean(controller) };
    }
    if (type === MSG.aiComplete) {
      if (message.requestId == null || aiCalls.has(message.requestId)) return { ok: false, reason: 'unavailable' };
      if (earlyAiCancels.delete(message.requestId)) return { ok: false, reason: 'cancelled' };
      const controller = new AbortController();
      aiCalls.set(message.requestId, controller);
      try {
        return await ai.complete({ purpose: message.purpose, system: message.system, user: message.user, signal: controller.signal });
      } finally {
        aiCalls.delete(message.requestId);
      }
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
      // An intent is the durable queue. On a live desktop it is not the end of the click:
      // no exact duplicate means the new application is written before this reply returns.
      if (result.status !== 'queued' || probe.mode !== 'ready') {
        return { ...result, mode: probe.mode, extensionId };
      }
      return finishOnlineSave({
        intent: result.intent,
        identity: probe.identity,
        mode: probe.mode,
        force: Boolean(message.force)
      });
    }

    if (type === MSG.continueSave) {
      // A saved intent the desktop could not take earlier. The user is asking again now.
      // Nothing here replays an old messageId or an old epoch.
      const probe = await session.probe();
      const intent = (await intents.list()).find(item => item.intentId === message.intentId);
      if (!intent) return { status: 'rejected', reason: 'unknown_intent', mode: probe.mode };
      if (probe.mode !== 'ready') return { status: 'queued', mode: probe.mode, intent, extensionId };
      return finishOnlineSave({
        intent,
        identity: probe.identity,
        mode: probe.mode,
        force: false
      });
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
      const expiredSnapshots = uploads ? await uploads.expired() : [];
      return { intents: await intents.list(), outbox: await outbox.list(), fillRecords: waiting, expiredSnapshots };
    }

    if (type === MSG.linkState) {
      // Answered from storage alone. Probing here would start the native host — and with it
      // the desktop application — after every single fill, for a card most users dismiss.
      return { everPaired: Boolean(await store?.hasEverPaired()) };
    }

    if (type === MSG.recordFill) {
      const probe = await session.probe();
      // Staged before the record exists, so a record never points at bytes that are not there.
      // Nothing is staged for a profile that may not keep a record at all.
      let snapshot = null;
      let snapshotIssue = null;
      if (message.snapshotTemplate && uploads && mayRecord(probe.mode)) {
        const staged = await uploads.stage(message.snapshotTemplate);
        snapshot = staged.snapshot ?? null;
        snapshotIssue = staged.issue ?? null;
      }
      const created = await fillRecords.create({ raw: message.raw, mode: probe.mode, snapshot });
      if (created.status !== 'recorded') {
        if (snapshot) await uploads.discard(snapshot.snapshotId);
        return { ...created, mode: probe.mode };
      }
      if (!message.applicationId || probe.mode !== 'ready') {
        return { ...created, mode: probe.mode, snapshotIssue };
      }
      const sent = await bindFill(created.record.recordId, message.applicationId, probe.identity);
      return { ...sent, record: created.record, mode: probe.mode, snapshotIssue: sent.snapshotIssue ?? snapshotIssue };
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
      const record = (await fillRecords.list()).find(item => item.recordId === message.recordId);
      const removed = await fillRecords.removeWaiting(message.recordId);
      if (!removed) return { ok: false, reason: 'not_waiting' };
      if (record?.snapshot && uploads) await uploads.abandon(record.snapshot.snapshotId);
      return { ok: true };
    }

    if (type === MSG.dropSnapshot) {
      // Delete the copy first, then the entry: a crash in between leaves an entry whose bytes
      // are gone — reported as such — rather than an upload that quietly comes back. A copy
      // IndexedDB will not delete yet leaves a tombstone instead (uploads.abandon).
      await uploads?.abandon(message.snapshotId);
      await fillRecords?.dropSnapshot(message.snapshotId);
      return { ok: true };
    }

    if (type === MSG.retry) {
      // The user asking again is not a new decision: the same messageId and the same stamped
      // epoch go back out, so the desktop can still recognise it as a replay.
      return drain.retryNow(message.messageId);
    }

    if (type === MSG.cancel) {
      // Giving up on the bound message. The intent or fill record stays, so the user can
      // pick a different application or delete it outright.
      const queue = await outbox.list();
      const entry = queue.find(item => item.messageId === message.messageId);
      if (entry?.messageType === SNAPSHOT_UPLOAD) {
        // Giving up on the snapshot only; the fill event is its own message.
        await uploads?.abandon(entry.snapshotId);
        await fillRecords?.dropSnapshot(entry.snapshotId);
        return { ok: true };
      }
      if (entry?.recordId && fillRecords) {
        // Giving up on a bound fill gives up on the snapshot bound with it: its chunks name
        // this application and could not be sent to another one.
        for (const related of queue.filter(item => item.recordId === entry.recordId && item.messageType === SNAPSHOT_UPLOAD)) {
          await uploads?.abandon(related.snapshotId);
        }
        await drain.cancel(entry.messageId);
        await fillRecords.unbind(entry.recordId, { dropSnapshot: true });
        return { ok: true };
      }
      await drain.cancel(message.messageId);
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

  // Live desktop, after the intent exists. Same-company applications are not a choice:
  // a different title is a new application. Only an exact duplicate asks the user.
  // `force` is the explicit "save again" click, which already chose to create another one.
  async function finishOnlineSave({ intent, identity, mode, force }) {
    const candidates = await outbox.queryCandidates({ identity, fields: intent.fields });
    if (candidates.status !== 'ok') {
      return { status: 'queued', mode, intent, reason: 'candidates_unavailable', extensionId };
    }
    const exact = candidates.exact ?? [];
    if (exact.length > 0 && !force) {
      return { status: 'needs_choice', mode, intent, exact, extensionId };
    }
    const bound = await outbox.bindAndSend({
      intentId: intent.intentId,
      applicationId: null,
      identity
    });
    return { ...bound, mode, intent, extensionId };
  }

  // Claim first, then queue. The claim is what makes a second click a duplicate; a queue
  // that refuses the entry hands the record back so it is not stuck as "bound" to nothing.
  async function bindFill(recordId, applicationId, identity) {
    if (!applicationId) return { status: 'rejected', reason: 'no_application' };
    const claim = await fillRecords.claim(recordId, applicationId);
    if (claim.status === 'unknown') return { status: 'rejected', reason: 'unknown_record' };
    if (claim.status === 'duplicate') return { status: 'duplicate' };

    // The snapshot is bound in IndexedDB before either message is queued (link/uploads.mjs).
    let upload = null;
    let snapshotIssue = null;
    if (claim.record.snapshot && uploads && (await outbox.list()).length > MAX_OUTBOX - 2) {
      // The event and its upload go in together or not at all: an event queued in the last
      // free place would name a snapshot that has nowhere to wait.
      await fillRecords.unbind(recordId);
      return { status: 'rejected', reason: 'queue_full' };
    }
    if (claim.record.snapshot && uploads) {
      const prepared = await uploads.prepare({ record: claim.record, applicationId, identity });
      upload = prepared.entry ?? null;
      snapshotIssue = prepared.issue ?? null;
    }

    const result = await outbox.sendFill({
      record: claim.record,
      applicationId,
      identity,
      snapshot: upload ? claim.record.snapshot : null
    });
    if (result.status === 'rejected') {
      // prepare() already wrote the binding into IndexedDB; take it back, or the next
      // repair() would send a snapshot whose event was never queued.
      if (upload) await uploads.release(upload.snapshotId);
      await fillRecords.unbind(recordId);
      return result;
    }
    // Queued after the event, and held until the event is accepted (drain.waitsForFill).
    // Started by the worker once the sidebar has its answer; a snapshot of a few hundred KiB
    // is several host starts.
    if (upload) {
      const added = await outbox.add(upload);
      if (added.status === 'rejected') snapshotIssue = 'queue_full';
    }
    return { ...result, snapshotIssue, uploadQueued: Boolean(upload) && !snapshotIssue };
  }

  return { handle };
}
