/**
 * 消息推送中心 · 企业微信。
 *
 * 两种官方推送方式：
 *  - 自建应用：CorpID + AgentID + Secret，能私聊指定成员（接收人可写邮箱或企业微信 UserID）。
 *  - 群机器人：一个 Webhook 地址，发到群里，不需要可信 IP，但不能指定个人。
 *
 * 推什么由规则决定：开发信首次打开 / 再次打开 / 链接点击 / 客户回信 / 广告表单线索。
 * 配置存在服务端（Secret 加密、只写不读），推送结果留在服务端的最近 200 条记录里。
 */
import { escapeHtml, qs, qsa } from "./shared";
import { api, setButtonPending, toast } from "./ui";

type WecomMode = "app" | "robot";

interface WecomRules {
  emailOpened: boolean;
  emailReopened: boolean;
  emailClicked: boolean;
  emailReplied: boolean;
  leadAds: boolean;
  outreachSummary: boolean;
  outreachRound: boolean;
}

interface WecomSettingsView {
  enabled: boolean;
  mode: WecomMode;
  corpId: string;
  agentId: string;
  secretSet: boolean;
  robotSet: boolean;
  sendToOwner: boolean;
  recipients: string[];
  rules: WecomRules;
  updatedAt: string;
  configured: boolean;
}

interface WecomLogEntry {
  id: string;
  at: string;
  key: string;
  event: string;
  title: string;
  recipients: string;
  status: "sent" | "failed" | "skipped";
  message: string;
}

interface WecomPushPayload {
  settings: WecomSettingsView;
  canManage: boolean;
  log: WecomLogEntry[];
  stats: { sent: number; failed: number; lastSentAt: string };
}

const RULE_OPTIONS: Array<{ key: keyof WecomRules; label: string; hint: string }> = [
  { key: "emailOpened", label: "开发信首次被打开", hint: "客户第一次读这封信" },
  { key: "emailReopened", label: "开发信再次被打开", hint: "同一封信被读了第 2 次及以上" },
  { key: "emailClicked", label: "开发信里的链接被点击", hint: "点了正文里的网址" },
  { key: "emailReplied", label: "客户回信", hint: "对方真的回了邮件（最该盯的）" },
  { key: "leadAds", label: "广告表单新线索", hint: "Facebook / 社交表单进了新线索" },
  { key: "outreachRound", label: "自动流本轮已发完", hint: "四步跑完、信真的发出去后推一条，不等总结邮件" },
  { key: "outreachSummary", label: "开发信发送总结已生成", hint: "一轮开发信发完，按发件邮箱各生成一份 Excel 并寄回该邮箱" }
];

const EVENT_LABELS: Record<string, string> = {
  "email.opened": "开发信被打开",
  "email.clicked": "链接被点击",
  "email.replied": "客户回信",
  "lead.ads": "广告表单线索",
  "outreach.round": "自动流本轮已发完",
  "outreach.summary": "发送总结已生成"
};

let wecomLoading = false;

function formatTime(iso: string) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function statusBadge(status: string) {
  if (status === "sent") return `<span class="badge green">已推送</span>`;
  if (status === "failed") return `<span class="badge red">失败</span>`;
  return `<span class="badge">已跳过</span>`;
}

function recipientsToText(list: string[]) {
  return (list || []).join("\n");
}

function textToRecipients(value: string) {
  return [...new Set(value.split(/[\s,，;；]+/u).map((item) => item.trim()).filter(Boolean))];
}

function setStatusBadge(settings: WecomSettingsView) {
  const badge = qs<HTMLElement>("#wecomPushStatus");
  if (!badge) return;
  badge.className = "badge";
  if (!settings.configured) {
    badge.classList.add("amber");
    badge.textContent = "未配置";
    return;
  }
  if (!settings.enabled) {
    badge.classList.add("amber");
    badge.textContent = "已保存，未启用";
    return;
  }
  badge.classList.add("green");
  badge.textContent = settings.mode === "robot" ? "已启用 · 群机器人" : "已启用 · 自建应用";
}

function syncModeFields() {
  const mode = (qs<HTMLSelectElement>("#wecomPushMode")?.value || "app") as WecomMode;
  const appFields = qs<HTMLElement>("#wecomPushAppFields");
  const robotFields = qs<HTMLElement>("#wecomPushRobotFields");
  if (appFields) appFields.hidden = mode !== "app";
  if (robotFields) robotFields.hidden = mode !== "robot";
  if (appFields) appFields.style.display = mode === "app" ? "grid" : "none";
  if (robotFields) robotFields.style.display = mode === "robot" ? "grid" : "none";
}

function renderRules(rules: WecomRules) {
  const host = qs<HTMLElement>("#wecomPushRules");
  if (!host) return;
  host.innerHTML = RULE_OPTIONS.map((option) => `
    <label class="wecom-push-rule">
      <input type="checkbox" data-wecom-rule="${option.key}" ${rules[option.key] ? "checked" : ""}>
      <span><b>${escapeHtml(option.label)}</b><small>${escapeHtml(option.hint)}</small></span>
    </label>`).join("");
}

function renderLog(entries: WecomLogEntry[]) {
  const body = qs<HTMLElement>("#wecomPushLogBody");
  if (!body) return;
  if (!entries.length) {
    body.innerHTML = `<tr><td colspan="5" class="wecom-push-empty">还没有推送记录。配置好以后，开发信被打开或客户回信时会立刻出现在这里。</td></tr>`;
    return;
  }
  body.innerHTML = entries.slice(0, 30).map((entry) => `
    <tr>
      <td>${escapeHtml(formatTime(entry.at))}</td>
      <td>${escapeHtml(EVENT_LABELS[entry.event] || entry.title || entry.event)}</td>
      <td>${escapeHtml(entry.recipients || "—")}</td>
      <td>${statusBadge(entry.status)}</td>
      <td class="wecom-push-log-message">${escapeHtml(entry.message || "—")}</td>
    </tr>`).join("");
}

function fillForm(payload: WecomPushPayload) {
  const settings = payload.settings;
  const enabled = qs<HTMLInputElement>("#wecomPushEnabled");
  if (enabled) enabled.checked = Boolean(settings.enabled);
  const mode = qs<HTMLSelectElement>("#wecomPushMode");
  if (mode) mode.value = settings.mode || "app";
  const corpId = qs<HTMLInputElement>("#wecomPushCorpId");
  if (corpId) corpId.value = settings.corpId || "";
  const agentId = qs<HTMLInputElement>("#wecomPushAgentId");
  if (agentId) agentId.value = settings.agentId || "";
  const secret = qs<HTMLInputElement>("#wecomPushSecret");
  if (secret) {
    secret.value = "";
    secret.placeholder = settings.secretSet ? "已保存，留空表示不修改" : "应用详情页里的 Secret";
  }
  const webhook = qs<HTMLInputElement>("#wecomPushRobotWebhook");
  if (webhook) {
    webhook.value = "";
    webhook.placeholder = settings.robotSet
      ? "已保存，留空表示不修改；填 - 可清除"
      : "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…";
  }
  const sendToOwner = qs<HTMLInputElement>("#wecomPushSendToOwner");
  if (sendToOwner) sendToOwner.checked = Boolean(settings.sendToOwner);
  const recipients = qs<HTMLTextAreaElement>("#wecomPushRecipients");
  if (recipients) recipients.value = recipientsToText(settings.recipients);
  renderRules(settings.rules);
  renderLog(payload.log);
  setStatusBadge(settings);
  syncModeFields();

  const canManage = payload.canManage;
  qsa<HTMLButtonElement>("#wecomPushSection button").forEach((button) => {
    if (button.dataset.wecomAction) button.disabled = !canManage;
  });
  const readonlyHint = qs<HTMLElement>("#wecomPushReadonlyHint");
  if (readonlyHint) readonlyHint.hidden = canManage;

  const updated = qs<HTMLElement>("#wecomPushUpdatedAt");
  if (updated) {
    updated.textContent = settings.updatedAt
      ? `最近保存：${formatTime(settings.updatedAt)} · 累计成功 ${payload.stats.sent} 条${payload.stats.failed ? ` · 失败 ${payload.stats.failed} 条` : ""}`
      : "还没有保存过配置。";
  }
}

function collectPayload() {
  const rules = { ...({} as WecomRules) };
  for (const option of RULE_OPTIONS) {
    const input = qs<HTMLInputElement>(`input[data-wecom-rule="${option.key}"]`);
    rules[option.key] = Boolean(input?.checked);
  }
  const secret = qs<HTMLInputElement>("#wecomPushSecret")?.value.trim() || "";
  const robotWebhook = qs<HTMLInputElement>("#wecomPushRobotWebhook")?.value.trim() || "";
  return {
    enabled: Boolean(qs<HTMLInputElement>("#wecomPushEnabled")?.checked),
    mode: (qs<HTMLSelectElement>("#wecomPushMode")?.value || "app") as WecomMode,
    corpId: qs<HTMLInputElement>("#wecomPushCorpId")?.value.trim() || "",
    agentId: qs<HTMLInputElement>("#wecomPushAgentId")?.value.trim() || "",
    ...(secret ? { secret } : {}),
    ...(robotWebhook ? { robotWebhook } : {}),
    sendToOwner: Boolean(qs<HTMLInputElement>("#wecomPushSendToOwner")?.checked),
    recipients: textToRecipients(qs<HTMLTextAreaElement>("#wecomPushRecipients")?.value || ""),
    rules
  };
}

export async function loadWecomPushSettings(options: { silent?: boolean } = {}) {
  if (!qs<HTMLElement>("#wecomPushSection")) return;
  if (wecomLoading) return;
  wecomLoading = true;
  try {
    const payload = await api<WecomPushPayload>("/api/notify/wecom");
    fillForm(payload);
  } catch (error) {
    if (!options.silent) toast(error instanceof Error ? error.message : "企业微信推送配置加载失败", "error");
  } finally {
    wecomLoading = false;
  }
}

async function save(button: HTMLButtonElement | null) {
  const payload = collectPayload();
  try {
    setButtonPending(button, true, "保存推送配置", "保存中…");
    await api("/api/notify/wecom", { method: "PUT", body: JSON.stringify(payload) });
    toast(payload.enabled ? "企业微信推送已保存并启用" : "企业微信推送配置已保存（未启用）", "success");
    await loadWecomPushSettings({ silent: true });
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
  } finally {
    setButtonPending(button, false, "保存推送配置", "保存中…");
  }
}

async function sendTest(button: HTMLButtonElement | null) {
  try {
    setButtonPending(button, true, "发送测试消息", "发送中…");
    const result = await api<{ ok: boolean; delivered: string[]; failed: Array<{ recipient: string; reason: string }>; message: string }>(
      "/api/notify/wecom/test",
      { method: "POST", body: JSON.stringify({}) }
    );
    if (result.ok) toast(`测试消息已送达：${(result.delivered || []).join("、")}`, "success");
    else toast(result.message || "测试消息没有送达", "error");
    await loadWecomPushSettings({ silent: true });
  } catch (error) {
    toast(error instanceof Error ? error.message : "测试消息发送失败", "error");
  } finally {
    setButtonPending(button, false, "发送测试消息", "发送中…");
  }
}

/** 幂等绑定：settings 视图每次进入都会调，用 onclick 覆盖而不是累计监听 */
export function initWecomPush() {
  const saveButton = qs<HTMLButtonElement>("#wecomPushSaveButton");
  if (saveButton) saveButton.dataset.wecomAction = "save";
  if (saveButton) saveButton.onclick = () => void save(saveButton);
  const testButton = qs<HTMLButtonElement>("#wecomPushTestButton");
  if (testButton) testButton.dataset.wecomAction = "test";
  if (testButton) testButton.onclick = () => void sendTest(testButton);
  const mode = qs<HTMLSelectElement>("#wecomPushMode");
  if (mode) mode.onchange = () => syncModeFields();
  const refreshButton = qs<HTMLButtonElement>("#wecomPushRefreshButton");
  if (refreshButton) refreshButton.onclick = () => void loadWecomPushSettings();
  void loadWecomPushSettings({ silent: true });
}
