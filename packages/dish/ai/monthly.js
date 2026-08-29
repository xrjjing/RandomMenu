/**
 * packages/dish/ai/monthly.js
 * F30 #6 AI 月报 + 分享海报(分包页,主包统计页只放入口跳转):
 * - 进入检查 textEnabled,关闭显示空态
 * - 数据:本月 statsAggregate(from=当月1日,to=今天)+ 菜谱总数
 * - 生成月报文本(streamText 流式回显),随后画 Canvas 分享海报(非 AI 生图,纯前端绘制)
 * - 海报:canvas 2d 绘制(白底 + 渐变头 + 统计块 + AI 小结 + 页脚),导出临时图后可存相册/预览
 * 数据库操作走主包 api/db.js 与 api/identity.js 封装(分包可引主包,反向禁止)。
 */
import useToastBehavior from '../../../behaviors/useToast.js';
import { ensureIdentity } from '../../../api/identity.js';
import { statsAggregate, fetchAllDishes, dateKey } from '../../../api/db.js';
import { computePeriod } from '../../../utils/stats.js';
import { getAiConfig } from './config.js';
import { streamText } from './text.js';
import { generateDishImage } from './api.js';

/** 海报画布逻辑尺寸(pt),导出即此分辨率。1080 高 = 9:16 标准竖版,小结区可容纳全文不截断 */
const POSTER_W = 600;
const POSTER_H = 1080;

/** 按最大显示宽度把长文本折行(逐字量宽,适配中文;canvas 2d 专用) */
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

Page({
  behaviors: [useToastBehavior],

  data: {
    textEnabled: false, // AI 生文开关(关闭显示空态)
    periodText: '', // 当期文案(如「2026年9月」)
    loading: false, // 生成中
    reportText: '', // 月报正文
    error: '', // 失败文案(卡片内展示,可重试)
    reportStream: '', // 月报流式回显(生成中实时累计,完成后清空)
    posterReady: false, // 海报是否已绘制(控制按钮可用)
    aiPosterGenerating: false, // AI 生图海报生成中(防重复)
    aiPosterUrl: '', // AI 生图海报本地路径(下载原图或叠字导出后的临时路径)
    aiPosterFileId: '', // AI 生图海报云存储 fileID(cloud://)
    aiPosterError: '', // AI 生图海报失败文案(卡片内红字,保持本地海报可用)
  },

  onLoad() {
    this.posterPath = ''; // 海报临时文件路径(绘制成功后写入)
    this.posterCanvas = null; // canvas 2d 节点引用(绘制/导出复用)
    this.init();
  },

  /** 检查开关:开启则自动生成一次;关闭停留空态 */
  async init() {
    try {
      const cfg = await getAiConfig();
      this.setData({ textEnabled: cfg.textEnabled });
      if (cfg.textEnabled) this.generate();
    } catch (err) {
      console.error('AI 配置加载失败', err);
    }
  },

  /** 组装本月数据生文;成功后画海报。失败仅在卡片内展示文案 */
  async generate() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '', reportText: '', reportStream: '', posterReady: false });
    this.posterPath = '';
    try {
      const { member } = await ensureIdentity();
      const familyId = member ? member.familyId : '';
      const period = computePeriod('month', 0);
      const now = new Date();
      const [stats, dishes] = await Promise.all([
        statsAggregate({ from: period.from, to: dateKey(now), familyId }),
        fetchAllDishes(),
      ]);
      const byDish = stats.byDish || [];
      const byIngredient = stats.byIngredient || [];
      const monthTotal = byDish.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
      const dataText = JSON.stringify({
        月份: period.text,
        本月累计做饭次数: monthTotal,
        本月最常做: byDish.slice(0, 3),
        本月最爱原料: byIngredient.slice(0, 3),
        菜谱总数: dishes.length,
      });
      const cfg = await getAiConfig();
      const text = await streamText(
        [
          { role: 'system', content: cfg.prompts.monthly },
          { role: 'user', content: dataText },
        ],
        {
          // 流式:生成中实时回显到月报页,完成后统一 setData 文案再画海报
          onChunk: (chunk) => {
            this.setData({ reportStream: this.data.reportStream + chunk });
          },
        },
      );
      // 海报绘制素材保留在实例上(含 top 菜名/原料名),画完即渲染,页面只 setData 文案
      this.posterData = {
        periodText: period.text,
        monthTotal,
        topDishes: byDish.slice(0, 3),
        topIngredients: byIngredient.slice(0, 3),
        dishCount: dishes.length,
      };
      this.setData({ loading: false, reportText: text, periodText: period.text, reportStream: '' });
      // 等 setData 渲染出 canvas 节点后再画(节点须存在于节点树)
      setTimeout(() => this.drawPoster(text), 60);
    } catch (err) {
      console.error('AI 月报生成失败', err);
      this.setData({ loading: false, error: err.message || '生成失败，请重试', reportStream: '' });
    }
  },

  /** 重新生成 */
  onGenerate() {
    this.generate();
  },

  /* ---------------- 分享海报(Canvas 2d) ---------------- */

  /** 画海报:白底 + 渐变标题头 + 统计块 + AI 小结 + 页脚;导出临时路径供保存/预览 */
  async drawPoster(reportText) {
    try {
      const canvasNode = await this.getPosterCanvasNode(3);
      const dpr = wx.getSystemInfoSync().pixelRatio || 2;
      const canvas = canvasNode;
      canvas.width = POSTER_W * dpr;
      canvas.height = POSTER_H * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      this.posterCanvas = canvas;

      // 背景
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, POSTER_W, POSTER_H);

      // 渐变标题头(暖橙 → 深橙),高度 160
      const grad = ctx.createLinearGradient(0, 0, POSTER_W, 0);
      grad.addColorStop(0, '#ff9a5a');
      grad.addColorStop(1, '#ff6f3c');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, POSTER_W, 160);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 44px sans-serif';
      ctx.fillText('AI 月报', 48, 88);
      ctx.font = 'normal 26px sans-serif';
      ctx.fillText(this.posterData.periodText, 48, 130);

      this.drawPosterBody(ctx, reportText);

      const tempPath = await new Promise((resolve, reject) => {
        wx.canvasToTempFilePath({
          canvas: canvasNode,
          success: (res) => resolve(res.tempFilePath),
          fail: reject,
        });
      });
      this.posterPath = tempPath;
      this.setData({ posterReady: true });
    } catch (err) {
      console.error('海报绘制失败', err);
      this.setData({ posterReady: false });
    }
  },

  /** 统计块 + 最常做/最爱原料 + 小结卡 + 页脚(本地海报与 AI 生图海报共用排版,字体均显式带 weight)
   *  dark=true:AI 生图海报的暗背景模式(统计/最爱/页脚用白字,小结卡改浅底深字保证对比度)
   *  铁律:必须「先设 ctx.font 再 wrapText 量宽」——量宽用 A 字体、绘制用 B 字体会因宽度偏差溢出被裁 */
  drawPosterBody(ctx, reportText, dark = false) {
    // 统计块:两行,30px,行距 54,起点 y=212
    const rows = [`本月做饭  ${this.posterData.monthTotal} 次`, `菜谱总数  ${this.posterData.dishCount} 道`];
    let y = 212;
    ctx.fillStyle = dark ? '#ffffff' : '#333333';
    ctx.font = 'normal 30px sans-serif';
    for (let i = 0; i < rows.length; i += 1) {
      ctx.fillText(rows[i], 48, y);
      y += 54;
    }
    if (this.posterData.topDishes.length) {
      const names = this.posterData.topDishes.map((d) => `${d.name}(${d.count}次)`).join('、');
      ctx.font = 'normal 24px sans-serif'; // 先设字体再量宽,否则按上一字体测出的行宽与实际不符
      const lines = wrapText(ctx, `最常做  ${names}`, POSTER_W - 96 - 20);
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.92)' : '#555555';
      for (let i = 0; i < lines.length; i += 1) {
        ctx.fillText(lines[i], 48, y);
        y += 38;
      }
    }
    if (this.posterData.topIngredients.length) {
      const names = this.posterData.topIngredients.map((d) => d.name).join('、');
      ctx.font = 'normal 24px sans-serif';
      const lines = wrapText(ctx, `最爱原料  ${names}`, POSTER_W - 96 - 20);
      ctx.fillStyle = dark ? 'rgba(255,255,255,0.92)' : '#555555';
      for (let i = 0; i < lines.length; i += 1) {
        ctx.fillText(lines[i], 48, y);
        y += 38;
      }
    }

    // 小结卡:浅底卡片 + 折行正文;底边安全线 = 页脚上方留 40,超长才截断(1080 高下一般放得下全文)
    // 文字起点 x=72,右侧留 24 → 量宽/绘制统一用内宽 456(此前 504 超出卡片右边界被裁,表现为「文本不全」)
    y += 24;
    const quoteTop = y;
    const safeBottom = POSTER_H - 48 - 40;
    const availH = safeBottom - quoteTop;
    const maxLines = Math.max(2, Math.floor((availH - 64) / 42));
    ctx.font = 'normal 28px sans-serif'; // 小结绘制字体,先设好再折行测量
    const summaryLines = wrapText(ctx, reportText, POSTER_W - 96 - 48);
    let quoteLines = summaryLines;
    if (quoteLines.length > maxLines) {
      quoteLines = quoteLines.slice(0, maxLines - 1);
      const last = quoteLines.length - 1;
      quoteLines[last] = `${quoteLines[last]}…`;
    }
    const quoteHeight = quoteLines.length * 42 + 64;
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.94)' : '#fff4ec';
    ctx.fillRect(48, quoteTop, POSTER_W - 96, quoteHeight);
    ctx.fillStyle = '#e2692f';
    ctx.fillRect(48, quoteTop, 8, quoteHeight);
    ctx.fillStyle = '#333333';
    for (let i = 0; i < quoteLines.length; i += 1) {
      ctx.fillText(quoteLines[i], 72, quoteTop + 52 + i * 42);
    }

    // 页脚
    ctx.fillStyle = dark ? 'rgba(255,255,255,0.8)' : '#bbbbbb';
    ctx.font = 'normal 24px sans-serif';
    ctx.fillText('来自 · 随机菜单', 48, POSTER_H - 48);
  },

  /** 「生成海报」:本地 Canvas 绘制(自动绘制失败时也可手动重试;幂等) */
  onDrawPoster() {
    if (!this.data.reportText) {
      this.onShowToast('#t-toast', '请先生成月报');
      return;
    }
    this.drawPoster(this.data.reportText);
  },

  /** 「AI 生图海报」:生图 → 下载本地 → 画布叠文字;画布失败降级为预览/保存 AI 原图 */
  async onAiPosterGenerate() {
    if (this.data.aiPosterGenerating) return;
    if (!this.data.reportText || !this.posterData) {
      this.onShowToast('#t-toast', '请先生成月报');
      return;
    }
    this.setData({ aiPosterGenerating: true, aiPosterError: '' });
    try {
      const topNames = this.posterData.topDishes
        .map((d) => d.name)
        .slice(0, 3)
        .join('、');
      const prompt = `${topNames ? `菜品:${topNames}。` : ''}${
        this.posterData.periodText
      } 中式家常菜场景插画,暖色调,竖版`;
      const fileID = await generateDishImage(prompt);
      const localPath = await this.downloadAiPoster(fileID);
      try {
        const outPath = await this.drawAiPosterWithImage(localPath);
        this.posterPath = outPath;
        this.setData({
          aiPosterGenerating: false,
          aiPosterUrl: outPath,
          aiPosterFileId: fileID,
          aiPosterError: '',
        });
        this.setData({ posterReady: true });
      } catch (drawErr) {
        // 画布绘制失败:不叠字,直接进入「预览/保存 AI 原图」
        console.error('AI 生图海报叠字失败,降级为原图预览', drawErr);
        this.posterPath = localPath;
        this.setData({
          aiPosterGenerating: false,
          aiPosterUrl: localPath,
          aiPosterFileId: fileID,
          aiPosterError: '',
        });
        this.setData({ posterReady: true });
      }
    } catch (err) {
      console.error('AI 生图海报失败', err);
      this.setData({ aiPosterGenerating: false, aiPosterError: err.message || 'AI 生图失败' });
      this.onShowToast('#t-toast', 'AI 生图失败,可先用本地海报');
    }
  },

  /** 云存储 fileID 下载到本地临时路径(规避临时域名白名单;canvas 可直接用本地路径) */
  downloadAiPoster(fileID) {
    return new Promise((resolve, reject) => {
      wx.cloud.downloadFile({
        fileID,
        success: (res) => resolve(res.tempFilePath),
        fail: reject,
      });
    });
  },

  /** AI 生图海报:图片按 cover 裁切铺满 600x1080 + 半透明暗色遮罩 + 复用统计/小结文字 */
  async drawAiPosterWithImage(localPath) {
    const canvasNode = await this.getPosterCanvasNode(3);
    const dpr = wx.getSystemInfoSync().pixelRatio || 2;
    const canvas = canvasNode;
    canvas.width = POSTER_W * dpr;
    canvas.height = POSTER_H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    this.posterCanvas = canvas;

    const img = canvas.createImage();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = localPath;
    });
    if (!img.width || !img.height) {
      throw new Error('AI 生图海报图片尺寸无效');
    }

    // cover 裁切:取图片居中最大覆盖窗口铺满 600x1080
    const scale = Math.max(POSTER_W / img.width, POSTER_H / img.height);
    const sw = POSTER_W / scale;
    const sh = POSTER_H / scale;
    const sx = (img.width - sw) / 2;
    const sy = (img.height - sh) / 2;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, POSTER_W, POSTER_H);

    // 双层遮罩保证文字可读:全屏压暗 + 顶部渐变加强(统计区集中在海报上半部)
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.fillRect(0, 0, POSTER_W, POSTER_H);
    const shade = ctx.createLinearGradient(0, 0, 0, 480);
    shade.addColorStop(0, 'rgba(0,0,0,0.38)');
    shade.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, POSTER_W, 480);

    // 暗背景模式:统计/最爱/页脚用白字,小结卡浅底深字
    this.drawPosterBody(ctx, this.data.reportText, true);

    const tempPath = await new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas: canvasNode,
        success: (res) => resolve(res.tempFilePath),
        fail: reject,
      });
    });
    return tempPath;
  },

  /** 取 canvas 2d 节点(仅查 node,尺寸用逻辑尺寸写死,不依赖 boundingClientRect;setData 渲染有 1 帧延迟,失败重试) */
  getPosterCanvasNode(attempts = 3) {
    return new Promise((resolve, reject) => {
      const tryOnce = (left) => {
        wx.createSelectorQuery()
          .select('#posterCanvas')
          .fields({ node: true })
          .exec((res) => {
            const node = res && res[0] && res[0].node;
            if (node) {
              resolve(node);
            } else if (left <= 1) {
              reject(new Error('海报画布初始化失败'));
            } else {
              setTimeout(() => tryOnce(left - 1), 80);
            }
          });
      };
      tryOnce(attempts);
    });
  },

  /** 预览海报大图 */
  onPreview() {
    if (!this.posterPath) {
      this.onShowToast('#t-toast', '海报尚未生成');
      return;
    }
    wx.previewImage({ urls: [this.posterPath] });
  },

  /** 保存到相册(系统权限未开启时引导) */
  onSavePoster() {
    if (!this.posterPath) {
      this.onShowToast('#t-toast', '海报尚未生成');
      return;
    }
    wx.saveImageToPhotosAlbum({
      filePath: this.posterPath,
      success: () => this.onShowToast('#t-toast', '已保存到相册'),
      fail: () => this.onShowToast('#t-toast', '保存失败，请检查相册权限后重试'),
    });
  },
});
