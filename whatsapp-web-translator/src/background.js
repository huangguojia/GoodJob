/**
 * MV3 service worker：唯一负责**发网络请求**的地方。
 *
 * 为什么网络必须在 background 而不是 content script：
 * MV3 起 content script 的 fetch 按页面源处理，从 web.whatsapp.com 直连翻译接口会被 CORS 拦。
 * background 是 chrome-extension:// 源，配合 host_permissions 不受页面 CORS 限制。
 *
 * 缓存也放这里（storage.local 持久化 + 内存 LRU）：
 * 换会话、刷新页面、重开标签都不会重复花钱翻译同一句话。
 */

import {
  CACHE_KEY,
  cacheKey,
  CRM_SESSION_KEY,
  detectLanguage,
  isConfigured,
  loadSettings,
  readCacheStore,
  saveSettings,
  SETTINGS_KEY,
  touchCache
} from "./settings.js";
import {
  composeFromCrm,
  importTrainingProfile,
  loginToCrm,
  readEngineStatus,
  readResourceStats,
  readSessionState,
  recordResourceFeedback,
  revealResource,
  searchResources,
  suggestForConversation
} from "./crm.js";
import { listModels, OVERALL_TIMEOUT_CODE, translateText } from "./provider.js";
import { fastTranslate, isFastBaseEnabled, probeFastBase } from "./fast-base.js";

const MAX_CONCURRENT = 3;

let cacheEntries = null;
let cachePersistTimer = null;
let persistInFlight = null;
let active = 0;
const waiting = [];
/**
 * 同一段文本的并发请求合并：只保留一个 promise。
 * 没有它的话，聊天里出现两条一模一样的消息（客户常连着发两遍）会各打一次上游 —— 白花钱。
 * 缓存只能挡住"前一次已经落库"的情况，挡不住同一批里的并发。
 */
const inflight = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await loadSettings();
  if (!isConfigured(settings)) chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // 设置变更后广播给所有页面，内容脚本据此启用/停用并重扫
  if (changes[SETTINGS_KEY]) {
    chrome.tabs.query({}, (tabs) => {
      for (const tab of tabs) {
        if (!tab.id) continue;
        chrome.tabs.sendMessage(tab.id, { type: "settingsChanged" }, () => void chrome.runtime.lastError);
      }
    });
  }
  if (changes[CACHE_KEY]) cacheEntries = null;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handle(message, sender)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function handle(message, sender) {
  const type = message?.type;
  if (type === "getSettings") return { ok: true, settings: await loadSettings() };
  if (type === "getVersion") {
    // 诊断单要报扩展版本（先排除"没重载就来说坏了"）。⚠️ getManifest 在内容脚本里不可用
    // （e2e 实测返回"未知"），所以由后台代取 —— 后台一定能拿到。
    return { ok: true, version: chrome.runtime.getManifest().version };
  }
  if (type === "status") return statusPayload();
  if (type === "clearCache") {
    cacheEntries = [];
    await chrome.storage.local.set({ [CACHE_KEY]: { entries: [] } });
    return { ok: true };
  }
  if (type === "testConnection") return testConnection(message);
  if (type === "listModels") return handleListModels(message);
  if (type === "probeFastBase") return handleProbeFastBase(message);
  if (type === "translate") return translate(message, sender);
  if (type === "setAutoReply") return setAutoReply(message);
  if (type === "updateSettings") return updateSettings(message);
  if (type === "crmLogin") return crmLogin(message);
  if (type === "crmLogout") return crmLogout();
  if (type === "crmStatus") return crmStatus(message);
  if (type === "crmCompose") return crmCompose(message);
  if (type === "crmSuggest") return crmSuggest(message);
  if (type === "crmResources") return crmResources(message);
  if (type === "crmReveal") return crmReveal(message);
  if (type === "crmFeedback") return crmFeedback(message);
  if (type === "crmTrainingImport") return crmTrainingImport(message);
  if (type === "crmResourceStats") return crmResourceStats(message);
  if (type === "openOptions") return openOptions();
  return { ok: false, error: `未知指令：${type}` };
}

/** 面板里「去设置页登录」用它。放在 background 是因为只有它能把 options 页顶到前台。 */
async function openOptions() {
  try {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/* ------------------------------------------------------------ CRM 通道 */

/**
 * CRM 会话令牌存在**独立**的 storage key 里，不混进设置对象 ——
 * 设置会被 options 页整块读写、也会进诊断输出，令牌不该出现在那些地方。
 */
async function readSession() {
  const raw = await chrome.storage.local.get(CRM_SESSION_KEY);
  return raw?.[CRM_SESSION_KEY] ?? null;
}

/** 登录。会顺手把两个地址与邮箱存下来，下次只要密码（用户自己决定要不要重填）。 */
async function crmLogin(message) {
  const settings = await saveSettings({ crm: message?.connection || {} });
  const result = await loginToCrm(settings, { email: message?.email, password: message?.password });
  if (!result.ok) return result;
  await chrome.storage.local.set({ [CRM_SESSION_KEY]: result.session });
  return { ok: true, session: readSessionState(result.session), crm: settings.crm };
}

async function crmLogout() {
  await chrome.storage.local.remove(CRM_SESSION_KEY);
  return { ok: true, session: readSessionState(null) };
}

async function crmStatus(message) {
  const settings = await loadSettings();
  const session = await readSession();
  const state = readSessionState(session);
  // 没登录就不去探插件了：那条请求必然 401，只会让状态栏多一条没用的红字。
  if (!state.loggedIn) return { ok: true, session: state, crm: settings.crm, engine: null };
  return { ok: true, session: state, crm: settings.crm, engine: await readEngineStatus(settings, session, { timeoutMs: message?.timeoutMs }) };
}

/**
 * 拿一段现场对话换一条草稿。
 *
 * ⚠️ 这一步可能要等几十秒（本机 CLI 真跑一次生成），而 MV3 的 service worker 默认会被回收。
 * 靠的是 `onMessage` 里 `return true` 把消息通道挂住 —— 只要还有没回的消息，
 * Chrome 就不会回收这个 worker。所以这里**不能**改成 fire-and-forget。
 */
async function crmCompose(message) {
  const settings = await loadSettings();
  const session = await readSession();
  return composeFromCrm(settings, session, message?.payload || {}, { timeoutMs: message?.timeoutMs });
}

/**
 * 「回复 + 资料一次给全」。右侧整列走这条。
 *
 * 和 `crmCompose` 一样**不能**改成 fire-and-forget：这条最长要等两三分钟（出回复 60s + 资料复排 60s
 * 并行），全靠 `onMessage` 里 `return true` 挂住消息通道来阻止 MV3 回收这个 worker。
 */
async function crmSuggest(message) {
  const settings = await loadSettings();
  const session = await readSession();
  return suggestForConversation(settings, session, message?.payload || {}, { timeoutMs: message?.timeoutMs });
}

/** 只要资料（快）。面板打开时先拿它把内容铺出来，不用等模型。 */
async function crmResources(message) {
  const settings = await loadSettings();
  const session = await readSession();
  return searchResources(settings, session, message?.payload || {}, { timeoutMs: message?.timeoutMs });
}

/** 取真实外链。**只由用户点击触发**，拿到就交给页面，绝不落 storage。 */
async function crmReveal(message) {
  const settings = await loadSettings();
  const session = await readSession();
  return revealResource(settings, session, message?.payload || {}, { timeoutMs: message?.timeoutMs });
}

/**
 * 上报采纳/忽略。**失败被吞掉，永远回 ok:true**。
 *
 * 埋点是旁路：它丢一次不影响任何功能，但让它把「复制链接」「发给客户了」这类用户动作
 * 变成一个红色报错就本末倒置了。
 */
async function crmFeedback(message) {
  const settings = await loadSettings();
  const session = await readSession();
  try {
    await recordResourceFeedback(settings, session, message?.payload || {}, { timeoutMs: message?.timeoutMs });
  } catch {
    /* 故意吞掉 */
  }
  return { ok: true };
}

/**
 * 把本地训练档案推送到插件。快（纯落库，不调模型），但同样走消息通道挂住，
 * 与其它 crm* 处理器保持同一形态，避免某条通道将来被「顺手优化」成 fire-and-forget。
 */
async function crmTrainingImport(message) {
  const settings = await loadSettings();
  const session = await readSession();
  return importTrainingProfile(settings, session, message?.payload || {}, { timeoutMs: message?.timeoutMs });
}

/** 读推荐效果报表（设置页「资料推荐效果」卡片用，只读）。 */
async function crmResourceStats(message) {
  const settings = await loadSettings();
  const session = await readSession();
  return readResourceStats(settings, session, message?.payload || {}, { timeoutMs: message?.timeoutMs });
}

/**
 * 改自动回复开关。放在 background 而不是让页面直接写 storage：
 * 写进去之后 `storage.onChanged` 会把 `settingsChanged` 广播给**所有** WhatsApp 标签页，
 * 多开的窗口才不会各用各的旧设置。
 */
async function setAutoReply(message) {
  const next = await saveSettings({ autoReply: message?.patch || {} });
  return { ok: true, autoReply: next.autoReply };
}

/**
 * 改顶层设置（目前是翻译引擎 engineMode，来自 GJ 面板的引擎三选一）。
 * 与 setAutoReply 同理：写 storage，`storage.onChanged` 会把 `settingsChanged`
 * 广播给所有 WhatsApp 标签页，多开的窗口不会各用各的旧设置。
 */
async function updateSettings(message) {
  const patch = message?.patch && typeof message.patch === "object" ? message.patch : {};
  const next = await saveSettings(patch);
  return { ok: true, settings: next };
}

async function statusPayload() {
  const settings = await loadSettings();
  return {
    ok: true,
    enabled: settings.enabled,
    configured: isConfigured(settings),
    model: settings.model,
    apiBase: settings.apiBase,
    targetLang: settings.targetLang,
    fastBase: settings.fastBase,
    lastFastBaseError,
    cacheSize: (await getCache()).length
  };
}

/**
 * 底座最近一次失败的原因。
 *
 * 底座失败是**静默降级**（用户看到的是"这次慢"，不是报错），所以必须留个地方能问出来，
 * 否则用户问"为什么有时候快有时候慢"我答不上来。
 */
let lastFastBaseError = "";

async function testConnection(message) {
  const settings = await loadSettings();
  const merged = { ...settings, ...(message?.draft || {}) };
  // ⚠️ 这里曾经硬压 `timeoutMs = min(settings.timeoutMs, 30000)`。
  // 后果是**测试报超时、真翻译却能成功**（实测有模型要 43~68 秒），
  // 用户据此把本来能用的模型判死 —— 又一个"假信号"。
  // 测试就该按真实预算跑，并把耗时报回去让人自己判断。
  if (!isConfigured(merged)) return { ok: false, error: "先填 API 地址、Key 和模型名" };
  try {
    const result = await translateText(merged, {
      text: "Could you confirm the lead time for the custom packaging?",
      sourceLang: "en",
      targetLang: "zh-CN"
    });
    // 把耗时一起带回去：用户判断「这个模型到底行不行」靠的就是这个数，而不是「成功」两个字
    return {
      ok: true,
      text: result.text,
      endpoint: result.endpoint,
      model: result.model,
      totalMs: result.totalMs,
      streamed: result.streamed,
      lean: result.lean
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 拉取这条线路的模型清单。
 *
 * 设置页靠它把「模型名」从**手输**变成**点选**。手输一个这条线路上不存在的模型会每次都
 * 404，而用户只看得到「接口路径或模型名不对」—— 真实可用的名字是什么，他无从得知。
 */
async function handleListModels(message) {
  const settings = await loadSettings();
  // 拉清单是轻请求，不该跟着翻译的整体超时一起等 30 秒
  const merged = { ...settings, ...(message?.draft || {}), timeoutMs: 15_000 };
  try {
    return { ok: true, ...(await listModels(merged)) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 设置页「测一次底座」用。与 `handleListModels` 同一套：可带表单里的草稿值，
 * 让用户**不必先保存**就能测出真实毫秒数。
 */
async function handleProbeFastBase(message) {
  const settings = { ...(await loadSettings()), ...(message?.draft || {}) };
  return { ok: true, ...(await probeFastBase(settings)) };
}

/**
 * 对「整体超时」自动重试一次。
 *
 * 超时几乎都是上游偶发（排队、连接被挂住），隔一次重试就回来了；而失败对用户的代价是
 * **这条客户消息永远空着**，代价不对称。只重试超时 —— Key 错 / 路径错 / 限流重试是白搭，
 * 只会让用户多等一轮。
 *
 * **首字超时不重试**：那说明这个模型本身在做长推理，重试还是它，白等一轮。
 * 草稿翻译（`message.quick`）同样不重试：用户正盯着浮框等，20 秒已经够久。
 */
async function translateWithRetry(settings, input) {
  try {
    return await translateText(settings, input);
  } catch (error) {
    // 判据挂在错误对象的 code 上，**不是文案** —— 文案是给人看的，改一次就会让
    // 基于 includes 的判断静默变成死代码（已经踩过一次，见 provider.js::FIRST_TOKEN_CODE）。
    // 只重试「整体超时」：首字超时说明这个模型/线路根本没响应，重试还是它，白等一轮。
    if (error?.code !== OVERALL_TIMEOUT_CODE) throw error;
    try {
      return await translateText(settings, input);
    } catch (again) {
      if (again?.code === OVERALL_TIMEOUT_CODE) {
        throw new Error(`${again.message}（已自动重试一次，上游一直没响应）`);
      }
      throw again;
    }
  }
}

/**
 * ── 两段式翻译 ────────────────────────────────────────────────────
 *
 *   第一段：免费底座（MyMemory）—— 实测 0.8~4.8 秒出初译，先给用户看；
 *   第二段：AI 精修 —— 后台照旧跑，回来了**原地替换**掉机译。
 *
 * 为什么不是「二选一」而是「两段」：两条路的优缺点正好互补。
 *   底座快但糙（实测把 `unidades` 译成"单位"、`adjunto el pedido` 译成"我正在附加订单"）；
 *   AI 准但慢（同一条线路上最快也要 10 秒，慢的 67 秒）。
 * 所以**先给快的那份、再用准的那份覆盖**：等待时间按底座算，最终质量按 AI 算。
 *
 * ⚠️ 初译**不写缓存**。写了的后果是：精修一旦失败（网络抖动、上游 5xx），
 * "机译"就被永久钉在这句话上 —— 用户以后每次翻回来看都是机译，且再没有机会变好。
 * 底座又快又免费，让它下次重跑一遍的代价，远小于"永久停在机译"。
 * 只有 AI 译文才进缓存。
 */
async function translate(message, sender) {
  const text = String(message?.text || "").trim();
  if (!text) return { ok: false, error: "没有可翻译的内容" };

  const settings = await loadSettings();
  if (!settings.enabled) return { ok: false, error: "翻译已关闭" };

  const targetLang = message?.targetLang || settings.targetLang;
  const sourceLang = message?.sourceLang || detectLanguage(text);
  const key = cacheKey(text, targetLang);

  const fastReady = isFastBaseEnabled(settings);
  const aiReady = isConfigured(settings);
  // 有底座就能翻译 —— 不必再逼用户先配 Key
  if (!fastReady && !aiReady) {
    return { ok: false, error: "还没配置翻译模型，点扩展图标 → 打开设置" };
  }
  // 引擎三选一（settings.js normalize 兜底过，这里再防一手）：
  //   hybrid = 机译打底 + AI 精修（默认）；mt = 只用机译；ai = 只用 AI。
  const mode = ["hybrid", "mt", "ai"].includes(settings.engineMode) ? settings.engineMode : "hybrid";

  const cached = findCached(await getCache(), key);
  if (cached) return { ok: true, text: cached, cached: true };

  const pending = inflight.get(key);
  if (pending) return pending;

  const token = message?.refineToken || null;
  const task = enqueue(async () => {
    const second = findCached(await getCache(), key);
    if (second) return { ok: true, text: second, cached: true };

    const input = { text, sourceLang, targetLang };

    if (fastReady && mode !== "ai") {
      try {
        const fast = await fastTranslate(settings, input);
        if (fast?.text) {
          // 只用机译（mode === "mt"）不安排 AI 精修 —— 用户关掉的那条路不许再偷偷跑。
          const willRefine = aiReady && mode === "hybrid";
          if (willRefine) void refineLater(settings, { input, key, token, tabId: sender?.tab?.id });
          return {
            ok: true,
            text: fast.text,
            tier: "mt",
            base: fast.base,
            totalMs: fast.totalMs,
            refineToken: token,
            // 只有 AI 确实可用时才承诺"精修中"，否则界面上会挂一个永远不来的状态
            refining: willRefine
          };
        }
      } catch (error) {
        // 底座失败**不是错误**：它的定位是锦上添花，AI 那条路照走。
        lastFastBaseError = error instanceof Error ? error.message : String(error);
      }
    }

    if (mode === "mt") {
      // 只用机译：AI 这条路是用户主动关的，底座失败就照实说，不悄悄改走 AI。
      return {
        ok: false,
        error: `机译底座没出译文（${lastFastBaseError || "未知原因"}）· 当前引擎「只用机译」，可在 GJ 面板切换`
      };
    }

    if (!aiReady) {
      return { ok: false, error: `快速底座没能出初译（${lastFastBaseError || "未知原因"}），而 AI 模型还没配置：点扩展图标 → 打开设置` };
    }

    try {
      const result = message?.quick ? await translateText(settings, input) : await translateWithRetry(settings, input);
      await putCache(key, result.text);
      return { ok: true, text: result.text, tier: "ai", model: result.model };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }).finally(() => inflight.delete(key));

  inflight.set(key, task);
  return task;
}

/**
 * 第二段：AI 精修。**故意不 await** —— 初译已经交给用户看了，
 * 精修什么时候回来就什么时候原地替换，回来不了也不影响任何东西。
 */
async function refineLater(settings, job) {
  try {
    const result = await translateText(settings, job.input);
    if (!result?.text) return;
    await putCache(job.key, result.text);
    notifyRefined(job.tabId, job.token, result.text);
  } catch {
    /* 精修失败就保留机译：这一层不该打扰用户，原因留给 lastFastBaseError 之外的静默处理 */
  }
}

/** 把精修结果推回发起翻译的那个页面。token 由页面生成，用来认领是「哪一条」消息。 */
function notifyRefined(tabId, token, text) {
  if (!tabId || !token) return;
  chrome.tabs.sendMessage(tabId, { type: "translateRefined", token, text }, () => void chrome.runtime.lastError);
}

/** 三个并发上限：一屏消息同时进来时不至于把上游打爆 */
function enqueue(task) {
  return new Promise((resolve, reject) => {
    const run = () => {
      active += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          const next = waiting.shift();
          if (next) next();
        });
    };
    if (active < MAX_CONCURRENT) run();
    else waiting.push(run);
  });
}

async function getCache() {
  if (cacheEntries) return cacheEntries;
  const raw = await chrome.storage.local.get(CACHE_KEY);
  cacheEntries = readCacheStore(raw?.[CACHE_KEY]);
  return cacheEntries;
}

function findCached(entries, key) {
  const hit = entries.find((entry) => entry[0] === key);
  return hit ? hit[1] : null;
}

async function putCache(key, value) {
  const entries = await getCache();
  cacheEntries = touchCache(entries, key, value);
  schedulePersist();
}

function schedulePersist() {
  if (cachePersistTimer) return;
  cachePersistTimer = setTimeout(() => {
    cachePersistTimer = null;
    void persistCache();
  }, 800);
}

async function persistCache() {
  if (persistInFlight) return persistInFlight;
  persistInFlight = chrome.storage.local
    .set({ [CACHE_KEY]: { entries: cacheEntries || [] } })
    .finally(() => {
      persistInFlight = null;
    });
  return persistInFlight;
}
