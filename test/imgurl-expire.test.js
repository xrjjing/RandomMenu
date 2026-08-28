/**
 * test/imgurl-expire.test.js
 * F25 后补:imgUrl 换链缓存的签名级过期判定(node --test)
 * 背景:2026-08-28 线上出现 403——本地 exp 未到但签名 t 已过期(热重载/多端
 * 场景本地时间戳不可信)。修复:getCached 以链接 t 参数(权威过期时刻)优先判定。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

/** 构造带 t 签名参数的 COS 风格临时链接(t 为 Unix 秒过期时刻) */
function cosUrl(expireSec) {
  return `https://demo.tcb.qcloud.la/builtin/x.jpg?sign=abc&t=${expireSec}`;
}

/** 纯逻辑镜像(与 utils/imgUrl.js 的 getCached 判定保持一致),便于无 wx 环境单测 */
function isExpired(url, localExp, now) {
  const m = typeof url === 'string' ? url.match(/[?&]t=(\d{10})(?:&|$)/) : null;
  const signedExp = m ? Number(m[1]) * 1000 : 0;
  return signedExp ? signedExp - 20 * 60 * 1000 <= now : localExp <= now;
}

test('t 在未来 2 小时:缓存有效', () => {
  const now = Date.now();
  assert.strictEqual(isExpired(cosUrl(Math.floor((now + 2 * 3600e3) / 1000)), now + 3600e3, now), false);
});

test('t 已过 13 分钟(线上 403 场景):即使本地 exp 未到也必须判过期', () => {
  const now = Date.now();
  const signedExp = now + 13 * 60e3; // 签名还剩 13 分钟,不足 20 分钟边距
  assert.strictEqual(isExpired(cosUrl(Math.floor(signedExp / 1000)), now + 60 * 60e3, now), true);
});

test('t 已过期很久:判过期', () => {
  const now = Date.now();
  assert.strictEqual(isExpired(cosUrl(Math.floor((now - 3600e3) / 1000)), now + 3600e3, now), true);
});

test('无 t 参数(非 COS 链接):回退本地 exp 判定', () => {
  const now = Date.now();
  assert.strictEqual(isExpired('https://a.b/c.jpg', now - 1, now), true);
  assert.strictEqual(isExpired('https://a.b/c.jpg', now + 3600e3, now), false);
});
