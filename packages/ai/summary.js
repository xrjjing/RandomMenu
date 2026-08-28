/**
 * packages/ai/summary.js
 * F27 AI 报菜员小结页(分包 packages/ai):
 * - 进入检查 getAiConfig().textEnabled,关闭则显示空态(主包入口零逻辑直接跳转)
 * - 数据:statsAggregate 近 7 天 {byDish, byIngredient} + upcomingRecords 今明已定
 * - 生成:generateText(messages) 混元 hy3,system 约束只许使用给定数据,120 字内
 * 注意:数据库操作走主包 api/db.js 与 api/identity.js 封装(分包可引主包,反向禁止)。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import { ensureIdentity } from '../../api/identity.js';
import { statsAggregate, upcomingRecords, dateKey } from '../../api/db.js';
import { getAiConfig } from './config.js';
import { generateText } from './text.js';

// F28:system 提示词运行时从 config 取(cfg.prompts.summary,空串/缺失由 normalizePrompts 兜底内置默认)

Page({
  behaviors: [useToastBehavior],

  data: {
    textEnabled: false, // AI 生文开关(关闭显示空态)
    loading: false, // 生成中
    summaryText: '', // 生成结果
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

  /** 组装近 7 天数据文本并发起生文;失败文案展示在卡片内 */
  async generate() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '', summaryText: '' });
    try {
      const { member } = await ensureIdentity();
      const familyId = member ? member.familyId : '';
      const now = Date.now();
      const [stats, upcoming] = await Promise.all([
        statsAggregate({ from: dateKey(new Date(now - 6 * 86400000)), to: dateKey(new Date(now)), familyId }),
        upcomingRecords(familyId),
      ]);
      const dataText = JSON.stringify({
        近7天做菜统计: {
          菜品次数: stats.byDish,
          常用原料: stats.byIngredient.slice(0, 8),
        },
        今明已定: {
          今天: (upcoming.today || []).map((r) => r.dishName),
          明天: (upcoming.tomorrow || []).map((r) => r.dishName),
        },
      });
      const cfg = await getAiConfig(); // 60s 内存缓存,重复读开销极低
      const text = await generateText([
        { role: 'system', content: cfg.prompts.summary },
        { role: 'user', content: dataText },
      ]);
      this.setData({ loading: false, summaryText: text });
    } catch (err) {
      console.error('AI 小结生成失败', err);
      this.setData({ loading: false, error: err.message || '生成失败，请重试' });
      this.onShowToast('#t-toast', err.message || '生成失败，请重试');
    }
  },

  /** 重新总结 */
  onRegenerate() {
    this.generate();
  },
});
