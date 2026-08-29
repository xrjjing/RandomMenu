/**
 * test/ai-usage.test.js
 * F30 #9 用量汇总纯函数验收(node --test):packages/dish/ai/usage.js。
 * 覆盖:monthKey 月份键 / summarizeUsage 空文档与有数据文档(本月 + 累计)。
 * 运行:node --test。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { monthKey, summarizeUsage } = require('../packages/dish/ai/usage.js');

/* ---------------- monthKey ---------------- */

test('monthKey:本地年月补零', () => {
  assert.equal(monthKey(new Date(2026, 7, 5)), '2026-08');
  assert.equal(monthKey(new Date(2026, 10, 30)), '2026-11');
  assert.equal(monthKey(new Date(2027, 0, 1)), '2027-01');
});

/* ---------------- summarizeUsage ---------------- */

test('summarizeUsage:无文档返回本月/累计全 0', () => {
  const now = new Date(2026, 8, 15);
  const out = summarizeUsage(null, now);
  assert.equal(out.monthKey, '2026-09');
  assert.deepEqual(out.month, { textCalls: 0, imageCalls: 0, totalTokens: 0 });
  assert.deepEqual(out.total, { textCalls: 0, imageCalls: 0, totalTokens: 0 });
});

test('summarizeUsage:按嵌套 byMonth 读本月,累计读顶层字段', () => {
  const now = new Date(2026, 8, 15);
  const doc = {
    totalTextCalls: 12,
    totalImageCalls: 3,
    totalTokens: 1234,
    byMonth: {
      '2026-09': { textCalls: 5, imageCalls: 2, totalTokens: 500 },
      '2026-08': { textCalls: 7, imageCalls: 1, totalTokens: 734 },
    },
  };
  const out = summarizeUsage(doc, now);
  assert.equal(out.monthKey, '2026-09');
  assert.deepEqual(out.month, { textCalls: 5, imageCalls: 2, totalTokens: 500 });
  assert.deepEqual(out.total, { textCalls: 12, imageCalls: 3, totalTokens: 1234 });
});

test('summarizeUsage:当月无记录时本月为 0,累计仍读顶层', () => {
  const now = new Date(2026, 8, 15);
  const doc = { totalTextCalls: 1, byMonth: { '2026-01': { textCalls: 1 } } };
  const out = summarizeUsage(doc, now);
  assert.deepEqual(out.month, { textCalls: 0, imageCalls: 0, totalTokens: 0 });
  assert.equal(out.total.textCalls, 1);
});
