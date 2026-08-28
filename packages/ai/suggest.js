/**
 * packages/ai/suggest.js
 * F27 AI 定菜助手页(分包 packages/ai,首页「✨AI 推荐」入口跳入):
 * - 进入检查 getAiConfig().textEnabled,关闭则显示空态(主包入口零逻辑直接跳转)
 * - 候选 = 全量菜名;排除近 3 天做过的(近 14 天窗口聚合取近 3 天段做排除)
 * - 生成:generateText 输出严格 JSON {name, reason},extractJson 解析
 * - 「就吃这个」:wx.setStorageSync('aiPick', name) 后返回,首页 onShow 读取(不强制自动落账)
 * 注意:数据库操作走主包 api/db.js 与 api/identity.js 封装(分包可引主包,反向禁止)。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import { ensureIdentity } from '../../api/identity.js';
import { fetchAllDishes, statsAggregate, upcomingRecords, dateKey } from '../../api/db.js';
import { getAiConfig } from './config.js';
import { generateText, extractJson } from './text.js';

// F28:system 提示词运行时从 config 取(cfg.prompts.suggest,空串/缺失由 normalizePrompts 兜底内置默认)

/**
 * 候选池打散:随机洗牌后截取最多 60 个。
 * 原因:全量候选(百道级)传给 LLM 会产生强头部偏置(实测连续 10 次推同一道第 8 位的菜),
 * 洗牌 + 截断既消除位置偏见,又降低 token 消耗。
 */
export function shuffleCandidates(names, max = 60) {
  const arr = names.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, max);
}

Page({
  behaviors: [useToastBehavior],

  data: {
    textEnabled: false, // AI 生文开关(关闭显示空态)
    loading: false, // 生成中
    pickName: '', // 推荐菜名
    pickReason: '', // 推荐理由
    error: '', // 失败文案
  },

  onLoad() {
    this.init();
  },

  /** 检查开关:开启则自动推荐一次;关闭停留空态 */
  async init() {
    try {
      const cfg = await getAiConfig();
      this.setData({ textEnabled: cfg.textEnabled });
      if (cfg.textEnabled) this.suggest();
    } catch (err) {
      console.error('AI 配置加载失败', err);
    }
  },

  /** 组装候选与排除数据并发起生文;解析失败/输出不在候选内降级提示重试 */
  async suggest() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '', pickName: '', pickReason: '' });
    try {
      const { member } = await ensureIdentity();
      const familyId = member ? member.familyId : '';
      const now = Date.now();
      // 并行:全量菜(候选)、今明已定(避免重复推荐)、近 3 天已做(排除)
      const [dishes, upcoming, recent] = await Promise.all([
        fetchAllDishes(),
        upcomingRecords(familyId),
        statsAggregate({
          from: dateKey(new Date(now - 2 * 86400000)),
          to: dateKey(new Date(now)),
          familyId,
        }),
      ]);
      const recentNames = new Set(recent.byDish.map((d) => d.name));
      const plannedNames = new Set(
        []
          .concat(upcoming.today || [], upcoming.tomorrow || [])
          .map((r) => r.dishName),
      );
      const candidates = shuffleCandidates(
        dishes
          .map((d) => d.name)
          .filter((name) => !recentNames.has(name) && !plannedNames.has(name)),
      );
      if (candidates.length === 0) {
        this.setData({ loading: false, error: '候选菜为空(都做过或已定),先添加几道新菜吧' });
        return;
      }
      const dataText = JSON.stringify({
        候选列表: candidates,
        今明已定: Array.from(plannedNames),
      });
      const cfg = await getAiConfig(); // 60s 内存缓存,重复读开销极低
      const text = await generateText([
        { role: 'system', content: cfg.prompts.suggest },
        { role: 'user', content: dataText },
      ]);
      const parsed = extractJson(text);
      const name = parsed && typeof parsed.name === 'string' ? parsed.name : '';
      if (!name || !candidates.includes(name)) {
        this.setData({ loading: false, error: 'AI 没给出有效推荐，请重试' });
        return;
      }
      this.setData({
        loading: false,
        pickName: name,
        pickReason: typeof parsed.reason === 'string' ? parsed.reason : '',
      });
    } catch (err) {
      console.error('AI 推荐失败', err);
      this.setData({ loading: false, error: err.message || '生成失败，请重试' });
      this.onShowToast('#t-toast', err.message || '生成失败，请重试');
    }
  },

  /** 换一个 */
  onSuggest() {
    this.suggest();
  },

  /** 就吃这个:storage 标记后返回首页(首页 onShow 读取并提示,不强制自动落账) */
  onAccept() {
    const { pickName } = this.data;
    if (!pickName) return;
    wx.setStorageSync('aiPick', pickName);
    wx.navigateBack();
  },
});
