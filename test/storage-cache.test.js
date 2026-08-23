/**
 * test/storage-cache.test.js
 * utils/storageCache.js 的单元测试(node --test)
 * 运行:node --test
 * 覆盖:set/get/remove/clearAll 正常回环、前缀规范、JSON 损坏降级、storage 超限降级、数组防污染
 * 说明:wx.Storage 以 in-memory 替身注入(global.wx),storageCache 内部仅在函数内引用 wx,node 下可正常 import。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const storageCache = require('../utils/storageCache.js');

/**
 * 构造 wx.Storage 的 in-memory mock 替身(模拟序列化往返:Date→string、对象深拷贝)。
 * @param {object} [opts]
 * @param {boolean} [opts.setError] setStorageSync 抛错(模拟 10MB 超限)
 * @param {boolean} [opts.getError] getStorageSync 抛错
 * @param {string|null} [opts.corruptKey] 该键返回损坏 JSON
 * @returns {Map} 内存存储(测试可直查)
 */
function setupMockStorage({ setError = false, getError = false, corruptKey = null } = {}) {
  const mem = new Map();
  global.wx = {
    setStorageSync(key, value) {
      if (setError) throw new Error('storage limit exceeded');
      mem.set(key, JSON.parse(JSON.stringify(value)));
    },
    getStorageSync(key) {
      if (getError) throw new Error('storage get failed');
      if (corruptKey && key === corruptKey) return '{bad json!!';
      return mem.has(key) ? JSON.parse(JSON.stringify(mem.get(key))) : '';
    },
    removeStorageSync(key) {
      mem.delete(key);
    },
    getStorageInfoSync() {
      return { keys: Array.from(mem.keys()) };
    },
  };
  return mem;
}

/** 静默 console.error(降级用例会打印预期错误,避免污染测试输出) */
function silenceConsoleError(fn) {
  const orig = console.error;
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.error = orig;
  }
}

test('storageCache: set/get 正常回环,自动补 rmdc_ 前缀', () => {
  const mem = setupMockStorage();
  const items = [{ _id: '1', name: '西红柿' }, { _id: '2', name: '鸡蛋' }];
  storageCache.set('ingredients', items);
  assert.ok(mem.has('rmdc_ingredients'), 'storage 键应带 rmdc_ 前缀');
  assert.deepEqual(storageCache.get('ingredients'), items);
});

test('storageCache: get 未设置的键返回 undefined', () => {
  setupMockStorage();
  assert.equal(storageCache.get('dishes'), undefined);
  assert.equal(storageCache.get('rmdc_unknown'), undefined);
});

test('storageCache: 存储值格式为 { items, syncTs }', () => {
  const mem = setupMockStorage();
  storageCache.set('dishes', [{ _id: 'a' }]);
  const raw = mem.get('rmdc_dishes');
  assert.ok(Array.isArray(raw.items));
  assert.equal(raw.items.length, 1);
  assert.equal(typeof raw.syncTs, 'number');
});

test('storageCache: cacheKey 幂等,传完整键与集合名等价', () => {
  setupMockStorage();
  storageCache.set('rmdc_ingredients', [{ name: '姜' }]);
  assert.deepEqual(storageCache.get('ingredients'), [{ name: '姜' }]);
  assert.deepEqual(storageCache.get('rmdc_ingredients'), [{ name: '姜' }]);
});

test('storageCache: 同键二次 set 覆盖旧值', () => {
  setupMockStorage();
  storageCache.set('dishes', [{ name: '旧菜' }]);
  storageCache.set('dishes', [{ name: '新菜' }, { name: '另一道' }]);
  assert.deepEqual(storageCache.get('dishes'), [{ name: '新菜' }, { name: '另一道' }]);
});

test('storageCache: remove 后 get 返回 undefined,其他键保留', () => {
  const mem = setupMockStorage();
  storageCache.set('dishes', [{ name: 'A' }]);
  storageCache.set('ingredients', [{ name: 'B' }]);
  storageCache.remove('dishes');
  assert.equal(storageCache.get('dishes'), undefined);
  assert.deepEqual(storageCache.get('ingredients'), [{ name: 'B' }]);
  assert.ok(!mem.has('rmdc_dishes'));
});

test('storageCache: clearAll 只清 rmdc_ 前缀键,用户其他键保留', () => {
  const mem = setupMockStorage();
  storageCache.set('dishes', []);
  storageCache.set('ingredients', []);
  mem.set('user_setting', { theme: 'dark' });
  storageCache.clearAll();
  assert.equal(storageCache.get('dishes'), undefined);
  assert.equal(storageCache.get('ingredients'), undefined);
  assert.ok(mem.has('user_setting'), '非 rmdc_ 前缀键不应被清除');
});

test('storageCache: JSON 损坏时 get 静默降级返回 undefined 不抛错', () => {
  const mem = setupMockStorage({ corruptKey: 'rmdc_dishes' });
  mem.set('rmdc_dishes', '{bad json!!');
  silenceConsoleError(() => {
    assert.equal(storageCache.get('dishes'), undefined);
  });
  // 损坏键不影响其他正常键
  storageCache.set('ingredients', [{ name: '土豆' }]);
  assert.deepEqual(storageCache.get('ingredients'), [{ name: '土豆' }]);
});

test('storageCache: setStorageSync 超限抛错时 set 不向外抛,业务可继续', () => {
  setupMockStorage({ setError: true });
  silenceConsoleError(() => {
    storageCache.set('dishes', [{ name: '大菜单' }]);
  });
  // 写入失败但调用不抛错;未损坏的其他键可正常读写
  assert.equal(storageCache.get('dishes'), undefined);
});

test('storageCache: getStorageSync 抛错时 get 静默降级返回 undefined', () => {
  setupMockStorage({ getError: true });
  silenceConsoleError(() => {
    assert.equal(storageCache.get('dishes'), undefined);
  });
});

test('storageCache: get 返回数组浅拷贝,修改返回结果不污染持久缓存', () => {
  setupMockStorage();
  storageCache.set('dishes', [{ _id: '1', name: '菜一' }]);
  const first = storageCache.get('dishes');
  first.push({ _id: '2', name: '菜二' });
  first[0].name = '被改';
  const second = storageCache.get('dishes');
  assert.equal(second.length, 1);
  assert.equal(second[0].name, '菜一');
});
