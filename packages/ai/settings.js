/**
 * packages/ai/settings.js
 * F26/F27 AI 设置页(分包 packages/ai,自家庭管理页迁入):
 * - 守卫:onLoad → ensureIdentity → 非 admin toast 后 navigateBack
 * - AI 生图 / 生文开关(即时保存,setAiConfig 整组覆盖防误关另一开关)
 * - AI 报菜员入口(textEnabled 时显示,跳 summary 页)
 * - AI 补图弹层(imageEnabled 时显示):无图菜列表逐个生成/采用,一次会话最多 10 张
 * - F28 提示词区块:生图词根/推荐/小结/做法 四个提示词,单套可编辑 + 逐项恢复默认
 * 逻辑原样迁自 packages/family/index.js,方法名/数据字段保持一致。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import { ensureIdentity, isFamilyAdmin } from '../../api/identity.js';
import { getAiConfig, setAiConfig } from './config.js';
import { DEFAULT_PROMPTS, PROMPT_LIMITS } from './prompts.js';
import { fetchAllDishes } from '../../api/db.js';
import { generateDishImage, attachImageToDish } from './api.js';
import { resolveImgUrls } from '../../utils/imgUrl.js';

/** AI 补图单次弹层会话生成上限(防误触刷爆额度) */
const REPAIR_LIMIT = 10;

Page({
  behaviors: [useToastBehavior],

  data: {
    // AI 设置开关(读侧默认全关,init 时拉取真实值)
    aiImageEnabled: false,
    aiTextEnabled: false,
    aiImageSwitching: false, // 开关写入中(loading 防重复)
    aiTextSwitching: false,
    // AI 补图弹层
    repairPopupVisible: false,
    repairItems: [], // 无图菜列表 [{_id, name, genLoading, previewUrl, previewFileId, error}]
    // F28 提示词管理(单套可编辑):四文本域 + 逐项恢复默认 + 底部保存
    prompts: { ...DEFAULT_PROMPTS }, // 当前编辑中的提示词(init 时从 config 拉取)
    promptLimits: PROMPT_LIMITS, // 供 wxml maxlength
    promptSaving: false, // 保存中(防重复)
    promptFields: [
      { key: 'imageStyle', label: '生图风格词根', placeholder: '追加在生图描述后,保证真实菜品照片' },
      { key: 'suggest', label: 'AI 推荐', placeholder: '定菜助手的 system 提示词' },
      { key: 'summary', label: 'AI 小结', placeholder: '报菜员的 system 提示词' },
      { key: 'recipe', label: 'AI 写做法', placeholder: '做法草稿的 system 提示词' },
    ],
  },

  onLoad() {
    this.init();
  },

  /** 进页守卫 + 拉取 AI 配置;非 admin 直接退回 */
  async init() {
    try {
      const { member } = await ensureIdentity();
      if (!isFamilyAdmin(member)) {
        this.onShowToast('#t-toast', '仅管理员可访问');
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.loadAiConfig();
    } catch (err) {
      console.error('身份加载失败', err);
      this.onShowToast('#t-toast', '身份加载失败，请稍后再试');
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  /* ---------------- AI 设置开关 ---------------- */

  /** 拉取 AI 配置刷新开关显示;若库里 aiEnabled 与派生值不一致(旧数据),自动修复 */
  async loadAiConfig() {
    try {
      const cfg = await getAiConfig();
      this.setData({
        aiImageEnabled: cfg.imageEnabled,
        aiTextEnabled: cfg.textEnabled,
        prompts: cfg.prompts, // F28:已归一化,缺失字段已被内置默认填充
      });
      // 自愈:历史数据可能存在「子开关开但总开关关」的死锁,按派生语义重写一次
      const derived = cfg.imageEnabled || cfg.textEnabled;
      if (derived && !cfg.aiEnabled) {
        await setAiConfig({ imageEnabled: cfg.imageEnabled, textEnabled: cfg.textEnabled });
      }
    } catch (err) {
      console.error('AI 配置加载失败', err);
    }
  },

  /** 切换开关:先读当前值再合并写全三字段(setAiConfig 整组覆盖,防误关另一开关) */
  async onAiImageSwitch(e) {
    this.saveAiSwitch('imageEnabled', !!e.detail.value, 'aiImageSwitching');
  },

  async onAiTextSwitch(e) {
    this.saveAiSwitch('textEnabled', !!e.detail.value, 'aiTextSwitching');
  },

  async saveAiSwitch(field, value, switchingKey) {
    if (this.data[switchingKey]) return;
    this.setData({ [switchingKey]: true });
    try {
      const cur = await getAiConfig();
      const next = { ...cur, [field]: value };
      await setAiConfig(next);
      this.setData({
        [switchingKey]: false,
        aiImageEnabled: next.imageEnabled,
        aiTextEnabled: next.textEnabled,
      });
      this.onShowToast('#t-toast', '已保存');
    } catch (err) {
      console.error('AI 配置保存失败', err);
      this.setData({ [switchingKey]: false });
      this.onShowToast('#t-toast', err.message || '保存失败，请重试');
    }
  },

  /** 跳转 AI 报菜员小结页(仅 textEnabled 时入口可见) */
  onSummaryTap() {
    wx.navigateTo({ url: '/packages/ai/summary' });
  },

  /* ---------------- 提示词管理(F28,单套可编辑) ---------------- */

  /** 提示词文本域输入:data-key 区分字段 */
  onPromptInput(e) {
    const { key } = e.currentTarget.dataset;
    this.setData({ [`prompts.${key}`]: e.detail.value });
  },

  /** 恢复默认:把该字段填回内置默认值(仅改编辑态,点保存才落库) */
  onPromptReset(e) {
    const { key } = e.currentTarget.dataset;
    this.setData({ [`prompts.${key}`]: DEFAULT_PROMPTS[key] });
  },

  /** 保存提示词:非空校验(空串回退由读取侧兼底,但保存时拦截更直观)→ setAiConfig(写后缓存已失效) */
  async onSavePrompts() {
    if (this.data.promptSaving) return;
    const { prompts } = this.data;
    const emptyKey = Object.keys(prompts).find((key) => !String(prompts[key] || '').trim());
    if (emptyKey) {
      this.onShowToast('#t-toast', '提示词不能为空');
      return;
    }
    this.setData({ promptSaving: true });
    try {
      const cfg = await setAiConfig({ prompts });
      // 以归一化后的值回填(去首尾空白),缓存已被 setAiConfig 清空
      this.setData({ promptSaving: false, prompts: cfg.prompts });
      this.onShowToast('#t-toast', '提示词已保存');
    } catch (err) {
      console.error('提示词保存失败', err);
      this.setData({ promptSaving: false });
      this.onShowToast('#t-toast', err.message || '保存失败，请重试');
    }
  },

  /* ---------------- AI 补图 ---------------- */

  /** 打开补图弹层:拉全量菜后滤 images 为空的;每次会话重新计数 */
  async onRepairTap() {
    try {
      const dishes = await fetchAllDishes();
      const repairItems = dishes
        .filter((d) => !(d.images && d.images.length > 0))
        .filter((d) => !!d._id) // 防御:缓存链路上的旧结构可能缺 _id,无 id 行无法写库,直接过滤
        .map((d) => ({
          _id: d._id,
          name: d.name,
          genLoading: false,
          previewUrl: '',
          previewFileId: '',
          error: '',
        }));
      this.repairGenerated = 0; // 本次弹层会话已生成张数
      this.setData({ repairItems, repairPopupVisible: true });
    } catch (err) {
      console.error('无图菜加载失败', err);
      this.onShowToast('#t-toast', '加载失败，请重试');
    }
  },

  /** 补图弹层遮罩关闭 */
  onRepairPopupVisibleChange(e) {
    const detail = e.detail || {};
    const visible = typeof detail === 'boolean' ? detail : detail.visible;
    if (visible === false) this.setData({ repairPopupVisible: false });
  },

  onRepairClose() {
    this.setData({ repairPopupVisible: false });
  },

  /** 局部更新一行补图项(先在内存对象上合并再整体替换:setData 路径数组下标赋值是整行替换,
   * 若直接把 patch 赋下去会丢掉行内其余字段——首次成功后 name 被清空,「重新生成」拿 undefined 当 prompt 崩溃) */
  patchRepairItem(index, patch) {
    const merged = { ...this.data.repairItems[index], ...patch };
    this.setData({ [`repairItems[${index}]`]: merged });
  },

  /** 生成/重新生成:超限拦截 → 生图(写实词根由 api 层统一追加)→ 换链后行内预览;失败行内红字 */
  async onRepairGenerate(e) {
    const { index } = e.currentTarget.dataset;
    const item = this.data.repairItems[index];
    if (!item || item.genLoading) return;
    if (this.repairGenerated >= REPAIR_LIMIT) {
      this.patchRepairItem(index, { error: `本次已生成 ${REPAIR_LIMIT} 张，请关闭弹层后重进` });
      return;
    }
    this.patchRepairItem(index, { genLoading: true, error: '' });
    try {
      const fileID = await generateDishImage(item.name);
      const urls = await resolveImgUrls([fileID]);
      this.repairGenerated += 1;
      this.patchRepairItem(index, {
        genLoading: false,
        previewFileId: fileID,
        previewUrl: urls[0] || '',
      });
    } catch (err) {
      console.error('AI 补图生成失败', err);
      this.patchRepairItem(index, { genLoading: false, error: err.message || '生成失败，请重试' });
    }
  },

  /** 采用:写库并检查 updated,成功后从列表移除该行 */
  async onRepairAdopt(e) {
    const { index } = e.currentTarget.dataset;
    const item = this.data.repairItems[index];
    if (!item || !item.previewFileId || item.genLoading) return;
    if (!item._id) {
      // 旧结构缓存缺 _id:不调 doc(),提示用户下拉刷新换新缓存后重试
      this.patchRepairItem(index, { genLoading: false, error: '数据缓存过期，请退出小程序重新进入后重试' });
      return;
    }
    this.patchRepairItem(index, { genLoading: true, error: '' });
    try {
      const updated = await attachImageToDish(item._id, item.previewFileId);
      if (updated !== 1) {
        this.patchRepairItem(index, { genLoading: false, error: '保存失败，请重试' });
        return;
      }
      this.setData({ repairItems: this.data.repairItems.filter((_, i) => i !== index) });
      this.onShowToast('#t-toast', '已添加');
    } catch (err) {
      console.error('AI 补图保存失败', err);
      this.patchRepairItem(index, { genLoading: false, error: '保存失败，请重试' });
    }
  },
});
