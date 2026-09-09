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
  resolve: 'DESKTOP_RESOLVE'
};

export const DESKTOP_MESSAGE_TYPES = new Set(Object.values(MSG));
