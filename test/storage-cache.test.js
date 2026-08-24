/**
 * test/storage-cache.test.js
 * 本地持久缓存(storageCache,双层缓存 L2)单元测试(node --test)
 * 运行:node --test
 * 覆盖:set/get 回环、TTL 过期/未过期命中、remove、clearAll、removeByPrefix、异常降级、浅拷贝防污染
 * 说明:storageCache 内部仅在函数内引用 wx,node 下以 global.wx 替身
 *      (in-memory Map 模拟序列化往返)注入。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const storageCache = require('../utils/storageCache.js');

/** 构造 wx.Storage 替身:in-memory Map 模拟序列化往返(与真机 wx.Storage 行为一致) */
function setupStorageMock() {
  const store = new Map();
  global.wx = {
    getStorageSync(key) {
      const raw = store.get(key);
      return raw === undefined ? '' : raw;
    },
    setStorageSync(key, value) {
      // 模拟 wx 序列化往返(存储层天然隔离对象引用)
      store.set(key, JSON.parse(JSON.stringify(value)));
    },
    removeStorageSync(key) {
      store.delete(key);
    },
    getStorageInfoSync() {
      return { keys: Array.from(store.keys()) };
    },
  };
  return store;
}

/* ---------------- 基础回环 ---------------- */

test('storageCache:set/get 回环,值格式为 {ts, data}', () => {
  setupStorageMock();
  const list = [{ _id: '1', name: '西红柿' }, { _id: '2', name: '鸡蛋' }];
  storageCache.set('dishes', list);
  const got = storageCache.get('dishes', 5 * 60 * 1000);
  assert.deepEqual(got, list);
  // 存储原始值是 {ts, data} 结构
  const raw = global.wx.getStorageSync('rmdc_dishes');
  assert.equal(typeof raw.ts, 'number');
  assert.deepEqual(raw.data, list);
});

test('storageCache:cacheKey 幂等补全 rmdc_ 前缀', () => {
  setupStorageMock();
  assert.equal(storageCache.cacheKey('dishes'), 'rmdc_dishes');
  assert.equal(storageCache.cacheKey('rmdc_dishes'), 'rmdc_dishes');
});

test('storageCache:get 返回浅拷贝,调用方排序/增删不污染持久缓存', () => {
  setupStorageMock();
  const list = [{ _id: '2', name: '鸡蛋' }, { _id: '1', name: '西红柿' }];
  storageCache.set('dishes', list);
  const got = storageCache.get('dishes', 5 * 60 * 1000);
  got.reverse(); // 调用方排序(数组级操作)
  got.push({ _id: '3', name: '土豆' }); // 调用方增删
  const again = storageCache.get('dishes', 5 * 60 * 1000);
  assert.deepEqual(again, list);
});

/* ---------------- TTL 过期 ---------------- */

test('storageCache:未过期命中(TTL 内返回数据)', () => {
  setupStorageMock();
  storageCache.set('dishes', [{ _id: '1', name: '菜' }]);
  assert.deepEqual(storageCache.get('dishes', 5 * 60 * 1000), [{ _id: '1', name: '菜' }]);
});

test('storageCache:过期返回 null(超过 TTL 后上层走云库)', () => {
  setupStorageMock();
  storageCache.set('dishes', [{ _id: '1', name: '菜' }]);
  // 直接把存储里的 ts 拨回 10 秒前,模拟写入已久(不依赖真实时钟)
  const raw = global.wx.getStorageSync('rmdc_dishes');
  global.wx.setStorageSync('rmdc_dishes', { ts: Date.now() - 10 * 1000, data: raw.data });
  assert.equal(storageCache.get('dishes', 5 * 1000), null);
});

test('storageCache:不传 ttlMs 时按默认 5 分钟判断,过期返回 null', () => {
  setupStorageMock();
  storageCache.set('ingredients', [{ _id: '1', name: '盐' }]);
  const raw = global.wx.getStorageSync('rmdc_ingredients');
  global.wx.setStorageSync('rmdc_ingredients', { ts: Date.now() - 10 * 60 * 1000, data: raw.data });
  assert.equal(storageCache.get('ingredients'), null); // 默认 5min,10 分钟前写入已过期
});

/* ---------------- remove / clearAll / removeByPrefix ---------------- */

test('storageCache:remove 删除指定键后 get 返回 null', () => {
  setupStorageMock();
  storageCache.set('dishes', [{ _id: '1', name: '菜' }]);
  storageCache.remove('dishes');
  assert.equal(storageCache.get('dishes', 5 * 60 * 1000), null);
});

test('storageCache:clearAll 只清 rmdc_ 前缀键,不动用户其他键', () => {
  setupStorageMock();
  global.wx.setStorageSync('rmdc_dishes', { ts: Date.now(), data: [] });
  global.wx.setStorageSync('rmdc_records:2026-08-23', { ts: Date.now(), data: [] });
  global.wx.setStorageSync('userKey', { hello: 'world' }); // 用户手动写入的键
  storageCache.clearAll();
  assert.equal(global.wx.getStorageSync('rmdc_dishes'), '');
  assert.equal(global.wx.getStorageSync('rmdc_records:2026-08-23'), '');
  assert.deepEqual(global.wx.getStorageSync('userKey'), { hello: 'world' });
});

test('storageCache:removeByPrefix 删除前缀匹配键,保留 exceptKey 与其他键', () => {
  setupStorageMock();
  global.wx.setStorageSync('rmdc_records:2026-08-22', { ts: Date.now(), data: [] });
  global.wx.setStorageSync('rmdc_records:2026-08-23', { ts: Date.now(), data: [] });
  global.wx.setStorageSync('rmdc_dishes', { ts: Date.now(), data: [] });
  global.wx.setStorageSync('userKey', 1);
  storageCache.removeByPrefix('rmdc_records:', 'rmdc_records:2026-08-23');
  assert.equal(global.wx.getStorageSync('rmdc_records:2026-08-22'), ''); // 旧日期键被清
  assert.ok(global.wx.getStorageSync('rmdc_records:2026-08-23')); // exceptKey 保留
  assert.ok(global.wx.getStorageSync('rmdc_dishes')); // 非 records 前缀不动
  assert.equal(global.wx.getStorageSync('userKey'), 1);
});

/* ---------------- 异常降级 ---------------- */

test('storageCache:getStorageSync 抛错时 get 静默返回 null,不抛出', () => {
  setupStorageMock();
  global.wx.getStorageSync = () => {
    throw new Error('storage 不可用');
  };
  assert.equal(storageCache.get('dishes', 5 * 60 * 1000), null);
});

test('storageCache:setStorageSync 抛错(如 10MB 超限)时 set 静默降级,不抛出', () => {
  setupStorageMock();
  global.wx.setStorageSync = () => {
    throw new Error('exceed storage limit');
  };
  storageCache.set('dishes', [{ _id: '1', name: '菜' }]); // 不应抛
  assert.equal(storageCache.get('dishes', 5 * 60 * 1000), null); // 无缓存,走 L3
});

test('storageCache:JSON 损坏 / 历史旧格式({items,syncTs})时 get 返回 null 自愈', () => {
  setupStorageMock();
  global.wx.setStorageSync('rmdc_dishes', 'not-json{{{');
  assert.equal(storageCache.get('dishes', 5 * 60 * 1000), null);
  // 历史 F3 时代的旧格式 {items, syncTs}(无 data 字段)→ 按未命中处理
  global.wx.setStorageSync('rmdc_dishes', { items: [{ _id: '1' }], syncTs: Date.now() });
  assert.equal(storageCache.get('dishes', 5 * 60 * 1000), null);
});

test('storageCache:getStorageInfoSync 抛错时 clearAll/removeByPrefix 静默降级', () => {
  setupStorageMock();
  global.wx.getStorageInfoSync = () => {
    throw new Error('info 不可用');
  };
  storageCache.clearAll(); // 不应抛
  storageCache.removeByPrefix('rmdc_records:', 'rmdc_records:2026-08-23'); // 不应抛
});
