/**
 * utils/stats.js
 * 统计页纯逻辑(可在 node 下独立测试,不依赖 wx):
 * - computePeriod:按粒度与偏移计算当期时间范围与文案(未来期禁用规则)
 * - buildBarData:柱状图数据组装(日=按菜、月=按日 1~31 补零、年=按月 1~12 补零)
 * - buildPieData:饼图数据组装(byDish Top N + 其余聚合「其他」)
 * - buildIngredientRanking:原料榜列表组装(过滤调料、名次、进度条百分比)
 * 页面只做状态管理,组装逻辑统一收敛在这里,保证可测试、单一实现。
 */
import { SEASONING_SET } from './seasonings.js';

/** 数字补零(两位) */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时区日期键 YYYY-MM-DD(与 api/db.js dateKey 同规则,手动拼年月日避免 UTC 错位) */
function localDateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 计算当前期时间范围与文案。
 * 未来期不允许:offset=0 即当前期(今天/当月/当年),右箭头(下一期)必然进入未来,
 * 故 nextDisabled = offset >= 0;过去期永远可翻,prevDisabled 恒为 false。
 * @param {'day'|'month'|'year'} granularity 粒度
 * @param {number} [offset=0] 距当前期偏移(负数为过去)
 * @param {Date} [now] 当前时间(可注入便于测试)
 * @returns {{from: string, to: string, text: string, year: number, month: number, prevDisabled: boolean, nextDisabled: boolean}}
 */
export function computePeriod(granularity, offset = 0, now = new Date()) {
  let from;
  let to;
  let text;
  let year;
  let month;
  if (granularity === 'day') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    from = localDateKey(d);
    to = localDateKey(d);
    text = `${d.getMonth() + 1}月${d.getDate()}日`;
    year = d.getFullYear();
    month = d.getMonth() + 1;
  } else if (granularity === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    year = d.getFullYear();
    month = d.getMonth() + 1;
    from = localDateKey(d);
    // month 1-based,new Date(y, m, 0) 为 m 月最后一天
    to = localDateKey(new Date(year, month, 0));
    text = `${year}年${month}月`;
  } else {
    year = now.getFullYear() + offset;
    month = 1;
    from = `${year}-01-01`;
    to = `${year}-12-31`;
    text = `${year}年`;
  }
  return {
    from,
    to,
    text,
    year,
    month,
    prevDisabled: false,
    nextDisabled: offset >= 0,
  };
}

/**
 * 组装柱状图数据(已按展示顺序):
 * - day:每根柱 = 一道菜(byDish)
 * - month:当月每日 1~31,无记录补 0(保持列对齐)
 * - year:按月聚合 1~12 月,无记录补 0
 * @param {'day'|'month'|'year'} granularity 粒度
 * @param {{byDate: Array, byDish: Array}} stats statsAggregate 结果
 * @param {{year: number, month: number}} period computePeriod 结果(取年月)
 * @returns {Array<{label: string, value: number}>}
 */
export function buildBarData(granularity, stats, period) {
  if (granularity === 'day') {
    return stats.byDish.map((item) => ({ label: item.name, value: item.count }));
  }
  if (granularity === 'month') {
    const byDate = new Map(stats.byDate.map((item) => [item.date, item.count]));
    const days = new Date(period.year, period.month, 0).getDate(); // 当月天数
    const list = [];
    for (let d = 1; d <= days; d += 1) {
      const key = `${period.year}-${pad2(period.month)}-${pad2(d)}`;
      list.push({ label: String(d), value: byDate.get(key) || 0 });
    }
    return list;
  }
  // year:按月聚合
  const byMonth = new Array(13).fill(0);
  stats.byDate.forEach((item) => {
    const m = Number(item.date.slice(5, 7));
    if (m >= 1 && m <= 12) byMonth[m] += item.count;
  });
  return Array.from({ length: 12 }, (_, i) => ({ label: String(i + 1), value: byMonth[i + 1] }));
}

/**
 * 组装饼图数据:byDish(次数降序)取 Top N,其余聚合成「其他」。
 * @param {Array<{name: string, count: number}>} byDish statsAggregate 的 byDish(已降序)
 * @param {number} [topN=8] 最多展示的菜品数
 * @returns {Array<{name: string, value: number}>}
 */
export function buildPieData(byDish, topN = 8) {
  const list = byDish || [];
  if (list.length <= topN) {
    return list.map((item) => ({ name: item.name, value: item.count }));
  }
  const top = list.slice(0, topN).map((item) => ({ name: item.name, value: item.count }));
  const rest = list.slice(topN).reduce((sum, item) => sum + item.count, 0);
  if (rest > 0) top.push({ name: '其他', value: rest });
  return top;
}

/**
 * 组装原料榜列表(byIngredient 已按次数降序):
 * - includeSeasoning=false 时过滤调料(SEASONING_SET;注:addCookRecord 快照已排除调料,
 *   此过滤仅兜底历史遗留的调料名)
 * - 每项带名次 rank(前三名 top=true 高亮)与进度条宽度百分比 percent(相对最高次数)
 * @param {Array<{name: string, count: number}>} byIngredient statsAggregate 的 byIngredient(已降序)
 * @param {boolean} [includeSeasoning=false] 是否包含调料
 * @param {Set<string>} [seasoningSet=SEASONING_SET] 调料集合(可注入便于测试)
 * @returns {Array<{name: string, count: number, rank: number, top: boolean, percent: number}>}
 */
export function buildIngredientRanking(byIngredient, includeSeasoning = false, seasoningSet = SEASONING_SET) {
  const source = byIngredient || [];
  const list = includeSeasoning ? source : source.filter((item) => !seasoningSet.has(item.name));
  const maxCount = list.length ? list[0].count : 0; // 已按次数降序,首项即最大值
  return list.map((item, index) => ({
    name: item.name,
    count: item.count,
    rank: index + 1,
    top: index < 3,
    percent: maxCount > 0 ? Math.round((item.count / maxCount) * 100) : 0,
  }));
}
