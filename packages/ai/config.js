/**
 * packages/ai/config.js(自 api/aiConfig.js 挪入分包,主包页面不直接引用,规避"主包未使用 JS"扫描告警 #51)
 * F26 AI 功能配置读写(app_meta 集合 _id='ai_config' 单文档)。
 * 结构:{ _id:'ai_config', aiEnabled, imageEnabled, textEnabled, expireAt, prompts }
 * F28 扩展 prompts 字段(可编辑提示词,见 packages/ai/prompts.js):
 * 无该字段/字段缺失 → 逐字段回退内置默认,存量文档零影响。
 * 读取侧默认全关:键不存在 / 字段缺失 / 查询异常 → 全 false,
 * 即 AI 到期或关闭后所有调用方拿到的都是全 false,页面层据此隐藏入口,小程序既有功能零影响。
 * 缓存:模块级内存缓存 TTL 60s;setAiConfig 写库成功后立即清缓存,管理页改完立即可见新值。
 * 注意:wx 引用一律放在函数内部,保证 node 环境 import 本文件不抛错。
 */

import { normalizePrompts } from './prompts.js';

const CONFIG_ID = 'ai_config';
const TTL_MS = 60 * 1000;

/** 全关默认值(读取侧唯一事实来源) */
const ALL_OFF = { aiEnabled: false, imageEnabled: false, textEnabled: false };

/** 模块级内存缓存:{ value, expireAt } 或 null */
let cache = null;

/**
 * 把云库文档归一化为配置对象:仅显式 true 才开,其余(缺失/非 true)一律关。
 * @param {object|undefined} doc app_meta 的 ai_config 文档
 * @returns {object} { aiEnabled, imageEnabled, textEnabled }
 */
function normalizeConfig(doc) {
  const ok = Boolean(doc);
  return {
    aiEnabled: ok && doc.aiEnabled === true,
    imageEnabled: ok && doc.imageEnabled === true,
    textEnabled: ok && doc.textEnabled === true,
    // F28:提示词逐字段兜底(缺失/空串 → 内置默认),调用方拿到的四字段恒非空
    prompts: normalizePrompts(ok ? doc.prompts : undefined),
  };
}

/** 仅供测试:清空模块级缓存(test/ai-image.test.js 每个 aiConfig 用例前调用) */
export function __resetAiConfigCacheForTest() {
  cache = null;
}

/**
 * 读 AI 配置(app_meta doc 'ai_config')。
 * 用 where 查询形态容错:get 单条 doc 不存在会抛错,where().get() 返回空数组不抛。
 * 缓存 60s 内直接命中,不重复发查询。
 * @returns {Promise<object>} { aiEnabled, imageEnabled, textEnabled }
 */
export async function getAiConfig() {
  if (cache && Date.now() <= cache.expireAt) return cache.value;
  try {
    const db = wx.cloud.database();
    const res = await db.collection('app_meta').where({ _id: CONFIG_ID }).get();
    const value = normalizeConfig(res.data && res.data[0]);
    cache = { value, expireAt: Date.now() + TTL_MS };
    return value;
  } catch (err) {
    // 查询异常按全关处理,不阻断页面正常渲染
    console.error('[aiConfig] getAiConfig 查询失败,按全关处理:', err);
    return { ...ALL_OFF };
  }
}

/**
 * 写 AI 配置(仅管理页使用):update 已有文档,无则 set 创建。
 * 写库成功后清缓存,下一次 getAiConfig 必发查询拿到新值。
 * @param {object} patch 形如 { aiEnabled:true, imageEnabled:false, ... } 的部分字段
 * @returns {Promise<object>} 写后的最新配置
 */
export async function setAiConfig(patch) {
  const db = wx.cloud.database();
  const imageEnabled = patch.imageEnabled === true;
  const textEnabled = patch.textEnabled === true;
  const data = {
    // aiEnabled 为派生值:任一子开关开即视为总开关开(无独立 UI 开关,避免"子开总关"死锁)
    aiEnabled: imageEnabled || textEnabled,
    imageEnabled,
    textEnabled,
  };
  // F28:仅当 patch 显式携带 prompts 时才写入(update 是合并语义,不带 prompts 不会动库里的值)
  if (patch.prompts) {
    data.prompts = normalizePrompts(patch.prompts);
  }
  const existing = await db.collection('app_meta').where({ _id: CONFIG_ID }).get();
  if (existing.data && existing.data.length > 0) {
    await db.collection('app_meta').doc(CONFIG_ID).update({ data });
  } else {
    await db.collection('app_meta').add({ data: { _id: CONFIG_ID, ...data } });
  }
  cache = null;
  return data;
}
