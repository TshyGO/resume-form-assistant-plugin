import { MAX_STAGED_BYTES, MAX_STAGED_SNAPSHOTS, STAGING_EXPIRY_MS } from './limits.mjs';
import { sha256Hex } from './snapshot.mjs';

/**
 * Snapshot bytes waiting for the desktop, kept in extension-origin IndexedDB.
 *
 * D01 §8.5 puts every confirmed snapshot here before the first chunk is sent, whether or not
 * the desktop is reachable, and keeps it until the desktop acknowledges the complete snapshot.
 * Retries always send these original bytes; nothing is ever regenerated from the live template.
 *
 * The record also has to be enough to rebuild a lost outbox entry: IndexedDB and
 * chrome.storage.local share no transaction, so once the upload is bound, the chunk message
 * ids and the binding are written here first (see link/uploads.mjs).
 *
 * `kv` is the only way in: `{ get, put, delete, list }` over one object store. The service
 * worker passes an IndexedDB adapter (link/chrome.mjs); tests pass a Map.
 */
export function createStaging({ kv, now = () => new Date(), uuid }) {
  // Every write goes through here, one at a time. The worker is the only writer, but its
  // message handlers overlap: two tabs confirming at once would otherwise both pass the
  // capacity check on the same listing and both insert.
  let tail = Promise.resolve();
  function serial(operation) {
    const run = tail.then(operation, operation);
    tail = run.catch(() => {});
    return run;
  }

  /**
   * Store a built snapshot. Returns `{ status: 'staged', record }`, or `{ status: 'full',
   * reason }` when a product limit is reached, or `{ status: 'unavailable', reason }` when
   * IndexedDB fails. Never throws: this runs right after a fill, and a storage problem must
   * cost the user the snapshot, not the fill.
   */
  function stage(snapshot) {
    return serial(() => stageNow(snapshot));
  }

  async function stageNow(snapshot) {
    let written = null;
    try {
      const staged = await kv.list();
      if (staged.length >= MAX_STAGED_SNAPSHOTS) return { status: 'full', reason: 'count' };
      const used = staged.reduce((total, item) => total + (item.byteSize || 0), 0);
      if (used + snapshot.byteSize > MAX_STAGED_BYTES) return { status: 'full', reason: 'bytes' };

      const record = {
        snapshotId: uuid(),
        sha256: snapshot.sha256,
        byteSize: snapshot.byteSize,
        chunkCount: snapshot.chunks.length,
        bytes: snapshot.bytes.slice().buffer,
        chunks: snapshot.chunks.map(chunk => ({
          chunkIndex: chunk.chunkIndex,
          chunkSha256: chunk.chunkSha256,
          start: chunk.start,
          end: chunk.end,
          chunkMessageId: null
        })),
        templateName: snapshot.templateName,
        templateVersion: snapshot.templateVersion,
        createdAt: now().toISOString(),
        binding: null
      };

      await kv.put(record.snapshotId, record);
      written = record.snapshotId;

      // Read it back before calling it staged. "Staged" is a promise that the upload can
      // resume from these bytes after a restart; a copy that does not hash right cannot keep it.
      const stored = await kv.get(record.snapshotId);
      if (!stored?.bytes || (await sha256Hex(new Uint8Array(stored.bytes))) !== snapshot.sha256) {
        await kv.delete(record.snapshotId).catch(() => {});
        return { status: 'unavailable', reason: 'readback_mismatch' };
      }

      return { status: 'staged', record: stored };
    } catch (error) {
      // A record that was written but never confirmed must not hold quota or be listed later.
      if (written) await kv.delete(written).catch(() => {});
      return { status: 'unavailable', reason: error?.name || 'indexeddb_error' };
    }
  }

  async function get(snapshotId) {
    return (await kv.get(snapshotId)) ?? null;
  }

  /** The original bytes of one chunk, or null when the record or the chunk is gone. */
  async function readChunk(snapshotId, chunkIndex) {
    const record = await get(snapshotId);
    const chunk = record?.chunks.find(item => item.chunkIndex === chunkIndex);
    if (!record?.bytes || !chunk) return null;
    return new Uint8Array(record.bytes.slice(chunk.start, chunk.end));
  }

  /**
   * Store a whole record under its own id, verified by reading it back. Used to move staged
   * bytes to a new snapshot identity; no quota check, since it replaces a record already counted.
   */
  function put(record) {
    return serial(async () => {
      await kv.put(record.snapshotId, record);
      const stored = await kv.get(record.snapshotId);
      if (!stored?.bytes || (await sha256Hex(new Uint8Array(stored.bytes))) !== record.sha256) {
        await kv.delete(record.snapshotId).catch(() => {});
        throw new Error('readback_mismatch');
      }
      return stored;
    });
  }

  function update(snapshotId, change) {
    return serial(async () => {
      const record = await get(snapshotId);
      if (!record) return null;
      const next = change(record);
      await kv.put(snapshotId, next);
      return next;
    });
  }

  function remove(snapshotId) {
    return serial(() => kv.delete(snapshotId));
  }

  async function list() {
    return kv.list();
  }

  async function usage() {
    const staged = await kv.list();
    return { count: staged.length, bytes: staged.reduce((total, item) => total + (item.byteSize || 0), 0) };
  }

  // Expiry only raises the question with the user (§8.5). It never deletes by itself: an
  // expired snapshot the user was never asked about is still one they chose to keep.
  function isExpired(record) {
    return now().getTime() - Date.parse(record.createdAt) > STAGING_EXPIRY_MS;
  }

  return { stage, get, put, readChunk, update, remove, list, usage, isExpired };
}
