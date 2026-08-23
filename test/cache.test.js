/**
 * test/cache.test.js
 * utils/queryCache.js 的单元测试(node --test)
 * 运行:node --test
 * 覆盖:命中 / 未命中 / 过期 / 默认 TTL / markDirty 清全量 / invalidate 前缀失效 / 数组浅拷贝防污染
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { QueryCache } = require('../utils/queryCache.js');

test('TTL 缓存:写入后命中,返回缓存值', () => {
  const cache = new QueryCache();
  const key = cache.keyOf(['listIngredients', '']);
  cache.set(key, [{ name: '西红柿' }], 30 * 1000);
  assert.deepEqual(cache.get(key), [{ name: '西红柿' }]);
});

test('TTL 缓存:未写入的键返回 undefined', () => {
  const cache = new QueryCache();
  assert.equal(cache.get(cache.keyOf(['miss'])), undefined);
});

test('TTL 缓存:过期后自动失效(注入时钟)', () => {
  let now = 1000;
  const cache = new QueryCache({ now: () => now });
  const key = cache.keyOf(['searchByIngredients', ['西红柿'], 'partial']);
  cache.set(key, ['西红柿炒鸡蛋'], 30);
  assert.deepEqual(cache.get(key), ['西红柿炒鸡蛋']);
  now += 29; // 未到期
  assert.deepEqual(cache.get(key), ['西红柿炒鸡蛋']);
  now += 2; // 超过 30ms
  assert.equal(cache.get(key), undefined);
});

test('TTL 缓存:默认 TTL 为 5 分钟', () => {
  let now = 0;
  const cache = new QueryCache({ now: () => now });
  const key = cache.keyOf(['defaultTtl']);
  cache.set(key, 'v');
  now += 5 * 60 * 1000 - 1;
  assert.equal(cache.get(key), 'v');
  now += 2; // 超过 expireAt
  assert.equal(cache.get(key), undefined);
});

test('TTL 缓存:markDirty 清空全部缓存', () => {
  const cache = new QueryCache();
  cache.set(cache.keyOf(['a']), 1, 60 * 1000);
  cache.set(cache.keyOf(['b']), 2, 60 * 1000);
  cache.markDirty();
  assert.equal(cache.get(cache.keyOf(['a'])), undefined);
  assert.equal(cache.get(cache.keyOf(['b'])), undefined);
});

test('TTL 缓存:invalidate 按前缀失效指定键,其余保留', () => {
  const cache = new QueryCache();
  const k1 = cache.keyOf(['getDish', 'id-1']);
  const k2 = cache.keyOf(['getDish', 'id-2']);
  const k3 = cache.keyOf(['listIngredients', '']);
  cache.set(k1, 1, 60 * 1000);
  cache.set(k2, 2, 60 * 1000);
  cache.set(k3, 3, 60 * 1000);
  cache.invalidate('["getDish","id-1');
  assert.equal(cache.get(k1), undefined);
  assert.equal(cache.get(k2), 2);
  assert.equal(cache.get(k3), 3);
});

test('TTL 缓存:数组返回浅拷贝,防止调用方修改污染缓存', () => {
  const cache = new QueryCache();
  const key = cache.keyOf(['arr']);
  cache.set(key, [{ a: 1 }], 60 * 1000);
  const first = cache.get(key);
  first.push({ a: 2 });
  assert.deepEqual(cache.get(key), [{ a: 1 }]);
});
