/**
 * test/db-cache.test.js
 * 双层缓存数据层验收(node --test)
 * 运行:node --test
 * 覆盖:force 穿透(L2 有旧值也走 L3 并回填两层)、非 force 命中 L2(不打库)、
 *      写操作后 markDirty 使缓存失效(再次读取走 L3 拿最新)
 * 说明:mock wx.cloud(内存云库)+ wx.Storage 替身,每次用例 freshEnv 重置云库/存储
 *      并清空 L1 queryCache 单例,保证用例间无缓存串扰。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../api/db.js');
const storageCache = require('../utils/storageCache.js');
const { queryCache } = require('../utils/queryCache.js');

/* ---------------- mock 工具 ---------------- */

/** 字段值匹配:普通值相等、$set 展开;数组字段按包含处理 */
function matchField(actual, expected) {
  if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) {
    if (expected.$set !== undefined) return matchField(actual, expected.$set);
    return false;
  }
  if (Array.isArray(actual)) return actual.includes(expected);
  return actual === expected;
}

/** 文档级 where 匹配(本文件只用到普通值条件) */
function matchCond(doc, cond) {
  if (!cond || typeof cond !== 'object') return true;
  return Object.keys(cond).every((field) => matchField(doc[field], cond[field]));
}

/**
 * 构造 wx 替身:mock wx.cloud 数据库 + wx.Storage。
 * @param {object} initialData 初始集合数据 { dishes: [...], ingredients: [...] }
 * @returns {{counters, collections, storage}} counters.reads 供断言打库次数;collections 供直接改云库
 */
function setupMockWx(initialData = {}) {
  // ---- wx.cloud 数据库 ----
  const collections = {};
  for (const [name, docs] of Object.entries(initialData)) {
    collections[name] = new Map(docs.map((d) => [d._id, JSON.parse(JSON.stringify(d))]));
  }
  const counters = { reads: 0 };
  let idSeq = 1;
  const command = { set: (v) => ({ $set: v }) };

  const makeQuery = (colMap, cond) => {
    const matched = () => Array.from(colMap.values()).filter((doc) => matchCond(doc, cond));
    let skipN = 0;
    let limitN = Infinity;
    const q = {
      skip(n) {
        skipN = n;
        return q;
      },
      limit(n) {
        limitN = n;
        return q;
      },
      async get() {
        const list = matched();
        counters.reads += 1;
        return { data: list.slice(skipN, skipN + limitN) };
      },
    };
    return q;
  };

  const colApi = (name) => {
    const colMap = collections[name] || (collections[name] = new Map());
    return {
      where: (cond) => makeQuery(colMap, cond),
      async add({ data }) {
        const _id = data._id || `auto-${idSeq++}`;
        colMap.set(_id, { _id, ...JSON.parse(JSON.stringify(data)) });
        return { _id };
      },
    };
  };

  // ---- wx.Storage(双层缓存 L2 层) ----
  const storage = new Map();

  global.wx = {
    cloud: {
      database() {
        return {
          collection: colApi,
          command,
          serverDate: () => new Date(2026, 7, 23, 12, 0, idSeq),
          RegExp: (opts) => ({ $regexp: opts.regexp, $options: opts.options }),
        };
      },
    },
    getStorageSync(key) {
      const raw = storage.get(key);
      return raw === undefined ? '' : raw;
    },
    setStorageSync(key, value) {
      storage.set(key, JSON.parse(JSON.stringify(value)));
    },
    removeStorageSync(key) {
      storage.delete(key);
    },
    getStorageInfoSync() {
      return { keys: Array.from(storage.keys()) };
    },
  };
  return { counters, collections, storage };
}

/** 快速重置:new mock 环境 + 清空 L1 queryCache 单例(每个用例开头调用) */
function freshEnv(initialData) {
  queryCache.markDirty(); // L1 内存缓存是模块级单例,用例间必须清空防串扰
  return setupMockWx(initialData);
}

/* ---------------- 用例 ---------------- */

test('缓存:force 穿透(L2 有旧值也走 L3,并回填两层)', async () => {
  const mock = freshEnv();
  // 云库已有新数据
  await db.saveDish({ name: '云库新菜', category: 'meal', ingredients: [{ name: '西红柿' }] });
  // L2 预置旧值(模拟另一设备改库前,本机 L2 缓存里还是旧列表)
  storageCache.set('dishes', [{ _id: 'old-1', name: '旧缓存菜', category: 'meal' }]);
  const readsBefore = mock.counters.reads;

  const res = await db.listDishes({ force: true });
  assert.equal(res.total, 1);
  assert.equal(res.list[0].name, '云库新菜');
  assert.ok(mock.counters.reads > readsBefore, 'force 应绕过 L2 直查云库');

  // L2 已回填为云库最新
  const l2 = storageCache.get('dishes', 5 * 60 * 1000);
  assert.equal(l2.length, 1);
  assert.equal(l2[0].name, '云库新菜');

  // L1 也已回填:再次非 force 读命中 L1,不再打库
  const readsAfter = mock.counters.reads;
  const res2 = await db.listDishes({});
  assert.equal(res2.total, 1);
  assert.equal(res2.list[0].name, '云库新菜');
  assert.equal(mock.counters.reads, readsAfter, 'force 回填后非 force 读应命中缓存');
});

test('缓存:非 force 命中 L2(不访问云库,并回填 L1)', async () => {
  const mock = freshEnv();
  // 云库数据与 L2 缓存数据不同(模拟另一设备已改库,本机 L2 未同步)
  await db.saveDish({ name: '云库新菜', category: 'meal', ingredients: [{ name: '西红柿' }] });
  storageCache.set('dishes', [{ _id: 'old-1', name: '旧缓存菜', category: 'meal' }]);
  const readsBefore = mock.counters.reads;

  const res = await db.listDishes({});
  // 非 force:L1 未命中 → L2 命中,直接返回缓存不访问云库
  assert.equal(res.total, 1);
  assert.equal(res.list[0].name, '旧缓存菜');
  assert.equal(mock.counters.reads, readsBefore, 'L2 命中不应打库');

  // L1 已回填:再读一次仍不打库
  await db.listDishes({});
  assert.equal(mock.counters.reads, readsBefore, 'L1 回填后非 force 读仍命中缓存');
});

test('缓存:写操作后 markDirty 使缓存失效,再次读取走 L3 拿最新', async () => {
  const mock = freshEnv();
  await db.saveDish({ name: '旧菜', category: 'meal', ingredients: [{ name: '西红柿' }] });
  await db.listDishes({}); // 预热:读一次回填 L1 + L2
  assert.ok(storageCache.get('dishes', 5 * 60 * 1000), '预热后 L2 应有 dishes 缓存');

  // 模拟另一设备直接改云库加菜(本机缓存未同步)
  mock.collections.dishes.set('new-1', { _id: 'new-1', name: '另一设备新菜', category: 'meal' });
  // 本机写操作(saveDish 新增)成功后 markDirty 两层
  await db.saveDish({ name: '本机新菜', category: 'meal', ingredients: [{ name: '土豆' }] });
  // L2 dishes 键已被 markDirty 删除
  assert.equal(storageCache.get('dishes', 5 * 60 * 1000), null, '写操作后 L2 缓存应被清除');

  const readsAfterWrite = mock.counters.reads;
  const res = await db.listDishes({});
  // 缓存失效 → 走 L3:既能看到本机新菜,也能看到另一设备的新菜
  assert.ok(mock.counters.reads > readsAfterWrite, 'markDirty 后 listDishes 应走 L3 而非命中缓存');
  const names = res.list.map((d) => d.name);
  assert.ok(names.includes('本机新菜'));
  assert.ok(names.includes('另一设备新菜'));
});

test('缓存:ensureIngredient 写库后 listIngredients 缓存失效拿最新', async () => {
  const mock = freshEnv();
  await db.ensureIngredient('西红柿');
  await db.listIngredients(''); // 预热 ingredients 缓存
  assert.ok(storageCache.get('ingredients', 5 * 60 * 1000), '预热后 L2 应有 ingredients 缓存');

  // 本机 ensureIngredient 新增原料(写库)→ markDirty 两层
  await db.ensureIngredient('紫苏');
  assert.equal(storageCache.get('ingredients', 5 * 60 * 1000), null, '写操作后 L2 缓存应被清除');

  const readsAfterWrite = mock.counters.reads;
  const list = await db.listIngredients('紫苏');
  assert.ok(mock.counters.reads > readsAfterWrite, '缓存失效后应走 L3');
  assert.ok(list.some((d) => d.name === '紫苏'));
});
