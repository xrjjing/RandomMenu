/**
 * packages/dish/ai/fill.js
 * F30 AI 补全菜品信息(编辑页按钮):根据菜名与原料推断分类/烹饪时间/难度/标签。
 * - system 提示词运行时从 config 取(cfg.prompts.fill,内置默认见 prompts.js)
 * - 输出严格 JSON {category,cookTime,difficulty,tags},extractJson 解析,
 * - 校验(固定枚举)放调用方 edit.js,尽量复用其既有常量,不在此重复维护枚举
 * - 错误收口:不 throw,统一返回 { ok:false, error }
 * 注意:wx 引用一律放在函数内部,保证 node 环境 import 本文件不抛错。
 */
import { getAiConfig } from './config.js';
import { generateText, extractJson } from './text.js';

/**
 * 推断菜品元信息。
 * @param {object} args
 * @param {string} args.name 菜名
 * @param {Array<string|{name:string}>} [args.ingredients] 原料明细(名称)
 * @returns {Promise<{ok:boolean, data?:object, error?:string}>} data 为模型原文解析结果(未做枚举校验)
 */
export async function generateDishFill({ name, ingredients = [] }) {
  try {
    const cfg = await getAiConfig();
    const ingText = (ingredients || [])
      .map((ing) => (typeof ing === 'string' ? ing : ing.name))
      .filter(Boolean)
      .join('、');
    const text = await generateText([
      { role: 'system', content: cfg.prompts.fill },
      { role: 'user', content: `菜名:${name}\n原料:${ingText || '未知'}` },
    ]);
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, error: 'AI 没给出有效补全，请重试' };
    }
    return { ok: true, data: parsed };
  } catch (err) {
    console.error('[ai/fill] 补全失败:', err.message || err);
    return { ok: false, error: err.message || '生成失败，请重试' };
  }
}
