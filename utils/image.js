/**
 * utils/image.js
 * 图片路径相关纯函数(node 可独立单测)。
 * 用途:云存储 fileID 识别——删除菜品/移除表单图片时,只对云存储 fileID
 * 调用 wx.cloud.deleteFile,其他路径一律跳过,避免非法 fileID 报错;
 * 以及展示图片排序——云端 fileID 优先,内置静态图兜底(不顶掉用户上传图)。
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

/**
 * 排序展示图片:云端 fileID 在前、内置静态图在后,各自保持原相对顺序,空值剔除。
 * 详情页轮播与列表封面共用,保证 UI 顺序始终为 user-cloud → static fallback(不能反),
 * 即用户上传图永远不会被内置占位图顶掉。
 * @param {*} images 原始图片数组(文档 images 字段)
 * @returns {Array} 排序后的数组(云端在前);非数组/空值返回空数组
 */
export function orderDishImages(images) {
  const list = Array.isArray(images) ? images.filter((p) => typeof p === 'string' && p) : [];
  return list.filter(isCloudFileId).concat(list.filter((p) => !isCloudFileId(p)));
}
