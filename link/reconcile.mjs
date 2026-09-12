import { buildEnvelope } from './envelope.mjs';
import { sendOnce } from './transport.mjs';
import { forgetSource } from './outbox.mjs';
import { SNAPSHOT_UPLOAD } from './uploads.mjs';
import {
  MAX_RECONCILE_ITEMS,
  payloadBodySha256,
  snapshotChunkIdentitySha256
} from './protocol/validate.mjs';

/**
 * What happens to the queue when the desktop's archive has been restored.
 *
 * A restore mints a new `restoreEpoch`. Every queued message stamped with the old one is
 * paused immediately: the desktop would refuse it, and if it did not, the job would land in
 * an archive the user never chose. Paused messages may only ask a read-only question —
 * `outbox.reconcile` — and the answer never authorises a replay.
 */
export function createReconcile({ store, outbox, uuid, now, sendNative, sleep, uploads = null }) {
  const wire = { sendNative, sleep };

  /** Freeze everything whose bound epoch is not the current one. */
  async function pauseStale(identity) {
    await store.updateOutbox(list => list.map(entry => {
      if (entry.sourceRestoreEpoch === identity.restoreEpoch) return entry;
      if (entry.status === 'paused' || entry.status === 'needs_user') return entry;
      return { ...entry, status: 'paused', nextAttemptAt: null };
    }));
  }

  /** Ask the desktop what it knows about each paused message. */
  async function run(identity) {
    // A snapshot upload stays paused here: its identity is one per chunk, and asking about
    // it is a separate batch (see reconcileSnapshots).
    const paused = (await store.getOutbox()).filter(entry => entry.status === 'paused' && entry.messageType !== SNAPSHOT_UPLOAD);
    const report = { applied: [], needsUser: [], unreachable: [] };

    for (let at = 0; at < paused.length; at += MAX_RECONCILE_ITEMS) {
      const batch = paused.slice(at, at + MAX_RECONCILE_ITEMS);
      const items = await Promise.all(batch.map(identityOf));

      const message = await buildEnvelope({
        messageType: 'outbox.reconcile',
        messageId: uuid(),
        clientInstanceId: await store.clientInstanceId(),
        payload: { items },
        identity,
        now
      });

      const result = await sendOnce(message, wire);
      if (result.status !== 'ok') {
        report.unreachable.push(...batch.map(entry => entry.messageId));
        continue;
      }

      for (const answer of result.response.payload.items) {
        const entry = batch.find(item => item.messageId === answer.messageId);
        if (!entry) continue;

        if (answer.status === 'applied') {
          // The desktop already executed it. Drop the queue entry and the intent behind it,
          // and add nothing: `applied` confirms history, it does not license a rewrite.
          await store.updateOutbox(list => list.filter(item => item.messageId !== entry.messageId));
          await forgetSource(store, entry);
          report.applied.push({ messageId: entry.messageId, resultId: answer.resultId });
          continue;
        }

        // purged, not_found, conflict, unverifiable: all four stop here. In particular
        // not_found means "this archive holds no receipt", never "this never happened".
        await patch(entry.messageId, item => ({
          ...item,
          status: 'needs_user',
          reconcileStatus: answer.status,
          nextAttemptAt: null
        }));
        report.needsUser.push({ messageId: entry.messageId, status: answer.status });
      }
    }

    await reconcileUploads(identity, report);
    return report;
  }

  /**
   * Paused snapshot uploads: every chunk is asked about by its full old identity, in batches
   * the protocol allows. No answer settles a snapshot on its own — not even `applied` for every
   * chunk, which proves the chunks are in this archive's history, not that the snapshot was
   * ever completed there. The entry waits for the user with the answer that most needs them.
   */
  async function reconcileUploads(identity, report) {
    const paused = (await store.getOutbox()).filter(entry => entry.status === 'paused' && entry.messageType === SNAPSHOT_UPLOAD);
    if (!paused.length) return;

    const items = [];
    for (const entry of paused) {
      for (const chunk of entry.chunks) items.push(await chunkIdentityOf(entry, chunk));
    }

    const answers = new Map();
    for (let at = 0; at < items.length; at += MAX_RECONCILE_ITEMS) {
      const batch = items.slice(at, at + MAX_RECONCILE_ITEMS);
      const message = await buildEnvelope({
        messageType: 'outbox.reconcile',
        messageId: uuid(),
        clientInstanceId: await store.clientInstanceId(),
        payload: { items: batch },
        identity,
        now
      });
      const result = await sendOnce(message, wire);
      if (result.status !== 'ok') continue;
      for (const answer of result.response.payload.items) {
        answers.set(`${answer.snapshotId}:${answer.chunkIndex}`, answer.status);
      }
    }

    for (const entry of paused) {
      const statuses = entry.chunks.map(chunk => answers.get(`${entry.snapshotId}:${chunk.chunkIndex}`));
      if (statuses.some(status => status === undefined)) {
        // Part of it went unanswered: stay paused and ask again on the next pass.
        report.unreachable.push(entry.messageId);
        continue;
      }
      const summary = summarise(statuses);
      await patch(entry.messageId, item => ({
        ...item,
        status: 'needs_user',
        reconcileStatus: summary,
        chunkReconcile: statuses,
        nextAttemptAt: null
      }));
      report.needsUser.push({ messageId: entry.messageId, status: summary });
    }
  }

  async function chunkIdentityOf(entry, chunk) {
    return {
      clientInstanceId: entry.clientInstanceId,
      messageId: chunk.chunkMessageId,
      sourceRestoreEpoch: entry.sourceRestoreEpoch,
      payloadSha256: await snapshotChunkIdentitySha256({
        sourceRestoreEpoch: entry.sourceRestoreEpoch,
        snapshotId: entry.snapshotId,
        applicationId: entry.applicationId,
        chunkIndex: chunk.chunkIndex,
        chunkCount: entry.chunkCount,
        chunkSha256: chunk.chunkSha256,
        snapshotSha256: entry.sha256,
        byteSize: entry.byteSize
      }),
      snapshotId: entry.snapshotId,
      chunkIndex: chunk.chunkIndex
    };
  }

  /**
   * The three ways out of a paused message: bind it to an application, discard it, or write
   * it again under a new identity.
   *
   * The replacement is persisted before it is sent. Without that, a failed send would mint a
   * third identity on the next attempt and the user would have asked once for two writes.
   */
  async function resolve(messageId, { choice, applicationId = null, identity = null }) {
    const entry = (await store.getOutbox()).find(item => item.messageId === messageId);
    if (!entry) return { status: 'rejected', reason: 'unknown_message' };
    if (entry.status !== 'paused' && entry.status !== 'needs_user') {
      // A sidebar rendered before a drain pass can still be showing these buttons for an
      // entry that is back on the normal ladder. Minting a replacement identity for a
      // message that may already be in flight is how one decision becomes two applications.
      return { status: 'rejected', reason: 'not_paused' };
    }

    if (entry.messageType === SNAPSHOT_UPLOAD) return resolveUpload(entry, { choice, applicationId, identity });

    if (choice === 'discard') {
      await store.updateOutbox(list => list.filter(item => item.messageId !== messageId));
      await forgetSource(store, entry);
      return { status: 'discarded' };
    }

    if (!identity) return { status: 'rejected', reason: 'no_identity' };

    const payload = { ...entry.payload };
    delete payload.sourceRestoreEpoch;
    delete payload.payloadSha256;
    if (choice === 'associate') {
      if (!applicationId) return { status: 'rejected', reason: 'no_application' };
      payload.applicationId = applicationId;
    }

    const replacement = {
      ...entry,
      messageId: uuid(),
      archiveId: identity.archiveId,
      sourceRestoreEpoch: identity.restoreEpoch,
      applicationId: payload.applicationId ?? null,
      payload,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now().toISOString(),
      reconcileStatus: null,
      lastError: null,
      // Keeps the trail from the old archive to the new write. The old envelope is never
      // valid again; this is a record, not a credential.
      previousIdentity: {
        clientInstanceId: entry.clientInstanceId,
        messageId: entry.messageId,
        sourceRestoreEpoch: entry.sourceRestoreEpoch
      }
    };

    await store.updateOutbox(list => [
      ...list.filter(item => item.messageId !== messageId),
      replacement
    ]);

    return outbox.deliverOne(replacement.messageId, identity);
  }

  /**
   * A paused snapshot upload: discard it, or upload the same bytes again under a new identity
   * against the archive that exists now. "Associate" is the same act aimed at a chosen
   * application — the application is part of every chunk's identity, so there is no way to
   * re-point the old chunks.
   */
  async function resolveUpload(entry, { choice, applicationId, identity }) {
    if (choice === 'discard') {
      // abandon() keeps a tombstone if IndexedDB will not delete the copy yet.
      if (uploads) await uploads.abandon(entry.snapshotId);
      else await store.updateOutbox(list => list.filter(item => item.messageId !== entry.messageId));
      return { status: 'discarded' };
    }
    if (!identity) return { status: 'rejected', reason: 'no_identity' };
    if (!uploads) return { status: 'rejected', reason: 'unsupported' };

    // Claimed in one queued step before anything is minted. Two clicks would otherwise both
    // read the same paused entry and stage the same bytes under two new snapshot ids.
    let claimed = false;
    await store.updateOutbox(list => list.map(item => {
      if (item.messageId !== entry.messageId) return item;
      if (item.status !== 'paused' && item.status !== 'needs_user') return item;
      claimed = true;
      return { ...item, status: 'resaving', resumeStatus: item.status };
    }));
    if (!claimed) return { status: 'rejected', reason: 'not_paused' };

    const moved = await uploads.resave(entry, { identity, applicationId: choice === 'associate' ? applicationId : null });
    if (!moved.entry) {
      await patch(entry.messageId, item => ({ ...item, status: item.resumeStatus ?? 'needs_user', resumeStatus: undefined }));
      return { status: 'rejected', reason: moved.issue };
    }
    const replacement = moved.entry;

    await store.updateOutbox(list => list
      .filter(item => item.messageId !== entry.messageId)
      .map(item => (
        // A fill still waiting on the same decision should name the snapshot that will exist.
        item.recordId && item.recordId === entry.recordId && item.messageType === 'fill.submit'
          && (item.status === 'paused' || item.status === 'needs_user')
          ? { ...item, payload: { ...item.payload, snapshotId: replacement.snapshotId } }
          : item
      ))
      .concat(replacement));
    // Only now that nothing refers to it: delete the old copy, or leave a tombstone that stops
    // repair() from reading its binding as an interrupted upload.
    await uploads.abandon(entry.snapshotId);
    return { status: 'queued', messageId: replacement.messageId, uploadQueued: true };
  }

  // Full prior identity, exactly as §8.11 specifies. The digest is recomputed from the stored
  // payload the same way it was computed when the message was first built.
  async function identityOf(entry) {
    const body = { ...entry.payload, sourceRestoreEpoch: entry.sourceRestoreEpoch };
    delete body.payloadSha256;
    // A chunk's receipt digest is its immutable identity (snapshot/index/application/count/
    // length/hashes), not the payload body — the body carries the bytes, which the receipt
    // deliberately does not. Using the wrong one makes the desktop answer conflict or
    // not_found for chunks it is actually holding.
    const digest = entry.messageType === 'snapshot.chunk'
      ? await snapshotChunkIdentitySha256(body)
      : await payloadBodySha256(body);
    return {
      clientInstanceId: entry.clientInstanceId,
      messageId: entry.messageId,
      sourceRestoreEpoch: entry.sourceRestoreEpoch,
      payloadSha256: digest
    };
  }

  const patch = (messageId, change) => store.updateOutbox(list =>
    list.map(item => (item.messageId === messageId ? change(item) : item))
  );

  return { pauseStale, run, resolve };
}

// The answer that most needs a person, when the chunks of one snapshot disagree.
const URGENCY = ['conflict', 'purged', 'unverifiable', 'not_found', 'applied'];

function summarise(statuses) {
  for (const status of URGENCY) {
    if (status === 'applied') {
      if (statuses.every(item => item === 'applied')) return 'applied';
      continue;
    }
    if (statuses.includes(status)) return status;
  }
  return 'unverifiable';
}
