const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DAY = 86_400_000;

export class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

export async function readBytes(response, maximum) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new HttpError(413, 'body_too_large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function activityPayload(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415, 'invalid_content_type');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 512)) throw new HttpError(413, 'body_too_large');
  const bytes = await readBytes(request, 512);
  let payload;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new HttpError(400, 'invalid_request'); }
  const fields = request.method === 'DELETE' ? ['schema_version', 'installation_id'] : ['schema_version', 'installation_id', 'platform', 'app_version', 'surface'];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).length !== fields.length ||
      fields.some(field => !Object.hasOwn(payload, field)) || payload.schema_version !== 1 ||
      typeof payload.installation_id !== 'string' || !UUID_V4.test(payload.installation_id)) throw new HttpError(400, 'invalid_request');
  if (request.method === 'POST') {
    const version = typeof payload.app_version === 'string' && payload.app_version.length <= 64 && VERSION.exec(payload.app_version);
    if (!version || version[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0') ||
        !['windows', 'macos'].includes(payload.platform) || !['desktop', 'extension'].includes(payload.surface)) throw new HttpError(400, 'invalid_request');
  }
  return { ...payload, installation_id: payload.installation_id.toLowerCase() };
}

export async function hmac(secret, value) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function recordActivity(db, hash, payload, now) {
  const at = now.toISOString();
  const date = at.slice(0, 10);
  const results = await db.batch([
    db.prepare('UPDATE metric_sequence SET value = value + 1 WHERE id = 1'),
    db.prepare(`INSERT INTO activity_day
      (date_utc, installation_hash, platform, app_version, desktop_seen, extension_seen, last_seen_at_utc, last_seen_seq)
      SELECT ?, ?, ?, ?, ?, ?, ?, (SELECT value FROM metric_sequence WHERE id = 1)
      WHERE NOT EXISTS (SELECT 1 FROM revoked_installations WHERE installation_hash = ? AND expires_at_utc > ?)
      ON CONFLICT(date_utc, installation_hash) DO UPDATE SET
        desktop_seen = MAX(activity_day.desktop_seen, excluded.desktop_seen),
        extension_seen = MAX(activity_day.extension_seen, excluded.extension_seen),
        platform = CASE WHEN excluded.last_seen_at_utc >= activity_day.last_seen_at_utc THEN excluded.platform ELSE activity_day.platform END,
        app_version = CASE WHEN excluded.last_seen_at_utc >= activity_day.last_seen_at_utc THEN excluded.app_version ELSE activity_day.app_version END,
        last_seen_seq = CASE WHEN excluded.last_seen_at_utc >= activity_day.last_seen_at_utc THEN excluded.last_seen_seq ELSE activity_day.last_seen_seq END,
        last_seen_at_utc = MAX(activity_day.last_seen_at_utc, excluded.last_seen_at_utc)`)
      .bind(date, hash, payload.platform, payload.app_version, Number(payload.surface === 'desktop'), Number(payload.surface === 'extension'), at, hash, at),
    db.prepare(`INSERT INTO dataset_info(name, started_at_utc)
      SELECT 'activity', ? WHERE EXISTS (SELECT 1 FROM activity_day WHERE date_utc = ? AND installation_hash = ?)
      ON CONFLICT(name) DO NOTHING`).bind(at, date, hash),
    db.prepare('SELECT 1 AS revoked FROM revoked_installations WHERE installation_hash = ? AND expires_at_utc > ?').bind(hash, at),
  ]);
  return results[3].results.length === 0;
}

export async function deleteActivity(db, hash, now) {
  const at = now.toISOString();
  const expires = new Date(now.getTime() + 45 * DAY).toISOString();
  await db.batch([
    db.prepare(`INSERT INTO revoked_installations(installation_hash, expires_at_utc) VALUES (?, ?)
      ON CONFLICT(installation_hash) DO UPDATE SET expires_at_utc =
        CASE WHEN revoked_installations.expires_at_utc <= ? THEN excluded.expires_at_utc ELSE revoked_installations.expires_at_utc END`).bind(hash, expires, at),
    db.prepare('DELETE FROM activity_day WHERE installation_hash = ?').bind(hash),
  ]);
}
