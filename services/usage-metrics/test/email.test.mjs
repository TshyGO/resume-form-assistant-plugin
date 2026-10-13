import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { buildDailyEmail, runDailyEmail, EMAIL_TO, EMAIL_CRON } from '../src/email.mjs';
import { createWorker } from '../src/index.mjs';
const NOW = new Date('2026-10-13T00:30:00Z');
let mf, db;
before(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules:true,scriptPath:'output/worker.mjs',compatibilityDate:'2026-10-01',d1Databases:['DB'] }));
  db = await mf.getD1Database('DB');
  const sql = ['0001_metrics.sql','0002_maintenance_error.sql','0003_email_delivery.sql'].map(n => readFileSync(new URL('../migrations/'+n,import.meta.url),'utf8')).join('\n');
  await db.batch(sql.split(';').map(s=>s.trim()).filter(Boolean).map(s=>db.prepare(s)));
});
beforeEach(async()=> {
  await db.batch(['email_delivery','activity_day','dataset_info','metrics_daily','maintenance_state','release_observation'].map(t=>db.prepare('DELETE FROM '+t)));
  await db.prepare("INSERT INTO dataset_info VALUES ('activity','2026-10-12T12:00:00Z')").run();
  for(const task of ['summary','cleanup','downloads']) await db.prepare("INSERT INTO maintenance_state VALUES (?, '2026-10-13T00:10:10Z', '2026-10-13T00:10:10Z','success',NULL)").bind(task).run();
  await db.prepare("INSERT INTO metrics_daily VALUES ('2026-10-12',0,0,0,0,0,0,0,'2026-10-13T00:10:10Z')").run();
  for (const date of ['2026-10-12','2026-10-13']) await db.prepare('INSERT INTO release_observation VALUES (?,?,0)').bind(date+'T00:10:10Z',date).run();
});
after(async()=>mf?.dispose());
const env = send=>({DB:db,DAILY_EMAIL_ENABLED:'true',METRICS_EMAIL:{send}});
const opts={now:()=>NOW};
test('default off and missing binding never query or send', async()=> {
  assert.equal((await runDailyEmail({})).status,'disabled');
  assert.equal((await runDailyEmail({DAILY_EMAIL_ENABLED:'true'})).status,'not_ready');
});
test('UTC closed date, task freshness and snapshot row integrity determine normal vs anomaly',async()=>{
  let m=await buildDailyEmail(db,NOW);assert.equal(m.date,'2026-10-12');assert.match(m.subject,/统计日报/);assert.match(m.text,/来源可重叠/);
  await db.prepare("UPDATE maintenance_state SET last_success_at='2026-10-12T00:10:10Z' WHERE task='downloads'").run();
  m=await buildDailyEmail(db,NOW);assert.match(m.subject,/异常/);assert.doesNotMatch(m.text,/活跃安装样本：0/);
  await db.prepare('UPDATE release_observation SET asset_count=1').run();
  await assert.rejects(()=>buildDailyEmail(db,NOW),/Incomplete stored snapshot/);
});
test('missing report-day summary and unstarted activity are not misleading zero reports',async()=>{
  await db.prepare('DELETE FROM metrics_daily').run();assert.match((await buildDailyEmail(db,NOW)).text,/汇总缺失/);
  await db.prepare('DELETE FROM dataset_info').run();assert.match((await buildDailyEmail(db,NOW)).text,/尚未开始/);
});
test('parallel/repeated dispatch reserves each recipient once and stores acceptance, not inbox delivery',async()=>{
  const sent=[];const e=env(async mail=>sent.push(mail));
  await Promise.all([runDailyEmail(e,opts),runDailyEmail(e,opts)]);await runDailyEmail(e,opts);
  assert.equal(sent.length,2);assert.deepEqual(sent.map(x=>x.to).sort(),[...EMAIL_TO].sort());
  const rows=(await db.prepare('SELECT * FROM email_delivery').all()).results;assert.ok(rows.every(x=>x.status==='accepted'));
  assert.ok(rows.every(x=>!JSON.stringify(x).includes('@')));
});
test('partial acceptance and ambiguous error do not resend either recipient',async()=>{
  const calls=[];const e=env(async m=>{calls.push(m.to);if(m.to===EMAIL_TO[1])throw new Error('private provider details');});
  await runDailyEmail(e,opts);await runDailyEmail(e,opts);
  assert.equal(calls.length,2);const rows=(await db.prepare('SELECT status,error_code FROM email_delivery ORDER BY recipient_slot').all()).results;
  assert.equal(rows[0].status,'accepted');assert.equal(rows[1].status,'unknown');assert.equal(rows[1].error_code,'delivery_unconfirmed');
});
test('timeout preserves uncertainty and duplicate invocation cannot retry',async()=>{
  let calls=0;const e=env(()=>{calls++;return new Promise(()=>{});});
  await runDailyEmail(e,{...opts,timeoutMs:5});await runDailyEmail(e,opts);assert.equal(calls,2);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM email_delivery WHERE status='unknown'").first()).n,2);
});
test('pending crash reservation is never replayed and query failure is not sent',async()=>{
  await db.prepare("INSERT INTO email_delivery VALUES ('2026-10-12',0,'pending','2026-10-13T00:30:00Z',NULL)").run();
  let calls=0;await runDailyEmail(env(async()=>calls++),opts);assert.equal(calls,1);
  await db.prepare('UPDATE release_observation SET asset_count=1').run();assert.equal((await runDailyEmail(env(async()=>calls++),opts)).status,'report_failed');assert.equal(calls,1);
});
test('email cron does not run maintenance or send when default disabled',async()=>{
  const worker=createWorker({now:()=>NOW,fetchImpl:()=>{throw new Error('must not fetch');}});
  await worker.scheduled({cron:EMAIL_CRON},{});
});
