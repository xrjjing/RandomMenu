/**
 * test/ai-text.test.js
 * F27 生文封装验收(node --test):packages/dish/ai/text.js。
 * 覆盖:开关关 → AI_DISABLED / 正常生成取 choices[0].message.content /
 *      空内容 → MODEL_ERROR / 超时 → TIMEOUT / 云侧异常收口 /
 *      extractJson 容错(纯 JSON / ```json 包裹 / 前后缀 / 非法)。
 * 运行:node --test;mock 与 test/ai-image.test.js 同款思路。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const aiConfig = require('../packages/dish/ai/config.js');
const text = require('../packages/dish/ai/text.js');

/**
 * 构造 wx 替身:app_meta 配置 + extend.AI.createModel。
 * @param {object} opts
 * @param {object|undefined} opts.cfgDoc ai_config 文档(undefined=键不存在)
 * @param {Function|undefined} opts.generateText createModel 后 generateText 的替身
 */
function setupMockWx({ cfgDoc, generateText } = {}) {
  const metaDoc = cfgDoc === undefined ? null : { ...cfgDoc };
  global.wx = {
    cloud: {
      database() {
        return {
          collection: () => ({
            where: () => ({
              get: async () => ({ data: metaDoc ? [metaDoc] : [] }),
            }),
          }),
        };
      },
      extend: {
        AI: {
          createModel() {
            return {
              generateText: generateText || (async () => ({})),
            };
          },
        },
      },
    },
  };
}

function freshEnv(opts) {
  aiConfig.__resetAiConfigCacheForTest();
  return setupMockWx(opts);
}

test('generateText:开关关(aiEnabled false)→ AI_DISABLED,不发模型调用', async () => {
  let called = 0;
  freshEnv({ cfgDoc: undefined, generateText: () => { called += 1; return Promise.resolve({}); } });
  await assert.rejects(
    () => text.generateText([{ role: 'user', content: 'hi' }]),
    (err) => err.code === 'AI_DISABLED' && /未开启/.test(err.message),
  );
  assert.equal(called, 0, '模型不应被调用');
});

test('generateText:textEnabled false 同样拒绝', async () => {
  freshEnv({ cfgDoc: { aiEnabled: true, imageEnabled: true } });
  await assert.rejects(() => text.generateText([{ role: 'user', content: 'hi' }]), (err) => err.code === 'AI_DISABLED');
});

test('generateText:正常路径取 choices[0].message.content', async () => {
  freshEnv({
    cfgDoc: { aiEnabled: true, textEnabled: true },
    generateText: async ({ model, messages }) => {
      assert.equal(model, 'hy3');
      assert.equal(messages[0].content, '只回复:OK');
      return { choices: [{ message: { content: 'OK' } }] };
    },
  });
  const out = await text.generateText([{ role: 'user', content: '只回复:OK' }]);
  assert.equal(out, 'OK');
});

test('generateText:choices 空内容 → MODEL_ERROR', async () => {
  freshEnv({ cfgDoc: { aiEnabled: true, textEnabled: true }, generateText: async () => ({ choices: [{ message: {} }] }) });
  await assert.rejects(() => text.generateText([{ role: 'user', content: 'x' }]), (err) => err.code === 'MODEL_ERROR');
});

test('generateText:云侧异常收口为 MODEL_ERROR+中文文案', async () => {
  freshEnv({
    cfgDoc: { aiEnabled: true, textEnabled: true },
    generateText: async () => { const e = new Error('invalid token timestamp'); throw e; },
  });
  await assert.rejects(() => text.generateText([{ role: 'user', content: 'x' }]), (err) => err.code === 'MODEL_ERROR' && /暂时不可用/.test(err.message));
});

test('generateText:超时 → TIMEOUT(用 30ms 短超时触发)', async () => {
  freshEnv({
    cfgDoc: { aiEnabled: true, textEnabled: true },
    generateText: () => new Promise((resolve) => { setTimeout(() => resolve({ choices: [{ message: { content: 'late' } }] }), 300); }),
  });
  await assert.rejects(
    () => text.generateText([{ role: 'user', content: 'x' }], { timeoutMs: 30 }),
    (err) => err.code === 'TIMEOUT',
  );
});

test('extractJson:纯 JSON / ```json 包裹 / 前后缀文本 / 非法输入', () => {
  assert.deepEqual(text.extractJson('{"dish":"红烧肉"}'), { dish: '红烧肉' });
  assert.deepEqual(text.extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(text.extractJson('推荐如下:{"dish":"清蒸鱼"} 请查收'), { dish: '清蒸鱼' });
  assert.equal(text.extractJson('没有花括号'), null);
  assert.equal(text.extractJson('{"broken": '), null);
  assert.equal(text.extractJson(''), null);
  assert.equal(text.extractJson(null), null);
});
