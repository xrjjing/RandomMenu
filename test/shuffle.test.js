/**
 * shuffleCandidates 单元测试:
 * 候选池打散是「AI 推荐总是同一道菜」(LLM 大列表头部偏置)的修复手段,
 * 这里验证洗牌的三个不变量:全量保留、元素不增不减、多次调用顺序期望不同。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 直接从源文件读函数体执行(avoid 微信运行时依赖 wx):
// packages/ai/suggest.js 依赖 db.js → wx,无法直接 import;
// 用正则提取函数体在沙箱中求值,保持测试与实现一致。
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../packages/ai/suggest.js'), 'utf8');
const m = src.match(/export function shuffleCandidates\(names, max = 60\) \{[\s\S]*?\n\}/);
assert.ok(m, '源文件中应能提取 shuffleCandidates');
// eslint-disable-next-line no-new-func
const shuffleCandidates = new Function(`${m[0].replace('export ', '')}; return shuffleCandidates;`)();

test('shuffleCandidates:数组元素不增不减(全量保留)', () => {
  const input = ['a', 'b', 'c', 'd', 'e'];
  const out = shuffleCandidates(input);
  assert.equal(out.length, input.length);
  assert.deepEqual([...out].sort(), [...input].sort());
});

test('shuffleCandidates:截断到 max(默认60)', () => {
  const input = Array.from({ length: 150 }, (_, i) => `菜${i}`);
  const out = shuffleCandidates(input);
  assert.equal(out.length, 60);
  const out2 = shuffleCandidates(input, 10);
  assert.equal(out2.length, 10);
});

test('shuffleCandidates:不修改原数组', () => {
  const input = ['a', 'b', 'c'];
  const snapshot = JSON.stringify(input);
  shuffleCandidates(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('shuffleCandidates:多次调用产生不同顺序(概率性,180个元素洗10次全同序概率≈0)', () => {
  const input = Array.from({ length: 180 }, (_, i) => `菜${i}`);
  const orders = new Set();
  for (let i = 0; i < 10; i += 1) {
    orders.add(shuffleCandidates(input).join('|'));
  }
  assert.ok(orders.size > 1, '10 次洗牌至少出现 2 种顺序');
});
