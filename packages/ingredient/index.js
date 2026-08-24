/**
 * packages/ingredient/index.js
 * 原料库管理页(分包)
 * - 顶部搜索框:输入防抖 300ms 后按名称模糊过滤(listIngredients)
 * - 列表:原料名 + 被引用菜品次数(进入页面拉一次 ingredientUsage 建 Map)+ 调料小标签
 * - 新增:归一化后 ensureIngredient,已存在则 toast 并高亮该行
 * - 重命名:renameIngredient,撞名合并时 toast 提示,随后刷新
 * - 删除:确认后 removeIngredient(仅解除菜品引用,不删菜品)
 * 数据库操作一律走 api/db.js 封装,页面不直接调用 wx.cloud。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import {
  ensureIngredient,
  ingredientUsage,
  listIngredients,
  removeIngredient,
  renameIngredient,
} from '../../api/db.js';
import { SEASONING_SET } from '../../utils/seasonings.js';

Page({
  behaviors: [useToastBehavior],

  data: {
    loading: true, // 首次进入 / 刷新时加载态
    keyword: '', // 搜索关键字
    list: [], // 展示行:{_id, name, usage, isSeasoning, highlight}
    editDialogVisible: false, // 新增 / 重命名弹层
    editMode: '', // 'add' | 'rename'
    editDialogTitle: '',
    editPlaceholder: '',
    editName: '',
    editingId: '',
    deleteDialogVisible: false, // 删除确认弹层
    deleteTip: '',
    deleteConfirmBtn: {}, // 透传给 t-dialog 确认按钮(红色删除)
    deleteId: '',
  },

  onLoad() {
    // 实例级状态:避免 Page 配置对象上的引用类型被多实例共享
    this.usageMap = new Map();
    this.searchTimer = null;
    this.highlightTimer = null;
    // 进入页面属整页刷新时机:强制穿透缓存直查云库,家人改过原料后进入即最新
    this.refresh(true);
  },

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
  },

  /** 统一刷新:并行拉原料列表与使用次数统计,再组装展示行。
   *  force=true 强制穿透缓存(进入页面/整页刷新);搜索防抖/操作后刷新走缓存(markDirty 已失效) */
  async refresh(force = false) {
    this.setData({ loading: true });
    try {
      const [ingredients, usage] = await Promise.all([
        listIngredients(this.data.keyword, { force }),
        ingredientUsage(),
      ]);
      this.usageMap = new Map(usage.map((item) => [item.name, item.count]));
      this.applyList(ingredients);
    } catch (err) {
      console.error('原料列表加载失败', err);
      this.showFail();
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 把原始原料数组组装为展示行:附使用次数、调料标记;默认按次数降序,次数相同按名称 */
  applyList(ingredients) {
    const list = ingredients.map((item) => ({
      _id: item._id,
      name: item.name,
      usage: this.usageMap.get(item.name) || 0,
      isSeasoning: SEASONING_SET.has(item.name),
      highlight: false,
    }));
    list.sort((a, b) => b.usage - a.usage || a.name.localeCompare(b.name));
    this.setData({ list });
  },

  /** 搜索输入:防抖 300ms 后重新查询 */
  onSearchChange(e) {
    const keyword = (e.detail.value || '').trim();
    this.setData({ keyword });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.refresh(), 300);
  },

  /** 点击清除图标:立即恢复全量列表 */
  onSearchClear() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.setData({ keyword: '' });
    this.refresh();
  },

  /** 底部主按钮:打开新增弹层 */
  onAddTap() {
    this.setData({
      editMode: 'add',
      editDialogTitle: '新增原料',
      editPlaceholder: '请输入原料名称',
      editName: '',
      editingId: '',
      editDialogVisible: true,
    });
  },

  /** 点击列表行:打开重命名弹层(预填当前名称) */
  onRowTap(e) {
    const { id, name } = e.currentTarget.dataset;
    this.setData({
      editMode: 'rename',
      editDialogTitle: '重命名原料',
      editPlaceholder: '请输入新名称',
      editName: name,
      editingId: id,
      editDialogVisible: true,
    });
  },

  onEditNameChange(e) {
    this.setData({ editName: e.detail.value || '' });
  },

  onEditCancel() {
    this.setData({ editDialogVisible: false });
  },

  /** 弹层确认:新增走 ensureIngredient,重命名走 renameIngredient(撞名合并有提示) */
  async onEditConfirm() {
    const name = (this.data.editName || '').trim();
    if (!name) {
      this.onShowToast('#t-toast', '请输入原料名称');
      return;
    }
    const { editMode, editingId } = this.data;
    this.setData({ editDialogVisible: false });
    try {
      if (editMode === 'add') {
        const res = await ensureIngredient(name);
        if (res.isNew) {
          this.onShowToast('#t-toast', '已添加');
          await this.refresh();
        } else {
          this.onShowToast('#t-toast', '已存在');
          await this.highlightIngredient(res.name);
        }
      } else {
        const res = await renameIngredient(editingId, name);
        this.onShowToast('#t-toast', res.merged ? '已与既有原料合并' : '已重命名');
        await this.refresh();
      }
    } catch (err) {
      console.error('保存原料失败', err);
      this.showFail();
    }
  },

  /** 高亮指定原料行:清空搜索后刷新列表,给目标行高亮 2 秒便于定位 */
  async highlightIngredient(name) {
    if (this.data.keyword) {
      this.setData({ keyword: '' });
    }
    await this.refresh();
    const mark = (highlight) =>
      this.data.list.map((item) => ({
        ...item,
        highlight: item.name === name ? highlight : false,
      }));
    this.setData({ list: mark(true) });
    if (this.highlightTimer) clearTimeout(this.highlightTimer);
    this.highlightTimer = setTimeout(() => this.setData({ list: mark(false) }), 2000);
  },

  /** 行右侧删除按钮:打开确认弹层,文案注明影响菜品数(来自使用次数 Map) */
  onDeleteTap(e) {
    const { id, usage } = e.currentTarget.dataset;
    this.setData({
      deleteId: id,
      deleteTip: `将解除 ${usage} 道菜品的关联，不会删除菜品`,
      deleteConfirmBtn: { content: '删除', theme: 'danger' },
      deleteDialogVisible: true,
    });
  },

  onDeleteCancel() {
    this.setData({ deleteDialogVisible: false });
  },

  /** 确认删除:仅解除菜品引用,随后刷新列表与使用次数 */
  async onDeleteConfirm() {
    const { deleteId } = this.data;
    this.setData({ deleteDialogVisible: false });
    try {
      await removeIngredient(deleteId);
      this.onShowToast('#t-toast', '已删除');
      await this.refresh();
    } catch (err) {
      console.error('删除原料失败', err);
      this.showFail();
    }
  },

  /** 统一失败提示:所有 db 操作失败走这里 */
  showFail() {
    this.onShowToast('#t-toast', '操作失败，请重试');
  },
});
