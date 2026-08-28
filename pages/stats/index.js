/**
 * pages/stats/index.js
 * 统计页(主包 tab「统计」):做菜记录按日/月/年粒度聚合,柱状图/饼图展示 + 原料榜。
 * - 顶部粒度切换 t-tabs:日 / 月 / 年 / 原料榜;标题旁左右箭头切换上一期/下一期
 *   (日 ±1 天、月 ±1 月、年 ±1 年),未来期不允许(超出今天则右箭头禁用)
 * - 图型切换 t-tag:「柱状图 / 饼图」,切到原料榜时保持当前选择
 * - 数据源 statsAggregate({from, to}):日=当天(柱状按菜/饼图按菜 Top8+其他)、
 *   月=当月(柱状按日 1~31 补零/饼图按菜)、年=当年(柱状按月 1~12 补零/饼图按菜)
 * - 原料榜:byIngredient 排行(名次、名称、次数进度条),顶部 t-switch「含调料」默认关;
 *   注:addCookRecord 快照已排除调料,开关用于过滤 records 里历史遗留的调料名
 *   (用 utils/seasonings.js 的 SEASONING_SET 过滤即可,见 utils/stats.js)
 * - 加载态 t-loading;空态「这一期还没有做菜记录」+ 引导「去首页转一转吧」
 * - onShow 静默刷新(返回/切 tab 数据最新)
 * 期计算与数据组装等纯逻辑收敛在 utils/stats.js,页面只做状态管理。
 * 数据库操作一律走 api/db.js 封装,页面不直接调用 wx.cloud。
 */
import useToastBehavior from '../../behaviors/useToast.js';
import { statsAggregate } from '../../api/db.js';
import { computePeriod, buildBarData, buildPieData, buildIngredientRanking } from '../../utils/stats.js';
import { ensureIdentity } from '../../api/identity.js';

Page({
  behaviors: [useToastBehavior],

  data: {
    activeTab: 'day', // t-tabs 当前页签:day / month / year / ingredient
    granularity: 'day', // 期粒度:day / month / year(原料榜页签时仍按此粒度翻期)
    offset: 0, // 距当前期偏移:0=今天/当月/当年,负数为过去
    chartType: 'bar', // 图型:bar 柱状图 | pie 饼图
    periodText: '', // 当前期文案(如「8月23日」「2026年8月」「2026年」)
    prevDisabled: false, // 左箭头(上一期)是否禁用:过去期永远可用
    nextDisabled: true, // 右箭头(下一期)是否禁用:超出今天禁用
    loading: true, // 加载态
    empty: false, // 空态(当期无做菜记录)
    barData: [], // 柱状图数据:{label, value}
    pieData: [], // 饼图数据:{name, value}(已含「其他」)
    ingredientList: [], // 原料榜:{rank, name, count, percent, top}
    includeSeasoning: false, // 原料榜「含调料」开关,默认关
  },

  onLoad() {
    this.firstShow = true; // 首次 onShow 不重复加载
    this.identityReady = null; // 身份加载单例 Promise(避免并发重复拉取)
    this.member = null; // 当前成员文档(null = 未注册/未就绪,统计先按未分配池查)
    this.load(false);
  },

  onShow() {
    // 非首次进入(tab 切回 / 从其他页返回)静默刷新,保证数据最新
    if (!this.firstShow) {
      // 身份可能已变化(其他设备被 admin 改家庭/在首页完成注册):每次进入重新实查
      this.identityReady = null;
      this.load(true);
    }
    this.firstShow = false;
  },

  /* ---------------- 粒度 / 期切换 ---------------- */

  /** t-tabs 切换:日/月/年切粒度并回到当前期(offset=0),原料榜页签沿用当前粒度与期 */
  onTabChange(e) {
    const value = e.detail.value;
    const isGranularity = value === 'day' || value === 'month' || value === 'year';
    const next = { activeTab: value };
    if (isGranularity && value !== this.data.granularity) {
      next.granularity = value;
      next.offset = 0; // 切换粒度回到当前期(今天/当月/当年)
    }
    if (next.activeTab !== this.data.activeTab || next.offset !== undefined) {
      this.setData(next);
      this.load(false);
    }
  },

  /* ---------------- AI 小结入口 ---------------- */

  /** 跳转 AI 报菜员小结页(分包 packages/ai;主包零 import 分包,仅页面跳转) */
  onAiSummary() {
    wx.navigateTo({ url: '/packages/ai/summary' });
  },

  /** 上一期:offset - 1(过去期永远允许) */
  onPrev() {
    this.setData({ offset: this.data.offset - 1 });
    this.load(false);
  },

  /** 下一期:offset + 1(未来期禁用) */
  onNext() {
    if (this.data.nextDisabled) return;
    this.setData({ offset: this.data.offset + 1 });
    this.load(false);
  },

  /* ---------------- 图型切换 ---------------- */

  /** t-tag 切换柱状图 / 饼图(原料榜页签时保持当前选择,切回仍生效) */
  onChartTypeTap(e) {
    const type = e.currentTarget.dataset.type;
    if (type === this.data.chartType) return;
    this.setData({ chartType: type });
  },

  /* ---------------- 数据加载与组装 ---------------- */

  /* ---------------- 身份(家庭多租户) ---------------- */

  /** 加载身份:ensureIdentity 幂等单例;失败静默降级为未分配池,不打断统计展示 */
  loadIdentity() {
    if (!this.identityReady) {
      this.identityReady = ensureIdentity()
        .then(({ member }) => {
          this.member = member;
        })
        .catch((err) => {
          console.error('身份加载失败', err);
          this.identityReady = null; // 清单例,下次调用重新发起
        });
    }
    return this.identityReady;
  },

  /**
   * 加载当前期统计:statsAggregate({from, to}) 一次聚合出 byDate/byDish/byIngredient,
   * 按粒度与图型组装 barData / pieData,并重建原料榜列表(组装逻辑见 utils/stats.js)。
   * @param {boolean} silent 静默刷新(true 时不显示 loading,失败保留旧数据)
   */
  async load(silent) {
    const period = computePeriod(this.data.granularity, this.data.offset);
    const patch = {
      periodText: period.text,
      prevDisabled: period.prevDisabled,
      nextDisabled: period.nextDisabled,
    };
    if (!silent) patch.loading = true;
    this.setData(patch);
    // 统计按当前成员所属家庭过滤;身份未就绪时先按未分配池('')查,不阻塞展示
    await this.loadIdentity();
    try {
      const stats = await statsAggregate({
        from: period.from,
        to: period.to,
        familyId: this.member ? this.member.familyId : '',
      });
      this.stats = stats; // 缓存,原料榜开关切换时复用
      const barData = buildBarData(this.data.granularity, stats, period);
      const pieData = buildPieData(stats.byDish);
      this.buildIngredientList(barData, pieData);
      this.setData({ barData, pieData, loading: false });
    } catch (err) {
      console.error('统计加载失败', err);
      this.setData({ loading: false });
      if (!silent) this.showFail();
    }
  },

  /**
   * 重建原料榜列表(见 utils/stats.js buildIngredientRanking):
   * 「含调料」关时过滤历史遗留调料名;同时按当前页签与图型刷新空态标记。
   */
  buildIngredientList(barData, pieData) {
    const byIngredient = (this.stats && this.stats.byIngredient) || [];
    const ingredientList = buildIngredientRanking(byIngredient, this.data.includeSeasoning);
    // 空态:原料榜看列表是否为空;图表看柱状(全 0 视为空)或饼图(无数据)是否为空
    const chartEmpty =
      !barData.length ||
      barData.every((item) => item.value <= 0) ||
      (this.data.chartType === 'pie' && !pieData.length);
    this.setData({
      ingredientList,
      empty: this.data.activeTab === 'ingredient' ? ingredientList.length === 0 : chartEmpty,
    });
  },

  /* ---------------- 原料榜开关 ---------------- */

  /** 「含调料」开关:不重新拉数据,仅按开关重新过滤/组装原料榜 */
  onSeasoningChange(e) {
    this.setData({ includeSeasoning: !!e.detail.value });
    this.buildIngredientList(this.data.barData, this.data.pieData);
  },

  /* ---------------- 图表交互 ---------------- */

  /** 柱状图柱子点击:toast 显示「xxx：N 次」 */
  onBarTap(e) {
    const { label, value } = e.detail || {};
    if (label == null || value == null) return;
    this.onShowToast('#t-toast', `${label}：${value} 次`);
  },

  /* ---------------- 工具 ---------------- */

  /** 统一失败提示 */
  showFail() {
    this.onShowToast('#t-toast', '操作失败，请重试');
  },
});
