/**
 * utils/storageCache.js
 * 本地持久缓存(wx.Storage)封装:双层缓存中的 L2(内存 TTL → Storage)。
 * 键规范:'rmdc_' 前缀 + 集合名(如 rmdc_dishes),避免与用户手动写入/未来扩展的键冲突。
 * 值格式:{ ts, data }——ts 为写入时间戳,wx.Storage 无原生 TTL,
 * get(name, ttlMs) 检查 Date.now() - ts < ttlMs 才返回,过期返回 null,由上层走云库。
 * 读写全部 try/catch:JSON 损坏 / 超限(10MB)等异常静默降级,软性失败不打断用户流程。
 * 注意:wx 引用一律放在函数内部,node 环境下可注入 global.wx 替身做单元测试。
 */
const PREFIX = 'rmdc_';

/** 集合缓存默认 TTL(毫秒):L2 Storage 兜底时长,超过即视为过期,下次读走 L3 云库 */
export const STORAGE_TTL_MS = 5 * 60 * 1000;

/**
 * 规范化缓存键:统一补 rmdc_ 前缀(重复调用幂等)。
 * @param {string} name 集合名或完整键
 * @returns {string} 带前缀的 storage 键
 */
export function cacheKey(name) {
  return name.startsWith(PREFIX) ? name : `${PREFIX}${name}`;
}

/**
 * 读取本地缓存。
 * @param {string} key 集合名(自动补 rmdc_ 前缀)或完整键
 * @param {number} [ttlMs=5min] TTL 毫秒;写入超过 ttlMs 视为过期
 * @returns {Array|null} data 数组(浅拷贝);无缓存 / 过期 / 损坏 / 异常返回 null
 */
export function get(key, ttlMs = STORAGE_TTL_MS) {
  try {
    const raw = wx.getStorageSync(cacheKey(key));
    if (!raw) return null;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || !Array.isArray(parsed.data)) return null;
    // TTL 过期判断:写入超过 ttlMs 即失效(历史格式 {items, syncTs} 无 data 字段 → null 自愈)
    if (Date.now() - parsed.ts > ttlMs) return null;
    return parsed.data.slice(); // 浅拷贝,防止调用方排序/修改污染持久缓存
  } catch (err) {
    // JSON 损坏 / storage 异常:静默降级为未命中,不抛出
    console.error('[storageCache] get 失败(静默降级)', err);
    return null;
  }
}

/**
 * 写入本地缓存。
 * @param {string} key 集合名(自动补 rmdc_ 前缀)或完整键
 * @param {Array} list 原始数据数组(存 {ts, data},TTL 由 get 判断)
 */
export function set(key, list) {
  try {
    wx.setStorageSync(cacheKey(key), { ts: Date.now(), data: list });
  } catch (err) {
    // 超限(10MB)等:仅降级,不阻断业务(下次读会走 L3 拉取并重试回填)
    console.error('[storageCache] set 失败(静默降级)', err);
  }
}

/**
 * 删除指定键(写库后清理,保证下次读走 L3 拉最新)。
 * @param {string} key 集合名(自动补 rmdc_ 前缀)或完整键
 */
export function remove(key) {
  try {
    wx.removeStorageSync(cacheKey(key));
  } catch (err) {
    console.error('[storageCache] remove 失败(静默降级)', err);
  }
}

/**
 * 按前缀批量删除缓存键(存储泄漏防护:如历史日期的 records 键)。
 * 与 clearAll 相同的 getStorageInfoSync 遍历写法;exceptKey 为需保留的完整键(带 rmdc_ 前缀)。
 * @param {string} prefix 完整键前缀(带 rmdc_ 前缀,如 'rmdc_records:')
 * @param {string} exceptKey 需保留的完整 storage 键(带 rmdc_ 前缀)
 */
export function removeByPrefix(prefix, exceptKey) {
  try {
    const info = wx.getStorageInfoSync();
    const keys = (info && info.keys) || [];
    keys.forEach((k) => {
      if (k.startsWith(prefix) && k !== exceptKey) wx.removeStorageSync(k);
    });
  } catch (err) {
    console.error('[storageCache] removeByPrefix 失败(静默降级)', err);
  }
}

/**
 * 清空所有 rmdc_ 前缀缓存(内嵌前缀匹配,不动用户其他键)。
 */
export function clearAll() {
  try {
    const info = wx.getStorageInfoSync();
    const keys = (info && info.keys) || [];
    keys.forEach((k) => {
      if (k.startsWith(PREFIX)) wx.removeStorageSync(k);
    });
  } catch (err) {
    console.error('[storageCache] clearAll 失败(静默降级)', err);
  }
}
