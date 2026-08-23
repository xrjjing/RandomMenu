/**
 * api/db.js
 * 云数据库统一封装(零云函数,小程序端直连)
 * 所有页面只 import 本模块操作 dishes / ingredients,不散落 wx.cloud 调用。
 * 三层缓存:内存(queryCache TTL)→ wx.Storage(storageCache 持久)→ 云数据库(源头)。
 * 读流程统一走 loadCollection 三段读取;写流程统一 markDirty 双清 + 重拉回填 L2,
 * 保证"改了就能看到",且命中缓存时不再重打库。
 * 注意:wx 引用一律放在函数内部,保证在 node 环境下 import 本文件不抛错。
 */
import { escapeRegExp, normalizeName } from '../utils/normalize.js';
import { SEASONING_SET } from '../utils/seasonings.js';
import { queryCache } from '../utils/queryCache.js';
import { isCloudFileId } from '../utils/image.js';
import * as storageCache from '../utils/storageCache.js';

/** 小程序端单次查询上限(客户端 limit 最大 20,超出需 skip 分页) */
const PAGE_SIZE = 20;

/** L1 内存缓存 TTL:默认 30s(loadCollection 的 ttlMs 参数,同一个人反复点时的额外优化) */
const CACHE_TTL = { LIST: 30 * 1000 };

/** 卡片流列表查询字段投影(不含 steps/ingredients 等大字段,减小列表查询载荷) */
export const DISH_CARD_FIELDS = [
  'name',
  'category',
  'tags',
  'cookTime',
  'difficulty',
  'ingredientNames',
  'images',
  'isBuiltin',
];

/**
 * 内部:分页拉取集合全量(按 where 条件,默认空条件取全部)。
 * @param {string} collectionName 集合名
 * @param {object} where 查询条件
 * @returns {Promise<Array>} 全部文档
 */
async function fetchAll(collectionName, where = {}) {
  const db = wx.cloud.database();
  let list = [];
  let skip = 0;
  // 家庭量级(数百条),有限循环即可拉完
  for (let page = 0; page < 100; page += 1) {
    const res = await db
      .collection(collectionName)
      .where(where)
      .skip(skip)
      .limit(PAGE_SIZE)
      .get();
    list = list.concat(res.data);
    if (res.data.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return list;
}

/** 内部:L3 数据源——拉取 dishes 集合全量(供 loadCollection / refreshCollection 使用) */
async function fetchAllDishes() {
  return fetchAll('dishes');
}

/** 内部:L3 数据源——拉取 ingredients 集合全量(供 loadCollection / refreshCollection 使用) */
async function fetchAllIngredients() {
  return fetchAll('ingredients');
}

/**
 * 三段读取(L1 内存 → L2 Storage → L3 云库),命中即返回并回填上一层,不重打库。
 * @param {string} name 缓存单元名(如 'dishes'/'ingredients'/'records:2026-08-23';storage 键自动加 rmdc_ 前缀)
 * @param {Function} fetcher L3 拉取函数,返回 Promise<Array>
 * @param {object} [opts]
 * @param {number} [opts.ttlMs=CACHE_TTL.LIST] L1 内存 TTL(同一个人反复点时的额外优化;L2 持久层不设 TTL)
 * @returns {Promise<Array>} 文档数组(浅拷贝,调用方可安全排序/过滤)
 */
async function loadCollection(name, fetcher, { ttlMs = CACHE_TTL.LIST } = {}) {
  // L1:内存缓存(进程内 TTL)
  const memKey = queryCache.keyOf(['collection', name]);
  const mem = queryCache.get(memKey);
  if (mem) return mem;
  // L2:本地持久缓存(跨启动有效,首屏 onLaunch 预热后页面读这里加速)
  const local = storageCache.get(name);
  if (local) {
    queryCache.set(memKey, local, ttlMs);
    return local;
  }
  // L3:云数据库(源头),成功后回填 L2 + L1
  const list = await fetcher();
  storageCache.set(name, list);
  queryCache.set(memKey, list, ttlMs);
  return list.slice();
}

/**
 * 写库后一致性失效:清 L1 内存 + L2 Storage(同名前缀)。
 * 调用方随后应 refreshCollection 重拉最新数据回填 L2,保证"改了就能看到"。
 * @param {string[]} [collectionNames] 需要失效的缓存单元名数组;缺省清空全部 rmdc_ 键
 */
function markDirty(collectionNames) {
  // L1:内存缓存条目少,全清最可靠
  queryCache.markDirty();
  // L2:按集合名清(缺省全清),下次读对应集合时走 L3 拉最新
  if (Array.isArray(collectionNames) && collectionNames.length) {
    collectionNames.forEach((name) => storageCache.remove(name));
  } else {
    storageCache.clearAll();
  }
}

/**
 * 重拉某缓存单元全量并回填 L2(写后同步三层:以 L3 为源覆盖 L2)。
 * 失败仅 console.error 降级:L2 为空,下次读自动走 L3 拉取,不阻断业务。
 * @param {string} name 缓存单元名(同 loadCollection)
 * @param {Function} fetcher L3 拉取函数
 * @returns {Promise<Array|null>} 回填的数据;失败返回 null
 */
async function refreshCollection(name, fetcher) {
  try {
    const list = await fetcher();
    storageCache.set(name, list);
    return list;
  } catch (err) {
    console.error(`[db] refreshCollection 回填 ${name} 失败(降级)`, err);
    return null;
  }
}

/** 内部:字段投影(JS 层等价数据库 field 投影) */
function pickFields(doc, field) {
  const out = {};
  field.forEach((f) => {
    if (doc[f] !== undefined) out[f] = doc[f];
  });
  return out;
}

/**
 * 内部:把引用旧原料的菜品批量改指向新原料,并同步冗余的 ingredientNames。
 * @param {string} oldName 旧原料名
 * @param {string} oldId 旧原料 _id
 * @param {string} newId 新原料 _id(撞名合并时为既有原料,否则同 oldId)
 * @param {string} newName 新原料名
 */
async function redirectDishIngredients(oldName, oldId, newId, newName) {
  const db = wx.cloud.database();
  const _ = db.command;
  const dishes = await fetchAll('dishes', { ingredientNames: oldName });
  for (const dish of dishes) {
    const ingredientIds = (dish.ingredientIds || []).map((x) => (x === oldId ? newId : x));
    const ingredientNames = (dish.ingredientNames || []).map((x) => (x === oldName ? newName : x));
    await db.collection('dishes').doc(dish._id).update({
      data: {
        ingredientIds: _.set(ingredientIds),
        ingredientNames: _.set(ingredientNames),
      },
    });
  }
  return dishes.length;
}

/**
 * 确保原料存在:按归一化名称查重,库内已有则直接返回,否则插入。
 * 调料标记 isSeasoning 落库:显式传入时以传入值为准,否则按 SEASONING_SET 判断。
 * 独立调用(原料库新增)时 sync=true:写库后 markDirty + 重拉回填 L2,立即可见;
 * saveDish / seed 批量导入内部调用传 { sync: false },由外层统一同步,避免循环内反复拉全量。
 * @param {string} name 原料名(未归一化也可)
 * @param {boolean} [isSeasoning] 是否调料;缺省时按调料集合判断
 * @param {object} [opts]
 * @param {boolean} [opts.sync=true] 是否立即同步三层缓存
 * @returns {Promise<{_id: string, name: string, isNew: boolean, isSeasoning: boolean}>}
 */
export async function ensureIngredient(name, isSeasoning, { sync = true } = {}) {
  const normalized = normalizeName(name);
  const db = wx.cloud.database();
  const col = db.collection('ingredients');
  const exist = await col.where({ name: normalized }).limit(1).get();
  let result;
  if (exist.data.length > 0) {
    const doc = exist.data[0];
    // 显式传入标记且与库内不一致时补齐,保证调料标记落库一致
    if (isSeasoning != null && doc.isSeasoning !== Boolean(isSeasoning)) {
      await col.doc(doc._id).update({ data: { isSeasoning: Boolean(isSeasoning) } });
    }
    let finalSeasoning = SEASONING_SET.has(normalized);
    if (doc.isSeasoning != null) {
      finalSeasoning = doc.isSeasoning;
    } else if (isSeasoning != null) {
      finalSeasoning = Boolean(isSeasoning);
    }
    result = { _id: doc._id, name: normalized, isNew: false, isSeasoning: finalSeasoning };
  } else {
    const finalSeasoning = isSeasoning != null ? Boolean(isSeasoning) : SEASONING_SET.has(normalized);
    const added = await col.add({
      data: { name: normalized, isSeasoning: finalSeasoning, createdAt: db.serverDate() },
    });
    result = { _id: added._id, name: normalized, isNew: true, isSeasoning: finalSeasoning };
  }
  // 写库后同步三层:原料集合变化,清缓存并重拉回填 L2
  if (sync) {
    markDirty(['ingredients']);
    await refreshCollection('ingredients', fetchAllIngredients);
  }
  return result;
}

/**
 * 原料模糊查询:名称正则匹配(忽略大小写);kw 为空返回全部。
 * 读全量缓存(L1/L2/L3 三段),JS 层过滤,避免按关键字重复打库。
 * @param {string} [kw=''] 查询关键字
 * @returns {Promise<Array>} 原料文档数组
 */
export async function listIngredients(kw = '') {
  const all = await loadCollection('ingredients', fetchAllIngredients);
  if (!kw) return all;
  const re = new RegExp(escapeRegExp(kw), 'i');
  return all.filter((d) => re.test(d.name || ''));
}

/**
 * 原料重命名。
 * 撞名(新名称已存在)时:dishes 中的旧引用改指既有原料,随后删除旧原料;
 * 未撞名:直接改名,并同步 dishes 中冗余的 ingredientNames。
 * 写库后同步三层:重命名影响 ingredients + dishes(冗余 ingredientNames)。
 * @param {string} id 原料 _id
 * @param {string} newName 新名称
 * @returns {Promise<{_id: string, name: string, merged: boolean}>}
 */
export async function renameIngredient(id, newName) {
  const normalized = normalizeName(newName);
  const db = wx.cloud.database();
  const col = db.collection('ingredients');
  const oldDoc = await col.doc(id).get(); // 原料不存在时此处会抛错,由调用方提示
  const oldName = oldDoc.data.name;
  const dup = await col.where({ name: normalized }).limit(1).get();
  const target = dup.data[0];

  let result;
  if (target && target._id !== id) {
    // 撞名合并:旧引用改指既有原料后删除旧原料
    await redirectDishIngredients(oldName, id, target._id, normalized);
    await col.doc(id).remove();
    result = { _id: target._id, name: normalized, merged: true };
  } else {
    // 普通改名
    await redirectDishIngredients(oldName, id, id, normalized);
    await col.doc(id).update({ data: { name: normalized } });
    result = { _id: id, name: normalized, merged: false };
  }
  markDirty(['ingredients', 'dishes']);
  await refreshCollection('ingredients', fetchAllIngredients);
  await refreshCollection('dishes', fetchAllDishes);
  return result;
}

/**
 * 删除原料:仅解除 dishes 中的引用(ingredientIds / ingredientNames),不删除菜品。
 * 写库后同步三层:删除影响 ingredients + dishes。
 * @param {string} id 原料 _id
 * @returns {Promise<{removed: boolean, affectedDishes: number}>}
 */
export async function removeIngredient(id) {
  const db = wx.cloud.database();
  const _ = db.command;
  const col = db.collection('ingredients');
  const doc = await col.doc(id).get(); // 原料不存在时此处会抛错,由调用方提示
  const name = doc.data.name;
  const dishes = await fetchAll('dishes', { ingredientNames: name });
  for (const dish of dishes) {
    await db.collection('dishes').doc(dish._id).update({
      data: {
        ingredientIds: _.set((dish.ingredientIds || []).filter((x) => x !== id)),
        ingredientNames: _.set((dish.ingredientNames || []).filter((x) => x !== name)),
      },
    });
  }
  await col.doc(id).remove();
  markDirty(['ingredients', 'dishes']);
  await refreshCollection('ingredients', fetchAllIngredients);
  await refreshCollection('dishes', fetchAllDishes);
  return { removed: true, affectedDishes: dishes.length };
}

/**
 * 原料使用次数统计:基于 dishes.ingredientNames 聚合(菜品引用了该原料的次数)。
 * @returns {Promise<Array<{name: string, count: number}>>} 按次数降序
 */
export async function ingredientUsage() {
  const dishes = await fetchAll('dishes');
  const countMap = new Map();
  dishes.forEach((dish) => {
    (dish.ingredientNames || []).forEach((n) => {
      countMap.set(n, (countMap.get(n) || 0) + 1);
    });
  });
  const list = Array.from(countMap, ([name, count]) => ({ name, count }));
  list.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
  return list;
}

/* ---------------- dishes 数据层 ---------------- */

/**
 * 菜品列表:分类过滤 + 关键字三字段模糊 + 按更新时间倒序分页。
 * 读全量缓存后 JS 端过滤/排序/分页(等价原数据库 where + orderBy,家庭量级无压力),
 * 与 getDish / searchDishesByIngredients 共用同一份 dishes 缓存。
 * @param {object} [opts]
 * @param {string} [opts.category] 分类 meal/drink
 * @param {string[]} [opts.tags] 标签(数组有任一命中即入选)
 * @param {string} [opts.keyword] 关键字(菜名/原料名/做法模糊)
 * @param {number} [opts.page=1] 页码(从 1 开始)
 * @param {number} [opts.pageSize=20] 每页条数
 * @param {string[]} [opts.field] 字段投影(如 DISH_CARD_FIELDS),JS 层裁剪返回字段
 * @returns {Promise<{list: Array, total: number, hasMore: boolean}>}
 */
export async function listDishes({ category, tags, keyword, page = 1, pageSize = 20, field } = {}) {
  const all = await loadCollection('dishes', fetchAllDishes);
  // JS 端过滤(等价原数据库 buildDishWhere):分类 + 标签交集 + 关键字三字段模糊
  let list = all;
  if (category) list = list.filter((d) => d.category === category);
  if (tags && tags.length) {
    list = list.filter((d) => (d.tags || []).some((t) => tags.includes(t)));
  }
  if (keyword) {
    const re = new RegExp(escapeRegExp(keyword), 'i');
    list = list.filter(
      (d) =>
        re.test(d.name || '') ||
        (d.ingredientNames || []).some((n) => re.test(n)) ||
        (d.steps || []).some((s) => re.test(s)),
    );
  }
  // 更新时间倒序(等价数据库 orderBy updatedAt desc);缺 updatedAt 的旧数据排最后
  const sorted = list.slice().sort((a, b) => {
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta || (a.name || '').localeCompare(b.name || '', 'zh');
  });
  const total = sorted.length;
  const start = (page - 1) * pageSize;
  const pageItems = sorted.slice(start, start + pageSize);
  const out = Array.isArray(field) && field.length ? pageItems.map((d) => pickFields(d, field)) : pageItems;
  return { list: out, total, hasMore: page * pageSize < total };
}

/**
 * 按原料找菜:传入已选原料名,返回匹配菜品。
 * 调料(isSeasoning)的排除由调用方在传入 names 前处理,本函数只按传入名称匹配。
 * 读全量 dishes 缓存后 JS 层粗筛 + 精排(等价原数据库 _.in 粗筛)。
 * @param {string[]} ingredientNames 已选原料名(建议已归一化)
 * @param {object} [opts]
 * @param {'partial'|'complete'} [opts.mode='partial'] partial=交集(匹配度降序);complete=菜品全部原料都在所选范围内
 * @returns {Promise<Array>} 匹配菜品(partial 模式带 matchScore 字段)
 */
export async function searchDishesByIngredients(ingredientNames, { mode = 'partial' } = {}) {
  const names = (ingredientNames || []).map(normalizeName).filter(Boolean);
  if (names.length === 0) return [];
  // 与 listDishes 共用同一份 dishes 缓存,JS 端交集粗筛 + 模式精排
  const all = await loadCollection('dishes', fetchAllDishes);
  const candidates = all.filter((d) => (d.ingredientNames || []).some((n) => names.includes(n)));
  if (mode === 'complete') {
    return candidates
      .filter((dish) => (dish.ingredientNames || []).every((n) => names.includes(n)))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }
  // partial:交集匹配,匹配度 = 命中数 / 菜品原料总数,降序排列
  return candidates
    .map((dish) => {
      const dishNames = dish.ingredientNames || [];
      const hitCount = dishNames.filter((n) => names.includes(n)).length;
      return { ...dish, matchScore: dishNames.length ? hitCount / dishNames.length : 0 };
    })
    .sort((a, b) => b.matchScore - a.matchScore || a.name.localeCompare(b.name, 'zh'));
}

/**
 * 内部:归一化菜品 steps,兜底历史脏数据。
 * 修复 1 根因:saveDish 新增分支曾把 _.set command 对象当普通值写入,
 * 老数据 steps 可能是 {$set:[...]} 对象而非数组,这里提取 $set 数组,保证展示与编辑可用。
 * @param {object} raw 数据库返回的菜品文档
 * @returns {object} steps 归一化为字符串数组的文档
 */
function normalizeDishSteps(raw) {
  if (!raw) return raw;
  let steps = raw.steps;
  // 历史脏数据:add 分支误写入的 command 对象形状 {$set:[步骤...]}
  if (steps && !Array.isArray(steps) && Array.isArray(steps.$set)) steps = steps.$set;
  if (!Array.isArray(steps)) steps = [];
  return { ...raw, steps };
}

/**
 * 菜品详情:优先从全量 dishes 缓存命中;缓存中找不到(如其他设备新增/缓存过期)时单查 L3 兜底。
 * @param {string} id 菜品 _id
 * @returns {Promise<object>} 菜品文档(steps 已归一化为字符串数组)
 */
export async function getDish(id) {
  const all = await loadCollection('dishes', fetchAllDishes);
  const found = all.find((d) => d._id === id);
  if (found) return normalizeDishSteps(found);
  // 全量缓存中找不到:单查 L3 兜底(文档不存在时 SDK 抛错,由调用方提示)
  const db = wx.cloud.database();
  const res = await db.collection('dishes').doc(id).get();
  return normalizeDishSteps(res.data);
}

/**
 * 新增/编辑菜品统一入口。
 * 流程:逐个 ensureIngredient(含调料标记)→ 组装 ingredientIds/ingredientNames → add 或 update。
 * 更新时对全量字段用 _.set,updatedAt 取服务端时间。
 * @param {object} dish 菜品数据
 * @param {string} [dish.id] 存在则更新,否则新增
 * @param {string} dish.name 菜名
 * @param {string} dish.category meal/drink
 * @param {string[]} [dish.tags] 标签
 * @param {string} [dish.cookTime] 烹饪时间
 * @param {string} [dish.difficulty] 难度
 * @param {string[]} [dish.steps] 做法步骤
 * @param {string[]} [dish.images] 图片 fileID 列表(更新时缺省则保留原值)
 * @param {Array<{id?: string, name: string, amount?: string, isSeasoning?: boolean}>} [dish.ingredients] 原料;元素带 id 时信任该 id(跳过 ensure 查询,仅用于已知存在的原料)
 * @param {boolean} [dish.isBuiltin] 是否内置(新增时写入,更新时缺省保留原值)
 * @param {object} [opts]
 * @param {boolean} [opts.skipSync=false] 批量导入等场景跳过写后重拉回填(仅 markDirty 清缓存,下次读走 L3)
 * @returns {Promise<object>} 保存后的文档
 */
export async function saveDish(dish, { skipSync = false } = {}) {
  const db = wx.cloud.database();
  const _ = db.command;
  // 1. 原料逐个 ensure,组装关联字段与用量明细
  const ingredientIds = [];
  const ingredientNames = [];
  const ingredients = (dish.ingredients || []).map((ing) => {
    const res = { name: ing.name, amount: ing.amount || '', isSeasoning: ing.isSeasoning };
    // 保留调用方已提供的原料 id(编辑页勾选/seed 导入),用于下方跳过重复查询
    if (ing.id) res.id = ing.id;
    return res;
  });
  for (const ing of ingredients) {
    if (ing.id) {
      // 已带 id 说明原料已存在(编辑页从原料库勾选 / seed 导入前已 ensure 建 Map),
      // 信任该 id 即可,跳过一次 ensure 查询(内置数据批量导入的主要耗时点)
      ingredientIds.push(ing.id);
      ingredientNames.push(normalizeName(ing.name));
      continue;
    }
    // 内部 ensure:不各自同步缓存(sync:false),由 saveDish 写库后统一同步,避免循环内反复拉全量
    const ensured = await ensureIngredient(ing.name, ing.isSeasoning, { sync: false });
    ing.id = ensured._id;
    ing.name = ensured.name;
    ingredientIds.push(ensured._id);
    ingredientNames.push(ensured.name);
  }
  // 2. 组装全量字段(纯值;update 分支再按字段包 _.set,add 分支直接写纯值)
  //    注意:add 分支不能再带 command 对象(修复 1 根因),否则 steps 等数组字段会以
  //    {$set:[...]} 形状入库,导致详情页做法无法渲染
  const data = {
    name: normalizeName(dish.name),
    category: dish.category,
    tags: dish.tags || [],
    cookTime: dish.cookTime || '',
    difficulty: dish.difficulty || '',
    ingredientIds,
    ingredientNames,
    ingredients,
    steps: dish.steps || [],
    updatedAt: db.serverDate(),
  };
  if (dish.images) data.images = dish.images;
  if (dish.isBuiltin) data.isBuiltin = true;
  // 3. 新增或更新
  if (dish.id) {
    // 更新:数组字段必须用 _.set 整体替换(直接传数组会被当作字段合并);updatedAt 为 serverDate 保持原样
    const updateData = {};
    Object.keys(data).forEach((key) => {
      updateData[key] = key === 'updatedAt' ? data[key] : _.set(data[key]);
    });
    await db.collection('dishes').doc(dish.id).update({ data: updateData });
    markDirty(['dishes', 'ingredients']); // 写库后清 L1+L2
    if (!skipSync) {
      await refreshCollection('dishes', fetchAllDishes);
      await refreshCollection('ingredients', fetchAllIngredients);
    }
    return { _id: dish.id, ...data };
  }
  const added = await db.collection('dishes').add({ data: { ...data, createdAt: db.serverDate() } });
  markDirty(['dishes', 'ingredients']); // 写库后清 L1+L2
  if (!skipSync) {
    await refreshCollection('dishes', fetchAllDishes);
    await refreshCollection('ingredients', fetchAllIngredients);
  }
  return { _id: added._id, ...data };
}

/**
 * 删除菜品:先清理其云存储图片文件(images 为空数组则跳过),再删文档。
 * 仅对云存储 fileID 调用 wx.cloud.deleteFile,其他路径一律过滤,避免非法 fileID 报错。
 * records 中的历史做菜记录保留(靠冗余快照,不级联删除)。
 * @param {string} id 菜品 _id
 * @returns {Promise<{removed: boolean, dishName: string}>}
 */
export async function removeDish(id) {
  const db = wx.cloud.database();
  const doc = await db.collection('dishes').doc(id).get();
  const dish = doc.data;
  // 只清理云存储 fileID(非云路径一律过滤,避免 deleteFile 收到非法 fileID 报错)
  const images = (dish.images || []).filter(isCloudFileId);
  if (images.length > 0) {
    await wx.cloud.deleteFile({ fileList: images });
  }
  await db.collection('dishes').doc(id).remove();
  markDirty(['dishes']); // 写库后清 L1+L2
  await refreshCollection('dishes', fetchAllDishes);
  return { removed: true, dishName: dish.name };
}

/**
 * 菜名查重(软校验用):归一化后按 name 查库。
 * @param {string} name 菜名
 * @returns {Promise<boolean>} 已存在返回 true
 */
export async function checkDishName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return false;
  const db = wx.cloud.database();
  const res = await db.collection('dishes').where({ name: normalized }).limit(1).get();
  return res.data.length > 0;
}

/* ---------------- records 数据层 ---------------- */

/**
 * 本地时区日期键:YYYY-MM-DD(做菜记录的聚合分组键)。
 * 注意:不能用 toISOString()——它按 UTC 输出,东八区夜间会错位,必须手动拼年月日。
 * @param {Date} [d] 日期对象,默认当前时间
 * @returns {string} YYYY-MM-DD(本地时区)
 */
export function dateKey(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 做菜落账:读取菜品快照后写一条 records(只增不改,菜品删除后历史记录仍可读)。
 * ingredientNames 取非调料原料名列表(快照,统计模块原料 +1 的来源)。
 * @param {string} dishId 菜品 _id
 * @returns {Promise<object>} 新增的记录文档(含 _id)
 */
export async function addCookRecord(dishId) {
  const db = wx.cloud.database();
  // 取菜品快照:菜品删除后记录仍靠冗余字段保底可读
  const dish = await getDish(dishId);
  // 快照:非调料原料名列表;老数据无 ingredients 明细时退回 ingredientNames 兜底
  let ingredientNames = (dish.ingredients || [])
    .filter((ing) => (ing.isSeasoning != null ? !ing.isSeasoning : !SEASONING_SET.has(ing.name)))
    .map((ing) => ing.name);
  if (ingredientNames.length === 0 && Array.isArray(dish.ingredientNames)) {
    ingredientNames = dish.ingredientNames;
  }
  const doc = {
    date: dateKey(),
    dishId,
    dishName: dish.name,
    ingredientNames,
    createdAt: db.serverDate(),
  };
  const added = await db.collection('records').add({ data: doc });
  // 写库后同步三层:今日记录缓存失效并重拉回填 L2
  markDirty([`records:${doc.date}`]);
  await refreshCollection(`records:${doc.date}`, () => fetchAll('records', { date: doc.date }));
  return { _id: added._id, ...doc };
}

/**
 * 某天的做菜记录列表(倒序,新→旧)。
 * 读三段缓存(records:日期),L2 命中不重打库。
 * @param {string} [date] 日期键 YYYY-MM-DD,默认今天
 * @returns {Promise<Array>} 记录数组(createdAt 倒序)
 */
export async function todayRecords(date = dateKey()) {
  const list = await loadCollection(`records:${date}`, () => fetchAll('records', { date }));
  return list.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * 撤销当天最后一条记录:按 createdAt 倒序取第一条并删除。
 * @param {string} [date] 日期键 YYYY-MM-DD,默认今天
 * @returns {Promise<{removed: boolean, record?: object}>} removed=false 表示当天无记录
 */
export async function undoLastTodayRecord(date = dateKey()) {
  const db = wx.cloud.database();
  const res = await db
    .collection('records')
    .where({ date })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  if (res.data.length === 0) return { removed: false };
  const record = res.data[0];
  await db.collection('records').doc(record._id).remove();
  markDirty([`records:${date}`]); // 写库后清 L1+L2
  await refreshCollection(`records:${date}`, () => fetchAll('records', { date }));
  return { removed: true, record };
}

/**
 * 记录聚合统计:range 内按日期 / 菜品 / 原料分组(M4 统计模块用)。
 * 家庭量级一次 fetchAll 后 JS 分组即可,无需 aggregate 管道。
 * @param {object} [range]
 * @param {string} [range.from] 起始日期 YYYY-MM-DD(含)
 * @param {string} [range.to] 结束日期 YYYY-MM-DD(含)
 * @returns {Promise<{byDate: Array<{date,count}>, byDish: Array<{name,count}>, byIngredient: Array<{name,count}>}>}
 */
export async function statsAggregate({ from, to } = {}) {
  const db = wx.cloud.database();
  const _ = db.command;
  const where = {};
  if (from || to) {
    if (from && to) where.date = _.and(_.gte(from), _.lte(to));
    else if (from) where.date = _.gte(from);
    else where.date = _.lte(to);
  }
  const records = await fetchAll('records', where);
  const byDateMap = new Map();
  const byDishMap = new Map();
  const byIngredientMap = new Map();
  records.forEach((record) => {
    byDateMap.set(record.date, (byDateMap.get(record.date) || 0) + 1);
    const dishName = record.dishName || '未知菜品';
    byDishMap.set(dishName, (byDishMap.get(dishName) || 0) + 1);
    (record.ingredientNames || []).forEach((name) => {
      byIngredientMap.set(name, (byIngredientMap.get(name) || 0) + 1);
    });
  });
  const byDate = Array.from(byDateMap, ([date, count]) => ({ date, count })).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const byDish = Array.from(byDishMap, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'),
  );
  const byIngredient = Array.from(byIngredientMap, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'),
  );
  return { byDate, byDish, byIngredient };
}

/**
 * 首屏预热:并行拉取核心集合(dishes / ingredients / 今日 records)回填 L1+L2。
 * app.js onLaunch 中 wx.cloud.init 后调用,异步不阻塞首屏;
 * 页面后续请求优先命中本地缓存,减少云数据库调用。
 */
export async function preloadCoreData() {
  try {
    const today = dateKey();
    await Promise.all([
      loadCollection('dishes', fetchAllDishes),
      loadCollection('ingredients', fetchAllIngredients),
      loadCollection(`records:${today}`, () => fetchAll('records', { date: today })),
    ]);
  } catch (err) {
    // 预热失败降级:页面请求时自行走 L3 拉取并回填,不影响使用
    console.error('[db] preloadCoreData 失败(降级)', err);
  }
}
