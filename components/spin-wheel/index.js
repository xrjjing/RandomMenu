/**
 * components/spin-wheel/index.js
 * 随机转盘组件(Canvas 2D 绘制,父页面通过 items 传入候选)。
 * - items 超过 12 项时随机抽样 12 项上盘(盘面可读性优先),绘制前缓存本次盘面名单 spinItems
 * - 等分扇区:相邻扇区交替三种暖色系底(暖橙/杏橙/米白,与全局主色 #ff8c42 同色系),
 *   白色细分隔线 + 外圈主色粗环 + 环上均布白色小灯珠(静态装饰);菜名沿半径方向绘制
 *   (限 6 字,超出截断加…,旋转坐标系实现)
 * - 指针固定在正上方(wxml CSS 向下三角,白描边);中央圆钮「转」可点击触发旋转
 * - spin():随机基础圈数 5~7 圈 + 目标扇区中心角 + ±30% 扇区角随机偏移,
 *   requestAnimationFrame 两段式缓动(前 20% 加速 + 后 80% 长减速,约 3.5s)插值角度
 * - 结束后 triggerEvent('spinend', { index, item }),开始时 triggerEvent('spinstart')
 * - pageLifetimes.hide 时若在转:直接结算到目标角度并触发结果事件,避免后台空转
 */

/** 扇区底色三色循环:暖色系交替(暖橙/杏橙/米白,比旧版更鲜明) */
const SECTOR_COLORS = ['#ffe3cc', '#ffd1a3', '#fff1e6'];
/** 菜名文字色:深棕,保证浅底上的对比度 */
const TEXT_COLOR = '#5a3312';
/** 外圈描边主色:与全局主色一致 */
const RING_COLOR = '#ff8c42';
/** 外圈环上白色小灯珠数量(静态装饰) */
const LIGHT_COUNT = 20;
/** 盘面最大扇区数(盘面可读性优先,超出随机抽样) */
const MAX_SLICES = 12;
/** 旋转总时长(ms) */
const SPIN_DURATION = 3500;
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
      this.initCanvasWithRetry();
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
    /**
     * 初始化画布(node 查询 + 尺寸换算)。
     * 尺寸来源不再依赖 boundingClientRect(size 查询):本组件在 t-popup 内,ready 触发时
     * 弹层展开动画尚未结束,该场景下 boundingClientRect 恒为 0(F13 的 200ms×10 重试实测
     * 全部超时,治标不治本)。故改为双保险、零时序依赖:
     * - .fields({ node: true }) 只取节点:节点在 DOM 树即返回,不受 visibility/布局影响
     * - 尺寸用系统信息换算:index.less 的 .spin-canvas 定宽 600rpx,换算公式
     *   600 / 750 × windowWidth(两处若改宽度需同步),彻底绕开 size 查询缺陷
     * - 重试仅保底 node 拿不到的情况(极旧基础库等):上限 3 次,node 查询正常时一次就中
     */
    initCanvasWithRetry() {
      this.createSelectorQuery()
        .select('#spin-canvas')
        .fields({ node: true })
        .exec((res) => {
          const info = res && res[0];
          const node = info && info.node;
          if (!node) {
            // 极端环境(基础库过旧等):延迟重试保底,超限仅记录错误放弃,页面层仍可正常交互
            this.initRetryCount = (this.initRetryCount || 0) + 1;
            if (this.initRetryCount > 3) {
              console.error('转盘 canvas 初始化失败,请升级基础库至 2.9.0+');
              return;
            }
            setTimeout(() => this.initCanvasWithRetry(), 200);
            return;
          }
          // 拿到节点:完成初始化并清零重试计数;尺寸换算绕开 popup 场景 size 查询恒 0 的工具缺陷
          this.initRetryCount = 0;
          const sysInfo = wx.getSystemInfoSync();
          const dpr = sysInfo.pixelRatio || 2;
          // 600 是 index.less 的 .spin-canvas 定宽(rpx),与下方换算公式两处需同步修改
          const cssSize = Math.round((600 / 750) * sysInfo.windowWidth);
          node.width = cssSize * dpr;
          node.height = cssSize * dpr;
          const ctx = node.getContext('2d');
          ctx.scale(dpr, dpr);
          this.canvas = node;
          this.ctx = ctx;
          this.cssSize = cssSize; // canvas CSS 像素尺寸(绘制坐标基准),对应 .spin-canvas 600rpx
          if (this.pendingDraw) {
            this.pendingDraw = false;
            this.draw(0);
          }
        });
    },

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
     * @param {number} highlightIndex 高亮扇区下标(停转后标出选中结果);-1 表示不高亮
     */
    draw(rotationDeg = 0, highlightIndex = -1) {
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
      // 字号随盘面尺寸自适应(约 cssSize 的 5%),沿半径方向写 6 字不溢出
      const fontSize = Math.max(13, Math.round(size * 0.05));

      // 盘面整体旋转:扇区与文字都画在旋转坐标系内,指针固定在正上方不动
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((rotationDeg * Math.PI) / 180);
      // 等分扇区:相邻扇区交替三种浅色底,白色分隔线;
      // 高亮扇区(停转后的目标):底色换深一档杏橙 #ffb37a,并多一遍深色粗描边;先 fill 后 stroke 顺序不变
      for (let i = 0; i < n; i += 1) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, R - 6, i * slice, (i + 1) * slice);
        ctx.closePath();
        ctx.fillStyle = i === highlightIndex ? '#ffb37a' : SECTOR_COLORS[i % SECTOR_COLORS.length];
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5; // 白色细分隔线
        ctx.stroke();
        if (i === highlightIndex) {
          ctx.strokeStyle = '#e06a1f';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
      }
      // 菜名:旋转坐标系下竖排逐字、从内向外排列(真实转盘样式,字不躺着、天然居中在扇区中线)
      // 字列起点 0.35R,每字沿半径向外步进 ~1.15 字号;6 字 × step ≈ 103px,0.35R + 103 < R 不溢出
      ctx.fillStyle = TEXT_COLOR;
      ctx.font = `600 ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < n; i += 1) {
        const item = items[i];
        const chars = Array.from(this.truncateName(item && item.name));
        const step = Math.round(fontSize * 1.15);
        const startR = R * 0.35;
        ctx.save();
        ctx.rotate(i * slice + slice / 2);
        for (let k = 0; k < chars.length; k += 1) {
          ctx.fillText(chars[k], startR + k * step, 0);
        }
        ctx.restore();
      }
      ctx.restore();

      // 外圈主色粗环
      ctx.beginPath();
      ctx.arc(cx, cy, R - 6, 0, Math.PI * 2);
      ctx.strokeStyle = RING_COLOR;
      ctx.lineWidth = 8;
      ctx.stroke();
      // 环上均布白色小灯珠:圆心位于环中心线(R-6),半径随盘面尺寸,纯静态装饰
      const lightRadius = Math.max(2, size * 0.02);
      for (let i = 0; i < LIGHT_COUNT; i += 1) {
        const lightAngle = (Math.PI * 2 * i) / LIGHT_COUNT;
        ctx.beginPath();
        ctx.arc(cx + (R - 6) * Math.cos(lightAngle), cy + (R - 6) * Math.sin(lightAngle), lightRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
      }
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
        // 两段式缓动更接近真实转盘:前 20% 起步加速(easeInQuad),后 80% 长减速(easeOutCubic)
        // eased(0)=0、eased(0.2)=0.04、eased(1)=1,衔接处连续
        const easeOutCubic = (x) => 1 - (1 - x) ** 3;
        const eased =
          progress < 0.2
            ? (progress / 0.2) ** 2 * 0.04
            : 0.04 + easeOutCubic((progress - 0.2) / 0.8) * 0.96;
        const angle = startAngle + totalAngle * eased;
        this.currentAngle = angle;
        this.draw(angle);
        if (progress < 1) {
          this.rafId = this.canvas.requestAnimationFrame(step);
        } else {
          this.rafId = null;
          this.currentAngle = targetAngle % 360;
          // 停转后高亮目标扇区:指针固定正上方 + 高亮扇区 = 双重指示选中结果
          this.draw(this.currentAngle, this.targetIndex);
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
