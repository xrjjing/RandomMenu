/**
 * utils/menuSort.js
 * 菜谱列表排序纯函数(node 可独立单测)
 * 规则:难度 简单(0) → 中等(1) → 较难(2),相同难度按名称(localeCompare 'zh');
 * 大类「全部」时先按分类分组(餐食整列在前,饮品在后),每组内照难度规则。
 * 注意:编辑页另有「一般/复杂」档位(历史数据可能混存),未在规则内的难度一律排末档,组内按名称。
 */

/** 难度档位映射(任务书:简单 0 / 中等 1 / 较难 2;其余归末档) */
const DIFFICULTY_ORDER = { 简单: 0, 中等: 1, 较难: 2 };

/** 取难度档位;未知难度(一般/复杂/空)返回末档 99 */
function difficultyRank(difficulty) {
  const rank = DIFFICULTY_ORDER[difficulty];
  return rank != null ? rank : 99;
}

/** 按名称中文序比较 */
function compareByName(a, b) {
  return String(a.name).localeCompare(String(b.name), 'zh');
}

/**
 * 菜单列表排序。
 * @param {Array} dishes 菜品文档/卡片数组(元素需含 name/category/difficulty)
 * @param {object} [opts]
 * @param {string} [opts.category=''] 当前大类:'' 全部时先按分类分组(餐食在前、饮品在后)
 * @returns {Array} 排序后的新数组(不改动原数组)
 */
export function sortMenuDishes(dishes, { category = '' } = {}) {
  return (dishes || []).slice().sort((a, b) => {
    if (category === '') {
      const aCat = a.category === 'meal' ? 0 : 1;
      const bCat = b.category === 'meal' ? 0 : 1;
      if (aCat !== bCat) return aCat - bCat;
    }
    const diff = difficultyRank(a.difficulty) - difficultyRank(b.difficulty);
    if (diff !== 0) return diff;
    return compareByName(a, b);
  });
}
