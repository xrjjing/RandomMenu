/**
 * test/ai-recipe.test.js
 * F28 AI 写做法验收(node --test):packages/ai/recipe.js + packages/dish/edit.js。
 * 覆盖:生成成功收口 {ok,text} / 接口失败收口 {ok,error}(不 throw)/ 开关关 / 空内容 /
 *      编辑页已有内容时确认弹窗路径(源码提取 applyRecipeDraft,confirm 才覆盖)。
 * 运行:node --test;recipe.js mock 与 test/ai-text.test.js 同款;edit.js 用 shuffle.test.js
 *      同款源码提取手法(Page 依赖 wx 运行时无法直接 import)。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const aiConfig = require('../packages/ai/config.js');
const prompts = require('../packages/ai/prompts.js');
const recipe = require('../packages/ai/recipe.js');

/**
 * 构造 wx 替身:ai_config 内存文档 + extend.AI.createModel。
 * @param {object} opts
 * @param {boolean} opts.enabled ai_config 是否全开(默认 true)
 * @param {Function|undefined} opts.generateText createModel 后 generateText 的替身
 */
function freshEnv({ enabled = true, generateText } = {}) {
  aiConfig.__resetAiConfigCacheForTest();
  global.wx = {
    cloud: {
      database() {
        return {
          collection: () => ({
            where: () => ({
              get: async () => ({
                data: [{ _id: 'ai_config', aiEnabled: enabled, imageEnabled: true, textEnabled: enabled }],
              }),
            }),
          }),
        };
      },
      extend: {
        AI: {
          createModel() {
            return { generateText: generateText || (async () => ({})) };
          },
        },
      },
    },
  };
}

/* ---------------- generateRecipeDraft ---------------- */

test('generateRecipeDraft:成功 → {ok:true, text 为模型输出}', async () => {
  freshEnv({ generateText: async () => ({
    choices: [{ message: { content: '备料:五花肉\n步骤1.切块焯水\n步骤2.煸炒上色' } }],
  }) });
  const res = await recipe.generateRecipeDraft('红烧肉', '少辣');
  assert.equal(res.ok, true);
  assert.match(res.text, /备料/);
  assert.match(res.text, /步骤1\./);
});

test('generateRecipeDraft:messages 组装正确(system=recipe 提示词,user 含菜名与要点)', async () => {
  let captured;
  freshEnv({ generateText: async (params) => {
    captured = params.messages;
    return { choices: [{ message: { content: '做法' } }] };
  } });
  await recipe.generateRecipeDraft('红烧肉', '少辣');
  assert.equal(captured[0].role, 'system');
  assert.equal(captured[0].content, prompts.DEFAULT_PROMPTS.recipe);
  assert.equal(captured[1].role, 'user');
  assert.match(captured[1].content, /红烧肉/);
  assert.match(captured[1].content, /少辣/);
});

test('generateRecipeDraft:模型异常 → {ok:false},不 throw', async () => {
  freshEnv({ generateText: async () => { throw new Error('AI 暂时不可用,请稍后再试'); } });
  const res = await recipe.generateRecipeDraft('红烧肉');
  assert.equal(res.ok, false);
  assert.match(res.error, /暂时不可用/);
});

test('generateRecipeDraft:开关关 → {ok:false, AI 功能未开启}', async () => {
  freshEnv({ enabled: false });
  const res = await recipe.generateRecipeDraft('红烧肉');
  assert.equal(res.ok, false);
  assert.match(res.error, /未开启/);
});

test('generateRecipeDraft:空内容 → {ok:false}', async () => {
  freshEnv({ generateText: async () => ({ choices: [{ message: { content: '' } }] }) });
  const res = await recipe.generateRecipeDraft('红烧肉');
  assert.equal(res.ok, false);
  assert.match(res.error, /未返回内容/);
});

/* ---------------- 编辑页 applyRecipeDraft:已有内容确认路径 ---------------- */

// packages/dish/edit.js 是 Page 文件(依赖 wx 运行时),用源码提取 + 沙箱求值
const editSrc = fs.readFileSync(path.join(__dirname, '../packages/dish/edit.js'), 'utf8');
const m = editSrc.match(/applyRecipeDraft\(text\)\s\{[\s\S]*?\n\s\s\}/);
assert.ok(m, '源文件中应能提取 applyRecipeDraft');
// eslint-disable-next-line no-new-func
const applyRecipeDraft = new Function(
  `${m[0].replace(/^\s\s/, '').replace(/applyRecipeDraft\(text\)\s\{/, 'function applyRecipeDraft(text) {')};`
  + ' return applyRecipeDraft;',
)();

/** 构造页面 this 替身:{ data, setData, stepSeq } + wx.showModal 捕获 */
function setupPage(steps) {
  const state = { setDataCalls: [], modalContent: null, toast: null };
  global.wx = {
    showToast: (opts) => { state.toast = opts.title; },
    showModal: (opts) => {
      state.modalContent = opts.content;
      state.modalSuccess = opts.success;
    },
  };
  const page = {
    stepSeq: 100,
    data: { steps },
    setData(patch) { state.setDataCalls.push(patch); },
  };
  return { page, state };
}

test('applyRecipeDraft:做法为空 → 直接填入,不弹确认', () => {
  const { page, state } = setupPage([{ id: 0, text: '' }]);
  applyRecipeDraft.call(page, '备料:鸡蛋\n步骤1.打散');
  assert.equal(state.modalContent, null, '不应弹确认');
  const patch = state.setDataCalls.find((p) => p.steps);
  assert.equal(patch.steps.length, 2);
  assert.equal(patch.steps[0].text, '备料:鸡蛋');
});

test('applyRecipeDraft:已有内容 → 弹确认;confirm 才覆盖(回调触发)', () => {
  const { page, state } = setupPage([{ id: 0, text: '已有做法' }]);
  applyRecipeDraft.call(page, '备料:鸡蛋\n步骤1.打散');
  assert.match(state.modalContent, /覆盖当前做法/);
  // 用户取消:不做任何 setData
  state.modalSuccess({ confirm: false });
  assert.equal(state.setDataCalls.length, 0);
  // 用户确认:覆盖填入
  state.modalSuccess({ confirm: true });
  const patch = state.setDataCalls.find((p) => p.steps);
  assert.equal(patch.steps.length, 2);
  assert.equal(patch.steps[1].text, '步骤1.打散');
});

test('applyRecipeDraft:空文本 → 拦截并 toast,不写 setData', () => {
  const { page, state } = setupPage([{ id: 0, text: '' }]);
  applyRecipeDraft.call(page, '  \n  ');
  assert.equal(state.setDataCalls.length, 0);
  assert.match(state.toast, /生成失败/);
});
