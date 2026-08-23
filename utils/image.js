/**
 * utils/image.js
 * 图片路径相关纯函数(node 可独立单测)。
 * 用途:云存储 fileID 识别——删除菜品/移除表单图片时,只对云存储 fileID
 * 调用 wx.cloud.deleteFile,其他路径一律跳过,避免非法 fileID 报错。
 */

/**
 * 判断图片路径是否为云存储 fileID。
 * 云存储 fileID 形如 cloud://env-xxx/dishes/xxx.jpg。
 * @param {*} path 图片路径
 * @returns {boolean} true=云存储 fileID(可上传/删除);false=其他路径或空值
 */
export function isCloudFileId(path) {
  return typeof path === 'string' && path.length > 0 && path.indexOf('/static/') !== 0;
}
