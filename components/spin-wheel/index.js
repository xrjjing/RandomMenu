/**
 * components/spin-wheel/index.js
 * 随机转盘组件(Canvas 2D 绘制,父页面通过 items 传入候选)。
 * - items 超过 12 项时随机抽样 12 项上盘(盘面可读性优先),绘制前缓存本次盘面名单 spinItems
 * - 等分扇区:相邻扇区交替三种浅色底(暖橙/浅橙/米白,与全局主色 #ff8c42 同色系),
 *   外圈主色描边;菜名沿半径方向绘制(限 6 字,超出截断加…,旋转坐标系实现)
 * - 指针固定在正上方(wxml CSS 向下三角);中央圆钮「转」可点击触发旋转
 * - spin():随机基础圈数 5~7 圈 + 目标扇区中心角 + ±30% 扇区角随机偏移,
 *   requestAnimationFrame 缓动(easeOutCubic,约 4s)插值角度
 * - 结束后 triggerEvent('spinend', { index, item }),开始时 triggerEvent('spinstart')
 * - pageLifetimes.hide 时若在转:直接结算到目标角度并触发结果事件,避免后台空转
 */

/** 扇区底色三色循环:浅橙(全局 --td-brand-color-light)/ 暖橙浅 / 米白 */
const SECTOR_COLORS = ['#fff1e6', '#ffd9b8', '#fdf3e8'];
/** 菜名文字色:深棕橙,保证浅底上的对比度 */
const TEXT_COLOR = '#7a4a1e';
/** 外圈描边主色:与全局主色一致 */
const RING_COLOR = '#ff8c42';
/** 盘面最大扇区数(盘面可读性优先,超出随机抽样) */
const MAX_SLICES = 12;
/** 旋转总时长(ms) */
const SPIN_DURATION = 4000;
/** 菜名最大展示字数,超出截断加省略号 */
const MAX_NAME_LEN = 6;

Component({
  properties: {
    /** 候选菜品列表:元素 { id, name } */
    items: {
      type: Array,
      value: [],
    },
  },

  data: {
    spinItems: [], // 本次盘面名单(绘制缓存,超 12 项时已随机抽样)
    spinning: false, // 是否正在旋转
  },

  observers: {
    /** items 变化:刷新盘面名单;未在旋转中则重绘盘面 */
    items(items) {
      if (!Array.isArray(items)) return;
      this.setData({ spinItems: this.buildSpinItems(items) });
      if (this.data.spinning) return; // 旋转中不重绘,避免盘面闪动
      this.currentAngle = 0;
      if (this.canvas && this.ctx) {
        this.draw(0);
      } else {
        this.pendingDraw = true; // canvas 未就绪,ready 后补绘
      }
    },
  },

  pageLifetimes: {
    /** 页面切后台:若正在旋转,立即结算到目标角度并触发结果事件,避免后台空转 */
    hide() {
      if (this.data.spinning) {
        if (this.rafId != null && this.canvas) {
          this.canvas.cancelAnimationFrame(this.rafId);
          this.rafId = null;
        }
        this.currentAngle = this.targetAngle % 360;
        this.draw(this.currentAngle);
        this.setData({ spinning: false });
        this.triggerEvent('spinend', { index: this.targetIndex, item: this.targetItem });
      }
    },
  },

  lifetimes: {
    /** 组件创建:初始化画布节点(按 dpr 缩放);绘制失败仅 console.error,不白屏 */
    ready() {
      this.createSelectorQuery()
        .select('#spin-canvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const info = res && res[0];
          if (!info || !info.node) {
            // 极端环境(基础库过旧等):记录错误,页面层仍可正常交互
            console.error('转盘 canvas 初始化失败,请升级基础库至 2.9.0+');
            return;
          }
          const { node, width } = info;
          const dpr = wx.getSystemInfoSync().pixelRatio || 2;
          node.width = width * dpr;
          node.height = width * dpr;
          const ctx = node.getContext('2d');
          ctx.scale(dpr, dpr);
          this.canvas = node;
          this.ctx = ctx;
          this.cssSize = width; // canvas CSS 像素尺寸(绘制坐标基准)
          if (this.pendingDraw) {
            this.pendingDraw = false;
            this.draw(0);
          }
        });
    },

    /** 组件销毁:取消未完成的动画帧 */
    detached() {
      if (this.rafId != null && this.canvas) {
        this.canvas.cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
    },
  },

  methods: {
    /** 生成盘面名单:超过 12 项时随机抽样 12 项(Fisher-Yates 洗牌取前 12) */
    buildSpinItems(items) {
      const list = items.slice();
      if (list.length > MAX_SLICES) {
        for (let i = list.length - 1; i > 0; i -= 1) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = list[i];
          list[i] = list[j];
          list[j] = tmp;
        }
        list.length = MAX_SLICES;
      }
      return list;
    },

    /** 菜名限 6 字,超出截断加省略号(按码点截取,避免 emoji 半字符) */
    truncateName(name) {
      const chars = Array.from(name || '');
      return chars.length > MAX_NAME_LEN ? `${chars.slice(0, MAX_NAME_LEN).join('')}…` : name;
    },

    /**
     * 绘制盘面。
     * @param {number} rotationDeg 盘面当前旋转角度(顺时针);0 表示第 0 个扇区起于正上方
     */
    draw(rotationDeg = 0) {
      if (!this.ctx || !this.cssSize) return;
      const size = this.cssSize;
      const cx = size / 2;
      const cy = size / 2;
      const R = size / 2 - 10; // 外圈描边预留
      const ctx = this.ctx;
      const items = this.data.spinItems;
      const n = items.length;
      ctx.clearRect(0, 0, size, size);
      if (n === 0) return;
      const slice = (Math.PI * 2) / n;
      // 字号随盘面尺寸自适应,沿半径方向写 6 字不溢出
      const fontSize = Math.max(13, Math.round(size / 20));

      // 盘面整体旋转:扇区与文字都画在旋转坐标系内,指针固定在正上方不动
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((rotationDeg * Math.PI) / 180);
      // 等分扇区:相邻扇区交替三种浅色底,白色分隔线
      for (let i = 0; i < n; i += 1) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, R - 6, i * slice, (i + 1) * slice);
        ctx.closePath();
        ctx.fillStyle = SECTOR_COLORS[i % SECTOR_COLORS.length];
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      // 菜名:旋转坐标系下沿半径方向绘制(文字中心位于 0.72R 处)
      ctx.fillStyle = TEXT_COLOR;
      ctx.font = `600 ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < n; i += 1) {
        const item = items[i];
        ctx.save();
        ctx.rotate(i * slice + slice / 2);
        ctx.fillText(this.truncateName(item && item.name), R * 0.72, 0);
        ctx.restore();
      }
      ctx.restore();

      // 外圈主色描边
      ctx.beginPath();
      ctx.arc(cx, cy, R - 6, 0, Math.PI * 2);
      ctx.strokeStyle = RING_COLOR;
      ctx.lineWidth = 8;
      ctx.stroke();
    },

    /**
     * 开始旋转:随机目标扇区,基础圈数 5~7 圈 + 扇区中心角 + ±30% 扇区角偏移。
     * 目标角度换算:canvas 角度系 0° 指向正右方、顺时针为正;指针固定正上方即 270°。
     * 扇区 i 中心在 canvas 角 centerAngle,盘面顺时针旋转 A 后位于 centerAngle + A,
     * 对准指针需 centerAngle + A ≡ 270 (mod 360),故 A ≡ (270 - centerAngle) + 偏移。
     */
    spin() {
      if (this.data.spinning) return;
      const items = this.data.spinItems;
      if (!items || items.length === 0) return;
      if (!this.canvas || !this.ctx) {
        console.error('转盘 canvas 未初始化,无法旋转');
        return;
      }
      const n = items.length;
      const sliceAngle = 360 / n;
      const targetIndex = Math.floor(Math.random() * n); // 随机目标扇区
      const centerAngle = targetIndex * sliceAngle + sliceAngle / 2;
      const offset = (Math.random() * 2 - 1) * sliceAngle * 0.3; // ±30% 扇区角
      const baseTurns = 5 + Math.floor(Math.random() * 3); // 5~7 圈
      // 盘面需顺时针转 (270 - centerAngle) 使目标扇区中心对准正上方指针(+360 保证为正)
      let targetAngle = baseTurns * 360 + ((270 - centerAngle + 360) % 360) + offset;
      // 从当前角度继续累加,避免角度回退
      const startAngle = this.currentAngle || 0;
      while (targetAngle <= startAngle) targetAngle += 360;
      const totalAngle = targetAngle - startAngle;
      const startTime = Date.now();
      // 缓存目标信息,供页面隐藏时直接结算
      this.targetAngle = targetAngle;
      this.targetIndex = targetIndex;
      this.targetItem = items[targetIndex];

      this.setData({ spinning: true });
      this.triggerEvent('spinstart');

      const step = () => {
        const elapsed = Date.now() - startTime;
        const progress = Math.min(elapsed / SPIN_DURATION, 1);
        // easeOutCubic:1 - (1-t)^3,先快后慢
        const eased = 1 - (1 - progress) ** 3;
        const angle = startAngle + totalAngle * eased;
        this.currentAngle = angle;
        this.draw(angle);
        if (progress < 1) {
          this.rafId = this.canvas.requestAnimationFrame(step);
        } else {
          this.rafId = null;
          this.currentAngle = targetAngle % 360;
          this.setData({ spinning: false });
          this.triggerEvent('spinend', { index: targetIndex, item: this.targetItem });
        }
      };
      this.rafId = this.canvas.requestAnimationFrame(step);
    },

    /** 中央圆钮「转」:与页面「开始旋转」等效 */
    onCenterTap() {
      this.spin();
    },
  },
});
