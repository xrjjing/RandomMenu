// 云函数:家庭管理写操作(服务端身份执行,绕开小程序端安全规则对"非创建者记录"的拦截)
// 背景:members 记录的 _openid 是各成员自己的,管理员调整他人归属时,
// 小程序端 doc().update() 会被「仅创建者可写」/「仅管理员 openid 可写」规则静默拒绝
// (返回 updated:0 不抛错)。归属调整必须走本云函数:服务端先校验调用者 isAdmin 再代写。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

/** 统一响应 */
const ok = (data) => ({ ok: true, ...data });
const fail = (error) => ({ ok: false, error });

/** 校验调用者是管理员,返回 { member } 或抛错 */
async function requireAdmin(OPENID) {
  const res = await db.collection('members').where({ _openid: OPENID }).limit(1).get();
  const member = res.data[0];
  if (!member || member.isAdmin !== true) {
    throw new Error('仅管理员可执行此操作');
  }
  return member;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  try {
    // 归属调整:把某成员划到某家庭('' = 未分配池)。家庭存在性一并校验,防脏数据。
    if (action === 'updateMemberFamily') {
      await requireAdmin(OPENID);
      const memberDocId = String(event.memberDocId || '');
      const familyId = event.familyId ? String(event.familyId) : '';
      if (!memberDocId) return fail('缺少成员 id');
      if (familyId) {
        const fam = await db.collection('families').doc(familyId).get().catch(() => null);
        if (!fam || !fam.data) return fail('目标家庭不存在');
      }
      const res = await db.collection('members').doc(memberDocId).update({
        data: { familyId },
      });
      if (!res.stats || res.stats.updated === 0) return fail('成员不存在或未变动');
      return ok({ updated: res.stats.updated });
    }

    return fail(`未知 action: ${action}`);
  } catch (err) {
    return fail(err.message || '操作失败');
  }
};
