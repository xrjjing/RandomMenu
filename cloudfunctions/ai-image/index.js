/**
 * cloudfunctions/ai-image/index.js
 * F26 AI 生图云函数(混元成长计划,2026-02-24 到期,详见 docs/AI调用文档.md 第 2/4 节)。
 * 模型:HY-Image-3.0-Plus-4090-Tob-v1.0(cloudbase provider,免 API key,靠环境身份)。
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
  const width = Number(event.width) || 768;
  const height = Number(event.height) || 768;

  // 2. 调生图模型
  let genRes;
  try {
    genRes = await imageModel.generateImage({
      model: 'HY-Image-3.0-Plus-4090-Tob-v1.0',
      prompt,
      size: '1024x1024',
      revise: { value: true },
    });
  } catch (err) {
    console.error('[ai-image] generateImage 失败:', err.requestId || '', err.message || err);
    // debug 模式回传根因(前端不传 debug 时保持笼统文案,不泄漏内部信息)
    if (event.debug) {
      return { ok: false, error: '生图模型调用失败,请稍后重试', debug: err.requestId || '', detail: String(err.message || err) };
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
    return { ok: true, fileID: upRes.fileID };
  } catch (err) {
    console.error('[ai-image] uploadFile 转存失败:', err.message || err);
    return { ok: false, error: '图片转存云存储失败,请稍后重试' };
  }
};
