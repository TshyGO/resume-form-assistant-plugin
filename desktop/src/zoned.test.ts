import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatInZone, localInputToUtc, utcToLocalInput } from './zoned.ts';

test('墙钟按待办自己的时区换算成 UTC，不是按本机', () => {
  // 上海 9 月 14 日上午十点 = UTC 02:00。不管跑测试的机器在哪个时区。
  assert.equal(localInputToUtc("2026-09-14T10:00", "Asia/Shanghai"), "2026-09-14T02:00:00.000Z");
  assert.equal(localInputToUtc("2026-09-14T10:00", "UTC"), "2026-09-14T10:00:00.000Z");
  // 纽约夏令时是 UTC-4。
  assert.equal(
    localInputToUtc("2026-09-14T10:00", "America/New_York"),
    "2026-09-14T14:00:00.000Z",
  );
});

test('跨夏令时切换的那几个小时也要算对', () => {
  // 纽约 2026-11-01 02:00 已经回到 EST（UTC-5），01:00 还在 EDT（UTC-4）。
  // 一次偏移猜不准，所以要迭代第二次。
  assert.equal(
    localInputToUtc("2026-11-01T03:00", "America/New_York"),
    "2026-11-01T08:00:00.000Z",
    "EST：UTC-5",
  );
  assert.equal(
    localInputToUtc("2026-10-31T03:00", "America/New_York"),
    "2026-10-31T07:00:00.000Z",
    "EDT：UTC-4",
  );
});

test('UTC 时刻回填到输入框时按待办时区显示', () => {
  assert.equal(utcToLocalInput("2026-09-14T02:00:00Z", "Asia/Shanghai"), "2026-09-14T10:00");
  assert.equal(utcToLocalInput("2026-09-14T02:00:00Z", "UTC"), "2026-09-14T02:00");
  assert.equal(
    utcToLocalInput("2026-09-14T14:00:00Z", "America/New_York"),
    "2026-09-14T10:00",
  );
});

test('回填再保存要回到同一个时刻，不能每编辑一次就平移一个偏移', () => {
  const stored = "2026-09-14T02:00:00.000Z";
  for (const zone of ["Asia/Shanghai", "America/New_York", "UTC", null]) {
    const shown = utcToLocalInput(stored, zone);
    assert.equal(localInputToUtc(shown, zone), stored, `${zone} 往返不闭合`);
  }
});

test('显示用待办自己的时区，不是本机时区', () => {
  const shanghai = formatInZone("2026-09-14T02:00:00Z", "Asia/Shanghai");
  const newYork = formatInZone("2026-09-14T02:00:00Z", "America/New_York");

  assert.match(shanghai ?? "", /10:00/, "上海是 UTC+8");
  assert.match(newYork ?? "", /22:00/, "纽约是 UTC-4，同一时刻是前一天晚上");
  assert.match(newYork ?? "", /09\/13/, "而且已经是 13 号");
  assert.notEqual(shanghai, newYork, "两个时区不该显示成同一串数字");
});

test('时区名不认识、时间读不出来时不抛异常', () => {
  assert.equal(formatInZone("不是时间", "Asia/Shanghai"), null);
  assert.ok(formatInZone("2026-09-14T02:00:00Z", "Mars/Olympus_Mons"));
  assert.equal(utcToLocalInput("不是时间", "Asia/Shanghai"), "");
  assert.ok(utcToLocalInput("2026-09-14T02:00:00Z", "Mars/Olympus_Mons"));
  assert.equal(localInputToUtc("", "Asia/Shanghai"), null);
  assert.equal(localInputToUtc("不是时间", "Asia/Shanghai"), null);
});
