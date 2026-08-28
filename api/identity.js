/**
 * api/identity.js
 * 身份模块:微信 openid 获取 + members 注册/查询。
 * openid 永久缓存到 Storage(免云函数调用);member 文档每次实查——
 * 角色/家庭可能被 admin 随时改动,缓存会导致权限滞后,故不缓存。
 * 注意:wx 引用一律放在函数内部,保证 node 环境 import 本文件不抛错。
 */

/** openid 的 Storage 键(永久缓存,不设 TTL) */
const OPENID_KEY = 'rmdc_openid';

/** ensureIdentity 单例缓存:并发调用复用同一 Promise,避免重复打云函数/查库 */
let identityPromise = null;

/**
 * 内部:通过云函数 login 获取 openid(服务端身份,不可客户端伪造)。
 * @returns {Promise<string>}
 */
function fetchOpenid() {
  return wx.cloud
    .callFunction({ name: 'login' })
    .then((res) => res.result.openid);
}

/**
 * 幂等获取身份:{ openid, member }。member 为 null 表示未注册。
 * openid 优先读 Storage 缓存(成功获取过就不再调云函数);member 每次实查 members。
 * @returns {Promise<{openid: string, member: object|null}>}
 */
export function ensureIdentity() {
  if (identityPromise) return identityPromise;
  identityPromise = (async () => {
    // openid 缓存命中:跳过云函数调用(Storage 里存的是永久缓存,无过期概念)
    let openid = wx.getStorageSync(OPENID_KEY);
    if (!openid) {
      openid = await fetchOpenid();
      wx.setStorageSync(OPENID_KEY, openid);
    }
    // member 每次实查:isAdmin / familyId 可能被 admin 改动,不可缓存
    const db = wx.cloud.database();
    const res = await db.collection('members').where({ _openid: openid }).limit(1).get();
    const member = res.data.length ? res.data[0] : null;
    return { openid, member };
  })();
  // 失败时清掉单例缓存,让下次调用重新发起(不吞错,rethrow 给调用方提示)
  identityPromise.catch(() => {
    identityPromise = null;
  });
  return identityPromise;
}

/**
 * 注册成员:members.add,_openid 由云开发在 add 时自动写入(不手动写)。
 * 成功后清 ensureIdentity 单例缓存(下次 ensureIdentity 拿到新 member),并重查一次返回完整文档。
 * @param {string} nickname 昵称
 * @returns {Promise<object>} 新成员文档
 */
export async function registerMember(nickname) {
  const name = String(nickname || '').trim();
  if (!name) throw new Error('昵称不能为空');
  const db = wx.cloud.database();
  await db.collection('members').add({
    data: { nickname: name, familyId: '', isAdmin: false, createdAt: db.serverDate() },
  });
  // 身份状态已变化,强制下次 ensureIdentity 重新走一遍(重新拉 openid + 实查 member)
  identityPromise = null;
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
