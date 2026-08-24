/**
 * test/consistency.test.js
 * 数据层一致性验收(node --test)
 * 运行:node --test
 * 覆盖:双层缓存语义(写后 markDirty 失效、缓存命中不打库、删除同步)、
 *      内置公共图保护、matchDishesByIngredients 纯函数匹配
 * 说明:api/db.js 内部仅在函数内引用 wx,node 下以 global.wx 替身(mock wx.cloud 数据库 + wx.Storage)
 *      wiring 被测模块,断言真实数据库读写行为。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../api/db.js');
const { matchDishesByIngredients } = db;
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
 * 构造 wx 替身:mock wx.cloud 数据库,返回 { counters } 供断言查询次数。
 * @param {object} initialData 初始集合数据 { dishes: [...], ingredients: [...], records: [...], app_meta: [...] }
 */
function setupMockWx(initialData = {}) {
  // ---- wx.cloud 数据库 ----
  const collections = {};
  for (const [name, docs] of Object.entries(initialData)) {
    collections[name] = new Map(docs.map((d) => [d._id, JSON.parse(JSON.stringify(d))]));
  }
  const counters = { reads: 0, addCount: 0, deletedFileList: [] };
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

  // ---- wx.Storage(双层缓存 L2 层):每次环境重建即全新,避免用例间缓存串扰 ----
  const storage = new Map();
  global.wx = {
    cloud: {
      database() {
        return {
          collection: colApi,
          command,
          serverDate,
          RegExp: (opts) => ({ $regexp: opts.regexp, $options: opts.options }),
        };
      },
      deleteFile: async ({ fileList }) => {
        // 记录每次删除的 fileID,供断言「内置公共图不被删」
        counters.deletedFileList.push(...(fileList || []));
        return { fileList, deleted: fileList.length };
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
  return { counters, storage };
}

/** 快速重置:new mock 环境 + 清空 L1 queryCache 单例,返回 counters
 *  (每个用例开头调用,保证 wx 已就位且两层缓存无串扰) */
function freshEnv(initialData) {
  queryCache.markDirty(); // L1 内存缓存是模块级单例,用例间必须清空防串扰
  return setupMockWx(initialData);
}

/* ---------------- 用例 ---------------- */

test('一致性:saveDish 新增后 listDishes 立即能查到新菜(markDirty 后走 L3)', async () => {
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

test('缓存:写后读缓存已失效,listDishes 走 L3 拿最新(本机写后立读最新)', async () => {
  const mock = freshEnv();
  await db.saveDish({ name: '蛋炒饭', category: 'meal', ingredients: [{ name: '鸡蛋' }, { name: '米饭' }] });
  const readsAfterSave = mock.counters.reads;
  await db.listDishes({});
  // saveDish 成功后 markDirty 两层,listDishes 缓存未命中必然走 L3,拿到的必然是最新数据
  assert.ok(mock.counters.reads > readsAfterSave, '写后缓存失效,listDishes 应重新打库取最新');
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

test('一致性:removeDish 只删用户云图,内置公共图(映射内)保留', async () => {
  const builtinFileId = 'cloud://builtin/红烧肉.jpg';
  const userFileId = 'cloud://user/upload-1.jpg';
  const mock = freshEnv({
    // 注入 app_meta builtin_images 映射(与真实环境一致:内置图公共资产挂在映射上)
    app_meta: [{ _id: 'builtin_images', map: { 红烧肉: builtinFileId } }],
  });
  const saved = await db.saveDish({
    name: '红烧肉',
    category: 'meal',
    isBuiltin: true,
    images: [builtinFileId, userFileId],
  });
  await db.removeDish(saved._id);
  // 只把用户上传的云图传给 deleteFile,内置公共图(映射值)不被删除
  assert.deepEqual(mock.counters.deletedFileList, [userFileId]);
});

test('一致性:removeDish 无内置图映射(loadBuiltinImageMap 返回 null)时降级全删云图', async () => {
  const mock = freshEnv(); // 无 app_meta 文档 → loadBuiltinImageMap try/catch 返回 null
  const saved = await db.saveDish({
    name: '红烧肉',
    category: 'meal',
    isBuiltin: true,
    images: ['cloud://builtin/红烧肉.jpg'],
  });
  await db.removeDish(saved._id);
  // 保守降级:拿不到映射时按原逻辑全删,保证删菜功能不被云库抖动阻断
  assert.deepEqual(mock.counters.deletedFileList, ['cloud://builtin/红烧肉.jpg']);
});

test('一致性:addCookRecord 后 todayRecords 立即可见', async () => {
  freshEnv();
  const saved = await db.saveDish({ name: '麻婆豆腐', category: 'meal', ingredients: [{ name: '豆腐' }] });
  const record = await db.addCookRecord(saved._id);
  assert.ok(record._id);
  const list = await db.todayRecords();
  assert.equal(list.length, 1);
  assert.equal(list[0].dishName, '麻婆豆腐');
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

test('一致性:ensureIngredient 独立调用后 listIngredients 立即可见', async () => {
  freshEnv();
  const res = await db.ensureIngredient('紫苏');
  assert.equal(res.isNew, true);
  const list = await db.listIngredients('紫苏');
  assert.ok(list.some((d) => d.name === '紫苏'));
});

/* ---------------- matchDishesByIngredients 纯函数 ---------------- */

/** 构造测试菜品(只带匹配所需的 name / ingredientNames) */
function dish(name, ingredientNames) {
  return { _id: name, name, ingredientNames };
}

test('match:partial 交集匹配,返回有交集的菜并带 matchScore(命中数/菜品原料总数)', () => {
  const all = [
    dish('西红柿炒鸡蛋', ['西红柿', '鸡蛋']),
    dish('西红柿蛋汤', ['西红柿', '鸡蛋', '清水']),
    dish('青椒肉丝', ['青椒', '猪肉']),
  ];
  const matched = matchDishesByIngredients(all, ['西红柿', '鸡蛋'], { mode: 'partial' });
  assert.deepEqual(
    matched.map((d) => d.name),
    ['西红柿炒鸡蛋', '西红柿蛋汤'],
  );
  assert.equal(matched[0].matchScore, 1); // 2/2
  assert.equal(matched[1].matchScore, 2 / 3);
});

test('match:partial 按匹配度降序排序,同分按菜名拼音', () => {
  const all = [
    dish('三菜', ['a', 'b', 'c']),
    dish('一菜', ['a']),
    dish('二菜', ['a']),
  ];
  const matched = matchDishesByIngredients(all, ['a'], { mode: 'partial' });
  // 二菜 1/1、一菜 1/1 同分按拼音(二菜 er < 一菜 yi)在前;三菜 1/3 最后
  assert.deepEqual(
    matched.map((d) => d.name),
    ['二菜', '一菜', '三菜'],
  );
  assert.deepEqual(matched.map((d) => d.matchScore), [1, 1, 1 / 3]);
});

test('match:complete 完全匹配,仅返回全部原料都在所选范围内的菜(子集)', () => {
  const all = [
    dish('西红柿炒鸡蛋', ['西红柿', '鸡蛋']),
    dish('西红柿蛋汤', ['西红柿', '鸡蛋', '清水']),
  ];
  const matched = matchDishesByIngredients(all, ['西红柿', '鸡蛋'], { mode: 'complete' });
  // 「就用这些料做」:所选范围内能完整覆盖的只有 西红柿炒鸡蛋(蛋汤还差清水)
  assert.deepEqual(
    matched.map((d) => d.name),
    ['西红柿炒鸡蛋'],
  );
});

test('match:空输入 / 空数据返回空数组,不抛错', () => {
  const one = [dish('菜', ['西红柿'])];
  assert.deepEqual(matchDishesByIngredients([], ['西红柿'], { mode: 'partial' }), []);
  assert.deepEqual(matchDishesByIngredients(one, [], { mode: 'partial' }), []);
  assert.deepEqual(matchDishesByIngredients(null, ['西红柿'], { mode: 'partial' }), []);
  // 已选原料名未归一化时同样命中(内部归一化)
  assert.deepEqual(matchDishesByIngredients(one, [' 西红柿 '], { mode: 'partial' })[0].name, '菜');
});
