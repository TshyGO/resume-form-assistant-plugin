// @ts-check
// The names the sidebar and the service worker use to talk to each other. Content scripts
// cannot open a native messaging port, so every desktop operation crosses this boundary.
export const MSG = {
  probe: 'DESKTOP_PROBE',
  saveJob: 'DESKTOP_SAVE_JOB',
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
