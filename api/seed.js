/**
 * api/seed.js
 * 内置数据导入(零云函数,小程序端直连)
 * 首次导入协议:app_meta 集合中写入 _id='seed_lock' 的文档抢锁,
 * _id 冲突即说明其他设备已导入,避免重复入库。
 * 页面只 import 本模块,不直接调用 wx.cloud。
 */
import builtinData from '../data/builtin-dishes.js';
import builtinImages from '../data/builtin-images.js';
import { ensureIngredient, getDishByName, saveDish, updateDishImages } from './db.js';
import { loadBuiltinImageMap } from './upload.js';
import { normalizeName } from '../utils/normalize.js';

/**
 * 判断 add 失败是否因 _id 冲突(seed_lock 已存在)。
 * @param {Error} err 云数据库错误对象
 * @returns {boolean} true=锁已存在
 */
function isDuplicateLockError(err) {
  const msg = `${(err && (err.errMsg || err.message)) || ''} ${err && err.errCode != null ? err.errCode : ''}`;
  return /already exist/i.test(msg) || msg.includes('-502001');
}

/**
 * 导入内置菜谱与原料(幂等,可重复点击续传)。
 * @param {object} [opts]
 * @param {Function} [opts.onProgress] 每处理完一道菜回调 onProgress(done, total);done=成功+跳过+失败
 * @returns {Promise<{importedDishes: number, importedIngredients: number, skippedDishes: number, failed: string[], total: number}>}
 *   failed 为单道菜导入失败的菜名列表(不中断整体,可再次点击补导)
 */
export async function importBuiltinData({ onProgress } = {}) {
  // 0. 内置图映射:云映射优先(已上云则挂 cloud:// fileID,主包瘦身),本地静态路径兜底。
  //    loadBuiltinImageMap 云库不可达时返回 null,自动回退本地映射,不阻断导入
  const cloudMap = await loadBuiltinImageMap();
  const imageMap = cloudMap || builtinImages;

  const db = wx.cloud.database();
  // 1. 抢锁:add 成功=首次导入;add 冲突=已有人导入过
  try {
    await db.collection('app_meta').add({
      data: { _id: 'seed_lock', seededAt: db.serverDate() },
    });
  } catch (err) {
    if (!isDuplicateLockError(err)) throw err; // 网络等其他错误,交给调用方提示重试
    // 锁已存在:继续增量导入,只补缺失、不重复、不覆盖用户改动
  }

  // 2. 原料:逐个 ensure(带调料标记)并建 name → _id Map;
  //    菜品阶段把 Map 里的 id 传给 saveDish(带 id 的原料不再重复查询,大幅减少云调用次数)
  let importedIngredients = 0;
  const ingredientIdMap = new Map();
  for (const ing of builtinData.ingredients) {
    // sync:false——批量导入逐条同步会反复拉全量,由 saveDish 写库后统一失效缓存即可
    const res = await ensureIngredient(ing.name, ing.isSeasoning, { sync: false });
    if (res.isNew) importedIngredients += 1;
    ingredientIdMap.set(res.name, res._id);
  }

  // 3. 菜品:按菜名跳过已存在,其余入库(isBuiltin: true);
  //    单道菜 try/catch:失败收集菜名继续后续导入,不中断整体(网络抖动可再次点击续传)
  const total = builtinData.dishes.length;
  let importedDishes = 0;
  let skippedDishes = 0;
  let done = 0;
  const failed = [];
  // 内置图映射的全部有效值(循环外提取一次,避免每道菜重复 Object.values)
  const imageValues = Object.values(imageMap);
  for (const dish of builtinData.dishes) {
    try {
      const exists = await getDishByName(dish.name);
      if (exists) {
        // 增量同步内置图:内置菜且映射存在时,按当前 images 判断是否需要补图——
        // 有用户云图(cloud:// fileID)或当前映射有效值则不动;
        // 否则(旧失效路径 / 空串 / 无图)替换为内置图(imageMap 云 fileID 优先,本地静态路径兜底)。
        // 注意云图判断用 cloud:// 前缀而非 isCloudFileId:isCloudFileId 只排除 /static/ 前缀,
        // 会把旧 Unsplash HTTP 路径误判为云图,导致失效旧路径永远补不上。
        if (exists.isBuiltin && imageMap[dish.name]) {
          const validImages = (exists.images || []).filter(Boolean);
          const hasCloud = validImages.some((p) => p.indexOf('cloud://') === 0);
          const hasValidImage = validImages.some((p) => imageValues.includes(p));
          if (!hasCloud && !hasValidImage) {
            await updateDishImages(exists._id, [imageMap[dish.name]], { skipSync: true });
          }
        }
        skippedDishes += 1;
        done += 1;
        if (typeof onProgress === 'function') onProgress(done, total);
        continue;
      }
      await saveDish(
        {
          name: dish.name,
          category: dish.category,
          tags: dish.tags,
          cookTime: dish.cookTime,
          difficulty: dish.difficulty,
          steps: dish.steps,
          images: imageMap[dish.name] ? [imageMap[dish.name]] : [], // 内置菜挂载内置图(映射缺失时存空数组而非 [''])
          ingredients: dish.ingredients.map((ing) => {
            const res = { name: ing.name, amount: ing.amount, isSeasoning: ing.isSeasoning };
            // 原料阶段已确保存在,直接传 id 让 saveDish 跳过重复查询;查不到时缺省走 ensure 兜底
            const id = ingredientIdMap.get(normalizeName(ing.name));
            if (id) res.id = id;
            return res;
          }),
          isBuiltin: true,
        },
        // skipSync:批量导入期间不逐道重拉回填(每道都拉全量会拖慢导入),仅 markDirty 清缓存,
        // 导入完成后首次读取自然走 L3 拉最新并回填 L2
        { skipSync: true },
      );
      importedDishes += 1;
    } catch (err) {
      failed.push(dish.name);
    }
    done += 1;
    if (typeof onProgress === 'function') onProgress(done, total);
  }

  return { importedDishes, importedIngredients, skippedDishes, failed, total };
}
