import { dateOffset, liveStatistics } from './statistics.mjs';
import { downloadReport } from './downloads.mjs';

export const EMAIL_CRON = '30 0 * * *'; // 08:30 Asia/Shanghai; metrics dates remain UTC.
export const EMAIL_FROM = 'reports@19991107.xyz';
export const EMAIL_TO = ['peteryan233@foxmail.com', '1536484476@qq.com'];
const TIMEOUT_MS = 10_000;

export async function buildDailyEmail(db, now) {
  const today = now.toISOString().slice(0, 10);
  const date = dateOffset(today, -1);
  const report = await liveStatistics(db, date, 30, now);
  const cutoff = `${today}T00:10:00.000Z`;
  const issues = [];
  for (const task of ['summary', 'cleanup', 'downloads']) {
    const state = report.maintenance.find(row => row.task === task);
    if (!state || state.status !== 'success' || state.last_success_at < cutoff
        || state.last_success_at > now.toISOString()) issues.push(`${task} 未确认本轮成功`);
  }
  const observations = (await db.prepare('SELECT * FROM release_observation ORDER BY observed_at DESC LIMIT 2').all()).results;
  if (!observations[0] || observations[0].date_utc !== today
      || observations[0].observed_at < cutoff || observations[0].observed_at > now.toISOString()) issues.push('下载快照陈旧或缺失');
  const downloads = await downloadReport(db); // Stored row-count validation rejects incomplete snapshots.
  const sources = await db.prepare(`SELECT
    SUM(CASE WHEN platform = 'windows' THEN 1 ELSE 0 END) AS windows,
    SUM(CASE WHEN platform = 'macos' THEN 1 ELSE 0 END) AS macos,
    SUM(desktop_seen) AS desktop, SUM(extension_seen) AS extension
    FROM activity_day WHERE date_utc = ?`).bind(date).first();
  const activityStart = report.datasets.find(row => row.name === 'activity');
  if (!activityStart || activityStart.started_at_utc.slice(0, 10) > date) issues.push('报告日使用统计尚未开始，不能解释为零活跃');
  const summary = await db.prepare('SELECT generated_at_utc FROM metrics_daily WHERE date_utc = ?').bind(date).first();
  if (activityStart && activityStart.started_at_utc.slice(0, 10) <= date
      && (!summary || summary.generated_at_utc < cutoff || summary.generated_at_utc > now.toISOString())) issues.push('报告日汇总缺失或陈旧');
  const heading = `[测试] 网申快填${issues.length ? '统计异常简报' : '统计日报'}｜${date}（UTC）`;
  // On any freshness failure, do not present stale figures as a current normal report.
  const lines = issues.length ? ['本轮数据未通过完整性检查：', ...issues, '本次不展示可能过时的统计数字。'] : [
    `活跃安装样本：${report.counts.dau}；近7天：${report.counts.wau}；近30天：${report.counts.mau}`,
    `Windows：${sources.windows ?? 0}；Mac：${sources.macos ?? 0}`,
    `桌面来源：${sources.desktop ?? 0}；插件来源：${sources.extension ?? 0}（来源可重叠）`,
    `版本分布（近30天最后观察版本）：${report.versions.map(v => `${v.platform}/${v.app_version}: ${v.installations}`).join('；') || '无样本'}`,
    '汇总、清理、下载任务：本轮成功。',
    `下载观测区间：${downloads?.from_observed_at ?? '无前次快照'} → ${downloads?.to_observed_at ?? '无快照'}`,
    ...(downloads?.rows ?? []).map(row => `${row.file_name}：${row.status}；增量 ${row.increment ?? '不可计算'}`),
  ];
  const text = [heading, ...lines, '使用统计按UTC自然日；下载增量按快照区间，不是北京时间自然日。',
    '仅为启用统计的活跃安装样本，不是全量人数。关闭后重开及离线删除未确认可能形成多个样本。',
    '测试环境邮件，不代表正式运营数据。'].join('\n');
  return { date, subject: heading, text };
}

export async function runDailyEmail(env, { now = () => new Date(), timeoutMs = TIMEOUT_MS } = {}) {
  if (env.DAILY_EMAIL_ENABLED !== 'true') return { status: 'disabled' };
  if (typeof env.METRICS_EMAIL?.send !== 'function' || typeof env.DB?.prepare !== 'function') return { status: 'not_ready' };
  const at = now();
  // Fail before delivery reservation if queries fail; never turn exceptions into zero figures.
  let mail;
  try { mail = await buildDailyEmail(env.DB, at); } catch { return { status: 'report_failed' }; }
  const results = [];
  for (let slot = 0; slot < EMAIL_TO.length; slot++) {
    const claimed = await env.DB.prepare(`INSERT OR IGNORE INTO email_delivery
      (report_date, recipient_slot, status, updated_at) VALUES (?, ?, 'pending', ?)`)
      .bind(mail.date, slot, at.toISOString()).run();
    if (!claimed.meta.changes) { results.push('already_reserved'); continue; }
    // Commit uncertainty BEFORE invoking the external service. A crash cannot cause a
    // later invocation to blindly resend. Provider acceptance is not inbox delivery.
    await env.DB.prepare("UPDATE email_delivery SET status='unknown', error_code='delivery_unconfirmed', updated_at=? WHERE report_date=? AND recipient_slot=?")
      .bind(now().toISOString(), mail.date, slot).run();
    let timer;
    try {
      await Promise.race([
        env.METRICS_EMAIL.send({ from: EMAIL_FROM, to: EMAIL_TO[slot], subject: mail.subject, text: mail.text }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
      ]);
      await env.DB.prepare("UPDATE email_delivery SET status='accepted', error_code=NULL, updated_at=? WHERE report_date=? AND recipient_slot=?")
        .bind(now().toISOString(), mail.date, slot).run();
      results.push('accepted');
    } catch {
      results.push('unknown'); // No raw error/body/address logging; no automatic retry.
    } finally { clearTimeout(timer); }
  }
  // Do not delete reservations automatically: losing a reservation can resend old reports.
  return { status: 'processed', recipients: results };
}
