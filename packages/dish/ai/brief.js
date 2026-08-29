/**
 * packages/dish/ai/brief.js
 * F30 #3 首页 AI 今日简报(分包页,主包首页只放展示卡 + 跳转入口):
 * - 进入检查 textEnabled,关闭显示空态(主包入口零逻辑直接跳转)
 * - 数据:今日已做 + 明后天已定 + 菜谱总数 + 本月最爱(byDish/byIngredient Top3)
 * - 生成后写 storage 'aiBrief'({date, text}),首页 onShow 读同 key 回显当天简报
 * 数据库操作走主包 api/db.js 与 api/identity.js 封装(分包可引主包,反向禁止)。
 */
import useToastBehavior from '../../../behaviors/useToast.js';
import { ensureIdentity } from '../../../api/identity.js';
import { statsAggregate, upcomingRecords, fetchAllDishes, dateKey } from '../../../api/db.js';
import { getAiConfig } from './config.js';
import { streamText } from './text.js';

const BRIEF_STORAGE_KEY = 'aiBrief';

Page({
  behaviors: [useToastBehavior],

  data: {
    textEnabled: false, // AI 生文开关(关闭显示空态)
    loading: false, // 生成中
    briefText: '', // 生成结果
    briefStream: '', // 流式回显(生成中实时累计,完成后清空)
    error: '', // 失败文案(卡片内展示,可重试)
  },

  onLoad() {
    this.init();
  },

  /** 检查开关:开启则自动生成一次;关闭停留空态 */
  async init() {
    try {
      const cfg = await getAiConfig();
      this.setData({ textEnabled: cfg.textEnabled });
      if (cfg.textEnabled) this.generate();
    } catch (err) {
      console.error('AI 配置加载失败', err);
    }
  },

  /** 组装今日简报数据并发起生文;成功后写 storage 供首页同 key 回显,失败文案展示在卡片内 */
  async generate() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '', briefText: '', briefStream: '' });
    try {
      const { member } = await ensureIdentity();
      const familyId = member ? member.familyId : '';
      const now = new Date();
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      const [upcoming, dishes, monthStats] = await Promise.all([
        upcomingRecords(familyId),
        fetchAllDishes(),
        statsAggregate({ from: dateKey(first), to: dateKey(now), familyId }),
      ]);
      const byDish = monthStats.byDish || [];
      const byIngredient = monthStats.byIngredient || [];
      const monthTotal = byDish.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
      const dataText = JSON.stringify({
        今日已做: (upcoming.today || []).map((r) => r.dishName),
        明后天已定: (upcoming.tomorrow || []).concat(upcoming.dayafter || []).map((r) => r.dishName),
        今天做菜次数: (upcoming.today || []).length,
        菜谱总数: dishes.length,
        本月累计做饭次数: monthTotal,
        本月最常做: byDish.slice(0, 3),
        本月最爱原料: byIngredient.slice(0, 3),
      });
      const cfg = await getAiConfig(); // 60s 内存缓存,重复读开销极低
      const text = await streamText(
        [
          { role: 'system', content: cfg.prompts.brief },
          { role: 'user', content: dataText },
        ],
        {
          // 流式:生成中实时回显,完成后统一 setData 最终文本
          onChunk: (chunk) => {
            this.setData({ briefStream: this.data.briefStream + chunk });
          },
        },
      );
      // 首页 onShow 只回显当天简报,换天自动失效
      wx.setStorageSync(BRIEF_STORAGE_KEY, { date: dateKey(now), text });
      this.setData({ loading: false, briefText: text, briefStream: '' });
    } catch (err) {
      console.error('AI 今日简报生成失败', err);
      this.setData({ loading: false, error: err.message || '生成失败，请重试', briefStream: '' });
    }
  },

  /** 重新生成 */
  onRegenerate() {
    this.generate();
  },

  /** 回首页看卡片 */
  onBackHome() {
    wx.switchTab({ url: '/pages/home/index' });
  },
});
