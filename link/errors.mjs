// Every failure the desktop link can produce carries a D05 error code, so the UI copy and
// the retry policy read the same value. Codes the desktop never sent are still spelled the
// D05 way rather than invented locally.
export class LinkError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'LinkError';
    this.code = code;
  }
}

// `unavailable` is the only code D05 marks retryable by default. Everything else needs a
// deliberate decision, which is why the retry policy lives in one place instead of at each
// call site.
export const RETRYABLE_CODES = new Set(['unavailable']);
