/**
 * test/ai-image-retry.test.js
 * cloudfunctions/ai-image 生图重试强信号判定(node --test)。
 * 云函数本地位于 cloudfunctions/ai-image/index.js,依赖 wx-server-sdk 云端安装、本地无法直接 require,
 * 故用源码提取 + 沙箱求值(与 ai-recipe.test.js 编辑页 applyRecipeDraft 提取同款手法)。
 * 覆盖:429 状态码 / 限流与配额类文案→可重试;无关错误(如 token 时间戳)→不重试(生图重试代价高)。
 * 运行:node --test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../cloudfunctions/ai-image/index.js'), 'utf8');
const m = src.match(/function isRetryableImageError\(err\)\s\{[\s\S]*?\n\}/);
assert.ok(m, '源文件中应能提取 isRetryableImageError');
// eslint-disable-next-line no-new-func
const isRetryableImageError = new Function(`${m[0]}; return isRetryableImageError;`)();

test('ai-image 重试:statusCode / status 为 429 → 可重试', () => {
  assert.equal(isRetryableImageError({ statusCode: 429 }), true);
  assert.equal(isRetryableImageError({ status: 429 }), true);
  assert.equal(isRetryableImageError({ statusCode: 200 }), false);
});

test('ai-image 重试:429 / 限流 / 配额类文案 → 可重试', () => {
  assert.equal(isRetryableImageError({ message: 'HTTP 429 Too Many Requests' }), true);
  assert.equal(isRetryableImageError({ message: '触发限流' }), true);
  assert.equal(isRetryableImageError({ message: 'rate limit exceeded' }), true);
  assert.equal(isRetryableImageError({ message: 'quota exceeded' }), true);
  assert.equal(isRetryableImageError({ message: 'throttle' }), true);
  assert.equal(isRetryableImageError({ message: 'too many requests' }), true);
  assert.equal(isRetryableImageError({ message: 'RESOURCE_EXHAUSTED' }), true);
  assert.equal(isRetryableImageError({ message: 'ServiceUnavailable' }), true);
});

test('ai-image 重试:无关错误 → 不重试(识别不出就直抛,生图重试代价高)', () => {
  assert.equal(isRetryableImageError({ message: 'invalid token timestamp' }), false);
  assert.equal(isRetryableImageError({ message: '图片内容违规' }), false);
  assert.equal(isRetryableImageError({}), false);
  assert.equal(isRetryableImageError(null), false);
  assert.equal(isRetryableImageError(undefined), false);
});