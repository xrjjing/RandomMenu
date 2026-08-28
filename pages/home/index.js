/**
 * pages/home/index.js
 * 首页(主包 tab「首页」):今日已定 + 按料找菜 + 手选落账(转盘为 M3-b 独立组件)
 * - 今明已定卡(F25):upcomingRecords() 三分组(今天/明天/后天,空组整组不渲染),
 *   每行「原料」弹层查看 + 整行点击跳详情;撤销按钮仅今天组展示 → t-dialog 确认
 *   → undoLastTodayRecord(删除的是当天最后一条记录,弹层文案写清)→ 刷新
 * - 落账确认弹层(F25):「就做这道？」与转盘结果均改为底部 t-popup,
 *   加今天/明天/后天三选;addCookRecord 按三选写入对应 dateKey(自然进位跨月跨年),
 *   toast 文案:今天→「已记录」,明天/后天→「已定到 X M/D」
 * - 冰箱里有什么:横向 chips 多选原料(listIngredients 全量排除调料 isSeasoning),
 *   顶部小 t-search 防抖 300ms 过滤;已选原料可再点取消
 * - 匹配结果区(按需展示):
 *   - 未选原料且未选分类:「未搜索」引导态——不查询不展示列表,显示引导文案 + 三个分类入口 chips(全部/餐食/饮品)
 *   - 点击分类 chip(或选了原料后):立即查询展示;chips 上出现选中态
 *   - 已选原料:matchDishesByIngredients(dishesSnapshot, selected, {mode}) 内存快照匹配;t-switch 切「有交集即可 / 完全匹配」;
 *     点击卡片 → t-dialog「就做这道?」→ addCookRecord 落账 → toast「已记录」→ 刷新今日卡
 *   - 未选原料但已选分类:listDishes 按分类浏览(新增 category 条件),触底翻页
 *   - 取消勾选全部原料后回到「未搜索」引导态
 * - 随机转盘:候选 = 当前匹配结果(未选原料时=全部菜品,点击时拉全量);半屏 t-popup 内嵌
 *   spin-wheel 组件,「开始旋转」调组件 spin()(旋转中按钮置灰);spinend 高亮停留 800ms
 *   后先收转盘再弹结果(F17,绕开 dialog 与 popup 平叠 z-index 不生效问题),
 *   「就吃它了」落账 /「换一个」关结果重开转盘再转
 * - 菜品全量内存快照(dishesSnapshot):onShow 时若脏则重拉,「点原料→匹配」走内存匹配(0ms);
 *   onHide 置脏,切 tab / 从编辑页返回都走 onShow 重拉,保证匹配用最新数据;
 *   下拉刷新强制重拉(多设备一致性:家人任一手机改库后下拉即最新)
 * - onShow 静默刷新今日记录(tab 切回数据最新)
 * 数据库操作一律走 api/db.js 封装,页面不直接调用 wx.cloud。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import {
  addCookRecord,
  dateKey,
  fetchAllDishes,
  listDishes,
  listIngredients,
  matchDishesByIngredients,
  upcomingRecords,
  deleteRecord,
  undoLastTodayRecord,
  DISH_CARD_FIELDS,
} from '../../api/db.js';
import { SEASONING_SET } from '../../utils/seasonings.js';
import { ensureIdentity, registerMember } from '../../api/identity.js';
import { normalizeName } from '../../utils/normalize.js';
import { orderDishImages } from '../../utils/image.js';
import { resolveImgUrls } from '../../utils/imgUrl.js';

/** 每页条数(与云数据库客户端单次 limit 上限一致) */
const PAGE_SIZE = 20;

/**
 * 纯函数:关键词模糊匹配(菜名 或 原料名 包含关键词)。
 * 纯前端内存操作,基于首页全量快照;关键词已由调用方归一化(utils/normalize.js)。
 * 不做拼音(任务书明确不做);中文名包含匹配即可。
 * @param {Array} dishes 菜品全量快照(fetchAllDishes 结果)
 * @param {string} kw 已归一化的关键词
 * @returns {Array} 命中的菜品数组(保持快照原顺序)
 */
function matchDishesByKeyword(dishes, kw) {
  if (!Array.isArray(dishes) || !kw) return [];
  return dishes.filter((dish) => {
    if (dish.name && dish.name.includes(kw)) return true;
    return (dish.ingredientNames || []).some((name) => name.includes(kw));
  });
}

/** 服务端时间格式化为本地 HH:mm(今日已定列表展示用) */
function formatHHmm(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** F25 三选日期换算:今天/明天/后天 → dateKey(Date 自然进位,跨月跨年正确) */
function dateKeyOffset(n) {
  return dateKey(new Date(Date.now() + n * 86400000));
}

/** 'YYYY-MM-DD' → 'M/D'(去前导零,分组标题与 toast 文案用) */
function mdLabel(dateStr) {
  const [, m, d] = dateStr.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}

/** 三选 key → 偏移天数(落账 dateKey 换算用) */
const CONFIRM_DATE_OFFSETS = { today: 0, tomorrow: 1, dayafter: 2 };

/** 落账成功 toast 文案:今天→「已记录」;明天/后天→「已定到 X M/D」 */
function confirmToastText(key) {
  const offset = CONFIRM_DATE_OFFSETS[key] || 0;
  if (offset === 0) return '已记录';
  const when = offset === 1 ? '明天' : '后天';
  return `已定到${when} ${mdLabel(dateKeyOffset(offset))}`;
}

Page({
  behaviors: [useToastBehavior],

  data: {
    loading: true, // 首屏加载态(数据到位后隐藏,骨架屏显示)
    todaySkeletonRowCol: [
      // 今日已定卡骨架:标题 + 两条记录行
      [{ width: '30%', height: '32rpx' }],
      [{ width: '100%', height: '64rpx' }],
      [{ width: '100%', height: '64rpx' }],
    ],
    fridgeSkeletonRowCol: [
      // 冰箱 chips 区骨架:标题 + 一排圆角块
      [{ width: '30%', height: '32rpx' }],
      [{ width: '160rpx', height: '56rpx' }, { width: '160rpx', height: '56rpx' }, { width: '160rpx', height: '56rpx' }],
    ],
    // F25 今明已定三分组(空组整组不渲染,页面按 group.rows.length 判断)
    todayGroups: [],
    todayTotal: 0, // 三组合计条数(0 时显示空态文案)
    ingredientKeyword: '', // 冰箱原料搜索关键字(同时作为菜名/原料名模糊搜索词)
    pendingDate: 'today', // F25 落账三选:'today' | 'tomorrow' | 'dayafter'
    dateOptions: [
      { key: 'today', label: '今天' },
      { key: 'tomorrow', label: '明天' },
      { key: 'dayafter', label: '后天' },
    ],
    ingredientsPopupVisible: false, // F25 原料查看弹层
    ingredientsPopupName: '', // 原料弹层标题(菜名)
    ingredientsPopupList: [], // 原料弹层内容(原料名列表,空显示「暂无原料记录」)
    hasDishKeyword: false, // 搜索框是否有非空关键词(归一化后),wxml 引导态判定用
    ingredientChips: [], // 冰箱原料 chips:{name, active}(已排除调料)
    selectedNames: [], // 已选原料名
    completeMode: false, // 匹配模式:false 有交集即可 | true 完全匹配
    matchList: [], // 匹配结果卡片
    matchCategory: '', // 分类入口选中值:'' 全部 | 'meal' 餐食 | 'drink' 饮品(仅未选原料时生效)
    matchSearched: false, // 是否已进入查询态(未选原料且未选分类时为「未搜索」引导态)
    matchPage: 1, // 分类浏览时的页码
    matchHasMore: true, // 浏览全部时是否还有下一页
    matchLoadingMore: false, // 翻页 footer 加载中
    matchEmptyText: '', // 匹配区空态文案
    noDishes: false, // 库中无菜谱(空态显示去初始化引导)
    dishDialogVisible: false, // 「就做这道?」落账确认弹层
    pendingDishId: '', // 待落账菜品 _id
    pendingDishText: '', // 弹层正文(菜名)
    undoDialogVisible: false, // 撤销确认弹层
    undoConfirmBtn: { content: '撤销', theme: 'danger' }, // 撤销按钮(红色)
    undoName: '', // 将撤销的菜名(当天最后一条记录)
    deleteDialogVisible: false, // F25 删除确认弹层(明天/后天组行级删除)
    deleteRow: null, // 将删除的行 {recordId, dishName, dateLabel}
    wheelDisabled: true, // 转盘入口是否禁用(候选为空:无匹配/无菜谱)
    wheelVisible: false, // 转盘半屏弹层显隐
    wheelSpinning: false, // 转盘旋转中(开始按钮置灰)
    wheelResultVisible: false, // 转盘结果弹层显隐
    wheelResultText: '', // 结果弹层正文(今晚就吃:菜名)
    wheelResultItem: null, // 转盘结果菜品 {id, name}
    candidates: [], // 转盘候选(当前匹配结果 / 全部菜品)
    nicknamePopupVisible: false, // 昵称引导弹层(未注册成员首次进入时弹出)
    nicknameInput: '', // 昵称输入值
  },

  onLoad() {
    this.searchTimer = null; // 原料搜索防抖定时器
    this.firstShow = true; // 首次 onShow 不重复刷新
    this.requestSeq = 0; // 请求序号:快速切换条件时丢弃过期响应
    this.dishesSnapshot = null; // 菜品全量内存快照(匹配用,onShow 按需拉取)
    this.dishesSnapshotDirty = true; // 快照脏标记:onHide 置 true,onShow 重拉
    this.identityReady = null; // 身份加载单例 Promise(避免并发重复拉取)
    this.nicknamePrompted = false; // 昵称弹层本次会话只弹一次(可关不强制,下次冷启动再弹)
    this.member = null; // 当前成员文档(null = 未注册/未就绪,数据走未分配池)
    this.init();
  },

  onShow() {
    // AI 推荐返回:suggest 页写的 aiPick 标记,读取后清除并提示(不强制自动落账)
    const aiPick = wx.getStorageSync('aiPick');
    if (aiPick) {
      wx.removeStorageSync('aiPick');
      this.onShowToast('#t-toast', `AI 推荐:${aiPick}`);
    }
    // 快照脏时重拉(冷启动 / tab 切回 / 编辑页返回),保证匹配用最新菜品数据
    if (this.dishesSnapshotDirty) {
      this.refreshDishesSnapshot();
    }
    // 非首次进入(tab 切回)静默刷新今日记录,保证数据最新
    if (!this.firstShow) {
      this.refreshToday(true);
    }
    this.firstShow = false;
  },

  onHide() {
    // 离开首页(切 tab / 进详情、编辑页等):快照置脏,下次 onShow 重拉
    this.dishesSnapshotDirty = true;
  },

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  },

  nextSeq() {
    this.requestSeq += 1;
    return this.requestSeq;
  },

  /** 首次进入:并行加载原料 chips、今日记录;未搜索引导态不查询匹配列表 */
  async init() {
    const seq = this.nextSeq();
    // 引导态 refreshMatch 不查询,首屏骨架由原料 chips 与今日记录加载完成后统一关闭
    this.refreshMatch(seq, false);
    // 身份加载与数据加载并行:身份未就绪时今日卡先按未分配池('')查,不阻塞 UI;
    // 身份就绪后必须补刷一次今日卡(F25):否则按''查到的空组会一直停留到下次 onShow,
    // 家庭成员打开小程序会短暂看到"今明已定"为空(F24 既有缺陷,F25 三分组下更易感知)
    this.loadIdentity().then(() => {
      if (this.member) this.refreshToday(true);
    });
    await Promise.all([this.loadIngredients(''), this.refreshToday(false)]);
    if (seq === this.requestSeq) this.setData({ loading: false });
  },

  /** 拉取菜品全量内存快照(「点原料→匹配」0ms 的基础);失败保留旧快照并保持脏标记,
   *  下次 onShow / 下拉刷新自动重试。快照就绪后若已选原料则静默重跑匹配:
   *  用户在快照加载期间点选原料时 refreshMatch 已先置 loading,这里兜底渲染结果
   *  (silent:下拉刷新时不闪骨架;成功路径本身会复位 loading) */
  async refreshDishesSnapshot() {
    try {
      // force:整页刷新时机(onShow / 下拉刷新)强制穿透双层缓存直查云库,成功后回填两层
      const dishes = await fetchAllDishes({ force: true });
      this.dishesSnapshot = dishes;
      this.dishesSnapshotDirty = false;
      // 快照就绪后重跑匹配:已选原料 或 有关键词搜索时兜底渲染(用户在快照加载期间已触发的匹配)
      if (this.data.selectedNames.length > 0 || this.data.hasDishKeyword) {
        this.refreshMatch(this.nextSeq(), true);
      }
    } catch (err) {
      console.error('菜品快照加载失败', err);
    }
  },

  /** 下拉刷新:强制重拉菜品快照 + 今日记录 + 原料 chips(静默,不闪骨架) */
  async onPullDownRefresh() {
    this.dishesSnapshotDirty = true; // 主动刷新,无视 onHide 置脏时机,直接重拉
    await Promise.all([
      this.refreshDishesSnapshot(),
      this.refreshToday(true),
      // force:下拉刷新属整页刷新时机,原料 chips 也要拿云库最新(家人改过原料后下拉即见)
      this.loadIngredients(this.data.ingredientKeyword, true),
    ]);
    wx.stopPullDownRefresh();
  },

  /* ---------------- 身份(家庭多租户) ---------------- */

  /** 加载身份:ensureIdentity 幂等单例;失败 toast 允许重试(下次调用重新发起) */
  async loadIdentity() {
    if (!this.identityReady) {
      this.identityReady = ensureIdentity()
        .then(({ member }) => {
          // 只存页面需要的 member,不 setData 大对象
          this.member = member;
          // 未注册且本次会话未弹过:弹出昵称引导(可关闭不强制,未注册照常走未分配池)
          if (member === null && !this.nicknamePrompted) {
            this.nicknamePrompted = true;
            this.setData({ nicknamePopupVisible: true, nicknameInput: '' });
          }
        })
        .catch((err) => {
          console.error('身份加载失败', err);
          this.identityReady = null; // 清单例,下次调用重新发起
          this.onShowToast('#t-toast', '身份加载失败，部分功能不可用');
        });
    }
    return this.identityReady;
  },

  /** 昵称输入 */
  onNicknameInput(e) {
    this.setData({ nicknameInput: e.detail.value || '' });
  },

  /** 昵称弹层遮罩/下拉关闭:与「暂不设置」等价,仅收起不强制(受控组件需回写 visible) */
  onNicknameVisibleChange(e) {
    const detail = e.detail || {};
    const visible = typeof detail === 'boolean' ? detail : detail.visible;
    if (visible === false) this.setData({ nicknamePopupVisible: false });
  },

  /** 昵称弹层关闭(不强制注册,member 仍 null 走未分配池;下次冷启动再弹) */
  onNicknameClose() {
    this.setData({ nicknamePopupVisible: false });
  },

  /** 确认昵称注册:成功后更新本地 member,后续落账/查询即走所属家庭 */
  async onNicknameConfirm() {
    const name = (this.data.nicknameInput || '').trim();
    if (!name) {
      this.onShowToast('#t-toast', '昵称不能为空');
      return;
    }
    try {
      this.member = await registerMember(name);
      this.setData({ nicknamePopupVisible: false });
      this.onShowToast('#t-toast', '欢迎');
      // 注册前可能已按未分配池查过今日卡,落账归属变了,刷新一次
      this.refreshToday(true);
    } catch (err) {
      console.error('注册成员失败', err);
      this.onShowToast('#t-toast', err.message || '注册失败，请重试');
    }
  },

  /* ---------------- 今日已定 ---------------- */

  /** F25 拉取今/明/后三组记录并组装展示行(菜名 + 本地 HH:mm + 原料列表);
   *  空组整组不渲染(页面按 rows.length 判断),全空时显示空态文案 */
  async refreshToday(silent) {
    try {
      const res = await upcomingRecords(this.member ? this.member.familyId : '');
      const buildRows = (records) =>
        records.map((record) => ({
          _id: record._id,
          dishName: record.dishName || '未知菜品',
          dishId: record.dishId || '', // 行点击跳详情用;异常数据为空时不跳
          time: formatHHmm(record.createdAt),
          ingredients: record.ingredientNames || [],
        }));
      const todayGroups = [
        { key: 'today', label: `今天 ${mdLabel(dateKeyOffset(0))}`, rows: buildRows(res.today) },
        { key: 'tomorrow', label: `明天 ${mdLabel(dateKeyOffset(1))}`, rows: buildRows(res.tomorrow) },
        { key: 'dayafter', label: `后天 ${mdLabel(dateKeyOffset(2))}`, rows: buildRows(res.dayafter) },
      ];
      this.setData({ todayGroups, todayTotal: res.total });
    } catch (err) {
      console.error('今日记录加载失败', err);
      if (!silent) this.showFail();
    }
  },

  /** 点击「撤销」:打开确认弹层,提示将撤销当天最后一条记录(今天组倒序,第一条即最后一条);
   *  F25 撤销按钮只在今天组展示,undoLastTodayRecord 语义不变 */
  onUndoTap() {
    const todayGroup = this.data.todayGroups.find((g) => g.key === 'today');
    const last = todayGroup && todayGroup.rows[0];
    if (!last) return;
    this.setData({
      undoName: last.dishName,
      undoDialogVisible: true,
    });
  },

  onUndoCancel() {
    this.setData({ undoDialogVisible: false });
  },

  /** 确认撤销:undoLastTodayRecord 删除当天最后一条,随后刷新今日卡 */
  async onUndoConfirm() {
    this.setData({ undoDialogVisible: false });
    try {
      const res = await undoLastTodayRecord(dateKey(), this.member ? this.member.familyId : '');
      this.onShowToast('#t-toast', res.removed ? '已撤销' : '今天还没有记录');
      this.refreshToday(true);
    } catch (err) {
      console.error('撤销记录失败', err);
      this.showFail();
    }
  },

  /* ---------------- F25 明天/后天组:行级删除 ---------------- */

  /** 点击「删除」:打开确认弹层(带菜名与目标日期),按 recordId 精确删单条 */
  onDeleteTap(e) {
    const { gkey, index } = e.currentTarget.dataset;
    const group = this.data.todayGroups.find((g) => g.key === gkey);
    const row = group && group.rows[index];
    if (!row || !row._id) return;
    this.setData({
      deleteRow: { recordId: row._id, dishName: row.dishName, dateLabel: group.label },
      deleteDialogVisible: true,
    });
  },

  onDeleteCancel() {
    this.setData({ deleteDialogVisible: false });
  },

  /** 确认删除:deleteRecord 校验家庭快照后删单条,随后刷新今日卡 */
  async onDeleteConfirm() {
    const row = this.data.deleteRow;
    this.setData({ deleteDialogVisible: false });
    if (!row) return;
    try {
      const res = await deleteRecord(row.recordId, this.member ? this.member.familyId : '');
      this.onShowToast('#t-toast', res.removed ? '已删除' : '记录不存在或已变更');
      this.refreshToday(true);
    } catch (err) {
      console.error('删除记录失败', err);
      this.showFail();
    }
  },

  /* ---------------- 冰箱里有什么 ---------------- */

  /** 搜索输入:防抖 300ms 后重查原料 chips + 刷新匹配结果(菜名/原料名模糊搜索)。
   *  关键词非空时,匹配结果 = 词命中菜(∩ 已选原料命中菜);清空回到原 chips/分类逻辑 */
  onIngredientSearch(e) {
    const keyword = (e.detail.value || '').trim();
    this.setData({ ingredientKeyword: keyword, hasDishKeyword: normalizeName(keyword).length > 0 });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.loadIngredients(keyword);
      this.refreshMatch(this.nextSeq(), false);
    }, 300);
  },

  /** 点击清除图标:立即恢复全量原料 chips,并回到无关键词匹配逻辑 */
  onIngredientSearchClear() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.setData({ ingredientKeyword: '', hasDishKeyword: false });
    this.loadIngredients('');
    this.refreshMatch(this.nextSeq(), false);
  },

  /** 加载原料 chips:排除调料(isSeasoning);已选原料保证可见(过滤结果外补到尾部)。
   *  force=true 强制穿透缓存(进入/下拉刷新等整页刷新时机),搜索防抖走缓存不穿透 */
  async loadIngredients(kw, force = false) {
    try {
      const ingredients = await listIngredients(kw, { force });
      const selected = this.data.selectedNames;
      const chips = [];
      ingredients.forEach((item) => {
        const isSeasoning =
          item.isSeasoning != null ? item.isSeasoning : SEASONING_SET.has(item.name);
        if (isSeasoning) return;
        chips.push({ name: item.name, active: selected.includes(item.name) });
      });
      // 已选原料即使不在过滤结果中也补到列表尾部,避免选中态丢失后无法取消
      selected.forEach((name) => {
        if (!chips.some((chip) => chip.name === name)) chips.push({ name, active: true });
      });
      // 选中的排前面,其余按名称(便于查看已选)
      chips.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'zh'));
      this.setData({ ingredientChips: chips });
    } catch (err) {
      console.error('原料加载失败', err);
      this.showFail();
    }
  },

  /** 点击原料 chip:已选则取消,未选则加入;随后刷新匹配结果。
   *  分类浏览仅用于未选原料场景:选了原料即进入匹配模式,清空分类入口选中态;
   *  全部取消后回到「未搜索」引导态 */
  onIngredientTap(e) {
    const { name } = e.currentTarget.dataset;
    const selected = this.data.selectedNames.includes(name)
      ? this.data.selectedNames.filter((item) => item !== name)
      : this.data.selectedNames.concat(name);
    // 不可变更新 chips 选中态(保持「选中的在前」排序),保证 setData 可触发渲染
    const chips = this.data.ingredientChips
      .map((chip) => ({ ...chip, active: chip.name === name ? !chip.active : chip.active }))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'zh'));
    this.setData({
      selectedNames: selected,
      ingredientChips: chips,
      matchCategory: '',
      matchSearched: false,
    });
    this.refreshMatch(this.nextSeq(), false);
  },

  /** 分类入口 chips 点击(未选原料时展示):选择分类立即查询;再次点击已选分类取消,回到「未搜索」引导态 */
  onCategoryTap(e) {
    const value = e.currentTarget.dataset.value || ''; // 全部 → '' / 餐食 → meal / 饮品 → drink
    const { matchSearched, matchCategory } = this.data;
    const searched = matchSearched && matchCategory === value ? false : true;
    this.setData({
      matchCategory: searched ? value : '',
      matchSearched: searched,
    });
    this.refreshMatch(this.nextSeq(), false);
  },

  /* ---------------- 匹配结果 ---------------- */

  /** 匹配模式切换:false 有交集即可 | true 完全匹配(仅已选原料时重查) */
  onModeChange(e) {
    const completeMode = !!e.detail.value;
    if (completeMode === this.data.completeMode) return;
    this.setData({ completeMode });
    if (this.data.selectedNames.length > 0) {
      this.refreshMatch(this.nextSeq(), false);
    }
  },

  /**
   * 刷新匹配列表(按需展示):
   * - 未搜索引导态(未选原料且未选分类):不查询、不展示列表,仅显示引导文案 + 分类入口
   * - 已选原料:matchDishesByIngredients(dishesSnapshot, selected, {mode}) 内存匹配,带匹配度
   * - 未选原料但已选分类:listDishes 按分类浏览(新增 category 条件),支持触底翻页
   */
  async refreshMatch(seq, silent) {
    // 关键词(菜名/原料名模糊搜索):归一化后非空即进入关键词分支;为空走原 chips/分类逻辑
    const kw = normalizeName(this.data.ingredientKeyword);
    const hasKw = kw.length > 0;
    // 未搜索引导态:无关键词、未选原料且未选分类:不查询、不展示列表;loading 由 init 在其他数据到位后统一关闭
    if (!hasKw && this.data.selectedNames.length === 0 && !this.data.matchSearched) {
      if (seq !== this.requestSeq) return;
      this.setData({
        matchList: [],
        matchPage: 1,
        matchHasMore: false,
        matchLoadingMore: false,
        matchEmptyText: '',
        noDishes: false,
        wheelDisabled: false, // 引导态转盘候选=全部菜品,空库时 openWheel 内有兜底提示
      });
      return;
    }
    // 关键词搜索或已选原料需要内存快照;快照未就绪(首次加载 / 下拉刷新中):loading 兜底,
    // 快照就绪后 refreshDishesSnapshot 会自动重跑匹配(此处 return 在 try 之前,避免 finally 复位 loading)
    if ((hasKw || this.data.selectedNames.length > 0) && !this.dishesSnapshot) {
      if (seq !== this.requestSeq) return;
      this.setData({ loading: true });
      return;
    }
    if (!silent) this.setData({ loading: true });
    let cards = [];
    let hasMore = false;
    let emptyText = '';
    let noDishes = false;
    let wheelDisabled = true;
    try {
      const selected = this.data.selectedNames;
      if (hasKw) {
        // 关键词匹配:菜名或原料名包含关键词(归一化后);已选原料 chips 非空时再取交集
        let dishes = matchDishesByKeyword(this.dishesSnapshot, kw);
        if (selected.length > 0) {
          const selectedDishes = matchDishesByIngredients(this.dishesSnapshot, selected, {
            mode: this.data.completeMode ? 'complete' : 'partial',
          });
          const kwIds = new Set(dishes.map((dish) => dish._id));
          dishes = selectedDishes.filter((dish) => kwIds.has(dish._id));
          cards = await this.buildMatchCards(dishes, true);
        } else {
          cards = await this.buildMatchCards(dishes, false);
        }
        emptyText = '没有找到相关菜品';
        wheelDisabled = cards.length === 0; // 候选为空时禁用转盘入口
      } else if (selected.length > 0) {
        // 内存快照匹配(0ms):直查架构下全量已在快照中,避免每次点原料打库
        const dishes = matchDishesByIngredients(this.dishesSnapshot, selected, {
          mode: this.data.completeMode ? 'complete' : 'partial',
        });
        cards = await this.buildMatchCards(dishes, true);
        emptyText = '没有用这些原料能做出来的菜，换个搭配试试';
        wheelDisabled = cards.length === 0; // 候选为空时禁用转盘入口
      } else {
        const res = await listDishes({
          category: this.data.matchCategory,
          page: 1,
          pageSize: PAGE_SIZE,
          field: DISH_CARD_FIELDS,
        });
        cards = await this.buildMatchCards(res.list, false);
        hasMore = res.hasMore;
        wheelDisabled = res.total === 0; // 先按该分类是否有菜判断,空时再探测全库
        if (res.total === 0) {
          emptyText =
            this.data.matchCategory === ''
              ? '还没有菜谱，去「更多」页初始化内置菜谱吧'
              : '这个分类还没有菜谱';
          if (this.data.matchCategory === '') {
            noDishes = true;
          } else {
            // 该分类无菜时探测全库:库完全为空才引导去初始化;全库有菜则转盘仍可用(候选=全部菜品)
            try {
              const probe = await listDishes({ page: 1, pageSize: 1, field: ['name'] });
              if (probe.total === 0) {
                noDishes = true;
                emptyText = '还没有菜谱，去「更多」页初始化内置菜谱吧';
                wheelDisabled = true;
              } else {
                wheelDisabled = false;
              }
            } catch (probeErr) {
              console.error('菜谱空态探测失败', probeErr);
            }
          }
        }
      }
      if (seq !== this.requestSeq) return;
      this.setData({
        matchList: cards,
        matchPage: 1,
        matchHasMore: hasMore,
        matchLoadingMore: false, // 切换条件时复位翻页加载态,避免残留阻塞后续触底
        matchEmptyText: emptyText,
        noDishes,
        wheelDisabled,
        loading: false,
      });
    } catch (err) {
      if (seq !== this.requestSeq) return;
      console.error('匹配列表加载失败', err);
      this.showFail();
    } finally {
      if (!silent && seq === this.requestSeq) this.setData({ loading: false });
    }
  },

  /** 组装匹配卡片:复用菜谱列表页卡片风格,附匹配度百分比徽章(未选原料时不显示)
   *  封面 cloud:// fileID 批量换链为 https 临时链接后才能在非创建者手机上显示 */
  async buildMatchCards(dishes, withScore) {
    const cards = dishes.map((dish) => {
      const names = dish.ingredientNames || [];
      // 封面优先级:云端第一张图(排序后数组首位)→ 内置静态图(seed 已写入 images)→ 分类 emoji 占位
      const cover = orderDishImages(dish.images)[0] || '';
      const hasCover = !!cover;
      let score = '';
      if (withScore) {
        // partial 模式 matchScore(0-1)取整百分比;complete 模式全部完全匹配显示 100%
        const raw = this.data.completeMode ? 1 : dish.matchScore != null ? dish.matchScore : 0;
        score = `${Math.round(raw * 100)}%`;
      }
      return {
        _id: dish._id,
        name: dish.name,
        cover,
        emoji: hasCover ? '' : dish.category === 'drink' ? '🥤' : '🍜',
        ingredientTags: names.slice(0, 4),
        extraCount: names.length > 4 ? names.length - 4 : 0,
        cookTime: dish.cookTime || '',
        difficulty: dish.difficulty || '',
        isBuiltin: !!dish.isBuiltin,
        score,
      };
    });
    // cloud:// 封面批量换链(缓存命中时零调用);换链失败回空串走 emoji 兜底
    const covers = await resolveImgUrls(cards.map((c) => c.cover));
    cards.forEach((c, i) => {
      if (c.cover) c.cover = covers[i];
    });
    return cards;
  },

  /** 点击匹配卡片:打开「就做这道?」确认弹层(每次打开重置三选为今天) */
  onDishTap(e) {
    const { id, name } = e.currentTarget.dataset;
    this.setData({
      pendingDishId: id,
      pendingDishText: `「${name}」`,
      pendingDate: 'today',
      dishDialogVisible: true,
    });
  },

  /** F25 落账三选按钮:选中项高亮(两个弹层共用) */
  onDateOptionTap(e) {
    const { key } = e.currentTarget.dataset;
    if (key && key !== this.data.pendingDate) this.setData({ pendingDate: key });
  },

  /** 落账确认弹层遮罩/下拉关闭:受控组件回写 visible */
  onDishVisibleChange(e) {
    const detail = e.detail || {};
    const visible = typeof detail === 'boolean' ? detail : detail.visible;
    if (visible === false) this.setData({ dishDialogVisible: false });
  },

  onDishCancel() {
    this.setData({ dishDialogVisible: false });
  },

  /** 确认落账:addCookRecord 按 F25 三选写入对应日期;toast 文案区分今天/明天/后天 */
  async onDishConfirm() {
    const { pendingDishId, pendingDate } = this.data;
    const offset = CONFIRM_DATE_OFFSETS[pendingDate] || 0;
    this.setData({ dishDialogVisible: false });
    try {
      await addCookRecord(pendingDishId, this.member ? this.member.familyId : '', dateKeyOffset(offset));
      this.onShowToast('#t-toast', confirmToastText(pendingDate));
      this.refreshToday(true);
    } catch (err) {
      console.error('落账失败', err);
      this.showFail();
    }
  },

  /** F25 行点击「原料」:打开原料查看弹层(catch:tap 不触发行跳详情) */
  onIngredientsTap(e) {
    const { gkey, index } = e.currentTarget.dataset;
    const group = this.data.todayGroups.find((g) => g.key === gkey);
    const row = group && group.rows[index];
    if (!row) return;
    this.setData({
      ingredientsPopupVisible: true,
      ingredientsPopupName: row.dishName,
      ingredientsPopupList: row.ingredients,
    });
  },

  /** 原料弹层遮罩/下拉关闭:受控组件回写 visible */
  onIngredientsVisibleChange(e) {
    const detail = e.detail || {};
    const visible = typeof detail === 'boolean' ? detail : detail.visible;
    if (visible === false) this.setData({ ingredientsPopupVisible: false });
  },

  onIngredientsClose() {
    this.setData({ ingredientsPopupVisible: false });
  },

  /** F25 整行点击跳菜品详情(dishId 为空的异常数据不跳) */
  onTodayRowTap(e) {
    const { id } = e.currentTarget.dataset;
    if (!id) return;
    wx.navigateTo({ url: `/packages/dish/detail?id=${id}` });
  },

  /** 触底翻页:仅「未选原料且已选分类」浏览模式追加下一页(匹配/引导态不翻页) */
  async onReachBottom() {
    if (this.data.loading || this.data.matchLoadingMore || !this.data.matchHasMore) return;
    if (this.data.selectedNames.length > 0 || !this.data.matchSearched) return;
    const seq = this.requestSeq;
    const nextPage = this.data.matchPage + 1;
    this.setData({ matchLoadingMore: true });
    try {
      const res = await listDishes({ page: nextPage, pageSize: PAGE_SIZE, field: DISH_CARD_FIELDS });
      if (seq !== this.requestSeq) return;
      this.setData({
        matchList: this.data.matchList.concat(this.buildMatchCards(res.list, false)),
        matchPage: nextPage,
        matchHasMore: res.hasMore,
      });
    } catch (err) {
      if (seq !== this.requestSeq) return;
      console.error('匹配列表翻页失败', err);
      this.showFail();
    } finally {
      if (seq === this.requestSeq) this.setData({ matchLoadingMore: false });
    }
  },

  /** 空态引导:前往「更多」页初始化内置菜谱 */
  goMore() {
    wx.switchTab({ url: '/pages/more/index' });
  },

  /* ---------------- 随机转盘(M3-b) ---------------- */

  /** 转盘入口:候选为空时禁用置灰,点击直接忽略 */
  onWheelBtnTap() {
    if (this.data.wheelDisabled) return;
    this.openWheel();
  },

  /** AI 推荐入口:跳转分包 packages/dish/ai/suggest(主包零 import 分包,仅页面跳转) */
  onAiRecommend() {
    wx.navigateTo({ url: '/packages/dish/ai/suggest' });
  },

  /**
   * 打开转盘弹层:组装候选 = 当前匹配结果(未选原料时 = 全部菜品)。
   * 已选原料时 matchList 即内存快照匹配的全量结果;
   * 未选原料时列表只加载第一页,这里循环拉全量作为候选。
   */
  async openWheel() {
    let list = this.data.matchList;
    // 已选原料或关键词搜索时, matchList 已是内存全量结果(非分页),直接作为转盘候选;
    // 仅「未选原料且无关键词」的分类浏览场景 matchList 才只是第一页,需循环拉全量
    if (this.data.selectedNames.length === 0 && !this.data.hasDishKeyword) {
      try {
        list = await this.fetchAllDishesForWheel();
      } catch (err) {
        console.error('转盘候选加载失败', err);
        this.showFail();
        return;
      }
    }
    const candidates = list.map((dish) => ({ id: dish._id, name: dish.name }));
    if (candidates.length === 0) {
      this.onShowToast('#t-toast', '先选几道菜或添加菜谱');
      return;
    }
    this.setData({ candidates, wheelVisible: true });
  },

  /** 循环翻页拉取全部菜品(家庭量级有限循环即可) */
  async fetchAllDishesForWheel() {
    const list = [];
    let page = 1;
    for (let i = 0; i < 100; i += 1) {
      const res = await listDishes({ page, pageSize: PAGE_SIZE, field: ['name'] }); // 转盘候选只需 _id + name
      list.push(...res.list);
      if (!res.hasMore) break;
      page += 1;
    }
    return list;
  },

  /** 弹层关闭(点遮罩/关闭按钮):重置旋转状态并回写 wheelVisible,避免状态残留。
   *  t-popup 为受控组件,visible 必须回写 false 才能真正关闭;
   *  结果弹窗生命周期独立于转盘(F17:先收转盘再弹结果),不随转盘关闭 */
  onWheelVisibleChange(e) {
    const detail = e.detail || {};
    const visible = typeof detail === 'boolean' ? detail : detail.visible;
    if (visible === false) {
      this.setData({ wheelVisible: false, wheelSpinning: false });
    }
  },

  /** 顶部标题栏关闭按钮:与遮罩关闭等价,统一回写 wheelVisible 状态;
   *  结果弹窗不随转盘关闭(转盘停转后才弹,与转盘显隐解耦) */
  closeWheel() {
    this.setData({ wheelVisible: false, wheelSpinning: false });
  },

  /** 「开始旋转」:调组件 spin();旋转状态由组件的 spinstart/spinend 事件维护 */
  onStartSpin() {
    const wheel = this.selectComponent('#wheel');
    if (wheel) wheel.spin();
  },

  /** 组件开始旋转:按钮置灰 */
  onSpinStart() {
    this.setData({ wheelSpinning: true });
  },

  /** 组件旋转结束:保存结果但不立即弹窗——高亮停留 800ms 让用户看清选中扇区,
   *  再一并收起转盘 + 弹出结果。绕开 dialog 与 popup 平叠、z-index 在部分环境
   *  不生效导致结果弹层被转盘盖住的问题(结果弹出时转盘已收,无遮挡)。
   *  定时器无需存实例:800ms 内用户手动关转盘也无害,setData 幂等 */
  onSpinEnd(e) {
    const item = e.detail && e.detail.item;
    this.setData({
      wheelSpinning: false,
      wheelResultItem: item,
      wheelResultText: item ? `今晚就吃：${item.name}` : '',
      pendingDate: 'today', // F25 结果弹层三选每次重置为今天
    });
    setTimeout(() => {
      this.setData({ wheelVisible: false, wheelResultVisible: true });
    }, 800);
  },

  /** 结果确认「就吃它了」:关结果弹层 → 按 F25 三选落账 → toast → 刷新今日卡
   *  (转盘在停转时已收,无需再关 wheelVisible) */
  async onWheelConfirm() {
    const item = this.data.wheelResultItem;
    const { pendingDate } = this.data;
    const offset = CONFIRM_DATE_OFFSETS[pendingDate] || 0;
    this.setData({ wheelResultVisible: false });
    if (!item) return;
    try {
      await addCookRecord(item.id, this.member ? this.member.familyId : '', dateKeyOffset(offset));
      this.onShowToast('#t-toast', confirmToastText(pendingDate));
      this.refreshToday(true);
    } catch (err) {
      console.error('转盘落账失败', err);
      this.showFail();
    }
  },

  /** 结果「换一个」:关结果弹层 → 重开转盘 → 等组件重建后自动开转。
   *  转盘弹层内容由 wx:if 包裹,重开后 spin-wheel 销毁重建,
   *  需等 ready + canvas 初始化完成后再调 spin(),不能直接复用旧实例 */
  onWheelAgain() {
    this.setData({ wheelResultVisible: false, wheelVisible: true });
    setTimeout(() => {
      const wheel = this.selectComponent('#wheel');
      if (wheel && typeof wheel.spin === 'function') wheel.spin();
    }, 400);
  },

  /** 结果弹层点遮罩/关闭:仅关闭结果弹窗,不动转盘(此时转盘已收);
   *  F25 改为 t-popup 后由 visible-change 触达 */
  onWheelResultVisibleChange(e) {
    const detail = e.detail || {};
    const visible = typeof detail === 'boolean' ? detail : detail.visible;
    if (visible === false) this.setData({ wheelResultVisible: false });
  },

  /** 统一失败提示 */
  showFail() {
    this.onShowToast('#t-toast', '操作失败，请重试');
  },
});
