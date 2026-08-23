/**
 * pages/more/index.js
 * 更多页:功能入口列表
 * - 原料库:跳转分包 packages/ingredient
 * - 初始化内置菜谱:调 api/seed.js 的 importBuiltinData(app_meta 锁协议,幂等增量导入+进度反馈)
 */
import useToastBehavior from '../../behaviors/useToast.js';
import { importBuiltinData } from '../../api/seed.js';

Page({
  behaviors: [useToastBehavior],

  data: {
    importing: false, // 导入中标志,防重复点击
  },

  /** 跳转原料库管理页(分包 packages/ingredient) */
  goIngredient() {
    wx.navigateTo({ url: '/packages/ingredient/index' });
  },

  /** 初始化内置菜谱:幂等增量导入(按菜名跳过已存在),导入中 loading 实时进度,完毕 toast 反馈 */
  async goImportBuiltin() {
    if (this.data.importing) return;
    this.setData({ importing: true });
    this.progressTitle = '';
    // 先给初始 loading(原料 ensure 阶段较长,避免无反馈),onProgress 里更新精确进度
    wx.showLoading({ title: '正在导入…', mask: true });
    try {
      const res = await importBuiltinData({
        reimport: true,
        onProgress: (done, total) => {
          const title = `正在导入 ${done}/${total}`;
          // title 未变化时跳过,避免高频 showLoading 造成闪烁
          if (this.progressTitle !== title) {
            this.progressTitle = title;
            wx.showLoading({ title, mask: true });
          }
        },
      });
      wx.hideLoading();
      // 结果反馈:新增 / 已最新 / 失败三档组合
      const tips = [];
      if (res.importedDishes > 0) tips.push(`已导入 ${res.importedDishes} 道菜`);
      if (res.skippedDishes === res.total && res.importedDishes === 0) tips.push('内置菜谱已是最新');
      if (res.failed.length > 0) tips.push(`有 ${res.failed.length} 道失败，可再次点击重试`);
      this.onShowToast('#t-toast', tips.join('；') || '导入完成');
    } catch (err) {
      wx.hideLoading();
      console.error('内置数据导入失败', err);
      this.onShowToast('#t-toast', '导入失败，请重试');
    } finally {
      this.setData({ importing: false });
    }
  },
});
