/**
 * test/menuSort.test.js
 * utils/menuSort.js 排序规则测试(node --test)
 * 运行:node --test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sortMenuDishes } = require('../utils/menuSort.js');

// 构造测试数据:name/category/difficulty 三字段即可
function dish(name, category, difficulty) {
  return { name, category, difficulty };
}

test('menuSort:难度升序 简单→中等→较难', () => {
  const list = [
    dish('C', 'meal', '较难'),
    dish('B', 'meal', '中等'),
    dish('A', 'meal', '简单'),
  ];
  const sorted = sortMenuDishes(list);
  assert.deepEqual(
    sorted.map((d) => d.difficulty),
    ['简单', '中等', '较难'],
  );
});

test('menuSort:相同难度按名称中文序', () => {
  const list = [
    dish('西红柿炒鸡蛋', 'meal', '简单'),
    dish('蛋炒饭', 'meal', '简单'),
    dish('麻婆豆腐', 'meal', '简单'),
  ];
  const sorted = sortMenuDishes(list);
  assert.deepEqual(
    sorted.map((d) => d.name),
    ['蛋炒饭', '麻婆豆腐', '西红柿炒鸡蛋'],
  );
});

test('menuSort:大类「全部」餐食整列在前、饮品在后,组内照难度', () => {
  const list = [
    dish('D2', 'drink', '简单'),
    dish('M2', 'meal', '简单'),
    dish('D1', 'drink', '中等'),
    dish('M1', 'meal', '中等'),
  ];
  const sorted = sortMenuDishes(list, { category: '' });
  const cats = sorted.map((d) => d.category);
  assert.deepEqual(cats, ['meal', 'meal', 'drink', 'drink']);
  // 每组内:中等在前?不——难度升序,简单在前
  assert.deepEqual(
    sorted.map((d) => d.difficulty),
    ['简单', '中等', '简单', '中等'],
  );
});

test('menuSort:大类指定 meal/drink 时不分组,仅难度+名称', () => {
  const list = [
    dish('B', 'drink', '简单'),
    dish('A', 'drink', '较难'),
    dish('C', 'drink', '简单'),
  ];
  const sorted = sortMenuDishes(list, { category: 'drink' });
  assert.deepEqual(
    sorted.map((d) => d.name),
    ['B', 'C', 'A'],
  );
});

test('menuSort:未知难度(一般/复杂/空)排末档,组内按名称', () => {
  const list = [
    dish('D', 'meal', '较难'),
    dish('A', 'meal', '复杂'),
    dish('B', 'meal', '一般'),
    dish('C', 'meal', ''),
    dish('E', 'meal', '中等'),
  ];
  const sorted = sortMenuDishes(list, { category: 'meal' });
  assert.deepEqual(
    sorted.map((d) => d.name),
    ['E', 'D', 'A', 'B', 'C'],
  );
});

test('menuSort:不改动原数组,空输入安全返回', () => {
  const list = [dish('B', 'meal', '中等'), dish('A', 'meal', '简单')];
  const copy = list.slice();
  sortMenuDishes(list);
  assert.deepEqual(list, copy, '原数组不应被修改');
  assert.deepEqual(sortMenuDishes(null), []);
  assert.deepEqual(sortMenuDishes(undefined), []);
});
