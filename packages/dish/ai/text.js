/**
 * packages/ai/text.js
 * F27 AI 生文通用封装(混元成长计划,2026-02-24 到期,配置化开关,见 docs/AI调用文档.md)。
 * 小程序端直调 hy3(免 API key),契约 2026-08-28 实测探明:
 *   createModel('cloudbase') 字符串形态 + generateText({model, messages});
 *   文档里的 model.invoke(...) 是云端 API,小程序端没有。
 * 错误统一为 Error.message = 中文文案,调用方直接 toast;code 挂在 err.code 上供分支。
 * 注意:wx 引用一律放在函数内部,保证 node 环境 import 本文件不抛错。
 */
import { getAiConfig } from './config.js';

/** 单次生成超时(AI 报菜员/定菜助手都是短输出,15s 足够) */
const TIMEOUT_MS = 15 * 1000;

/**
 * 等待 ms 后以超时错误拒绝。
 * @param {number} ms
 * @returns {Promise<never>}
 */
function timeoutReject(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      const err = new Error('AI 响应超时,请稍后再试');
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
  });
}

/**
 * 生成文本(一次性返回,不做流式——两个场景都是短文本)。
 * @param {Array<{role:string, content:string}>} messages 消息数组
 * @param {object} [opts] { model='hy3', timeoutMs=TIMEOUT_MS }
 * @returns {Promise<string>} 模型文本(choices[0].message.content)
 * @throws {Error} code: AI_DISABLED(开关关)/ TIMEOUT / MODEL_ERROR
 */
export async function generateText(messages, opts = {}) {
  const { model = 'hy3', timeoutMs = TIMEOUT_MS } = opts;

  // 开关闸门:总开关或生文开关任一关闭,直接拒绝(入口层 wx:if 也读同一配置,双保险)
  const cfg = await getAiConfig();
  if (!cfg.aiEnabled || !cfg.textEnabled) {
    const err = new Error('AI 功能未开启');
    err.code = 'AI_DISABLED';
    throw err;
  }

  const call = (async () => {
    const aiModel = wx.cloud.extend.AI.createModel('cloudbase');
    const res = await aiModel.generateText({ model, messages });
    const text =
      res && res.choices && res.choices[0] && res.choices[0].message
        ? res.choices[0].message.content
        : '';
    if (!text) {
      const err = new Error('AI 未返回内容,请稍后再试');
      err.code = 'MODEL_ERROR';
      throw err;
    }
    return text;
  })();

  try {
    return await Promise.race([call, timeoutReject(timeoutMs)]);
  } catch (err) {
    if (err.code) throw err;
    // 云侧异常(含 invalid token timestamp 等工具劣化)统一收口
    console.error('[ai/text] generateText 失败:', err.errMsg || err.message || err);
    const wrapped = new Error('AI 暂时不可用,请稍后再试');
    wrapped.code = 'MODEL_ERROR';
    throw wrapped;
  }
}

/**
 * 从模型输出里提取 JSON 对象(容错 ```json 包裹与前后缀文本)。
 * @param {string} text 模型原始输出
 * @returns {object|null} 解析失败返回 null,调用方降级为纯文本展示
 */
export function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}
