/**
 * packages/dish/detail.js
 * 菜品详情页
 * - onLoad(options.id) → getDish 全量渲染,首屏加载态;失败 toast + 返回
 * - 图片区:t-swiper 轮播(云端 fileID 直接渲染);无图显示分类 emoji 占位(meal🍜/drink🥤)
 * - 头部卡:菜名、细分 tags、cookTime · difficulty 徽章、isBuiltin「内置」角标
 * - 原料卡:dish.ingredients 逐行「名称 + 用量」,调料行名称后加灰字「(调料)」
 * - 做法卡:steps 有序步骤列表,为空显示引导文案
 * - 底部操作栏:编辑 → /packages/dish/edit?id=;删除 → t-dialog 确认 → removeDish → toast → 返回
 * - 图片预览:点击轮播 wx.previewImage
 * 数据库操作一律走 api/db.js,页面不直接调用 wx.cloud。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import { getDish, removeDish } from '../../api/db.js';
import { SEASONING_SET } from '../../utils/seasonings.js';

Page({
  behaviors: [useToastBehavior],

  data: {
    id: '', // 菜品 _id
    loading: true, // 首屏加载态
    dish: null, // 菜品文档
    images: [], // 图片 fileID 数组(轮播数据)
    emoji: '🍜', // 无图时的分类占位 emoji(meal🍜 / drink🥤)
    ingredients: [], // 原料明细(含用量与调料标记)
    deleteVisible: false, // 删除确认弹窗
    deleting: false, // 删除进行中(防重复提交)
  },

  onLoad(options) {
    this.setData({ id: options.id || '' });
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
      // 图片:有云端 fileID 直接渲染;无图时轮播区显示分类 emoji 占位
      const images = dish.images || [];
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
    const index = e.detail.index;
    wx.previewImage({ current: images[index] || images[0], urls: images });
  },

  /** 底部「编辑」:跳转编辑页 */
  goEdit() {
    wx.navigateTo({ url: `/packages/dish/edit?id=${this.data.id}` });
  },

  /** 底部「删除」:打开确认弹窗 */
  onDeleteTap() {
    this.setData({ deleteVisible: true });
  },

  /** 删除弹窗取消 */
  onDeleteCancel() {
    this.setData({ deleteVisible: false });
  },

  /** 删除弹窗确认:removeDish(内部先清理云存储图片,records 历史保留) */
  async onDeleteConfirm() {
    if (this.data.deleting) return;
    this.setData({ deleting: true, deleteVisible: false });
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
