/**
 * api/upload.js
 * 图片能力封装:选择 / 压缩 / 上传 / 删除云存储文件
 * 页面只 import 本模块操作云存储,不直接碰 wx.cloud。
 * 注意:wx 引用一律放在函数内部,保证在 node 环境下 import 本文件不抛错。
 */

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
