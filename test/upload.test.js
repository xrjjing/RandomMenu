/**
 * test/upload.test.js
 * 内置图批量上云验收(node --test)
 * 运行:node --test
 * 覆盖:isBuiltinImageMapComplete 纯函数、loadBuiltinImageMap 读取/降级、
 *      uploadBuiltinImages 全量上传 / 已完整跳过 / 部分补传合并 / 单张失败收集与重试
 * 说明:api/upload.js 内部仅在函数内引用 wx,node 下以 global.wx 替身
 *      (mock wx.cloud 数据库 app_meta + wx.cloud.uploadFile)wiring 被测模块。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const upload = require('../api/upload.js');
const builtinData = require('../data/builtin-dishes.js').default;

/** 内置图菜名清单(与 api/upload.js BUILTIN_IMAGE_NAMES 同源;本地源已移除,扩展名恒为 jpg) */
const BUILTIN_IMAGE_NAMES = builtinData.dishes.map((dish) => dish.name);

/**
 * 构造 wx 替身:mock app_meta 集合(doc get/update + add)与 wx.cloud.uploadFile。
 * @param {object} [opts]
 * @param {Array} [opts.appMetaDocs] 初始 app_meta 文档数组
 * @param {Set<string>} [opts.failUploads] 需要模拟上传失败的 cloudPath 集合(可后续 delete 模拟恢复)
 */
function setupMockWx({ appMetaDocs = [], failUploads = new Set() } = {}) {
  const appMeta = new Map(appMetaDocs.map((d) => [d._id, JSON.parse(JSON.stringify(d))]));
  const calls = { uploads: [], metaReads: 0 };
  const command = { set: (v) => ({ $set: v }) };
  global.wx = {
    cloud: {
      database() {
        return {
          command,
          serverDate: () => new Date(2026, 7, 23, 12, 0, 0),
          collection() {
            return {
              doc(id) {
                return {
                  async get() {
                    const doc = appMeta.get(id);
                    if (!doc) {
                      const err = new Error(`document.get:fail document with _id ${id} does not exist`);
                      err.errMsg = err.message;
                      throw err;
                    }
                    calls.metaReads += 1;
                    return { data: JSON.parse(JSON.stringify(doc)) };
                  },
                  async update({ data }) {
                    const doc = appMeta.get(id);
                    if (!doc) {
                      throw new Error(`document.update:fail document with _id ${id} does not exist`);
                    }
                    Object.keys(data).forEach((k) => {
                      const v = data[k];
                      if (v && typeof v === 'object' && v.$set !== undefined) doc[k] = v.$set;
                      else doc[k] = v;
                    });
                    return { stats: { updated: 1 } };
                  },
                };
              },
              async add({ data }) {
                if (data._id && appMeta.has(data._id)) {
                  const err = new Error('add:fail document already exist');
                  err.errCode = -502001;
                  throw err;
                }
                const _id = data._id || `auto-${appMeta.size + 1}`;
                const doc = { _id, ...JSON.parse(JSON.stringify(data)) };
                appMeta.set(_id, doc);
                return { _id };
              },
            };
          },
        };
      },
      async uploadFile({ cloudPath, filePath }) {
        calls.uploads.push({ cloudPath, filePath });
        if (failUploads.has(cloudPath)) throw new Error('uploadFile:fail network');
        return { fileID: `cloud://builtin/${cloudPath.split('/').pop()}` };
      },
    },
  };
  return { calls, appMeta };
}

/* ---------------- 用例 ---------------- */

test('upload:isBuiltinImageMapComplete 完整性判断(纯函数)', () => {
  assert.equal(upload.isBuiltinImageMapComplete(null), false);
  assert.equal(upload.isBuiltinImageMapComplete({}), false);
  const names = BUILTIN_IMAGE_NAMES;
  assert.equal(names.length, 80, '内置菜名清单应覆盖全部 80 道菜');
  const full = Object.fromEntries(names.map((n) => [n, 'cloud://builtin/x.jpg']));
  assert.equal(upload.isBuiltinImageMapComplete(full), true);
  const partial = { ...full };
  delete partial[names[0]];
  assert.equal(upload.isBuiltinImageMapComplete(partial), false);
  const emptyValue = { ...full, [names[0]]: '' };
  assert.equal(upload.isBuiltinImageMapComplete(emptyValue), false);
});

test('upload:loadBuiltinImageMap 无记录返回 null、有记录返回 map、云库异常降级 null', async () => {
  const { appMeta } = setupMockWx();
  // 文档不存在:返回 null
  assert.equal(await upload.loadBuiltinImageMap(), null);
  // 有记录:返回 map
  appMeta.set('builtin_images', { _id: 'builtin_images', map: { 西红柿炒鸡蛋: 'cloud://builtin/x.jpg' } });
  const map = await upload.loadBuiltinImageMap();
  assert.equal(map['西红柿炒鸡蛋'], 'cloud://builtin/x.jpg');
  // 云库整体不可达:内部 catch,返回 null 而非抛错
  global.wx.cloud.database = () => {
    throw new Error('database:fail');
  };
  assert.equal(await upload.loadBuiltinImageMap(), null);
});

test('upload:uploadBuiltinImages 无记录全量上传并写回 app_meta', async () => {
  const { calls, appMeta } = setupMockWx();
  const progress = [];
  const res = await upload.uploadBuiltinImages({ onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(res.alreadyDone, false);
  assert.equal(res.uploaded, 80);
  assert.deepEqual(res.failed, []);
  assert.equal(calls.uploads.length, 80);
  // cloudPath 全部符合 builtin/{菜名}.jpg(本地源已移除,无扩展名可识别,恒为 jpg)
  calls.uploads.forEach(({ cloudPath }) => {
    assert.ok(cloudPath.startsWith('builtin/'), cloudPath);
    assert.ok(cloudPath.endsWith('.jpg'), cloudPath);
  });
  // onProgress 逐张回调,最后进度 = 总数
  assert.equal(progress.length, 80);
  assert.deepEqual(progress[progress.length - 1], [80, 80]);
  // app_meta 已写入,map 覆盖全部菜名且值为 cloud:// fileID
  const meta = appMeta.get('builtin_images');
  assert.ok(meta);
  assert.equal(Object.keys(meta.map).length, 80);
  assert.equal(meta.map['西红柿炒鸡蛋'], 'cloud://builtin/西红柿炒鸡蛋.jpg');
});

test('upload:uploadBuiltinImages 已完整上云直接返回,不重复上传', async () => {
  const fullMap = Object.fromEntries(BUILTIN_IMAGE_NAMES.map((n) => [n, 'cloud://builtin/x.jpg']));
  const { calls } = setupMockWx({ appMetaDocs: [{ _id: 'builtin_images', map: fullMap }] });
  const res = await upload.uploadBuiltinImages({});
  assert.deepEqual(res, { alreadyDone: true, uploaded: 0, failed: [] });
  assert.equal(calls.uploads.length, 0);
});

test('upload:uploadBuiltinImages 部分已上云只补缺失,并合并写回', async () => {
  const names = BUILTIN_IMAGE_NAMES;
  const partialMap = {
    [names[0]]: 'cloud://builtin/existing.jpg',
    [names[1]]: 'cloud://builtin/existing2.jpg',
  };
  const { calls, appMeta } = setupMockWx({
    appMetaDocs: [{ _id: 'builtin_images', map: partialMap }],
  });
  const res = await upload.uploadBuiltinImages({});
  assert.equal(res.alreadyDone, false);
  assert.equal(res.uploaded, 78);
  assert.deepEqual(res.failed, []);
  assert.equal(calls.uploads.length, 78);
  // 既有值保留,新上传补全 80 键
  const meta = appMeta.get('builtin_images');
  assert.equal(Object.keys(meta.map).length, 80);
  assert.equal(meta.map[names[0]], 'cloud://builtin/existing.jpg');
  assert.equal(meta.map[names[2]], `cloud://builtin/${names[2]}.jpg`);
});

test('upload:uploadBuiltinImages 单张失败不中断,收集菜名,重试只补缺失', async () => {
  const names = BUILTIN_IMAGE_NAMES;
  const failName = names[0];
  const failPath = `builtin/${failName}.jpg`;
  const failSet = new Set([failPath]);
  const { calls, appMeta } = setupMockWx({ failUploads: failSet });
  const res = await upload.uploadBuiltinImages({});
  assert.deepEqual(res.failed, [failName]);
  assert.equal(res.uploaded, 79);
  assert.equal(calls.uploads.length, 80); // 全部尝试过,失败的收集不中断
  // 失败的菜没写进 map,其余 79 个已写
  const meta = appMeta.get('builtin_images');
  assert.equal(Object.keys(meta.map).length, 79);
  assert.equal(meta.map[failName], undefined);
  // 重试(网络恢复):只补缺失的那一张
  failSet.delete(failPath);
  const retry = await upload.uploadBuiltinImages({});
  assert.equal(retry.alreadyDone, false);
  assert.equal(retry.uploaded, 1);
  assert.deepEqual(retry.failed, []);
  assert.equal(appMeta.get('builtin_images').map[failName], `cloud://builtin/${failName}.jpg`);
});
