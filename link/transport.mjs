import { validateResponseForRequest } from './protocol/validate.mjs';
import { WRITE_TYPES } from './envelope.mjs';

export const HOST_NAME = 'com.resumepro.desktop';

// D06 measured cold starts that exceed the host's ten second budget and answer with a
// retryable `unavailable`. One immediate retry covers that without turning the transport
// into a second retry engine; the queue owns the long backoff.
export const COLD_START_RETRY_DELAY_MS = 1000;

// Chrome's wording for a missing registration has been stable, but it is still English
// prose from another process. It is used only to *upgrade* a failure to the confident
// "not installed" reading; anything unrecognised stays retryable.
const HOST_MISSING_MARKERS = ['host not found', 'host has not been found'];

/**
 * Send one envelope and classify what came back.
 *
 * Returns one of:
 *   { status: 'ok', response, resultId }
 *   { status: 'not_installed' }         no host registration for this browser
 *   { status: 'not_paired' }            registered, but this extension is not paired
 *   { status: 'retryable', code }       cold start, broken pipe, unreadable reply
 *   { status: 'fatal', code, message }  a protocol decision the queue must act on
 *
 * It never throws for an expected failure: a queue that has to catch to decide whether to
 * retry ends up with the policy in two places.
 */
export async function sendOnce(message, { sendNative, sleep, hostName = HOST_NAME }) {
  let result = await attempt(message, sendNative, hostName);
  if (result.status === 'retryable') {
    await sleep(COLD_START_RETRY_DELAY_MS);
    result = await attempt(message, sendNative, hostName);
  }
  return result;
}

async function attempt(message, sendNative, hostName) {
  let reply;
  try {
    reply = await sendNative(hostName, message);
  } catch (error) {
    return classifyPortFailure(error?.message);
  }

  if (reply?.lastError) {
    return classifyPortFailure(reply.lastError);
  }

  const response = reply?.response ?? reply;
  try {
    validateResponseForRequest(response, message);
  } catch (error) {
    // `invalid_payload` means the reply proves nothing about the write — not success, and
    // not a reason to give up. Any other code is a verdict the validator reached on its own
    // (an incompatible protocol range, a secret in the response); retrying cannot change it.
    if (error?.code && error.code !== 'invalid_payload') {
      return { status: 'fatal', code: error.code, message: error.message };
    }
    return { status: 'retryable', code: 'invalid_payload', message: error?.message };
  }

  if (response.ok !== true) {
    const code = response.error?.code ?? 'unavailable';
    if (code === 'identity_not_allowed') {
      return { status: 'not_paired', code };
    }
    if (code === 'unavailable') {
      return { status: 'retryable', code };
    }
    return { status: 'fatal', code, message: response.error?.message };
  }

  if (WRITE_TYPES.has(message.messageType) && typeof response.resultId !== 'string') {
    // D05 requires a resultId on a successful write. Without one there is nothing to prove
    // the archive kept it, so it cannot be reported as saved.
    return { status: 'retryable', code: 'invalid_payload' };
  }

  return { status: 'ok', response, resultId: response.resultId ?? null };
}

function classifyPortFailure(text) {
  const lowered = String(text ?? '').toLowerCase();
  if (HOST_MISSING_MARKERS.some(marker => lowered.includes(marker))) {
    return { status: 'not_installed' };
  }
  return { status: 'retryable', code: 'unavailable', message: text };
}
