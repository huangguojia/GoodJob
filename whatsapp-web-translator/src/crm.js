/**
 * CRM 通道：拿 CRM 账号换一枚 Bearer，再用它调插件的「现场生成」接口。
 *
 * 为什么要走这两跳，而不是让扩展自己拼提示词：
 * 「有历史、有推理、有文档搜索」这三样都不在浏览器里 —— 客户往来历史在 CRM 库里、
 * 知识检索在 CRM 的 `/api/agent/knowledge/search`、推理是本机 WorkBuddy CLI 加载
 * `goodjob-auto-reply` 技能。扩展的职责只剩「把页面上这段对话读出来交上去，把草稿拿回来」。
 *
 * ⚠️ 这里的请求**必须**从 background（service worker）发出，不能从 content script 发：
 * content script 的 fetch 按页面源处理，从 `web.whatsapp.com` 直连 `127.0.0.1` 会被页面 CORS 拦；
 * background 是 `chrome-extension://` 源，配合 manifest 的 `host_permissions` 不受这道限制。
 * （localhost / 127.0.0.1 属 potentially-trustworthy，https 页面调它不算 mixed content。）
 */

import { assertEndpointAllowed } from "./settings.js";

const LOGIN_PATH = "/api/auth/login";
const COMPOSE_PATH = "/api/v1/auto-chat/compose";
const ENGINE_PATH = "/api/v1/auto-chat/engine";
/** 「回复 + 资料一次给全」。右侧整列只打这一个接口。 */
const SUGGEST_PATH = "/api/v1/auto-chat/suggest";
const RESOURCES_SEARCH_PATH = "/api/v1/resources/search";
const RESOURCES_REVEAL_PATH = "/api/v1/resources/reveal";
const RESOURCES_FEEDBACK_PATH = "/api/v1/resources/feedback";
/** 「归档并学习 → 推送到 CRM」：把本地训练档案送进插件（见 docs/TRAINING-UPLOAD-DESIGN.md）。 */
const TRAINING_IMPORT_PATH = "/api/v1/training/profiles/import";
/** 推荐效果报表（只读；docs/RESOURCE-FEEDBACK-REPORT-DESIGN.md）。 */
const RESOURCES_STATS_PATH = "/api/v1/resources/stats";

/** 现场对话最多带这么多条上去（与服务端的 `MAX_INLINE_CONTEXT_MESSAGES` 对齐）。 */
export const MAX_TRANSCRIPT_MESSAGES = 20;

/** 面板最多要几份资料。 */
export const RESOURCE_LIMIT = 5;

/** 去掉尾部斜杠并校验协议：http 只放行回环，与翻译端点同一套姿态。 */
export function baseUrlOf(raw, fallback = "") {
  const value = String(raw ?? "").trim() || fallback;
  if (!value) throw new Error("CRM 地址是空的");
  return assertEndpointAllowed(value).toString().replace(/\/+$/u, "");
}

/**
 * 从设置里取地址。
 *
 * ⚠️ 地址嵌在 `settings.crm` 下，不是顶层 —— 这里曾经写成 `settings.crmBaseUrl`，
 * 结果取到的永远是 undefined、永远回落到回环默认值：用户把 CRM 地址改成远端也毫无效果，
 * 而且**不报任何错**（回落是个合法地址）。取错层级的代价就是这样一声不响。
 */
function addressOf(settings, key, fallback) {
  return baseUrlOf(settings?.crm?.[key], fallback);
}

/** JWT 的过期时刻（毫秒）。解不出来就返回 null —— 只用于提示，不用于鉴权判断。 */
export function decodeJwtExpiry(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(parts[1].replace(/-/gu, "+").replace(/_/gu, "/")));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * 给界面看的会话状态。
 * 刻意**提前 5 分钟**判过期：等 401 回来才知道过期，用户已经点了按钮、白等一轮。
 */
export function readSessionState(session, now = Date.now()) {
  const token = String(session?.token ?? "");
  if (!token) return { loggedIn: false, email: "", expiresAt: null, expiresInMinutes: 0, expired: false };
  const expiresAt = decodeJwtExpiry(token);
  const expiresInMinutes = expiresAt ? Math.round((expiresAt - now) / 60_000) : 0;
  return {
    loggedIn: Boolean(expiresAt && expiresAt - now > 5 * 60_000),
    email: String(session?.email ?? ""),
    expiresAt,
    expiresInMinutes,
    expired: Boolean(expiresAt && expiresAt <= now)
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function failureOf(response, payload, what) {
  const detail = payload?.message || payload?.error || `HTTP ${response.status}`;
  // 401 单独标出来：这不是"坏了"，是"要重新登录一次"。
  return response.status === 401
    ? { ok: false, needsLogin: true, error: `${what}需要重新登录 CRM（${detail}）` }
    : { ok: false, error: `${what}失败：${detail}` };
}

/**
 * 用 CRM 账号换 Bearer。响应体里就带 `token`（CRM 的 `sendLoginSession` 同时下发 cookie 与 body），
 * 走 body 而不是 cookie：cookie 是 httpOnly + SameSite=strict，扩展拿不到也带不过去。
 */
export async function loginToCrm(settings, credentials, options = {}) {
  const email = String(credentials?.email ?? "").trim();
  const password = String(credentials?.password ?? "");
  if (!email || !password) return { ok: false, error: "CRM 邮箱和密码都要填" };
  let base;
  try {
    base = addressOf(settings, "crmBaseUrl", "http://127.0.0.1:4188");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const response = await fetch(`${base}${LOGIN_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000)
    });
    const payload = await readJson(response);
    if (!response.ok) return failureOf(response, payload, "登录 CRM");
    const token = String(payload?.token ?? "");
    if (!token) return { ok: false, error: "CRM 登录没有返回令牌（版本可能不匹配）" };
    return {
      ok: true,
      session: {
        token,
        email,
        userId: String(payload?.user?.id ?? ""),
        userName: String(payload?.user?.name ?? ""),
        at: new Date(options.now ?? Date.now()).toISOString()
      }
    };
  } catch (error) {
    return { ok: false, error: `连不上 CRM（${base}）：${error instanceof Error ? error.message : String(error)}` };
  }
}

/* --------------------------------------------------- 资源中心（资料推荐） */

/**
 * 插件侧的统一出入口。**只有这一处拼 URL 与 Bearer**。
 *
 * 抽出来的理由很具体：新增的四个接口（suggest / search / reveal / feedback）各写一遍 fetch，
 * 早晚会在「超时多少」「401 怎么标」「body 什么时候不传」上分叉 —— 而分叉出来的表现是
 * 「某一条通道在令牌过期后不提示重新登录」这种极难发现的 bug。
 */
async function pluginJson(settings, session, path, { method = "POST", body, timeoutMs, what = "请求插件" } = {}) {
  const token = String(session?.token ?? "");
  if (!token) return { ok: false, needsLogin: true, error: "还没登录 CRM" };
  let base;
  try {
    base = addressOf(settings, "pluginBaseUrl", "http://127.0.0.1:3100");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs ?? 120_000)
    });
    const payload = await readJson(response);
    if (!response.ok) return failureOf(response, payload, what);
    return { ok: true, result: payload };
  } catch (error) {
    return { ok: false, error: `连不上插件（${base}）：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 转写归一。**超限在这里截断**，而不是指望服务端兜 —— 少传一条比让服务端 400 好，
 * 用户至少还能拿到草稿。
 */
export function normalizeTranscript(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      direction: message?.direction === "outbound" ? "outbound" : "inbound",
      body: String(message?.body ?? "").slice(0, 4_000),
      occurredAt: String(message?.occurredAt ?? "")
    }))
    .filter((message) => message.body.trim())
    .slice(-MAX_TRANSCRIPT_MESSAGES);
}

function contactOf(payload) {
  return {
    phone: String(payload?.contact?.phone ?? "").slice(0, 32),
    name: String(payload?.contact?.name ?? "").slice(0, 180)
  };
}

/**
 * 「回复 + 资料一次给全」。
 *
 * ⚠️ 这个函数里**永远不许出现任何发送动作**。它的产物只有两种用途：渲染在右侧那一列里、
 * 或者被用户手动填进输入框 —— 按回车的人始终是用户。`tests/parity.test.mjs` 盯着这一条。
 */
export async function suggestForConversation(settings, session, payload, options = {}) {
  const messages = normalizeTranscript(payload?.messages);
  if (!messages.length) return { ok: false, error: "当前会话里没有可用的消息" };
  return pluginJson(settings, session, SUGGEST_PATH, {
    body: {
      messages,
      contact: contactOf(payload),
      conversationKey: String(payload?.conversationKey ?? "").slice(0, 200),
      customerId: String(payload?.customerId ?? "").slice(0, 64),
      limit: RESOURCE_LIMIT,
      ...(payload?.engine ? { engine: payload.engine } : {}),
      ...(payload?.model ? { model: payload.model } : {}),
      ...(payload?.effort ? { effort: payload.effort } : {}),
      ...(payload?.withAi === false ? { withAi: false } : {})
    },
    // 两件事并行做（出回复 60s + 资料复排 60s），所以给到 180 秒。
    timeoutMs: options.timeoutMs ?? 180_000,
    what: "推荐回复与资料"
  });
}

/** 只要资料（快，不调模型）。没给 messages 时是目录式检索。 */
export async function searchResources(settings, session, payload, options = {}) {
  const messages = normalizeTranscript(payload?.messages);
  const query = String(payload?.q ?? "").trim();
  if (!messages.length && !query) return { ok: false, error: "没有可检索的内容" };
  return pluginJson(settings, session, RESOURCES_SEARCH_PATH, {
    body: {
      ...(messages.length ? { messages } : { q: query.slice(0, 200) }),
      contact: contactOf(payload),
      conversationKey: String(payload?.conversationKey ?? "").slice(0, 200),
      limit: RESOURCE_LIMIT,
      ...(payload?.sourceTypes ? { sourceTypes: payload.sourceTypes } : {})
    },
    timeoutMs: options.timeoutMs ?? 20_000,
    what: "检索资料"
  });
}

/**
 * 取真实外链 / 内联正文。**整个系统里唯一一次把外链交出去的地方**，而且只在用户真的点了
 * 「复制链接 / 打开」时才调用 —— 不预取、不缓存、不写进 DOM。插件侧也刻意不缓存。
 */
export async function revealResource(settings, session, payload, options = {}) {
  const sourceType = String(payload?.sourceType ?? "").trim();
  const id = String(payload?.id ?? "").trim();
  if (!sourceType || !id) return { ok: false, error: "缺少资料标识" };
  return pluginJson(settings, session, RESOURCES_REVEAL_PATH, {
    body: {
      sourceType,
      id: id.slice(0, 120),
      reason: String(payload?.reason ?? "manual").slice(0, 200),
      conversationKey: String(payload?.conversationKey ?? "").slice(0, 200)
    },
    timeoutMs: options.timeoutMs ?? 15_000,
    what: "取资料链接"
  });
}

/** 采纳/忽略埋点。**旁路**：失败就算了，绝不允许它把「复制链接」这个动作卡住。 */
export async function recordResourceFeedback(settings, session, payload, options = {}) {
  const items = (Array.isArray(payload?.items) ? payload.items : [])
    .map((item) => ({
      resourceId: String(item?.resourceId ?? "").slice(0, 120),
      sourceType: String(item?.sourceType ?? "").trim(),
      action: item?.action === "dismissed" ? "dismissed" : item?.action === "sent" ? "sent" : "accepted"
    }))
    .filter((item) => item.resourceId && item.sourceType)
    .slice(0, 20);
  if (!items.length) return { ok: false, error: "没有可上报的条目" };
  return pluginJson(settings, session, RESOURCES_FEEDBACK_PATH, {
    body: { items, conversationKey: String(payload?.conversationKey ?? "").slice(0, 200) },
    timeoutMs: options.timeoutMs ?? 10_000,
    what: "上报资料反馈"
  });
}

/** 只用来把「插件在不在、CLI 可用不可用、装了哪个技能」显示给用户看。 */
export async function readEngineStatus(settings, session, options = {}) {
  let base;
  try {
    base = addressOf(settings, "pluginBaseUrl", "http://127.0.0.1:3100");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    const response = await fetch(`${base}${ENGINE_PATH}`, {
      headers: { authorization: `Bearer ${String(session?.token ?? "")}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000)
    });
    const payload = await readJson(response);
    if (!response.ok) return failureOf(response, payload, "读取插件引擎状态");
    return { ok: true, engine: payload };
  } catch (error) {
    return { ok: false, error: `连不上插件（${base}）：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 把本地训练档案推送到插件（「归档并学习」之后的第二步）。
 *
 * 送出去的只有**提炼后的档案**（风格 + 问答样本 + 护栏），不是会话原文 —— 体量小、隐私面小。
 * 服务端按内容指纹幂等：同一条语料反复点推送也只落一份。
 * 失败绝不影响本地学习结果（调用方只把它当「可选的同步动作」）。
 */
export async function importTrainingProfile(settings, session, payload, options = {}) {
  const examples = (Array.isArray(payload?.examples) ? payload.examples : [])
    .map((example) => ({
      inbound: String(example?.inbound ?? "").trim().slice(0, 2_000),
      reply: String(example?.reply ?? "").trim().slice(0, 2_000),
      ...(example?.occurredAt ? { occurredAt: String(example.occurredAt).slice(0, 40) } : {}),
      ...(example?.conversationId ? { conversationId: String(example.conversationId).slice(0, 120) } : {}),
      ...(Number.isFinite(example?.score) ? { score: Math.max(0, Math.min(1, Number(example.score))) } : {})
    }))
    .filter((example) => example.inbound && example.reply)
    .slice(0, 200);
  if (!examples.length) return { ok: false, error: "训练档案里没有可推送的问答样本" };
  const strings = (value, max, limit) =>
    (Array.isArray(value) ? value : [])
      .map((item) => String(item ?? "").trim().slice(0, max))
      .filter(Boolean)
      .slice(0, limit);
  return pluginJson(settings, session, TRAINING_IMPORT_PATH, {
    body: {
      name: String(payload?.name ?? "").trim().slice(0, 120) || "Web 会话档案",
      ...(payload?.tone ? { tone: String(payload.tone).slice(0, 80) } : {}),
      ...(payload?.summary ? { summary: String(payload.summary).slice(0, 1_200) } : {}),
      ...(payload?.guidelines?.length ? { guidelines: strings(payload.guidelines, 300, 12) } : {}),
      ...(payload?.signaturePhrases?.length ? { signaturePhrases: strings(payload.signaturePhrases, 120, 12) } : {}),
      ...(payload?.guardrails?.length ? { guardrails: strings(payload.guardrails, 300, 12) } : {}),
      ...(payload?.languages?.length ? { languages: strings(payload.languages, 16, 8) } : {}),
      examples,
      ...(payload?.stats ? { stats: payload.stats } : {}),
      ...(payload?.source ? { source: payload.source } : {})
    },
    timeoutMs: options.timeoutMs ?? 20_000,
    what: "推送训练档案"
  });
}

/**
 * 读推荐效果报表（只读）。设置页的「资料推荐效果」卡片用。
 * days ∈ [1,90]，默认 30 —— 夹取在扩展与服务端各做一次，谁先到都安全。
 */
export async function readResourceStats(settings, session, payload = {}, options = {}) {
  const parsed = Number.parseInt(String(payload?.days ?? 30), 10);
  const days = Math.min(90, Math.max(1, Number.isFinite(parsed) ? parsed : 30));
  return pluginJson(settings, session, `${RESOURCES_STATS_PATH}?days=${days}`, {
    method: "GET",
    timeoutMs: options.timeoutMs ?? 15_000,
    what: "读取推荐效果"
  });
}

/**
 * 拿一段现场对话换一条草稿。
 *
 * 入参只收已经归一过的转写；超出上限的在**这里**截断，而不是指望服务端兜 —— 少传一条
 * 比让服务端 400 好，用户至少能拿到草稿。
 */
export async function composeFromCrm(settings, session, payload, options = {}) {
  const messages = normalizeTranscript(payload?.messages);
  if (!messages.length) return { ok: false, error: "当前会话里没有可用的消息" };
  return pluginJson(settings, session, COMPOSE_PATH, {
    body: {
      messages,
      contact: contactOf(payload),
      ...(payload?.engine ? { engine: payload.engine } : {}),
      ...(payload?.model ? { model: payload.model } : {}),
      ...(payload?.effort ? { effort: payload.effort } : {})
    },
    // CLI 一次生成实测几十秒；这里给足，但不无限等 —— 卡住时用户要能立刻看到失败。
    timeoutMs: options.timeoutMs ?? 120_000,
    what: "生成回复"
  });
}

/**
 * 把插件返回的引擎状态写成一句人话。
 *
 * 「CLI 能跑」和「回复技能装上了」必须**分开说**：技能目录没被扫到时插件是**静默降档**到
 * 话术库的（照样出稿、照样不报错），不点破的话用户只会觉得"模型变笨了"，根本查不到原因。
 */
export function describeEngine(engine) {
  if (!engine) return { state: "unknown", text: "插件状态未检测" };
  if (!engine.ok) return { state: "err", text: engine.error || "插件探测失败" };
  const info = engine.engine || {};
  if (!info.available) return { state: "warn", text: `本机 CLI 不可用：${info.reason || "探测未通过"}` };
  const base = `本机 CLI 可用（${info.version || "版本未知"}）· 默认模型 ${info.defaultModel || "未知"}`;
  const skills = Array.isArray(info.skills) ? info.skills : [];
  // 两个技能分开说：它们各自决定一条能力。合成一句「技能已装」的话，
  // 只装了其中一个时用户会以为两条都好 —— 而实际表现是"回复像模像样，挑资料却像瞎选"。
  const replySkill = String(info.autoReplySkill ?? "");
  const scoutSkill = String(info.resourceScoutSkill ?? "");
  const missing = [
    replySkill && !skills.includes(replySkill) ? `回复技能 ${replySkill}` : "",
    scoutSkill && !skills.includes(scoutSkill) ? `资料技能 ${scoutSkill}` : ""
  ].filter(Boolean);
  return missing.length
    ? { state: "warn", text: `${base} · ${missing.join(" / ")} 没扫到（对应能力会降档）` }
    : { state: "ok", text: `${base} · 技能 ${[replySkill, scoutSkill].filter(Boolean).join(" / ")} 已装上` };
}

/**
 * 把结果里的「依据」写成一句人话。**这是这条链路唯一能被用户验证的地方** ——
 * 没有它，「智能回复」和瞎编在用户眼里没有任何区别。
 */
export function describeEvidence(evidence) {
  if (!evidence) return "依据：无（本次没有训练档案/训练库/CRM 上下文）";
  const parts = [];
  if (evidence.profile) parts.push(`训练档案「${evidence.profile.name}」${evidence.profile.examples} 组问答`);
  if (evidence.library) {
    const library = evidence.library;
    parts.push(`训练库命中 ${library.qa} 条（口径 ${library.snippets} / 政策 ${library.policies} / 禁用 ${library.forbidden}）`);
  }
  const crm = evidence.crm;
  if (crm) {
    if (crm.matchedBy === "none") {
      parts.push("CRM 未匹配到客户档案");
    } else {
      parts.push(
        `CRM 客户「${crm.customer || "未命名"}」（${crm.matchedBy === "phone" ? "按号码" : "按名字"}匹配，跟进 ${crm.followUps} 条 / 报价 ${crm.quotes} 条）`
      );
    }
    if (crm.knowledge?.length) parts.push(`知识命中：${crm.knowledge.map((item) => item.title).join("、")}`);
    if (crm.errors?.length) parts.push(`未取到：${crm.errors.join("；")}`);
  }
  return parts.length ? `依据：${parts.join(" · ")}` : "依据：无";
}
