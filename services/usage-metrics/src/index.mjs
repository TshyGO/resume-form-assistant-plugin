import { HttpError, activityPayload, hmac, recordActivity, deleteActivity } from './activity.mjs';
import { cleanup, summarizeClosedDays } from './statistics.mjs';
import { collectDownloads } from './downloads.mjs';

function response(status, error) {
  return new Response(error ? JSON.stringify({ error }) : null, { status, headers: { 'Cache-Control': 'no-store', ...(status === 405 ? { Allow: 'POST, DELETE' } : {}), ...(error ? { 'Content-Type': 'application/json' } : {}) } });
}

export async function runMaintenance(env, { now = () => new Date(), fetchImpl = fetch } = {}) {
  let failed = false;
  for (const [task, operation] of [
    ['summary', () => summarizeClosedDays(env.DB, now())],
    ['cleanup', () => cleanup(env.DB, now())],
    ['downloads', () => collectDownloads(env.DB, fetchImpl, env.GITHUB_TOKEN, now)],
  ]) {
    let status = 'success';
    try { await operation(); } catch { status = 'failed'; failed = true; }
    const at = now().toISOString();
    await env.DB.prepare(`INSERT INTO maintenance_state(task, last_success_at, last_attempt_at, status) VALUES (?, ?, ?, ?)
      ON CONFLICT(task) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, status = excluded.status,
        last_success_at = CASE WHEN excluded.status = 'success' THEN excluded.last_success_at ELSE maintenance_state.last_success_at END`)
      .bind(task, status === 'success' ? at : null, at, status).run();
  }
  if (failed) throw new Error('maintenance_failed');
}

export function createWorker({ now = () => new Date(), fetchImpl = fetch } = {}) {
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        if (url.pathname === '/health' && request.method === 'GET') {
          if (!env.DB) return response(503, 'not_ready');
          await env.DB.prepare('SELECT 1 FROM maintenance_state LIMIT 1').first();
          return Response.json({ service: 'usage-metrics', schema_version: 1, activity_enabled: env.METRICS_ENABLED === 'true' }, { headers: { 'Cache-Control': 'no-store' } });
        }
        if (url.pathname !== '/v1/activity') return response(404, 'not_found');
        if (!['POST', 'DELETE'].includes(request.method)) return response(405, 'method_not_allowed');
        if (url.search) return response(400, 'invalid_request');
        if (request.method === 'POST' && env.METRICS_ENABLED !== 'true') return response(503, 'metrics_disabled');
        if (!env.DB || !env.ACTIVITY_LIMITER || typeof env.INSTALLATION_HMAC_KEY !== 'string' || new TextEncoder().encode(env.INSTALLATION_HMAC_KEY).byteLength < 32) return response(503, 'not_ready');
        // Ephemeral provider rate-limit key, domain-separated from stored installation hashes.
        const rateKey = await hmac(env.INSTALLATION_HMAC_KEY, `rate:${request.headers.get('cf-connecting-ip') ?? 'local-unknown'}`);
        if (!(await env.ACTIVITY_LIMITER.limit({ key: rateKey })).success) return response(429, 'rate_limited');
        const payload = await activityPayload(request);
        const hash = await hmac(env.INSTALLATION_HMAC_KEY, `installation:${payload.installation_id}`);
        if (request.method === 'DELETE') await deleteActivity(env.DB, hash, now());
        else if (!(await recordActivity(env.DB, hash, payload, now()))) return response(410, 'installation_revoked');
        return response(204);
      } catch (error) {
        return error instanceof HttpError ? response(error.status, error.message) : response(500, 'service_error');
      }
    },
    async scheduled(_controller, env) { await runMaintenance(env, { now, fetchImpl }); },
  };
}

export default createWorker();
