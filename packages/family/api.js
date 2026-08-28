/**
 * packages/family/api.js
 * 家庭(families)与花名册(members)管理,admin 管理端使用。
 * 位于分包内(仅管理页使用,不放主包避免「主包未使用文件」告警);
 * 全部直查不走集合缓存:家庭/成员量级小、一致性敏感(改完立读必须生效)。
 * records 的 familyId 写操作无需失效缓存——records 本就不走集合缓存,直查天然最新。
 * 注意:wx 引用一律放在函数内部,保证 node 环境 import 本文件不抛错。
 */

/**
 * 家庭列表:全量,按 name 中文拼音序。
 * @returns {Promise<Array>}
 */
export async function listFamilies() {
  const db = wx.cloud.database();
  const res = await db.collection('families').get();
  // 家庭量级小,一次 get 即可(分页上限 20,超出场景目前不存在;保持简单)
  return (res.data || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
}

/**
 * 新建家庭:trim 非空 + 重名校验后插入。
 * @param {string} name 家庭名
 * @returns {Promise<object>} 新增文档(含 _id)
 */
export async function createFamily(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('家庭名不能为空');
  const db = wx.cloud.database();
  const dup = await db.collection('families').where({ name: trimmed }).limit(1).get();
  if (dup.data.length > 0) throw new Error('家庭名已存在');
  const added = await db.collection('families').add({
    data: { name: trimmed, createdAt: db.serverDate() },
  });
  return { _id: added._id, name: trimmed };
}

/**
 * 重命名家庭:trim 非空 + 重名校验(排除自身)后更新。
 * @param {string} id 家庭 _id
 * @param {string} name 新家庭名
 * @returns {Promise<void>}
 */
export async function renameFamily(id, name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('家庭名不能为空');
  const db = wx.cloud.database();
  const dup = await db.collection('families').where({ name: trimmed }).limit(1).get();
  const target = dup.data[0];
  if (target && target._id !== id) throw new Error('家庭名已存在');
  await db.collection('families').doc(id).update({ data: { name: trimmed } });
}

/**
 * 成员列表:全量,按 createdAt 升序(注册顺序)。
 * @returns {Promise<Array>}
 */
export async function listMembers() {
  const db = wx.cloud.database();
  const res = await db.collection('members').get();
  return (res.data || []).slice().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

/**
 * 设置成员所属家庭(familyId 传 '' 表示移回未分配池)。
 * @param {string} memberDocId members 文档 _id
 * @param {string} familyId 家庭 _id,或 '' 表示未分配
 * @returns {Promise<void>}
 */
export async function setMemberFamily(memberDocId, familyId) {
  const db = wx.cloud.database();
  await db.collection('members').doc(memberDocId).update({ data: { familyId: familyId || '' } });
}

/**
 * 未分配池计数:records 中 familyId 为 ''(含已归池的存量旧记录)的条数。
 * @returns {Promise<number>}
 */
export async function countUnassignedPool() {
  const db = wx.cloud.database();
  const res = await db.collection('records').where({ familyId: '' }).count();
  return res.total;
}

/**
 * 内部:分页拉全符合条件的 records(小程序端单次 get 上限 20 条,
 * 直接 .get() 会静默漏掉第 21 条起的记录——归池/划归都会只迁一页)。
 * 写法对齐 db.js fetchAll:orderBy _id 保证 skip 窗口稳定,有限循环拉完。
 * @param {object} where 查询条件
 * @returns {Promise<Array>} 全量记录文档
 */
async function fetchPoolRecords(where) {
  const db = wx.cloud.database();
  const PAGE = 20;
  let list = [];
  let skip = 0;
  for (let page = 0; page < 1000; page += 1) {
    const res = await db
      .collection('records')
      .where(where)
      .orderBy('_id', 'asc')
      .skip(skip)
      .limit(PAGE)
      .get();
    list = list.concat(res.data);
    if (res.data.length < PAGE) break;
    skip += PAGE;
  }
  return list;
}

/**
 * 一次性归池:把 familyId 字段不存在的存量旧记录全部补成 ''(未分配池)。
 * 幂等:再次调用时已无缺字段记录,返回 0。
 * @returns {Promise<number>} 本次迁移条数
 */
export async function migrateLegacyRecords() {
  const db = wx.cloud.database();
  const _ = db.command;
  const targets = await fetchPoolRecords({ familyId: _.exists(false) });
  for (const record of targets) {
    await db.collection('records').doc(record._id).update({ data: { familyId: '' } });
  }
  return targets.length;
}

/**
 * 未分配池分页明细:按日期倒序,供管理页逐条查看与单条划归。
 * 单页 get(10 条)不触达小程序端 20 条上限,无需分页循环。
 * @param {number} skip 已加载条数(首页传 0)
 * @param {number} limit 页大小
 * @returns {Promise<Array>} 记录文档({_id, dishName, date, ...})
 */
export async function fetchPoolPage(skip = 0, limit = 10) {
  const db = wx.cloud.database();
  const res = await db
    .collection('records')
    .where({ familyId: '' })
    .orderBy('date', 'desc')
    .orderBy('createdAt', 'desc')
    .skip(skip)
    .limit(limit)
    .get();
  return res.data || [];
}

/**
 * 单条划归:把池里指定一条记录划入目标家庭(按明细逐条分配历史数据用)。
 * @param {string} recordId records 文档 _id
 * @param {string} familyId 目标家庭 _id(必须非空)
 * @returns {Promise<void>}
 */
export async function assignRecordToFamily(recordId, familyId) {
  if (!familyId) throw new Error('familyId 不能为空');
  const db = wx.cloud.database();
  await db.collection('records').doc(recordId).update({ data: { familyId } });
}

/**
 * 把未分配池(familyId === '')的全部 records 划归指定家庭。
 * @param {string} familyId 目标家庭 _id(必须非空)
 * @returns {Promise<number>} 迁移条数
 */
export async function assignPoolToFamily(familyId) {
  if (!familyId) throw new Error('familyId 不能为空');
  const db = wx.cloud.database();
  const targets = await fetchPoolRecords({ familyId: '' });
  for (const record of targets) {
    await db.collection('records').doc(record._id).update({ data: { familyId } });
  }
  return targets.length;
}
