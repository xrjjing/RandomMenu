/**
 * test/upcoming.test.js
 * F25 提前定菜数据层验收(node --test)
 * 覆盖:addCookRecord 非法 date 兜底今天 / 合法 date 正常落库、
 *      groupByDate 分组(跨组/组内倒序/忽略组外日期/空输入)、
 *      upcomingRecords 三分组 + 组外日期忽略 + 空组 + 未分配池 '' 条件。
 * 运行:node --test
 * mock 方式与 test/db-cache.test.js 同款:内存云库 + 每次 freshEnv 重置。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../api/db.js');
const { queryCache } = require('../utils/queryCache.js');

/* ---------------- mock 工具 ---------------- */

/** 字段值匹配:普通值相等(本文件只用到普通值条件) */
function matchCond(doc, cond) {
  if (!cond || typeof cond !== 'object') return true;
  return Object.keys(cond).every((field) => doc[field] === cond[field]);
}

/**
 * 构造 wx 替身:mock wx.cloud 数据库(add + where 查询足够)。
 * @param {object} initialData 初始集合数据
 * @returns {{collections: object}} collections 供直接查看云库内容
 */
function setupMockWx(initialData = {}) {
  const collections = {};
  Object.entries(initialData).forEach(([name, docs]) => {
    collections[name] = new Map(
      docs.map((d) => [d._id, JSON.parse(JSON.stringify(d))]),
    );
  });
  let idSeq = 1;
  const makeQuery = (colMap, cond) => {
    const q = {
      orderBy() {
        return q;
      },
      skip() {
        return q;
      },
      limit() {
        return q;
      },
      async get() {
        return { data: Array.from(colMap.values()).filter((doc) => matchCond(doc, cond)) };
      },
    };
    return q;
  };
  const colApi = (name) => {
    const colMap = collections[name] || (collections[name] = new Map());
    return {
      where: (cond) => makeQuery(colMap, cond),
      async add({ data }) {
        const _id = data._id || `auto-${idSeq}`;
        idSeq += 1;
        colMap.set(_id, { _id, ...JSON.parse(JSON.stringify(data)) });
        return { _id };
      },
    };
  };
  global.wx = {
    cloud: {
      database() {
        return {
          collection: colApi,
          serverDate: () => new Date(2026, 7, 23, 12, 0, idSeq),
        };
      },
    },
    getStorageSync: () => '',
    setStorageSync: () => {},
    removeStorageSync: () => {},
  };
  return { collections };
}

/** 快速重置:new mock 环境 + 清空 L1 queryCache 单例 */
function freshEnv(initialData) {
  queryCache.markDirty();
  return setupMockWx(initialData);
}

/** 落一条最小菜品(供 addCookRecord 取快照) */
async function seedDish(name) {
  await db.saveDish({ name, category: 'meal', ingredients: [{ name: '西红柿' }] });
  const { list } = await db.listDishes({ force: true });
  return list[0]._id;
}

/* ---------------- addCookRecord date 兜底 ---------------- */

test('addCookRecord:非法 date(abc / 2026-13-99 / null)兜底今天', async () => {
  const mock = freshEnv();
  const dishId = await seedDish('西红柿炒蛋');
  const today = db.dateKey();
  const badDates = ['abc', '2026-13-99', null];
  // 顺序落三条非法 date(避免 for-of+await),逐条断言回退今天
  for (let i = 0; i < badDates.length; i += 1) {
    const badDate = badDates[i];
    const rec = await db.addCookRecord(dishId, '', badDate); // eslint-disable-line no-await-in-loop
    assert.equal(rec.date, today, `非法 date=${badDate} 应回退今天`);
  }
  // 云库侧确认三条都是今天
  const docs = Array.from(mock.collections.records.values());
  assert.equal(docs.length, 3);
  assert.ok(docs.every((d) => d.date === today));
});

test('addCookRecord:合法 date(2026-12-31)正常落库', async () => {
  const mock = freshEnv();
  const dishId = await seedDish('红烧肉');
  const rec = await db.addCookRecord(dishId, '', '2026-12-31');
  assert.equal(rec.date, '2026-12-31');
  assert.equal(Array.from(mock.collections.records.values())[0].date, '2026-12-31');
});

test('addCookRecord:省略 date 参数默认今天(向后兼容)', async () => {
  const fresh = freshEnv();
  const dishId = await seedDish('麻婆豆腐');
  const rec = await db.addCookRecord(dishId, 'fam-1');
  assert.equal(rec.date, db.dateKey());
  assert.equal(rec.familyId, 'fam-1');
});

/* ---------------- groupByDate 纯函数 ---------------- */

test('groupByDate:跨组分组 + 组内 createdAt 倒序 + 忽略组外日期', () => {
  const rec = (id, date, createdAt) => ({ _id: id, date, createdAt });
  const records = [
    rec('a1', '2026-09-01', '2026-09-01T08:00:00'),
    rec('a2', '2026-09-01', '2026-09-01T10:00:00'), // 同组更晚 → 排前面
    rec('b1', '2026-09-02', '2026-09-02T09:00:00'),
    rec('x1', '2026-08-01', '2026-08-01T09:00:00'), // 组外日期,应被忽略
  ];
  const groups = db.groupByDate(records, ['2026-09-01', '2026-09-02']);
  assert.deepEqual(
    groups['2026-09-01'].map((r) => r._id),
    ['a2', 'a1'],
  );
  assert.deepEqual(
    groups['2026-09-02'].map((r) => r._id),
    ['b1'],
  );
});

test('groupByDate:空输入返回全空组(与 dates 对齐)', () => {
  const groups = db.groupByDate([], ['2026-09-01', '2026-09-02']);
  assert.deepEqual(groups, { '2026-09-01': [], '2026-09-02': [] });
});

/* ---------------- upcomingRecords ---------------- */

test('upcomingRecords:today/tomorrow/dayafter 三分组 + 组外日期忽略 + total', async () => {
  const fresh = freshEnv();
  const dishId = await seedDish('可乐鸡翅');
  // 用 dateKey(Date.now()+N*86400000) 取与实现一致的今天/明天/后天,天然跨月安全
  const d0 = db.dateKey(new Date());
  const d1 = db.dateKey(new Date(Date.now() + 1 * 86400000));
  const d2 = db.dateKey(new Date(Date.now() + 2 * 86400000));
  const mk = (id, date, createdAt) => ({
    _id: id,
    date,
    dishId,
    dishName: '可乐鸡翅',
    familyId: '',
    ingredientNames: [],
    createdAt,
  });
  fresh.collections.records = new Map(
    [
      mk('t1', d0, '2026-01-01T08:00:00'),
      mk('t2', d0, '2026-01-01T12:00:00'),
      mk('m1', d1, '2026-01-01T09:00:00'),
      mk('a1', d2, '2026-01-01T09:30:00'),
      mk('far', '2030-01-01', '2026-01-01T09:40:00'), // 组外日期,应被忽略
    ].map((d) => [d._id, d]),
  );

  const res = await db.upcomingRecords('');
  assert.deepEqual(
    res.today.map((r) => r._id),
    ['t2', 't1'],
  );
  assert.deepEqual(
    res.tomorrow.map((r) => r._id),
    ['m1'],
  );
  assert.deepEqual(
    res.dayafter.map((r) => r._id),
    ['a1'],
  );
  assert.equal(res.total, 4);
  // 组内保留 records 原始字段
  assert.equal(res.today[0].dishName, '可乐鸡翅');
  assert.equal(res.today[0].familyId, '');
  assert.ok(Array.isArray(res.today[0].ingredientNames));
});

test('upcomingRecords:空库返回三个空数组,total=0', async () => {
  freshEnv();
  const res = await db.upcomingRecords('fam-1');
  assert.deepEqual(res, { today: [], tomorrow: [], dayafter: [], total: 0 });
});
