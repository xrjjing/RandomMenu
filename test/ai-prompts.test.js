/**
 * test/ai-prompts.test.js
 * F28 提示词管理验收(node --test):packages/ai/prompts.js + config.js + api.js。
 * 覆盖:默认兜底(缺失/空串/纯空白 → 内置默认)/ 保存后读取一致(含缓存失效)/
 *      只写开关不抹掉已有 prompts / imageStyle 拼接含去重。
 * 运行:node --test;mock 方式与 test/ai-image.test.js 同款(内存云库 + freshEnv 重置)。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const prompts = require('../packages/ai/prompts.js');
const aiConfig = require('../packages/ai/config.js');
const aiApi = require('../packages/ai/api.js');

/* ---------------- mock 工具(与 test/ai-image.test.js 同款思路) ---------------- */

/**
 * 构造 wx 替身:app_meta 内存集合(带调用计数)+ callFunction。
 * @param {object|undefined} aiConfigDoc 预置的 ai_config 文档内容(undefined = 键不存在)
 */
function setupMockWx(aiConfigDoc) {
  const counters = { appMetaGet: 0, callFunction: 0 };
  const exists = aiConfigDoc !== undefined;
  const metaDoc = exists ? { ...aiConfigDoc } : {}; // add 分支会真实写入,模拟云库
  global.wx = {
    cloud: {
      database() {
        return {
          collection(name) {
            assert.equal(name, 'app_meta', '本测试只允许访问 app_meta 集合');
            return {
              where(cond) {
                assert.deepEqual(cond, { _id: 'ai_config' });
                return {
                  async get() {
                    counters.appMetaGet += 1;
                    return { data: exists ? [metaDoc] : [] };
                  },
                };
              },
              doc(id) {
                assert.equal(id, 'ai_config');
                return {
                  async update({ data }) {
                    Object.assign(metaDoc, data);
                    return { stats: { updated: 1 } };
                  },
                };
              },
              async add({ data }) {
                Object.assign(metaDoc, data);
                return { _id: data._id };
              },
            };
          },
        };
      },
      async callFunction({ name, data }) {
        counters.callFunction += 1;
        counters.lastCall = { name, data };
        return { result: { ok: true, fileID: 'cloud://test-file-id' } };
      },
    },
  };
  return counters;
}

function freshEnv(aiConfigDoc) {
  aiConfig.__resetAiConfigCacheForTest();
  return setupMockWx(aiConfigDoc);
}

/* ---------------- normalizePrompts:默认兜底 ---------------- */

test('normalizePrompts:undefined → 四字段全为内置默认', () => {
  const out = prompts.normalizePrompts(undefined);
  assert.deepEqual(out, prompts.DEFAULT_PROMPTS);
});

test('normalizePrompts:空串/纯空白字段 → 回退该字段默认,其余保留', () => {
  const out = prompts.normalizePrompts({
    imageStyle: '   ',
    suggest: '',
    summary: '自定义小结词',
  });
  assert.equal(out.imageStyle, prompts.DEFAULT_PROMPTS.imageStyle);
  assert.equal(out.suggest, prompts.DEFAULT_PROMPTS.suggest);
  assert.equal(out.summary, '自定义小结词');
  assert.equal(out.recipe, prompts.DEFAULT_PROMPTS.recipe);
});

test('normalizePrompts:自定义值保留并去首尾空白', () => {
  const out = prompts.normalizePrompts({ suggest: '  自定义推荐词  ' });
  assert.equal(out.suggest, '自定义推荐词');
});

/* ---------------- getAiConfig:prompts 读取兜底 ---------------- */

test('getAiConfig:文档无 prompts 字段 → 返回内置默认(存量数据零影响)', async () => {
  freshEnv({ aiEnabled: true, imageEnabled: true, textEnabled: true });
  const cfg = await aiConfig.getAiConfig();
  assert.deepEqual(cfg.prompts, prompts.DEFAULT_PROMPTS);
});

test('getAiConfig:库中空串字段 → 回退默认;有效字段透传', async () => {
  freshEnv({
    aiEnabled: true,
    imageEnabled: true,
    textEnabled: true,
    prompts: { imageStyle: '水彩插画风格', summary: '' },
  });
  const cfg = await aiConfig.getAiConfig();
  assert.equal(cfg.prompts.imageStyle, '水彩插画风格');
  assert.equal(cfg.prompts.summary, prompts.DEFAULT_PROMPTS.summary);
});

/* ---------------- setAiConfig:保存后读取一致 ---------------- */

test('setAiConfig:保存 prompts 后立即读取一致(缓存已失效,必发查询)', async () => {
  const counters = freshEnv({ aiEnabled: false, imageEnabled: false, textEnabled: true });
  const before = counters.appMetaGet;
  const saved = await aiConfig.setAiConfig({
    textEnabled: true,
    prompts: { suggest: '新的推荐词', recipe: '新的做法词' },
  });
  assert.equal(saved.prompts.suggest, '新的推荐词');
  const cfg = await aiConfig.getAiConfig();
  assert.equal(counters.appMetaGet > before, true, '保存后应重新发查询');
  assert.equal(cfg.prompts.suggest, '新的推荐词');
  assert.equal(cfg.prompts.recipe, '新的做法词');
  assert.equal(cfg.prompts.imageStyle, prompts.DEFAULT_PROMPTS.imageStyle, '未保存字段回默认');
});

test('setAiConfig:仅写开关(不带 prompts)→ 库里已有 prompts 不被抹掉', async () => {
  freshEnv({
    aiEnabled: true,
    imageEnabled: true,
    textEnabled: false,
    prompts: { imageStyle: '水彩插画风格' },
  });
  await aiConfig.setAiConfig({ imageEnabled: true, textEnabled: true });
  const cfg = await aiConfig.getAiConfig();
  assert.equal(cfg.prompts.imageStyle, '水彩插画风格');
});

/* ---------------- buildImagePrompt:拼接含去重 ---------------- */

test('buildImagePrompt:默认词根追加在用户词后(兼容存量生图行为)', () => {
  const out = prompts.buildImagePrompt('红烧肉,俯拍', prompts.DEFAULT_PROMPTS.imageStyle);
  assert.equal(out, '红烧肉,俯拍,写实美食摄影,真实菜品照片');
});

test('buildImagePrompt:已含完整词根 → 不重复追加', () => {
  const style = prompts.DEFAULT_PROMPTS.imageStyle;
  const prompt = `红烧肉,${style}`;
  assert.equal(prompts.buildImagePrompt(prompt, style), prompt);
});

test('buildImagePrompt:自定义词根追加;空词根回退默认', () => {
  assert.equal(prompts.buildImagePrompt('红烧肉', '水彩插画'), '红烧肉,水彩插画');
  assert.equal(
    prompts.buildImagePrompt('红烧肉', ''),
    `红烧肉,${prompts.DEFAULT_PROMPTS.imageStyle}`,
  );
});

/* ---------------- generateDishImage:运行时读 config.imageStyle ---------------- */

test('generateDishImage:词根来自 config.imageStyle(签名不变)', async () => {
  const counters = freshEnv({
    aiEnabled: true,
    imageEnabled: true,
    textEnabled: true,
    prompts: { imageStyle: '水彩插画风格' },
  });
  await aiApi.generateDishImage('红烧肉');
  assert.equal(counters.lastCall.data.prompt, '红烧肉,水彩插画风格');
});
