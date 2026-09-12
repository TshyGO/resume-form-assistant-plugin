import { MAX_FILL_RECORDS } from './limits.mjs';
import { redactUrl } from './redact.mjs';

// Same rule as SaveIntent (§5.2.3): only a profile that has reached a paired desktop keeps
// anything. A profile that never did would be told its fill is "pending" forever.
const MAY_RECORD = new Set(['ready', 'unavailable', 'incompatible']);

const MAX_COUNT = 10000;
const MAX_DURATION_MS = 3600000;

/**
 * The `fill.submit` payload body for one finished fill, from what content.js measured.
 *
 * An allowlist, not a filter: only these keys can leave, whatever else the caller passes.
 * No field values, no AI matches, no prompt, no configuration — the same line
 * `formatFillDiagnostics` holds for the copyable diagnostics (§8.8).
 *
 * `filledCount` is the number of fields actually written into the page. What the AI
 * returned but was never written is not counted, and nothing here can say the site accepted
 * anything: the plugin cannot know that.
 */
export function buildFillPayload(raw) {
  const filledCount = count(raw?.filledCount);
  const payload = {
    outcome: outcomeOf(raw, filledCount),
    fieldCount: count(raw?.fieldCount),
    filledCount,
    unconfirmedCount: count(raw?.unconfirmedCount)
  };

  const durationsMs = {};
  const timing = raw?.timing ?? {};
  for (const [key, source] of [['scan', 'scanMs'], ['match', 'roundTripMs'], ['fill', 'fillMs'], ['total', 'totalMs']]) {
    const value = duration(timing[source]);
    if (value !== null) durationsMs[key] = value;
  }
  payload.durationsMs = durationsMs;

  // Redacted in the sidebar already; redacted again here, where the queue is written, so a
  // caller that forgot cannot put a token into storage or onto the wire.
  const url = redactUrl(String(raw?.urlRedacted ?? ''));
  if (url?.sourceUrl) payload.urlRedacted = url.sourceUrl.slice(0, 2000);

  payload.templateName = label(raw?.templateName, 200) || '未命名模板';
  const version = label(raw?.templateVersion, 64);
  if (version) payload.templateVersion = version;
  const pluginVersion = label(raw?.pluginVersion, 64);
  if (pluginVersion) payload.pluginVersion = pluginVersion;

  return payload;
}

/**
 * Cancelling only gives up on the AI wait; local matches already written stay written, so a
 * cancelled fill that wrote something is partial. So is a failure that got some fields in:
 * "failed" would tell the user nothing was touched when something was.
 */
function outcomeOf(raw, filledCount) {
  if (raw?.cancelled) return filledCount > 0 ? 'partial' : 'cancelled';
  if (raw?.outcome === 'success') return 'completed';
  if (raw?.outcome === 'partial') return 'partial';
  return filledCount > 0 ? 'partial' : 'failed';
}

function count(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.min(Math.max(number, 0), MAX_COUNT);
}

function duration(value) {
  if (value === null || value === undefined) return null;
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(Math.max(number, 0), MAX_DURATION_MS);
}

function label(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

const MAX_HINT_URL = 2000;

// The sidebar's clock at the end of the fill, if it is a real time not in the future.
function occurredAtOf(value, current) {
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= current.getTime() ? new Date(at).toISOString() : current.toISOString();
}

/**
 * Where to look for candidates when the record is bound later. Kept with the record, never
 * sent in `fill.submit`: it is the same posting information a SaveIntent already holds.
 */
function jobHint(job) {
  const url = redactUrl(String(job?.sourceUrl ?? ''))?.sourceUrl ?? '';
  return {
    company: label(job?.company, 200),
    title: label(job?.title, 200),
    // queryCandidates refuses a longer sourceUrl, and a cut URL would match nothing anyway.
    sourceUrl: url.length <= MAX_HINT_URL ? url : ''
  };
}

/**
 * Fills the user chose to archive (D08). Like a SaveIntent, a record is not a message: no
 * messageId, no epoch. It becomes a `fill.submit` only once the user has picked the
 * application, against a desktop that answered.
 */
export function createFillRecords({ store, uuid, now }) {
  async function create({ raw, mode }) {
    if (!MAY_RECORD.has(mode)) return { status: 'not_recorded', reason: mode };

    const record = {
      recordId: uuid(),
      clientInstanceId: await store.clientInstanceId(),
      fill: buildFillPayload(raw),
      job: jobHint(raw?.job),
      applicationId: null,
      createdAt: now().toISOString(),
      // When the fill ended, sent as the event's occurredAt however late the record is bound.
      occurredAt: occurredAtOf(raw?.endedAt, now()),
      status: 'pending_bind'
    };

    let outcome;
    await store.updateFillRecords(list => {
      if (list.length >= MAX_FILL_RECORDS) {
        outcome = { status: 'rejected', reason: 'queue_full' };
        return list;
      }
      outcome = { status: 'recorded', record };
      return [...list, record];
    });
    return outcome;
  }

  /**
   * Take a waiting record for one application. Decided and written in one queued step, so
   * two clicks cannot both see it waiting and both send it: the second is a duplicate.
   */
  async function claim(recordId, applicationId) {
    let outcome;
    await store.updateFillRecords(list => list.map(record => {
      if (record.recordId !== recordId) return record;
      if (record.status !== 'pending_bind') {
        outcome = { status: 'duplicate' };
        return record;
      }
      const claimed = { ...record, status: 'bound', applicationId };
      outcome = { status: 'claimed', record: claimed };
      return claimed;
    }));
    return outcome ?? { status: 'unknown' };
  }

  // The bound message was given up on. The record goes back to waiting, so the user can
  // choose another application or delete it.
  function unbind(recordId) {
    return store.updateFillRecords(list => list.map(record => (
      record.recordId === recordId ? { ...record, status: 'pending_bind', applicationId: null } : record
    )));
  }

  return {
    create,
    claim,
    unbind,
    list: () => store.getFillRecords(),
    remove: recordId => store.updateFillRecords(list => list.filter(record => record.recordId !== recordId)),
    removeWaiting
  };

  /**
   * Delete a record the user no longer wants — only while it is still waiting. A sidebar
   * drawn before the record was bound elsewhere must not delete it from under its queued
   * fill.submit, which would then be archived anyway.
   */
  async function removeWaiting(recordId) {
    let removed = false;
    await store.updateFillRecords(list => list.filter(record => {
      if (record.recordId !== recordId || record.status !== 'pending_bind') return true;
      removed = true;
      return false;
    }));
    return removed;
  };
}
