/**
 * OpenAI 兼容的翻译调用。
 *
 * 与插件侧 `whatsapp-plugin/src/server/services/translation.ts` 的 `openAiTranslate`
 * 保持同口径：同一个系统提示词、同一套提速参数。这样 CRM 里的翻译和浏览器里的
 * 翻译不会出现两套译风。
 *
 * ── 为什么「翻译慢」基本不是网络问题 ────────────────────────────────
 * 默认模型 `gpt-5.5` 属**推理型**：它在吐第一个字之前要先做一轮内部推理，而翻译
 * 这种轻任务根本不需要推理。预算经常被这轮推理吃光，用户看到的就是「翻译超时」。
 * 所以这里做三件事（按收益排序）：
 *
 *   1. 提示词明确禁止「先想想再答」并要求直接给译文 —— 对推理型模型能明显缩短思考；
 *   2. `reasoningEffort`：部分上游支持显式压低推理预算（默认不传，不支持的模型会 400，
 *      因此带了参数被 400 拒时会**自动去掉参数重试一次**）；
 *   3. 流式：好把「首字超时」和「整体超时」分开判。渲染层仍是一次性拿到完整译文，流式只用来自保。
 *
 * ⚠️ 但**别指望靠掐超时提速**：实测某中转站 9 个模型全是推理型，最快 8.0 秒、最慢 32.3 秒，
 * 曾把首字超时定成 8 秒 → 整条线路全军击穿。所以现在的姿态是「阈值放宽 + 让用户点选可用模型」，
 * 而不是「猜一个快模型的名字让用户填」——猜错过一次：让用户填了条线路上根本不存在的
 * gpt-4o-mini，每次请求秒回 404，用户看到的现象是「翻译完全没反应」。
 */

import { assertEndpointAllowed, normalizeEndpoint } from "./settings.js";

/**
 * 系统提示词。**与插件侧 translation.ts 逐字相同**（有副本一致性自检盯着）。
 *
 * ⚠️ 每一句都是踩坑换来的，别删：
 * - `Output the translation only … no original text` —— 少了它，部分模型会回
 *   「Here is the translation: …」，而这句会**原样出现在客户消息下面**。
 * - `Do not think step by step` —— 翻译不需要推理，省下的正是「超时」的那几十秒。
 * - 保住数字/型号/换行 —— 外贸场景里错一个字就是事故。
 */
export const TRANSLATOR_SYSTEM_PROMPT = [
  "You are a professional B2B trade translator. Translate the user's text into the target language.",
  "Output the translation only: no preamble, no explanation, no notes, no quotes, no original text.",
  "Do not think step by step, do not deliberate, do not restate the request. Translate directly.",
  "Keep names, numbers, currencies, dates, model numbers, URLs and line breaks exactly as they are, and keep the original tone."
].join("\n");

export function buildUserPrompt(text, sourceLang, targetLang) {
  const source = sourceLang ? ` from ${sourceLang}` : "";
  return `Translate${source} to ${targetLang}:\n\n${text}`;
}

function joinParts(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  return "";
}

/** OpenAI 兼容响应里取正文 —— 兼容 content 为分片数组的格式 */
export function pickContent(payload) {
  return joinParts(payload?.choices?.[0]?.message?.content).trim();
}

/** 流式分片里取增量正文 */
export function pickDelta(chunk) {
  return joinParts(chunk?.choices?.[0]?.delta?.content);
}

export function describeError(status, body) {
  const snippet = String(body || "").replace(/\s+/gu, " ").slice(0, 160);
  if (status === 401 || status === 403) return `API 密钥无效或无权限（${status}）${snippet ? `：${snippet}` : ""}`;
  if (status === 404) return `接口路径或模型名不对（404）${snippet ? `：${snippet}` : ""}`;
  if (status === 429) return "触发限流（429），稍后重试或换更便宜的模型";
  if (status >= 500) return `上游服务异常（${status}）${snippet ? `：${snippet}` : ""}`;
  return `翻译请求失败（${status}）${snippet ? `：${snippet}` : ""}`;
}

/**
 * 整体超时预算（毫秒）。首字到了之后会一直等到收完，所以这里比旧版宽松。
 * 30000 的依据见 settings.js::timeoutMs（实测同线路 8.0 ~ 32.3 秒）。
 */
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * 「首字超时」预算（毫秒）。到点还没吐第一个字 = 上游彻底没响应（不是"模型有点慢"）。
 *
 * ⚠️ 曾定成 8000，把整条线路 9 个模型全击穿（实测最快的也要 8.0 秒）。放宽到 20000。
 */
const DEFAULT_FIRST_TOKEN_MS = 20_000;

export function firstTokenMessage(firstTokenMs, model) {
  const seconds = Math.max(1, Math.round(firstTokenMs / 1000));
  return `等了 ${seconds} 秒，上游一个字都没返回 —— 模型「${model}」此刻没有响应（推理型模型长推理、或这条线路被挂住都会这样）。去设置页点「拉取模型清单」换一个试试。`;
}

/**
 * 超时错误的**机器可判据**。
 *
 * ⚠️ 千万别改回「靠错误文案判断」——踩过一次：
 * `background.js::translateWithRetry` 原本写的是 `message.includes("还没开始出译文")`
 * 来决定「首字超时要不要重试」，而文案一改（换成"上游一个字都没返回"），这个判断
 * **当场变成死代码**且不会报任何错。文案是给人看的，判据必须挂在错误对象上。
 */
export const FIRST_TOKEN_CODE = "first-token-timeout";
export const OVERALL_TIMEOUT_CODE = "overall-timeout";

/** 首字超时错误（带判据） */
function firstTokenError(firstTokenMs, model) {
  const error = new Error(firstTokenMessage(firstTokenMs, model));
  error.code = FIRST_TOKEN_CODE;
  return error;
}

/** 整体超时错误（带判据） */
function timeoutError(timeoutMs) {
  const error = new Error(`翻译超时（${Math.round(timeoutMs / 1000)} 秒）`);
  error.code = OVERALL_TIMEOUT_CODE;
  return error;
}

/**
 * SSE 逐块读，顺带在拿到第一个字时回调（用于取消首字超时定时器）。
 *
 * 有些上游会无视 `stream: true` 直接回一整段 JSON —— 那样这里读不到 `data:` 行，
 * 所以要兜底：最终没拼出内容时，把原始文本当普通响应再解析一次。
 */
async function readStream(response, onFirst) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let raw = "";
  let text = "";
  let usage = 0;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const piece = decoder.decode(chunk.value, { stream: true });
    raw += piece;
    buffer += piece;

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = pickDelta(parsed);
      if (delta) {
        text += delta;
        onFirst();
      }
      const total = parsed?.usage?.total_tokens;
      if (typeof total === "number" && total > 0) usage = total;
    }
  }

  if (!text.trim() && raw.trim()) {
    try {
      const payload = JSON.parse(raw);
      const fallback = pickContent(payload);
      if (fallback) return { text: fallback, usage: payload?.usage?.total_tokens ?? usage };
    } catch {
      /* 真的不是 JSON，交给上层报「没有返回译文内容」 */
    }
  }
  return { text: text.trim(), usage };
}

function buildBody({ model, input, stream, reasoningEffort, maxTokens, lean }) {
  const body = {
    model,
    messages: [
      { role: "system", content: TRANSLATOR_SYSTEM_PROMPT },
      { role: "user", content: buildUserPrompt(input.text, input.sourceLang, input.targetLang) }
    ]
  };
  // lean = 上次被 400 拒了，这次只留最小参数集
  if (!lean) {
    body.temperature = 0;
    if (maxTokens > 0) body.max_tokens = maxTokens;
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  }
  if (stream && !lean) body.stream = true;
  return body;
}

/**
 * @param {{ apiBase:string, apiKey:string, model:string, timeoutMs?:number, firstTokenMs?:number,
 *           stream?:boolean, reasoningEffort?:string, maxTokens?:number }} config
 * @param {{ text:string, sourceLang?:string, targetLang:string }} input
 * @param {{ fetchImpl?: typeof fetch }} [deps] 测试注入点
 */
export async function translateText(config, input, deps = {}) {
  const doFetch = deps.fetchImpl || fetch;
  const apiKey = String(config?.apiKey || "").trim();
  const model = String(config?.model || "").trim();
  if (!apiKey) throw new Error("还没有填 API Key（去扩展设置里填一次）");
  if (!model) throw new Error("还没有填模型名");
  // 最后防线：「a,b,c」这种一串是「对比测速」的候选清单，不是一个模型名。
  // 真发出去只会换回一个 404 model_not_found —— 在这里拦住，把话说清楚。
  if (/[，,]/u.test(model)) {
    throw new Error(`模型名不能是「${model}」这一串 —— 多个名字只用于对比测速，每次请求只带一个`);
  }

  // 先断言合法性（https / 本机回环），再做归一化 —— 保证不会被误导到明文远程端点
  assertEndpointAllowed(config.apiBase);
  const endpoint = normalizeEndpoint(config.apiBase);

  const timeoutMs = Number(config?.timeoutMs) > 0 ? Number(config.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const firstTokenMs = Number(config?.firstTokenMs) > 0 ? Number(config.firstTokenMs) : DEFAULT_FIRST_TOKEN_MS;
  const reasoningEffort = String(config?.reasoningEffort || "").trim();
  const maxTokens = Number(config?.maxTokens) > 0 ? Number(config.maxTokens) : 0;
  const stream = config?.stream !== false;

  async function request(lean) {
    const useStream = stream && !lean;
    const controller = new AbortController();
    let gotFirst = false;
    let hitFirstToken = false;
    let hitOverall = false;

    const overallTimer = setTimeout(() => {
      hitOverall = true;
      controller.abort();
    }, timeoutMs);
    // 首字超时只在流式下有意义：非流式根本看不到「第一个字」什么时候到
    const firstTimer = useStream
      ? setTimeout(() => {
          if (!gotFirst) {
            hitFirstToken = true;
            controller.abort();
          }
        }, firstTokenMs)
      : null;

    const startedAt = Date.now();

    try {
      let response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify(buildBody({ model, input, stream: useStream, reasoningEffort, maxTokens, lean })),
          signal: controller.signal
        });
      } catch (error) {
        if (hitFirstToken) throw firstTokenError(firstTokenMs, model);
        if (hitOverall) throw timeoutError(timeoutMs);
        if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw timeoutError(timeoutMs);
        }
        throw new Error(`连不上翻译接口：${error instanceof Error ? error.message : String(error)}`);
      }

      if (!response.ok) {
        const body = await safeText(response);
        const error = new Error(describeError(response.status, body));
        error.status = response.status;
        error.body = body;
        throw error;
      }

      let text = "";
      let tokenUsage = 0;
      let streamed = false;

      if (useStream && typeof response.body?.getReader === "function") {
        streamed = true;
        const consumed = await readStream(response, () => {
          gotFirst = true;
        });
        text = consumed.text;
        tokenUsage = consumed.usage;
      } else {
        const payload = await response.json().catch(() => null);
        text = pickContent(payload);
        tokenUsage = payload?.usage?.total_tokens ?? 0;
        gotFirst = true;
      }

      if (!text) throw new Error("模型没有返回译文内容");
      return {
        text,
        endpoint,
        model,
        tokenUsage,
        streamed,
        lean,
        totalMs: Date.now() - startedAt
      };
    } catch (error) {
      // 读流被打断时也走这里：把 abort 的两个原因翻译成人话
      if (hitFirstToken && !gotFirst) throw firstTokenError(firstTokenMs, model);
      if (hitOverall && !(error instanceof Error && error.status)) {
        throw timeoutError(timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(overallTimer);
      if (firstTimer) clearTimeout(firstTimer);
    }
  }

  try {
    return await request(false);
  } catch (error) {
    // 400 基本只可能是「这个模型不认某个可选参数」（temperature / reasoning_effort /
    // max_tokens / stream）。去掉它们再试一次，用户就不必自己去猜哪些参数能传。
    const canRetryLean =
      error && error.status === 400 && (reasoningEffort || maxTokens > 0 || stream);
    if (!canRetryLean) throw error;
    return await request(true);
  }
}

/**
 * 拉取这条线路上**真实可用**的模型清单。
 *
 * 为什么必须有它 —— 这是踩坑换来的：
 * 模型名一直是**用户手输**的，而不同中转站能用的模型差得极远（实测某站一共只有 9 个模型，
 * 且不含任何 gpt-4o-* 系列）。一旦填了个这条线路上不存在的名字，**每一次请求都秒回
 * 404 model_not_found**，界面上只显示「接口路径或模型名不对」—— 用户根本不知道自己错在哪，
 * 看到的现象就是「翻译完全没有反应」。
 *
 * 有了它，设置页就能「点一下列出清单、点一个填进去」，这类错误从根上消失。
 *
 * 注意：不少中转站的 /models 并不对外开放（返回 403/404），所以调用方要把这类失败
 * 与「Key 无效」分开说 —— 前者只是这条路走不通，不代表配置坏了。
 */
export async function listModels(config, deps = {}) {
  const doFetch = deps.fetchImpl || fetch;
  const apiKey = String(config?.apiKey || "").trim();
  if (!apiKey) throw new Error("还没有填 API Key（去扩展设置里填一次）");

  // 先断言合法性（https / 本机回环），再做归一化 —— 与翻译走同一套地址校验
  assertEndpointAllowed(config.apiBase);
  const listEndpoint = normalizeEndpoint(config.apiBase).replace(/\/chat\/completions$/u, "/models");

  const timeoutMs = Number(config?.timeoutMs) > 0 ? Number(config.timeoutMs) : 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    let response;
    try {
      response = await doFetch(listEndpoint, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: controller.signal
      });
    } catch (error) {
      if (error && (error.name === "AbortError" || error.name === "TimeoutError")) {
        throw new Error(`拉取模型清单超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }
      throw new Error(`连不上翻译接口：${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok) {
      const body = await safeText(response);
      const error = new Error(describeError(response.status, body));
      error.status = response.status;
      throw error;
    }

    const payload = await response.json().catch(() => null);
    const models = [
      ...new Set(
        (Array.isArray(payload?.data) ? payload.data : [])
          .map((row) => (typeof row?.id === "string" ? row.id.trim() : ""))
          .filter(Boolean)
      )
    ].sort((a, b) => a.localeCompare(b));
    if (!models.length) throw new Error("这个接口没返回任何模型名（多半是不开放 /models）");

    return { models, endpoint: listEndpoint, totalMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
