/**
 * api/upload.js
 * 图片能力封装:选择 / 压缩 / 上传 / 删除云存储文件 + 内置图批量上云
 * 页面只 import 本模块操作云存储,不直接碰 wx.cloud。
 * 注意:wx 引用一律放在函数内部,保证在 node 环境下 import 本文件不抛错。
 */
import builtinData from '../data/builtin-dishes.js';

/** 内置图菜名清单(云映射的键基准;主包瘦身后本地源已移除,菜名唯一来自内置数据) */
const BUILTIN_IMAGE_NAMES = builtinData.dishes.map((dish) => dish.name);

/** 内置图上传并发批次大小(每批同时上传 5 张,避免瞬时并发过高) */
const UPLOAD_BATCH_SIZE = 5;

/** 单张图片大小上限(1MB,单位字节) */
const MAX_SIZE = 1024 * 1024;

/** 压缩质量阶梯:依次降质,最后一级附带宽度 1280 兜底 */
const QUALITY_STEPS = [
  { quality: 80 },
  { quality: 60 },
  { quality: 40, compressedWidth: 1280 },
];

/** 从临时文件路径取扩展名(如 jpg/png/gif),取不到默认 jpg */
function getExt(tempFilePath) {
  const match = String(tempFilePath).match(/\.([a-z0-9]+)(?:\?|$)/i);
  return match ? match[1].toLowerCase() : 'jpg';
}

/** 生成云存储路径:dishes/日期时间戳-随机串.扩展名 */
function buildCloudPath(ext) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join('');
  const time = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('');
  const random = Math.random().toString(36).slice(2, 8);
  return `dishes/${date}${time}-${random}.${ext}`;
}

/** 读取本地文件大小(字节);读取失败返回 -1 */
function getFileSize(filePath) {
  return new Promise((resolve) => {
    wx.getFileSystemManager().getFileInfo({
      filePath,
      success: (res) => resolve(res.size),
      fail: () => resolve(-1),
    });
  });
}

/**
 * 单张压缩到 ≤1M:按质量阶梯(80→60→40)循环,每级压缩后重新取大小,达标即返回。
 * 每级以上一级压缩结果为源继续压,最后一级附带 1280 宽度兜底;仍超 1M 返回空串。
 * @param {object} file wx.chooseMedia 返回的临时文件(含 tempFilePath)
 * @returns {Promise<string>} 达标后的临时路径;无法压缩达标返回空串
 */
async function compressToFit(file) {
  let src = file.tempFilePath;
  for (const step of QUALITY_STEPS) {
    const params = { src, quality: step.quality };
    if (step.compressedWidth) params.compressedWidth = step.compressedWidth;
    const compressed = await new Promise((resolve) => {
      wx.compressImage({
        ...params,
        success: (res) => resolve(res.tempFilePath),
        fail: () => resolve(''),
      });
    });
    if (!compressed) return '';
    const size = await getFileSize(compressed);
    if (size >= 0 && size <= MAX_SIZE) return compressed;
    src = compressed; // 未达标,继续以上一级结果降质
  }
  return '';
}

/**
 * 选择并上传图片(最多 max 张)。
 * 流程:wx.chooseMedia 选择 → 逐张判断:
 *  - size ≤ 1M 直传;
 *  - > 1M 用 wx.compressImage 循环降质(quality 80→60→40,compressedWidth 兜底 1280),仍超 1M 拒绝该张;
 *  - gif 不可压缩,> 1M 直接拒绝。
 * 上传路径 dishes/{日期时间戳-随机串}.{ext},ext 从 tempFilePath 后缀取,默认 jpg。
 * @param {number} existingCount 已选图片数(用于计算本次可再选数量)
 * @param {number} [max=5] 图片总数上限
 * @returns {Promise<{fileIds: string[], rejected: string[]}>} 上传成功的 fileID 与被拒绝的文件名
 */
export async function chooseAndUploadImages(existingCount, max = 5) {
  const count = Math.max(0, max - existingCount);
  if (count <= 0) return { fileIds: [], rejected: [] };

  let tempFiles = [];
  try {
    const res = await wx.chooseMedia({ count, mediaType: ['image'] });
    tempFiles = res.tempFiles || [];
  } catch (err) {
    // 用户取消选择等场景,静默返回
    return { fileIds: [], rejected: [] };
  }

  const fileIds = [];
  const rejected = [];
  for (const file of tempFiles) {
    const path = file.tempFilePath;
    const ext = getExt(path);
    const name = path.split('/').pop() || '图片';
    let size = file.size;
    if (!size) {
      const got = await getFileSize(path);
      if (got > 0) size = got;
    }

    // gif 不可压缩:超过 1M 直接拒绝
    if (ext === 'gif' && size > MAX_SIZE) {
      rejected.push(name);
      continue;
    }

    // 超过 1M:循环压缩降质,仍超 1M 拒绝该张
    let targetPath = path;
    if (size > MAX_SIZE) {
      targetPath = await compressToFit({ tempFilePath: path });
      if (!targetPath) {
        rejected.push(name);
        continue;
      }
    }

    try {
      const uploadRes = await wx.cloud.uploadFile({
        cloudPath: buildCloudPath(ext),
        filePath: targetPath,
      });
      fileIds.push(uploadRes.fileID);
    } catch (err) {
      // 单张上传失败:先清理本批次已上传文件,再抛出让调用方提示重试
      console.error('图片上传失败', err);
      await deleteImages(fileIds);
      throw err;
    }
  }
  return { fileIds, rejected };
}

/**
 * 删除云存储图片文件(空数组直接返回;删除失败仅记录日志,不阻断主流程)。
 * @param {string[]} fileIds 云存储 fileID 列表
 */
export async function deleteImages(fileIds) {
  if (!fileIds || fileIds.length === 0) return;
  try {
    await wx.cloud.deleteFile({ fileList: fileIds });
  } catch (err) {
    console.error('删除云存储图片失败', err);
  }
}

/* ---------------- 内置图批量上云(方案 A,主包瘦身) ---------------- */

/**
 * 判断云映射是否已覆盖全部内置菜(builtin-dishes.js 全部菜名且值非空)。
 * 纯函数:预检「已上云」与重试时判断还缺哪些菜。
 * @param {object|null} map app_meta builtin_images 文档的 map(菜名→fileID);null=无记录
 * @returns {boolean} 已完整覆盖返回 true
 */
export function isBuiltinImageMapComplete(map) {
  if (!map || typeof map !== 'object') return false;
  return BUILTIN_IMAGE_NAMES.every((name) => !!map[name]);
}

/**
 * 读取内置图云映射(app_meta 集合 _id='builtin_images' 的 map:菜名→云 fileID)。
 * 文档不存在或云库不可达均返回 null(调用方回退本地静态映射,不阻断业务)。
 * @returns {Promise<object|null>} 菜名→fileID 映射;不存在/读取失败返回 null
 */
export async function loadBuiltinImageMap() {
  try {
    const db = wx.cloud.database();
    const res = await db.collection('app_meta').doc('builtin_images').get();
    const map = res.data && res.data.map;
    return map && typeof map === 'object' ? map : null;
  } catch (err) {
    // 云库不可达 / 文档不存在:返回 null,调用方回退本地映射
    return null;
  }
}

/**
 * 上传全部内置菜图片到云存储(一次性,主包瘦身;库中旧菜的 images 由 seed 增量补图自动替换成云 fileID)。
 * ⚠️ 本地静态源已移除(主包瘦身,static/images 已删):云映射不完整时,本函数的上传分支会失败,
 *    需将原图放回 static/images 并恢复 data/builtin-images.js 映射后重试;预检已完整时照常返回
 *    alreadyDone,这是正常主路径(不触发上传)。
 * 流程:预检 app_meta 云映射——已完整覆盖全部内置菜直接返回(不重复上传、不报错);
 * 缺失的菜名才尝试上传,cloudPath 为 builtin/{菜名}.jpg(无本地源可识别扩展名,默认 jpg);
 * 并发分批(每批 5 张),单张失败不中断(收集菜名,可再次点击重试只补缺失);
 * 全部完成后写回 app_meta:无记录用 add 带 _id(与 seed_lock 同款),已有部分记录用 doc update _.set 合并全量 map。
 * @param {object} [opts]
 * @param {Function} [opts.onProgress] 每处理完一张回调 onProgress(done, total)
 * @returns {Promise<{alreadyDone: boolean, uploaded: number, failed: string[]}>}
 *   alreadyDone=true 表示已完整上云(本次未上传);uploaded 为本次新上传张数;failed 为上传失败的菜名列表
 */
export async function uploadBuiltinImages({ onProgress } = {}) {
  // 预检:已完整上云直接返回(主路径),不重复上传
  const existing = await loadBuiltinImageMap();
  if (isBuiltinImageMapComplete(existing)) {
    return { alreadyDone: true, uploaded: 0, failed: [] };
  }

  const names = BUILTIN_IMAGE_NAMES;
  const total = names.length;
  const resultMap = {}; // 菜名 → fileID(既有映射 + 本次上传,合并后全量写回)
  const failed = [];
  let uploadedCount = 0;
  let done = 0;
  // 分批并发,每批 5 张;单张失败只收集菜名,不中断整体
  for (let i = 0; i < total; i += UPLOAD_BATCH_SIZE) {
    const batch = names.slice(i, i + UPLOAD_BATCH_SIZE);
    await Promise.all(
      batch.map(async (name) => {
        try {
          if (existing && existing[name]) {
            // 已上云的菜直接沿用(重试只补缺失,不重复上传)
            resultMap[name] = existing[name];
          } else {
            // 本地源已移除:无有效 filePath,此分支注定失败(保留结构便于恢复本地源后重试)
            const res = await wx.cloud.uploadFile({
              cloudPath: `builtin/${name}.jpg`,
              filePath: '',
            });
            resultMap[name] = res.fileID;
            uploadedCount += 1;
          }
        } catch (err) {
          console.error('内置图上传失败', name, err);
          failed.push(name);
        }
        done += 1;
        if (typeof onProgress === 'function') onProgress(done, total);
      }),
    );
  }

  // 全部完成后写回 app_meta(合并全量 map,含既有部分 + 本次上传)
  const db = wx.cloud.database();
  const _ = db.command;
  const meta = { map: resultMap, updatedAt: db.serverDate() };
  if (existing) {
    // 已有部分记录:doc update _.set 合并全量 map
    await db.collection('app_meta').doc('builtin_images').update({
      data: { map: _.set(resultMap), updatedAt: db.serverDate() },
    });
  } else {
    // 无记录:add 带 _id(与 seed_lock 同款);并发冲突(记录已被其他设备写入)降级为 update 合并
    try {
      await db.collection('app_meta').add({ data: { _id: 'builtin_images', ...meta } });
    } catch (err) {
      await db.collection('app_meta').doc('builtin_images').update({
        data: { map: _.set(resultMap), updatedAt: db.serverDate() },
      });
    }
  }
  return { alreadyDone: false, uploaded: uploadedCount, failed };
}
