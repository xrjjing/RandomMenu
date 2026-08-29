/**
 * packages/dish/detail.js
 * 菜品详情页
 * - onLoad(options.id) → getDish 全量渲染,首屏加载态;失败 toast + 返回
 * - 图片区:t-swiper 轮播(云端 fileID 直接渲染);无图显示分类 emoji 占位(meal🍜/drink🥤)
 * - 头部卡:菜名、细分 tags、cookTime · difficulty 徽章、isBuiltin「内置」角标
 * - 原料卡:dish.ingredients 逐行「名称 + 用量」,调料行名称后加灰字「(调料)」
 * - 做法卡:steps 有序步骤列表,为空显示引导文案
 * - 底部操作栏:编辑 → /packages/dish/edit?id=;删除 → 两层确认(t-dialog:删除确认 → 再次确认)→ removeDish → toast → 返回
 * - 图片预览:点击轮播 wx.previewImage
 * 数据库操作一律走 api/db.js,页面不直接调用 wx.cloud。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import { getDish, removeDish } from '../../api/db.js';
import { SEASONING_SET } from '../../utils/seasonings.js';
import { orderDishImages } from '../../utils/image.js';
import { resolveImgUrls } from '../../utils/imgUrl.js';
import { getAiConfig } from './ai/config.js';
import { generateDishTips } from './ai/tips.js';

Page({
  behaviors: [useToastBehavior],

  data: {
    id: '', // 菜品 _id
    loading: true, // 首屏加载态
    dish: null, // 菜品文档
    images: [], // 图片 fileID 数组(轮播数据)
    emoji: '🍜', // 无图时的分类占位 emoji(meal🍜 / drink🥤)
    ingredients: [], // 原料明细(含用量与调料标记)
    deleteVisible: false, // 第一层删除确认弹窗
    deleteReconfirmVisible: false, // 第二层「再次确认」弹窗(防误删,第一层确定后弹出)
    deleteReconfirmBtn: { content: '删除', theme: 'danger' }, // 第二层确认按钮(danger 红色)
    deleting: false, // 删除进行中(防重复提交)
    textEnabled: false, // AI 生文开关(小贴士入口可见性)
    tipsPopupVisible: false, // AI 小贴士弹层
    tipsQuestion: '', // 小贴士问题输入
    tipsResult: '', // 生成结果
    tipsError: '', // 生成失败文案
    tipsGenerating: false, // 生成中(防重复)
    tipsStream: '', // 贴士生成中流式回显(完成后清空)
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
    // 小贴士入口开关(失败按 false,不弹错误)
    getAiConfig()
      .then((cfg) => this.setData({ textEnabled: cfg.textEnabled }))
      .catch(() => {});
    this.needsRefresh = false; // 从编辑页返回后是否需要静默刷新
    this.loadDish();
  },

  onShow() {
    // 从编辑页返回(可能保存过)时静默刷新,保证展示最新数据
    if (this.needsRefresh) {
      this.needsRefresh = false;
      this.loadDish(true);
    }
  },

  onHide() {
    this.needsRefresh = true;
  },

  /** 拉取菜品详情并渲染;silent=true 为静默刷新(不显示加载态,失败保留旧数据) */
  async loadDish(silent) {
    if (!silent) this.setData({ loading: true });
    try {
      const dish = await getDish(this.data.id);
      // 图片:云端 fileID 在前、内置静态图在后(置顶判断,用户上传图不被内置占位图顶掉),空值剔除
      // cloud:// 换链为 https 临时链接后显示(非创建者手机也能看);dish 对象保留原 fileID 不动
      // 换链失败的项回 ''——这里过滤后再 setData,避免轮播渲染空白页(应回落到 emoji 占位)
      const images = (await resolveImgUrls(orderDishImages(dish.images))).filter(Boolean);
      // 原料明细兜底:老数据可能只有 ingredientNames 无用量明细
      const ingredients =
        dish.ingredients && dish.ingredients.length
          ? dish.ingredients
          : (dish.ingredientNames || []).map((name) => ({
              id: '',
              name,
              amount: '',
              isSeasoning: SEASONING_SET.has(name),
            }));
      const patch = {
        dish,
        images,
        emoji: dish.category === 'drink' ? '🥤' : '🍜',
        ingredients,
        // 换菜/刷新后旧贴士可能串题,直接清空(弹层通常已关闭)
        tipsResult: '',
        tipsError: '',
        tipsStream: '',
      };
      if (!silent) patch.loading = false;
      this.setData(patch);
    } catch (err) {
      console.error('菜品详情加载失败', err);
      if (silent) return; // 静默刷新失败:保留旧数据
      this.setData({ loading: false });
      this.onShowToast('#t-toast', '加载失败，请重试');
      // 稍作停留提示后返回上一页
      setTimeout(() => wx.navigateBack(), 1200);
    }
  },

  /** 点击轮播图:全屏预览当前图片 */
  onImagePreview(e) {
    const { images } = this.data;
    if (images.length === 0) return;
    const { index } = e.detail;
    wx.previewImage({ current: images[index] || images[0], urls: images });
  },

  /** 底部「编辑」:跳转编辑页 */
  goEdit() {
    wx.navigateTo({ url: `/packages/dish/edit?id=${this.data.id}` });
  },

  /** 打开 AI 小贴士弹层 */
  onTipsTap() {
    this.setData({ tipsPopupVisible: true });
  },

  /** 小贴士弹层显隐变化 */
  onTipsPopupVisibleChange(e) {
    if (!e.detail.visible) this.setData({ tipsPopupVisible: false });
  },

  /** 关闭小贴士弹层 */
  onTipsClose() {
    this.setData({ tipsPopupVisible: false });
  },

  /** 小贴士问题输入 */
  onTipsQuestionInput(e) {
    this.setData({ tipsQuestion: e.detail.value });
  },

  /** 生成小贴士 */
  async onTipsGenerate() {
    if (this.data.tipsGenerating) return;
    this.setData({ tipsGenerating: true, tipsError: '', tipsResult: '', tipsStream: '' });
    const res = await generateDishTips({
      name: this.data.dish.name,
      ingredients: this.data.ingredients,
      question: this.data.tipsQuestion,
      // 流式:生成中实时回显到弹层,完成后统一渲染 tipsResult
      onChunk: (chunk) => {
        this.setData({ tipsStream: this.data.tipsStream + chunk });
      },
    });
    if (res.ok) {
      this.setData({ tipsGenerating: false, tipsResult: res.text, tipsStream: '' });
    } else {
      this.setData({ tipsGenerating: false, tipsError: res.error, tipsStream: '' });
    }
  },

  /** 底部「删除」:打开第一层确认弹窗 */
  onDeleteTap() {
    this.setData({ deleteVisible: true });
  },

  /** 第一层删除弹窗取消:直接关闭,安全返回 */
  onDeleteCancel() {
    this.setData({ deleteVisible: false });
  },

  /** 第一层删除弹窗确认:关闭第一层,打开第二层「再次确认」(此时尚未执行删除) */
  onDeleteConfirm() {
    this.setData({ deleteVisible: false, deleteReconfirmVisible: true });
  },

  /** 第二层「再次确认」取消:直接关闭,安全返回 */
  onDeleteReconfirmCancel() {
    this.setData({ deleteReconfirmVisible: false });
  },

  /** 第二层「再次确认」确定:才真正执行 removeDish(内部先清理云存储图片,records 历史保留) */
  async onDeleteReconfirmConfirm() {
    if (this.data.deleting) return;
    this.setData({ deleting: true, deleteReconfirmVisible: false });
    try {
      await removeDish(this.data.id);
      this.onShowToast('#t-toast', '已删除');
      setTimeout(() => wx.navigateBack(), 800);
    } catch (err) {
      console.error('删除菜品失败', err);
      this.setData({ deleting: false });
      this.onShowToast('#t-toast', '操作失败，请重试');
    }
  },
});
