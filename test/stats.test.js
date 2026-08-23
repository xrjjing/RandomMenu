/**
 * test/stats.test.js
 * utils/stats.js 统计页纯逻辑单元测试(node --test)
 * 覆盖:期计算(日/月/年、偏移、跨月跨年、未来期禁用)、
 * 柱状图组装(日按菜、月补零、年按月聚合)、饼图 Top N + 其他、原料榜过滤与百分比。
 * 运行:node --test
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computePeriod,
  buildBarData,
  buildPieData,
  buildIngredientRanking,
} = require('../utils/stats.js');

/* ---------------- computePeriod ---------------- */

test('computePeriod 日:今天与上一期', () => {
  const now = new Date(2026, 7, 23); // 2026-08-23
  const cur = computePeriod('day', 0, now);
  assert.equal(cur.from, '2026-08-23');
  assert.equal(cur.to, '2026-08-23');
  assert.equal(cur.text, '8月23日');
  assert.equal(cur.nextDisabled, true, '今天向右(明天)是未来,应禁用');
  assert.equal(cur.prevDisabled, false);
  const prev = computePeriod('day', -1, now);
  assert.equal(prev.from, '2026-08-22');
  assert.equal(prev.text, '8月22日');
  assert.equal(prev.nextDisabled, false, '昨天向右(今天)不是未来,应可翻');
});

test('computePeriod 日:跨月与跨年边界', () => {
  const now = new Date(2026, 7, 23);
  assert.equal(computePeriod('day', -24, now).text, '7月30日'); // 8月23 - 24 天 = 7月30日
  const newYear = new Date(2026, 0, 1);
  const prev = computePeriod('day', -1, newYear);
  assert.equal(prev.from, '2025-12-31');
  assert.equal(prev.text, '12月31日');
});

test('computePeriod 月:当月范围与文案', () => {
  const now = new Date(2026, 7, 23); // 2026-08-23
  const cur = computePeriod('month', 0, now);
  assert.equal(cur.from, '2026-08-01');
  assert.equal(cur.to, '2026-08-31');
  assert.equal(cur.text, '2026年8月');
  assert.equal(cur.nextDisabled, true);
  const prev = computePeriod('month', -1, now);
  assert.equal(prev.from, '2026-07-01');
  assert.equal(prev.to, '2026-07-31');
  assert.equal(prev.nextDisabled, false);
});

test('computePeriod 月:2 月(平年 28 天 / 闰年 29 天)', () => {
  assert.equal(computePeriod('month', 0, new Date(2026, 1, 10)).to, '2026-02-28');
  assert.equal(computePeriod('month', 0, new Date(2028, 1, 5)).to, '2028-02-29');
});

test('computePeriod 年:当年范围与跨年', () => {
  const now = new Date(2026, 7, 23);
  const cur = computePeriod('year', 0, now);
  assert.equal(cur.from, '2026-01-01');
  assert.equal(cur.to, '2026-12-31');
  assert.equal(cur.text, '2026年');
  assert.equal(cur.nextDisabled, true);
  const prev = computePeriod('year', -1, now);
  assert.equal(prev.from, '2025-01-01');
  assert.equal(prev.to, '2025-12-31');
  assert.equal(prev.text, '2025年');
  assert.equal(prev.nextDisabled, false);
});

/* ---------------- buildBarData ---------------- */

test('buildBarData 日:每根柱 = 一道菜', () => {
  const stats = { byDish: [{ name: '红烧肉', count: 3 }, { name: '番茄炒蛋', count: 1 }] };
  assert.deepEqual(buildBarData('day', stats, { year: 2026, month: 8 }), [
    { label: '红烧肉', value: 3 },
    { label: '番茄炒蛋', value: 1 },
  ]);
});

test('buildBarData 月:当月每日 1~31 补零', () => {
  const stats = {
    byDate: [
      { date: '2026-08-03', count: 2 },
      { date: '2026-08-31', count: 1 },
    ],
  };
  const data = buildBarData('month', stats, { year: 2026, month: 8 });
  assert.equal(data.length, 31);
  assert.equal(data[0].label, '1');
  assert.equal(data[0].value, 0, '无记录日期补 0');
  assert.equal(data[2].label, '3');
  assert.equal(data[2].value, 2);
  assert.equal(data[30].label, '31');
  assert.equal(data[30].value, 1);
  assert.equal(buildBarData('month', stats, { year: 2026, month: 2 }).length, 28, '2 月 28 天');
});

test('buildBarData 年:按月聚合 1~12 补零', () => {
  const stats = {
    byDate: [
      { date: '2026-01-05', count: 1 },
      { date: '2026-01-20', count: 2 },
      { date: '2026-12-01', count: 3 },
    ],
  };
  const data = buildBarData('year', stats, { year: 2026, month: 1 });
  assert.equal(data.length, 12);
  assert.equal(data[0].label, '1');
  assert.equal(data[0].value, 3, '1 月两条记录聚合');
  assert.equal(data[1].value, 0, '2 月无记录补 0');
  assert.equal(data[11].label, '12');
  assert.equal(data[11].value, 3);
});

/* ---------------- buildPieData ---------------- */

test('buildPieData:≤TopN 原样返回', () => {
  const byDish = [
    { name: 'A', count: 5 },
    { name: 'B', count: 3 },
  ];
  assert.deepEqual(buildPieData(byDish, 8), [
    { name: 'A', value: 5 },
    { name: 'B', value: 3 },
  ]);
});

test('buildPieData:>TopN 其余聚合「其他」', () => {
  const byDish = Array.from({ length: 10 }, (_, i) => ({ name: `菜${i + 1}`, count: 10 - i }));
  const data = buildPieData(byDish, 8);
  assert.equal(data.length, 9, '前 8 + 其他');
  assert.equal(data[0].name, '菜1');
  assert.equal(data[0].value, 10);
  assert.equal(data[8].name, '其他');
  assert.equal(data[8].value, 3, '菜9(2) + 菜10(1)');
});

/* ---------------- buildIngredientRanking ---------------- */

test('buildIngredientRanking:默认过滤调料并算名次与百分比', () => {
  const byIngredient = [
    { name: '盐', count: 5 },
    { name: '猪肉', count: 3 },
    { name: '番茄', count: 2 },
  ];
  const list = buildIngredientRanking(byIngredient);
  assert.equal(list.length, 2, '盐(调料)被过滤');
  assert.deepEqual(
    list.map((item) => item.name),
    ['猪肉', '番茄'],
  );
  assert.equal(list[0].rank, 1);
  assert.equal(list[0].top, true);
  assert.equal(list[0].percent, 100, '最高次数为基准 100%');
  assert.equal(list[1].rank, 2);
  assert.equal(list[1].percent, 67, '2/3 四舍五入为 67%');
});

test('buildIngredientRanking:含调料开关打开时不过滤', () => {
  const byIngredient = [{ name: '盐', count: 5 }, { name: '猪肉', count: 3 }];
  assert.equal(buildIngredientRanking(byIngredient, true).length, 2);
  assert.equal(buildIngredientRanking(byIngredient, false).length, 1);
});

test('buildIngredientRanking:空列表', () => {
  assert.deepEqual(buildIngredientRanking([], false), []);
});
