/**
 * test/consistency.test.js
 * 三层缓存一致性验收(node --test)
 * 运行:node --test
 * 覆盖:写后同步三层(saveDish 新增 → listDishes 立即可见)、删除同步、L2 回填与命中不再打库、
 *      初始化卫士(reimport=false 库已有数据抛「库中已有」)、ensureIngredient 独立同步
 * 说明:api/db.js 内部仅在函数内引用 wx,node 下以 global.wx 替身(mock wx.cloud 数据库 + wx.Storage)
 *      wiring 被测模块,断言真实缓存行为。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../api/db.js');
const seed = require('../api/seed.js');
const storageCache = require('../utils/storageCache.js');
const { queryCache } = require('../utils/queryCache.js');

/* ---------------- mock 工具 ---------------- */

/** 字段值匹配:普通值相等(数组字段=包含)、$in/$or/$and/$gte/$lte command 操作符 */
function matchField(actual, expected) {
  if (expected && typeof expected === 'object' && !(expected instanceof Date) && !Array.isArray(expected)) {
    if (Array.isArray(expected.$in)) {
      if (Array.isArray(actual)) return actual.some((x) => expected.$in.includes(x));
      return expected.$in.includes(actual);
    }
    if (Array.isArray(expected.$or)) return expected.$or.some((sub) => matchField(actual, sub));
    if (Array.isArray(expected.$and)) return expected.$and.every((sub) => matchField(actual, sub));
    if (expected.$gte !== undefined && expected.$lte !== undefined) {
      return actual >= expected.$gte && actual <= expected.$lte;
    }
    if (expected.$gte !== undefined) return actual >= expected.$gte;
    if (expected.$lte !== undefined) return actual <= expected.$lte;
    return false;
  }
  if (Array.isArray(actual)) return actual.includes(expected);
  return actual === expected;
}

/** 文档级 where 匹配 */
function matchCond(doc, cond) {
  if (!cond || typeof cond !== 'object') return true;
  return Object.keys(cond).every((field) => matchField(doc[field], cond[field]));
}

/**
 * 构造 wx 替身:mock wx.cloud 数据库 + wx.Storage,返回 { counters } 供断言查询次数。
 * @param {object} initialData 初始集合数据 { dishes: [...], ingredients: [...], records: [...], app_meta: [...] }
 */
function setupMockWx(initialData = {}) {
  // ---- wx.Storage ----
  const storageMap = new Map();
  const wxStorage = {
    setStorageSync: (k, v) => storageMap.set(k, JSON.parse(JSON.stringify(v))),
    getStorageSync: (k) => (storageMap.has(k) ? JSON.parse(JSON.stringify(storageMap.get(k))) : ''),
    removeStorageSync: (k) => storageMap.delete(k),
    getStorageInfoSync: () => ({ keys: Array.from(storageMap.keys()) }),
  };

  // ---- wx.cloud 数据库 ----
  const collections = {};
  for (const [name, docs] of Object.entries(initialData)) {
    collections[name] = new Map(docs.map((d) => [d._id, JSON.parse(JSON.stringify(d))]));
  }
  const counters = { reads: 0, addCount: 0 };
  let idSeq = 1;
  // serverDate 递增:保证 orderBy createdAt 倒序可稳定断言
  const serverDate = () => new Date(2026, 7, 23, 12, 0, idSeq);
  const command = {
    set: (v) => ({ $set: v }),
    in: (arr) => ({ $in: Array.isArray(arr) ? arr : [arr] }),
    or: (conds) => ({ $or: conds }),
    and: (conds) => ({ $and: conds }),
    gte: (v) => ({ $gte: v }),
    lte: (v) => ({ $lte: v }),
  };

  const makeQuery = (colMap, cond) => {
    const matched = () => Array.from(colMap.values()).filter((doc) => matchCond(doc, cond));
    let sortField = null;
    let sortDir = 'asc';
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
      orderBy(field, dir) {
        sortField = field;
        sortDir = dir;
        return q;
      },
      async get() {
        let list = matched();
        if (sortField) {
          list = list.slice().sort((a, b) => {
            const va = new Date(a[sortField]).getTime();
            const vb = new Date(b[sortField]).getTime();
            return sortDir === 'desc' ? vb - va : va - vb;
          });
        }
        counters.reads += 1;
        return { data: list.slice(skipN, skipN + limitN) };
      },
      async count() {
        return { total: matched().length };
      },
    };
    return q;
  };

  const docApi = (colMap, id) => ({
    async get() {
      const doc = colMap.get(id);
      if (!doc) {
        const err = new Error(`document.get:fail document with _id ${id} does not exist`);
        err.errMsg = err.message;
        throw err;
      }
      counters.reads += 1;
      return { data: JSON.parse(JSON.stringify(doc)) };
    },
    async update({ data }) {
      const doc = colMap.get(id);
      if (!doc) throw new Error(`document.update:fail document with _id ${id} does not exist`);
      Object.keys(data).forEach((k) => {
        const v = data[k];
        if (v && typeof v === 'object' && v.$set !== undefined) doc[k] = v.$set;
        else doc[k] = v;
      });
      return { stats: { updated: 1 } };
    },
    async remove() {
      const existed = colMap.delete(id);
      return { stats: { removed: existed ? 1 : 0 } };
    },
  });

  const colApi = (name) => {
    const colMap = collections[name] || (collections[name] = new Map());
    return {
      where: (cond) => makeQuery(colMap, cond),
      doc: (id) => docApi(colMap, id),
      async add({ data }) {
        if (data._id && colMap.has(data._id)) {
          const err = new Error('add:fail document already exist');
          err.errCode = -502001;
          throw err;
        }
        const _id = data._id || `auto-${idSeq++}`;
        const doc = { _id, ...JSON.parse(JSON.stringify(data)) };
        colMap.set(_id, doc);
        counters.addCount += 1;
        return { _id };
      },
    };
  };

  global.wx = {
    ...wxStorage,
    cloud: {
      database() {
        return {
          collection: colApi,
          command,
          serverDate,
          RegExp: (opts) => ({ $regexp: opts.regexp, $options: opts.options }),
        };
      },
      deleteFile: async ({ fileList }) => ({ fileList, deleted: fileList.length }),
    },
  };
  return { counters };
}

/** 快速重置:new mock 环境 + 清缓存,返回 counters(每个用例开头调用,保证 wx 已就位) */
function freshEnv(initialData) {
  const mock = setupMockWx(initialData);
  queryCache.markDirty();
  storageCache.clearAll();
  return mock;
}

/* ---------------- 用例 ---------------- */

test('一致性:saveDish 新增后 listDishes 立即能查到新菜(三层同步)', async () => {
  freshEnv();
  const saved = await db.saveDish({
    name: '西红柿炒鸡蛋',
    category: 'meal',
    tags: ['蛋类'],
    steps: ['打蛋', '下锅'],
    ingredients: [{ name: '西红柿' }, { name: '鸡蛋' }],
  });
  assert.ok(saved._id);
  const res = await db.listDishes({});
  assert.equal(res.total, 1);
  assert.equal(res.list[0].name, '西红柿炒鸡蛋');
});

test('一致性:saveDish 写库后 L2(storage)立即回填新菜', async () => {
  freshEnv();
  await db.saveDish({ name: '清炒土豆丝', category: 'meal', ingredients: [{ name: '土豆' }] });
  const cached = storageCache.get('dishes');
  assert.ok(Array.isArray(cached));
  assert.ok(cached.some((d) => d.name === '清炒土豆丝'));
  // 原料集合同样已回填(ensure 新增了原料)
  const ings = storageCache.get('ingredients');
  assert.ok(ings.some((d) => d.name === '土豆'));
});

test('一致性:写后读命中 L2,不再请求 L3(数据库读取计数不变)', async () => {
  const mock = freshEnv();
  await db.saveDish({ name: '蛋炒饭', category: 'meal', ingredients: [{ name: '鸡蛋' }, { name: '米饭' }] });
  const readsAfterSave = mock.counters.reads;
  const res = await db.listDishes({});
  assert.equal(res.total, 1);
  assert.equal(mock.counters.reads, readsAfterSave, 'listDishes 应从 L2 命中,不新增数据库读取');
});

test('一致性:removeDish 后 getDish 抛 not found,listDishes 不再包含', async () => {
  freshEnv();
  const saved = await db.saveDish({ name: '酸辣土豆丝', category: 'meal', ingredients: [{ name: '土豆' }] });
  const removed = await db.removeDish(saved._id);
  assert.equal(removed.removed, true);
  await assert.rejects(() => db.getDish(saved._id), /not exist/i);
  const res = await db.listDishes({});
  assert.equal(res.total, 0);
});

test('一致性:removeDish 后 L2 缓存同步为最新(不含被删菜)', async () => {
  freshEnv();
  const saved = await db.saveDish({ name: '糖醋里脊', category: 'meal', ingredients: [{ name: '里脊肉' }] });
  await db.removeDish(saved._id);
  const cached = storageCache.get('dishes');
  assert.ok(Array.isArray(cached));
  assert.equal(cached.some((d) => d._id === saved._id), false);
});

test('一致性:addCookRecord 后 todayRecords 立即可见,L2 已回填', async () => {
  freshEnv();
  const saved = await db.saveDish({ name: '麻婆豆腐', category: 'meal', ingredients: [{ name: '豆腐' }] });
  const record = await db.addCookRecord(saved._id);
  assert.ok(record._id);
  const list = await db.todayRecords();
  assert.equal(list.length, 1);
  assert.equal(list[0].dishName, '麻婆豆腐');
  const cached = storageCache.get(`records:${db.dateKey()}`);
  assert.ok(Array.isArray(cached) && cached.length === 1);
});

test('一致性:undoLastTodayRecord 撤销后 todayRecords 立即更新', async () => {
  freshEnv();
  const saved = await db.saveDish({ name: '回锅肉', category: 'meal', ingredients: [{ name: '五花肉' }] });
  await db.addCookRecord(saved._id);
  const undo = await db.undoLastTodayRecord();
  assert.equal(undo.removed, true);
  const list = await db.todayRecords();
  assert.equal(list.length, 0);
});

test('一致性:ensureIngredient 独立调用后 listIngredients 立即可见(L2 已回填)', async () => {
  freshEnv();
  const res = await db.ensureIngredient('紫苏');
  assert.equal(res.isNew, true);
  const list = await db.listIngredients('紫苏');
  assert.ok(list.some((d) => d.name === '紫苏'));
  const cached = storageCache.get('ingredients');
  assert.ok(cached.some((d) => d.name === '紫苏'));
});

test('初始化卫士:库已有数据时 reimport=false 抛错含「库中已有」', async () => {
  freshEnv({
    dishes: [
      {
        _id: 'd1',
        name: '已有菜',
        category: 'meal',
        tags: [],
        steps: [],
        ingredientNames: [],
        updatedAt: new Date(2026, 7, 23),
      },
    ],
  });
  await assert.rejects(
    () => seed.importBuiltinData({ reimport: false }),
    (err) => err.message.includes('库中已有'),
  );
});

test('初始化卫士:库空时 reimport=false 正常导入,不误伤首次初始化', async () => {
  freshEnv();
  const res = await seed.importBuiltinData({ reimport: false });
  assert.equal(res.skipped, false);
  assert.equal(res.importedDishes, 80);
  // 导入完成后读取立即可见(库有 80 道)
  const dishes = await db.listDishes({});
  assert.equal(dishes.total, 80);
});
