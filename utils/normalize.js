/**
 * utils/normalize.js
 * 文本归一化与内置原料解析的纯函数
 * 供原料清洗脚本(scripts/clean-ingredients.js)、
 * 数据层(api/db.js)与页面模糊搜索共用,保持单一实现
 */

/** 全角字母与数字(不包含全角标点,括号等保持原样) */
const FULL_TO_HALF = /[\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/g;

/**
 * 名称归一化:
 * 1. 去首尾空白
 * 2. 全角空格(U+3000)转半角
 * 3. 连续空白折叠为单个空格
 * 4. 全角字母数字转半角(用于查重与模糊匹配)
 * @param {string} name 原始名称
 * @returns {string} 归一化后的名称
 */
export function normalizeName(name) {
  if (name == null) return '';
  return String(name)
    .trim()
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(FULL_TO_HALF, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

/**
 * 解析内置数据「名称 数量」格式(如「西红柿 2个」):
 * 以最后一个空格为界,前段为名称,后段为用量;无空格时用量为空串。
 * @param {string} raw 原始原料串
 * @returns {{name: string, amount: string}} 解析结果
 */
export function splitIngredient(raw) {
  const s = normalizeName(raw);
  const index = s.lastIndexOf(' ');
  if (index === -1) return { name: s, amount: '' };
  return { name: s.slice(0, index), amount: s.slice(index + 1) };
}

/**
 * 正则特殊字符转义,用于把用户输入当作字面量构造 RegExp。
 * @param {string} str 待转义字符串
 * @returns {string} 转义后的字符串
 */
export function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
