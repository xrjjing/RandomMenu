/**
 * components/bar-chart/index.js
 * 柱状图组件(Canvas 2D 自绘,零外部依赖;样式与全局暖橙主题 #ff8c42 一致)。
 * - properties:data 元素 {label, value}(已按展示顺序传入)、unit(默认 '次')
 * - 柱体主色 #ff8c42,柱顶圆角(自绘圆角矩形路径);value 为 0 的项画极矮灰柱占位保持列对齐
 * - x 轴标签:≤8 项全显,>8 项隔行显示(奇数下标跳过,避免重叠);y 轴不画,
 *   仅顶部 3 条虚线网格(浅灰)+ 左上角最大值标注
 * - 柱子点击:记录每根柱的命中矩形(整列区域),命中后 triggerEvent('barTap', {label, value})
 * - 空数据:canvas 清空,组件内 wxml 覆盖层显示「暂无数据」(canvas 始终渲染保证可查询)
 * - observers data 变化重绘;canvas 初始化参照 spin-wheel 的 dpr 缩放模式
 * - 组件宽高由外层容器决定(建议 100% × 固定 420rpx)
 */

/** 柱体主色(与全局主色一致) */
const BAR_COLOR = '#ff8c42';
/** 0 值占位灰柱颜色 */
const BAR_ZERO_COLOR = '#e5e5e5';
/** 虚线网格浅灰 */
const GRID_COLOR = '#e8e8e8';
/** 文字色 */
const TEXT_COLOR = '#999';
/** 柱顶圆角半径上限(px) */
const MAX_RADIUS = 4;
/** 0 值灰柱高度(px),保持列对齐的极矮占位 */
const ZERO_BAR_HEIGHT = 4;

Component({
  properties: {
    /** 柱状图数据:元素 {label, value},已按展示顺序传入 */
    data: {
      type: Array,
      value: [],
    },
    /** 数值单位,默认 '次'(左上角最大值标注与父页面 toast 使用) */
    unit: {
      type: String,
      value: '次',
    },
  },

  data: {},

  observers: {
    /** data 变化:canvas 就绪则重绘,未就绪置 pendingDraw 待 ready 补绘 */
    data() {
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
        .select('#bar-canvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const info = res && res[0];
          if (!info || !info.node) {
            console.error('柱状图 canvas 初始化失败,请升级基础库至 2.9.0+');
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
    /**
     * 自绘圆角矩形路径(不依赖 ctx.roundRect,兼容性更稳)。
     * @param {object} ctx canvas 2d 上下文
     * @param {number} x 左上角 x
     * @param {number} y 左上角 y
     * @param {number} w 宽
     * @param {number} h 高
     * @param {number} r 圆角半径(自动收敛到宽/高一半以内)
     */
    roundRectPath(ctx, x, y, w, h, r) {
      const rr = Math.max(0, Math.min(r, w / 2, h / 2));
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.lineTo(x + w - rr, y);
      ctx.arcTo(x + w, y, x + w, y + rr, rr);
      ctx.lineTo(x + w, y + h - rr);
      ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
      ctx.lineTo(x + rr, y + h);
      ctx.arcTo(x, y + h, x, y + h - rr, rr);
      ctx.lineTo(x, y + rr);
      ctx.arcTo(x, y, x + rr, y, rr);
      ctx.closePath();
    },

    /**
     * 绘制柱状图:顶部虚线网格 + 最大值标注 + 圆角柱体 + x 轴标签。
     * 同时记录每根柱的命中矩形(整列区域,从绘图区顶到底),供点击命中检测。
     */
    draw() {
      if (!this.ctx || !this.cssWidth) return;
      const ctx = this.ctx;
      const W = this.cssWidth;
      const H = this.cssHeight;
      ctx.clearRect(0, 0, W, H);
      const items = this.data.data || [];
      this.hitRects = [];
      if (items.length === 0) return; // 空数据:canvas 已清空,wxml 覆盖层显示「暂无数据」

      // 绘制区边距:顶部留给最大值标注,底部留给 x 轴标签
      const PAD_TOP = 36;
      const PAD_BOTTOM = 36;
      const PAD_LEFT = 10;
      const PAD_RIGHT = 10;
      const plotW = W - PAD_LEFT - PAD_RIGHT;
      const plotH = H - PAD_TOP - PAD_BOTTOM;
      const values = items.map((item) => Number(item.value) || 0);
      const max = Math.max(1, ...values); // 兜底 1,避免除零

      // 顶部虚线网格 3 条(25%/50%/75% 高度),浅灰;y 轴不画
      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      [0.25, 0.5, 0.75].forEach((ratio) => {
        const y = PAD_TOP + plotH * (1 - ratio);
        ctx.beginPath();
        ctx.moveTo(PAD_LEFT, y);
        ctx.lineTo(PAD_LEFT + plotW, y);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // 左上角最大值标注
      ctx.fillStyle = TEXT_COLOR;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${max}${this.data.unit}`, PAD_LEFT, PAD_TOP / 2);

      const n = items.length;
      const slot = plotW / n;
      const barW = Math.max(3, slot * 0.55);
      const showAllLabels = n <= 8; // ≤8 项标签全显,>8 项隔行显示(奇数下标跳过)

      items.forEach((item, i) => {
        const value = values[i];
        // 命中矩形:整列区域(从绘图区顶到底),点击该列任意高度都命中,方便小柱体点击
        this.hitRects.push({
          label: item.label,
          value,
          x: PAD_LEFT + i * slot,
          y: PAD_TOP,
          width: slot,
          height: plotH,
        });
        const x = PAD_LEFT + i * slot + (slot - barW) / 2;
        if (value <= 0) {
          // 0 值:极矮灰柱占位,保持列对齐
          const gy = PAD_TOP + plotH - ZERO_BAR_HEIGHT;
          ctx.fillStyle = BAR_ZERO_COLOR;
          this.roundRectPath(ctx, x, gy, barW, ZERO_BAR_HEIGHT, Math.min(2, barW / 2));
          ctx.fill();
        } else {
          const h = (value / max) * plotH;
          const y = PAD_TOP + plotH - h;
          ctx.fillStyle = BAR_COLOR;
          this.roundRectPath(ctx, x, y, barW, h, Math.min(MAX_RADIUS, barW / 2, h / 2));
          ctx.fill();
        }
        // x 轴标签(短标签如日号/月号;菜名较长时由页面保证数量级可控)
        if (showAllLabels || i % 2 === 0) {
          ctx.fillStyle = TEXT_COLOR;
          ctx.font = '10px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(String(item.label), PAD_LEFT + i * slot + slot / 2, PAD_TOP + plotH + 18);
        }
      });
    },

    /** canvas 触摸按下:命中检测 → triggerEvent('barTap', {label, value}) */
    onCanvasTouch(e) {
      const { x, y } = e.detail || {};
      if (x == null || y == null) return;
      const rects = this.hitRects || [];
      for (const rect of rects) {
        if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
          this.triggerEvent('barTap', { label: rect.label, value: rect.value });
          return;
        }
      }
    },
  },
});
