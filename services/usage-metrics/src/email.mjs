import { dateOffset, liveStatistics } from './statistics.mjs';
import { downloadReport } from './downloads.mjs';

export const EMAIL_CRON = '30 0 * * *'; // 08:30 Asia/Shanghai; metrics dates remain UTC.
const TIMEOUT_MS = 10_000;

const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

function downloadSummary(downloads) {
  const rows = downloads?.rows ?? [];
  const numeric = rows.filter(row => Number.isSafeInteger(row.increment));
  return {
    total: numeric.reduce((sum, row) => sum + row.increment, 0),
    tracked: rows.length,
    changed: numeric.filter(row => row.increment > 0)
      .sort((left, right) => right.increment - left.increment || left.file_name.localeCompare(right.file_name))
      .slice(0, 8),
  };
}

function emailHtml({ environment, heading, date, issues, report, sources, downloads }) {
  const shell = body => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f5f7fb;color:#172033;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif"><div style="max-width:680px;margin:0 auto;padding:24px 12px"><div style="background:#ffffff;border:1px solid #e3e8f2;border-radius:16px;overflow:hidden"><div style="padding:24px;background:#172554;color:#fff"><div style="font-size:12px;opacity:.75">网申快填 · ${escapeHtml(environment)}环境</div><h1 style="font-size:22px;margin:8px 0 4px">${escapeHtml(issues.length ? '统计异常简报' : '统计日报')}</h1><div style="font-size:14px;opacity:.85">统计日期 ${escapeHtml(date)}（UTC）</div></div>${body}<div style="padding:18px 24px;background:#f8fafc;color:#64748b;font-size:12px;line-height:1.7">使用统计按 UTC 自然日；下载量按两次快照之间的区间计算。数据仅代表启用统计并成功上报的活跃安装样本，不代表全部用户人数。</div></div></div></body></html>`;
  if (issues.length) {
    return shell(`<div style="padding:24px"><div style="padding:16px;border-radius:12px;background:#fff7ed;border:1px solid #fed7aa"><div style="font-weight:700;color:#9a3412;margin-bottom:10px">本轮数据未通过完整性检查</div><ul style="margin:0;padding-left:20px;line-height:1.8;color:#7c2d12">${issues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')}</ul></div><p style="color:#64748b;font-size:13px;margin:16px 0 0">本次不展示可能过时的统计数字。</p></div>`);
  }
  const summary = downloadSummary(downloads);
  const card = (label, value) => `<td style="width:33.33%;padding:6px"><div style="padding:16px 10px;text-align:center;border:1px solid #e2e8f0;border-radius:12px;background:#f8fafc"><div style="font-size:26px;font-weight:750;color:#1d4ed8">${escapeHtml(value)}</div><div style="font-size:12px;color:#64748b;margin-top:5px">${escapeHtml(label)}</div></div></td>`;
  const versionRows = report.versions.length
    ? report.versions.map(row => `<tr><td style="padding:9px;border-bottom:1px solid #edf2f7">${escapeHtml(row.platform)}</td><td style="padding:9px;border-bottom:1px solid #edf2f7">${escapeHtml(row.app_version)}</td><td style="padding:9px;text-align:right;border-bottom:1px solid #edf2f7">${escapeHtml(row.installations)}</td></tr>`).join('')
    : '<tr><td colspan="3" style="padding:12px;color:#64748b">暂无样本</td></tr>';
  const changedRows = summary.changed.length
    ? summary.changed.map(row => `<tr><td style="padding:9px;border-bottom:1px solid #edf2f7;word-break:break-all">${escapeHtml(row.file_name)}</td><td style="padding:9px;text-align:right;border-bottom:1px solid #edf2f7;color:#047857;font-weight:650">+${escapeHtml(row.increment)}</td></tr>`).join('')
    : '<tr><td colspan="2" style="padding:12px;color:#64748b">本区间没有新增下载</td></tr>';
  return shell(`<div style="padding:18px"><table role="presentation" style="width:100%;border-collapse:collapse"><tr>${card('当日活跃', report.counts.dau)}${card('近 7 天', report.counts.wau)}${card('近 30 天', report.counts.mau)}</tr></table></div><div style="padding:0 24px 22px"><h2 style="font-size:16px;margin:0 0 10px">使用分布</h2><table style="width:100%;border-collapse:collapse;font-size:13px"><tr><td style="padding:9px;background:#f8fafc">Windows</td><td style="padding:9px;text-align:right;background:#f8fafc">${escapeHtml(sources.windows ?? 0)}</td><td style="padding:9px;background:#f8fafc">Mac</td><td style="padding:9px;text-align:right;background:#f8fafc">${escapeHtml(sources.macos ?? 0)}</td></tr><tr><td style="padding:9px">桌面来源</td><td style="padding:9px;text-align:right">${escapeHtml(sources.desktop ?? 0)}</td><td style="padding:9px">插件来源</td><td style="padding:9px;text-align:right">${escapeHtml(sources.extension ?? 0)}</td></tr></table><div style="font-size:11px;color:#64748b;margin-top:6px">桌面和插件来源可能来自同一安装，请勿相加。</div><h2 style="font-size:16px;margin:22px 0 10px">下载概览</h2><div style="padding:14px;border-radius:12px;background:#eff6ff;color:#1e3a8a;line-height:1.7"><strong>新增下载 ${escapeHtml(summary.total)} 次</strong> · 跟踪 ${escapeHtml(summary.tracked)} 个文件<br><span style="font-size:12px">${escapeHtml(downloads?.from_observed_at ?? '无前次快照')} → ${escapeHtml(downloads?.to_observed_at ?? '无快照')}</span></div><table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:8px"><thead><tr><th style="padding:8px;text-align:left;color:#64748b">有变化的文件（最多 8 个）</th><th style="padding:8px;text-align:right;color:#64748b">新增</th></tr></thead><tbody>${changedRows}</tbody></table><h2 style="font-size:16px;margin:22px 0 10px">版本分布（近 30 天最后观察版本）</h2><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th style="padding:8px;text-align:left;color:#64748b">系统</th><th style="padding:8px;text-align:left;color:#64748b">版本</th><th style="padding:8px;text-align:right;color:#64748b">安装样本</th></tr></thead><tbody>${versionRows}</tbody></table><div style="margin-top:18px;padding:10px 12px;border-radius:10px;background:#ecfdf5;color:#065f46;font-size:12px">汇总、清理、下载任务：本轮成功</div></div>`);
}

function fresh(timestamp, cutoff, now) {
  if (typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(timestamp)) return false;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value >= Date.parse(cutoff) && value <= now.getTime();
}

export async function buildDailyEmail(db, now, environment = '测试') {
  const today = now.toISOString().slice(0, 10);
  const date = dateOffset(today, -1);
  const report = await liveStatistics(db, date, 30, now);
  const cutoff = `${today}T00:10:00.000Z`;
  const issues = [];
  for (const task of ['summary', 'cleanup', 'downloads']) {
    const state = report.maintenance.find(row => row.task === task);
    if (!state || state.status !== 'success' || !fresh(state.last_success_at, cutoff, now)) issues.push(`${task} 未确认本轮成功`);
  }
  const observations = (await db.prepare('SELECT * FROM release_observation ORDER BY observed_at DESC LIMIT 2').all()).results;
  if (!observations[0] || observations[0].date_utc !== today
      || !fresh(observations[0].observed_at, cutoff, now)) issues.push('下载快照陈旧或缺失');
  let downloads = null;
  if (!issues.includes('下载快照陈旧或缺失')) {
    try { downloads = await downloadReport(db); }
    catch { issues.push('下载快照明细不可用或不完整'); }
  }
  const sources = await db.prepare(`SELECT
    SUM(CASE WHEN platform = 'windows' THEN 1 ELSE 0 END) AS windows,
    SUM(CASE WHEN platform = 'macos' THEN 1 ELSE 0 END) AS macos,
    SUM(desktop_seen) AS desktop, SUM(extension_seen) AS extension
    FROM activity_day WHERE date_utc = ?`).bind(date).first();
  const activityStart = report.datasets.find(row => row.name === 'activity');
  if (!activityStart?.started_at_utc || activityStart.started_at_utc.slice(0, 10) > date) issues.push('报告日使用统计尚未开始，不能解释为零活跃');
  const dailySummary = await db.prepare('SELECT generated_at_utc FROM metrics_daily WHERE date_utc = ?').bind(date).first();
  if (activityStart?.started_at_utc && activityStart.started_at_utc.slice(0, 10) <= date
      && !fresh(dailySummary?.generated_at_utc, cutoff, now)) issues.push('报告日汇总缺失或陈旧');
  const heading = `[${environment}] 网申快填${issues.length ? '统计异常简报' : '统计日报'}｜${date}（UTC）`;
  // On any freshness failure, do not present stale figures as a current normal report.
  const downloadTotals = downloadSummary(downloads);
  const lines = issues.length ? ['本轮数据未通过完整性检查：', ...issues, '本次不展示可能过时的统计数字。'] : [
    `活跃安装样本：${report.counts.dau}；近7天：${report.counts.wau}；近30天：${report.counts.mau}`,
    `Windows：${sources.windows ?? 0}；Mac：${sources.macos ?? 0}`,
    `桌面来源：${sources.desktop ?? 0}；插件来源：${sources.extension ?? 0}（来源可重叠）`,
    `版本分布（近30天最后观察版本）：${report.versions.map(v => `${v.platform}/${v.app_version}: ${v.installations}`).join('；') || '无样本'}`,
    '汇总、清理、下载任务：本轮成功。',
    `下载观测区间：${downloads?.from_observed_at ?? '无前次快照'} → ${downloads?.to_observed_at ?? '无快照'}`,
    `下载新增：${downloadTotals.total} 次；跟踪文件：${downloadTotals.tracked} 个`,
    ...downloadTotals.changed.map(row => `${row.file_name}：+${row.increment}`),
  ];
  const text = [heading, ...lines, '使用统计按UTC自然日；下载增量按快照区间，不是北京时间自然日。',
    '仅为启用统计的活跃安装样本，不是全量人数。关闭后重开及离线删除未确认可能形成多个样本。',
    environment === '测试' ? '测试环境邮件，不代表正式运营数据。' : '正式环境邮件。'].join('\n');
  return { date, subject: heading, text, html: emailHtml({ environment, heading, date, issues, report, sources, downloads }) };
}

export async function runDailyEmail(env, { now = () => new Date(), timeoutMs = TIMEOUT_MS } = {}) {
  if (env.DAILY_EMAIL_ENABLED !== 'true') return { status: 'disabled' };
  if (typeof env.METRICS_EMAIL?.send !== 'function' || typeof env.DB?.prepare !== 'function') return { status: 'not_ready' };
  const addresses = [env.DAILY_EMAIL_TO_0, env.DAILY_EMAIL_TO_1];
  const environment = env.DAILY_EMAIL_ENVIRONMENT;
  const validAddress = value => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (!validAddress(env.DAILY_EMAIL_FROM) || addresses.some(value => !validAddress(value))
      || addresses[0] === addresses[1] || !['测试', '正式'].includes(environment)) return { status: 'not_ready' };
  const at = now();
  // Fail before delivery reservation if queries fail; never turn exceptions into zero figures.
  let mail;
  try { mail = await buildDailyEmail(env.DB, at, environment); } catch { return { status: 'report_failed' }; }
  const results = [];
  let storageFailed = false;
  for (let slot = 0; slot < addresses.length; slot++) {
    let claimed;
    try {
      claimed = await env.DB.prepare(`INSERT OR IGNORE INTO email_delivery
        (report_date, recipient_slot, status, updated_at) VALUES (?, ?, 'pending', ?)`)
        .bind(mail.date, slot, at.toISOString()).run();
    } catch {
      storageFailed = true;
      results.push('reservation_failed');
      continue;
    }
    if (!claimed.meta.changes) { results.push('already_reserved'); continue; }
    // Commit uncertainty BEFORE invoking the external service. A crash cannot cause a
    // later invocation to blindly resend. Provider acceptance is not inbox delivery.
    try {
      await env.DB.prepare("UPDATE email_delivery SET status='unknown', error_code='delivery_unconfirmed', updated_at=? WHERE report_date=? AND recipient_slot=?")
        .bind(now().toISOString(), mail.date, slot).run();
    } catch {
      storageFailed = true;
      results.push('reservation_unconfirmed');
      continue; // pending prevents an automatic retry; no email is sent without durable unknown.
    }
    let timer;
    try {
      await Promise.race([
        env.METRICS_EMAIL.send({ from: env.DAILY_EMAIL_FROM, to: addresses[slot], subject: mail.subject, text: mail.text, html: mail.html }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
      ]);
    } catch {
      results.push('unknown'); // Provider outcome unknown; no automatic retry.
      continue;
    } finally { clearTimeout(timer); }
    try {
      await env.DB.prepare("UPDATE email_delivery SET status='accepted', error_code=NULL, updated_at=? WHERE report_date=? AND recipient_slot=?")
        .bind(now().toISOString(), mail.date, slot).run();
      results.push('accepted');
    } catch {
      // Provider accepted, but receipt could not be saved. The durable row remains unknown.
      results.push('accepted_record_failed');
    }
  }
  // Do not delete reservations automatically: losing a reservation can resend old reports.
  if (storageFailed) throw new Error('email_delivery_state_failed');
  return { status: 'processed', recipients: results };
}
