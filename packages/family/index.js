/**
 * packages/family/index.js
 * 家庭与成员管理页(admin 专用,分包页):
 * - 守卫:onLoad → ensureIdentity → 非 admin toast 后 navigateBack
 * - 我的信息卡:昵称 + 所属家庭名 + 管理员 tag
 * - 家庭管理(仅 admin):列表(点击重命名)+ 新建家庭,均用 t-dialog 内嵌 t-input
 *   (t-dialog 支持 content 插槽,已核对 miniprogram_npm/tdesign-miniprogram/dialog 源码)
 * - 成员管理:花名册列表,点击成员 → 底部 t-popup 选家庭(含「未分配」)→ setMemberFamily
 * - 未分配池:池条数 + 归池历史记录(migrateLegacyRecords)+ 划归家庭(assignPoolToFamily)
 * 交互从简:进页一次性加载 + 操作后局部刷新,不做骨架/下拉刷新。
 * 数据库操作一律走本分包 api.js(家庭数据)与主包 api/identity.js(身份)封装,页面不直接调用 wx.cloud。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import { ensureIdentity, isFamilyAdmin } from '../../api/identity.js';
import {
  listFamilies,
  createFamily,
  renameFamily,
  listMembers,
  setMemberFamily,
  countUnassignedPool,
  migrateLegacyRecords,
  fetchPoolPage,
  assignRecordToFamily,
  assignPoolToFamily,
} from './api.js';

Page({
  behaviors: [useToastBehavior],

  POOL_PAGE_SIZE: 10, // 池明细分页大小(实例属性,非响应式)

  data: {
    me: null, // 当前成员文档(信息卡展示;守卫与自身归属调整用)
    myFamilyName: '', // 我的所属家庭名('' 未分配显示「未分配」)
    families: [], // 家庭列表 [{_id, name}]
    members: [], // 花名册 [{_id, nickname, familyName}]
    poolCount: 0, // 未分配池条数
    poolRecords: [], // 池明细(当前已加载页) [{_id, dishName, date}]
    poolHasMore: false, // 是否还有下一页
    // 家庭名对话框:mode 区分新建/重命名(复用同一弹层)
    nameDialogVisible: false,
    nameDialogTitle: '',
    nameDialogMode: 'create', // create 新建 | rename 重命名
    nameInput: '',
    renameTargetId: '', // 重命名的家庭 _id
    // 成员归属选择弹层
    memberPopupVisible: false,
    activeMember: null, // 正在调整的成员文档
    // 划归家庭:先选家庭再二次确认(不可撤销,文案写清后果)
    assignPopupVisible: false,
    assignDialogVisible: false,
    assignFamilyId: '',
    assignFamilyName: '',
    assignMode: 'pool', // pool 整池划归 | record 单条划归
    assignRecordId: '', // mode=record 时目标记录 _id
  },

  onLoad() {
    this.init();
  },

  /** 进页守卫 + 一次性加载;非 admin 直接退回 */
  async init() {
    try {
      const { member } = await ensureIdentity();
      if (!isFamilyAdmin(member)) {
        this.onShowToast('#t-toast', '仅管理员可访问');
        setTimeout(() => wx.navigateBack(), 800);
        return;
      }
      this.member = member;
      await this.refresh();
    } catch (err) {
      console.error('身份加载失败', err);
      this.onShowToast('#t-toast', '身份加载失败，请稍后再试');
      setTimeout(() => wx.navigateBack(), 800);
    }
  },

  /** 刷新页面全部数据(信息卡 + 家庭 + 花名册 + 池条数与第一页明细) */
  async refresh() {
    try {
      const [families, members, poolCount] = await Promise.all([
        listFamilies(),
        listMembers(),
        countUnassignedPool(),
      ]);
      const nameById = {};
      families.forEach((f) => {
        nameById[f._id] = f.name;
      });
      const me = this.member || null;
      this.setData({
        me,
        myFamilyName: me && me.familyId ? nameById[me.familyId] || '未知家庭' : '',
        families: families.map((f) => ({ _id: f._id, name: f.name })),
        members: members.map((m) => ({
          _id: m._id,
          nickname: m.nickname || '未命名',
          familyId: m.familyId || '',
          familyName: m.familyId ? nameById[m.familyId] || '未知家庭' : '',
        })),
        poolCount,
      });
      await this.reloadPool();
    } catch (err) {
      console.error('管理数据加载失败', err);
      this.onShowToast('#t-toast', '加载失败，请重试');
    }
  },

  /* ---------------- 未分配池明细(分页) ---------------- */

  /** 重新从第一页拉池明细(划归/归池后调用,池内容变化) */
  async reloadPool() {
    this.poolSkip = 0;
    const page = await fetchPoolPage(0, this.POOL_PAGE_SIZE);
    this.setData({
      poolRecords: page,
      poolHasMore: page.length >= this.POOL_PAGE_SIZE && page.length < this.data.poolCount,
    });
  },

  /** 加载下一页追加(点击「加载更多」) */
  async onPoolMore() {
    try {
      const skip = (this.data.poolRecords || []).length;
      const page = await fetchPoolPage(skip, this.POOL_PAGE_SIZE);
      this.setData({
        poolRecords: this.data.poolRecords.concat(page),
        poolHasMore: page.length >= this.POOL_PAGE_SIZE,
      });
    } catch (err) {
      console.error('池明细加载失败', err);
      this.onShowToast('#t-toast', '加载失败，请重试');
    }
  },

  /* ---------------- 家庭管理:新建 / 重命名 ---------------- */

  /** 点击「+ 新建家庭」:打开新建对话框 */
  onCreateFamilyTap() {
    this.setData({
      nameDialogVisible: true,
      nameDialogTitle: '新建家庭',
      nameDialogMode: 'create',
      nameInput: '',
      renameTargetId: '',
    });
  },

  /** 点击家庭 cell:打开重命名对话框(预填当前名) */
  onFamilyTap(e) {
    const { id, name } = e.currentTarget.dataset;
    this.setData({
      nameDialogVisible: true,
      nameDialogTitle: '重命名家庭',
      nameDialogMode: 'rename',
      nameInput: name,
      renameTargetId: id,
    });
  },

  onNameInput(e) {
    this.setData({ nameInput: e.detail.value || '' });
  },

  onNameDialogClose() {
    this.setData({ nameDialogVisible: false });
  },

  /** 确认新建/重命名:api 内已做非空与重名校验,失败原样透出错误消息 */
  async onNameDialogConfirm() {
    const { nameDialogMode, nameInput, renameTargetId } = this.data;
    const name = (nameInput || '').trim();
    if (!name) {
      this.onShowToast('#t-toast', '家庭名不能为空');
      return;
    }
    try {
      if (nameDialogMode === 'create') {
        await createFamily(name);
      } else {
        await renameFamily(renameTargetId, name);
      }
      this.setData({ nameDialogVisible: false });
      this.onShowToast('#t-toast', nameDialogMode === 'create' ? '已新建' : '已重命名');
      this.refresh();
    } catch (err) {
      console.error('家庭保存失败', err);
      this.onShowToast('#t-toast', err.message || '操作失败，请重试');
    }
  },

  /* ---------------- 成员归属调整 ---------------- */

  /** 点击成员 cell:打开归属选择弹层(未分配 + 全部家庭) */
  onMemberTap(e) {
    const { id } = e.currentTarget.dataset;
    const member = this.data.members.find((m) => m._id === id);
    if (!member) return;
    this.setData({ activeMember: member, memberPopupVisible: true });
  },

  /** 归属弹层遮罩关闭(受控组件需回写 visible) */
  onMemberPopupVisibleChange(e) {
    const detail = e.detail || {};
    const visible = typeof detail === 'boolean' ? detail : detail.visible;
    if (visible === false) this.setData({ memberPopupVisible: false });
  },

  /** 划归选择弹层遮罩关闭(受控组件需回写 visible) */
  onAssignPopupVisibleChange(e) {
    const detail = e.detail || {};
    const visible = typeof detail === 'boolean' ? detail : detail.visible;
    if (visible === false) this.setData({ assignPopupVisible: false });
  },

  /** 选择目标家庭:未分配传 ''(移回未分配池);可把自己也调整 */
  async onFamilyOptionTap(e) {
    const { familyId } = e.currentTarget.dataset;
    const member = this.data.activeMember;
    if (!member) return;
    try {
      await setMemberFamily(member._id, familyId);
      // 改的是自己:同步本地 member,信息卡与守卫判定保持最新
      if (this.member && this.member._id === member._id) {
        this.member.familyId = familyId;
      }
      this.setData({ memberPopupVisible: false });
      this.onShowToast('#t-toast', '已调整');
      this.refresh();
    } catch (err) {
      console.error('成员归属调整失败', err);
      this.onShowToast('#t-toast', '操作失败，请重试');
    }
  },

  /* ---------------- 未分配池:归池 / 划归 ---------------- */

  /** 点击池里某条记录:单条划归(选家庭后只改这一条) */
  onPoolRecordTap(e) {
    const { id } = e.currentTarget.dataset;
    if (this.data.families.length === 0) {
      this.onShowToast('#t-toast', '请先新建家庭');
      return;
    }
    this.setData({ assignMode: 'record', assignRecordId: id, assignPopupVisible: true });
  },

  /** 归池历史记录:把无 familyId 字段的存量旧记录补成 ''(幂等) */
  async onMigrateTap() {
    try {
      const count = await migrateLegacyRecords();
      this.onShowToast('#t-toast', count > 0 ? `已归池 ${count} 条` : '没有需要归池的记录');
      this.refresh();
    } catch (err) {
      console.error('归池历史记录失败', err);
      this.onShowToast('#t-toast', '操作失败，请重试');
    }
  },

  /** 划归家庭(整池):需已有家庭且池数 > 0;先弹家庭选择,选中后二次确认(不可撤销) */
  onAssignTap() {
    if (this.data.families.length === 0) {
      this.onShowToast('#t-toast', '请先新建家庭');
      return;
    }
    if (this.data.poolCount === 0) {
      this.onShowToast('#t-toast', '未分配池是空的');
      return;
    }
    this.setData({ assignMode: 'pool', assignRecordId: '', assignPopupVisible: true });
  },

  onAssignPopupClose() {
    this.setData({ assignPopupVisible: false });
  },

  /** 选中目标家庭:关选择弹层,开确认弹层(文案写清「不可撤销」) */
  onAssignFamilyTap(e) {
    const { id, name } = e.currentTarget.dataset;
    this.setData({
      assignPopupVisible: false,
      assignFamilyId: id,
      assignFamilyName: name,
      assignDialogVisible: true,
    });
  },

  onAssignDialogClose() {
    this.setData({ assignDialogVisible: false });
  },

  /** 划归家庭确认弹层关闭(遮罩):仅收起 */
  onAssignCancel() {
    this.setData({ assignDialogVisible: false });
  },

  /** 确认划归:整池(assignPoolToFamily)或单条(assignRecordToFamily),均不可撤销 */
  async onAssignConfirm() {
    const { assignFamilyId, assignMode, assignRecordId, poolRecords } = this.data;
    this.setData({ assignDialogVisible: false });
    if (!assignFamilyId) return;
    try {
      if (assignMode === 'record') {
        await assignRecordToFamily(assignRecordId, assignFamilyId);
        this.onShowToast('#t-toast', '已划归');
      } else {
        const count = await assignPoolToFamily(assignFamilyId);
        this.onShowToast('#t-toast', `已划归 ${count} 条`);
      }
      // 单条划归后该记录已不在池里,本地移除比整页刷新更顺滑(池计数仍需 refresh 校准)
      if (assignMode === 'record') {
        const rest = poolRecords.filter((r) => r._id !== assignRecordId);
        this.setData({ poolRecords: rest });
        countUnassignedPool().then((total) => this.setData({
          poolCount: total,
          poolHasMore: this.data.poolHasMore && rest.length >= this.POOL_PAGE_SIZE,
        }));
      } else {
        this.refresh();
      }
    } catch (err) {
      console.error('划归失败', err);
      this.onShowToast('#t-toast', '操作失败，请重试');
    }
  },
});
