CREATE TABLE activity_day (
  date_utc TEXT NOT NULL,
  installation_hash TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos')),
  app_version TEXT NOT NULL,
  desktop_seen INTEGER NOT NULL DEFAULT 0 CHECK (desktop_seen IN (0, 1)),
  extension_seen INTEGER NOT NULL DEFAULT 0 CHECK (extension_seen IN (0, 1)),
  last_seen_at_utc TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL,
  PRIMARY KEY (date_utc, installation_hash)
);
CREATE INDEX idx_activity_day_installation ON activity_day(installation_hash);

CREATE TABLE metric_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
INSERT INTO metric_sequence VALUES (1, 0);
CREATE TABLE dataset_info (name TEXT PRIMARY KEY, started_at_utc TEXT NOT NULL);

CREATE TABLE revoked_installations (
  installation_hash TEXT PRIMARY KEY,
  expires_at_utc TEXT NOT NULL
);

CREATE TABLE metrics_daily (
  date_utc TEXT PRIMARY KEY,
  dau INTEGER NOT NULL,
  wau INTEGER NOT NULL,
  mau INTEGER NOT NULL,
  windows_dau INTEGER NOT NULL,
  macos_dau INTEGER NOT NULL,
  desktop_dau INTEGER NOT NULL,
  extension_dau INTEGER NOT NULL,
  generated_at_utc TEXT NOT NULL
);

CREATE TABLE release_observation (
  observed_at TEXT PRIMARY KEY,
  date_utc TEXT NOT NULL UNIQUE,
  asset_count INTEGER NOT NULL
);
CREATE TABLE release_download_snapshot (
  observed_at TEXT NOT NULL REFERENCES release_observation(observed_at) ON DELETE CASCADE,
  asset_id INTEGER NOT NULL,
  release_id INTEGER NOT NULL,
  tag_name TEXT NOT NULL,
  file_name TEXT NOT NULL,
  published_at TEXT NOT NULL,
  download_count INTEGER NOT NULL CHECK (download_count >= 0),
  release_family TEXT NOT NULL,
  release_channel TEXT NOT NULL,
  artifact_kind TEXT NOT NULL,
  PRIMARY KEY (observed_at, asset_id)
);
CREATE INDEX idx_download_snapshot_asset ON release_download_snapshot(asset_id, observed_at);

-- Safe operational state only: no request bodies, IDs, IPs, or exception strings.
CREATE TABLE maintenance_state (
  task TEXT PRIMARY KEY,
  last_success_at TEXT,
  last_attempt_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed'))
);
