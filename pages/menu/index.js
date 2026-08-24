/**
 * pages/menu/index.js
 * 菜谱列表页(主包 tab「菜谱」)
 * - 顶部搜索:输入防抖 300ms 后按菜名/原料/做法三字段模糊(listDishes keyword)
 * - 大类 t-tabs:全部 / 餐食 / 饮品(category ''|'meal'|'drink')
 * - 细分标签 chips:2 列网格布局(不再横滑),选项来自当前大类下出现过的 tags(全量聚合去重,按出现次数降序),多选切换(选中高亮,listDishes tags _.in);默认折叠只显示前 4 个(选中项固定在前),右侧按钮展开/折叠
 * - 卡片流:封面(云端第一张图,无则分类 emoji)、菜名、原料名标签(前 4 +「+N」)、时间/难度小徽章、内置角标
 * - 列表排序:难度 简单→中等→较难、相同难度按名称;大类「全部」时餐食整列在前(utils/menuSort.js);
 *   当前筛选条件下全量拉取排序后,翻页仅本地切片,保证全局排序与分页一致
 * - 分页:onReachBottom 加载下一页;onPullDownRefresh 重置第一页
 * - onShow 非首次进入且从其他页返回时静默刷新第一页(needsRefresh 标记)
 * 数据库操作一律走 api/db.js 封装,页面不直接调用 wx.cloud。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import { listDishes, DISH_CARD_FIELDS } from '../../api/db.js';
import { sortMenuDishes } from '../../utils/menuSort.js';
import { orderDishImages } from '../../utils/image.js';

/** 每页条数(与云数据库客户端单次 limit 上限一致) */
const PAGE_SIZE = 20;

Page({
  behaviors: [useToastBehavior],

  data: {
    category: '', // 大类:'' 全部 | 'meal' 餐食 | 'drink' 饮品
    keyword: '', // 搜索关键字
    tagChips: [{ name: '不限', active: true }], // 细分标签 chips(含选中态)
    displayTagChips: [], // 展示用 chips(选中项固定在前,保证折叠时可见可点叉取消)
    chipsCollapsed: true, // 细分标签折叠状态:默认收起,只显示第一排(top4)
    tagVisibleCount: 4, // 折叠时展示的标签数;选中标签数更多时取其值,保证全部选中项可见
    selectedTags: [], // 已选细分标签(不含「不限」)
    list: [], // 展示卡片
    page: 1, // 当前页码
    hasMore: true, // 是否还有下一页
    loading: true, // 首屏加载态(数据到位后隐藏,骨架屏显示)
    skeletonCards: [1, 2, 3], // 骨架屏卡片行数(3 行卡片形骨架)
    menuSkeletonRowCol: [
      // 单张卡片骨架:左图 + 右侧信息两行
      [{ width: '160rpx', height: '160rpx', marginRight: '24rpx' }, { width: '60%', height: '36rpx' }],
      [{ width: '40%', height: '28rpx', marginLeft: '184rpx' }],
    ],
    loadingMore: false, // 翻页 footer 加载中
    hasFilter: false, // 是否有搜索/筛选条件(用于区分空态文案)
  },

  onLoad() {
    this.searchTimer = null; // 搜索防抖定时器
    this.needsRefresh = false; // 从其他页返回后是否需要静默刷新
    this.firstShow = true; // 首次 onShow 不重复刷新
    this.requestSeq = 0; // 请求序号:快速切换条件时丢弃过期响应
    this.tagNames = []; // 最近一次聚合出的标签名列表(供 chips 刷新选中态)
    this.fullList = []; // 当前筛选条件下的全量排序列表(翻页本地切片,保证全局排序一致)
    this.init();
  },

  onShow() {
    // 非首次进入且 onHide 已置位(从详情/编辑/更多等页返回)时,静默刷新第一页保证列表最新
    if (!this.firstShow && this.needsRefresh) {
      this.needsRefresh = false;
      // 整页刷新时机(onShow):强制穿透缓存直查云库,家人任一手机改库后回到本页即最新
      this.refreshFirstPage(this.nextSeq(), true, true);
    }
    this.firstShow = false;
  },

  onHide() {
    this.needsRefresh = true;
  },

  onUnload() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
  },

  /** 首次进入:并行聚合细分标签 + 拉第一页 */
  init() {
    const seq = this.nextSeq();
    this.loadTagOptions(seq);
    this.refreshFirstPage(seq, false);
  },

  nextSeq() {
    this.requestSeq += 1;
    return this.requestSeq;
  },

  /** 聚合当前大类下出现过的 tags:循环翻页取全量,按出现次数降序(次数相同按名称) */
  async loadTagOptions(seq) {
    const countMap = new Map();
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const res = await listDishes({
        category: this.data.category,
        page,
        pageSize: PAGE_SIZE,
        field: ['tags'], // 聚合细分标签只需 tags 字段
      });
      res.list.forEach((dish) => {
        (dish.tags || []).forEach((tag) => {
          countMap.set(tag, (countMap.get(tag) || 0) + 1);
        });
      });
      hasMore = res.hasMore;
      page += 1;
    }
    if (seq !== this.requestSeq) return; // 期间已切换条件,丢弃过期结果
    this.tagNames = Array.from(countMap.keys()).sort(
      (a, b) => countMap.get(b) - countMap.get(a) || a.localeCompare(b, 'zh'),
    );
    this.setData(this.applyTagChips(this.buildTagChips(this.tagNames, this.data.selectedTags)));
  },

  /** 组装标签 chips:首位固定「不限」,其余按选中态标记 */
  buildTagChips(names, selectedTags) {
    const chips = [{ name: '不限', active: selectedTags.length === 0 }];
    names.forEach((name) => {
      chips.push({ name, active: selectedTags.includes(name) });
    });
    return chips;
  },

  /** 展示用 chips:已选中的标签固定在前(即使折叠也在首排可见,方便点叉取消),其余保持原顺序 */
  buildDisplayTagChips(chips) {
    const { selectedTags } = this.data;
    const selected = chips.filter((c) => selectedTags.includes(c.name));
    const rest = chips.filter((c) => !selectedTags.includes(c.name));
    return selected.concat(rest);
  },

  /** 更新 tagChips 及展示派生状态(选中项前置 + 折叠可见数),返回 setData 补丁 */
  applyTagChips(chips) {
    return {
      tagChips: chips,
      displayTagChips: this.buildDisplayTagChips(chips),
      tagVisibleCount: Math.max(4, this.data.selectedTags.length),
    };
  },

  /** 细分标签展开/折叠切换 */
  onToggleTagChips() {
    this.setData({ chipsCollapsed: !this.data.chipsCollapsed });
  },

  /**
   * 拉取当前筛选条件下的全部菜品并排序(家庭量级循环翻页即可,保证全局排序与分页切片一致)。
   * 排序规则见 utils/menuSort.js:难度 简单→中等→较难,同名按名称;大类「全部」时餐食整列在前。
   * @param {number} seq 请求序号
   * @param {boolean} [force=false] 是否强制穿透缓存(整页刷新时机:onShow/下拉刷新)
   * @returns {Promise<Array|null>} 排序后的菜品文档数组;期间条件已变化则返回 null
   */
  async loadAllSortedDishes(seq, force) {
    const all = [];
    let page = 1;
    for (let i = 0; i < 100; i += 1) {
      const res = await listDishes({
        category: this.data.category,
        tags: this.data.selectedTags,
        keyword: this.data.keyword,
        page,
        pageSize: PAGE_SIZE,
        field: DISH_CARD_FIELDS, // 卡片流字段投影,steps 不进列表查询载荷
        // 整页刷新(force)只在第一页强制穿透:首拉即回填两层缓存,后续翻页走刚回填的缓存,
        // 避免同一集合在翻页循环里重复全量打库;筛选/搜索等交互不穿透,命中缓存秒开
        force: page === 1 ? force : false,
      });
      if (seq !== this.requestSeq) return null; // 期间已切换条件,丢弃过期结果
      all.push(...res.list);
      if (!res.hasMore) break;
      page += 1;
    }
    return sortMenuDishes(all, { category: this.data.category });
  },

  /** 拉取第一页并替换列表(重置分页);silent=true 时不清空旧列表(静默刷新/下拉刷新);
   *  force=true 时整页刷新强制穿透缓存(onShow/下拉刷新),筛选/搜索等交互不穿透走缓存 */
  async refreshFirstPage(seq, silent, force = false) {
    if (!silent) this.setData({ loading: true });
    try {
      const sorted = await this.loadAllSortedDishes(seq, force);
      if (seq !== this.requestSeq || !sorted) return;
      this.fullList = sorted; // 全量排序结果,供触底翻页本地切片
      this.setData({
        list: this.buildCards(sorted.slice(0, PAGE_SIZE)),
        page: 1,
        hasMore: sorted.length > PAGE_SIZE,
        hasFilter: !!(this.data.keyword || this.data.selectedTags.length),
        ...this.applyTagChips(this.buildTagChips(this.tagNames, this.data.selectedTags)),
        loading: false,
      });
    } catch (err) {
      if (seq !== this.requestSeq) return;
      console.error('菜谱列表加载失败', err);
      this.showFail();
    } finally {
      if (!silent && seq === this.requestSeq) this.setData({ loading: false });
    }
  },

  /** 把菜品文档组装为展示卡片:封面(云端第一张图 → 内置静态图 → 分类 emoji)、原料标签、徽章、内置角标 */
  buildCards(dishes) {
    return dishes.map((dish) => {
      const names = dish.ingredientNames || [];
      // 封面优先级:云端第一张图(排序后数组首位)→ 内置静态图(seed 已写入 images)→ 分类 emoji 占位
      const cover = orderDishImages(dish.images)[0] || '';
      const hasCover = !!cover;
      return {
        _id: dish._id,
        name: dish.name,
        cover,
        emoji: hasCover ? '' : (dish.category === 'drink' ? '🥤' : '🍜'),
        ingredientTags: names.slice(0, 4),
        extraCount: names.length > 4 ? names.length - 4 : 0,
        cookTime: dish.cookTime || '',
        difficulty: dish.difficulty || '',
        isBuiltin: !!dish.isBuiltin,
      };
    });
  },

  /** 大类切换:重置已选标签并重新聚合细分标签,刷新第一页 */
  onCategoryChange(e) {
    const category = e.detail.value || '';
    if (category === this.data.category) return;
    const seq = this.nextSeq();
    this.setData({ category, selectedTags: [] });
    this.loadTagOptions(seq);
    this.refreshFirstPage(seq, false);
  },

  /** 搜索输入:防抖 300ms 后刷新列表 */
  onSearchChange(e) {
    const keyword = (e.detail.value || '').trim();
    this.setData({ keyword });
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.refreshFirstPage(this.nextSeq(), false);
    }, 300);
  },

  /** 点击清除图标:立即恢复全量列表 */
  onSearchClear() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.setData({ keyword: '' });
    this.refreshFirstPage(this.nextSeq(), false);
  },

  /** 细分标签点击:「不限」清空全部选中;其余多选切换 */
  onTagTap(e) {
    const { value } = e.currentTarget.dataset;
    let selectedTags;
    if (value === '不限') {
      selectedTags = [];
    } else if (this.data.selectedTags.includes(value)) {
      selectedTags = this.data.selectedTags.filter((tag) => tag !== value);
    } else {
      selectedTags = this.data.selectedTags.concat(value);
    }
    this.setData({ selectedTags });
    this.refreshFirstPage(this.nextSeq(), false);
  },

  /** 点击卡片:跳转菜品详情 */
  onDishTap(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: `/packages/dish/detail?id=${id}` });
  },

  /** 右下角浮动按钮:跳转新增 / 编辑页 */
  goAdd() {
    wx.navigateTo({ url: '/packages/dish/edit' });
  },

  /** 空态引导:前往「更多」页初始化内置菜谱 */
  goMore() {
    wx.switchTab({ url: '/pages/more/index' });
  },

  /** 下拉刷新:重置第一页(静默模式,保留旧列表避免闪空);force 强制穿透缓存拿云库最新 */
  async onPullDownRefresh() {
    const seq = this.nextSeq();
    await this.refreshFirstPage(seq, true, true);
    wx.stopPullDownRefresh();
  },

  /** 触底翻页:追加下一页,无更多时底部提示(全量已在上次刷新时拉取并排序,翻页仅本地切片) */
  async onReachBottom() {
    if (this.data.loading || this.data.loadingMore || !this.data.hasMore) return;
    const seq = this.requestSeq;
    const nextPage = this.data.page + 1;
    this.setData({ loadingMore: true });
    try {
      const sorted = this.fullList || [];
      const slice = sorted.slice((nextPage - 1) * PAGE_SIZE, nextPage * PAGE_SIZE);
      if (seq !== this.requestSeq) return; // 期间发生刷新/条件变化,丢弃过期翻页
      this.setData({
        list: this.data.list.concat(this.buildCards(slice)),
        page: nextPage,
        hasMore: nextPage * PAGE_SIZE < sorted.length,
      });
    } catch (err) {
      if (seq !== this.requestSeq) return;
      console.error('菜谱翻页加载失败', err);
      this.showFail();
    } finally {
      if (seq === this.requestSeq) this.setData({ loadingMore: false });
    }
  },

  /** 统一失败提示 */
  showFail() {
    this.onShowToast('#t-toast', '操作失败，请重试');
  },
});
