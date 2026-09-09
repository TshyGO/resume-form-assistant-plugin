// The only place the desktop link touches `chrome` directly. Everything else takes these
// two adapters as dependencies, which is what lets the queue and the retry policy run under
// `node --test` instead of only inside a browser.

/**
 * Wrap chrome.runtime.sendNativeMessage so a closed port comes back as data.
 *
 * `chrome.runtime.lastError` is only readable inside the callback; reading it afterwards
 * yields undefined and the failure looks like an empty reply. Turning it into an exception
 * would push the retry decision into a catch block far from the classification table.
 */
export function nativeSender(api) {
  return (hostName, message) => new Promise(resolve => {
    api.runtime.sendNativeMessage(hostName, message, response => {
      const lastError = api.runtime.lastError;
      if (lastError) {
        resolve({ lastError: lastError.message ?? String(lastError) });
        return;
      }
      resolve({ response });
    });
  });
}

export function storageAdapter(api) {
  return {
    get: keys => api.storage.local.get(keys),
    set: values => api.storage.local.set(values)
  };
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
