/**
 * components/pie-chart/index.js
 * 饼图(环形)组件(Canvas 2D 自绘,零外部依赖;暖橙系色板与全局主题一致)。
 * - properties:data 元素 {name, value}(已含「其他」聚合项,由父层处理)
 * - canvas 绘制:暖橙系 6 色循环色板,值越小透明度越低(体现占比差异);
 *   中心镂空成环形(内半径 0.55R),环心显示总次数大字 + 「共计」小字
 * - 图例不用 canvas 画:wxml 渲染两列网格列表(色点 + 名称 + 次数 + 百分比),保证文字清晰
 * - 空数据:canvas 清空,组件内 wxml 覆盖层显示「暂无数据」(canvas 始终渲染保证可查询)
 * - observers data 变化重绘;canvas 初始化参照 spin-wheel 的 dpr 缩放模式
 */

/** 暖橙系色板(6 色循环,与全局主色 #ff8c42 同色系) */
const PALETTE = ['#ff8c42', '#ffb380', '#ffd9b8', '#e0762f', '#fff1e6', '#7a4a1e'];
/** 环内半径比例(相对外半径) */
const INNER_RATIO = 0.55;
/** 白色分隔线宽度 */
const SPLIT_WIDTH = 2;

Component({
  properties: {
    /** 饼图数据:元素 {name, value},已含「其他」聚合项 */
    data: {
      type: Array,
      value: [],
    },
  },

  data: {
    legendItems: [], // 图例列表:{name, value, color, percent}
  },

  observers: {
    /** data 变化:重建图例并重绘 */
    data(items) {
      this.buildLegend(items);
      if (this.ctx && this.cssWidth) {
        this.draw();
      } else {
        this.pendingDraw = true;
      }
    },
  },

  lifetimes: {
    /** 组件就绪:初始化 canvas 节点(按 dpr 缩放,坐标以 CSS 像素为基准) */
    ready() {
      this.createSelectorQuery()
        .select('#pie-canvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const info = res && res[0];
          if (!info || !info.node) {
            console.error('饼图 canvas 初始化失败,请升级基础库至 2.9.0+');
            return;
          }
          const { node, width, height } = info;
          const dpr = wx.getSystemInfoSync().pixelRatio || 2;
          node.width = width * dpr;
          node.height = height * dpr;
          const ctx = node.getContext('2d');
          ctx.scale(dpr, dpr);
          this.canvas = node;
          this.ctx = ctx;
          this.cssWidth = width; // CSS 像素宽(绘制坐标基准)
          this.cssHeight = height;
          if (this.pendingDraw) {
            this.pendingDraw = false;
            this.draw();
          }
        });
    },

    /** 组件销毁:清理引用 */
    detached() {
      this.canvas = null;
      this.ctx = null;
    },
  },

  methods: {
    /** 重建图例:按 data 顺序分配色板颜色,计算次数与百分比(保留 1 位小数) */
    buildLegend(items) {
      const list = (items || []).map((item, i) => ({
        name: item.name,
        value: Number(item.value) || 0,
        color: PALETTE[i % PALETTE.length],
        percent: '',
      }));
      const total = list.reduce((sum, item) => sum + item.value, 0);
      if (total > 0) {
        list.forEach((item) => {
          item.percent = Math.round((item.value / total) * 1000) / 10;
        });
      }
      this.setData({ legendItems: list });
    },

    /**
     * 绘制环形饼图:从正上方开始顺时针;每个扇区按色板取色,
     * 透明度随值占比线性变化(值小透明度降低);中心白色覆盖镂空成环,再画环心文字。
     */
    draw() {
      if (!this.ctx || !this.cssWidth) return;
      const ctx = this.ctx;
      const W = this.cssWidth;
      const H = this.cssHeight;
      ctx.clearRect(0, 0, W, H);
      const items = this.data.data || [];
      if (items.length === 0) return; // 空数据:canvas 已清空,wxml 覆盖层显示「暂无数据」

      const total = items.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
      if (total <= 0) return;
      const cx = W / 2;
      const cy = H / 2;
      const R = Math.min(W, H) / 2 - 4; // 外半径(留白)
      const innerR = R * INNER_RATIO; // 内半径:中心镂空成环
      const maxValue = Math.max(...items.map((item) => Number(item.value) || 0));

      // 扇区:从正上方(-90°)开始顺时针;透明度 = 0.5 + 0.5*(值/最大值),值小透明度可降
      let start = -Math.PI / 2;
      items.forEach((item, i) => {
        const value = Number(item.value) || 0;
        const angle = (value / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R, start, start + angle);
        ctx.closePath();
        ctx.globalAlpha = 0.5 + 0.5 * (value / maxValue);
        ctx.fillStyle = PALETTE[i % PALETTE.length];
        ctx.fill();
        ctx.globalAlpha = 1;
        // 白色分隔线
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = SPLIT_WIDTH;
        ctx.stroke();
        start += angle;
      });

      // 中心镂空:白色内圆覆盖(内半径 0.55R),形成环形
      ctx.beginPath();
      ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();

      // 环心:总次数大字 + 「共计」小字
      ctx.fillStyle = '#333';
      ctx.font = '600 28px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(total), cx, cy - 10);
      ctx.fillStyle = '#999';
      ctx.font = '12px sans-serif';
      ctx.fillText('共计', cx, cy + 20);
    },
  },
});
