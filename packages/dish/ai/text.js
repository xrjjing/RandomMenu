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
import { reportTextUsage } from './usage.js';

/** 单次生成超时(AI 报菜员/定菜助手都是短输出,15s 足够) */
const TIMEOUT_MS = 15 * 1000;

/** 生文重试:最多 3 次尝试,退避 1s/2s,总预算 30s(单次超时取 min(TIMEOUT_MS, 剩余预算)) */
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 2000];
const TOTAL_BUDGET_MS = 30 * 1000;

/** 流式:全程总时限 30s;8s 无新增量(idle)即 TIMEOUT */
const STREAM_TOTAL_MS = 30 * 1000;
const STREAM_IDLE_MS = 8 * 1000;

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

/** 等待 ms(重试退避用) */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** 第 attempt 次失败后的退避时长(attempt 从 1 计:1s/2s,超出为 0) */
function retryDelay(attempt) {
  return RETRY_DELAYS_MS[attempt - 1] || 0;
}

/** 错误三分类里可重试的:TIMEOUT / MODEL_ERROR 可重试;AI_DISABLED 立即抛 */
function isRetryableError(err) {
  return !!(err && (err.code === 'TIMEOUT' || err.code === 'MODEL_ERROR'));
}

/** 提取错误对象常见字段做结构化日志(便于日后实采真实 SDK 错误形状,不含用户输入) */
function pickErrorFields(err) {
  const out = {};
  if (!err) return out;
  ['code', 'errCode', 'errMsg', 'message', 'statusCode', 'status', 'requestId'].forEach((key) => {
    if (err[key] !== undefined) out[key] = err[key];
  });
  return out;
}

/**
 * 生成文本(一次性返回,不做流式——两个场景都是短文本)。
 * 内置重试:TIMEOUT / MODEL_ERROR 最多重试 2 次(总 3 次尝试,退避 1s/2s),AI_DISABLED 立即抛。
 * @param {Array<{role:string, content:string}>} messages 消息数组
 * @param {object} [opts] { model='hy3', timeoutMs=TIMEOUT_MS, totalMs=TOTAL_BUDGET_MS }
 * @returns {Promise<string>} 模型文本(choices[0].message.content)
 * @throws {Error} code: AI_DISABLED(开关关)/ TIMEOUT / MODEL_ERROR
 */
export async function generateText(messages, opts = {}) {
  const { model = 'hy3', timeoutMs = TIMEOUT_MS, totalMs = TOTAL_BUDGET_MS } = opts;

  // 开关闸门:总开关或生文开关任一关闭,直接拒绝(入口层 wx:if 也读同一配置,双保险)
  const cfg = await getAiConfig();
  if (!cfg.aiEnabled || !cfg.textEnabled) {
    const err = new Error('AI 功能未开启');
    err.code = 'AI_DISABLED';
    throw err;
  }

  const startAt = Date.now();

  /** 单次尝试:按错误三分类决定是否重试(递归推进,所有尝试共享 30s 总预算) */
  const attempt = async (n) => {
    const remaining = totalMs - (Date.now() - startAt);
    if (remaining <= 0) {
      const err = new Error('AI 响应超时,请稍后再试');
      err.code = 'TIMEOUT';
      throw err;
    }
    // 单次超时取调用方配置与剩余预算的较小值,保证 30s 总预算不被击穿
    const attemptTimeout = Math.min(timeoutMs, remaining);

    try {
      const call = (async () => {
        const aiModel = wx.cloud.extend.AI.createModel('cloudbase');
        const res = await aiModel.generateText({ model, messages });
        const text = res && res.choices && res.choices[0] && res.choices[0].message ? res.choices[0].message.content : '';
        if (!text) {
          const err = new Error('AI 未返回内容,请稍后再试');
          err.code = 'MODEL_ERROR';
          throw err;
        }
        // 用量静默上报:成功生成后记 token(fire-and-forget,失败不阻断)
        if (res && res.usage) reportTextUsage(res.usage).catch(() => {});
        return text;
      })();

      return await Promise.race([call, timeoutReject(attemptTimeout)]);
    } catch (err) {
      // 结构化错误日志:供日后实采真实错误形状(如 429),用户可见文案不变
      console.error('[ai/text] generateText 失败:', JSON.stringify(pickErrorFields(err)));
      if (err && err.code) {
        // 已分类错误:TIMEOUT / MODEL_ERROR 可重试;AI_DISABLED 立即抛
        if (!isRetryableError(err) || n >= MAX_ATTEMPTS) throw err;
      } else if (n >= MAX_ATTEMPTS) {
        // 云侧异常(含 invalid token timestamp 等工具劣化)统一收口为 MODEL_ERROR
        const wrapped = new Error('AI 暂时不可用,请稍后再试');
        wrapped.code = 'MODEL_ERROR';
        throw wrapped;
      }
      await sleep(retryDelay(n));
      return attempt(n + 1);
    }
  };

  return attempt(1);
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

/**
 * 流式生成文本(F30 #7:写做法等长输出先流式回显,提升感知速度)。
 * 基础库 ≥3.15.1 且生文能力支持时走 streamText 逐段回调;不支持/失败时退回一次性 generateText。
 * 超时:全程总时限 30s;8s 无新增量(idle)即 TIMEOUT。
 * 重试:仅限「尚未收到任何 chunk」时(TIMEOUT / MODEL_ERROR 可重试);一旦收到过增量,失败直接抛(避免重复文本)。
 * @param {Array<{role:string, content:string}>} messages 消息数组
 * @param {object} [opts] { model='hy3', onChunk(textDelta)=(), totalMs=STREAM_TOTAL_MS, idleMs=STREAM_IDLE_MS }
 * @returns {Promise<string>} 完整累积文本
 * @throws {Error} code: AI_DISABLED / TIMEOUT / MODEL_ERROR
 */
export async function streamText(messages, opts = {}) {
  const { model = 'hy3', onChunk, totalMs = STREAM_TOTAL_MS, idleMs = STREAM_IDLE_MS } = opts;

  // 开关闸门:与 generateText 同源双保险
  const cfg = await getAiConfig();
  if (!cfg.aiEnabled || !cfg.textEnabled) {
    const err = new Error('AI 功能未开启');
    err.code = 'AI_DISABLED';
    throw err;
  }

  const startAt = Date.now();
  // 是否已收到首个增量:收到后失败直接抛、不重试(避免重复文本);退回 generateText 的整段回调同理
  let started = false;

  /** 单次流式尝试:首 chunk 前 + 可重试分类才重试;收到增量后失败直接抛 */
  const attempt = async (n) => {
    const remaining = totalMs - (Date.now() - startAt);
    if (remaining <= 0) {
      const err = new Error('AI 响应超时,请稍后再试');
      err.code = 'TIMEOUT';
      throw err;
    }

    try {
      const aiModel = wx.cloud.extend.AI.createModel('cloudbase');
      let full = '';

      // 基础库不支持 streamText(<3.15.1)/能力差异时,优雅退回一次性 generateText(generateText 自带重试+超时)
      if (typeof aiModel.streamText !== 'function') {
        const text = await generateText(messages, opts);
        if (typeof onChunk === 'function') onChunk(text);
        return text;
      }

      // 首次流式请求(拿响应对象)本身也受总时限约束,防止流挂起 = 永久 loading
      const res = await Promise.race([
        aiModel.streamText({ data: { model, messages } }),
        timeoutReject(Math.min(totalMs, remaining)),
      ]);

      if (!(res && res.textStream)) {
        // streamText 存在但未返回 textStream(能力差异):同样退回一次性生成
        const text = await generateText(messages, opts);
        if (typeof onChunk === 'function') onChunk(text);
        return text;
      }

      // 逐段累积并回调;流式接口一般不返回 usage,按完成字数估算 completion tokens(中文≈1字1token),
      // promptTokens 未知计 0——仅供用量面板参考,非精确计费
      const iterator = res.textStream[Symbol.asyncIterator]();
      const deadlineAt = startAt + totalMs;
      const drain = async (it, total) => {
        // 全程总时限(从 streamText 进入时起算,重试窗口也计入)
        if (Date.now() > deadlineAt) {
          const err = new Error('AI 响应超时,请稍后再试');
          err.code = 'TIMEOUT';
          throw err;
        }
        let idleTimer = null;
        try {
          // 逐段取流;8s 无新增量(idle)= TIMEOUT。it.next() 挂起时由 idle 计时器先行使 race 结束,
          // 正常返回/超时/异常三条路径都能 clearTimeout,避免残留孤儿定时器
          const result = await Promise.race([
            it.next(),
            new Promise((resolve) => {
              idleTimer = setTimeout(() => resolve({ __idle: true }), idleMs);
            }),
          ]);
          if (result && result.__idle) {
            const err = new Error('AI 响应超时,请稍后再试');
            err.code = 'TIMEOUT';
            throw err;
          }
          const { value, done } = result;
          if (done) return total;
          if (!started) started = true;
          const next = total + value;
          if (typeof onChunk === 'function') onChunk(value);
          return drain(it, next);
        } finally {
          if (idleTimer) clearTimeout(idleTimer);
        }
      };

      full = await drain(iterator, '');
      if (!full.trim()) {
        const err = new Error('AI 未返回内容,请稍后再试');
        err.code = 'MODEL_ERROR';
        throw err;
      }

      if (res.usage) {
        reportTextUsage(res.usage).catch(() => {});
      } else {
        // 流式接口不返回 usage,只能以完成字数近似(不精确,仅供面板参考);total 同步计入避免面板 Token 恒为 0
        const est = Math.ceil(full.length);
        reportTextUsage({ completion_tokens: est, total_tokens: est }).catch(() => {});
      }
      return full;
    } catch (err) {
      console.error('[ai/text] streamText 失败:', JSON.stringify(pickErrorFields(err)));
      if (err && err.code) {
        // 首 chunk 前 + 可重试分类才重试;收到增量后直接抛,避免重复文本
        if (!started && isRetryableError(err) && n < MAX_ATTEMPTS) {
          await sleep(retryDelay(n));
          return attempt(n + 1);
        }
        throw err;
      }
      // 云侧异常收口为 MODEL_ERROR,同样只允许首 chunk 前重试
      const wrapped = new Error('AI 暂时不可用,请稍后再试');
      wrapped.code = 'MODEL_ERROR';
      if (!started && n < MAX_ATTEMPTS) {
        await sleep(retryDelay(n));
        return attempt(n + 1);
      }
      throw wrapped;
    }
  };

  return attempt(1);
}
