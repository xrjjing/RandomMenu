/**
 * packages/dish/ai/prompt-edit.js
 * F29 提示词详情页(单条用途的编辑):
 * - 守卫:ensureIdentity → 非 admin toast 后 navigateBack
 * - 改:文本域编辑 + 保存(非空校验,写 app_meta.ai_config.prompts[用途])
 * - 删(恢复默认):确认后把该用途写回 DEFAULT_PROMPTS 内置值
 */
import useToastBehavior from '../../../behaviors/useToast.js';
import { ensureIdentity, isFamilyAdmin } from '../../../api/identity.js';
import { getAiConfig, setAiConfig } from './config.js';
import { DEFAULT_PROMPTS, PROMPT_LABELS, PROMPT_LIMITS } from './prompts.js';

Page({
  behaviors: [useToastBehavior],

  data: {
    key: '',
    label: '',
    desc: '',
    value: '',
    limit: 500,
    saving: false, // 保存中(防重复)
    resetting: false, // 恢复默认中(防重复)
  },

  onLoad(options) {
    this.promptKey = (options && options.key) || '';
    this.init();
  },

  /** 进页守卫 + 参数校验 */
  async init() {
    if (!this.promptKey || !DEFAULT_PROMPTS[this.promptKey]) {
      this.onShowToast('#t-toast', '参数错误');
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    try {
      const { member } = await ensureIdentity();
      if (!isFamilyAdmin(member)) {
        this.onShowToast('#t-toast', '仅管理员可访问');
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.loadPrompt();
    } catch (err) {
      console.error('身份加载失败', err);
      this.onShowToast('#t-toast', '身份加载失败，请稍后再试');
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  /** 拉取该用途当前值(已归一化)并填表 */
  async loadPrompt() {
    try {
      const cfg = await getAiConfig();
      const meta = PROMPT_LABELS[this.promptKey] || {};
      this.setData({
        key: this.promptKey,
        label: meta.label || this.promptKey,
        desc: meta.desc || '',
        value: cfg.prompts[this.promptKey],
        limit: PROMPT_LIMITS[this.promptKey] || 500,
      });
    } catch (err) {
      console.error('提示词加载失败', err);
      this.onShowToast('#t-toast', '加载失败，请稍后再试');
    }
  },

  /** 文本域输入 */
  onInput(e) {
    this.setData({ value: e.detail.value });
  },

  /** 保存:非空校验 → 合并写回该用途(idempotent,setAiConfig 只动 prompts 字段) */
  async onSave() {
    if (this.data.saving) return;
    const value = String(this.data.value || '').trim();
    if (!value) {
      this.onShowToast('#t-toast', '提示词不能为空');
      return;
    }
    this.setData({ saving: true });
    try {
      const cur = await getAiConfig();
      const cfg = await setAiConfig({ prompts: { ...cur.prompts, [this.promptKey]: value } });
      this.setData({ saving: false, value: cfg.prompts[this.promptKey] });
      this.onShowToast('#t-toast', '已保存');
    } catch (err) {
      console.error('提示词保存失败', err);
      this.setData({ saving: false });
      this.onShowToast('#t-toast', err.message || '保存失败，请重试');
    }
  },

  /** 恢复默认(删除该用途的自定义覆盖):确认后写回内置默认值 */
  async onReset() {
    if (this.data.resetting) return;
    const confirm = await wx.showModal({
      title: '恢复默认？',
      content: '将丢弃该提示词的自定义内容，回退为内置默认版本。',
      confirmText: '恢复',
      cancelText: '取消',
    });
    if (!confirm.confirm) return;
    this.setData({ resetting: true });
    try {
      const cur = await getAiConfig();
      const cfg = await setAiConfig({
        prompts: { ...cur.prompts, [this.promptKey]: DEFAULT_PROMPTS[this.promptKey] },
      });
      this.setData({ resetting: false, value: cfg.prompts[this.promptKey] });
      this.onShowToast('#t-toast', '已恢复默认');
    } catch (err) {
      console.error('恢复默认失败', err);
      this.setData({ resetting: false });
      this.onShowToast('#t-toast', err.message || '恢复失败，请重试');
    }
  },
});
