/**
 * packages/ai/recipe.js
 * F28 AI 写做法(草稿定位):编辑页「AI 写做法(草稿)」按钮调用,返回 {ok, text}。
 * - system 提示词运行时从 config 取(cfg.prompts.recipe,内置默认见 prompts.js)
 * - 输出为草稿,填入输入框后由用户核对修改,不做任何"权威"暗示
 * - 错误收口:不 throw,统一返回 { ok:false, error },风格与 summary/suggest 页一致
 * 注意:wx 引用一律放在函数内部,保证 node 环境 import 本文件不抛错。
 */
import { getAiConfig } from './config.js';
import { generateText } from './text.js';
import { buildRecipeMessages } from './prompts.js';

/**
 * 生成做法草稿。
 * @param {string} name 菜名
 * @param {string} [hint] 可选"特色/要点"补充,一句话,可空
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function generateRecipeDraft(name, hint = '') {
  try {
    const cfg = await getAiConfig();
    const text = await generateText(buildRecipeMessages(cfg.prompts.recipe, name, hint));
    const clean = (text || '').trim();
    if (!clean) return { ok: false, error: 'AI 未返回内容,请重试' };
    return { ok: true, text: clean };
  } catch (err) {
    console.error('[ai/recipe] 生成做法失败:', err.message || err);
    return { ok: false, error: err.message || '生成失败,请重试' };
  }
}
