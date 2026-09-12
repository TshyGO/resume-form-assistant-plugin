import { buildEnvelope } from './envelope.mjs';
import { sendOnce } from './transport.mjs';
import { buildSnapshot, encodeBase64, planChunks } from './snapshot.mjs';
import { nextDelayMs } from './drain.mjs';
import { BIND_INTERRUPTED_GRACE_MS, MAX_OUTBOX, ORPHAN_STAGING_GRACE_MS } from './limits.mjs';

// A plugin-local queue kind, never a wire message type: one entry per snapshot, carrying the
// identity of every chunk. Its `messageId` is the snapshotId (entries are keyed by messageId
// everywhere in the queue); the wire ids are the per-chunk `chunkMessageId`s.
export const SNAPSHOT_UPLOAD = 'snapshot.upload';

export function firstUnacked(chunks) {
  const index = chunks.findIndex(chunk => !chunk.acked);
  return index === -1 ? chunks.length : index;
}

/**
 * Record a chunk ACK. The cursor is the first chunk not yet acknowledged, counted from zero:
 * an ACK for a later chunk never moves it past a gap (§8.5). The desktop's cursor is the
 * durable truth — if it is behind chunks we believed acknowledged, those go back to unsent.
 */
export function applyChunkAck(entry, chunkIndex, desktopCursor) {
  const chunks = entry.chunks.map(chunk => {
    if (chunk.chunkIndex === chunkIndex) return { ...chunk, acked: true };
    if (Number.isInteger(desktopCursor) && chunk.chunkIndex >= desktopCursor && chunk.chunkIndex < chunkIndex) {
      return { ...chunk, acked: false };
    }
    return chunk;
  });
  return { ...entry, chunks, chunkCursor: firstUnacked(chunks) };
}

/**
 * Snapshot uploads (D08): staging on confirmation, binding to an application, sending chunks
 * in cursor order, and cleaning up only after the desktop's complete ACK.
 *
 * The rules that shape it (§8.5, walkthroughs 10.10 / 10.14 / 10.21):
 *  - The bytes sent are always the staged originals. Nothing is rebuilt from the live template.
 *  - Each chunk's id is minted once, written to IndexedDB before the queue entry exists, and
 *    reused on every retry and after every restart.
 *  - A chunk ACK advances the cursor; only a complete ACK deletes the staged copy, and that
 *    delete happens after the queue entry says "completed", so a crash in between finishes the
 *    cleanup instead of losing the copy early.
 */
export function createUploads({ store, staging, sendNative, sleep, uuid, now }) {
  const wire = { sendNative, sleep };

  /** Build and stage a snapshot of the template the fill used. */
  async function stage(template) {
    const built = await buildSnapshot(template, { now });
    if (built.error) return { issue: built.error };
    built.chunks = await planChunks(built.bytes);
    const staged = await staging.stage(built);
    if (staged.status === 'full') return { issue: 'staging_full' };
    if (staged.status !== 'staged') return { issue: 'staging_unavailable' };
    const { record } = staged;
    return {
      snapshot: {
        snapshotId: record.snapshotId,
        sha256: record.sha256,
        byteSize: record.byteSize,
        chunkCount: record.chunkCount,
        staging: 'idb'
      }
    };
  }

  /**
   * Bind a staged snapshot to the application the fill was bound to, and return the queue
   * entry to add. The chunk ids and the binding go into IndexedDB first: if the worker dies
   * before the entry is queued, repair() rebuilds it from there with the same ids.
   */
  async function prepare({ record, applicationId, identity }) {
    const snapshotId = record.snapshot?.snapshotId;
    if (!snapshotId) return { issue: 'no_snapshot' };
    let staged;
    try {
      staged = await staging.get(snapshotId);
    } catch {
      staged = null;
    }
    if (!staged) return { issue: 'bytes_lost' };

    const clientInstanceId = await store.clientInstanceId();
    const binding = {
      recordId: record.recordId,
      applicationId,
      archiveId: identity.archiveId,
      sourceRestoreEpoch: identity.restoreEpoch,
      clientInstanceId,
      templateName: staged.templateName,
      boundAt: now().toISOString()
    };
    // Ids already minted for this very binding are kept; any other binding gets new ones —
    // the application is part of each chunk's identity.
    const sameBinding = staged.binding
      && staged.binding.applicationId === applicationId
      && staged.binding.sourceRestoreEpoch === identity.restoreEpoch;
    const chunks = staged.chunks.map(chunk => ({
      chunkIndex: chunk.chunkIndex,
      chunkSha256: chunk.chunkSha256,
      chunkMessageId: sameBinding && chunk.chunkMessageId ? chunk.chunkMessageId : uuid()
    }));

    try {
      await staging.update(snapshotId, current => ({
        ...current,
        binding,
        chunks: current.chunks.map(chunk => ({ ...chunk, chunkMessageId: chunks[chunk.chunkIndex].chunkMessageId }))
      }));
    } catch {
      return { issue: 'staging_unavailable' };
    }

    return { entry: entryFor(staged, chunks, binding) };
  }

  function entryFor(staged, chunks, binding) {
    return {
      messageId: staged.snapshotId,
      messageType: SNAPSHOT_UPLOAD,
      snapshotId: staged.snapshotId,
      recordId: binding.recordId,
      intentId: null,
      clientInstanceId: binding.clientInstanceId,
      archiveId: binding.archiveId,
      sourceRestoreEpoch: binding.sourceRestoreEpoch,
      applicationId: binding.applicationId,
      sha256: staged.sha256,
      byteSize: staged.byteSize,
      chunkCount: staged.chunkCount,
      chunks: chunks.map(chunk => ({ ...chunk, acked: false })),
      chunkCursor: 0,
      // For the pending list only. Never sent: the wire payload is built per chunk.
      payload: { applicationId: binding.applicationId, templateName: binding.templateName },
      createdAt: staged.createdAt,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now().toISOString(),
      lastError: null
    };
  }

  /**
   * One pass over one snapshot: send chunks from the cursor until the desktop says the
   * snapshot is complete, a send fails, or every chunk is acknowledged without a complete
   * ACK (then the last chunk is resent once — the desktop answers a replay from its current
   * state — and otherwise the entry waits on the retry ladder).
   */
  async function deliver(entry, identity) {
    if (!identity) return { status: 'pending', messageId: entry.messageId };
    if (entry.status === 'completed') return finish(entry);

    let current = entry;
    for (let sends = 0; sends <= current.chunkCount; sends += 1) {
      const resending = current.chunkCursor >= current.chunkCount;
      const index = resending ? current.chunkCount - 1 : current.chunkCursor;
      let bytes = null;
      try {
        bytes = await staging.readChunk(current.snapshotId, index);
      } catch {
        bytes = null;
      }
      if (!bytes) {
        // Never regenerated from the template: the user is told the copy is gone (10.10).
        await patch(current.messageId, item => ({ ...item, status: 'bytes_lost', nextAttemptAt: null, lastError: 'bytes_lost' }));
        return { status: 'failed', messageId: current.messageId, code: 'bytes_lost' };
      }

      const chunk = current.chunks[index];
      const message = await buildEnvelope({
        messageType: 'snapshot.chunk',
        messageId: chunk.chunkMessageId,
        clientInstanceId: current.clientInstanceId,
        payload: {
          snapshotId: current.snapshotId,
          applicationId: current.applicationId,
          chunkIndex: index,
          chunkCount: current.chunkCount,
          chunkSha256: chunk.chunkSha256,
          snapshotSha256: current.sha256,
          byteSize: current.byteSize,
          bytesBase64: encodeBase64(bytes)
        },
        identity,
        sourceRestoreEpoch: current.sourceRestoreEpoch,
        now
      });

      const result = await sendOnce(message, wire);
      if (result.status === 'ok') {
        const ack = result.response.payload;
        if (ack.ackKind === 'snapshot') return finish(current);
        if (resending) return backoff(current, 'unavailable');
        current = applyChunkAck(current, index, ack.chunkCursor);
        const progressed = current;
        await patch(current.messageId, item => ({
          ...item,
          chunks: progressed.chunks,
          chunkCursor: progressed.chunkCursor,
          attempts: 0,
          lastError: null
        }));
        continue;
      }

      if (result.status === 'fatal') {
        await patch(current.messageId, item => ({
          ...item,
          status: 'failed',
          attempts: item.attempts + 1,
          nextAttemptAt: null,
          lastError: result.code
        }));
        return { status: 'failed', messageId: current.messageId, code: result.code };
      }

      return backoff(current, result.code ?? result.status);
    }
    return backoff(current, 'unavailable');
  }

  // The desktop holds the whole snapshot. Say so first, then delete the copy, then drop the
  // entry: each step can be repeated after a crash without undoing the one before it.
  async function finish(entry) {
    await patch(entry.messageId, item => ({ ...item, status: 'completed', nextAttemptAt: null }));
    try {
      await staging.remove(entry.snapshotId);
    } catch {
      // Left for repair(): the entry still says completed.
      return { status: 'saved', messageId: entry.messageId, applicationId: entry.applicationId };
    }
    await store.updateOutbox(list => list.filter(item => item.messageId !== entry.messageId));
    return { status: 'saved', messageId: entry.messageId, applicationId: entry.applicationId };
  }

  async function backoff(entry, code) {
    const attempts = (entry.attempts ?? 0) + 1;
    const delay = nextDelayMs(attempts);
    await patch(entry.messageId, item => ({
      ...item,
      attempts,
      status: delay === null ? 'stalled' : 'pending',
      nextAttemptAt: delay === null ? null : new Date(now().getTime() + delay).toISOString(),
      lastError: code
    }));
    return { status: delay === null ? 'stalled' : 'pending', messageId: entry.messageId, code };
  }

  /**
   * Delete a staged copy. Safe to call for one already gone. Returns false when IndexedDB
   * refused; callers that must not let the copy come back use abandon() instead.
   */
  async function discard(snapshotId) {
    try {
      await staging.remove(snapshotId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The user gave up on a snapshot. Delete the copy, then its queue entry. If the copy cannot
   * be deleted, the entry stays as a tombstone ('discarding') until it can: otherwise the
   * binding still in IndexedDB would read to repair() as an interrupted upload, and the
   * snapshot would be sent after all.
   */
  async function abandon(snapshotId) {
    if (await discard(snapshotId)) {
      await store.updateOutbox(list => list.filter(item => item.messageId !== snapshotId));
      return { status: 'discarded' };
    }
    await store.updateOutbox(list => {
      const tombstone = { status: 'discarding', nextAttemptAt: null, lastError: 'discard_failed' };
      if (list.some(item => item.messageId === snapshotId)) {
        return list.map(item => (item.messageId === snapshotId ? { ...item, ...tombstone } : item));
      }
      return [...list, {
        messageId: snapshotId, messageType: SNAPSHOT_UPLOAD, snapshotId, recordId: null,
        chunks: [], chunkCount: 0, payload: {}, attempts: 0, ...tombstone
      }];
    });
    return { status: 'discarding' };
  }

  /**
   * Undo prepare() for a bind that never got queued: the staged copy stays, unbound, for the
   * user to bind again, and repair() has no binding to mistake for an interrupted upload.
   */
  async function release(snapshotId) {
    try {
      await staging.update(snapshotId, current => ({
        ...current,
        binding: null,
        chunks: current.chunks.map(chunk => ({ ...chunk, chunkMessageId: null }))
      }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bring the queue and IndexedDB back into agreement after a restart (§8.5: the two stores
   * share no transaction, so IndexedDB carries enough to rebuild the queue entry).
   */
  async function repair() {
    let staged;
    try {
      staged = await staging.list();
    } catch {
      return;
    }
    const outbox = await store.getOutbox();
    const records = await store.getFillRecords();

    for (const entry of outbox.filter(item => item.messageType === SNAPSHOT_UPLOAD)) {
      if (entry.status === 'discarding') {
        if (await discard(entry.snapshotId)) {
          await store.updateOutbox(list => list.filter(item => item.messageId !== entry.messageId));
        }
        continue;
      }
      if (entry.status === 'completed') {
        // The entry goes only with the copy: a staged record left behind with its binding
        // would be rebuilt below and send chunks the desktop already has in full.
        if (await discard(entry.snapshotId)) {
          await store.updateOutbox(list => list.filter(item => item.messageId !== entry.messageId));
        }
        continue;
      }
      if (entry.status !== 'bytes_lost' && !staged.some(record => record.snapshotId === entry.snapshotId)) {
        await patch(entry.messageId, item => ({ ...item, status: 'bytes_lost', nextAttemptAt: null, lastError: 'bytes_lost' }));
      }
    }

    const queued = new Set(outbox.map(item => item.messageId));
    for (const record of staged) {
      if (record.binding) {
        // A binding whose record is back to waiting is left over from a bind that was never
        // queued (or given up on): the user has not chosen an application for it any more.
        const owner = records.find(item => item.recordId === record.binding.recordId);
        if (owner?.status === 'pending_bind' && !queued.has(record.snapshotId)) {
          await release(record.snapshotId);
          continue;
        }
        // Bound, but its fill.submit never reached the queue: the worker stopped between the
        // two writes. An upload alone would archive the snapshot and lose the fill, so the
        // record goes back to waiting for the user to bind it again.
        const eventQueued = outbox.some(item => item.messageType === 'fill.submit' && item.recordId === record.binding.recordId);
        if (owner?.status === 'bound' && !eventQueued && !queued.has(record.snapshotId)) {
          const age = now().getTime() - Date.parse(record.binding.boundAt ?? record.createdAt);
          if (age > BIND_INTERRUPTED_GRACE_MS) {
            await release(record.snapshotId);
            await store.updateFillRecords(list => list.map(item => (
              item.recordId === owner.recordId ? { ...item, status: 'pending_bind', applicationId: null } : item
            )));
          }
          continue;
        }
        if (!queued.has(record.snapshotId) && outbox.length >= MAX_OUTBOX) continue;
        if (!queued.has(record.snapshotId) && record.chunks.every(chunk => chunk.chunkMessageId)) {
          const entry = entryFor(record, record.chunks, record.binding);
          await store.updateOutbox(list => (list.some(item => item.messageId === entry.messageId) ? list : [...list, entry]));
        }
        continue;
      }
      // Staged, then nothing ever referred to it: the worker died between staging and writing
      // the record. Left alone for a while, since a record may still be on its way.
      const referenced = records.some(item => item.snapshot?.snapshotId === record.snapshotId);
      const age = now().getTime() - Date.parse(record.createdAt);
      if (!referenced && age > ORPHAN_STAGING_GRACE_MS) await discard(record.snapshotId);
    }
  }

  /** Snapshots old enough that the user should be asked about them (§8.5, 30 days). */
  async function expired() {
    try {
      return (await staging.list()).filter(record => staging.isExpired(record)).map(record => record.snapshotId);
    } catch {
      return [];
    }
  }

  const patch = (messageId, change) => store.updateOutbox(list =>
    list.map(item => (item.messageId === messageId ? change(item) : item))
  );

  return { stage, prepare, deliver, discard, abandon, release, repair, expired };
}
