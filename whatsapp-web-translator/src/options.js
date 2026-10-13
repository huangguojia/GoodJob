import {
  DEFAULT_SETTINGS,
  loadSettings,
  maskKey,
  originPattern,
  saveSettings,
  TARGET_LANGUAGES
} from "./settings.js";
import { fastBaseEndpoint, FAST_BASES, isFastBaseEnabled } from "./fast-base.js";
import { describeEngine } from "./crm.js";

const el = (id) => document.getElementById(id);
const status = el("status");
const crmState = el("crmState");
const crmStatus = el("crmStatus");

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = kind;
}

/**
 * CRM 卡片自己的反馈行。
 * 与页面底部那条 `#status` 分开：按「登录 CRM」之后结果跑到页面底部，用户根本不会往那儿看。
 * 密码/令牌相关的话也只该出现在这张卡里。
 */
function setCrmStatus(text, kind = "") {
  crmStatus.textContent = text;
  crmStatus.className = kind ? `hint ${kind}` : "hint";
}

/** 回调式 `sendMessage`：后台抛错时只有这里能读到 `lastError`，promise 形式会静默 reject。 */
function sendToBackground(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) resolve({ ok: false, error: error.message });
        else resolve(response ?? { ok: false, error: "扩展后台没有响应" });
      });
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function fillLanguageSelect(select, includeEmpty) {
  select.textContent = "";
  if (includeEmpty) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "（跟随上面的目标语言）";
    select.appendChild(option);
  }
  for (const item of TARGET_LANGUAGES) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = `${item.label}（${item.value}）`;
    select.appendChild(option);
  }
  const custom = document.createElement("option");
  custom.value = "__custom__";
  custom.textContent = "其它（保持现状）";
  select.appendChild(custom);
}

/** 目标语言是下拉里的“其它”时，回填成当前值，避免静默改掉用户配置 */
function readSelectValue(select, fallback) {
  if (select.value === "__custom__") return fallback;
  if (select.value === "") return "";
  return select.value;
}

function fillFastBaseSelect(select) {
  select.textContent = "";
  for (const base of FAST_BASES) {
    const option = document.createElement("option");
    option.value = base.id;
    option.textContent = base.label;
    select.appendChild(option);
  }
}

/** 下拉选项旁那句"这个选项到底意味着什么"。选项名本身说不清取舍，得有人话解释。 */
function renderFastBaseNote(id) {
  const base = FAST_BASES.find((item) => item.id === id);
  el("fastBaseNote").textContent = base?.hint || "";
}

/** 多行文本 ↔ 字符串数组：空文本代表"用出厂默认"，所以返回空数组。 */
function readLines(id) {
  return el(id)
    .value.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function writeLines(id, list) {
  el(id).value = (list || []).join("\n");
}

/** 数字输入框清空会是 NaN：宁可回落到原值，也不要写进一个 NaN 让限额永久失效。 */
function num(id, fallback) {
  const value = Number(el(id).value);
  return Number.isFinite(value) ? value : fallback;
}

async function render() {
  const settings = await loadSettings();
  fillLanguageSelect(el("targetLang"), false);
  fillLanguageSelect(el("replyLang"), false);
  fillFastBaseSelect(el("fastBase"));

  el("enabled").checked = settings.enabled;
  el("targetLang").value = TARGET_LANGUAGES.some((item) => item.value === settings.targetLang)
    ? settings.targetLang
    : "__custom__";
  el("composeTranslate").checked = settings.composeTranslate;
  el("composeAuto").checked = settings.composeAuto;
  el("autoSendAfterReplace").checked = settings.autoSendAfterReplace !== false;
  el("engineMode").value = ["hybrid", "mt", "ai"].includes(settings.engineMode) ? settings.engineMode : "hybrid";
  el("replyLang").value = TARGET_LANGUAGES.some((item) => item.value === settings.replyLang)
    ? settings.replyLang
    : "__custom__";
  el("apiBase").value = settings.apiBase;
  el("apiKey").value = settings.apiKey;
  el("model").value = settings.model;
  el("reasoningEffort").value = settings.reasoningEffort || "";
  el("fastBase").value = settings.fastBase || DEFAULT_SETTINGS.fastBase;
  el("fastBaseEmail").value = settings.fastBaseEmail || "";
  renderFastBaseNote(el("fastBase").value);
  // 只有打开时才有内容可测 —— 关着还留一个按钮，会让人以为"关了也能测"
  el("probeFastBase").disabled = !isFastBaseEnabled(settings);

  const auto = settings.autoReply;
  el("autoMode").value = auto.mode;
  el("autoDailyLimit").value = auto.dailyLimit;
  el("autoInterval").value = auto.minIntervalMinutes;
  el("autoHoursStart").value = auto.activeHoursStart;
  el("autoHoursEnd").value = auto.activeHoursEnd;
  el("autoThreshold").value = auto.confidenceThreshold;
  writeLines("autoEscalate", auto.escalateKeywords);
  writeLines("autoGuardrails", auto.guardrails);

  el("crmBaseUrl").value = settings.crm.crmBaseUrl;
  el("pluginBaseUrl").value = settings.crm.pluginBaseUrl;
  el("crmEmail").value = settings.crm.email;
  // 密码框**永远**从空开始：密码不进存储，回填只会把上一次的残留留在页面上。
  el("crmPassword").value = "";

  if (settings.apiKey) setStatus(`当前 Key：${maskKey(settings.apiKey)}`);

  void refreshCrm();
}

/** 保存前按需申请目标域权限：没有它 background 的 fetch 会被拦 */
async function ensureHostPermission(apiBase) {
  let pattern;
  try {
    pattern = originPattern(apiBase);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (pattern.startsWith("http://127.0.0.1") || pattern.startsWith("http://localhost")) return { ok: true };
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return { ok: true };
  const granted = await chrome.permissions.request({ origins: [pattern] });
  return granted ? { ok: true } : { ok: false, error: `没有授权访问 ${pattern}，翻译会失败` };
}

/* ------------------------------------------------------------ CRM 连接 */

/**
 * 读 CRM 那三个字段。
 * 地址留空就回落到出厂默认：用户多半是误删，静默存一个空串会让"为什么连不上"变成查不出的谜。
 */
function readCrmPatch() {
  const fallback = DEFAULT_SETTINGS.crm;
  return {
    crmBaseUrl: el("crmBaseUrl").value.trim() || fallback.crmBaseUrl,
    pluginBaseUrl: el("pluginBaseUrl").value.trim() || fallback.pluginBaseUrl,
    email: el("crmEmail").value.trim()
  };
}

/** CRM 与插件地址也要过一遍授权。默认是回环（已在 host_permissions 里），改成远端才真会弹窗。 */
async function ensureCrmPermissions(crm) {
  for (const [label, raw] of [["CRM 地址", crm.crmBaseUrl], ["插件地址", crm.pluginBaseUrl]]) {
    const result = await ensureHostPermission(raw);
    if (!result.ok) return { ok: false, error: `${label}：${result.error}` };
  }
  return { ok: true };
}

/** 会话状态写成一句人话：登录了就报还能用多久，过期了直接说"重登一次"而不是"未登录"。 */
function renderSessionState(session) {
  if (!session?.loggedIn) {
    if (session?.expired) {
      crmState.dataset.state = "warn";
      crmState.textContent = `登录已过期${session.email ? `（${session.email}）` : ""} —— 重新登录一次`;
      return;
    }
    crmState.dataset.state = "unknown";
    crmState.textContent = "未登录（智能回复现在用不了）";
    return;
  }
  crmState.dataset.state = "ok";
  crmState.textContent = `已登录${session.email ? `：${session.email}` : ""} · 令牌约剩 ${session.expiresInMinutes} 分钟`;
}

/**
 * 问一次后台：会话还有效吗、插件在不在、CLI 能不能跑。
 * `verbose` 只在用户**点了按钮**时为真 —— 自动刷新时不该往卡片里塞一句教程。
 */
async function refreshCrm({ verbose = false } = {}) {
  crmState.dataset.state = "unknown";
  crmState.textContent = "检测中…";
  const response = await sendToBackground({ type: "crmStatus" });
  if (!response?.ok) {
    crmState.dataset.state = "err";
    crmState.textContent = response?.error || "读取失败";
    el("crmStats").hidden = true;
    setCrmStatus("读不到 CRM 会话状态，确认插件/CRM 已在运行", "err");
    return;
  }
  renderSessionState(response.session);
  // 没登录时后台不会去探插件（那条请求必然 401），所以 engine 是 null 属正常，不是故障。
  if (!response.session?.loggedIn) {
    el("crmStats").hidden = true;
    setCrmStatus(verbose ? "还没登录 CRM —— 填上账号密码点「登录 CRM」" : "", verbose ? "warn" : "");
    return;
  }
  const engine = describeEngine(response.engine);
  setCrmStatus(engine.text, engine.state === "unknown" ? "" : engine.state);
  // 登录有效才拉报表；失败是旁路，绝不能影响上面的连接状态展示。
  void refreshResourceStats();
}

/**
 * 「资料推荐效果」小卡片（只读，docs/RESOURCE-FEEDBACK-REPORT-DESIGN.md）。
 *
 * 纪律与连接状态一致：**不出假数据**。拉不到就把原因写出来；
 * 未登录整块隐藏 —— 一张「全 0 报表」会让人误以为真的一次都没推荐过。
 */
async function refreshResourceStats() {
  const card = el("crmStats");
  card.hidden = false;
  const totals = el("crmStatsTotals");
  const items = el("crmStatsItems");
  totals.textContent = "";
  items.textContent = "";
  const response = await sendToBackground({ type: "crmResourceStats", payload: { days: 30 } });
  if (!response?.ok) {
    totals.replaceChildren(Object.assign(document.createElement("p"), { className: "crm-stats-error", textContent: `推荐效果没取到：${response?.error || "未知原因"}` }));
    return;
  }
  const data = response.result ?? {};
  const summary = data.totals ?? {};
  const fmtPct = (value) => `${Math.round(Number(value || 0) * 1000) / 10}%`;
  const cells = [
    ["曝光", summary.exposed],
    ["查看", summary.revealed],
    ["采纳率", fmtPct(summary.adoptionRate)],
    ["发送", summary.sent]
  ];
  totals.replaceChildren(
    ...cells.map(([label, value]) => {
      const span = document.createElement("span");
      span.textContent = `${label} `;
      const bold = document.createElement("b");
      bold.textContent = String(value ?? 0);
      span.appendChild(bold);
      return span;
    })
  );
  const rows = (Array.isArray(data.items) ? data.items : []).slice(0, 8);
  items.replaceChildren(
    ...rows.map((item) => {
      const li = document.createElement("li");
      const title = document.createElement("span");
      title.textContent = item.title || "（未命名资料）";
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = `采纳 ${fmtPct(item.adoptionRate)} · 查看 ${item.counts?.revealed ?? 0}`;
      li.append(title, num);
      return li;
    })
  );
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.textContent = "最近还没有资料被推荐过";
    items.replaceChildren(empty);
  }
}

async function loginCrm() {
  const connection = readCrmPatch();
  const email = el("crmEmail").value.trim();
  const password = el("crmPassword").value;
  if (!email || !password) {
    setCrmStatus("CRM 账号和密码都要填", "err");
    return;
  }
  const permission = await ensureCrmPermissions(connection);
  if (!permission.ok) {
    setCrmStatus(permission.error, "err");
    return;
  }
  const button = el("crmLogin");
  button.disabled = true;
  setCrmStatus("正在登录…");
  try {
    const response = await sendToBackground({ type: "crmLogin", email, password, connection });
    // 不管成没成都立刻把密码从 DOM 里抹掉：它没有任何理由在页面上多留一秒。
    el("crmPassword").value = "";
    if (!response?.ok) {
      setCrmStatus(response?.error || "登录失败", "err");
      return;
    }
    renderSessionState(response.session);
    setCrmStatus("已登录 —— 现在去 WhatsApp 页面右侧面板点「用 CRM 生成回复」", "ok");
  } finally {
    button.disabled = false;
  }
}

async function logoutCrm() {
  const response = await sendToBackground({ type: "crmLogout" });
  if (!response?.ok) {
    setCrmStatus(response?.error || "退出失败", "err");
    return;
  }
  renderSessionState(response.session);
  setCrmStatus("已退出登录，令牌已从本机删除", "ok");
  el("crmStats").hidden = true;
}

async function save() {
  const current = await loadSettings();
  const patch = {
    enabled: el("enabled").checked,
    targetLang: readSelectValue(el("targetLang"), current.targetLang),
    replyLang: readSelectValue(el("replyLang"), current.replyLang) || current.replyLang || DEFAULT_SETTINGS.replyLang,
    composeTranslate: el("composeTranslate").checked,
    composeAuto: el("composeAuto").checked,
    autoSendAfterReplace: el("autoSendAfterReplace").checked,
    engineMode: el("engineMode").value,
    apiBase: el("apiBase").value.trim(),
    apiKey: el("apiKey").value.trim(),
    model: el("model").value.trim(),
    reasoningEffort: el("reasoningEffort").value,
    fastBase: el("fastBase").value,
    fastBaseEmail: el("fastBaseEmail").value.trim(),
    autoReply: {
      mode: el("autoMode").value,
      // 开关只由模式派生：选 off 就是关，避免出现"开着但模式是 off"这种自相矛盾的状态。
      enabled: el("autoMode").value !== "off",
      dailyLimit: num("autoDailyLimit", current.autoReply.dailyLimit),
      minIntervalMinutes: num("autoInterval", current.autoReply.minIntervalMinutes),
      activeHoursStart: num("autoHoursStart", current.autoReply.activeHoursStart),
      activeHoursEnd: num("autoHoursEnd", current.autoReply.activeHoursEnd),
      confidenceThreshold: num("autoThreshold", current.autoReply.confidenceThreshold),
      escalateKeywords: readLines("autoEscalate"),
      guardrails: readLines("autoGuardrails")
    }
  };

  if (!patch.apiBase) {
    setStatus("API 地址不能为空", "err");
    return;
  }
  // 保存的是「真正要用的那一个模型」。模型框允许临时放多个名字（给对比测速），
  // 但那串东西一旦被原样存进设置，之后每一次真翻译都会带着 "a,b,c" 去打上游 —— 秒 404。
  const pickedModels = splitModels(el("model").value);
  if (pickedModels.length === 0) {
    setStatus("模型名不能为空", "err");
    return;
  }
  if (pickedModels.length > 1) {
    setStatus(`模型框里现在是 ${pickedModels.length} 个名字 —— 那是给「对比测速」用的；保存前挑定一个`, "err");
    return;
  }
  patch.model = pickedModels[0];

  const crm = readCrmPatch();
  // 底座是**第三方域名**，刻意不写进 manifest 的 host_permissions ——
  // 用可选权限在「用户主动打开它的那一刻」才申请。不打开就永远不会碰到它。
  const fastPermission = patch.fastBase && patch.fastBase !== "off"
    ? await ensureHostPermission(fastBaseEndpoint({ ...current, fastBase: patch.fastBase }))
    : { ok: true };
  const permission = await ensureHostPermission(patch.apiBase);
  const crmPermission = await ensureCrmPermissions(crm);
  // CRM 那三个字段一起存：它们和翻译设置同在「保存」这一个动作下，分开存会出现
  // "地址改了但没保存、登录用的却是新地址"这种自相矛盾的状态。
  await saveSettings({ ...patch, crm });
  if (!permission.ok) {
    setStatus(`已保存，但${permission.error}`, "err");
    return;
  }
  if (!fastPermission.ok) {
    setStatus(`已保存，但快速底座${fastPermission.error}`, "err");
    return;
  }
  if (!crmPermission.ok) {
    setStatus(`已保存，但${crmPermission.error}`, "err");
    return;
  }
  setStatus("已保存");
}

/**
 * 「模型」框里现在填着的名字列表。逗号（半/全角）和空白都算分隔。
 *
 * ⚠️ 这个框是**双职责**的：存一个名字 = 当前要用的模型；存多个名字 = 「对比测速」的候选清单。
 * 正因为这个双职责，`test()` / `save()` 拿到值后**必须先过这里**再发/再存 ——
 * 否则 "a,b,c" 会被当成一个模型名整个塞进请求的 model 字段发给上游（真实发生过，很低级的错误）。
 */
function splitModels(value) {
  return String(value || "")
    .split(/[,，\s]+/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 模型卡片里当前填的这几项。测速与保存共用一份，避免两处各读一遍表单。
 */
function readModelDraft() {
  return {
    apiBase: el("apiBase").value.trim(),
    apiKey: el("apiKey").value.trim(),
    model: el("model").value.trim(),
    reasoningEffort: el("reasoningEffort").value
  };
}

function setBench(text, kind = "") {
  const node = el("benchOut");
  node.textContent = text;
  node.className = kind ? `hint ${kind}` : "hint";
}

/**
 * 按**实测秒数**给结论 —— 「连接成功」这四个字说明不了任何事，用户真正要知道的是
 * 「这个模型做翻译要几秒」。
 *
 * 分档依据：一句普通外贸问句，正常模型 1–3 秒；3 秒以上就偏慢，8 秒以上体验已经很差。
 *
 * ⚠️ 这是**体验**分档，与 `settings.js::firstTokenMs`（判死阈值，实测后放宽到 60 秒）
 * 不是一回事 —— 别拿判死阈值当速度标准，否则整条线路都会被"合格"。
 */
function describeSpeed(seconds) {
  if (seconds <= 3) return { kind: "ok", note: "速度正常" };
  if (seconds <= 8) return { kind: "ok", note: "偏慢 —— 可以换更轻的模型" };
  return { kind: "err", note: "太慢 —— 这个模型不适合做翻译，建议换成非推理的轻量模型" };
}

async function test() {
  // 模型框里是多个名字 = 用户想做对比。此时绝不能把整串当 model 发出去 —— 转给对比测速逐个来。
  if (splitModels(el("model").value).length > 1) {
    setStatus("模型框里是多个名字 —— 按「对比测速」逐个测，结果在按钮下方", "");
    await bench();
    return;
  }
  setStatus("正在测试…");
  const draft = readModelDraft();
  const permission = await ensureHostPermission(draft.apiBase);
  if (!permission.ok) {
    setStatus(permission.error, "err");
    return;
  }
  const response = await sendToBackground({ type: "testConnection", draft });
  if (!response?.ok) {
    setStatus(response?.error || "测试失败", "err");
    return;
  }
  const seconds = Math.round(Number(response.totalMs || 0) / 100) / 10;
  const { kind, note } = describeSpeed(seconds);
  setStatus(`${seconds} 秒 · ${note} · 译：${response.text}`, kind);
}

/**
 * 对比测速：在「模型」里用逗号写两个以上模型名，逐个测一遍并排报出秒数。
 *
 * 这是回答「怎么才能快」最直接的办法 —— 与其猜哪个模型快，不如在同一台机器、
 * 同一条线路、同一句话上各测一遍。测的是**当前表单里的值**，不用先保存。
 */
async function bench() {
  const models = splitModels(el("model").value);
  if (models.length < 2) {
    setBench("在「模型」里用逗号分隔写两个及以上模型名，再点对比测速。", "err");
    return;
  }
  const draft = readModelDraft();
  const permission = await ensureHostPermission(draft.apiBase);
  if (!permission.ok) {
    setBench(permission.error, "err");
    return;
  }

  setBench(`正在逐个测 ${models.length} 个模型，每个最多等 20 秒…`);
  const rows = [];
  for (const model of models) {
    const response = await sendToBackground({ type: "testConnection", draft: { ...draft, model } });
    if (!response?.ok) {
      rows.push(`${model}：✗ ${response?.error || "失败"}`);
      continue;
    }
    const seconds = Math.round(Number(response.totalMs || 0) / 100) / 10;
    rows.push(`${model}：${seconds} 秒`);
  }
  const fastest = rows.filter((row) => !row.includes("✗"));
  setBench(rows.join("　|　"), fastest.length ? "ok" : "err");
}

/**
 * 拉取这条线路上**真实可用**的模型清单，渲染成一排可点的标签。
 *
 * 这一块是踩坑补上的：模型名原本只能手输，填了一个这条线路上不存在的名字
 * → 每次请求秒回 404，而界面上只显示「接口路径或模型名不对」，用户根本不知道能填什么。
 * 点选就不会错。
 */
function renderModelList(models, error) {
  const node = el("modelList");
  node.textContent = "";
  node.hidden = false;

  if (error) {
    const warn = document.createElement("p");
    warn.className = "hint";
    warn.textContent = error;
    node.append(warn);
    return;
  }

  const picked = () => splitModels(el("model").value);

  const current = picked();
  for (const name of models) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.setAttribute("aria-pressed", current.includes(name) ? "true" : "false");
    button.addEventListener("click", () => {
      // 点一下填进去；已填着的再点一次 = 取消。这样能连着挑两三个再用「对比测速」比。
      const now = picked();
      const next = now.includes(name) ? now.filter((item) => item !== name) : [...now, name];
      el("model").value = next.join(",");
      renderModelList(models, "");
    });
    node.append(button);
  }

  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = `共 ${models.length} 个。点一下填进「模型」框；挑两个以上，就能用下面的「对比测速」各测一遍再定。`;
  node.append(note);
}

async function fetchModels() {
  const draft = readModelDraft();
  const permission = await ensureHostPermission(draft.apiBase);
  if (!permission.ok) {
    renderModelList([], permission.error);
    return;
  }
  renderModelList([], "正在拉取…");
  const response = await sendToBackground({ type: "listModels", draft });
  if (!response?.ok) {
    // 不少中转站根本不开放 /models，这属于"这条路走不通"，不是配置坏了 —— 提示语要分开
    renderModelList([], `${response?.error || "拉取失败"} —— 有些中转站不开放这个接口，那就只能手输模型名了（注意别写错）。`);
    return;
  }
  renderModelList(response.models || [], "");
}

async function clearCache() {
  await sendToBackground({ type: "clearCache" });
  setStatus("翻译缓存已清空，下次会重新翻译", "ok");
}

/**
 * 测一次底座。**必须打真实服务** —— "底座能不能用、要几秒"只有真跑一次才知道，
 * 自检里的桩永远打不到这一层（这正是本项目最贵的那条教训）。
 *
 * 与「模型对比测速」共用同一套分档：按**实测秒数**说话，而不是"成功/失败"。
 */
async function probeFastBase() {
  const draft = {
    fastBase: el("fastBase").value,
    fastBaseEmail: el("fastBaseEmail").value.trim(),
    fastBaseUrl: ""
  };
  const button = el("probeFastBase");
  button.disabled = true;
  el("fastBaseOut").className = "hint";
  el("fastBaseOut").textContent = "正在打真实服务…";
  try {
    if (!isFastBaseEnabled(draft)) {
      el("fastBaseOut").textContent = "底座关着 —— 先在里面选一个再测。";
      return;
    }
    const permission = await ensureHostPermission(fastBaseEndpoint(draft));
    if (!permission.ok) {
      el("fastBaseOut").className = "hint err";
      el("fastBaseOut").textContent = permission.error;
      return;
    }
    const response = await sendToBackground({ type: "probeFastBase", draft });
    const result = response?.result || response;
    if (!result?.ok) {
      el("fastBaseOut").className = "hint err";
      el("fastBaseOut").textContent = `底座没通：${result?.error || "未知原因"}`;
      return;
    }
    const seconds = Math.round(Number(result.totalMs || 0) / 100) / 10;
    // 底座的"正常"标准比 AI 严得多：它存在的唯一理由就是快，超过 3 秒就对不起这个定位。
    const kind = seconds <= 3 ? "ok" : "err";
    const note = seconds <= 3 ? "够快，初译基本是秒出" : "偏慢 —— 初译会拖，考虑关掉它只用 AI";
    el("fastBaseOut").className = `hint ${kind}`;
    el("fastBaseOut").textContent = `${seconds} 秒 · ${note} · 译：${result.text}`;
  } finally {
    button.disabled = false;
  }
}

el("save").addEventListener("click", () => void save());
el("test").addEventListener("click", () => void test());
el("listModels").addEventListener("click", () => void fetchModels());
el("bench").addEventListener("click", () => void bench());
el("clear").addEventListener("click", () => void clearCache());
el("probeFastBase").addEventListener("click", () => void probeFastBase());
// 换底座要立刻把说明和按钮状态跟上，否则用户会对着"关闭"的选项读一段 MyMemory 的说明
el("fastBase").addEventListener("change", () => {
  renderFastBaseNote(el("fastBase").value);
  el("probeFastBase").disabled = !isFastBaseEnabled({ fastBase: el("fastBase").value });
  el("fastBaseOut").textContent = "";
});
el("crmLogin").addEventListener("click", () => void loginCrm());
el("crmRefresh").addEventListener("click", () => void refreshCrm({ verbose: true }));
el("crmLogout").addEventListener("click", () => void logoutCrm());
// 登录框里按回车直接登录：这是这个卡片上唯一一个"填完就想立刻执行"的动作。
el("crmPassword").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  void loginCrm();
});

void render();
