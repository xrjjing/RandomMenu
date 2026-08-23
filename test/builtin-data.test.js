/**
 * test/builtin-data.test.js
 * data/builtin-dishes.js 内置数据结构校验(node --test)
 * 运行:node --test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SEASONING_SET } = require('../utils/seasonings.js');
const builtin = require('../data/builtin-dishes.js').default;

test('内置数据:共 80 道菜', () => {
  assert.equal(builtin.dishes.length, 80);
});

test('内置数据:菜名非空且唯一', () => {
  const names = builtin.dishes.map((d) => d.name);
  names.forEach((name) => {
    assert.ok(typeof name === 'string' && name.trim().length > 0, `存在空菜名:${JSON.stringify(name)}`);
  });
  assert.equal(new Set(names).size, names.length, '菜名存在重复');
});

test('内置数据:category 枚举合法(meal/drink)', () => {
  builtin.dishes.forEach((dish) => {
    assert.ok(
      dish.category === 'meal' || dish.category === 'drink',
      `非法分类:${dish.name} → ${dish.category}`,
    );
  });
});

test('内置数据:每道菜 ingredients 元素结构合法(name 非空/amount 字符串/isSeasoning 布尔)', () => {
  builtin.dishes.forEach((dish) => {
    assert.ok(Array.isArray(dish.ingredients), `${dish.name} 的 ingredients 应为数组`);
    dish.ingredients.forEach((ing) => {
      assert.ok(
        typeof ing.name === 'string' && ing.name.trim().length > 0,
        `${dish.name} 存在空原料名`,
      );
      assert.equal(typeof ing.amount, 'string', `${dish.name}/${ing.name} 的 amount 应为字符串`);
      assert.equal(
        typeof ing.isSeasoning,
        'boolean',
        `${dish.name}/${ing.name} 的 isSeasoning 应为布尔`,
      );
    });
  });
});

test('内置数据:顶层 ingredients 列表 name 唯一且 isSeasoning 布尔', () => {
  const names = builtin.ingredients.map((i) => i.name);
  assert.ok(Array.isArray(builtin.ingredients), '顶层 ingredients 应为数组');
  names.forEach((name) => {
    assert.ok(typeof name === 'string' && name.trim().length > 0, `存在空原料名:${JSON.stringify(name)}`);
  });
  assert.equal(new Set(names).size, names.length, '顶层原料名存在重复');
  builtin.ingredients.forEach((ing) => {
    assert.equal(typeof ing.isSeasoning, 'boolean', `${ing.name} 的 isSeasoning 应为布尔`);
  });
});

test('内置数据:调料集合与顶层原料标记一致(并集覆盖)', () => {
  // 顶层原料中被标记为调料的,必须都在共享调料集合内(反向不强制,允许集合含未使用项)
  const marked = builtin.ingredients.filter((i) => i.isSeasoning).map((i) => i.name);
  const missing = marked.filter((name) => !SEASONING_SET.has(name));
  assert.deepEqual(missing, [], `以下调料不在共享集合中:${missing.join('、')}`);
});
