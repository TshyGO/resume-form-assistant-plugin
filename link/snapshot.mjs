// @ts-check
import { MAX_SNAPSHOT_BYTES, canonicalJson, sha256Hex } from './protocol/validate.mjs';
import { RULES } from './protocol/schema-lite.mjs';
import { isSecretFieldName, isSecretFieldValue, stripSecretFields } from './secret-fields.mjs';

export { MAX_SNAPSHOT_BYTES, sha256Hex };
export { isSecretFieldName, isSecretFieldValue };

export const SNAPSHOT_FORMAT = 'resume-pro.snapshot';
export const SNAPSHOT_FORMAT_VERSION = 1;

// D05's suggested raw chunk size. 32 KiB becomes 43,692 Base64 characters, which leaves the
// complete envelope comfortably under the 64 KiB frame limit.
export const CHUNK_BYTES = RULES.suggestedRawChunkBytes;

const encoder = new TextEncoder();

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
/**
 * @param {{ name?: unknown, groups?: unknown } | null | undefined} template `normalizeTemplate` 的形状
 * @param {{ now?: () => Date }} [options]
 */
export async function buildSnapshot(template, { now = () => new Date() } = {}) {
  const { groups, omittedFieldCount } = stripSecretFields(template);
  if (!groups.length) return { error: 'empty' };

  const templateName = String(template?.name ?? '').trim() || '未命名模板';
  const templateVersion = await versionOf(groups);

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

/**
 * The version a snapshot of this template would carry, without building one. A fill record
 * reports it even when the user keeps the snapshot to themselves, so both must agree.
 */
/** @param {{ name?: unknown, groups?: unknown } | null | undefined} template */
export async function templateVersionOf(template) {
  const { groups } = stripSecretFields(template);
  return groups.length ? versionOf(groups) : null;
}

// The content short code D01 §8.5 asks for when the plugin has no revision counter. It covers
// the kept groups only, so two captures of an unchanged template share a version.
/** @param {Array<{ name: string, fields: Array<{ key: string, value: string }> }>} groups */
async function versionOf(groups) {
  return (await sha256Hex(encoder.encode(canonicalJson(groups)))).slice(0, 12);
}

/** Split snapshot bytes into protocol chunks, each with its own digest. */
/** @param {Uint8Array} bytes */
export async function planChunks(bytes) {
  const chunks = [];
  for (let start = 0, chunkIndex = 0; start < bytes.length; start += CHUNK_BYTES, chunkIndex += 1) {
    const end = Math.min(start + CHUNK_BYTES, bytes.length);
    chunks.push({ chunkIndex, start, end, chunkSha256: await sha256Hex(bytes.subarray(start, end)) });
  }
  return chunks;
}

/** Standard, padded Base64 — the only form D05's strict decoder accepts. */
/** @param {Uint8Array} bytes */
export function encodeBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
