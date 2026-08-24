/**
 * test/savedish.test.js
 * saveDish 写入形状集成测试(node --test)
 * 运行:node --test
 * 背景:用户怀疑保存丢数据,主代理用 /tmp/test-savedish.mjs 诊断脚本验证写入链路正确
 *      (mock wx.cloud 全链路)。本文件把该脚本固化为正式用例,防止以后重构 CRUD/缓存时回归。
 * 覆盖:新增分支(add 收到 12 字段纯值 payload)、编辑分支(update 各字段 _.set 包装 + updatedAt 原样)、
 *      云端应用 update 后的文档语义、getDish 读回、ensureIngredient 新原料写入形状。
 * 说明:wx mock 在 require('../api/db.js') 前通过 globalThis.wx 就位;where().get() 恒返回空,
 *      使 ensureIngredient 恒走新增分支、getDish 走单查兜底,便于精确断言写入形状。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

/* ---------------- mock 工具(结构同 /tmp/test-savedish.mjs,已跑通) ---------------- */

/** 写入调用记录:add / update 按集合收集,供断言 */
const calls = { add: [], update: [] };
/** 模拟集合文档存储:dishes / ingredients */
const store = new Map();
const ingStore = new Map();

/** command 代理:_.set(v) → { __cmd: 'set', v };其余操作符占位 */
const cmdHandler = {
  get(target, prop) {
    if (prop === 'set') return (v) => ({ __cmd: 'set', v });
    if (prop === 'and' || prop === 'gte' || prop === 'lte') return () => ({ __cmd: prop });
    return target[prop];
  },
};
const _ = new Proxy({}, cmdHandler);

/**
 * 构造集合 API:where 恒空(ensure 恒走新增分支)、add 写入 store、doc(id).update 模拟云端语义
 * (_.set 包裹的字段整体替换为纯值,纯值字段直接赋值)。
 */
function makeColl(collName, getStore) {
  return {
    where() {
      const chain = {
        limit: () => chain,
        skip: () => chain,
        orderBy: () => chain,
        get: async () => ({ data: [] }),
      };
      return chain;
    },
    add: async ({ data }) => {
      const id = 'doc_' + (getStore().size + 1);
      getStore().set(id, { _id: id, ...JSON.parse(JSON.stringify(data)) });
      calls.add.push({ coll: collName, id, data });
      return { _id: id };
    },
    doc: (id) => ({
      get: async () => ({ data: getStore().get(id) }),
      update: async ({ data }) => {
        calls.update.push({ coll: collName, id, data });
        const doc = getStore().get(id);
        if (!doc) return { stats: { updated: 0 } };
        Object.entries(data).forEach(([k, v]) => {
          doc[k] = v && v.__cmd === 'set' ? JSON.parse(JSON.stringify(v.v)) : v;
        });
        return { stats: { updated: 1 } };
      },
      remove: async () => {
        getStore().delete(id);
        return {};
      },
    }),
  };
}

/** wx 替身:wx.cloud 数据库 + wx.Storage 缓存空实现(双层缓存 L2 层直接 miss) */
globalThis.wx = {
  cloud: {
    database: () => ({
      command: _,
      serverDate: () => ({ __serverDate: true }),
      collection: (name) => makeColl(name, name === 'dishes' ? () => store : () => ingStore),
    }),
  },
  getStorageSync: () => null,
  setStorageSync() {},
  removeStorageSync() {},
  getStorageInfoSync: () => ({ keys: [] }),
};

/* 被测模块:wx mock 已就位后加载 */
const { saveDish, getDish, ensureIngredient } = require('../api/db.js');
const { queryCache } = require('../utils/queryCache.js');

/** 每用例重置:清空云库与调用记录 + 清空 L1 queryCache 单例(防用例间缓存串扰,见 F19) */
function resetMock() {
  store.clear();
  ingStore.clear();
  calls.add.length = 0;
  calls.update.length = 0;
  queryCache.markDirty();
}

/* ---------------- 用例 ---------------- */

test('新增分支:saveDish 全字段 payload → add 收到 12 字段纯值,关联字段与 ensure 结果一致', async () => {
  resetMock();
  const saved = await saveDish({
    name: '丝瓜炒蛋',
    category: 'meal',
    tags: ['家常菜'],
    cookTime: '15分钟',
    difficulty: '简单',
    images: ['cloud://test.1234/user/abc.jpg'],
    ingredients: [
      { name: '丝瓜', amount: '1根', isSeasoning: false },
      { name: '鸡蛋', amount: '2个', isSeasoning: false },
    ],
    steps: ['丝瓜去皮切片', '鸡蛋炒散', '合炒调味'],
  });
  const addCall = calls.add.find((c) => c.coll === 'dishes');
  assert.ok(addCall, '新增应有一次 dishes add');
  // 全字段 payload → add 收到 12 个字段:
  // name/category/tags/cookTime/difficulty/ingredientIds/ingredientNames/ingredients/steps/updatedAt/images/createdAt
  const keys = Object.keys(addCall.data).sort();
  assert.equal(keys.length, 12, 'add 应收到 12 个字段');
  assert.deepEqual(keys, [
    'category', 'cookTime', 'createdAt', 'difficulty', 'images', 'ingredientIds',
    'ingredientNames', 'ingredients', 'name', 'steps', 'tags', 'updatedAt',
  ]);
  // steps / images 为纯数组(无命令包装)——修复 1 根因:add 分支不能再带 command 对象
  assert.ok(Array.isArray(addCall.data.steps), 'steps 应为纯数组');
  assert.equal(addCall.data.steps.__cmd, undefined);
  assert.deepEqual(addCall.data.steps, ['丝瓜去皮切片', '鸡蛋炒散', '合炒调味']);
  assert.ok(Array.isArray(addCall.data.images), 'images 应为纯数组');
  assert.equal(addCall.data.images.__cmd, undefined);
  assert.deepEqual(addCall.data.images, ['cloud://test.1234/user/abc.jpg']);
  // 标量字段为纯值
  assert.equal(addCall.data.cookTime, '15分钟');
  assert.equal(addCall.data.difficulty, '简单');
  // updatedAt / createdAt 为 serverDate 原样
  assert.deepEqual(addCall.data.updatedAt, { __serverDate: true });
  assert.deepEqual(addCall.data.createdAt, { __serverDate: true });
  // ingredientIds / ingredientNames 与内部 ensure 的结果一致(按原料顺序)
  const ingAdds = calls.add.filter((c) => c.coll === 'ingredients');
  assert.equal(ingAdds.length, 2, '新增应 ensure 两个原料');
  assert.deepEqual(addCall.data.ingredientIds, ingAdds.map((c) => c.id));
  assert.deepEqual(addCall.data.ingredientNames, ingAdds.map((c) => c.data.name));
  // 原料明细带 ensure 回写的 id 与用量
  assert.equal(addCall.data.ingredients[0].id, ingAdds[0].id);
  assert.equal(addCall.data.ingredients[0].amount, '1根');
  assert.equal(addCall.data.ingredients[1].isSeasoning, false);
  // 返回值含新 id
  assert.equal(saved._id, addCall.id);
});

test('编辑分支:saveDish(id) → update 数组/标量字段均带 __cmd:set 包装,updatedAt 为 serverDate 原样', async () => {
  resetMock();
  // 先新增一道菜得到稳定 id(新增分支 ensure '丝瓜')
  const added = await saveDish({
    name: '丝瓜炒蛋',
    category: 'meal',
    cookTime: '15分钟',
    difficulty: '简单',
    ingredients: [{ name: '丝瓜', amount: '1根', isSeasoning: false }],
    steps: ['丝瓜去皮切片'],
  });
  // 编辑:原料带 id 跳过 ensure(信任既有原料)
  const saved = await saveDish({
    id: added._id,
    name: '丝瓜炒蛋',
    category: 'meal',
    tags: [],
    cookTime: '20分钟',
    difficulty: '中等',
    images: ['cloud://test.1234/user/abc.jpg'],
    ingredients: [{ id: 'i1', name: '丝瓜', amount: '2根', isSeasoning: false }],
    steps: ['去皮', '炒'],
  });
  const upd = calls.update.find((c) => c.coll === 'dishes' && c.id === added._id);
  assert.ok(upd, '编辑应有一次 dishes update');
  // 数组字段:_.set 整体替换包装
  assert.deepEqual(upd.data.steps, { __cmd: 'set', v: ['去皮', '炒'] });
  assert.deepEqual(upd.data.images, { __cmd: 'set', v: ['cloud://test.1234/user/abc.jpg'] });
  assert.deepEqual(upd.data.ingredients, {
    __cmd: 'set',
    v: [{ id: 'i1', name: '丝瓜', amount: '2根', isSeasoning: false }],
  });
  // 标量字段同样包装(现状断言即可)
  assert.deepEqual(upd.data.name, { __cmd: 'set', v: '丝瓜炒蛋' });
  assert.deepEqual(upd.data.category, { __cmd: 'set', v: 'meal' });
  assert.deepEqual(upd.data.cookTime, { __cmd: 'set', v: '20分钟' });
  assert.deepEqual(upd.data.difficulty, { __cmd: 'set', v: '中等' });
  // updatedAt 为 serverDate 原样(不包 _.set)
  assert.deepEqual(upd.data.updatedAt, { __serverDate: true });
  // 编辑带 id 的原料不应再触发 ingredients add
  assert.equal(calls.add.filter((c) => c.coll === 'ingredients').length, 1, '编辑不新增原料');
  // 返回值
  assert.equal(saved._id, added._id);
  assert.deepEqual(saved.steps, ['去皮', '炒']);
});

test('云端应用语义:update 应用后文档的 cookTime/difficulty/steps/images 为新值', async () => {
  resetMock();
  const added = await saveDish({
    name: '丝瓜炒蛋',
    category: 'meal',
    cookTime: '15分钟',
    difficulty: '简单',
    images: ['cloud://test.1234/user/1.jpg'],
    ingredients: [{ name: '丝瓜', isSeasoning: false }],
    steps: ['旧步骤'],
  });
  await saveDish({
    id: added._id,
    name: '丝瓜炒蛋',
    category: 'meal',
    cookTime: '20分钟',
    difficulty: '中等',
    images: ['cloud://test.1234/user/2.jpg'],
    ingredients: [{ id: 'i1', name: '丝瓜', isSeasoning: false }],
    steps: ['新步骤一', '新步骤二'],
  });
  // mock 端已模拟云端应用 update(doc.update 把 __cmd:'set' 展开为纯值写回 store)
  const doc = store.get(added._id);
  assert.equal(doc.cookTime, '20分钟');
  assert.equal(doc.difficulty, '中等');
  assert.deepEqual(doc.steps, ['新步骤一', '新步骤二']);
  assert.deepEqual(doc.images, ['cloud://test.1234/user/2.jpg']);
});

test('getDish 读回:update 后 getDish 返回的 steps 为新数组', async () => {
  resetMock();
  const added = await saveDish({
    name: '丝瓜炒蛋',
    category: 'meal',
    ingredients: [{ name: '丝瓜', isSeasoning: false }],
    steps: ['旧步骤'],
  });
  await saveDish({
    id: added._id,
    name: '丝瓜炒蛋',
    category: 'meal',
    ingredients: [{ id: 'i1', name: '丝瓜', isSeasoning: false }],
    steps: ['新步骤一', '新步骤二'],
  });
  const got = await getDish(added._id);
  assert.ok(Array.isArray(got.steps), 'getDish 的 steps 应为数组');
  assert.deepEqual(got.steps, ['新步骤一', '新步骤二']);
  assert.equal(got.name, '丝瓜炒蛋');
});

test('ensureIngredient 新原料:ingredients 集合 add 收到 {name, isSeasoning, createdAt}', async () => {
  resetMock();
  const result = await ensureIngredient('紫苏', false);
  const ingAdd = calls.add.find((c) => c.coll === 'ingredients');
  assert.ok(ingAdd, '新原料应有一次 ingredients add');
  assert.deepEqual(ingAdd.data, {
    name: '紫苏',
    isSeasoning: false,
    createdAt: { __serverDate: true },
  });
  assert.equal(result.isNew, true);
  assert.equal(result.name, '紫苏');
  assert.equal(result.isSeasoning, false);
  assert.equal(result._id, ingAdd.id);
});
