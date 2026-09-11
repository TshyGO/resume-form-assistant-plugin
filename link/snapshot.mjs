import { MAX_SNAPSHOT_BYTES, canonicalJson, sha256Hex } from './protocol/validate.mjs';
import { RULES } from './protocol/schema-lite.mjs';

export { MAX_SNAPSHOT_BYTES, sha256Hex };

export const SNAPSHOT_FORMAT = 'resume-pro.snapshot';
export const SNAPSHOT_FORMAT_VERSION = 1;

// D05's suggested raw chunk size. 32 KiB becomes 43,692 Base64 characters, which leaves the
// complete envelope comfortably under the 64 KiB frame limit.
export const CHUNK_BYTES = RULES.suggestedRawChunkBytes;

const encoder = new TextEncoder();

// data-privacy §4.1 lists what may never reach a snapshot, and says the desktop copy has to
// strip once more even though the fill path already skips password inputs: a template is a
// spreadsheet the user typed, and nothing stops a row called "登录密码". Chinese labels are
// matched anywhere in the name; the English words only as whole words, so "Photo" and
// "Hotpot" are not mistaken for "otp". camelCase names are split first, so "apiKey" and
// "accessToken" are words too. When in doubt the field is dropped, never kept "to see".
const SECRET_CJK = /(密码|口令|验证码|校验码|授权码|密钥|私钥|令牌)/u;
const SECRET_LATIN = /(?:^|[^a-z])(password|passwd|pwd|otp|api[\s_-]?key|token|cookie|secret)(?:[^a-z]|$)/iu;

export function isSecretFieldName(name) {
  const text = String(name ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return SECRET_CJK.test(text) || SECRET_LATIN.test(text);
}

// The name is not the only way in: an imported template can carry a credential under "备注".
// These match a credential's shape — a labelled secret ("password: …"), a bearer header, a
// secret-bearing URL parameter, or a well-known key format — not the words alone, so a
// summary that says "熟悉 API Key 管理" stays.
const SECRET_VALUES = [
  /(?:^|[^a-z])(password|passwd|pwd|passcode|otp|api[\s_-]?key|(?:access|refresh|auth)?[\s_-]?token|secret|cookie|authorization)\s*[:=：]\s*\S/iu,
  /(密码|口令|验证码|校验码|授权码|密钥|令牌)\s*[:=：]\s*\S/u,
  /\bbearer\s+[a-z0-9._~+/=-]{16,}/iu,
  /[?&#](?:access_token|refresh_token|id_token|token|api_?key|key|secret|password|sig|signature|auth|code|ticket)=[^&#\s]+/iu,
  /\b(?:sk|pk|rk)-[a-z0-9_-]{16,}/iu,
  /\bgh[pousr]_[a-z0-9]{20,}/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}/iu
];

export function isSecretFieldValue(value) {
  const text = String(value ?? '');
  return SECRET_VALUES.some(pattern => pattern.test(text));
}

/**
 * Freeze a template into snapshot v1 bytes.
 *
 * The input is the template object the fill actually used (normalizeTemplate's shape). The
 * output is canonical JSON — sorted keys, compact, UTF-8 — so one template captured at one
 * instant always yields one byte sequence and one digest (`capturedAt` is part of the bytes;
 * only `templateVersion` is stable across captures). Returns `{ error }` instead of bytes when there is nothing
 * worth keeping or the result would exceed the 2 MiB product limit; the caller then records
 * the fill without a snapshot rather than failing the fill.
 */
export async function buildSnapshot(template, { now = () => new Date() } = {}) {
  let omittedFieldCount = 0;
  const groups = [];

  for (const group of Array.isArray(template?.groups) ? template.groups : []) {
    const fields = [];
    for (const field of Array.isArray(group?.fields) ? group.fields : []) {
      const key = String(field?.key ?? '').trim();
      if (!key) continue;
      const value = String(field?.value ?? '');
      if (isSecretFieldName(key) || isSecretFieldValue(value)) {
        omittedFieldCount += 1;
        continue;
      }
      fields.push({ key, value });
    }
    if (fields.length) groups.push({ name: String(group?.name ?? '').trim() || '未分类', fields });
  }

  if (!groups.length) return { error: 'empty' };

  const templateName = String(template?.name ?? '').trim() || '未命名模板';
  // The content short code D01 §8.5 asks for when the plugin has no revision counter. It
  // covers the groups only, so two captures of an unchanged template share a version.
  const templateVersion = (await sha256Hex(encoder.encode(canonicalJson(groups)))).slice(0, 12);

  const bytes = encoder.encode(canonicalJson({
    format: SNAPSHOT_FORMAT,
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    templateName,
    templateVersion,
    capturedAt: now().toISOString(),
    groups,
    omittedFieldCount
  }));

  if (bytes.length > MAX_SNAPSHOT_BYTES) return { error: 'too_large', byteSize: bytes.length };

  return {
    bytes,
    sha256: await sha256Hex(bytes),
    byteSize: bytes.length,
    templateName,
    templateVersion,
    omittedFieldCount
  };
}

/** Split snapshot bytes into protocol chunks, each with its own digest. */
export async function planChunks(bytes) {
  const chunks = [];
  for (let start = 0, chunkIndex = 0; start < bytes.length; start += CHUNK_BYTES, chunkIndex += 1) {
    const end = Math.min(start + CHUNK_BYTES, bytes.length);
    chunks.push({ chunkIndex, start, end, chunkSha256: await sha256Hex(bytes.subarray(start, end)) });
  }
  return chunks;
}

/** Standard, padded Base64 — the only form D05's strict decoder accepts. */
export function encodeBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
