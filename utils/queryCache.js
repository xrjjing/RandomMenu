/**
 * utils/queryCache.js
 * 内存级 TTL 查询缓存(家庭量级:小程序进程存活期内有效)。
 * 使用场景:
 * - 列表类查询(原料/匹配/今日记录)TTL 30s、详情类(getDish)TTL 60s,
 *   避免同一查询在短时间内重复打库;
 * - 写库操作(saveDish/removeDish/落账等)完成后调用 markDirty() 全量失效,保证数据一致性;
 * - key 由调用方用 JSON.stringify(查询参数盐) 生成,不同参数互不串扰。
 * 注意:缓存值若为数组,get 时返回浅拷贝,防止调用方误改污染缓存。
 */
export class QueryCache {
  /**
   * @param {object} [opts]
   * @param {Function} [opts.now] 时钟函数(测试注入用),默认 Date.now
   */
  constructor({ now = Date.now } = {}) {
    this.store = new Map();
    this.now = now;
  }

  /** 查询参数盐 → 缓存键(JSON 序列化,保证参数组合唯一) */
  keyOf(salt) {
    return JSON.stringify(salt);
  }

  /** 命中且未过期返回缓存值(数组浅拷贝);未命中/过期返回 undefined 并清理过期项 */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now() > entry.expireAt) {
      this.store.delete(key);
      return undefined;
    }
    return Array.isArray(entry.value) ? entry.value.slice() : entry.value;
  }

  /**
   * 写入缓存。
   * @param {string} key 缓存键(由 keyOf 生成)
   * @param {*} value 缓存值
   * @param {number} [ttlMs=300000] 过期毫秒数,默认 5 分钟
   * @returns {*} 原样返回 value,便于链式 return
   */
  set(key, value, ttlMs = 5 * 60 * 1000) {
    this.store.set(key, { value, expireAt: this.now() + ttlMs });
    return value;
  }

  /** 按键前缀失效(如只让某道菜详情失效);当前调用方多走 markDirty 全清 */
  invalidate(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /** 写库后全量清空:家庭量级缓存条目有限,全清最简单可靠 */
  markDirty() {
    this.store.clear();
  }
}

/** 全局单例:小程序进程内所有页面共享同一份缓存 */
export const queryCache = new QueryCache();
