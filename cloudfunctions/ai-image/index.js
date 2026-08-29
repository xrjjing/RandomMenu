/**
 * cloudfunctions/ai-image/index.js
 * F26 AI 生图云函数(混元成长计划,2026-02-24 到期,详见 docs/AI调用文档.md 第 2/4 节)。
 * 模型:默认 HY-Image-3.0-Plus-4090-Tob-v1.0(文生图);
 *   图生图(传 imageFileId / imageUrl)换用 HY-Image-v3.0-I2I-ToB-v1.0.1 + image_urls。
 *
 * 为何用 wx-server-sdk ^4.0.2(与旧函数 ~2.6.3 不同是刻意的):
 *   官方 AI 能力要求 >=4.0.2(HY-Image-3.0 需子依赖 @cloudbase/ai >= 2.30.0)。
 *
 * 为何转存:generateImage 返回的 url 24 小时后失效,
 *   且该 url 是普通 https 地址(cloud.downloadFile 只认 cloud://,会失败),
 *   所以用 Node https 模块下载 buffer 后 cloud.uploadFile 转存云存储,再返回永久 fileID。
 *
 * ⚠️ 部署提醒:生图 10-30s,云函数超时请在控制台配置为 120s;用「云端安装依赖」部署。
 */
const https = require('https');
const http = require('http');
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  // 生图含 prompt 改写约 10-40s,init 层超时给足(控制台还需同步配置 120s)
  timeout: 120000,
});

// 官方文档形态:模型族名走 createImageModel 位置参数,具体模型 ID 放 generateImage 参数
const imageModel = cloud.ai().createImageModel('hunyuan-image');

/** 生成随机串(云存储路径防撞) */
function randomToken() {
  return Math.random().toString(36).slice(2, 10);
}

/** 当前月份键 YYYY-MM(与小程序端 usage.js 的 monthKey 同构,云函数环境不复用小端模块) */
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 生图重试配置:最多重试 2 次(总 3 次尝试),退避 2s/4s */
const GEN_MAX_ATTEMPTS = 3;
const GEN_RETRY_DELAYS_MS = [2000, 4000];

/** 等待 ms(生图重试退避用) */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 判断生图失败是否强信号可重试:只认 429 状态码与限流/配额类文案,识别不出不重试(生图代价高) */
function isRetryableImageError(err) {
  if (!err) return false;
  if (err.statusCode === 429 || err.status === 429) return true;
  const msg = String(err.message || err.errMsg || '');
  return /429|限流|rate.?limit|quota|throttle|too many|RESOURCE_EXHAUSTED|ServiceUnavailable/i.test(msg);
}

/** 提取错误对象常见字段做结构化日志(便于排查真实错误形状,不含用户输入) */
function pickErrorFields(err) {
  const out = {};
  if (!err) return out;
  ['code', 'errCode', 'errMsg', 'message', 'statusCode', 'status', 'requestId'].forEach((key) => {
    if (err[key] !== undefined) out[key] = err[key];
  });
  return out;
}

/**
 * 生图用量计数(转存成功后 upsert 计数,失败不阻断主流程)。
 * 写入 app_meta 集合 _id='ai_usage' 单文档,inc 原子累加;文档不存在则降级 add 初值。
 */
async function reportImageUsage() {
  try {
    const db = cloud.database();
    const _ = db.command;
    const ym = monthKey();
    const inc = {
      totalImageCalls: _.inc(1),
      [`byMonth.${ym}.imageCalls`]: _.inc(1),
    };
    const res = await db.collection('app_meta').doc('ai_usage').update({ data: inc });
    // 文档不存在时 update 静默返回 stats.updated:0(不 reject),须显式判 0 补 add
    if (!res || !res.stats || res.stats.updated === 0) {
      await db
        .collection('app_meta')
        .add({ data: { _id: 'ai_usage', totalImageCalls: 1, byMonth: { [ym]: { imageCalls: 1 } } } })
        .catch(() => {}); // 并发首写重复 _id 时忽略
    }
  } catch (err) {
    console.error('[ai-image] 用量计数失败:', err.errMsg || err.message || err);
  }
}

/**
 * 下载 https/http 图片为 Buffer(生图 url 是普通 https 地址,cloud.downloadFile 不适用)。
 * @param {string} url 图片地址
 * @returns {Promise<Buffer>}
 */
function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('http://') ? http : https;
    client
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`下载生图结果失败:HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

exports.main = async (event) => {
  // 1. 入参校验
  const prompt = typeof event.prompt === 'string' ? event.prompt.trim() : '';
  if (!prompt) return { ok: false, error: '提示词不能为空' };
  if (prompt.length > 500) return { ok: false, error: '提示词最多 500 字' };

  // 2. 解析参考图(F30 #8 图生图):fileID(cloud://)先转临时 https,或直接用 imageUrl(https)
  let refUrl = '';
  const fileID = typeof event.imageFileId === 'string' ? event.imageFileId.trim() : '';
  const directUrl = typeof event.imageUrl === 'string' ? event.imageUrl.trim() : '';
  if (fileID || directUrl) {
    try {
      if (fileID) {
        const tmp = await cloud.getTempFileURL({ fileList: [fileID] });
        const file = tmp && tmp.fileList && tmp.fileList[0];
        if (file && file.tempFileURL) refUrl = file.tempFileURL;
        else return { ok: false, error: '参考图片读取失败,请稍后重试' };
      } else {
        refUrl = directUrl;
      }
    } catch (err) {
      console.error('[ai-image] 参考图取链失败:', err.errMsg || err.message || err);
      return { ok: false, error: '参考图片读取失败,请稍后重试' };
    }
  }
  const isI2i = !!refUrl;

  // 3. 调生图模型:文生图 / 图生图(参考图走专用 I2I 模型 + image_urls;I2I 不带 revise 改写参数)
  //    仅限流/配额等强信号重试(总 3 次尝试,退避 2s/4s);识别不出不重试,生图代价高
  let genRes;
  const generateOnce = async (n) => {
    // 注:I2I 官方口径只需 image_urls(≤1 张);revise 对 I2I 是否可用未实测确认,故先不带,
    // 上线后如画风异常可传 event.debug=true 回传根因排查(T2I 路径保留 revise 稳定不变)。
    const genParams = isI2i
      ? { model: 'HY-Image-v3.0-I2I-ToB-v1.0.1', prompt, image_urls: [refUrl], size: '1024x1024' }
      : { model: 'HY-Image-3.0-Plus-4090-Tob-v1.0', prompt, size: '1024x1024', revise: { value: true } };
    try {
      return await imageModel.generateImage(genParams);
    } catch (err) {
      // 结构化错误日志:供日后实采真实错误形状(如 429),用户可见文案不变
      console.error('[ai-image] generateImage 失败:', JSON.stringify(pickErrorFields(err)));
      if (isRetryableImageError(err) && n < GEN_MAX_ATTEMPTS) {
        await sleep(GEN_RETRY_DELAYS_MS[n - 1] || 0);
        return generateOnce(n + 1);
      }
      throw err;
    }
  };
  try {
    genRes = await generateOnce(1);
  } catch (err) {
    // debug 模式回传根因(前端不传 debug 时保持笼统文案,不泄漏内部信息)
    if (event.debug) {
      return {
        ok: false,
        error: '生图模型调用失败,请稍后重试',
        debug: err.requestId || '',
        detail: String(err.message || err),
      };
    }
    return { ok: false, error: '生图模型调用失败,请稍后重试' };
  }

  // 返回结构按官方口径 res.data[0].url,容错单 url 形态
  const item = (genRes && genRes.data && genRes.data[0]) || genRes || {};
  const url = item.url;
  if (!url) {
    console.error('[ai-image] 生图结果缺少 url:', JSON.stringify(genRes));
    return { ok: false, error: '生图结果异常,请稍后重试' };
  }

  // 3. 下载临时 url(24h 失效)并转存云存储
  let buffer;
  try {
    buffer = await downloadBuffer(url);
  } catch (err) {
    console.error('[ai-image] 下载生图 url 失败:', url, err.message || err);
    return { ok: false, error: '生图结果下载失败,请稍后重试' };
  }

  try {
    const upRes = await cloud.uploadFile({
      cloudPath: `ai-images/${Date.now()}-${randomToken()}.png`,
      fileContent: buffer,
    });
    await reportImageUsage(); // 计数失败不阻断返回
    return { ok: true, fileID: upRes.fileID };
  } catch (err) {
    console.error('[ai-image] uploadFile 转存失败:', err.message || err);
    return { ok: false, error: '图片转存云存储失败,请稍后重试' };
  }
};
