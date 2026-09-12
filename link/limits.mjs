// Product limits, in one place so the UI copy and the queue agree on the numbers.

// D01 §5.2.4 suggests 100 of each and requires the number to be stated rather than implied.
// A full queue refuses new work and says so; it never drops the oldest entry, because the
// user was already told that entry is pending.
export const MAX_INTENTS = 100;
export const MAX_OUTBOX = 100;

// Fills the user chose to archive but has not bound to an application yet (D08). Same rule:
// full means refuse and say so, never drop the oldest.
export const MAX_FILL_RECORDS = 100;

// A same-posting save inside this window is a double click rather than a decision, so the
// wording says "just saved" instead of "already pending". Either way it is refused as a
// duplicate: a pending intent for the same posting always requires an explicit "save again",
// no matter how old it is. Letting the guard expire would hand the user two applications for
// one posting through nothing but delay.
export const DEDUPE_WINDOW_MS = 10_000;

// Retry backoff for bound messages. Capped: after the last step the entry waits for the user
// rather than retrying forever.
export const BACKOFF_STEPS_MS = [1_000, 5_000, 30_000, 120_000, 600_000, 1_800_000];

// chrome.alarms will not fire faster than this, so anything shorter runs in the worker while
// it is still alive and falls back to an alarm once it is not.
export const MIN_ALARM_DELAY_MS = 30_000;

// D01 §8.5: snapshots waiting in extension IndexedDB, whichever limit is reached first. A full
// staging area refuses the new snapshot; it never evicts one the user was told is pending.
export const MAX_STAGED_SNAPSHOTS = 20;
export const MAX_STAGED_BYTES = 20 * 1024 * 1024;

// An unfinished snapshot older than this is brought to the user. It is never deleted for age.
export const STAGING_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

// A staged snapshot no record refers to was left by a worker that died between staging and
// writing the record. Only cleaned up after this long, so one still on its way is not touched.
export const ORPHAN_STAGING_GRACE_MS = 60 * 60 * 1000;

// A snapshot binding whose fill.submit never reached the queue is treated as an interrupted
// bind once it is this old. The two writes are milliseconds apart; this only has to be longer
// than any bind still in progress when a worker starts.
export const BIND_INTERRUPTED_GRACE_MS = 2 * 60 * 1000;
