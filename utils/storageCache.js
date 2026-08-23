/**
 * utils/storageCache.js
 * 本地持久缓存(wx.Storage)封装:三层缓存中的 L2(内存 TTL → Storage → 云数据库)。
 * 键规范:'rmdc_' 前缀 + 集合名(如 rmdc_dishes),避免与用户手动写入/未来扩展的键冲突。
 * 值格式:{ items, syncTs }——wx.Storage 无原生 TTL,这里只存 raw items,
 * 过期判断由 L1 内存层(queryCache TTL)负责。
 * 读写全部 try/catch:JSON 损坏 / 超限(10MB)等异常静默降级,软性失败不打断用户流程。
 * 注意:wx 引用一律放在函数内部,node 环境下可注入 global.wx 替身做单元测试。
 */
const PREFIX = 'rmdc_';

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
 * @returns {Array|undefined} items 数组(浅拷贝);无缓存 / 损坏 / 异常返回 undefined
 */
export function get(key) {
  try {
    const raw = wx.getStorageSync(cacheKey(key));
    if (!raw) return undefined;
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || !Array.isArray(parsed.items)) return undefined;
    return parsed.items.slice(); // 浅拷贝,防止调用方排序/修改污染持久缓存
  } catch (err) {
    // JSON 损坏 / storage 异常:静默降级为未命中,不抛出
    console.error('[storageCache] get 失败(静默降级)', err);
    return undefined;
  }
}

/**
 * 写入本地缓存。
 * @param {string} key 集合名(自动补 rmdc_ 前缀)或完整键
 * @param {Array} items 原始数据数组(不设 TTL,过期由 L1 内存层负责)
 * @param {number} [ttlMs] 保留参数:wx.Storage 无 TTL,这里仅记录 syncTs 供排查
 */
export function set(key, items, ttlMs) {
  try {
    wx.setStorageSync(cacheKey(key), { items, syncTs: Date.now() });
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
