import { loadSettings, saveSettings, TARGET_LANGUAGES } from "./settings.js";
import { describeEngine } from "./crm.js";

const el = (id) => document.getElementById(id);

/** 回调式 sendMessage：后台抛错时只有这里能读到 `lastError`，promise 形式会静默 reject。 */
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

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "页面没有响应" });
    });
  });
}

/**
 * 归档/学习/自动回复都跑在页面脚本里，所以先确认这一页真的能用。
 * 刻意**不看 URL**：能不能通上话才是唯一可信的判据 —— URL 正则会漏掉本地 mock 页，
 * 也会在 WhatsApp 换域名/带参数时误判成"不是 WhatsApp 页面"。
 */
async function agentTab() {
  const tab = await activeTab();
  if (!tab?.id) return null;
  const probe = await sendToTab(tab.id, { type: "agent:status" });
  return probe?.ok ? { tab, status: probe } : null;
}

/** 翻译链路自检。与 agentTab 同理，用"能否通信"判断，不看 URL。 */
async function translationProbe() {
  const tab = await activeTab();
  if (!tab?.id) return { ok: false, error: "没有活动标签页" };
  return sendToTab(tab.id, { type: "stats" });
}

function renderTranslationProbe(probe, settings) {
  const node = el("trMeta");
  if (!probe?.ok) {
    // 最常见的一种：扩展刚更新/重载过，但 WhatsApp 页面还是旧上下文，页面里没有我们的脚本。
    node.className = "status warn";
    node.textContent =
      "这一页没有检测到翻译脚本。两种可能：① 当前标签页不是网页版 WhatsApp；② 扩展刚更新或重新加载过，需要刷新这个页面（F5）才会注入。";
    return;
  }
  const lastError = probe.lastError || (settings.apiKey ? "" : "还没填 API Key");
  // 「该翻却没翻」= 客户发来的减去本来就该跳过的（中文 / 纯数字 / 表情）。
  // 这一条是给"页面看着没反应"直接下结论用的：没有它，用户只能看着空消息猜。
  const shouldTranslate = Math.max(0, (probe.inbound || 0) - (probe.skipped || 0));
  const dead = shouldTranslate > 0 && (probe.nodes || 0) === 0 && !probe.pending;
  const lines = [
    `已接管 · 这一页看到 ${probe.rows} 条消息（客户发来 ${probe.inbound} 条）`,
    `已显示译文 ${probe.nodes} 条${probe.failed ? `，失败 ${probe.failed} 条（消息下面有点「重试」的按钮）` : ""}`,
    probe.skipped ? `跳过 ${probe.skipped} 条（中文 / 纯数字 / 表情）` : "",
    probe.pending
      ? `还有 ${probe.pending} 条在处理中${probe.stalled ? `（其中 ${probe.stalled} 条卡住了，45 秒后会自动重来）` : ""}`
      : "",
    probe.enabled === false ? "自动翻译开关是关的" : "",
    // 有消息行、但一条都认不出方向 —— 典型的 WhatsApp 改版信号
    probe.rows > 0 && probe.inbound === 0 && probe.testIdRows > 0 ? "⚠️ 消息方向识别不到，可能 WhatsApp 改版了" : "",
    dead
      ? `⚠️ 有 ${shouldTranslate} 条客户消息该翻却没翻（既没译文、也没报错）：多半是翻译接口不响应 —— 去设置页点「测试连接」，看它是几秒返回还是直接超时`
      : "",
    lastError ? `最近失败：${lastError}` : ""
  ].filter(Boolean);
  node.className = lastError || probe.enabled === false || dead ? "status warn" : "status ok";
  node.textContent = lines.join("\n");
}

function setAgentEnabled(enabled) {
  for (const id of ["archiveCurrent", "archiveAll", "learn", "exportKit", "reset", "replyNow", "format", "autoMode"]) {
    el(id).disabled = !enabled;
  }
}

/**
 * CRM 状态单独问后台，不经过页面脚本。
 * 「我到底登录了没」是弹窗自己就该答得上来的问题 —— 面板可能还没展开，当前标签页甚至可能不是 WhatsApp。
 * 按钮在两种状态之间切换角色：没登录时它负责把人送去设置页，登录了才真的去生成。
 */
async function renderCrm() {
  const node = el("crmMeta");
  const button = el("crmReply");
  const response = await sendToBackground({ type: "crmStatus" });
  if (!response?.ok) {
    node.className = "status err";
    node.textContent = response?.error || "读不到 CRM 状态";
    button.textContent = "去设置";
    button.dataset.gjAction = "options";
    return;
  }
  const session = response.session;
  if (!session?.loggedIn) {
    node.className = "status warn";
    node.textContent = session?.expired
      ? "CRM 登录已过期 —— 点下面去设置页重新登录一次。"
      : "还没登录 CRM —— 点下面去设置页填一次账号密码（密码不留存）。";
    button.textContent = "去登录 CRM";
    button.dataset.gjAction = "options";
    return;
  }
  const engine = describeEngine(response.engine);
  node.className = `status ${engine.state === "err" ? "err" : engine.state === "ok" ? "ok" : "warn"}`;
  node.textContent = `已登录 ${session.email || "CRM"}（令牌约剩 ${session.expiresInMinutes} 分钟）\n${engine.text}`;
  button.textContent = "用 CRM 生成回复";
  button.dataset.gjAction = "compose";
}

async function render() {
  const settings = await loadSettings();
  el("enabled").checked = settings.enabled;

  el("targetLang").textContent = "";
  const languages = TARGET_LANGUAGES.some((item) => item.value === settings.targetLang)
    ? TARGET_LANGUAGES
    : [...TARGET_LANGUAGES, { value: settings.targetLang, label: settings.targetLang }];
  for (const item of languages) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    el("targetLang").appendChild(option);
  }
  el("targetLang").value = settings.targetLang;
  el("composeAuto").checked = settings.composeAuto;

  el("autoMode").value = settings.autoReply.enabled ? settings.autoReply.mode : "off";

  renderTranslationProbe(await translationProbe(), settings);
  // 放在 agentTab 判断**之前**：CRM 状态不依赖当前标签页，早退分支也不该让它停在"正在读取…"。
  void renderCrm();

  const status = el("status");
  if (!settings.apiKey) {
    status.className = "status warn";
    status.textContent = "还没填 API Key —— 翻译要它；归档与自动回复用的是本地历史话术，不填也能用。";
  }

  const agent = await agentTab();
  setAgentEnabled(Boolean(agent));
  if (!agent) {
    el("agentMeta").textContent = "这一页没有归档脚本。打开 web.whatsapp.com 并点开一个对话；如果扩展刚更新过，先按 F5 刷新页面。";
    if (settings.apiKey) {
      status.className = "status warn";
      status.textContent = "当前标签页不是网页版 WhatsApp。";
    }
    return;
  }

  const { status: probe } = agent;
  const contact = probe.contact?.contactName || "未识别会话";
  el("agentMeta").textContent = `${contact} · 当前会话 ${probe.messageCount} 条消息`;

  const profile = probe.profile;
  const profileLine = profile
    ? `训练档案：${profile.status === "ready" ? "就绪" : "样本不足"} · ${profile.samples} 组问答 · 语气「${profile.tone}」`
    : "训练档案：还没有，点一次「归档并学习」即可生成";

  status.className = settings.apiKey ? "status ok" : "status warn";
  const ledger = probe.ledger;
  const quota = settings.autoReply.enabled
    ? `自动回复：${settings.autoReply.mode === "auto" ? "全自动发送" : "草稿"}${ledger?.sentToday ? ` · 今天已发 ${ledger.sentToday} 条` : ""}`
    : "自动回复：已关闭";
  status.textContent = [profileLine, quota, probe.note ? `最近：${probe.note}` : ""].filter(Boolean).join("\n");
}

async function runAgent(action) {
  const agent = await agentTab();
  if (!agent) return;
  setAgentEnabled(false);
  const response = await sendToTab(agent.tab.id, action);
  setAgentEnabled(true);
  if (response?.ok === false) {
    el("status").className = "status warn";
    el("status").textContent = response.error || "操作失败";
    return;
  }
  await render();
}

el("enabled").addEventListener("change", async () => {
  await saveSettings({ enabled: el("enabled").checked });
  const tab = await activeTab();
  if (tab?.id) void sendToTab(tab.id, { type: "settingsChanged" });
  void render();
});

el("targetLang").addEventListener("change", async () => {
  await saveSettings({ targetLang: el("targetLang").value });
  const tab = await activeTab();
  if (tab?.id) void sendToTab(tab.id, { type: "rescan", clearCache: false });
  void render();
});

el("composeAuto").addEventListener("change", async () => {
  await saveSettings({ composeAuto: el("composeAuto").checked });
  const tab = await activeTab();
  if (tab?.id) void sendToTab(tab.id, { type: "settingsChanged" });
  void render();
});

el("autoMode").addEventListener("change", async () => {
  const picked = el("autoMode").value;
  await saveSettings({ autoReply: { enabled: picked !== "off", mode: picked === "off" ? "draft" : picked } });
  const tab = await activeTab();
  if (tab?.id) void sendToTab(tab.id, { type: "settingsChanged" });
  void render();
});

el("archiveCurrent").addEventListener("click", () =>
  runAgent({ type: "agent:archive", scope: "current", format: el("format").value, learn: true })
);
el("archiveAll").addEventListener("click", () =>
  runAgent({ type: "agent:archive", scope: "all", format: el("format").value, learn: true })
);
el("learn").addEventListener("click", () => runAgent({ type: "agent:learn" }));
el("exportKit").addEventListener("click", () => runAgent({ type: "agent:exportProfile" }));
el("reset").addEventListener("click", () => runAgent({ type: "agent:reset" }));
el("replyNow").addEventListener("click", () => runAgent({ type: "agent:replyNow" }));

el("rescan").addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab?.id) await sendToTab(tab.id, { type: "rescan", clearCache: true });
  void render();
});

el("options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

el("crmReply").addEventListener("click", async () => {
  // 按钮此刻的角色由 renderCrm 决定：没登录时它是"去设置"，别硬去生成。
  if (el("crmReply").dataset.gjAction === "options") {
    chrome.runtime.openOptionsPage();
    return;
  }
  const node = el("crmMeta");
  const agent = await agentTab();
  if (!agent) {
    node.className = "status warn";
    node.textContent = "这一页没有归档脚本 —— 打开 web.whatsapp.com 并点开一个对话；如果扩展刚更新过，先按 F5。";
    return;
  }
  node.className = "status";
  node.textContent = "已交给页面生成 —— 一次通常几十秒，结果落在页面右侧面板里。\n这个弹窗现在可以关掉。";
  // 刻意不 await：popup 一失焦就会被销毁，等在这儿毫无意义；真正的生成跑在页面里，关掉弹窗也不会中断。
  void sendToTab(agent.tab.id, { type: "agent:crmCompose" });
});

void render();
