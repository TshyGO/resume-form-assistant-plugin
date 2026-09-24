// @ts-check
// The names the sidebar and the service worker use to talk to each other. Content scripts
// cannot open a native messaging port, so every desktop operation crosses this boundary.
export const MSG = {
  probe: 'DESKTOP_PROBE',
  resumeRead: 'DESKTOP_RESUME_READ',
  resumeUpdate: 'DESKTOP_RESUME_UPDATE',
  openView: 'DESKTOP_OPEN_VIEW',
  // #130 PR 5: moving 0.4.0 plugin data into the desktop.
  legacyStatus: 'DESKTOP_LEGACY_STATUS',
  legacyResend: 'DESKTOP_LEGACY_RESEND',
  legacyDiscard: 'DESKTOP_LEGACY_DISCARD',
  legacyDropKey: 'DESKTOP_LEGACY_DROP_KEY',
  legacyUnmigrated: 'DESKTOP_LEGACY_UNMIGRATED',
  aiComplete: 'DESKTOP_AI_COMPLETE',
  aiCancel: 'DESKTOP_AI_CANCEL',
  saveJob: 'DESKTOP_SAVE_JOB',
  continueSave: 'DESKTOP_CONTINUE_SAVE',
  candidates: 'DESKTOP_CANDIDATES',
  bind: 'DESKTOP_BIND',
  listQueue: 'DESKTOP_LIST_QUEUE',
  removeIntent: 'DESKTOP_REMOVE_INTENT',
  retry: 'DESKTOP_RETRY',
  cancel: 'DESKTOP_CANCEL',
  resolve: 'DESKTOP_RESOLVE',
  confirmSubmit: 'DESKTOP_CONFIRM_SUBMIT',
  candidatesFor: 'DESKTOP_CANDIDATES_FOR',
  // D08: archiving a finished fill.
  linkState: 'DESKTOP_LINK_STATE',
  recordFill: 'DESKTOP_RECORD_FILL',
  bindFill: 'DESKTOP_BIND_FILL',
  removeFill: 'DESKTOP_REMOVE_FILL',
  dropSnapshot: 'DESKTOP_DROP_SNAPSHOT'
};

export const DESKTOP_MESSAGE_TYPES = new Set(Object.values(MSG));
