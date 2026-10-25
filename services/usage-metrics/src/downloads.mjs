import { createDownloadSnapshot, compareDownloadSnapshots, RELEASES_API_BASE, REPOSITORY } from '../../../desktop/scripts/usage-metrics/downloads.mjs';
import { readBytes } from './activity.mjs';

export class DownloadCollectionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const BASE = RELEASES_API_BASE;
// The 22 published releases already require 23 calls. Leave room for bridge
// and Stable releases while staying below the Workers Free 50-subrequest cap.
const MAX_GITHUB_REQUESTS = 40;

export async function fetchReleases(fetchImpl, token) {
  let calls = 0;
  async function pages(path) {
    const result = [];
    for (let page = 1; ; page++) {
      if (++calls > MAX_GITHUB_REQUESTS) throw new Error('GitHub request budget exceeded');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      let values;
      try {
        const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'resume-usage-metrics' };
        if (token) headers.Authorization = `Bearer ${token}`;
        // Workers supports follow/manual, not error. Non-2xx (including redirects)
        // is rejected below; credentials never follow a redirected destination.
        const response = await fetchImpl(`${BASE}${path}?per_page=100&page=${page}`, { headers, signal: controller.signal, redirect: 'manual' });
        if (!response.ok) {
          const limited = response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0';
          throw new DownloadCollectionError(limited ? 'github_rate_limited'
            : response.status === 401 ? 'github_auth_failed' : 'github_http_failed');
        }
        const bytes = await readBytes(response, 5 * 1024 * 1024);
        values = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!Array.isArray(values)) throw new Error('Invalid GitHub page');
      } catch (error) {
        if (error instanceof DownloadCollectionError) throw error;
        throw new DownloadCollectionError(controller.signal.aborted ? 'github_timeout'
          : error instanceof SyntaxError ? 'github_invalid_json'
          : error instanceof TypeError ? 'github_network_failed' : 'github_data_invalid');
      } finally { clearTimeout(timer); }
      result.push(...values);
      if (values.length < 100) return result;
    }
  }
  const releases = await pages('/releases');
  for (const release of releases) {
    if (release?.draft === true) continue;
    if (!Number.isSafeInteger(release?.id) || release.id < 1) throw new Error('Invalid release ID');
    release.assets = await pages(`/releases/${release.id}/assets`);
  }
  return releases;
}

export async function collectDownloads(db, fetchImpl, token, now) {
  const date = now().toISOString().slice(0, 10);
  if (await db.prepare('SELECT 1 FROM release_observation WHERE date_utc = ?').bind(date).first()) return;
  const releases = await fetchReleases(fetchImpl, token);
  const snapshot = createDownloadSnapshot(releases, now().toISOString());
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO release_observation(observed_at, date_utc, asset_count) VALUES (?, ?, ?)').bind(snapshot.observed_at, snapshot.date_utc, snapshot.assets.length),
    db.prepare(`INSERT INTO release_download_snapshot
      SELECT ?, json_extract(value, '$.asset_id'), json_extract(value, '$.release_id'), json_extract(value, '$.tag_name'),
        json_extract(value, '$.file_name'), json_extract(value, '$.published_at'), json_extract(value, '$.download_count'),
        json_extract(value, '$.release_family'), json_extract(value, '$.release_channel'), json_extract(value, '$.artifact_kind')
      FROM json_each(?) WHERE changes() = 1`).bind(snapshot.observed_at, JSON.stringify(snapshot.assets)),
    db.prepare("INSERT OR IGNORE INTO dataset_info VALUES ('downloads', ?)").bind(snapshot.observed_at),
  ]);
}

export async function downloadReport(db) {
  const observations = (await db.prepare('SELECT * FROM release_observation ORDER BY observed_at DESC LIMIT 2').all()).results;
  if (!observations.length) return null;
  async function restore(observation) {
    const assets = (await db.prepare('SELECT asset_id, release_id, tag_name, file_name, published_at, download_count, release_family, release_channel, artifact_kind FROM release_download_snapshot WHERE observed_at = ? ORDER BY asset_id').bind(observation.observed_at).all()).results;
    if (assets.length !== observation.asset_count) throw new Error('Incomplete stored snapshot');
    return { schema_version: 1, repository: REPOSITORY, observed_at: observation.observed_at, date_utc: observation.date_utc, assets };
  }
  return compareDownloadSnapshots(observations[1] ? await restore(observations[1]) : null, await restore(observations[0]));
}
