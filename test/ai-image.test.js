/**
 * test/ai-image.test.js
 * F26 AI 生图批次1验收(node --test):api/aiConfig.js + packages/ai/api.js。
 * 覆盖:getAiConfig 键不存在→全 false / 正常键透传 / 60s 缓存命中不重复发查询 /
 *      setAiConfig 写后清缓存;setAiConfig update/set 两分支;
 *      generateDishImage 云函数 ok:false → throw / ok:true → 返回 fileID;
 *      attachImageToDish stats.updated 原样透传(1/0)。
 * 运行:node --test;mock 方式与 test/upcoming.test.js 同款(内存云库 + freshEnv 重置)。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const aiConfig = require('../packages/ai/config.js');
const aiApi = require('../packages/ai/api.js');

/* ---------------- mock 工具 ---------------- */

/**
 * 构造 wx 替身:app_meta 内存集合(带 get 调用计数)+ dishes doc().update + callFunction。
 * @param {object} opts
 * @param {object|undefined} opts.aiConfigDoc 预置的 ai_config 文档内容(undefined = 键不存在)
 * @param {Function} opts.callFunction 云函数替身(event) => result
 * @param {number} opts.dishUpdateResult doc().update 的返回值
 */
function setupMockWx({ aiConfigDoc, callFunction, dishUpdateResult }) {
  const counters = { appMetaGet: 0, callFunction: 0, dishUpdate: 0 };
  // ai_config 内存文档:update 会真实应用,模拟云库行为
  const metaDoc = aiConfigDoc === undefined ? null : { ...aiConfigDoc };
  global.wx = {
    cloud: {
      database() {
        return {
          collection(name) {
            assert.equal(name, 'app_meta', 'aiConfig 只允许访问 app_meta 集合');
            return {
              where(cond) {
                assert.deepEqual(cond, { _id: 'ai_config' });
                return {
                  async get() {
                    counters.appMetaGet += 1;
                    return { data: metaDoc ? [metaDoc] : [] };
                  },
                };
              },
              doc(id) {
                assert.equal(id, 'ai_config');
                return {
                  async update({ data }) {
                    // 记录 update 内容供断言,并真实应用(模拟云库)
                    counters.lastUpdate = { ...data };
                    Object.assign(metaDoc, data);
                    return { stats: { updated: 1 } };
                  },
                };
              },
              async add({ data }) {
                counters.lastAdd = { ...data };
                return { _id: data._id };
              },
            };
          },
        };
      },
      async callFunction({ name, data }) {
        counters.callFunction += 1;
        counters.lastCall = { name, data };
        return { result: callFunction(data) };
      },
    },
  };
  return counters;
}

/** 重置:重建 mock(aiConfig 模块缓存由 setAiConfig 清空,或直接改内部缓存) */
function freshEnv(opts) {
  aiConfig.__resetAiConfigCacheForTest();
  return setupMockWx(opts);
}

/* ---------------- getAiConfig ---------------- */

test('getAiConfig:键不存在 → 全 false,且不抛错', async () => {
  const counters = freshEnv({ aiConfigDoc: undefined });
  const cfg = await aiConfig.getAiConfig();
  assert.deepEqual(cfg, { aiEnabled: false, imageEnabled: false, textEnabled: false });
  assert.equal(counters.appMetaGet, 1);
});

test('getAiConfig:正常键 → 透传显式 true,缺失字段按关', async () => {
  freshEnv({ aiConfigDoc: { _id: 'ai_config', aiEnabled: true, imageEnabled: true, expireAt: '2027-02-24' } });
  const cfg = await aiConfig.getAiConfig();
  assert.deepEqual(cfg, { aiEnabled: true, imageEnabled: true, textEnabled: false });
});

test('getAiConfig:60s 内二次读命中缓存,不重复发查询', async () => {
  const counters = freshEnv({ aiConfigDoc: { aiEnabled: true } });
  await aiConfig.getAiConfig();
  const cfg2 = await aiConfig.getAiConfig();
  assert.equal(counters.appMetaGet, 1, '第二次应命中内存缓存');
  assert.equal(cfg2.aiEnabled, true);
});

test('getAiConfig:字段为 false / 非布尔 → 一律关(读取侧只有显式 true 才开)', async () => {
  freshEnv({ aiConfigDoc: { aiEnabled: 'yes', imageEnabled: false, textEnabled: 1 } });
  const cfg = await aiConfig.getAiConfig();
  assert.deepEqual(cfg, { aiEnabled: false, imageEnabled: false, textEnabled: false });
});

/* ---------------- setAiConfig ---------------- */

test('setAiConfig:已有文档走 update,写后缓存被清(下次读发新查询且拿到新值)', async () => {
  const counters = freshEnv({ aiConfigDoc: { aiEnabled: true } });
  await aiConfig.getAiConfig(); // 预热缓存
  // aiEnabled 为派生值:imageEnabled||textEnabled,入参里的 aiEnabled 被忽略
  const after = await aiConfig.setAiConfig({ aiEnabled: false, imageEnabled: true });
  assert.deepEqual(after, { aiEnabled: true, imageEnabled: true, textEnabled: false });
  assert.deepEqual(counters.lastUpdate, { aiEnabled: true, imageEnabled: true, textEnabled: false });
  // 写后 get 应重新发查询(appMetaGet: 预热1 + setAiConfig 内部查1 + 写后 get 1 = 3)
  const cfg = await aiConfig.getAiConfig();
  assert.equal(counters.appMetaGet, 3);
  assert.deepEqual(cfg, { aiEnabled: true, imageEnabled: true, textEnabled: false });
});

test('setAiConfig:键不存在走 add 创建;全关时 aiEnabled 派生为 false', async () => {
  const counters = freshEnv({ aiConfigDoc: undefined });
  await aiConfig.setAiConfig({ textEnabled: true });
  assert.deepEqual(counters.lastAdd, {
    _id: 'ai_config',
    aiEnabled: true,
    imageEnabled: false,
    textEnabled: true,
  });
});

/* ---------------- generateDishImage ---------------- */

test('generateDishImage:云函数 ok:false → throw Error(带 error 文案)', async () => {
  freshEnv({ callFunction: () => ({ ok: false, error: '提示词最多 500 字' }) });
  await assert.rejects(
    () => aiApi.generateDishImage('x'.repeat(501)),
    (err) => err instanceof Error && /500 字/.test(err.message),
  );
});

test('generateDishImage:ok:true → 返回 fileID,width/height 透传,prompt 追加写实词根', async () => {
  const counters = freshEnv({ callFunction: () => ({ ok: true, fileID: 'cloud://xxx.png' }) });
  const fileID = await aiApi.generateDishImage('红烧肉,俯拍', { width: 1024, height: 1024 });
  assert.equal(fileID, 'cloud://xxx.png');
  assert.deepEqual(counters.lastCall, {
    name: 'ai-image',
    data: { prompt: '红烧肉,俯拍,写实美食摄影,真实菜品照片', width: 1024, height: 1024 },
  });
});

test('generateDishImage:result 缺失/ok 非真 → 兜底文案 throw', async () => {
  freshEnv({ callFunction: () => undefined });
  await assert.rejects(() => aiApi.generateDishImage('a'), /生图失败/);
});

/* ---------------- attachImageToDish ---------------- */

test('attachImageToDish:stats.updated=1 原样透传,images 用 _.push 追加', async () => {
  global.wx = {
    cloud: {
      database() {
        const command = { push: (arr) => ({ __cmd: 'push', arr }) };
        return {
          command,
          collection(name) {
            assert.equal(name, 'dishes');
            return {
              doc(id) {
                assert.equal(id, 'dish-1');
                return {
                  async update({ data }) {
                    assert.deepEqual(data.images, { __cmd: 'push', arr: ['cloud://new.png'] });
                    return { stats: { updated: 1 } };
                  },
                };
              },
            };
          },
        };
      },
    },
  };
  const updated = await aiApi.attachImageToDish('dish-1', 'cloud://new.png');
  assert.equal(updated, 1);
});

test('attachImageToDish:stats.updated=0(id 不存在)透传 0,调用方自查', async () => {
  global.wx = {
    cloud: {
      database() {
        return {
          command: { push: (arr) => ({ arr }) },
          collection: () => ({
            doc: () => ({
              update: async () => ({ stats: { updated: 0 } }),
            }),
          }),
        };
      },
    },
  };
  const updated = await aiApi.attachImageToDish('missing', 'cloud://x.png');
  assert.equal(updated, 0);
});
