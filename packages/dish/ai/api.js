/**
 * packages/ai/api.js
 * F26 AI 生图前端封装(AI 功能:混元成长计划,2026-02-24 到期,配置化开关,见 docs/AI调用文档.md)。
 * 生图仅支持服务端调用(官方限制),小程序端经云函数 ai-image 中转;
 * 云函数内部已把 24h 临时 url 转存云存储,这里拿到的直接是 cloud:// fileID。
 * 位于分包 packages/ai(批次 2 UI 也放本分包,不增大主包)。
 * 写实保障:所有生图 prompt 统一追加写实词根(已含词根时不重复追加)。
 * 注意:wx 引用一律放在函数内部,保证 node 环境 import 本文件不抛错。
 */

import { getAiConfig } from './config.js';
import { buildImagePrompt } from './prompts.js';

/**
 * 生成菜品图片:调云函数 ai-image,失败(业务/网络)一律 throw,由调用方 toast。
 * F28:写实词根改读 config.imageStyle(可编辑,内部 await getAiConfig 后拼接,签名不变)。
 * @param {string} prompt 生图提示词(云函数侧做非空/长度校验)
 * @param {object} [opts] 可选 { width, height },默认 768x768
 * @returns {Promise<string>} 云存储 fileID(cloud://)
 */
export async function generateDishImage(prompt, opts = {}) {
  const cfg = await getAiConfig();
  const fullPrompt = buildImagePrompt(prompt, cfg.prompts.imageStyle);
  const res = await wx.cloud.callFunction({
    name: 'ai-image',
    data: { prompt: fullPrompt, width: opts.width || 768, height: opts.height || 768 },
  });
  const result = res.result || {};
  if (result.ok !== true) {
    throw new Error(result.error || '生图失败,请稍后重试');
  }
  return result.fileID;
}

/**
 * 把生成图片追加到菜品 images 数组末尾。
 * 小程序端写操作不可信静默成功:返回 update 结果的 stats.updated,由调用方自查(0 = 实际未写入)。
 * @param {string} dishId 菜品 _id
 * @param {string} fileID 云存储文件 ID
 * @returns {Promise<number>} stats.updated(1 = 成功追加)
 */
export async function attachImageToDish(dishId, fileID) {
  const db = wx.cloud.database();
  const _ = db.command;
  const res = await db.collection('dishes').doc(dishId).update({
    data: { images: _.push([fileID]) },
  });
  return (res.stats && res.stats.updated) || 0;
}
