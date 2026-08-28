/**
 * pages/more/index.js
 * 更多页:功能入口列表
 * - 原料库:跳转分包 packages/ingredient
 * - 初始化内置菜谱:调 api/seed.js 的 importBuiltinData(app_meta 锁协议,幂等增量导入+进度反馈)
 * - 上传内置图到云:调 api/upload.js 的 uploadBuiltinImages(一次性上云,主包瘦身)
 */
import useToastBehavior from '../../behaviors/useToast.js';
import { importBuiltinData } from '../../api/seed.js';
import { listDishes } from '../../api/db.js';
import { isBuiltinImageMapComplete, loadBuiltinImageMap, uploadBuiltinImages } from '../../api/upload.js';
import { ensureIdentity, isFamilyAdmin } from '../../api/identity.js';

Page({
  behaviors: [useToastBehavior],

  data: {
    importing: false, // 导入中标志,防重复点击
    uploading: false, // 内置图上云中标志,防重复点击
    isAdmin: false, // 是否家庭管理员(管理入口仅 admin 可见)
  },

  onShow() {
    // 每次进入实查身份:isAdmin 可能被其他设备随时改动,不可缓存
    this.loadIdentity();
  },

  /** 加载身份并刷新 admin 标记;失败静默(入口保持隐藏,不阻塞其他功能) */
  async loadIdentity() {
    try {
      const { member } = await ensureIdentity();
      this.member = member;
      this.setData({ isAdmin: isFamilyAdmin(member) });
    } catch (err) {
      console.error('身份加载失败', err);
    }
  },

  /** 跳转家庭与成员管理页(分包 packages/family) */
  goFamily() {
    wx.navigateTo({ url: '/packages/family/index' });
  },

  /** 跳转 AI 设置页(分包 packages/dish/ai;主包零 import 分包,仅页面跳转) */
  onAiSettings() {
    wx.navigateTo({ url: '/packages/dish/ai/settings' });
  },

  /** 跳转原料库管理页(分包 packages/ingredient) */
  goIngredient() {
    wx.navigateTo({ url: '/packages/ingredient/index' });
  },

  /** 初始化内置菜谱:库里已有数据时先温和确认(初始化是幂等增量,不会覆盖用户修改与图片) */
  async goImportBuiltin() {
    if (this.data.importing) return;
    // 防误操作预检:轻查一页,已有菜谱则弹温和确认(不是报错),取消直接返回零副作用
    try {
      const check = await listDishes({ pageSize: 1 });
      if (check.total > 0) {
        const confirm = await wx.showModal({
          title: '确认初始化？',
          content: '检测到已有菜谱数据。再次初始化仅补齐缺失菜品，不会覆盖你的修改与图片。是否继续？',
          confirmText: '继续',
          cancelText: '取消',
        });
        if (!confirm.confirm) return;
      }
    } catch (err) {
      // 预检/确认异常:不阻断,交给导入自身处理(与原行为一致)
    }
    this.setData({ importing: true });
    this.progressTitle = '';
    // 先给初始 loading(原料 ensure 阶段较长,避免无反馈),onProgress 里更新精确进度
    wx.showLoading({ title: '导入中…', mask: true });
    try {
      const res = await importBuiltinData({
        onProgress: (done, total) => {
          const title = `导入 ${done}/${total}`;
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

  /** 上传内置图到云:预检已完整则提示无需重复;否则 loading 实时进度上传,完毕按结果反馈 */
  async goUploadBuiltinImages() {
    if (this.data.uploading) return;
    this.setData({ uploading: true });
    try {
      // 预检:已完整上云(覆盖 80 键)直接提示,不执行、不报错
      const cloudMap = await loadBuiltinImageMap();
      if (isBuiltinImageMapComplete(cloudMap)) {
        this.onShowToast('#t-toast', '内置图已上传至云端，无需重复操作');
        return;
      }
      this.progressTitle = '';
      wx.showLoading({ title: '正在上传 0/180', mask: true });
      const res = await uploadBuiltinImages({
        onProgress: (done, total) => {
          const title = `正在上传 ${done}/${total}`;
          // title 未变化时跳过,避免高频 showLoading 造成闪烁
          if (this.progressTitle !== title) {
            this.progressTitle = title;
            wx.showLoading({ title, mask: true });
          }
        },
      });
      wx.hideLoading();
      // 结果反馈:本次上传张数 + 失败数(可重试,重试只补缺失)
      const tips = [];
      if (res.uploaded > 0) tips.push(`已上传 ${res.uploaded} 张`);
      if (res.failed.length > 0) tips.push(`有 ${res.failed.length} 张失败，可再次点击重试`);
      this.onShowToast('#t-toast', tips.join('；') || '内置图已全部在云端');
    } catch (err) {
      wx.hideLoading();
      console.error('内置图上传失败', err);
      this.onShowToast('#t-toast', '上传失败，请重试');
    } finally {
      this.setData({ uploading: false });
    }
  },
});
