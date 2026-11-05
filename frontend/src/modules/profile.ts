/**
 * 个人资料、已读追踪、发件邮箱池、开发信预览。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { closeModal, confirmAction, openModal, state } from "../prototype-api";
import { type User } from "./models";
import { formatTime } from "./dashboard";
import { badge, escapeHtml, qs, qsa, roleLabel, setFieldValue, storage } from "./shared";
import { loadCompanyProfile, renderEmailConfigurationReminders } from "./development-email";
import { api, setButtonPending, toast } from "./ui";
import { applyAuthedUser, roleScopeText, updateProfileSmtpHints } from "./auth";

export function renderProfile(user = state.user) {
  if (!user) return;
  const avatar = qs<HTMLElement>("#profileAvatarLarge");
  const name = qs<HTMLElement>("#profileNameTitle");
  const role = qs<HTMLElement>("#profileRoleText");
  const status = qs<HTMLElement>("#profileEmailStatus");
  const signatureStatus = qs<HTMLElement>("#profileSignatureStatus");
  const teamText = user.teamId === "all" ? "全局团队" : `${user.teamId} 组`;
  const mailReady = Boolean(user.outboundEmail);
  if (avatar) avatar.textContent = user.avatar;
  if (name) name.textContent = user.name;
  const effectiveRoleName = state.iamCapabilities?.roleNames.join(" / ") || user.iamRoleNames?.join(" / ") || roleLabel[user.role];
  if (role) role.textContent = `${effectiveRoleName} · ${roleScopeText(user)}`;
  qs<HTMLElement>("#profileStatusBadge")!.textContent = "账号正常";
  qs<HTMLElement>("#profileTeamBadge")!.textContent = teamText;
  const emailBadge = qs<HTMLElement>("#profileEmailBadge");
  if (emailBadge) {
    emailBadge.className = `badge ${mailReady ? "green" : "amber"}`;
    emailBadge.textContent = mailReady ? "发件邮箱已绑定" : "发件邮箱待绑定";
  }
  const allScopes = Object.values(state.iamCapabilities?.permissions || user.iamPermissions || {}).flat();
  qs<HTMLElement>("#profileScopeMetric")!.textContent = user.iamSource === "platform" || state.iamCapabilities?.source === "platform"
    ? "平台运维"
    : allScopes.includes("tenant") ? "公司范围" : allScopes.includes("org_subtree") || allScopes.includes("org_unit") ? "组织范围" : "本人业务";
  qs<HTMLElement>("#profileRoleMetric")!.textContent = effectiveRoleName;
  qs<HTMLElement>("#profileMailMetric")!.textContent = mailReady && user.smtpHost && user.hasSmtpPassword ? "可真实发信" : mailReady ? "待配SMTP" : "未绑定";
  qs<HTMLElement>("#profileLoginEmailText")!.textContent = user.email;
  qs<HTMLElement>("#profileIdText")!.textContent = user.id;
  qs<HTMLElement>("#profileScopeText")!.textContent = roleScopeText(user);
  setFieldValue("#profileLoginEmail", user.email);
  setFieldValue("#profileOutboundEmail", user.outboundEmail || "");
  setFieldValue("#profileSenderName", user.emailSenderName || "");
  setFieldValue("#profileEmailSignature", user.emailSignature || "");
  setFieldValue("#profileSmtpHost", user.smtpHost || "");
  setFieldValue("#profileSmtpPort", String(user.smtpPort || 465));
  setFieldValue("#profileSmtpUser", user.smtpUser || "");
  setFieldValue("#profileSmtpPassword", "");
  setFieldValue("#profileTestEmailTo", "");
  const smtpSecure = qs<HTMLSelectElement>("#profileSmtpSecure");
  if (smtpSecure) smtpSecure.value = String(user.smtpSecure ?? true);
  if (status) status.innerHTML = user.outboundEmail ? `${badge("已绑定", "green")} ${escapeHtml(user.outboundEmail)}` : `${badge("未绑定", "amber")} 请先绑定发件邮箱`;
  if (signatureStatus) signatureStatus.innerHTML = user.emailSignature?.trim() ? `${badge("已设置", "green")} ${escapeHtml((user.emailSignature.split("\n")[0] || "签名已维护").slice(0, 36))}` : badge("待完善", "amber");
  const smtpStatus = qs<HTMLElement>("#profileSmtpStatus");
  if (smtpStatus) smtpStatus.innerHTML = user.smtpHost && user.smtpUser && user.hasSmtpPassword ? `${badge("已配置", "green")} ${escapeHtml(user.smtpHost)}` : `${badge("未完整", "amber")} 填写SMTP后才能真实发信`;
  const imapEnabled = qs<HTMLInputElement>("#profileImapEnabled");
  if (imapEnabled) imapEnabled.checked = Boolean(user.inboundSyncEnabled);
  setFieldValue("#profileImapHost", user.imapHost || "");
  setFieldValue("#profileImapPort", String(user.imapPort || 993));
  setFieldValue("#profileImapUser", user.imapUser || "");
  setFieldValue("#profileImapPassword", "");
  const imapSecure = qs<HTMLSelectElement>("#profileImapSecure");
  if (imapSecure) imapSecure.value = String(user.imapSecure ?? true);
  const imapSync = qs<HTMLElement>("#profileImapSyncStatus");
  if (imapSync) {
    if (user.lastInboundSyncAt) {
      const label = user.lastInboundSyncStatus === "error" ? "同步异常" : "已同步";
      const cls = user.lastInboundSyncStatus === "error" ? "amber" : "green";
      imapSync.innerHTML = `${badge(label, cls)} <span title="${escapeHtml(user.lastInboundSyncError || "")}">${escapeHtml(formatTime(user.lastInboundSyncAt))}</span>`;
    } else {
      imapSync.textContent = user.inboundSyncEnabled ? "等待首次同步" : "尚未开启";
    }
  }
  updateProfileSmtpHints(user);
  renderEmailConfigurationReminders();
  void loadCompanyProfile();
  void loadSenderMailboxes();
  void loadEmailTrackingConfig();
}

// ---------------------------------------------------------------------------
// 发件邮箱池：登记多个 SMTP 发件邮箱，自动发信方案按「每 N 封」轮换使用
// ---------------------------------------------------------------------------

interface SenderMailboxView {
  id: string;
  label: string;
  email: string;
  fromName: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  imapHost: string;
  imapPort: number;
  imapUser: string;
  enabled: boolean;
  hasSmtpPassword: boolean;
  hasImapPassword: boolean;
}

// ── 已读追踪配置（个人设置 → 已读追踪）─────────────────────────────
interface EmailTrackingConfigView {
  enabled: boolean;
  baseUrl: string;
  source: string;
  messageIdDomain: string;
  secretConfigured: boolean;
}

export async function loadEmailTrackingConfig() {
  const box = qs<HTMLElement>("#trackingConfigStatus");
  if (!box) return;
  try {
    const { config } = await api<{ config: EmailTrackingConfigView }>("/api/email-tracking/config");
    const input = qs<HTMLInputElement>("#trackingBaseUrlInput");
    if (input && document.activeElement !== input) input.value = config.baseUrl;
    box.innerHTML = config.enabled
      ? `<span class="badge green">已开启</span> <small>信号回传域名 <b>${escapeHtml(config.messageIdDomain)}</b> · 来源 ${config.source === "app_settings" ? "本页配置" : "环境变量"}</small>`
      : `<span class="badge gray">未开启</span> <small>发出的开发信不含追踪像素，无法得知客户是否打开</small>`;
  } catch (error) {
    box.innerHTML = `<span class="badge amber">读取失败</span> <small>${escapeHtml(error instanceof Error ? error.message : "未知错误")}</small>`;
  }
}

export async function saveEmailTrackingConfig(button?: HTMLButtonElement | null) {
  const input = qs<HTMLInputElement>("#trackingBaseUrlInput");
  if (!input) return;
  const baseUrl = input.value.trim();
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
    toast("地址必须以 http:// 或 https:// 开头", "error");
    return;
  }
  setButtonPending(button ?? null, true, "保存", "保存中");
  try {
    const { config } = await api<{ config: EmailTrackingConfigView }>("/api/email-tracking/config", { method: "PUT", body: JSON.stringify({ baseUrl }) });
    toast(config.enabled ? "已读追踪已开启：之后发出的开发信会带回打开/点击信号" : "已读追踪已关闭：信件按纯文本发送");
    await loadEmailTrackingConfig();
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存已读追踪配置失败", "error");
  } finally {
    setButtonPending(button ?? null, false, "保存", "保存中");
  }
}

let senderMailboxes: SenderMailboxView[] = [];

export async function loadSenderMailboxes() {
  const list = qs<HTMLElement>("#mailboxPoolList");
  if (!list) return;
  try {
    const result = await api<{ mailboxes: SenderMailboxView[] }>("/api/sender-mailboxes");
    senderMailboxes = result.mailboxes || [];
  } catch (error) {
    senderMailboxes = [];
    list.innerHTML = `<div class="empty-cell">读取失败：${escapeHtml(error instanceof Error ? error.message : "未知错误")}</div>`;
    return;
  }
  renderSenderMailboxList();
}

function renderSenderMailboxList() {
  const list = qs<HTMLElement>("#mailboxPoolList");
  if (!list) return;
  if (!senderMailboxes.length) {
    list.innerHTML = `<div class="mailbox-pool-empty">还没有登记发件邮箱。主发件邮箱始终可用；登记 2 个以上并启用后，方案即可按「每 N 封」轮换发送。</div>`;
    return;
  }
  list.innerHTML = senderMailboxes.map((mailbox, index) => {
    const status = !mailbox.enabled ? `<span class="badge gray">已停用</span>`
      : mailbox.hasSmtpPassword ? `<span class="badge green">可用</span>`
      : `<span class="badge amber">缺授权码</span>`;
    const primary = mailbox.email === (state.user?.outboundEmail || "") ? `<span class="badge" style="background:#eef4fc;border-color:#d5e3f6;color:#1f5fa8">同主邮箱</span>` : "";
    return `<div class="mailbox-pool-row${mailbox.enabled ? "" : " is-off"}" style="--mb-i:${index}">
      <div class="mailbox-pool-main">
        <b>${escapeHtml(mailbox.label || mailbox.email)}${primary}</b>
        <small>${escapeHtml(mailbox.email)} · ${escapeHtml(mailbox.smtpHost)}:${mailbox.smtpPort} ${mailbox.smtpSecure ? "SSL" : "STARTTLS"}${mailbox.fromName ? ` · 发件人 ${escapeHtml(mailbox.fromName)}` : ""}</small>
      </div>
      <div class="mailbox-pool-side">${status}</div>
      <div class="mailbox-pool-actions">
        <button class="btn tiny" data-mailbox-test="${escapeHtml(mailbox.id)}" ${mailbox.hasSmtpPassword ? "" : "disabled title=\"缺授权码，先编辑补全\""}>测试</button>
        <button class="btn tiny" data-mailbox-edit="${escapeHtml(mailbox.id)}">编辑</button>
        <button class="btn tiny danger subtle" data-mailbox-remove="${escapeHtml(mailbox.id)}">删除</button>
      </div>
    </div>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-mailbox-test]", list).forEach((button) => button.addEventListener("click", () => void testSenderMailbox(button.dataset.mailboxTest || "", button)));
  qsa<HTMLButtonElement>("[data-mailbox-edit]", list).forEach((button) => button.addEventListener("click", () => {
    const mailbox = senderMailboxes.find((row) => row.id === button.dataset.mailboxEdit);
    if (mailbox) openSenderMailboxModal(mailbox);
  }));
  qsa<HTMLButtonElement>("[data-mailbox-remove]", list).forEach((button) => button.addEventListener("click", () => void removeSenderMailbox(button.dataset.mailboxRemove || "")));
}

export function openSenderMailboxModal(mailbox?: SenderMailboxView) {
  const title = mailbox ? "编辑发件邮箱" : "登记发件邮箱";
  const body = `
    <div class="form-grid">
      <div class="form-field"><label>备注名称</label><input id="smbLabel" placeholder="例如 腾讯企业邮 2 号" value="${escapeHtml(mailbox?.label || "")}"></div>
      <div class="form-field"><label>发件邮箱 *</label><input id="smbEmail" placeholder="sales2@your-company.com" value="${escapeHtml(mailbox?.email || "")}"></div>
      <div class="form-field"><label>发件人显示名</label><input id="smbFromName" placeholder="留空 = 沿用账号发件人名称" value="${escapeHtml(mailbox?.fromName || "")}"></div>
      <div class="form-field"><label>SMTP服务器 *</label><input id="smbSmtpHost" placeholder="smtp.exmail.qq.com" value="${escapeHtml(mailbox?.smtpHost || "")}"></div>
      <div class="form-field"><label>SMTP端口</label><input id="smbSmtpPort" type="number" min="1" max="65535" value="${mailbox?.smtpPort || 465}"></div>
      <div class="form-field"><label>加密方式</label><select id="smbSmtpSecure"><option value="true"${mailbox?.smtpSecure === false ? "" : " selected"}>SSL/TLS（465）</option><option value="false"${mailbox?.smtpSecure === false ? " selected" : ""}>STARTTLS/普通（587）</option></select></div>
      <div class="form-field"><label>SMTP账号 *</label><input id="smbSmtpUser" placeholder="通常与发件邮箱一致" value="${escapeHtml(mailbox?.smtpUser || "")}"></div>
      <div class="form-field"><label>SMTP授权码 ${mailbox ? "（留空 = 保留原授权码）" : "*"}</label><input id="smbSmtpPassword" type="password" placeholder="${mailbox ? "输入后覆盖保存" : "授权码/客户端专用密码"}"></div>
      <div class="form-field"><label>IMAP服务器（可选）</label><input id="smbImapHost" placeholder="留空 = 按 SMTP 主机推导" value="${escapeHtml(mailbox?.imapHost || "")}"></div>
      <div class="form-field"><label>IMAP账号（可选）</label><input id="smbImapUser" placeholder="留空 = 同 SMTP 账号" value="${escapeHtml(mailbox?.imapUser || "")}"></div>
      <div class="form-field"><label>IMAP授权码（可选）</label><input id="smbImapPassword" type="password" placeholder="留空 = 同 SMTP 授权码"></div>
      <label class="form-field" style="display:flex;gap:8px;align-items:center"><input id="smbEnabled" type="checkbox"${!mailbox || mailbox.enabled ? " checked" : ""}>启用（参与轮换）</label>
    </div>`;
  const foot = `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="smbSaveButton">${mailbox ? "保存修改" : "登记"}</button>`;
  openModal(title, body, foot, { closeOnBackdrop: false });
  qs<HTMLElement>("#appModal .modal")?.classList.add("sender-mailbox-modal");
  qsa("[data-modal-close]").forEach((node) => node.addEventListener("click", closeModal));
  qs<HTMLButtonElement>("#smbSaveButton")?.addEventListener("click", (event) => void saveSenderMailboxModal(event.currentTarget as HTMLButtonElement, mailbox?.id));
}

async function saveSenderMailboxModal(button?: HTMLButtonElement, id?: string) {
  const payload = {
    label: qs<HTMLInputElement>("#smbLabel")?.value.trim() || "",
    email: qs<HTMLInputElement>("#smbEmail")?.value.trim() || "",
    fromName: qs<HTMLInputElement>("#smbFromName")?.value.trim() || "",
    smtpHost: qs<HTMLInputElement>("#smbSmtpHost")?.value.trim() || "",
    smtpPort: Number(qs<HTMLInputElement>("#smbSmtpPort")?.value || 465),
    smtpSecure: qs<HTMLSelectElement>("#smbSmtpSecure")?.value !== "false",
    smtpUser: qs<HTMLInputElement>("#smbSmtpUser")?.value.trim() || "",
    smtpPassword: qs<HTMLInputElement>("#smbSmtpPassword")?.value || "",
    imapHost: qs<HTMLInputElement>("#smbImapHost")?.value.trim() || "",
    imapUser: qs<HTMLInputElement>("#smbImapUser")?.value.trim() || "",
    imapPassword: qs<HTMLInputElement>("#smbImapPassword")?.value || "",
    enabled: qs<HTMLInputElement>("#smbEnabled")?.checked ?? true
  };
  if (!payload.email || !payload.smtpHost || !payload.smtpUser || (!id && !payload.smtpPassword)) {
    toast("带 * 的字段都要填写（编辑时授权码可留空保留）", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = id ? "保存中" : "登记中";
  }
  try {
    await api(id ? `/api/sender-mailboxes/${encodeURIComponent(id)}` : "/api/sender-mailboxes", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(payload)
    });
    closeModal();
    toast(id ? "发件邮箱已更新" : "发件邮箱已登记", "success");
    await loadSenderMailboxes();
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
    if (button) {
      button.disabled = false;
      button.textContent = id ? "保存修改" : "登记";
    }
  }
}

async function testSenderMailbox(id: string, button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    const result = await api<{ to: string; simulated?: boolean }>(`/api/sender-mailboxes/${encodeURIComponent(id)}/test`, { method: "POST", body: "{}" });
    toast(result.simulated ? "测试邮件已生成（测试环境未外发）" : `测试邮件已发送到 ${result.to}，请查收`, "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "测试失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "测试";
    }
  }
}

async function removeSenderMailbox(id: string) {
  const mailbox = senderMailboxes.find((row) => row.id === id);
  const ok = await confirmAction({
    title: `删除发件邮箱「${mailbox?.label || mailbox?.email || id}」`,
    message: "删除后轮换序列里不再使用这个邮箱，正在运行的方案会自动跳过它。",
    consequences: ["该邮箱从发件邮箱池移除", "已发出的邮件与台账记录不受影响"],
    confirmLabel: "删除",
    tone: "danger"
  });
  if (!ok) return;
  try {
    await api(`/api/sender-mailboxes/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast("发件邮箱已删除", "success");
    await loadSenderMailboxes();
  } catch (error) {
    toast(error instanceof Error ? error.message : "删除失败", "error");
  }
}

function collectDevelopmentEmailDraft() {
  const sender = qs<HTMLInputElement>("#profileSenderName")?.value.trim() || state.user?.name || "GoodJob Sales";
  const from = qs<HTMLInputElement>("#profileOutboundEmail")?.value.trim() || state.user?.outboundEmail || "";
  const signature = qs<HTMLTextAreaElement>("#profileEmailSignature")?.value.trim() || "";
  return {
    to: qs<HTMLInputElement>("#devEmailTo")?.value.trim() || "",
    company: qs<HTMLInputElement>("#devEmailCompany")?.value.trim() || "",
    subject: qs<HTMLInputElement>("#devEmailSubject")?.value.trim() || "",
    body: qs<HTMLTextAreaElement>("#devEmailBody")?.value.trim() || "",
    sender,
    from,
    signature
  };
}

function renderDevelopmentEmailPreview() {
  const draft = collectDevelopmentEmailDraft();
  const preview = qs<HTMLElement>("#devEmailPreview");
  if (!preview) return;
  preview.textContent = [
    `From: ${draft.sender}${draft.from ? ` <${draft.from}>` : " <未绑定>"}`,
    `To: ${draft.to || "未填写"}`,
    `Subject: ${draft.subject || "未填写"}`,
    "",
    draft.body || "填写内容后可预览开发信。"
  ].join("\n");
}

export function updateStoredUser(user: User) {
  state.user = user;
  localStorage.setItem(storage.user, JSON.stringify(user));
  applyAuthedUser(user);
}

export async function saveProfileEmailBinding(button?: HTMLButtonElement, clearSmtpPassword = false, clearImapPassword = false) {
  const outboundEmail = qs<HTMLInputElement>("#profileOutboundEmail")?.value.trim() || "";
  const emailSenderName = qs<HTMLInputElement>("#profileSenderName")?.value.trim() || "";
  const emailSignature = qs<HTMLTextAreaElement>("#profileEmailSignature")?.value.trim() || "";
  const smtpHost = qs<HTMLInputElement>("#profileSmtpHost")?.value.trim() || "";
  const smtpPort = Number(qs<HTMLInputElement>("#profileSmtpPort")?.value || 465);
  const smtpSecure = qs<HTMLSelectElement>("#profileSmtpSecure")?.value !== "false";
  const smtpUser = qs<HTMLInputElement>("#profileSmtpUser")?.value.trim() || "";
  const smtpPassword = qs<HTMLInputElement>("#profileSmtpPassword")?.value || "";
  const inboundSyncEnabled = qs<HTMLInputElement>("#profileImapEnabled")?.checked || false;
  const imapHost = qs<HTMLInputElement>("#profileImapHost")?.value.trim() || "";
  const imapPort = Number(qs<HTMLInputElement>("#profileImapPort")?.value || 993);
  const imapSecure = qs<HTMLSelectElement>("#profileImapSecure")?.value !== "false";
  const imapUser = qs<HTMLInputElement>("#profileImapUser")?.value.trim() || "";
  const imapPassword = qs<HTMLInputElement>("#profileImapPassword")?.value || "";
  const idleText = clearSmtpPassword ? "清空邮箱绑定" : "保存个人资料";
  if (button) {
    button.disabled = true;
    button.textContent = clearSmtpPassword ? "清空中" : "保存中";
  }
  try {
    const result = await api<{ user: User }>("/api/profile/email-binding", {
      method: "PATCH",
      body: JSON.stringify({ outboundEmail, emailSenderName, emailSignature, smtpHost, smtpPort, smtpSecure, smtpUser, smtpPassword, clearSmtpPassword, imapHost, imapPort, imapSecure, imapUser, imapPassword, clearImapPassword, inboundSyncEnabled })
    });
    updateStoredUser(result.user);
    if (clearImapPassword && !clearSmtpPassword) toast("IMAP 密码已清除");
    else toast(outboundEmail ? "个人邮箱配置已保存" : "个人邮箱配置已清空");
  } catch (error) {
    toast(error instanceof Error ? error.message : "个人邮箱配置保存失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = idleText;
    }
  }
}

export async function changeProfilePassword(button?: HTMLButtonElement) {
  const currentPassword = qs<HTMLInputElement>("#profileCurrentPassword")?.value || "";
  const newPassword = qs<HTMLInputElement>("#profileNewPassword")?.value || "";
  const confirmPassword = qs<HTMLInputElement>("#profileConfirmPassword")?.value || "";
  if (!currentPassword) {
    toast("请输入当前密码", "error");
    return;
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    toast("新密码长度需要为 8 至 128 位", "error");
    return;
  }
  if (newPassword !== confirmPassword) {
    toast("两次输入的新密码不一致", "error");
    return;
  }
  if (button) setButtonPending(button, true, "修改登录密码", "保存中");
  try {
    await api<{ requiresRelogin: boolean; message: string }>("/api/profile/password", {
      method: "PATCH",
      body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
    });
    ["#profileCurrentPassword", "#profileNewPassword", "#profileConfirmPassword"].forEach((selector) => setFieldValue(selector, ""));
    setFieldValue("#loginPassword", "");
    localStorage.removeItem(storage.user);
    state.user = null;
    state.iamCapabilities = null;
    document.body.classList.remove("is-authenticated");
    toast("密码已修改，请使用新密码重新登录", "success");
  } catch (error) {
    toast(error instanceof Error ? error.message : "密码修改失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "修改登录密码", "保存中");
  }
}

export async function clearProfileEmailBinding(button?: HTMLButtonElement) {
  if (!await confirmAction({
    title: "清空发件邮箱绑定",
    message: "将清除当前账号的发件邮箱配置。",
    consequences: ["SMTP 主机、账号和授权码会被清空", "发件人名称与邮件签名会被清空", "重新配置前无法从 CRM 发信"],
    confirmLabel: "清空绑定"
  })) return;
  setFieldValue("#profileOutboundEmail", "");
  setFieldValue("#profileSenderName", "");
  setFieldValue("#profileEmailSignature", "");
  setFieldValue("#profileSmtpHost", "");
  setFieldValue("#profileSmtpPort", "465");
  setFieldValue("#profileSmtpUser", "");
  setFieldValue("#profileSmtpPassword", "");
  setFieldValue("#profileTestEmailTo", "");
  await saveProfileEmailBinding(button, true);
}

export async function clearProfileImapPassword(button?: HTMLButtonElement) {
  if (!await confirmAction({
    title: "清除 IMAP 授权码",
    message: "将清除当前账号保存的收信授权码。",
    consequences: ["收信监听将在下次同步时停止", "重新填写有效授权码后才会恢复"],
    confirmLabel: "清除授权码"
  })) return;
  setFieldValue("#profileImapPassword", "");
  await saveProfileEmailBinding(button, false, true);
}

export async function sendProfileTestEmail(button?: HTMLButtonElement) {
  const to = qs<HTMLInputElement>("#profileTestEmailTo")?.value.trim() || "";
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    const result = await api<{ ok: boolean; simulated: boolean; messageId?: string; to?: string }>("/api/profile/test-email", {
      method: "POST",
      body: JSON.stringify({ to })
    });
    toast(result.simulated ? "测试邮件已生成（测试环境未外发）" : "测试邮件已发送，请检查发件邮箱收件箱");
  } catch (error) {
    toast(error instanceof Error ? error.message : "测试邮件发送失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "发送测试邮件";
    }
  }
}

export async function testProfileImap(button?: HTMLButtonElement) {
  if (button) setButtonPending(button, true, "测试 IMAP", "连接中");
  try {
    await api<{ ok: boolean }>("/api/profile/inbound-mail/test", { method: "POST" });
    toast("IMAP 连接成功，可以接收回信和退信");
  } catch (error) {
    toast(error instanceof Error ? error.message : "IMAP 连接失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "测试 IMAP", "连接中");
  }
}

export async function checkProfileEmailDomain(button?: HTMLButtonElement) {
  if (button) setButtonPending(button, true, "域名检测", "检测中");
  try {
    const result = await api<{ authentication: {
      domain: string;
      ready: boolean;
      spf: { ok: boolean };
      dmarc: { ok: boolean };
      dkim: { ok: boolean; selector: string; definitive: boolean };
    } }>("/api/profile/email-domain-authentication");
    const auth = result.authentication;
    const line = (label: string, ok: boolean, detail = "") =>
      `<div class="profile-info-row"><span>${escapeHtml(label)}</span><b>${badge(ok ? "通过" : "待配置", ok ? "green" : "amber")} ${escapeHtml(detail)}</b></div>`;
    openModal(`发件域名检测 · ${auth.domain}`, `
      <div class="profile-info-list">
        ${line("SPF", auth.spf.ok)}
        ${line("DMARC", auth.dmarc.ok)}
        ${line("DKIM", auth.dkim.ok, auth.dkim.selector ? `selector: ${auth.dkim.selector}` : auth.dkim.definitive ? "指定 selector 未发现" : "请向邮箱服务商确认 selector")}
      </div>
      <div class="form-hint" style="margin-top:12px">检测通过可显著降低进入垃圾邮件的风险，但不能保证送达；DKIM selector 由邮箱服务商提供。</div>
    `, `<button class="btn primary" data-modal-close>关闭</button>`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "域名检测失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "域名检测", "检测中");
  }
}
