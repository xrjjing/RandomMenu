/**
 * test/image.test.js
 * utils/image.js 图片路径识别与展示排序逻辑测试(node --test)
 * 运行:node --test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isCloudFileId, orderDishImages } = require('../utils/image.js');

const CLOUD_A = 'cloud://env-xxx.656e-env-xxx/dishes/20260823-abc.jpg';
const CLOUD_B = 'cloud://env-xxx.656e-env-xxx/dishes/20260823-def.png';
const STATIC_A = '/static/images/回锅肉.jpg';
const STATIC_B = '/static/images/扬州炒饭.jpeg';

test('image:isCloudFileId 识别云端 fileID', () => {
  assert.equal(isCloudFileId(CLOUD_A), true);
  assert.equal(isCloudFileId('cloud://x/y.png'), true);
  assert.equal(isCloudFileId('cloud://env/dishes/a.jpg'), true);
});

test('image:isCloudFileId 静态路径返回 false(删除图片时不清理本地源文件)', () => {
  assert.equal(isCloudFileId(STATIC_A), false);
  assert.equal(isCloudFileId(STATIC_B), false);
  assert.equal(isCloudFileId('/static/images/a.png'), false);
  assert.equal(isCloudFileId('/static/images/b.jpeg'), false);
});

test('image:isCloudFileId 空值/非字符串返回 false', () => {
  assert.equal(isCloudFileId(''), false);
  assert.equal(isCloudFileId(null), false);
  assert.equal(isCloudFileId(undefined), false);
});

test('image:orderDishImages 云端图在前、静态图在后(各自保持原相对顺序)', () => {
  const out = orderDishImages([STATIC_A, CLOUD_A, STATIC_B, CLOUD_B]);
  assert.deepEqual(out, [CLOUD_A, CLOUD_B, STATIC_A, STATIC_B]);
});

test('image:orderDishImages 仅静态图时原样返回(内置占位图兜底)', () => {
  assert.deepEqual(orderDishImages([STATIC_A]), [STATIC_A]);
});

test('image:orderDishImages 仅云端图时原样返回(用户上传图置顶)', () => {
  assert.deepEqual(orderDishImages([CLOUD_A, CLOUD_B]), [CLOUD_A, CLOUD_B]);
});

test('image:orderDishImages 空值/非数组容错', () => {
  assert.deepEqual(orderDishImages([]), []);
  assert.deepEqual(orderDishImages(null), []);
  assert.deepEqual(orderDishImages(undefined), []);
  assert.deepEqual(orderDishImages(['', STATIC_A]), [STATIC_A]);
});
