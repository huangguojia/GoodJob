/**
 * 免费机器翻译底座 —— 两段式翻译的**第一段**：秒出初译。
 *
 * ── 为什么必须引入它（本轮实测结论）─────────────────────────────────
 * AI 那条中转线路（`api.52token.org/v1`）**不存在快模型**。2026-10-12 同一句西语外贸问句
 * 流式实测（看首字到得多快）：
 *
 *   | 模型 | 首字 | 总耗时 | prompt_tokens |
 *   |---|---|---|---|
 *   | `gpt-5.6-sol`（最快） | 10.3 / 20.0 秒 | 10.6 / 43.0 秒 | 3613 |
 *   | `gpt-6.1-sol` | 65.8 / 17.8 秒 | 66.1 / 18.4 秒 | 4273 |
 *   | `gpt-5.5`（曾作默认） | 32.7 / 66.4 秒 | 34.6 / 67.9 秒 | 4437 |
 *
 * 两个关键事实：
 *   1. **同一个模型连跑两次能差 3 倍**（10.3 秒 vs 20.0 秒）—— 这是排队，不是模型慢；
 *   2. `prompt_tokens` 恒在 3600~4400，而原文+提示词本身不到 100 token → **上游每个请求
 *      都强塞了一大段隐藏前缀**。掐超时、换模型、改提示词都治不了这个病。
 *
 * 所以「让译文更快出现」的唯一有效手段是：**第一眼要看到的那句话，不走 AI。**
 *
 * ── 别指望谷歌 ────────────────────────────────────────────────
 * 「接个谷歌免费接口」是最自然的想法，但在本机网络下**走不通**（实测）：
 * `translate.googleapis.com` 12 秒超时（被墙）；`libretranslate.com` 403；
 * `api-free.deepl.com` 403。真正可达且**不需要 Key** 的只有 MyMemory：
 * 长句 960~1804 毫秒、短句最快 829 毫秒 —— 比 AI 快一到两个数量级。
 *
 * ⚠️ 联网行为（必须明说）：打开 `fastBase` 意味着**客户消息正文会发给第三方机器翻译服务**。
 * 这是拿隐私换速度的取舍，所以它是个可以在设置页一键关掉的开关，而不是硬编码行为。
 */

/** 底座的机器可判据 —— 与 provider.js 同一约定：判据挂 code，不挂文案 */
export const FAST_BASE_TIMEOUT_CODE = "fast-base-timeout";
export const FAST_BASE_QUOTA_CODE = "fast-base-quota";

export const FAST_BASE_MYMEMORY = "mymemory";

/** 设置页下拉用。`off` 必须排第一：它是"退回原行为"的安全出口。 */
export const FAST_BASES = [
  { id: "off", label: "关闭（只用 AI）", hint: "不把消息发给第三方，但译文要等 AI（实测 10~70 秒）" },
  {
    id: "mymemory",
    label: "MyMemory（免费·无需 Key）",
    // 2026-10-12 实测：英/西/德/法 六条外贸问句，6/6 成功，0.8~3.4 秒。
    hint: "实测 0.8~3.4 秒出初译，随后 AI 精修覆盖"
  }
];

/** MyMemory 的官方接口。`langpair` 是它唯一要求的参数，格式 `源|目标`。 */
const DEFAULT_MYMEMORY_URL = "https://api.mymemory.translated.net/get";

/**
 * 每次请求的正文上限。匿名额度按**字节**算，超过会被拒（返回一段警告文本而不是译文）。
 * 取 450 留足余量 —— WhatsApp 的长消息很常见，所以下面必须**分片**而不是直接放弃。
 */
const MAX_CHUNK = 450;

/** 分片后的片数上限。超过就说明这不是「消息」而是「文件」，交给 AI 那条路。 */
const MAX_CHUNKS = 8;

export function isFastBaseEnabled(settings) {
  const id = String(settings?.fastBase || "").trim();
  return Boolean(id) && id !== "off";
}

export function fastBaseLabel(id) {
  return FAST_BASES.find((base) => base.id === id)?.label || id || "";
}

export function fastBaseEndpoint(settings) {
  const id = String(settings?.fastBase || "").trim();
  const configured = String(settings?.fastBaseUrl || "").trim();
  if (configured) return configured;
  if (id === FAST_BASE_MYMEMORY) return DEFAULT_MYMEMORY_URL;
  return "";
}

/**
 * 我们内部的语言码 → 底座认的写法。
 *
 * 内部统一用 `normalizeLanguage` 那种短码（`zh` / `en` / `es`），而 MyMemory 对中文
 * 认 `zh-CN`（只给 `zh` 会落到繁体）。其余语种短码通用，不必额外映射。
 */
export function toBaseLang(language) {
  const short = String(language || "").toLowerCase().replace(/_/gu, "-").split("-")[0];
  if (!short) return "";
  if (short === "zh") return "zh-CN";
  return short;
}

/**
 * 按字节预算分片，**尽量落在换行与句号上** —— 外贸消息里换行分隔的常是并列的几条要求，
 * 切在换行上能保证每片的语义完整，机译质量明显更好，也能原样保住换行。
 */
export function splitForBase(text) {
  const source = String(text || "");
  const chunks = [];
  let buffer = "";

  const push = () => {
    const trimmed = buffer.trim();
    if (trimmed) chunks.push(trimmed);
    buffer = "";
  };

  for (const line of source.split(/\r?\n/u)) {
    // 单行本身超限：再按句子切，句子还超就硬切
    const pieces = line.length > MAX_CHUNK ? splitLine(line) : [line];
    for (const piece of pieces) {
      if (!buffer) {
        buffer = piece;
      } else if (buffer.length + 1 + piece.length <= MAX_CHUNK) {
        buffer = `${buffer}\n${piece}`;
      } else {
        push();
        buffer = piece;
      }
    }
    // ⚠️ 这里**刻意不 push**：短行必须攒在一起发一次。
    // 每条消息一个请求的话，五行消息 = 5 次往返（约 5 秒），"秒出初译"就白做了。
  }
  push();
  return chunks;
}

function splitLine(line) {
  const out = [];
  let rest = line;
  while (rest.length > MAX_CHUNK) {
    // 优先在句末切（. ! ? … ；。！？），找不到就硬切
    const window = rest.slice(0, MAX_CHUNK);
    const at = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("; "),
      window.lastIndexOf("。"),
      window.lastIndexOf("；")
    );
    const cut = at > MAX_CHUNK * 0.5 ? at + 1 : MAX_CHUNK;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * MyMemory 在出错时**不一定改 HTTP 状态码** —— 它常常是 200，然后把一句英文警告
 * 塞进 `responseData.translatedText` 里。如果只看 HTTP 状态，那句警告会**原样显示在
 * 客户消息下面**。所以这里逐个判据都要过。
 */
export function pickFastTranslation(payload, originalText = "") {
  const status = Number(payload?.responseStatus);
  const details = String(payload?.responseDetails || "");
  const text = decodeEntities(String(payload?.responseData?.translatedText || "")).trim();

  if (payload?.quotaFinished || /ALL AVAILABLE FREE TRANSLATIONS|QUOTA/i.test(details)) {
    const error = new Error("MyMemory 今日免费额度已用完（可在设置页填邮箱把额度提到 10 倍）");
    error.code = FAST_BASE_QUOTA_CODE;
    throw error;
  }
  if (status && status !== 200) throw new Error(details.slice(0, 120) || `底座返回 ${status}`);
  if (!text) throw new Error("底座没有返回译文");
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE PAIR|NO QUERY SPECIFIED/i.test(text)) {
    throw new Error(text.slice(0, 120));
  }
  // 原样回吐原文 = 它没接这个语向。**别拿来当译文显示**，宁可判失败让 AI 接管。
  // 只在原文足够长时判定：`FOB?` 这种短词本来就该原样保留。
  if (originalText.trim().length >= 12 && normalize(text) === normalize(originalText)) {
    throw new Error("底座没有真正翻译（原样返回了原文）");
  }
  return text;
}

/** 极少数常见实体（MyMemory 会回 `&amp;` `&#39;` 这类）；不引第三方库 */
export function decodeEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value || "")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/giu, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/giu, (whole, name) => named[String(name).toLowerCase()] ?? whole);
}

function normalize(value) {
  return String(value || "").replace(/\s+/gu, " ").trim().toLowerCase();
}

function buildUrl(endpoint, { text, sourceLang, targetLang, email }) {
  const url = new URL(endpoint);
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", `${toBaseLang(sourceLang)}|${toBaseLang(targetLang)}`);
  if (email) url.searchParams.set("de", email);
  return url.toString();
}

/**
 * 跑一次底座翻译。**任何失败都抛错**，由调用方决定是「回退到 AI」还是「报给用户」——
 * 这一层不做降级决策，只提供事实。
 *
 * @param {{ fastBase?:string, fastBaseUrl?:string, fastBaseEmail?:string, fastBaseTimeoutMs?:number }} settings
 * @param {{ text:string, sourceLang?:string, targetLang:string }} input
 * @param {{ fetchImpl?: typeof fetch }} [deps] 测试注入点（e2e 靠它把请求打到本地 mock）
 */
export async function fastTranslate(settings, input, deps = {}) {
  const doFetch = deps.fetchImpl || fetch;
  const endpoint = fastBaseEndpoint(settings);
  if (!endpoint) throw new Error("没有配置快速底座的地址");

  const targetLang = String(input?.targetLang || "").trim();
  const sourceLang = String(input?.sourceLang || "").trim();
  if (!targetLang) throw new Error("没有目标语言");

  const chunks = splitForBase(input?.text);
  if (!chunks.length) throw new Error("没有可翻译的内容");
  if (chunks.length > MAX_CHUNKS) throw new Error("内容太长，交给 AI 处理");

  const timeoutMs = Number(settings?.fastBaseTimeoutMs) > 0 ? Number(settings.fastBaseTimeoutMs) : 6000;
  const email = String(settings?.fastBaseEmail || "").trim();
  const startedAt = Date.now();

  const parts = [];
  for (const chunk of chunks) {
    parts.push(await once(doFetch, endpoint, { chunk, sourceLang, targetLang, email, timeoutMs }));
  }

  return {
    text: parts.join("\n").trim(),
    base: String(settings?.fastBase || FAST_BASE_MYMEMORY),
    endpoint,
    totalMs: Date.now() - startedAt
  };
}

async function once(doFetch, endpoint, { chunk, sourceLang, targetLang, email, timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response;
    try {
      response = await doFetch(buildUrl(endpoint, { text: chunk, sourceLang, targetLang, email }), {
        method: "GET",
        signal: controller.signal
      });
    } catch (error) {
      if (timedOut) {
        const timeout = new Error(`快速底座超过 ${Math.round(timeoutMs / 1000)} 秒没回应`);
        timeout.code = FAST_BASE_TIMEOUT_CODE;
        throw timeout;
      }
      // 主动取消（页面关闭等）不该被当成"底座坏了"
      throw new Error(`连不上快速底座：${error instanceof Error ? error.message : String(error)}`);
    }
    // 底座出错时也常带 200，所以状态码只用来挡明确的服务端错误，不做唯一判据
    if (response.status >= 500) throw new Error(`快速底座服务异常（${response.status}）`);
    const payload = await response.json().catch(() => null);
    return pickFastTranslation(payload, chunk);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 设置页「测一次」用：只翻一句固定短句，报真实毫秒数。
 * 与 `fastTranslate` 走同一条代码路径 —— 免得"测的时候好好的、真用起来不一样"。
 */
export async function probeFastBase(settings, deps = {}) {
  const sample = "Hola, nos interesan 500 unidades. Podrían compartir el precio FOB?";
  const startedAt = Date.now();
  try {
    const result = await fastTranslate(settings, { text: sample, sourceLang: "es", targetLang: "zh-CN" }, deps);
    return { ok: true, totalMs: result.totalMs, text: result.text, base: result.base };
  } catch (error) {
    return {
      ok: false,
      totalMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code || null
    };
  }
}
