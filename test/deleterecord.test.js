/**
 * test/deleterecord.test.js
 * F25 补充:deleteRecord 行级删除验收(node --test)
 * 覆盖:家庭匹配删成功 / 家庭不匹配拒绝(防跨家庭误删)/
 *      未分配池 '' 有效条件匹配 / 记录不存在返回 removed:false。
 * 运行:node --test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

/** wx mock:doc(id).get / doc(id).remove,store 供用例注入数据 */
function setupMockWx(store, removedIds) {
  global.wx = {
    cloud: {
      database: () => ({
        collection: () => ({
          doc: (id) => ({
            get: async () => ({ data: store.has(id) ? store.get(id) : null }),
            remove: async () => {
              if (!store.has(id)) throw new Error('document.get:fail document not exists');
              store.delete(id);
              removedIds.push(id);
              return {};
            },
          }),
        }),
      }),
    },
  };
}

const { deleteRecord } = require('../api/db.js');

/** 重新加载 db.js:让用例各自 mock 的 wx 在首次 require 前就绪(模块内不缓存 wx,仅需保证顺序) */
function loadDb() {
  return { deleteRecord };
}

test('deleteRecord: 家庭匹配时删单条成功', async () => {
  const store = new Map([['r1', { _id: 'r1', dishName: '八宝粥', familyId: 'fam1' }]]);
  const removedIds = [];
  setupMockWx(store, removedIds);
  const { deleteRecord } = loadDb();
  const res = await deleteRecord('r1', 'fam1');
  assert.strictEqual(res.removed, true);
  assert.deepStrictEqual(removedIds, ['r1']);
});

test('deleteRecord: 家庭不匹配时拒绝删除(防跨家庭误删)', async () => {
  const store = new Map([['r2', { _id: 'r2', dishName: '红烧肉', familyId: 'famB' }]]);
  const removedIds = [];
  setupMockWx(store, removedIds);
  const { deleteRecord } = loadDb();
  const res = await deleteRecord('r2', 'famA');
  assert.strictEqual(res.removed, false);
  assert.strictEqual(removedIds.length, 0);
});

test('deleteRecord: 未分配池 familyId="" 是有效条件,与快照 "" 匹配', async () => {
  const store = new Map([['r3', { _id: 'r3', dishName: '凉拌黄瓜', familyId: '' }]]);
  const removedIds = [];
  setupMockWx(store, removedIds);
  const { deleteRecord } = loadDb();
  const res = await deleteRecord('r3', '');
  assert.strictEqual(res.removed, true);
  assert.deepStrictEqual(removedIds, ['r3']);
});

test('deleteRecord: 记录不存在时返回 removed:false 不抛错', async () => {
  const store = new Map();
  const removedIds = [];
  setupMockWx(store, removedIds);
  const { deleteRecord } = loadDb();
  const res = await deleteRecord('ghost', 'fam1');
  assert.strictEqual(res.removed, false);
  assert.strictEqual(removedIds.length, 0);
});
