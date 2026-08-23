/**
 * test/image.test.js
 * utils/image.js 图片路径识别逻辑测试(node --test)
 * 运行:node --test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isCloudFileId } = require('../utils/image.js');

const CLOUD_A = 'cloud://env-xxx.656e-env-xxx/dishes/20260823-abc.jpg';

test('image:isCloudFileId 识别云端 fileID', () => {
  assert.equal(isCloudFileId(CLOUD_A), true);
  assert.equal(isCloudFileId('cloud://x/y.png'), true);
  assert.equal(isCloudFileId('cloud://env/dishes/a.jpg'), true);
});

test('image:isCloudFileId 空值/非字符串返回 false', () => {
  assert.equal(isCloudFileId(''), false);
  assert.equal(isCloudFileId(null), false);
  assert.equal(isCloudFileId(undefined), false);
});
