/**
 * test/normalize.test.js
 * utils/normalize.js 的单元测试(node --test)
 * 运行:node --test test/
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeName, splitIngredient, escapeRegExp } = require('../utils/normalize.js');

/* ---------------- normalizeName ---------------- */

test('normalizeName: 去首尾空白', () => {
  assert.equal(normalizeName('  西红柿  '), '西红柿');
  assert.equal(normalizeName('西红柿'), '西红柿');
});

test('normalizeName: 全角空格转半角', () => {
  assert.equal(normalizeName('西　红柿'), '西 红柿');
  assert.equal(normalizeName('西　红　柿'), '西 红 柿');
});

test('normalizeName: 首尾全角空格随 trim 去掉', () => {
  assert.equal(normalizeName('　西红柿　'), '西红柿');
});

test('normalizeName: 连续空格折叠为单个', () => {
  assert.equal(normalizeName('a  b   c'), 'a b c');
  assert.equal(normalizeName('a　　b　c'), 'a b c');
});

test('normalizeName: 全角字母数字转半角', () => {
  assert.equal(normalizeName('ＡＢＣ１２３'), 'ABC123');
  assert.equal(normalizeName('ｘｙｚ０９'), 'xyz09');
  // 全角标点保持原样(只转字母数字)
  assert.equal(normalizeName('水果丁（芒果/火龙果）'), '水果丁（芒果/火龙果）');
});

test('normalizeName: 边界用例', () => {
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName('　'), '');
  assert.equal(normalizeName(null), '');
  assert.equal(normalizeName(undefined), '');
  assert.equal(normalizeName('   '), '');
});

/* ---------------- splitIngredient ---------------- */

test('splitIngredient: 最后一个空格分隔名称与用量', () => {
  assert.deepEqual(splitIngredient('西红柿 2个'), { name: '西红柿', amount: '2个' });
  assert.deepEqual(splitIngredient('盐 适量'), { name: '盐', amount: '适量' });
});

test('splitIngredient: 无空格时用量为空串', () => {
  assert.deepEqual(splitIngredient('土豆'), { name: '土豆', amount: '' });
  assert.deepEqual(splitIngredient('盐'), { name: '盐', amount: '' });
});

test('splitIngredient: 名称内部含空格时按最后一个空格拆分', () => {
  assert.deepEqual(splitIngredient('水果丁（芒果/火龙果） 适量'), {
    name: '水果丁（芒果/火龙果）',
    amount: '适量',
  });
});

test('splitIngredient: 归一化后再拆分(全角空格/多余空格)', () => {
  assert.deepEqual(splitIngredient('  苹果　3个  '), { name: '苹果', amount: '3个' });
  assert.deepEqual(splitIngredient('a  b  c'), { name: 'a b', amount: 'c' });
});

test('splitIngredient: 边界用例', () => {
  assert.deepEqual(splitIngredient(''), { name: '', amount: '' });
  assert.deepEqual(splitIngredient('   '), { name: '', amount: '' });
  assert.deepEqual(splitIngredient(null), { name: '', amount: '' });
});

/* ---------------- escapeRegExp ---------------- */

test('escapeRegExp: 转义正则特殊字符', () => {
  assert.equal(escapeRegExp('a.b'), 'a\\.b');
  assert.equal(escapeRegExp('.*+?^${}()|[]\\'), '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\');
});

test('escapeRegExp: 中文与普通字符不受影响', () => {
  assert.equal(escapeRegExp('西红柿'), '西红柿');
  assert.equal(escapeRegExp('abc123'), 'abc123');
  assert.equal(escapeRegExp(''), '');
});

test('escapeRegExp: 转义后可作字面量正则使用', () => {
  const re = new RegExp(escapeRegExp('x.y'));
  assert.equal(re.test('ax.yb'), true);
  assert.equal(re.test('axby'), false);
});
