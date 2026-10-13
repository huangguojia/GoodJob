/**
 * 设置、语言判定、缓存键与端点归一化。
 *
 * 这一层被 background / options / popup 共用，必须保持**无副作用**：
 * 不 import chrome.* 之外的东西，不发起请求。
 */

export const SETTINGS_KEY = "gj_translator_settings";
export const CACHE_KEY = "gj_translator_cache";
export const CACHE_LIMIT = 800;
/**
 * CRM 会话（Bearer token）。**与设置分开存**：
 * 令牌是密钥，不该跟着设置对象一起被渲染进设置页、也不该出现在任何诊断输出里。
 * 密码一个字节都不存 —— 只在点「登录」那一刻用一次。
 */
export const CRM_SESSION_KEY = "gj_crm_session";
/** 本地训练出来的自动回复档案（单份，覆盖式保存）。 */
export const PROFILE_KEY = "gj_reply_profile";
/** 自动回复账本：只记今天发了几条、最后一条什么时候发的。 */
export const LEDGER_KEY = "gj_auto_reply_ledger";
/** 归档历史的索引（不含正文，正文只进下载文件与训练档案）。 */
export const ARCHIVE_INDEX_KEY = "gj_archive_index";
/**
 * 本地语料摘要（问答对 + 风格样本），训练的唯一输入。
 * 刻意**不**存归档全文：全文可能有几 MB，会顶爆 storage 配额，也没必要——
 * 全文只出现在下载出去的归档文件里。
 */
export const CORPUS_KEY = "gj_reply_corpus";

/** 目标语言候选（中文是主场景，其余是外贸常见语种） */
export const TARGET_LANGUAGES = [
  { value: "zh-CN", label: "简体中文" },
  { value: "en", label: "英语" },
  { value: "es", label: "西班牙语" },
  { value: "pt", label: "葡萄牙语" },
  { value: "fr", label: "法语" },
  { value: "de", label: "德语" },
  { value: "ru", label: "俄语" },
  { value: "ar", label: "阿拉伯语" }
];

/**
 * 默认值取**同一条线路上实测最快**的模型。
 *
 * 2026-10-12 在 `api.52token.org/v1` 上用同一句西语外贸问句实测（流式，看首字）：
 *
 *   | 模型 | 首字 | 总耗时 | prompt_tokens |
 *   |---|---|---|---|
 *   | `gpt-5.6-sol`（CRM 即时沟通就用它） | 10.3 / 20.0 秒 | 10.6 / 43.0 秒 | 3613 |
 *   | `gpt-5.5` | **32.7 / 66.4 秒** | 34.6 / 67.9 秒 | 4437 |
 *   | `gpt-6.1-sol` | 65.8 / 17.8 秒 | 66.1 / 18.4 秒 | 4273 |
 *   | `gpt-5.3-codex-spark` | 502 / 503，挂 | — | — |
 *
 * `gpt-5.5` 是这条线上**最慢**的，别再当默认值。apiKey 留空 —— 扩展不读 CRM 的加密 key。
 */
export const DEFAULT_SETTINGS = {
  enabled: true,
  targetLang: "zh-CN",
  replyLang: "en",
  apiBase: "https://api.52token.org/v1",
  apiKey: "",
  model: "gpt-5.6-sol",
  composeTranslate: true,
  /**
   * 草稿自动翻译：你在输入框里打中文，停一下自动译成 `replyLang` 并弹出右侧浮框
   * （可一键复制 / 一键替换到输入框）。
   *
   * **只处理中文草稿** —— 你打英文时不会被自动译回中文，否则输入框会被反复改写，没法用。
   * 想翻英文草稿仍然可以点右下角的「译」手动触发。
   */
  composeAuto: true,
  /**
   * 「替换到输入框」一键到底：译文写进输入框（读回确认）后**立刻自动发送**，
   * 不用再按回车。点按钮的人就是发消息的人 —— 发送只是按钮承诺的收尾动作。
   *
   * 两道安全闸（都在 content.js，缺一不发）：
   *   1. 写入必须走**编辑器命令**路径（insertText / selectAll / paste，Lexical 内部状态
   *      已同步）；dom 兜底档只是"看着有字"，编辑器状态未必认，点了发送可能把**旧内容**
   *      发出去 —— 这一档绝不自动发；
   *   2. 发送后**读回输入框**：没清空就不算发出去，照实提示「请按回车」，绝不谎报已发送。
   *
   * 不想要这行为就在设置页关掉（关掉后回到「替换 → 自己按回车」的老流程）。
   */
  autoSendAfterReplace: true,
  /**
   * 翻译引擎三选一（GJ 面板和设置页都能切，默认混合）：
   *   - "hybrid"：机译打底 + AI 精修（两段式，默认 —— 等待按机译算，质量按 AI 算）；
   *   - "mt"：只用机译（最快、免费；底座失败就照实报错，不走 AI）；
   *   - "ai"：只用 AI（最准、最慢；跳过机译底座，直接等 AI）。
   */
  engineMode: "hybrid",
  /**
   * 整体超时（毫秒）。首字到了之后会一直等到收完，所以给得比较宽松。
   *
   * ⚠️ 这个预算的**唯一正确参照是用户那条线路的实测值**，不能按「翻译应该很快」拍脑袋。
   * 2026-10-12 实测同一句问句、同一线路：`gpt-5.6-sol` 10.6~43.0 秒、`gpt-5.5` 34.6~67.9 秒、
   * `gpt-6.1-sol` 18.4~66.1 秒 —— 连**同一个模型连跑两次**都能差 3 倍。
   *
   * CRM 侧的对应值是 `ai-model-runtime.ts::AI_MODEL_TIMEOUT_MS = 120_000`。两边取齐：
   * 120 秒。翻译迟到只是慢，翻不出来是**这条客户消息永远空着**，代价不对称。
   */
  timeoutMs: 120000,
  /**
   * 「首字超时」（毫秒）：流式下到点还没吐第一个字就判死。
   *
   * ⚠️ 这个值被定错过**两次**，代价都是「整条线路全军击穿」：
   *   - 第一次 8000：当时 9 个模型最快的也要 8.0 秒 → 全灭；
   *   - 第二次 20000：看着够用，但实测 `gpt-5.5` 首字**33 / 66 秒**、`gpt-6.1-sol` 做过 65.8 秒
   *     → 仍然全灭。用户看到的现象就是「翻译一直不出来」，而线路本身是好的。
   *
   * 现在 60000：只为拦住「上游彻底没响应 / 连接被挂住」，不再承担「模型有点慢」的判定。
   * 真嫌慢请用**免费底座先出初译**（`fastBase`）或去设置页用「拉取清单 + 对比测速」挑模型。
   */
  firstTokenMs: 60000,
  /**
   * 流式输出。渲染层仍是一次性拿到完整译文（不做增量渲染），开它只是为了拿到
   * 「第一个字什么时候到」这个信号 —— 才有上面的首字超时。上游不认 `stream`
   * 会回 400，那时 provider 会自动去掉该参数重试一次。
   */
  stream: true,
  /**
   * 推理预算。留空 = 不传该参数（兼容性最好）。翻译不需要推理，配 `minimal`
   * 能明显提速 —— 但只有部分上游认这个参数，不认的会被 400 拒后自动降级重试。
   */
  reasoningEffort: "",
  /** 输出上限。`0` = 不传（默认）。设一个上限能防模型「写小作文」。 */
  maxTokens: 0,
  /**
   * ── 免费底座（第一段：秒出初译）────────────────────────────────────
   *
   * 为什么要有它：上面那条中转线路**没有快模型**（实测最快也要 10 秒，慢的 60 秒以上），
   * 而它的固定开销里光 `prompt_tokens` 就有 3600~4400（原文+提示词本身不到 100），
   * 说明每个请求都被上游塞了一大段隐藏前缀。**掐超时治不了这个病，换模型也治不了。**
   * 唯一能真快起来的办法是把「第一眼要看到的那句话」交给一条轻量机器翻译。
   *
   * `"off"` / `"mymemory"`。MyMemory 免费、无需 Key，2026-10-12 实测：
   * 长句 960~1804 毫秒、短句最快 829 毫秒 —— 比 AI 快一到两个数量级。
   *
   * ⚠️ 别指望谷歌：`translate.googleapis.com` 在本机网络下 **12 秒超时（被墙）**，
   * `libretranslate.com` 403、`api-free.deepl.com` 403，都不可用。MyMemory 是实测可达的那个。
   *
   * ⚠️ 联网行为变化（明说在前）：打开它意味着**客户消息正文会发给 MyMemory** 做机器翻译。
   * 觉得不合适就把这里改成 `"off"`，翻译会退回「只用 AI 那条线路」的原行为。
   *
   * 机译只当**初译**：拿到就先显示（标注「机译」），同时后台照旧跑 AI 精修，
   * 精修回来原地替换成 AI 译文。所以打开它不降低最终译文的质量，只降低你等待的时间。
   */
  fastBase: "mymemory",
  /**
   * MyMemory 的接口地址。**正常不用改**，摆在设置里是为了两件事：
   *   1. 自检时把它指到本地 mock（e2e 不该真的去打第三方服务）；
   *   2. 哪天这个域名变了，改个地址就能救回来，不必等发版。
   */
  fastBaseUrl: "https://api.mymemory.translated.net/get",
  /**
   * MyMemory 匿名额度按天算、比较小。填一个邮箱会走 `de` 参数把额度提到 10 倍。
   * 留空 = 匿名额度，用完自动退回 AI 那条路（不会报错，只是慢一点）。
   */
  fastBaseEmail: "",
  /**
   * 底座的等待上限（毫秒）。它是「初译」，**迟到就没价值了** —— 超过这个时间就直接放弃，
   * 让 AI 那条路接管，而不是让用户干等。实测最长 1.8 秒，给到 6 秒已经很宽松。
   */
  fastBaseTimeoutMs: 6000,
  /**
   * 自动回复。**默认草稿模式**：生成后填进输入框、由人确认发送。
   * 错发的报价/承诺不可撤回，所以不默认走全自动；要全自动只需把 mode 改成 "auto"。
   *
   * `guardrails` / `escalateKeywords` 留空数组 = 用出厂默认（与 CRM 插件同一约定：
   * 空数组代表"用出厂值"，非空才覆盖）。出厂内容在 `trainer.js` 里，避免两处各写一份。
   */
  /**
   * CRM 连接。扩展靠它把「现场对话」交给 CRM 侧那条真正的回复链：
   *   1. 用 CRM 账号换一枚 Bearer（`POST {crmBaseUrl}/api/auth/login`）；
   *   2. 拿这枚 Bearer 调插件的现场生成接口（`POST {pluginBaseUrl}/api/v1/auto-chat/compose`）——
   *      插件在那个接口里会以**这个人的权限**去读 CRM 客户往来历史与知识检索命中，
   *      再交给本机 CLI 加载 `goodjob-auto-reply` 技能出稿。
   *
   * 两个地址默认为本机默认端口；换成局域网/远端也允许，但 http 只放行回环（同 `assertEndpointAllowed`）。
   */
  crm: {
    crmBaseUrl: "http://127.0.0.1:4188",
    pluginBaseUrl: "http://127.0.0.1:3100",
    email: ""
  },
  autoReply: {
    enabled: false,
    mode: "draft",
    language: "auto",
    dailyLimit: 20,
    minIntervalMinutes: 3,
    activeHoursStart: 8,
    activeHoursEnd: 22,
    confidenceThreshold: 0.72,
    guardrails: [],
    escalateKeywords: []
  }
};

export function isConfigured(settings) {
  return Boolean(settings && settings.apiBase && settings.apiKey && settings.model);
}

/**
 * 设置结构的版本号。**改「工程参数」的默认值时必须 +1**，否则老用户永远升不上来。
 *
 * ── 为什么需要它（这是本轮最贵的教训）────────────────────────────────
 * `mergeSettings` 是 `{...默认值, ...存储值}`，**存储值一律赢**。这对「用户主动填的东西」
 * 是对的（API Key、模型名不该被覆盖），但对「我们改错的工程参数」是**致命的**：
 * 上一轮把 `firstTokenMs` 从 8000 放宽到 20000、`timeoutMs` 从 20000 放到 30000，
 * 代码改了、自检全绿，**而用户浏览器里存着的仍然是 8000 / 20000** ——
 * 于是实测首字要 33~66 秒的 `gpt-5.5`，每一次翻译都在第 8 秒被判死。
 * 用户看到的永远是「翻译不出来」，而我这边所有测试都是绿的。
 *
 * 教训：**凡是「默认值承载了实测结论」的字段，都必须有一条从老值到新值的迁移**，
 * 光改默认值等于没改。
 */
export const SETTINGS_SCHEMA_VERSION = 2;

/**
 * 一次性修正。只碰「已被实测证明会让用户完全用不了」的值，不动 API Key / 地址这类用户主动填写的东西。
 *
 * 判据刻意用**区间**而不是「等于某个旧默认值」：用户可能手改过这些数字，
 * 但只要它低于「实测最慢模型都过不了」的线，就一定会出问题，一律抬到安全值。
 */
export function migrateSettings(stored) {
  const raw = stored && typeof stored === "object" ? stored : {};
  if (Number(raw.schemaVersion) >= SETTINGS_SCHEMA_VERSION) return { settings: raw, changed: false };

  const next = { ...raw, schemaVersion: SETTINGS_SCHEMA_VERSION };

  // 首字超时：实测有模型首字 66 秒。低于 30 秒的一定是「击穿线路」的老值。
  if (!(Number(next.firstTokenMs) >= 30000)) next.firstTokenMs = DEFAULT_SETTINGS.firstTokenMs;
  // 整体超时：实测有模型总耗时 67.9 秒，CRM 侧取 120 秒。
  if (!(Number(next.timeoutMs) >= 90000)) next.timeoutMs = DEFAULT_SETTINGS.timeoutMs;
  // 模型：gpt-4o-mini 在这条线路上**根本不存在**（每次秒回 404），gpt-5.5 实测最慢（首字 33/66 秒）。
  if (WOBBLY_MODELS.has(String(next.model || "").trim())) next.model = DEFAULT_SETTINGS.model;
  // 引擎模式：只认三个值，其余（含老版本残留的乱值）一律回默认混合。
  if (!["hybrid", "mt", "ai"].includes(next.engineMode)) next.engineMode = DEFAULT_SETTINGS.engineMode;

  return { settings: next, changed: true };
}

/** 实测已知「填了必坏」的模型名：不存在的、或慢到会被超时判死的 */
const WOBBLY_MODELS = new Set(["gpt-4o-mini", "gpt-5.5", "gpt-5.4-mini", "gpt-5.3-codex-spark"]);

/**
 * 把存储里读到的值补齐成完整设置。
 * `autoReply` / `crm` 是嵌套对象，必须**逐键合并**：浅合并会让老版本存下的设置直接丢掉整块字段，
 * 表现成"改了上限、重启又变回默认"这种很难查的问题。
 */
export function mergeSettings(raw) {
  const stored = raw && typeof raw === "object" ? raw : {};
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    crm: { ...DEFAULT_SETTINGS.crm, ...(stored.crm || {}) },
    autoReply: { ...DEFAULT_SETTINGS.autoReply, ...(stored.autoReply || {}) }
  };
}

/**
 * 读设置。**顺带把迁移落盘** —— 不落盘的话每次读都要重算一遍，
 * 而且用户下次打开设置页看到的仍是旧值，会以为自己没改成。
 */
export async function loadSettings() {
  const raw = await chrome.storage.local.get(SETTINGS_KEY);
  const { settings, changed } = migrateSettings(raw?.[SETTINGS_KEY]);
  const merged = mergeSettings(settings);
  if (changed) await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = {
    ...current,
    ...patch,
    crm: patch?.crm ? { ...current.crm, ...patch.crm } : current.crm,
    autoReply: patch?.autoReply ? { ...current.autoReply, ...patch.autoReply } : current.autoReply
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

/** `zh-CN` / `zh_Hans` / `zh` 一律视为同一种语言 */
export function normalizeLanguage(language) {
  return String(language || "").toLowerCase().replace(/_/gu, "-").split("-")[0];
}

export function isChineseText(text) {
  const value = String(text || "");
  // 假名 / 谚文是日语、韩语的特征。两种语言都大量使用汉字，少了这道判断，
  // 日语消息会被整条当成中文而跳过翻译（实测「ありがとうございます。納期を…」= 3 汉字 0 拉丁 → 必然命中）。
  if (/[\u3040-\u30ff\uac00-\ud7af]/u.test(value)) return false;
  if (!/[\u4e00-\u9fff]/u.test(value)) return false;
  const han = (value.match(/[\u4e00-\u9fff]/gu) || []).length;
  const letters = (value.match(/[A-Za-z\u00c0-\u024f]/gu) || []).length;
  // 中文字符占可见字符多数时才认定为中文，避免"中文夹一句英文报价"被整条跳过
  return han >= 2 && han >= letters;
}

/** 与插件侧 isTranslatable 同口径：纯数字、纯链接、纯表情不翻 */
export function isTranslatable(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return false;
  if (/^\d+([.,]\d+)?$/u.test(trimmed)) return false;
  if (/^(https?:\/\/|www\.)\S+$/iu.test(trimmed)) return false;
  if (/^[\p{Emoji}\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) return false;
  return /\p{L}/u.test(trimmed);
}

/**
 * 词形匹配。刻意**不用 `\b`**：它按 ASCII 的 `\w` 划边界，而葡语的 `olá`、法语的 `échantillon`
 * 首尾都是带重音的字母，`\b` 在它们旁边永远不成立 —— 整条规则会静默失效（实测葡语检测从未生效过）。
 */
function hasWord(value, alternation) {
  return new RegExp(`(?:^|[^\\p{L}])(?:${alternation})(?![\\p{L}])`, "iu").test(value);
}

/**
 * 轻量源语言判别，与插件侧 `translation.ts::detectLanguage` 同一套规则。
 * 只用于把 prompt 写成 "Translate from es to zh-CN" —— 判错也不会译错，
 * 只是少了一层提示；不引入语言检测依赖。
 */
export function detectLanguage(text) {
  const value = String(text || "");
  // 日语先用假名拦下：日语同属"汉字语言"，落到下面的中文分支会把源语言写成 zh-CN，
  // 等于告诉模型"这就是中文"，比不写源语言更糟。
  if (/[\u3040-\u30ff]/u.test(value)) return "ja";
  if (/[\uac00-\ud7af]/u.test(value)) return "ko";
  if (/[\u4e00-\u9fff]/u.test(value)) return "zh-CN";
  if (/[\u0400-\u04ff]/u.test(value)) return "ru";
  if (hasWord(value, "hola|gracias|pedido|precio|muestras|necesitamos|cuál|pueden|podrían")) return "es";
  if (hasWord(value, "olá|obrigado|preço|pedido|amostras|vocês")) return "pt";
  if (hasWord(value, "bonjour|merci|prix|commande|échantillon")) return "fr";
  return "en";
}

/**
 * 草稿该译成什么语言。
 *   中文草稿 → `replyLang`（这句是要发给客户的，方向"中 → 外"）
 *   其它语言 → `targetLang`（随手看看自己写的英文对不对，方向"外 → 中"）
 * 自动链路只跑中文这一支，见 `shouldAutoTranslate`。
 */
export function draftTarget(text, settings) {
  const chinese = isChineseText(text);
  return {
    chinese,
    targetLang: chinese ? settings?.replyLang || "en" : settings?.targetLang || "zh-CN",
    sourceLang: chinese ? "zh-CN" : detectLanguage(text)
  };
}

/**
 * 草稿自动翻译的闸门。纯函数，便于逐条断言。
 *
 * 为什么要挡这么多种情形：
 *   - `already`     同一份草稿不重复打请求 —— 打字过程中 input 事件会连续触发
 *   - `not-chinese` 英文草稿不自动翻，否则你写的英文会被自动换成中文
 *   - `guarded`     刚点过「替换到输入框」，输入框从中文变成了外文；这次变化是我们自己
 *                   造成的，再翻一轮就会中↔外来回震荡，所以给一个短抑制窗口
 */
export function shouldAutoTranslate(input = {}) {
  const { text = "", lastText = "", enabled = true, now = Date.now(), guardUntil = 0 } = input;
  const value = String(text || "").trim();
  if (!enabled) return { run: false, reason: "disabled" };
  if (!value) return { run: false, reason: "empty" };
  if (Number(now) < Number(guardUntil)) return { run: false, reason: "guarded" };
  if (!isChineseText(value)) return { run: false, reason: "not-chinese" };
  if (value === lastText) return { run: false, reason: "already" };
  return { run: true, reason: "ok" };
}

/**
 * 缓存键 = **文本 + 目标语言**。
 *
 * ⚠️ 刻意**不含模型名**（旧版含）。两个原因：
 *   1. 两段式翻译下同一条缓存会先被写成机译、再被 AI 精修覆盖，键里带模型名会让
 *      「精修结果」和「机译结果」落在两个不同的键上，永远互相顶不掉；
 *   2. 换模型是**调优动作**，不该把整份缓存作废 —— 换一次就要为所有历史消息重新付费翻译一次。
 * 所以译文与「谁翻的」解耦：「谁翻的」作为附加信息单独记录，键只认文本本身。
 */
export function cacheKey(text, targetLang) {
  const normalized = String(text || "").replace(/\s+/gu, " ").trim();
  return `${normalizeLanguage(targetLang)}|${normalized}`;
}

/**
 * 只允许 https，或本机回环的 http（本地 mock / 自建代理用）。
 * 与插件侧 validateEndpoint 的安全姿态一致：不接受明文远程端点。
 */
export function assertEndpointAllowed(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || ""));
  } catch {
    throw new Error("API 地址不是合法 URL");
  }
  const host = url.hostname.toLowerCase();
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (url.protocol === "http:" && !isLoopback) {
    throw new Error("远程 API 地址必须用 https（本机 127.0.0.1 可用 http）");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("API 地址只支持 http(s)");
  }
  return url;
}

/** `https://host/v1` → `https://host/v1/chat/completions`（已经是完整路径则原样返回） */
export function normalizeEndpoint(rawUrl) {
  const url = assertEndpointAllowed(rawUrl);
  const trimmed = url.toString().replace(/\/+$/u, "");
  if (/\/chat\/completions$/u.test(trimmed)) return trimmed;
  return /\/v1$/u.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/** 供 options 页申请权限用：`https://host/v1` → `https://host/*` */
export function originPattern(rawUrl) {
  const url = assertEndpointAllowed(rawUrl);
  return `${url.protocol}//${url.host}/*`;
}

export function readCacheStore(raw) {
  const store = raw && typeof raw === "object" ? raw : {};
  const entries = Array.isArray(store.entries) ? store.entries : [];
  return entries.filter((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string");
}

/** 简单 LRU：命中就挪到末尾，超限从头部淘汰 */
export function touchCache(entries, key, value) {
  const next = entries.filter((entry) => entry[0] !== key);
  next.push([key, value]);
  return next.length > CACHE_LIMIT ? next.slice(next.length - CACHE_LIMIT) : next;
}

export function maskKey(apiKey) {
  const value = String(apiKey || "");
  if (!value) return "";
  return value.length <= 8 ? "****" : `****${value.slice(-4)}`;
}
