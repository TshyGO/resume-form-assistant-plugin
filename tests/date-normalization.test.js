const test = require("node:test");
const assert = require("node:assert/strict");
const helpers = require("../ai-helpers.js");

test("中文格式 '1999年1月1日' → type=date → '1999-01-01'", () => {
  assert.equal(helpers.normalizeDateValue("1999年1月1日", "date"), "1999-01-01");
});

test("中文格式 '1999年1月1日' → type=month → '1999-01'", () => {
  assert.equal(helpers.normalizeDateValue("1999年1月1日", "month"), "1999-01");
});

test("中文格式无日 '1999年3月' → type=date → 原值（缺 day）", () => {
  assert.equal(helpers.normalizeDateValue("1999年3月", "date"), "1999年3月");
});

test("中文格式无日 '1999年3月' → type=month → '1999-03'", () => {
  assert.equal(helpers.normalizeDateValue("1999年3月", "month"), "1999-03");
});

test("斜杠格式 '1999/1/1' → type=date → '1999-01-01'", () => {
  assert.equal(helpers.normalizeDateValue("1999/1/1", "date"), "1999-01-01");
});

test("斜杠格式 '1999/01/01' → type=date → '1999-01-01'", () => {
  assert.equal(helpers.normalizeDateValue("1999/01/01", "date"), "1999-01-01");
});

test("点号格式 '1999.1.1' → type=date → '1999-01-01'", () => {
  assert.equal(helpers.normalizeDateValue("1999.1.1", "date"), "1999-01-01");
});

test("连字符格式 '1999-01-01' → type=date → '1999-01-01'（已是标准格式）", () => {
  assert.equal(helpers.normalizeDateValue("1999-01-01", "date"), "1999-01-01");
});

test("斜杠年月 '1999/01' → type=month → '1999-01'", () => {
  assert.equal(helpers.normalizeDateValue("1999/01", "month"), "1999-01");
});

test("点号年月 '1999.3' → type=month → '1999-03'", () => {
  assert.equal(helpers.normalizeDateValue("1999.3", "month"), "1999-03");
});

test("时间格式 '09:30' → type=time → '09:30'", () => {
  assert.equal(helpers.normalizeDateValue("09:30", "time"), "09:30");
});

test("时间格式 '9:05' → type=time → '09:05'", () => {
  assert.equal(helpers.normalizeDateValue("9:05", "time"), "09:05");
});

test("datetime-local '1999/01/01 09:30' → type=datetime-local → '1999-01-01T09:30'", () => {
  assert.equal(helpers.normalizeDateValue("1999/01/01 09:30", "datetime-local"), "1999-01-01T09:30");
});

test("中文日期带时间 '1999年1月1日 09:30' → type=datetime-local → '1999-01-01T09:30'", () => {
  assert.equal(helpers.normalizeDateValue("1999年1月1日 09:30", "datetime-local"), "1999-01-01T09:30");
});

test("中文日期带时间 '1999年1月1日 09:30' → type=date → '1999-01-01'（时间部分忽略）", () => {
  assert.equal(helpers.normalizeDateValue("1999年1月1日 09:30", "date"), "1999-01-01");
});

test("datetime-local '1999-01-01T08:00' → type=datetime-local → '1999-01-01T08:00'", () => {
  assert.equal(helpers.normalizeDateValue("1999-01-01T08:00", "datetime-local"), "1999-01-01T08:00");
});

test("月份范围 '2023.06-2023.08' → type=month → 原值（不应被解析为单月）", () => {
  assert.equal(helpers.normalizeDateValue("2023.06-2023.08", "month"), "2023.06-2023.08");
});

test("月份范围 '2023/06-2023/08' → type=month → 原值", () => {
  assert.equal(helpers.normalizeDateValue("2023/06-2023/08", "month"), "2023/06-2023/08");
});

test("无效输入 '出生日期' → type=date → 原值不崩溃", () => {
  assert.equal(helpers.normalizeDateValue("出生日期", "date"), "出生日期");
});

test("空字符串 → type=date → 返回空字符串", () => {
  assert.equal(helpers.normalizeDateValue("", "date"), "");
});

test("null 输入 → type=date → 返回空字符串", () => {
  assert.equal(helpers.normalizeDateValue(null, "date"), "");
});

test("未知 inputType → 返回原值", () => {
  assert.equal(helpers.normalizeDateValue("1999-01-01", "unknown"), "1999-01-01");
});

test("月份个位数补零 '2000/5/8' → type=date → '2000-05-08'", () => {
  assert.equal(helpers.normalizeDateValue("2000/5/8", "date"), "2000-05-08");
});

test("月份个位数补零 '2000/5' → type=month → '2000-05'", () => {
  assert.equal(helpers.normalizeDateValue("2000/5", "month"), "2000-05");
});
