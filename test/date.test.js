/**
 * test/date.test.js
 * api/db.js dateKey 的单元测试(node --test)
 * 覆盖本地时区日期构造(不能用 toISOString,UTC 会错位)、补零、月末与年初边界。
 * 运行:node --test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dateKey } = require('../api/db.js');

test('dateKey: 本地时区构造常规日期', () => {
  assert.equal(dateKey(new Date(2026, 7, 23)), '2026-08-23');
  assert.equal(dateKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(dateKey(new Date(2026, 11, 31)), '2026-12-31');
});

test('dateKey: 月 / 日补零', () => {
  assert.equal(dateKey(new Date(2026, 1, 3)), '2026-02-03');
  assert.equal(dateKey(new Date(2026, 9, 9)), '2026-10-09');
  assert.equal(dateKey(new Date(2026, 6, 7)), '2026-07-07');
});

test('dateKey: 月末边界(2 月平年 / 4 月小月 / 1 月大月)', () => {
  assert.equal(dateKey(new Date(2026, 1, 28)), '2026-02-28');
  assert.equal(dateKey(new Date(2026, 3, 30)), '2026-04-30');
  assert.equal(dateKey(new Date(2026, 0, 31)), '2026-01-31');
});

test('dateKey: 跨年 / 年初边界', () => {
  assert.equal(dateKey(new Date(2026, 0, 1)), '2026-01-01');
  assert.equal(dateKey(new Date(2025, 11, 31)), '2025-12-31');
  assert.equal(dateKey(new Date(2026, 11, 31)), '2026-12-31');
  assert.equal(dateKey(new Date(2027, 0, 1)), '2027-01-01');
});

test('dateKey: 默认参数为本地时区的今天', () => {
  const now = new Date();
  const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
  assert.equal(dateKey(), expected);
});
