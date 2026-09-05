/**
 * api/identity.js
 * 身份模块:微信 openid 获取 + members 注册/查询。
 * openid 永久缓存到 Storage(免云函数调用);member 文档每次实查——
 * 角色/家庭可能被 admin 随时改动,缓存会导致权限滞后,故不缓存。
 * 注意:wx 引用一律放在函数内部,保证 node 环境 import 本文件不抛错。
 */

/** openid 的 Storage 键(永久缓存,不设 TTL) */
const OPENID_KEY = 'rmdc_openid';

/** openid 单例缓存:并发调用复用同一 Promise,避免重复打 login 云函数 */
let openidPromise = null;

/** member 实查的在途去重:仅合并同一时刻的并发调用,完成后立即清空(下次重新实查) */
let memberInflight = null;

/**
 * 内部:通过云函数 login 获取 openid(服务端身份,不可客户端伪造)。
 * @returns {Promise<string>}
 */
function fetchOpenid() {
  return wx.cloud.callFunction({ name: 'login' }).then((res) => res.result.openid);
}

/**
 * 内部:获取 openid(单例去重 + Storage 永久缓存,不设 TTL)。
 * 失败时清掉单例,下次调用重新发起(不吞错,rethrow 给调用方提示)。
 * @returns {Promise<string>}
 */
function getOpenid() {
  if (openidPromise) return openidPromise;
  openidPromise = (async () => {
    // openid 缓存命中:跳过云函数调用(Storage 里存的是永久缓存,无过期概念)
    const cached = wx.getStorageSync(OPENID_KEY);
    if (cached) return cached;
    const openid = await fetchOpenid();
    wx.setStorageSync(OPENID_KEY, openid);
    return openid;
  })();
  openidPromise.catch(() => {
    openidPromise = null;
  });
  return openidPromise;
}

/**
 * 幂等获取身份:{ openid, member }。member 为 null 表示未注册。
 * openid 走单例 + Storage 永久缓存;member 每次实查 members(_openid = openid),不做永久缓存——
 * isAdmin / familyId 可能被 admin 随时改动,缓存会导致权限滞后(家庭归属改了不生效)。
 * 并发去重:同一时刻多次调用复用同一在途 Promise,完成后立即清除引用,下次调用重新实查。
 * @returns {Promise<{openid: string, member: object|null}>}
 */
export function ensureIdentity() {
  if (memberInflight) return memberInflight;
  memberInflight = (async () => {
    const openid = await getOpenid();
    // member 每次实查:isAdmin / familyId 可能被 admin 改动,不可缓存
    const db = wx.cloud.database();
    const res = await db.collection('members').where({ _openid: openid }).limit(1).get();
    const member = res.data.length ? res.data[0] : null;
    return { openid, member };
  })();
  // 完成后立即清除在途引用(成功/失败都清):并发窗口外的下次调用重新实查;
  // 不吞错,rejection 原样传给调用方,由调用方决定提示或静默
  const clearInflight = () => {
    memberInflight = null;
  };
  memberInflight.then(clearInflight, clearInflight);
  return memberInflight;
}

/**
 * 注册成员:members.add,_openid 由云开发在 add 时自动写入(不手动写)。
 * ensureIdentity 每次实查 member,注册成功后直接重查一次即可拿到新文档。
 * @param {string} nickname 昵称
 * @returns {Promise<object>} 新成员文档(极端并发下可能为 { openid, member: null })
 */
export async function registerMember(nickname) {
  const name = String(nickname || '').trim();
  if (!name) throw new Error('昵称不能为空');
  const db = wx.cloud.database();
  await db.collection('members').add({
    data: { nickname: name, familyId: '', isAdmin: false, createdAt: db.serverDate() },
  });
  // 清掉成员实查的去重引用:避免复用到注册前发起的在途查询(返回旧 member:null)
  memberInflight = null;
  // ensureIdentity 每次实查 member,注册后重查即可拿到新文档
  const { openid, member } = await ensureIdentity();
  return member === null ? { openid, member } : member;
}

/**
 * 是否家庭管理员。
 * @param {object|null} member 成员文档
 * @returns {boolean}
 */
export function isFamilyAdmin(member) {
  return Boolean(member && member.isAdmin === true);
}
