/**
 * pages/home/index.js
 * 首页(主包 tab「首页」):今日已定 + 按料找菜 + 手选落账(转盘为 M3-b 独立组件)
 * - 今日已定卡:todayRecords() 列表(菜名 + 时间 HH:mm),每行右侧「撤销」→ t-dialog 确认
 *   → undoLastTodayRecord(删除的是当天最后一条记录,弹层文案写清)→ 刷新
 * - 冰箱里有什么:横向 chips 多选原料(listIngredients 全量排除调料 isSeasoning),
 *   顶部小 t-search 防抖 300ms 过滤;已选原料可再点取消
 * - 匹配结果区(按需展示):
 *   - 未选原料且未选分类:「未搜索」引导态——不查询不展示列表,显示引导文案 + 三个分类入口 chips(全部/餐食/饮品)
 *   - 点击分类 chip(或选了原料后):立即查询展示;chips 上出现选中态
 *   - 已选原料:searchDishesByIngredients(selectedNames, {mode});t-switch 切「有交集即可 / 完全匹配」;
 *     点击卡片 → t-dialog「就做这道?」→ addCookRecord 落账 → toast「已记录」→ 刷新今日卡
 *   - 未选原料但已选分类:listDishes 按分类浏览(新增 category 条件),触底翻页
 *   - 取消勾选全部原料后回到「未搜索」引导态
 * - 随机转盘:候选 = 当前匹配结果(未选原料时=全部菜品,点击时拉全量);半屏 t-popup 内嵌
 *   spin-wheel 组件,「开始旋转」调组件 spin()(旋转中按钮置灰);spinend → t-dialog 结果
 *   「今晚就吃:xxx」→「就吃它了」落账 /「换一个」重转
 * - onShow 静默刷新今日记录(tab 切回数据最新)
 * 数据库操作一律走 api/db.js 封装,页面不直接调用 wx.cloud。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import {
  addCookRecord,
  dateKey,
  listDishes,
  listIngredients,
  searchDishesByIngredients,
  todayRecords,
  undoLastTodayRecord,
  DISH_CARD_FIELDS,
} from '../../api/db.js';
import { SEASONING_SET } from '../../utils/seasonings.js';
import { orderDishImages } from '../../utils/image.js';

/** 每页条数(与云数据库客户端单次 limit 上限一致) */
const PAGE_SIZE = 20;

/** 服务端时间格式化为本地 HH:mm(今日已定列表展示用) */
function formatHHmm(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
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
    today: [], // 今日已定列表:{_id, dishName, time}
    ingredientKeyword: '', // 冰箱原料搜索关键字
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
    wheelDisabled: true, // 转盘入口是否禁用(候选为空:无匹配/无菜谱)
    wheelVisible: false, // 转盘半屏弹层显隐
    wheelSpinning: false, // 转盘旋转中(开始按钮置灰)
    wheelResultVisible: false, // 转盘结果弹层显隐
    wheelResultText: '', // 结果弹层正文(今晚就吃:菜名)
    wheelResultItem: null, // 转盘结果菜品 {id, name}
    candidates: [], // 转盘候选(当前匹配结果 / 全部菜品)
  },

  onLoad() {
    this.searchTimer = null; // 原料搜索防抖定时器
    this.firstShow = true; // 首次 onShow 不重复刷新
    this.requestSeq = 0; // 请求序号:快速切换条件时丢弃过期响应
    this.init();
  },

  onShow() {
    // 非首次进入(tab 切回)静默刷新今日记录,保证数据最新
    if (!this.firstShow) {
      this.refreshToday(true);
    }
    this.firstShow = false;
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
    await Promise.all([this.loadIngredients(''), this.refreshToday(false)]);
    if (seq === this.requestSeq) this.setData({ loading: false });
  },

  /* ---------------- 今日已定 ---------------- */

  /** 拉取今日记录并组装展示行(菜名 + 本地 HH:mm);silent=true 时失败不打扰用户 */
  async refreshToday(silent) {
    try {
      const records = await todayRecords(dateKey());
      const today = records.map((record) => ({
        _id: record._id,
        dishName: record.dishName || '未知菜品',
        time: formatHHmm(record.createdAt),
      }));
      this.setData({ today });
    } catch (err) {
      console.error('今日记录加载失败', err);
      if (!silent) this.showFail();
    }
  },

  /** 点击「撤销」:打开确认弹层,提示将撤销当天最后一条记录(列表倒序,第一条即最后一条) */
  onUndoTap() {
    const last = this.data.today[0];
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
      const res = await undoLastTodayRecord(dateKey());
      this.onShowToast('#t-toast', res.removed ? '已撤销' : '今天还没有记录');
      this.refreshToday(true);
    } catch (err) {
      console.error('撤销记录失败', err);
      this.showFail();
    }
  },

  /* ---------------- 冰箱里有什么 ---------------- */

  /** 搜索输入:防抖 300ms 后按关键字重查原料 chips */
  onIngredientSearch(e) {
    const keyword = (e.detail.value || '').trim();
    this.setData({ ingredientKeyword: keyword });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.loadIngredients(keyword), 300);
  },

  /** 点击清除图标:立即恢复全量原料 chips */
  onIngredientSearchClear() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.setData({ ingredientKeyword: '' });
    this.loadIngredients('');
  },

  /** 加载原料 chips:排除调料(isSeasoning);已选原料保证可见(过滤结果外补到尾部) */
  async loadIngredients(kw) {
    try {
      const ingredients = await listIngredients(kw);
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
   * - 已选原料:searchDishesByIngredients(selectedNames, {mode}) 一次性返回全部,带匹配度
   * - 未选原料但已选分类:listDishes 按分类浏览(新增 category 条件),支持触底翻页
   */
  async refreshMatch(seq, silent) {
    // 未搜索引导态:不查询、不展示列表;loading 由 init 在其他数据到位后统一关闭
    if (this.data.selectedNames.length === 0 && !this.data.matchSearched) {
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
    if (!silent) this.setData({ loading: true });
    let cards = [];
    let hasMore = false;
    let emptyText = '';
    let noDishes = false;
    let wheelDisabled = true;
    try {
      const selected = this.data.selectedNames;
      if (selected.length > 0) {
        const dishes = await searchDishesByIngredients(selected, {
          mode: this.data.completeMode ? 'complete' : 'partial',
        });
        cards = this.buildMatchCards(dishes, true);
        emptyText = '没有用这些原料能做出来的菜，换个搭配试试';
        wheelDisabled = cards.length === 0; // 候选为空时禁用转盘入口
      } else {
        const res = await listDishes({
          category: this.data.matchCategory,
          page: 1,
          pageSize: PAGE_SIZE,
          field: DISH_CARD_FIELDS,
        });
        cards = this.buildMatchCards(res.list, false);
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

  /** 组装匹配卡片:复用菜谱列表页卡片风格,附匹配度百分比徽章(未选原料时不显示) */
  buildMatchCards(dishes, withScore) {
    return dishes.map((dish) => {
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
  },

  /** 点击匹配卡片:打开「就做这道?」确认弹层 */
  onDishTap(e) {
    const { id, name } = e.currentTarget.dataset;
    this.setData({
      pendingDishId: id,
      pendingDishText: `「${name}」，确定今天做这道吗？`,
      dishDialogVisible: true,
    });
  },

  onDishCancel() {
    this.setData({ dishDialogVisible: false });
  },

  /** 确认落账:addCookRecord 写一条 records,toast 后刷新今日卡 */
  async onDishConfirm() {
    const { pendingDishId } = this.data;
    this.setData({ dishDialogVisible: false });
    try {
      await addCookRecord(pendingDishId);
      this.onShowToast('#t-toast', '已记录');
      this.refreshToday(true);
    } catch (err) {
      console.error('落账失败', err);
      this.showFail();
    }
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

  /**
   * 打开转盘弹层:组装候选 = 当前匹配结果(未选原料时 = 全部菜品)。
   * 已选原料时 matchList 即 searchDishesByIngredients 的全量结果;
   * 未选原料时列表只加载第一页,这里循环拉全量作为候选。
   */
  async openWheel() {
    let list = this.data.matchList;
    if (this.data.selectedNames.length === 0) {
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

  /** 弹层遮罩关闭:重置旋转与结果状态,避免状态残留 */
  onWheelVisibleChange(e) {
    const detail = e.detail || {};
    const visible = typeof detail === 'boolean' ? detail : detail.visible;
    if (visible === false) {
      this.setData({ wheelSpinning: false, wheelResultVisible: false });
    }
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

  /** 组件旋转结束:弹出结果弹层「今晚就吃:菜名」 */
  onSpinEnd(e) {
    const item = e.detail && e.detail.item;
    this.setData({
      wheelSpinning: false,
      wheelResultItem: item,
      wheelResultText: item ? `今晚就吃：${item.name}` : '',
      wheelResultVisible: true,
    });
  },

  /** 结果确认「就吃它了」:关弹层 → 落账 → toast → 刷新今日卡 */
  async onWheelConfirm() {
    const item = this.data.wheelResultItem;
    this.setData({ wheelResultVisible: false, wheelVisible: false });
    if (!item) return;
    try {
      await addCookRecord(item.id);
      this.onShowToast('#t-toast', '已记录');
      this.refreshToday(true);
    } catch (err) {
      console.error('转盘落账失败', err);
      this.showFail();
    }
  },

  /** 结果「换一个」:关结果弹层,重新旋转 */
  onWheelAgain() {
    this.setData({ wheelResultVisible: false });
    const wheel = this.selectComponent('#wheel');
    if (wheel) wheel.spin();
  },

  /** 结果弹层点遮罩/关闭:仅关闭,保留转盘弹层可再转 */
  onWheelResultClose() {
    this.setData({ wheelResultVisible: false });
  },

  /** 统一失败提示 */
  showFail() {
    this.onShowToast('#t-toast', '操作失败，请重试');
  },
});
