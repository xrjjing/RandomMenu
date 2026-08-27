/**
 * test/imgUrl.test.js
 * 云函数换链工具验收(node --test)
 * 运行:node --test
 * 覆盖:非 cloud:// 原样返回不调云函数、cloud:// 批量换链回填、缓存命中零调用、
 *      云函数异常回空串不 reject、>50 分批、Storage 异常静默降级、过期缓存视为未命中
 * 说明:mock wx.cloud.callFunction + wx.Storage 替身;imgUrl 模块级内存缓存
 *      通过 clearImgUrlCache 清空保证用例间无串扰。
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { resolveImgUrls, clearImgUrlCache, isCloudProtocol } = require('../utils/imgUrl.js');

/* ---------------- mock 工具 ---------------- */

function setupMock({ callFunctionImpl, storageThrow = false } = {}) {
  const counters = { calls: 0, batches: [] };
  const storage = new Map();
  global.wx = {
    cloud: {
      callFunction: async (opts) => {
        counters.calls += 1;
        counters.batches.push(opts.data.fileIds);
        if (callFunctionImpl) return callFunctionImpl(opts);
        const map = {};
        opts.data.fileIds.forEach((fid) => {
          map[fid] = `https://tmp.example.com/${fid.slice(-6)}?sign=x`;
        });
        return { result: { map, failed: [] } };
      },
    },
    getStorageSync(key) {
      if (storageThrow) throw new Error('storage broken');
      const raw = storage.get(key);
      return raw === undefined ? '' : raw;
    },
    setStorageSync(key, value) {
      if (storageThrow) throw new Error('storage broken');
      storage.set(key, JSON.parse(JSON.stringify(value)));
    },
    removeStorageSync(key) {
      storage.delete(key);
    },
  };
  return { counters, storage };
}

beforeEach(() => {
  clearImgUrlCache();
});

/* ---------------- 用例 ---------------- */

test('isCloudProtocol:仅 cloud:// 前缀判定', () => {
  assert.equal(isCloudProtocol('cloud://env.abc/dishes/x.jpg'), true);
  assert.equal(isCloudProtocol('/static/images/a.jpg'), false);
  assert.equal(isCloudProtocol(''), false);
  assert.equal(isCloudProtocol(null), false);
});

test('非 cloud:// 输入原样返回且不触发云函数', async () => {
  const { counters } = setupMock();
  const out = await resolveImgUrls(['/static/a.jpg', 'https://x.com/b.jpg', '']);
  assert.deepEqual(out, ['/static/a.jpg', 'https://x.com/b.jpg', ''], '同序同长,空串原位保留');
  assert.equal(counters.calls, 0, '无 cloud:// 输入零调用');
});

test('cloud:// 批量换链回填且同序', async () => {
  const { counters } = setupMock();
  const out = await resolveImgUrls(['/static/a.jpg', 'cloud://env/x/1.jpg', 'cloud://env/x/2.jpg']);
  assert.match(out[0], /^\/static\//);
  assert.match(out[1], /^https:\/\/tmp\.example\.com/);
  assert.match(out[2], /^https:\/\/tmp\.example\.com/);
  assert.equal(counters.calls, 1, '一次批量调用');
});

test('缓存命中:二次调用同 fileId 零云函数调用', async () => {
  const { counters } = setupMock();
  await resolveImgUrls(['cloud://env/x/1.jpg']);
  assert.equal(counters.calls, 1);
  const out2 = await resolveImgUrls(['cloud://env/x/1.jpg']);
  assert.match(out2[0], /^https:\/\//);
  assert.equal(counters.calls, 1, '缓存命中不增调用');
});

test('云函数抛错:对应位置回空串且不 reject', async () => {
  setupMock({
    callFunctionImpl: () => {
      throw new Error('cloud down');
    },
  });
  const out = await resolveImgUrls(['cloud://env/x/1.jpg', '/static/a.jpg']);
  assert.deepEqual(out, ['', '/static/a.jpg']);
});

test('云函数返回缺项:缺的位置回空串', async () => {
  setupMock({
    callFunctionImpl: (opts) => ({ result: { map: {}, failed: opts.data.fileIds } }),
  });
  const out = await resolveImgUrls(['cloud://env/x/1.jpg']);
  assert.deepEqual(out, ['']);
});

test('>50 个分批:52 个 → 2 次调用且全部回填', async () => {
  const { counters } = setupMock();
  const ids = Array.from({ length: 52 }, (_, i) => `cloud://env/x/${i}.jpg`);
  const out = await resolveImgUrls(ids);
  assert.equal(counters.calls, 2, '52 个分 2 批');
  assert.equal(counters.batches[0].length, 50);
  assert.equal(counters.batches[1].length, 2);
  out.forEach((u) => assert.match(u, /^https:\/\//));
});

test('wx.Storage 异常:静默降级换链仍工作', async () => {
  const { counters } = setupMock({ storageThrow: true });
  const out = await resolveImgUrls(['cloud://env/x/1.jpg']);
  assert.match(out[0], /^https:\/\//);
  assert.equal(counters.calls, 1);
  // 二次调用:持久层坏但内存层在,仍零调用
  await resolveImgUrls(['cloud://env/x/1.jpg']);
  assert.equal(counters.calls, 1);
});

test('过期缓存条目视为未命中重新换链', async () => {
  const { counters, storage } = setupMock();
  await resolveImgUrls(['cloud://env/x/1.jpg']);
  assert.equal(counters.calls, 1);
  // 手动把缓存 exp 改到过去,模拟 TTL 到期
  const persisted = storage.get('img_url_cache');
  const fid = Object.keys(persisted)[0];
  persisted[fid].exp = Date.now() - 1000;
  storage.set('img_url_cache', persisted);
  clearImgUrlCache(); // 清内存层,强制走持久层(带过期条目)
  const out = await resolveImgUrls(['cloud://env/x/1.jpg']);
  assert.equal(counters.calls, 2, '过期后重新换链');
  assert.match(out[0], /^https:\/\//);
});

test('持久层跨实例命中:模块重载(冷启动)后 Storage 条目仍命中', async () => {
  const env = setupMock();
  await resolveImgUrls(['cloud://env/x/1.jpg']);
  assert.equal(env.counters.calls, 1);
  // 模拟冷启动:清 require 缓存重载模块,内存 Map 全新,wx.Storage(同一 mock storage)保留
  delete require.cache[require.resolve('../utils/imgUrl.js')];
  const imgUrl2 = require('../utils/imgUrl.js');
  const out = await imgUrl2.resolveImgUrls(['cloud://env/x/1.jpg']);
  assert.equal(env.counters.calls, 1, '持久层命中,冷启动后也不重新调云函数');
  assert.match(out[0], /^https:\/\//);
});
