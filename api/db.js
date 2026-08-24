/**
 * api/db.js
 * 云数据库统一封装(零云函数,小程序端直连)
 * 所有页面只 import 本模块操作 dishes / ingredients,不散落 wx.cloud 调用。
 * 双层缓存(L1 内存 queryCache → L2 wx.Storage storageCache)+ TTL,规则一句话:
 * 「用户可见的整页刷新时机强制直查(force);页面内连续交互走缓存」——
 * - 页面内交互(搜索防抖/筛选/翻页)命中 L1(60s)→ L2(5min)→ L3,逐层回填;
 * - 整页刷新(onShow / 下拉刷新 / 进入页面)由页面传 force=true 强制穿透直达云库,成功后回填两层;
 * - 写操作(saveDish/removeDish/ensureIngredient/rename/removeIngredient/addCookRecord)
 *   成功后 markDirty 本机两层(下次读走 L3),本机写后立读最新;
 * - 单条详情(getDish)与 records 读取(todayRecords/statsAggregate)不走集合缓存,维持直查。
 * 首页「点原料→匹配」用内存快照(dishesSnapshot)兜底交互速度,见 pages/home/index.js。
 * 注意:wx 引用一律放在函数内部,保证在 node 环境下 import 本文件不抛错。
 */
import { escapeRegExp, normalizeName } from '../utils/normalize.js';
import { SEASONING_SET } from '../utils/seasonings.js';
import { isCloudFileId } from '../utils/image.js';
import { queryCache } from '../utils/queryCache.js';
import * as storageCache from '../utils/storageCache.js';
// 单向依赖:upload.js 只 import data/builtin-dishes.js,不依赖本模块,无循环引用(seed.js 已同款并存)
import { loadBuiltinImageMap } from './upload.js';

/** 小程序端单次查询上限(客户端 limit 最大 20,超出需 skip 分页) */
const PAGE_SIZE = 20;

/** L1 内存缓存 TTL(进程内页面交互,60 秒) */
const L1_TTL_MS = 60 * 1000;
/** L2 Storage 缓存 TTL(跨启动持久,5 分钟) */
const L2_TTL_MS = 5 * 60 * 1000;

/** 卡片流列表查询字段投影(不含 steps/ingredients 等大字段,减小列表查询载荷) */
export const DISH_CARD_FIELDS = [
  '_id', // 详情跳转与落账都需要菜品 id,投影里必须包含
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

/**
 * 拉取 dishes 集合全量(走集合缓存;force=true 强制穿透直查并回填两层)。
 * 首页匹配快照、listDishes 底层共用同一缓存单元 'dishes'。
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] 是否强制穿透缓存直接查云库(整页刷新时机用)
 * @returns {Promise<Array>} 全部菜品文档
 */
export async function fetchAllDishes({ force = false } = {}) {
  return loadCollection('dishes', () => fetchAll('dishes'), { force });
}

/** 内部:拉取 ingredients 集合全量(供 loadCollection 使用) */
async function fetchAllIngredients() {
  return fetchAll('ingredients');
}

/**
 * 双层缓存读取:L1 内存(queryCache,60s)→ L2 Storage(storageCache,5min)→ L3 云库,逐层回填。
 * force=true 时跳过 L1/L2 直接查云库,成功后回填两层(整页刷新时机用)。
 * @param {string} name 缓存单元名(集合名,如 'dishes' / 'ingredients')
 * @param {Function} fetcher 拉取函数,返回 Promise<Array>
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] 是否强制穿透缓存直接查云库
 * @param {number} [opts.ttlMs=60000] L1 内存缓存 TTL(毫秒)
 * @returns {Promise<Array>} 文档数组(浅拷贝,调用方可安全排序/过滤)
 */
async function loadCollection(name, fetcher, { force = false, ttlMs = L1_TTL_MS } = {}) {
  const memKey = queryCache.keyOf(['collection', name]);
  if (!force) {
    // L1 内存命中:进程内 TTL 内不重复打库(queryCache.get 已返回浅拷贝)
    const l1 = queryCache.get(memKey);
    if (l1) return l1;
    // L2 Storage 命中:回填 L1(逐层回填,不重打库)
    const l2 = storageCache.get(name, L2_TTL_MS);
    if (l2) {
      queryCache.set(memKey, l2, ttlMs);
      return l2;
    }
  }
  // L3 云库:成功后回填 L1 + L2
  const list = await fetcher();
  queryCache.set(memKey, list, ttlMs);
  storageCache.set(name, list);
  return list.slice();
}

/**
 * 内部:写库成功后失效缓存(本机 L1 内存全清 + L2 Storage 按集合删除)。
 * 下次读取(force=false)缓存未命中即走 L3 拉最新,保证本机写后立读最新。
 * @param {string[]} [collectionNames] 需失效的 L2 集合名(如 ['dishes','ingredients']);
 *   缺省则清空全部 rmdc_ 前缀键
 */
function markDirty(collectionNames) {
  // L1 全清:家庭量级缓存条目有限,全清最简单可靠
  queryCache.markDirty();
  if (collectionNames && collectionNames.length) {
    collectionNames.forEach((name) => storageCache.remove(name));
  } else {
    storageCache.clearAll();
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
 * 双层缓存:写库成功后 markDirty 本机两层,调用方再次读取自然拿到最新数据。
 * @param {string} name 原料名(未归一化也可)
 * @param {boolean} [isSeasoning] 是否调料;缺省时按调料集合判断
 * @param {object} [opts]
 * @param {boolean} [opts.sync=true] 兼容参数(历史控制写后同步,现在写库统一 markDirty;保留避免改动调用方)
 * @returns {Promise<{_id: string, name: string, isNew: boolean, isSeasoning: boolean}>}
 */
export async function ensureIngredient(name, isSeasoning, { sync = true } = {}) {
  const normalized = normalizeName(name);
  const db = wx.cloud.database();
  const col = db.collection('ingredients');
  const exist = await col.where({ name: normalized }).limit(1).get();
  let result;
  let wrote = false; // 是否真正写库(存在且无变更时不清缓存)
  if (exist.data.length > 0) {
    const doc = exist.data[0];
    // 显式传入标记且与库内不一致时补齐,保证调料标记落库一致
    if (isSeasoning != null && doc.isSeasoning !== Boolean(isSeasoning)) {
      await col.doc(doc._id).update({ data: { isSeasoning: Boolean(isSeasoning) } });
      wrote = true;
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
    wrote = true;
  }
  // 写库成功:本机两层缓存失效,下次读取走 L3 拿最新
  if (wrote) markDirty(['ingredients']);
  return result;
}

/**
 * 原料模糊查询:名称正则匹配(忽略大小写);kw 为空返回全部。
 * 走集合缓存(force=true 强制穿透);直查全量后 JS 层过滤,避免按关键字重复打库。
 * @param {string} [kw=''] 查询关键字
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] 是否强制穿透缓存直接查云库(进入页面/整页刷新时机用)
 * @returns {Promise<Array>} 原料文档数组
 */
export async function listIngredients(kw = '', { force = false } = {}) {
  const all = await loadCollection('ingredients', fetchAllIngredients, { force });
  if (!kw) return all;
  const re = new RegExp(escapeRegExp(kw), 'i');
  return all.filter((d) => re.test(d.name || ''));
}

/**
 * 原料重命名。
 * 撞名(新名称已存在)时:dishes 中的旧引用改指既有原料,随后删除旧原料;
 * 未撞名:直接改名,并同步 dishes 中冗余的 ingredientNames。
 * 双层缓存:写库成功后 markDirty 本机两层,下次读取自然拿到最新。
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
  // 写库成功:原料与菜品冗余字段都可能变化,两层缓存一并失效
  markDirty(['ingredients', 'dishes']);
  return result;
}

/**
 * 删除原料:仅解除 dishes 中的引用(ingredientIds / ingredientNames),不删除菜品。
 * 双层缓存:写库成功后 markDirty 本机两层,下次读取自然拿到最新。
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
  // 写库成功:原料与菜品冗余字段都可能变化,两层缓存一并失效
  markDirty(['ingredients', 'dishes']);
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
 * 走集合缓存(force=true 强制穿透);直查全量后 JS 端过滤/排序/分页
 * (等价原数据库 where + orderBy,家庭量级无压力),与 fetchAllDishes 共用同一缓存单元。
 * @param {object} [opts]
 * @param {string} [opts.category] 分类 meal/drink
 * @param {string[]} [opts.tags] 标签(数组有任一命中即入选)
 * @param {string} [opts.keyword] 关键字(菜名/原料名/做法模糊)
 * @param {number} [opts.page=1] 页码(从 1 开始)
 * @param {number} [opts.pageSize=20] 每页条数
 * @param {string[]} [opts.field] 字段投影(如 DISH_CARD_FIELDS),JS 层裁剪返回字段
 * @param {boolean} [opts.force=false] 是否强制穿透缓存直接查云库(整页刷新时机用)
 * @returns {Promise<{list: Array, total: number, hasMore: boolean}>}
 */
export async function listDishes({ category, tags, keyword, page = 1, pageSize = 20, field, force = false } = {}) {
  const all = await loadCollection('dishes', () => fetchAll('dishes'), { force });
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
 * 纯函数:按原料匹配菜品(交集粗筛 + matchScore 排序 + complete 子集过滤)。
 * 直查版 searchDishesByIngredients 与首页内存快照匹配共用,保证两处排序一致。
 * 调料(isSeasoning)的排除由调用方在传入 names 前处理,本函数只按传入名称匹配。
 * @param {Array} allDishes 菜品全量(可直接传首页内存快照)
 * @param {string[]} ingredientNames 已选原料名(建议已归一化)
 * @param {object} [opts]
 * @param {'partial'|'complete'} [opts.mode='partial'] partial=交集(匹配度降序);complete=菜品全部原料都在所选范围内
 * @returns {Array} 匹配菜品(partial 模式带 matchScore 字段)
 */
export function matchDishesByIngredients(allDishes, ingredientNames, { mode = 'partial' } = {}) {
  const names = (ingredientNames || []).map(normalizeName).filter(Boolean);
  if (names.length === 0 || !Array.isArray(allDishes)) return [];
  // JS 端交集粗筛(等价原数据库 _.in 粗筛)
  const candidates = allDishes.filter((d) => (d.ingredientNames || []).some((n) => names.includes(n)));
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
 * 按原料找菜:直查云库拉全量后交给纯函数 matchDishesByIngredients 匹配。
 * @param {string[]} ingredientNames 已选原料名(建议已归一化)
 * @param {object} [opts]
 * @param {'partial'|'complete'} [opts.mode='partial'] 同 matchDishesByIngredients
 * @returns {Promise<Array>} 匹配菜品(partial 模式带 matchScore 字段)
 */
export async function searchDishesByIngredients(ingredientNames, { mode = 'partial' } = {}) {
  // 维持直查(首页已改用内存快照匹配,此函数仅作兜底入口)
  const all = await fetchAll('dishes');
  return matchDishesByIngredients(all, ingredientNames, { mode });
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
 * 菜品详情:单条不走集合缓存(维持直查)——进入详情页属于整页刷新,直接查云库拿最新;
 * 全量中找不到(并发删除等)时单查兜底。
 * @param {string} id 菜品 _id
 * @returns {Promise<object>} 菜品文档(steps 已归一化为字符串数组)
 */
export async function getDish(id) {
  const all = await fetchAll('dishes');
  const found = all.find((d) => d._id === id);
  if (found) return normalizeDishSteps(found);
  // 全量中找不到:单查兜底(文档不存在时 SDK 抛错,由调用方提示)
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
 * @param {boolean} [opts.skipSync=false] 兼容参数(历史控制写后逐条重拉,现在写库统一 markDirty;保留避免改动调用方)
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
    // 内部 ensure:直查架构写后无需同步,再次读取自然拿到最新数据
    const ensured = await ensureIngredient(ing.name, ing.isSeasoning);
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
    // 写库成功:本机两层缓存失效,下次读取走 L3 拿最新(内部 ensure 新增原料也会失效 ingredients)
    markDirty(['dishes', 'ingredients']);
    return { _id: dish.id, ...data };
  }
  const added = await db.collection('dishes').add({ data: { ...data, createdAt: db.serverDate() } });
  markDirty(['dishes', 'ingredients']);
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
  // 内置公共图(cloud://builtin/…)生命周期跟随 app_meta builtin_images 映射,而非单道菜:
  // 删菜时若一并删除会留下映射死链,重导该菜时封面空白,因此必须保留内置公共图。
  // loadBuiltinImageMap 读取失败返回 null,此时视为无内置图,按原逻辑全删云图(保守降级,
  // 保证删菜功能不被云库抖动阻断)。
  const builtinMap = await loadBuiltinImageMap();
  const builtinValues = builtinMap ? Object.values(builtinMap) : [];
  // 只清理用户上传的云图 fileID(非云路径 + 内置公共图一律过滤,避免 deleteFile 收到非法 fileID 报错)
  const images = (dish.images || [])
    .filter(isCloudFileId)
    .filter((id) => !builtinValues.includes(id));
  if (images.length > 0) {
    await wx.cloud.deleteFile({ fileList: images });
  }
  await db.collection('dishes').doc(id).remove();
  // 写库成功:本机两层缓存失效,下次读取走 L3 拿最新
  markDirty(['dishes']);
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

/**
 * 按菜名查询菜品文档(供内置数据增量同步等场景,需要拿到文档而不仅是存在性)。
 * @param {string} name 菜名
 * @returns {Promise<object|null>} 菜品文档;不存在返回 null
 */
export async function getDishByName(name) {
  const normalized = normalizeName(name);
  if (!normalized) return null;
  const db = wx.cloud.database();
  const res = await db.collection('dishes').where({ name: normalized }).limit(1).get();
  return res.data.length ? res.data[0] : null;
}

/**
 * 仅更新菜品 images 字段(内置数据增量同步补图等场景,不触碰其他字段)。
 * 双层缓存:写库成功后 markDirty 本机两层,下次读取自然拿到最新。
 * @param {string} id 菜品 _id
 * @param {string[]} images 新图片数组
 * @param {object} [opts]
 * @param {boolean} [opts.skipSync=false] 兼容参数(历史控制写后同步,现在写库统一 markDirty;保留避免改动调用方)
 * @returns {Promise<void>}
 */
export async function updateDishImages(id, images, { skipSync = false } = {}) {
  const db = wx.cloud.database();
  const _ = db.command;
  await db.collection('dishes').doc(id).update({
    data: { images: _.set(images || []) },
  });
  markDirty(['dishes']);
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
  // records 读取(todayRecords/statsAggregate)为直查不走集合缓存,无需失效 L2;
  // 仅全清 L1 内存(防御其他内存快照持有旧引用),保证本机写后立读最新
  markDirty();
  return { _id: added._id, ...doc };
}

/**
 * 某天的做菜记录列表(倒序,新→旧)。records 维持直查——今日已定卡是最直观的
 * 一致性窗口,每次读取都拿云库最新(不走集合缓存)。
 * @param {string} [date] 日期键 YYYY-MM-DD,默认今天
 * @returns {Promise<Array>} 记录数组(createdAt 倒序)
 */
export async function todayRecords(date = dateKey()) {
  const list = await fetchAll('records', { date });
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
