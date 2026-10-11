// Public Release metadata only. No activity collection or Cloudflare credentials.
export const REPOSITORY = 'TshyGO/resume-form-assistant-plugin';
const DAY_MS = 86_400_000;
const PLUGIN_ZIP = /^(?:wangshen-kuaitian|resume-pro)-(?:plugin-|v)\d+\.\d+\.\d+(?:[-.][a-z0-9-]+)*\.zip$/i;

function timestamp(value) {
  const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value)) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 ||
      new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) {
    throw new Error('Expected an ISO timestamp with an explicit timezone');
  }
  return new Date(value).toISOString();
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function classification(tag, name, prerelease) {
  const releaseFamily = tag.startsWith('desktop-v') ? 'desktop' : /^v\d+\./.test(tag) ? 'extension' : 'other';
  const lower = name.toLowerCase();
  let kind = 'other';
  if (lower.endsWith('.exe')) kind = 'windows-exe';
  else if (lower.endsWith('.dmg')) kind = 'macos-dmg';
  else if (PLUGIN_ZIP.test(name)) kind = 'plugin-zip';
  return {
    release_family: releaseFamily,
    release_channel: prerelease || /\d+\.\d+\.\d+-/.test(tag) ? 'prerelease' : 'stable',
    artifact_kind: kind,
  };
}

export function createDownloadSnapshot(releases, observedAt) {
  if (!Array.isArray(releases)) throw new Error('Expected the complete releases array');
  const observed = timestamp(observedAt);
  const assets = [];
  const ids = new Set();
  const releaseIds = new Set();
  for (const release of releases) {
    if (!release || typeof release.draft !== 'boolean') throw new Error('Invalid release');
    if (release.draft) continue;
    if (!positiveId(release.id) || typeof release.tag_name !== 'string' || !release.tag_name ||
        typeof release.prerelease !== 'boolean' || !Array.isArray(release.assets)) throw new Error('Invalid published release');
    if (releaseIds.has(release.id)) throw new Error('Duplicate release ID; collect a fresh complete snapshot');
    releaseIds.add(release.id);
    const publishedAt = timestamp(release.published_at);
    for (const asset of release.assets) {
      if (!asset || typeof asset.name !== 'string' || !asset.name || typeof asset.state !== 'string') throw new Error('Invalid asset');
      if (!['uploaded', 'starter'].includes(asset.state)) throw new Error('Invalid asset state');
      if (asset.name.toLowerCase().endsWith('.sha256') || asset.state === 'starter') continue;
      if (!positiveId(asset.id) || !Number.isSafeInteger(asset.download_count) || asset.download_count < 0) throw new Error('Invalid asset counter');
      if (ids.has(asset.id)) throw new Error('Duplicate asset ID; collect a fresh complete snapshot');
      ids.add(asset.id);
      assets.push({
        asset_id: asset.id,
        release_id: release.id,
        tag_name: release.tag_name,
        file_name: asset.name,
        published_at: publishedAt,
        download_count: asset.download_count,
        ...classification(release.tag_name, asset.name, release.prerelease),
      });
    }
  }
  assets.sort((a, b) => a.asset_id - b.asset_id);
  return { schema_version: 1, repository: REPOSITORY, observed_at: observed, date_utc: observed.slice(0, 10), assets };
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schema_version !== 1 || snapshot.repository !== REPOSITORY || !Array.isArray(snapshot.assets)) throw new Error('Invalid download snapshot');
  const observed = timestamp(snapshot.observed_at);
  if (snapshot.date_utc !== observed.slice(0, 10)) throw new Error('Snapshot UTC date does not match timestamp');
  const ids = new Set();
  for (const asset of snapshot.assets) {
    if (!asset || !positiveId(asset.asset_id) || !positiveId(asset.release_id) ||
        typeof asset.tag_name !== 'string' || !asset.tag_name || typeof asset.file_name !== 'string' || !asset.file_name ||
        !Number.isSafeInteger(asset.download_count) || asset.download_count < 0 || ids.has(asset.asset_id)) throw new Error('Invalid snapshot asset');
    timestamp(asset.published_at);
    if (!['desktop', 'extension', 'other'].includes(asset.release_family) ||
        !['stable', 'prerelease'].includes(asset.release_channel) ||
        !['windows-exe', 'macos-dmg', 'plugin-zip', 'other'].includes(asset.artifact_kind)) throw new Error('Invalid snapshot classification');
    const expected = classification(asset.tag_name, asset.file_name, asset.release_channel === 'prerelease');
    if (Object.keys(expected).some(key => expected[key] !== asset[key])) throw new Error('Snapshot classification does not match asset metadata');
    ids.add(asset.asset_id);
  }
}

// Deltas cover the actual observation interval, never reconstructed history.
export function compareDownloadSnapshots(previous, current) {
  validateSnapshot(current);
  if (previous !== null) {
    validateSnapshot(previous);
    if (Date.parse(current.observed_at) <= Date.parse(previous.observed_at)) throw new Error('Current snapshot must be newer');
  }
  const oldAssets = new Map((previous?.assets ?? []).map(asset => [asset.asset_id, asset]));
  const elapsedDays = previous === null ? null : Math.round((Date.parse(`${current.date_utc}T00:00:00Z`) - Date.parse(`${previous.date_utc}T00:00:00Z`)) / DAY_MS);
  const rows = current.assets.map(asset => {
    const old = oldAssets.get(asset.asset_id);
    oldAssets.delete(asset.asset_id);
    let status;
    let increment = null;
    if (previous === null) status = 'baseline';
    else if (!old) status = 'new_asset';
    else if (['release_id', 'tag_name', 'file_name', 'release_family', 'release_channel', 'artifact_kind'].some(key => old[key] !== asset[key])) status = 'metadata_changed';
    else if (asset.download_count < old.download_count) status = 'count_decreased';
    else {
      increment = asset.download_count - old.download_count;
      status = elapsedDays === 1 ? 'adjacent_day' : elapsedDays === 0 ? 'same_day' : 'gap';
    }
    return { ...asset, status, increment };
  });
  for (const asset of oldAssets.values()) rows.push({ ...asset, download_count: null, status: 'missing_asset', increment: null });
  rows.sort((a, b) => a.asset_id - b.asset_id);
  return {
    schema_version: 1, repository: REPOSITORY,
    from_observed_at: previous?.observed_at ?? null,
    to_observed_at: current.observed_at,
    elapsed_utc_days: elapsedDays, rows,
  };
}
