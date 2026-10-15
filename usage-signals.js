(() => {
  // Only browser-trusted input in our visible UI. Never read field values or page URLs.
  const signal = event => {
    if (!event.isTrusted || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    if (event.type === 'keydown' && event.repeat) return;
    if (event.target instanceof Element && event.target.closest('[data-feedback], [data-usage-settings], .feedback-choice')) return;
    chrome.runtime.sendMessage({ type: 'DESKTOP_USAGE_TOUCH' }).catch(() => {});
  };
  document.addEventListener('pointerdown', signal, { capture: true });
  document.addEventListener('keydown', signal, { capture: true });
})();
