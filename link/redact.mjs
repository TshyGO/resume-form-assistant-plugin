// @ts-check
import { RULES } from './protocol/schema-lite.mjs';

// The credential parameter names and the reviewed allowlist both come from the vendored D05
// rules. Keeping a second copy here would let the plugin believe a URL is clean while the
// desktop refuses it — the failure mode is a queue that can never drain.
export const SECRET_QUERY_KEYS = new Set(RULES.urlSecretQueryKeys || []);
/** @type {Array<{ host?: string, pathPrefix: string, param?: string, valuePattern: string }>} */
export const URL_ALLOWLIST = RULES.urlAllowlist || [];

// Removed from dedupeUrl only. They are not credentials, so they stay in sourceUrl where
// the user can still see where the posting came from; they just must not split one posting
// into several candidates.
const TRACKING_PREFIXES = ['utm_'];
const TRACKING_NAMES = new Set(['gclid', 'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'ref_src']);

/**
 * Redact a page URL into the two forms D01 defines.
 *
 * Returns `{ sourceUrl, dedupeUrl }`, or null when there is nothing safe to keep. Redaction
 * happens here, before the intent is queued, so no copy of the original ever reaches
 * storage, a log or the wire.
 */
/** @param {unknown} raw */
export function redactUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  // D05 accepts https only. An http page gets no URL rather than a rewritten one: pretending
  // a plaintext address was https would be a claim about the page that is not true.
  if (url.protocol !== 'https:') return null;

  url.username = '';
  url.password = '';
  url.hash = '';

  /** @type {Array<[string, string]>} */
  const kept = [];
  for (const [name, value] of url.searchParams) {
    if (isSecretParam(url.hostname, url.pathname, name, value)) continue;
    kept.push([name, value]);
  }

  const sourceUrl = withParams(url, kept);
  const dedupeUrl = withParams(url, kept.filter(([name]) => !isTracking(name)));
  return { sourceUrl, dedupeUrl };
}

/**
 * @param {string} host
 * @param {string} path
 * @param {string} name
 * @param {string} value
 */
function isSecretParam(host, path, name, value) {
  const normalised = name.toLowerCase().replaceAll('-', '_');
  if (!SECRET_QUERY_KEYS.has(normalised)) return false;
  // `code` and `key` are stripped by default. Only a reviewed, versioned site rule can keep
  // one, and the rule may never cover an authentication path.
  return !isAllowlisted(host, path, normalised, value);
}

/**
 * @param {string} host
 * @param {string} path
 * @param {string} param
 * @param {string} value
 */
function isAllowlisted(host, path, param, value) {
  return URL_ALLOWLIST.some(rule =>
    rule.host?.toLowerCase() === host.toLowerCase() &&
    path.startsWith(rule.pathPrefix) &&
    rule.param?.toLowerCase() === param &&
    new RegExp(rule.valuePattern).test(value)
  );
}

/**
 * Strip credentials from a URL the user typed, keeping everything else.
 *
 * `redactUrl` above is for page addresses and refuses anything but https; an AI endpoint
 * is often `http://localhost:1234/v1`, and dropping it would break the config it is meant
 * to protect. This one keeps the scheme and only removes what authenticates: userinfo and
 * the D05 secret query parameters. `changed` lets the caller say so out loud.
 *
 * @param {unknown} raw
 * @returns {{ url: string, changed: boolean }}
 */
export function redactUrlCredentials(raw) {
  const text = typeof raw === 'string' ? raw : '';

  let url;
  try {
    url = new URL(text);
  } catch {
    // Not a URL, so it never authenticated anything either. Hand it back untouched.
    return { url: text, changed: false };
  }

  let changed = Boolean(url.username || url.password);
  url.username = '';
  url.password = '';

  /** @type {Array<[string, string]>} */
  const kept = [];
  for (const [name, value] of url.searchParams) {
    if (SECRET_QUERY_KEYS.has(name.toLowerCase().replaceAll('-', '_'))) {
      changed = true;
      continue;
    }
    kept.push([name, value]);
  }

  return { url: withParams(url, kept), changed };
}

/** @param {string} name */
function isTracking(name) {
  const lowered = name.toLowerCase();
  return TRACKING_NAMES.has(lowered) || TRACKING_PREFIXES.some(prefix => lowered.startsWith(prefix));
}

/**
 * @param {URL} url
 * @param {Array<[string, string]>} pairs
 */
function withParams(url, pairs) {
  const out = new URL(url.toString());
  out.search = '';
  for (const [name, value] of pairs) out.searchParams.append(name, value);
  return out.toString();
}
