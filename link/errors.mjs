// @ts-check
// Every failure the desktop link can produce carries a D05 error code, so the UI copy and
// the retry policy read the same value. Codes the desktop never sent are still spelled the
// D05 way rather than invented locally.
export class LinkError extends Error {
  /**
   * @param {string} code D05 错误码
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message || code);
    this.name = 'LinkError';
    this.code = code;
  }
}
