/**
 * packages/dish/ai/prompts.js
 * AI 提示词集中管理:各 AI 功能的内置默认提示词 + 归一化/拼接纯函数(单一事实来源)。
 * - 可编辑提示词存 app_meta 的 ai_config 文档 prompts 字段;
 * - 字段缺失 / 空串 / 纯空白 → 逐字段回退内置默认,防止清空导致功能废;
 * - 用途为开放枚举:新增 AI 功能在 DEFAULT_PROMPTS 加键即自动接入读取兜底与提示词管理页;
 * - 本模块不引用 wx,可在 node 环境 import(测试直接 require)。
 */

/** 内置默认提示词(提示词管理页「恢复默认」与读取侧兜底共用) */
export const DEFAULT_PROMPTS = {
  // 生图保底词根(generateDishImage 追加在用户词后;编辑页输入框默认词也读它拼接)
  imageStyle: '写实美食摄影,真实菜品照片',
  // AI 定菜推荐 system(原 suggest.js 内置值;F30 升级为自然语言找菜:候选带原料/标签,可接收用户想法)
  suggest:
    '你是定菜助手。从候选列表里推荐1道今晚的菜,只能从候选列表选,禁止编造。' +
    '候选列表每项含菜名/原料/标签;用户可能提出想法(手头原料、口味、忌口等),尽量满足但不必逐字照办。' +
    '候选列表顺序无意义,不要总选同一个;追求多样性和新鲜感。' +
    '输出严格 JSON:{"name":"菜名","reason":"30字内理由,可提一下为什么合适"}',
  // AI 报菜员小结 system(原 summary.js 内置值)
  summary:
    '你是家庭菜谱小程序的AI报菜员。只能使用用户提供的数据,禁止编造数据之外的菜名或数字;' +
    '用轻松口语化中文,120字内,结尾可给1条轻建议。',
  // AI 写做法 system(草稿定位:家常做法、结构化、不编特殊食材)
  recipe:
    '你是家常菜谱助手。根据用户给的菜名和补充要点,写一份家常做法草稿:' +
    '先用「备料:」列出所需食材,再用「步骤1.」「步骤2.」…按顺序写做法;' +
    '只使用常见家常食材,禁止编造特殊食材或复杂工艺;全文150字内,输出纯文本。',
  // 做菜小贴士(F30:详情页入口,替代/口味调整等轻咨询)
  tips:
    '你是家常菜小助手。根据用户给的菜名、现有原料和他的问题,给1条实用做菜小贴士或原料替代建议。' +
    '只基于家常常识,不编造;20-60字,口语化,直接给建议,输出纯文本。',
  // AI 补全菜品信息(F30:编辑页按钮,推断分类/时间/难度/标签,只输出固定选项值)
  fill:
    '你是菜谱信息整理助手。根据菜名和原料推断这道菜的元信息,只能输出给定的固定选项值,禁止自创。' +
    '固定选项——category:meal(餐食)或drink(饮品);cookTime:10分钟/15分钟/20分钟/30分钟/45分钟/60分钟;' +
    'difficulty:简单/中等/较难;tags:从以下标签选0-3个最贴切的:主食,汤羹,猪肉,禽肉,鱼虾,素菜,蛋类,鲜榨果汁,奶茶,奶昔,果茶,咖啡拿铁,养生热饮,豆浆米糊,甜品饮品,消暑饮品,冷饮,热饮。' +
    '输出严格 JSON:{"category":"meal","cookTime":"20分钟","difficulty":"简单","tags":["素菜","蛋类"]}',
  // 首页 AI 今日简报(F30:首页简报卡,分包 brief 页生成,主包只读展示)
  brief:
    '你是家庭菜谱小程序的今日简报助手。只能使用用户提供的数据,禁止编造数据之外的菜名、数字或事实;' +
    '用轻松口语化中文写3-4句话,概括今天的做饭情况并给1条轻建议,90字内,输出纯文本。',
  // AI 月报(F30:统计页入口,分包 monthly 页生成;供月报与分享海报配文)
  monthly:
    '你是家庭菜谱小程序的月度总结助手。只能使用用户提供的月度统计,禁止编造数据之外的菜名、数字或事实;' +
    '写一段150字内的月度做饭小结:点出总次数、最常做的菜和最爱原料,语气温暖,输出纯文本。',
};

/** 各提示词输入框字数上限(详情页 maxlength 与保存校验共用) */
export const PROMPT_LIMITS = {
  imageStyle: 200,
  suggest: 500,
  summary: 500,
  recipe: 500,
  tips: 500,
  fill: 600,
  brief: 400,
  monthly: 600,
};

/** 各提示词用途的展示元信息(提示词管理列表/详情页用;开放枚举:新增 AI 功能在此追加即可自动出现在管理页) */
export const PROMPT_LABELS = {
  imageStyle: { label: '生图风格词根', desc: '追加在生图描述之后，保持真实菜品照片风格' },
  suggest: { label: 'AI 推荐', desc: '定菜助手（AI 自然语言找菜）的提示词' },
  summary: { label: 'AI 小结', desc: '报菜员（统计页 AI 小结）的提示词' },
  recipe: { label: 'AI 写做法', desc: '做法草稿的提示词' },
  tips: { label: '做菜小贴士', desc: '详情页 AI 小贴士（替代/口味调整）的提示词' },
  fill: { label: 'AI 补全信息', desc: '编辑页 AI 补全（分类/时间/难度/标签）的提示词' },
  brief: { label: '今日简报', desc: '首页 AI 今日简报卡的提示词' },
  monthly: { label: 'AI 月报', desc: '统计页 AI 月报/分享海报配文的提示词' },
};

/**
 * 归一化提示词配置:逐字段校验,缺失/非字符串/空串/纯空白 → 回退内置默认。
 * @param {object|undefined} raw ai_config.prompts 原始值
 * @returns {object} 全部字段齐全的提示词对象(各字段均为非空 string)
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
