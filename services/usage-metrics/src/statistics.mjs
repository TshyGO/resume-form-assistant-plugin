export function dateOffset(date, days) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export class StatisticsInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatisticsInputError';
    this.code = code;
  }
}

export function validateStatisticsWindow(date, days = 30, observedAt = new Date()) {
  if (![7, 30].includes(days)) throw new StatisticsInputError('invalid_window', 'Invalid statistics window');
  const timestamp = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new StatisticsInputError('invalid_date', 'Invalid statistics window');
  }
  const today = observedAt.toISOString().slice(0, 10);
  if (date > today || date < dateOffset(today, -15)) {
    throw new StatisticsInputError('outside_retained_history', 'Window outside complete retained history');
  }
  return { today, from: dateOffset(date, 1 - days) };
}

export async function liveStatistics(db, date, days = 30, observedAt = new Date()) {
  const { today, from } = validateStatisticsWindow(date, days, observedAt);
  const latest = `WITH ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY installation_hash ORDER BY last_seen_at_utc DESC, last_seen_seq DESC) AS rank
    FROM activity_day WHERE date_utc BETWEEN ? AND ?
  ) SELECT app_version, platform, COUNT(*) AS installations FROM ranked WHERE rank = 1 GROUP BY app_version, platform ORDER BY app_version, platform`;
  const results = await db.batch([
    db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN date_utc = ? THEN installation_hash END) AS dau,
      COUNT(DISTINCT CASE WHEN date_utc >= ? THEN installation_hash END) AS wau,
      COUNT(DISTINCT installation_hash) AS mau
      FROM activity_day WHERE date_utc BETWEEN ? AND ?`).bind(date, dateOffset(date, -6), dateOffset(date, -29), date),
    db.prepare(latest).bind(from, date),
    db.prepare('SELECT name, started_at_utc FROM dataset_info ORDER BY name'),
    db.prepare('SELECT task, last_success_at, last_attempt_at, status, last_error_code FROM maintenance_state ORDER BY task'),
  ]);
  return { date_utc: date, current_day_incomplete: date === today, version_window_days: days, scope: 'enabled_statistics_installations', counts: results[0].results[0], versions: results[1].results, datasets: results[2].results, maintenance: results[3].results };
}

export async function summarizeClosedDays(db, now) {
  const today = now.toISOString().slice(0, 10);
  const start = await db.prepare("SELECT substr(started_at_utc, 1, 10) AS date FROM dataset_info WHERE name = 'activity'").first();
  if (!start) return;
  // Earliest complete 30-day window recoverable from 45 retained UTC days.
  const first = [start.date, dateOffset(today, -15)].sort().at(-1);
  const last = dateOffset(today, -1);
  if (first > last) return;
  await db.prepare(`WITH RECURSIVE days(date) AS (
      SELECT ? UNION ALL SELECT date(date, '+1 day') FROM days WHERE date < ?
    ) INSERT INTO metrics_daily
      (date_utc, dau, wau, mau, windows_dau, macos_dau, desktop_dau, extension_dau, generated_at_utc)
    SELECT date,
      (SELECT COUNT(*) FROM activity_day WHERE date_utc = days.date),
      (SELECT COUNT(DISTINCT installation_hash) FROM activity_day WHERE date_utc BETWEEN date(days.date, '-6 days') AND days.date),
      (SELECT COUNT(DISTINCT installation_hash) FROM activity_day WHERE date_utc BETWEEN date(days.date, '-29 days') AND days.date),
      (SELECT COUNT(*) FROM activity_day WHERE date_utc = days.date AND platform = 'windows'),
      (SELECT COUNT(*) FROM activity_day WHERE date_utc = days.date AND platform = 'macos'),
      (SELECT COUNT(*) FROM activity_day WHERE date_utc = days.date AND desktop_seen = 1),
      (SELECT COUNT(*) FROM activity_day WHERE date_utc = days.date AND extension_seen = 1), ?
    FROM days WHERE true ON CONFLICT(date_utc) DO NOTHING`).bind(first, last, now.toISOString()).run();
}

export async function cleanup(db, now) {
  const today = now.toISOString().slice(0, 10);
  await db.batch([
    db.prepare('DELETE FROM activity_day WHERE date_utc < ?').bind(dateOffset(today, -44)),
    db.prepare('DELETE FROM revoked_installations WHERE expires_at_utc <= ?').bind(now.toISOString()),
    db.prepare('DELETE FROM metrics_daily WHERE date_utc < ?').bind(dateOffset(today, -364)),
    db.prepare('DELETE FROM release_observation WHERE date_utc < ?').bind(dateOffset(today, -364)),
  ]);
}
