/**
 * utils/imgUrl.js
 * 云存储图片换链工具:cloud:// fileID → 带签名公开 https 临时链接。
 *
 * 背景:免费云环境的安全规则按「创建者」过滤存储读权限,客户端直接用
 * cloud:// 作 image src 只有上传者本人可见;云函数(服务端身份)不受
 * 规则约束,getimgurls 云函数批量换取的临时链接任何用户可显示。
 *
 * 设计:双层缓存(内存 Map + wx.Storage 持久化),临时链接官方 2 小时
 * 有效,缓存提前 20 分钟过期防边界;批量换链一次 callFunction,严禁逐条调用。
 */

/** 临时链接缓存时长(毫秒):官方 2 小时,提前 20 分钟过期 */
const URL_TTL_MS = 100 * 60 * 1000;
/** wx.Storage 持久缓存键 */
const STORAGE_KEY = 'img_url_cache';
/** 云函数单次入参上限(getimgurls 内部 slice(0,50),这里对齐分批) */
const BATCH_SIZE = 50;

/** 内存层缓存:fileId → { url, exp } */
const memCache = new Map();

/** 判断是否为 cloud:// 协议的云存储 fileID(仅前缀判定,区别于 image.js 的 isCloudFileId) */
export function isCloudProtocol(path) {
  return typeof path === 'string' && path.indexOf('cloud://') === 0;
}

/** 读取持久层缓存(wx.Storage 异常静默降级,返回 {} 或上次快照) */
function loadPersisted() {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    if (raw && typeof raw === 'object') return raw;
  } catch (e) {
    // Storage 读写异常不阻断换链,仅退化到内存层
  }
  return {};
}

/** 写回持久层(异常静默,失败只影响下次冷启动命中率) */
function savePersisted() {
  try {
    wx.setStorageSync(STORAGE_KEY, Object.fromEntries(memCache));
  } catch (e) {
    // 同上,静默降级
  }
}

/** 提前过期边距(毫秒):到期前 20 分钟即视为失效,防边界抖动 */
const EXPIRE_MARGIN_MS = 20 * 60 * 1000;

/**
 * 从腾讯 COS 临时链接提取签名过期时刻:t 参数为 Unix 秒(过期时刻,权威值)。
 * 解析失败返回 0(调用方回退本地 exp 字段)。
 */
function extractExpireMs(url) {
  const m = typeof url === 'string' ? url.match(/[?&]t=(\d{10})(?:&|$)/) : null;
  return m ? Number(m[1]) * 1000 : 0;
}

/** 取缓存:以签名 t(权威)与本地 exp 双重判定,任一过期即重取 */
function getCached(fileId, persisted) {
  const hit = memCache.get(fileId) || persisted[fileId];
  if (!hit) return null;
  const now = Date.now();
  // 签名 t 是腾讯侧真实过期时刻,比本地时间戳可信(本地 exp 会因热重载/多端同步错乱)
  const signedExp = extractExpireMs(hit.url);
  const expired = signedExp ? signedExp - EXPIRE_MARGIN_MS <= now : hit.exp <= now;
  if (expired) {
    memCache.delete(fileId);
    return null;
  }
  // 命中持久层时回填内存层,加速后续查询
  memCache.set(fileId, hit);
  return hit.url;
}

/**
 * 批量换链:cloud:// 元素换为 https 临时链接,其余元素原样保留,顺序不变。
 * 云函数失败/返回缺项的位置回 ''(调用方已有空值兜底走 emoji),永不 reject。
 * @param {Array} paths 图片路径数组(可混合 cloud:// 与普通路径)
 * @returns {Promise<Array>} 与入参同序的数组
 */
export async function resolveImgUrls(paths) {
  const list = Array.isArray(paths) ? paths : [];
  if (list.length === 0) return [];

  const persisted = loadPersisted();
  // 与入参同长度的结果数组:非 cloud:// 与空值元素原样保留原位,严禁过滤(过滤会导致调用方按下标错位)
  const result = new Array(list.length);
  const pending = []; // 待换链的 { fileId, index }

  list.forEach((p, i) => {
    if (isCloudProtocol(p)) {
      const cached = getCached(p, persisted);
      if (cached) {
        result[i] = cached;
      } else {
        pending.push({ fileId: p, index: i });
      }
    } else {
      result[i] = p || ''; // 非 cloud://(含空串)原样返回,统一空值为 ''
    }
  });
  if (pending.length === 0) return result;

  // 分批调云函数(每批 ≤50),失败位置回 ''
  const batches = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) batches.push(pending.slice(i, i + BATCH_SIZE));

  const now = Date.now();
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await wx.cloud.callFunction({
          name: 'getimgurls',
          data: { fileIds: batch.map((it) => it.fileId) },
        });
        const map = (res && res.result && res.result.map) || {};
        batch.forEach((it) => {
          const url = map[it.fileId];
          if (url) {
            const entry = { url, exp: now + URL_TTL_MS };
            memCache.set(it.fileId, entry);
            result[it.index] = url;
          } else {
            result[it.index] = '';
          }
        });
      } catch (err) {
        console.error('云函数换链失败', err);
        batch.forEach((it) => {
          result[it.index] = '';
        });
      }
    }),
  );

  savePersisted();
  return result;
}

/** 清空两层换链缓存(图片删除/替换后可调用,避免残留死链) */
export function clearImgUrlCache() {
  memCache.clear();
  try {
    wx.removeStorageSync(STORAGE_KEY);
  } catch (e) {
    // 静默降级
  }
}
