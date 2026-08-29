/**
 * packages/dish/ai/prompt-list.js
 * F29 提示词管理列表页:
 * - 守卫:ensureIdentity → 非 admin toast 后 navigateBack
 * - 列出全部提示词用途(来源:DEFAULT_PROMPTS 键集 + PROMPT_LABELS 元信息,开放枚举)
 * - 每次 onShow 重新拉取(从详情页返回后立即刷新,管理页语义走最新值)
 */
import useToastBehavior from '../../../behaviors/useToast.js';
import { ensureIdentity, isFamilyAdmin } from '../../../api/identity.js';
import { getAiConfig } from './config.js';
import { DEFAULT_PROMPTS, PROMPT_LABELS } from './prompts.js';

Page({
  behaviors: [useToastBehavior],

  data: {
    items: [], // [{ key, label, desc }]
  },

  onLoad() {
    this.init();
  },

  onShow() {
    // 守卫通过后每次进页刷新(从详情页 navigateBack 返回时立即生效)
    if (this.guarded) this.loadPrompts();
  },

  /** 进页守卫;非 admin 直接退回 */
  async init() {
    try {
      const { member } = await ensureIdentity();
      if (!isFamilyAdmin(member)) {
        this.onShowToast('#t-toast', '仅管理员可访问');
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.guarded = true;
      this.loadPrompts();
    } catch (err) {
      console.error('身份加载失败', err);
      this.onShowToast('#t-toast', '身份加载失败，请稍后再试');
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  /** 拉取 AI 配置,按 DEFAULT_PROMPTS 键集生成列表(开放枚举:新增键自动出现) */
  async loadPrompts() {
    try {
      const cfg = await getAiConfig();
      const items = Object.keys(DEFAULT_PROMPTS).map((key) => {
        const meta = PROMPT_LABELS[key] || {};
        return {
          key,
          label: meta.label || key,
          desc: meta.desc || '',
        };
      });
      this.setData({ items });
    } catch (err) {
      console.error('提示词列表加载失败', err);
    }
  },

  /** 跳转详情页 */
  onItemTap(e) {
    const { key } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/packages/dish/ai/prompt-edit?key=${key}` });
  },
});
