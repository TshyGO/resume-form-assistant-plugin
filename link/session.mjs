import { buildEnvelope, MAX_PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } from './envelope.mjs';
import { sendOnce } from './transport.mjs';

export const PLUGIN_VERSION = '0.4.0';

/**
 * The five states §5.2.3 and §9 distinguish, plus `ready`. They are not severities: each one
 * allows a different thing, and collapsing any two of them breaks a rule.
 *
 *   ready         handshake succeeded; queryCandidates and writes are allowed
 *   incompatible  desktop and plugin share no protocol version; intents are kept but never
 *                 promoted to bound messages
 *   not_installed no host registration for this browser
 *   not_paired    a host answered but this extension is not in the desktop's pairing list
 *   unavailable   this profile has paired before and the desktop is not reachable now;
 *                 this is the only failure that may persist a SaveIntent
 *   never_paired  no successful handshake was ever recorded; no long-lived queue is created
 */
export function createSession({ store, sendNative, sleep, uuid, now, send = sendOnce }) {
  async function probe() {
    const message = await buildEnvelope({
      messageType: 'handshake',
      messageId: uuid(),
      clientInstanceId: await store.clientInstanceId(),
      payload: {
        pluginVersion: PLUGIN_VERSION,
        minProtocolVersion: MIN_PROTOCOL_VERSION,
        maxProtocolVersion: MAX_PROTOCOL_VERSION
      },
      now
    });

    const result = await send(message, { sendNative, sleep });

    if (result.status === 'ok') {
      const payload = result.response.payload;
      if (!versionsIntersect(payload.minProtocolVersion, payload.maxProtocolVersion)) {
        // Deliberately not recorded as pairing: an incompatible desktop must not make the
        // queue believe writes are possible.
        return { mode: 'incompatible', identity: null };
      }
      const identity = { archiveId: payload.archiveId, restoreEpoch: payload.restoreEpoch };
      await store.setPairing({
        archiveId: payload.archiveId,
        restoreEpoch: payload.restoreEpoch,
        appVersion: payload.appVersion,
        at: now().toISOString()
      });
      return { mode: 'ready', identity, capabilities: payload.capabilities };
    }

    if (result.status === 'not_paired') return { mode: 'not_paired', identity: null };
    if (result.status === 'fatal' && result.code === 'protocol_incompatible') {
      return { mode: 'incompatible', identity: null };
    }

    // Whether the user may queue work depends on whether this profile ever reached a paired
    // desktop — not on the wording of this particular failure.
    //
    // A missing registration reads as "not installed" from the browser, but §5.2.3 lists
    // "the host failed to start" under *previously paired, desktop unavailable*, which keeps
    // the intent. Someone who paired last week and hits a broken registration today must not
    // be told to install what they already have, and must not have the fields they just
    // confirmed thrown away. Only a profile with no pairing history is told it is missing.
    const everPaired = await store.hasEverPaired();
    if (everPaired) {
      return { mode: 'unavailable', identity: null, code: result.code ?? result.status };
    }
    if (result.status === 'not_installed') return { mode: 'not_installed', identity: null };
    return { mode: 'never_paired', identity: null, code: result.code };
  }

  return { probe };
}

function versionsIntersect(min, max) {
  if (!Number.isInteger(min) || !Number.isInteger(max)) return false;
  return min <= MAX_PROTOCOL_VERSION && max >= MIN_PROTOCOL_VERSION;
}
