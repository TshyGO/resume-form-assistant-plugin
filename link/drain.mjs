import { BACKOFF_STEPS_MS, MIN_ALARM_DELAY_MS } from './limits.mjs';

export const ALARM_NAME = 'resume-pro-desktop-drain';

/**
 * How long to wait before attempt number `attempts + 1`.
 *
 * Returns null once the ladder is exhausted: the entry then waits for a person. Retrying
 * forever would hide a problem only the user can fix, and would keep waking the worker to
 * do it.
 */
export function nextDelayMs(attempts) {
  return BACKOFF_STEPS_MS[attempts - 1] ?? null;
}

/**
 * A snapshot upload waits while the fill event it belongs to is still in the queue (D08
 * decision 7). Queue order alone does not hold: an event backing off is not due, the upload
 * behind it would be, and an event that failed may never go at all. Until the event is
 * accepted the upload is not work — neither for a pass nor for an alarm or a host start.
 */
export function waitsForFill(entry, queue) {
  return entry.messageType === 'snapshot.upload'
    && Boolean(entry.recordId)
    && queue.some(item => item.messageType === 'fill.submit' && item.recordId === entry.recordId);
}

/**
 * Drives the outbox on a schedule the service worker can survive.
 *
 * MV3 evicts the worker while entries are still queued, so the wake-up is a chrome alarm
 * rather than a timer. Chrome will not fire an alarm sooner than MIN_ALARM_DELAY_MS, so the
 * short rungs of the ladder only apply while the worker happens to still be alive; the alarm
 * catches everything else a little later. Later is fine. Never is not.
 */
export function createDrain({ session, outbox, reconcile = null, alarms, now }) {
  async function run() {
    // Nothing queued means nothing to do, and probing is not free: it spawns a native host,
    // and per D06 the host starts the desktop application on demand. Waking every thirty
    // seconds to do that for an empty queue would restart a desktop the user deliberately
    // closed, indefinitely. Entries that are only waiting for a person — stalled, failed,
    // already reconciled — are not work either.
    if (!(await hasWork())) {
      return { mode: 'idle', saved: [], pending: [], failed: [] };
    }

    const probe = await session.probe();
    if (probe.mode !== 'ready') {
      // Not an error: a closed desktop is the normal case for a queue that exists precisely
      // because the desktop was closed. Just make sure something wakes us again.
      await schedule(MIN_ALARM_DELAY_MS);
      return { mode: probe.mode, saved: [], pending: [], failed: [] };
    }

    // Pausing comes first, in the same pass. A stale entry that reaches drainOnce would be
    // sent under an epoch the user never chose.
    if (reconcile) await reconcile.pauseStale(probe.identity);
    const result = await outbox.drainOnce({ identity: probe.identity });
    const reconciled = reconcile ? await reconcile.run(probe.identity) : null;
    await scheduleNext();
    return { mode: probe.mode, ...result, reconciled };
  }

  // Work the queue can make progress on by itself: a pending entry to send, or a paused one
  // waiting to be reconciled against the archive that exists now.
  async function hasWork() {
    const queue = await outbox.list();
    return queue.some(entry => (entry.status === 'pending' && !waitsForFill(entry, queue)) || entry.status === 'paused');
  }

  async function retryNow(messageId) {
    const due = await outbox.markDue(messageId, now());
    if (due.status !== 'ok') return due;
    const probe = await session.probe();
    if (probe.mode !== 'ready') return { status: 'pending', mode: probe.mode };
    const result = await outbox.deliverOne(messageId, probe.identity);
    await scheduleNext();
    return result;
  }

  async function cancel(messageId) {
    await outbox.remove(messageId);
    await scheduleNext();
  }

  // The next alarm is set for the earliest entry that still has a rung left. A stalled entry
  // is deliberately not counted: nothing about waiting longer will change it.
  async function scheduleNext() {
    const queue = await outbox.list();
    const due = queue
      .filter(entry => entry.status === 'pending' && entry.nextAttemptAt && !waitsForFill(entry, queue))
      .map(entry => Date.parse(entry.nextAttemptAt))
      .filter(Number.isFinite);

    if (!due.length) return;
    await schedule(Math.min(...due) - now().getTime());
  }

  async function schedule(delayMs) {
    const delay = Math.max(delayMs, MIN_ALARM_DELAY_MS);
    await alarms.create(ALARM_NAME, { delayInMinutes: delay / 60_000 });
  }

  return { run, retryNow, cancel, scheduleNext, alarmName: ALARM_NAME };
}
