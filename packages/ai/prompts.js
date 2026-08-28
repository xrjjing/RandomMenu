/**
 * packages/ai/prompts.js
 * F28 AI 提示词集中管理:各 AI 功能的内置默认提示词 + 归一化/拼接纯函数(单一事实来源)。
 * - 可编辑提示词存 app_meta 的 ai_config 文档 prompts 字段(单套可编辑,YAGNI 不做多套切换);
 * - 字段缺失 / 空串 / 纯空白 → 逐字段回退内置默认,防止清空导致功能废;
 * - 本模块不引用 wx,可在 node 环境 import(测试直接 require)。
 */

/** 内置默认提示词(设置页「恢复默认」与读取侧兜底共用) */
export const DEFAULT_PROMPTS = {
  // 生图保底词根(generateDishImage 追加在用户词后;编辑页输入框默认词也读它拼接)
  imageStyle: '写实美食摄影,真实菜品照片',
  // AI 定菜推荐 system(原 suggest.js 内置值)
  suggest:
    '你是定菜助手。从候选列表中推荐1道今晚的菜,只能从候选列表选,禁止编造。'
    + '候选列表顺序无意义,不要总选同一个;追求多样性和新鲜感。'
    + '输出严格 JSON:{"name":"菜名","reason":"20字内理由"}',
  // AI 报菜员小结 system(原 summary.js 内置值)
  summary:
    '你是家庭菜谱小程序的AI报菜员。只能使用用户提供的数据,禁止编造数据之外的菜名或数字;'
    + '用轻松口语化中文,120字内,结尾可给1条轻建议。',
  // AI 写做法 system(草稿定位:家常做法、结构化、不编特殊食材)
  recipe:
    '你是家常菜谱助手。根据用户给的菜名和补充要点,写一份家常做法草稿:'
    + '先用「备料:」列出所需食材,再用「步骤1.」「步骤2.」…按顺序写做法;'
    + '只使用常见家常食材,禁止编造特殊食材或复杂工艺;全文150字内,输出纯文本。',
};

/** 各提示词输入框字数上限(设置页 wxml maxlength 与保存校验共用) */
export const PROMPT_LIMITS = {
  imageStyle: 200,
  suggest: 500,
  summary: 500,
  recipe: 500,
};

/**
 * 归一化提示词配置:逐字段校验,缺失/非字符串/空串/纯空白 → 回退内置默认。
 * @param {object|undefined} raw ai_config.prompts 原始值
 * @returns {object} 四个字段齐全的提示词对象(各字段均为非空 string)
 */
export function normalizePrompts(raw) {
  const out = {};
  Object.keys(DEFAULT_PROMPTS).forEach((key) => {
    const v = raw && raw[key];
    out[key] = typeof v === 'string' && v.trim() ? v.trim() : DEFAULT_PROMPTS[key];
  });
  return out;
}

/**
 * 生图 prompt 拼接:用户词后追加风格词根;已包含完整词根时不重复(去重)。
 * @param {string} prompt 用户输入的生图描述
 * @param {string} imageStyle 风格词根(config 读取,已归一化非空)
 * @returns {string} 拼接后的完整 prompt
 */
export function buildImagePrompt(prompt, imageStyle) {
  const style = (imageStyle || '').trim() || DEFAULT_PROMPTS.imageStyle;
  return String(prompt).includes(style) ? String(prompt) : `${prompt},${style}`;
}

/**
 * 组装 AI 写做法的 messages(system + user,user 含菜名与可选补充要点)。
 * @param {string} system recipe 提示词(config 读取)
 * @param {string} name 菜名
 * @param {string} [hint] 可选的"特色/要点"补充,一句话
 * @returns {Array<{role:string, content:string}>}
 */
export function buildRecipeMessages(system, name, hint) {
  const extra = hint && hint.trim() ? `。补充要点:${hint.trim()}` : '';
  return [
    { role: 'system', content: system },
    { role: 'user', content: `菜名:${name}${extra}` },
  ];
}
