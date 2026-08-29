/**
 * test/ai-text-stream.test.js
 * F30 #7 流式生成验收(node --test):packages/dish/ai/text.js 的 streamText。
 * 覆盖:开关关 → AI_DISABLED / streamText 不可用 → 退回 generateText(整段回调一次)/
 *       textStream 逐段累积并按序 onChunk / 返回体无 textStream → 退回 generateText。
 * 运行:node --test;mock 与 test/ai-text.test.js 同款思路。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const aiConfig = require('../packages/dish/ai/config.js');
const text = require('../packages/dish/ai/text.js');

/** 构造 wx 替身:app_meta 配置 + createModel 返回 {generateText, streamText?} */
function setupMockWx({ cfgDoc, generateText, streamText } = {}) {
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
            const model = { generateText: generateText || (async () => ({})) };
            if (streamText !== undefined) model.streamText = streamText;
            return model;
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

/** 把一个字符串数组包成 async iterable(模拟 textStream) */
function textStreamOf(chunks) {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (i < chunks.length) {
            const value = chunks[i];
            i += 1;
            return { value, done: false };
          }
          return { value: '', done: true };
        },
      };
    },
  };
}

/** next() 永远挂起的流(模拟流挂起,验证无增量超时) */
function neverStream() {
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}),
      };
    },
  };
}

/** 先吐一 chunk、随后 next() 抛错的流(模拟收到首 chunk 后断流) */
function textStreamChunkThenThrow(chunk, err) {
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          if (i === 0) {
            i += 1;
            return { value: chunk, done: false };
          }
          throw err;
        },
      };
    },
  };
}

const ON = { cfgDoc: { aiEnabled: true, textEnabled: true } };

test('streamText:开关关 → AI_DISABLED', async () => {
  freshEnv({ cfgDoc: undefined });
  await assert.rejects(
    () => text.streamText([{ role: 'user', content: 'x' }]),
    (err) => err.code === 'AI_DISABLED',
  );
});

test('streamText:streamText 非函数 → 退回 generateText,onChunk 整段回调一次', async () => {
  freshEnv({
    ...ON,
    generateText: async () => ({ choices: [{ message: { content: '完整做法' } }] }),
  });
  const seen = [];
  const out = await text.streamText([{ role: 'user', content: '红烧肉做法' }], { onChunk: (c) => seen.push(c) });
  assert.equal(out, '完整做法');
  assert.deepEqual(seen, ['完整做法']);
});

test('streamText:逐段累积并按序 onChunk', async () => {
  freshEnv({
    ...ON,
    streamText: async () => ({
      textStream: textStreamOf(['先', '焯水', ',再', '红烧']),
    }),
  });
  const seen = [];
  const out = await text.streamText([{ role: 'user', content: '做法' }], { onChunk: (c) => seen.push(c) });
  assert.equal(out, '先焯水,再红烧');
  assert.deepEqual(seen, ['先', '焯水', ',再', '红烧']);
});

test('streamText:返回体无 textStream → 退回 generateText', async () => {
  freshEnv({
    ...ON,
    streamText: async () => ({}),
    generateText: async () => ({ choices: [{ message: { content: '降级文本' } }] }),
  });
  const out = await text.streamText([{ role: 'user', content: 'x' }]);
  assert.equal(out, '降级文本');
});

test('streamText:8s 无增量超时 → TIMEOUT(测试用极短 idleMs 触发)', async () => {
  freshEnv({
    ...ON,
    streamText: async () => ({ textStream: neverStream() }),
  });
  await assert.rejects(
    () => text.streamText([{ role: 'user', content: '做法' }], { idleMs: 30, totalMs: 200 }),
    (err) => err.code === 'TIMEOUT',
  );
});

test('streamText:收到首 chunk 后失败不重试且直接抛(Model 只调一次)', async () => {
  let calls = 0;
  freshEnv({
    ...ON,
    streamText: async () => {
      calls += 1;
      return { textStream: textStreamChunkThenThrow('先', new Error('连接断开')) };
    },
  });
  const seen = [];
  await assert.rejects(
    () => text.streamText([{ role: 'user', content: '做法' }], { onChunk: (c) => seen.push(c) }),
    (err) => err.code === 'MODEL_ERROR' && /暂时不可用/.test(err.message),
  );
  assert.deepEqual(seen, ['先']);
  assert.equal(calls, 1, '收到首 chunk 后不应重试');
});
