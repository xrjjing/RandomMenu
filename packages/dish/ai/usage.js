/**
 * packages/dish/ai/usage.js
 * AI 用量静默上报(F30 用量面板数据源):
 * - 生文在 text.js 调用成功后上报 token(见 reportTextUsage);
 * - 生图在 ai-image 云函数转存成功后计数(云函数内独立实现,不回 import 本模块);
 * - 写入 app_meta 集合 _id='ai_usage' 单文档,用 db.command.inc 原子累加;
 *   文档不存在时降级 add 初值(并发首写可能丢一次累加,面板允许合理误差);
 * - 上报一律 fire-and-forget:失败只 console.error,绝不阻断生成主链路。
 * 注意:wx 引用一律放在函数内部,保证 node 环境 import 本模块不抛错。
 */

/** 当前月份键 YYYY-MM(与 dateKey 同族:本地时区、padStart,粒度到月;云函数各持一份不跨端复用) */
export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 内部:把带点号路径的累加字段组装成首写 add 文档(byMonth.2026-09.xxx → 嵌套对象)。
 * @param {object} fields 累加字段(值为普通数字,非 command)
 * @returns {object} 含 _id 的初始文档
 */
function buildInitialDoc(fields) {
  const doc = { _id: 'ai_usage' };
  const byMonth = {};
  Object.keys(fields).forEach((k) => {
    const v = Number(fields[k]);
    if (k.startsWith('byMonth.')) {
      const parts = k.split('.'); // ['byMonth', '2026-09', 'textCalls']
      if (parts.length === 3 && parts[1]) {
        if (!byMonth[parts[1]]) byMonth[parts[1]] = {};
        byMonth[parts[1]][parts[2]] = v;
      }
    } else {
      doc[k] = v;
    }
  });
  if (Object.keys(byMonth).length) doc.byMonth = byMonth;
  return doc;
}

/**
 * 内部:对 ai_usage 文档做 inc 累加(值为 0 的字段跳过);文档不存在则 add 初值。
 * 注意:小程序端 doc().update() 对不存在/被规则拒绝的文档静默返回 stats.updated:0(不 reject),
 *   必须显式判 updated===0 补 add,否则首写后文档永远不会创建(踩过的坑,见 family/api.js)。
 * @param {object} fields 累加字段(值为数字)
 * @returns {Promise<void>}
 */
export async function incUsage(fields) {
  const db = wx.cloud.database();
  const _ = db.command;
  const data = {};
  Object.keys(fields).forEach((k) => {
    const v = Number(fields[k]);
    if (Number.isFinite(v) && v !== 0) data[k] = _.inc(v);
  });
  if (Object.keys(data).length === 0) return;
  try {
    const res = await db.collection('app_meta').doc('ai_usage').update({ data });
    // 文档不存在/规则拒绝:静默 updated===0,补 add 初值(并发首写可能丢一次累加,可接受)
    if (!res || !res.stats || res.stats.updated === 0) {
      await db
        .collection('app_meta')
        .add({ data: buildInitialDoc(fields) })
        .catch(() => {});
    }
  } catch (e) {
    console.error('[ai/usage] 累加失败:', e.errMsg || e.message || e);
  }
}

/**
 * 生文 token 用量上报(开关已在 text.js 校验,这里纯累计)。
 * @param {object} usage 模型返回的 usage(兼容 prompt_tokens / promptTokens 两种键名)
 * @returns {Promise<void>}
 */
export function reportTextUsage(usage) {
  if (!usage) return Promise.resolve();
  const p = Number(usage.prompt_tokens || usage.promptTokens || 0);
  const c = Number(usage.completion_tokens || usage.completionTokens || 0);
  const t = Number(usage.total_tokens || usage.totalTokens || 0);
  if (!Number.isFinite(p) || !Number.isFinite(c) || !Number.isFinite(t)) return Promise.resolve();
  const ym = monthKey();
  return incUsage({
    totalTextCalls: 1,
    promptTokens: p,
    completionTokens: c,
    totalTokens: t,
    [`byMonth.${ym}.textCalls`]: 1,
    [`byMonth.${ym}.promptTokens`]: p,
    [`byMonth.${ym}.completionTokens`]: c,
    [`byMonth.${ym}.totalTokens`]: t,
  });
}

/**
 * 生图计数上报(当前生图在云函数侧独立计数;本函数供小程序端未来直连场景使用)。
 * @param {number} [n=1] 生成张数
 * @returns {Promise<void>}
 */
export function reportImageCount(n = 1) {
  const count = Number(n);
  if (!Number.isFinite(count) || count <= 0) return Promise.resolve();
  const ym = monthKey();
  return incUsage({
    totalImageCalls: count,
    [`byMonth.${ym}.imageCalls`]: count,
  });
}

/**
 * 读取 ai_usage 单文档(不存在/读取失败返回 null,调用方显示全 0)。
 * @returns {Promise<object|null>}
 */
export async function fetchUsage() {
  try {
    const db = wx.cloud.database();
    const res = await db.collection('app_meta').doc('ai_usage').get();
    return (res && res.data) || null;
  } catch (e) {
    console.error('[ai/usage] 读取失败:', e.errMsg || e.message || e);
    return null;
  }
}

/**
 * 汇总用量文档为「本月 / 累计」两组展示数据(纯函数,node 可测)。
 * @param {object|null} doc ai_usage 文档
 * @param {Date} [now] 当前时间(测试注入)
 * @returns {{monthKey:string, month:object, total:object}}
 */
export function summarizeUsage(doc, now = new Date()) {
  const ym = monthKey(now);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const m = (doc && doc.byMonth && doc.byMonth[ym]) || {};
  return {
    monthKey: ym,
    month: {
      textCalls: num(m.textCalls),
      imageCalls: num(m.imageCalls),
      totalTokens: num(m.totalTokens),
    },
    total: {
      textCalls: num(doc && doc.totalTextCalls),
      imageCalls: num(doc && doc.totalImageCalls),
      totalTokens: num(doc && doc.totalTokens),
    },
  };
}
