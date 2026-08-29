/**
 * packages/dish/ai/tips.js
 * F30 AI 做菜小贴士(详情页入口):根据菜名、现有原料与用户问题,生成一条实用小贴士。
 * - system 提示词运行时从 config 取(cfg.prompts.tips,内置默认见 prompts.js)
 * - 轻咨询定位:替代/口味调整等常见问题,不写完整做法
 * - 错误收口:不 throw,统一返回 { ok:false, error },风格与 summary/suggest 页一致
 * 注意:wx 引用一律放在函数内部,保证 node 环境 import 本文件不抛错。
 */
import { getAiConfig } from './config.js';
import { streamText } from './text.js';

/**
 * 生成做菜小贴士。
 * @param {object} args
 * @param {string} args.name 菜名
 * @param {Array<string|{name:string}>} [args.ingredients] 原料明细(名称)
 * @param {string} [args.question] 用户问题(可空,默认给一条通用小贴士)
 * @param {(chunk:string)=>void} [args.onChunk] 流式逐段回调(详情页生成中实时回显用)
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function generateDishTips({ name, ingredients = [], question = '', onChunk = null }) {
  try {
    const cfg = await getAiConfig();
    const ingText = (ingredients || [])
      .map((ing) => (typeof ing === 'string' ? ing : ing.name))
      .filter(Boolean)
      .join('、');
    const messages = [
      { role: 'system', content: cfg.prompts.tips },
      {
        role: 'user',
        content: `菜名:${name}\n现有原料:${ingText || '未知'}\n我的问题:${question.trim() || '给一条实用小贴士'}`,
      },
    ];
    const text = await streamText(messages, { onChunk });
    const clean = (text || '').trim();
    if (!clean) return { ok: false, error: 'AI 未返回内容，请重试' };
    return { ok: true, text: clean };
  } catch (err) {
    console.error('[ai/tips] 生成小贴士失败:', err.message || err);
    return { ok: false, error: err.message || '生成失败，请重试' };
  }
}
