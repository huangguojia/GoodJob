/**
 * 线索。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, openBackgroundResearch, openModal, renderProspectList, state } from "../prototype-api";
import {
  type Customer, type Deal, type DealRecommendation, type Lead, type LeadActivity, type LeadConversionMatch,
  type LeadSourceEvent, type ProcurementContext
} from "./models";
import {
  LEAD_ACTIVITY_LABEL, LEAD_PAGE_SIZE, LEAD_STAGES, LEAD_STATUS_LABEL, LEAD_STATUS_TONE, leadFollowState,
  leadSourceLabel, leadStageTone, refreshDashboardOnly
} from "./dashboard";
import { renderCustomers } from "./customers";
import {
  PROSPECT_PAGE_SIZE, bindProcurementContextActions, prospectFilteredRows, prospectRequestId,
  renderProcurementContextPanel
} from "./prospecting";
import { amount, badge, escapeHtml, qs, qsa } from "./shared";
import { countryFlag, isContactDockRowAction, leadContactDockSubject, refreshContactDock, selectLeadForContact } from "./customer-detail";
import { openDevelopmentEmail, openWhatsAppForContact, researchButtonIcon } from "./development-email";
import { whatsAppEntryAttrs, whatsAppEntryClass } from "./whatsapp";
import { api, toast } from "./ui";
import { defaultFutureDate, renderPipeline } from "./deals";

export function renderLeads() {
  const tbody = qs<HTMLElement>("#leadsTableBody");
  const cards = qs<HTMLElement>("#leadMobileList");
  if (!tbody || !cards) return;
  const chipsWrap = qs<HTMLElement>("#leadStageChips");
  const activeLeads = state.leadView === "trash" ? state.leadTrash : state.leads;
  const q = state.leadSearch.trim().toLowerCase();
  const sourceOptions = [...new Set(activeLeads.map(leadSourceLabel))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const sourceSelect = qs<HTMLSelectElement>("#leadSourceFilter");
  if (sourceSelect) {
    const selected = sourceOptions.includes(state.leadSourceFilter) ? state.leadSourceFilter : "all";
    state.leadSourceFilter = selected;
    sourceSelect.innerHTML = `<option value="all">全部来源</option>${sourceOptions.map((source) => `<option value="${escapeHtml(source)}">${escapeHtml(source)}</option>`).join("")}`;
    sourceSelect.value = selected;
  }
  const filtered = activeLeads.filter((lead) => {
    const matchStage = state.leadStageFilter === "all" || lead.stage === state.leadStageFilter;
    const matchIntent = state.leadIntentFilter === "all" || lead.intent === state.leadIntentFilter;
    const matchSource = state.leadSourceFilter === "all" || leadSourceLabel(lead) === state.leadSourceFilter;
    const matchFollow = state.leadFollowFilter === "all" || leadFollowState(lead) === state.leadFollowFilter;
    const matchReply = state.leadReplyFilter === "all" || Boolean(lead.lastEmailReplyAt);
    const haystack = [lead.company, lead.contact, lead.country, lead.email, lead.phone, lead.source, lead.sourceChannel, lead.externalId, lead.inquiryContent]
      .filter(Boolean).join(" ").toLowerCase();
    return matchStage && matchIntent && matchSource && matchFollow && matchReply && (!q || haystack.includes(q));
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / LEAD_PAGE_SIZE));
  state.leadPage = Math.min(state.leadPage, totalPages);
  const pageRows = filtered.slice((state.leadPage - 1) * LEAD_PAGE_SIZE, state.leadPage * LEAD_PAGE_SIZE);

  if (chipsWrap) {
    const counts = LEAD_STAGES.map((stage) => [stage, activeLeads.filter((lead) => lead.stage === stage).length] as const);
    chipsWrap.innerHTML = `<button class="filter lead-chip ${state.leadStageFilter === "all" ? "active" : ""}" data-lead-stage="all">全部 ${activeLeads.length}</button>` +
      counts.filter(([, count]) => count > 0).map(([stage, count]) => `<button class="filter lead-chip ${state.leadStageFilter === stage ? "active" : ""}" data-lead-stage="${escapeHtml(stage)}">${escapeHtml(stage)} ${count}</button>`).join("");
    qsa<HTMLElement>(".lead-chip", chipsWrap).forEach((chip) => {
      chip.addEventListener("click", () => {
        state.leadStageFilter = chip.dataset.leadStage || "all";
        state.leadPage = 1;
        renderLeads();
      });
    });
  }

  const replyFlag = (lead: { lastEmailReplyAt?: string }) => lead.lastEmailReplyAt
    ? `<span class="lead-reply-flag" title="客户已回复：${escapeHtml(new Date(lead.lastEmailReplyAt).toLocaleString("zh-CN"))}">✉</span>`
    : "";
  tbody.innerHTML = pageRows.length ? pageRows.map((lead) => `<tr data-lead-id="${lead.id}" class="${lead.id === state.selectedLeadId ? "selected" : ""}">
    <td><div class="company"><input type="checkbox" class="lead-row-check" data-lead-check="${lead.id}" ${state.selectedLeadIds.includes(lead.id) ? "checked" : ""} title="勾选加入发信批次">${countryFlag(lead.country)}<div><button class="lead-name" data-open-lead="${lead.id}">${escapeHtml(lead.company)}</button>${replyFlag(lead)}<span>${escapeHtml(lead.contact || "联系人待补充")} · ${escapeHtml(lead.country || "国家待补充")}${lead.email ? ` · ${escapeHtml(lead.email)}` : ""}</span></div></div></td>
    <td><div class="lead-decision-cell">${badge("意向" + lead.intent, lead.intent === "高" ? "red" : lead.intent === "中" ? "amber" : "gray")}${badge(lead.stage, leadStageTone(lead.stage))}</div></td>
    <td><div class="lead-follow-cell"><b>${escapeHtml(lead.nextFollowAt || "未安排")}</b><span>${leadFollowState(lead) === "overdue" ? "已逾期" : leadFollowState(lead) === "unset" ? "待安排" : "已计划"}</span></div></td>
    <td><div class="lead-source-cell"><b>${escapeHtml(leadSourceLabel(lead))}</b><span>${escapeHtml(lead.sourceCampaign || lead.externalId || "无活动编号")}</span></div></td>
    <td><div class="lead-created-cell"><b>${escapeHtml(formatLeadDate(lead.createdAt))}</b></div></td>
    <td>${badge(state.leadView === "trash" ? "垃圾箱" : (LEAD_STATUS_LABEL[lead.status] || lead.status), state.leadView === "trash" ? "red" : (LEAD_STATUS_TONE[lead.status] || ""))}</td>
    <td><div class="lead-row-actions">${state.leadView === "trash"
      ? `<button class="btn tiny" type="button" data-lead-row-action="restore" data-lead-row-id="${lead.id}">恢复</button>${lead.convertedCustomerId ? "" : `<button class="btn tiny danger" type="button" data-lead-row-action="permanent" data-lead-row-id="${lead.id}">永久删除</button>`}`
      : `<button class="btn tiny danger subtle" type="button" data-lead-row-action="trash" data-lead-row-id="${lead.id}">删除</button>`}</div></td>
  </tr>`).join("") : `<tr><td colspan="7" class="empty-cell">${state.leadView === "trash" ? "垃圾箱中没有符合条件的线索" : "暂无符合条件的线索"}</td></tr>`;

  cards.innerHTML = pageRows.length ? pageRows.map((lead) => `
    <article class="lead-mobile-card ${lead.id === state.selectedLeadId ? "selected" : ""}" data-lead-id="${lead.id}">
      <span class="lead-mobile-top"><button class="lead-name" data-open-lead="${lead.id}">${escapeHtml(lead.company)}</button>${replyFlag(lead)}${badge("意向" + lead.intent, lead.intent === "高" ? "red" : lead.intent === "中" ? "amber" : "gray")}</span>
      <span>${escapeHtml(lead.contact || "联系人待补充")} · ${escapeHtml(lead.country || "国家待补充")}${lead.email ? ` · ${escapeHtml(lead.email)}` : ""}</span>
      <span class="lead-mobile-meta"><i>${escapeHtml(lead.stage)}</i><i>${escapeHtml(leadSourceLabel(lead))}</i><i>${escapeHtml(lead.nextFollowAt || "待安排跟进")}</i><i>${escapeHtml(formatLeadDate(lead.createdAt))}</i></span>
      <span class="lead-mobile-actions">${state.leadView === "trash"
        ? `<button class="btn tiny" type="button" data-lead-row-action="restore" data-lead-row-id="${lead.id}">恢复</button>${lead.convertedCustomerId ? "" : `<button class="btn tiny danger" type="button" data-lead-row-action="permanent" data-lead-row-id="${lead.id}">永久删除</button>`}`
        : `<button class="btn tiny danger subtle" type="button" data-lead-row-action="trash" data-lead-row-id="${lead.id}">删除</button>`}</span>
    </article>`).join("") : `<div class="empty-cell">${state.leadView === "trash" ? "垃圾箱中没有符合条件的线索" : "暂无符合条件的线索"}</div>`;

  qsa<HTMLButtonElement>("[data-open-lead]", qs("#leads")!).forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.openLead || "";
    if (id) void openLead(id);
  }));
  qsa<HTMLElement>("tr[data-lead-id]", tbody).forEach((row) => {
    row.addEventListener("click", (event) => {
      if (isContactDockRowAction(event.target)) return;
      const lead = activeLeads.find((item) => item.id === row.dataset.leadId);
      if (lead) selectLeadForContact(lead);
    });
  });
  qsa<HTMLElement>("[data-lead-id]", cards).forEach((card) => {
    card.addEventListener("click", (event) => {
      if (isContactDockRowAction(event.target)) return;
      const lead = activeLeads.find((item) => item.id === card.dataset.leadId);
      if (lead) selectLeadForContact(lead);
    });
  });
  refreshContactDock("leads", (id) => {
    const lead = [...state.leads, ...state.leadTrash].find((item) => item.id === id);
    return lead ? leadContactDockSubject(lead) : null;
  });
  qsa<HTMLButtonElement>("[data-lead-row-action]", qs("#leads")!).forEach((button) => button.addEventListener("click", () => {
    const lead = activeLeads.find((item) => item.id === button.dataset.leadRowId);
    if (!lead) return;
    const action = button.dataset.leadRowAction;
    if (action === "trash") openLeadTrashModal(lead);
    if (action === "restore") void restoreLead(lead.id);
    if (action === "permanent") openLeadPermanentModal(lead);
  }));
  qsa<HTMLInputElement>(".lead-row-check", qs("#leads")!).forEach((box) => box.addEventListener("change", () => {
    const id = box.dataset.leadCheck || "";
    if (!id) return;
    if (box.checked && !state.selectedLeadIds.includes(id)) state.selectedLeadIds.push(id);
    if (!box.checked) state.selectedLeadIds = state.selectedLeadIds.filter((item) => item !== id);
    const createButton = qs<HTMLButtonElement>("#leadCreateOutreachBatchButton");
    if (createButton) createButton.textContent = state.selectedLeadIds.length ? `✉ 生成发信批次（${state.selectedLeadIds.length}）` : "✉ 生成发信批次";
  }));

  const pagination = qs<HTMLElement>("#leadPagination");
  if (pagination) {
    pagination.innerHTML = `<span>共 ${filtered.length} 条 · 第 ${state.leadPage}/${totalPages} 页</span><div><button class="btn tiny" id="leadPrevPage" ${state.leadPage <= 1 ? "disabled" : ""}>上一页</button><button class="btn tiny" id="leadNextPage" ${state.leadPage >= totalPages ? "disabled" : ""}>下一页</button></div>`;
    qs<HTMLButtonElement>("#leadPrevPage", pagination)?.addEventListener("click", () => { state.leadPage -= 1; renderLeads(); });
    qs<HTMLButtonElement>("#leadNextPage", pagination)?.addEventListener("click", () => { state.leadPage += 1; renderLeads(); });
  }

  qs("#leadActiveTab")?.classList.toggle("active", state.leadView === "active");
  qs("#leadTrashTab")?.classList.toggle("active", state.leadView === "trash");
  const activeCount = qs("#leadActiveCount");
  const trashCount = qs("#leadTrashCount");
  if (activeCount) activeCount.textContent = String(state.leads.length);
  if (trashCount) trashCount.textContent = String(state.leadTrash.length);
}

export async function openLead(id: string) {
  state.selectedLeadId = id;
  qsa<HTMLElement>("#leadsTableBody tr[data-lead-id]").forEach((row) => row.classList.toggle("selected", row.dataset.leadId === id));
  const drawer = qs<HTMLElement>("#leadDrawer");
  if (!drawer) return;
  drawer.classList.add("open");
  qs("#leadDrawerBackdrop")?.classList.add("active");
  document.body.classList.add("lead-drawer-open");
  drawer.innerHTML = `<div class="drawer-head"><div><h2>加载中…</h2></div></div>`;
  try {
    const data = await api<{
      lead: Lead;
      activities: LeadActivity[];
      sourceEvents: LeadSourceEvent[];
      procurement: ProcurementContext;
    }>(`/api/leads/${id}`);
    renderLeadDrawer(
      data.lead,
      data.activities,
      data.sourceEvents || [],
      data.procurement
    );
  } catch (error) {
    drawer.innerHTML = `<div class="drawer-head"><div><h2>加载失败</h2><p>${escapeHtml(error instanceof Error ? error.message : "")}</p></div><button class="btn icon-only" id="leadDrawerClose" title="关闭">×</button></div>`;
    qs("#leadDrawerClose", drawer)?.addEventListener("click", closeLeadDrawer);
  }
}

export function closeLeadDrawer() {
  qs("#leadDrawer")?.classList.remove("open");
  qs("#leadDrawerBackdrop")?.classList.remove("active");
  document.body.classList.remove("lead-drawer-open");
}

export function formatLeadDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function sourceTypeText(value?: string) {
  const labels: Record<string, string> = { outbound: "主动开发", inbound: "主动询盘", offline: "线下活动", referral: "转介绍", import: "批量导入" };
  return labels[value || ""] || value || "未标注";
}

function renderLeadDrawer(
  lead: Lead,
  activities: LeadActivity[],
  sourceEvents: LeadSourceEvent[],
  procurement?: ProcurementContext
) {
  const drawer = qs<HTMLElement>("#leadDrawer");
  if (!drawer) return;
  const sourceProspect = state.websiteOpportunities.find((item) => item.leadId === lead.id);
  const inTrash = Boolean(lead.deletedAt);
  const sourceEvent = sourceEvents[0];
  const fields: Array<[string, string]> = [
    ["联系人", lead.contact || "—"], ["国家/地区", lead.country || "—"], ["邮箱", lead.email || "—"],
    ["电话", lead.phone || "—"], ["微信", lead.wechat || "—"], ["预估金额", amount(lead.estimatedAmount || 0)]
  ];
  const sourceFields: Array<[string, string]> = [
    ["来源类型", sourceTypeText(sourceEvent?.sourceType || lead.sourceType)],
    ["来源渠道", sourceEvent?.channel || lead.sourceChannel || lead.source || "—"],
    ["来源活动", sourceEvent?.campaign || lead.sourceCampaign || "—"],
    ["外部编号", sourceEvent?.externalId || lead.externalId || "—"],
    ["来源地址", sourceEvent?.sourceUrl || lead.sourceUrl || "—"],
    ["平台发生时间", formatLeadDate(sourceEvent?.occurredAt)],
    ["系统接收时间", formatLeadDate(sourceEvent?.receivedAt || lead.createdAt)]
  ];
  const dedupeBasis = sourceEvent?.externalId
    ? `按业务员 + ${sourceEvent.channel} + ${sourceEvent.externalId} 去重`
    : "未提供平台外部编号，本次以系统线索编号留档";
  drawer.innerHTML = `
    <div class="drawer-head">
      <div><h2>${escapeHtml(lead.company)}</h2><p>${escapeHtml(lead.country || "—")} · ${escapeHtml(lead.contact || "—")}</p></div>
      <div class="lead-drawer-head-actions">${inTrash ? "" : `<button class="${whatsAppEntryClass(lead.phone || "")}" id="leadWhatsAppButton" ${whatsAppEntryAttrs(lead.phone || "", "该线索未维护电话 / WhatsApp 号码，补齐后再联系")}>WhatsApp</button><button class="btn" id="leadDevelopmentEmailButton">写开发信</button><button class="btn primary ai-entry-button" id="leadAiResearchButton">${researchButtonIcon()}AI 背调</button>`}${badge(inTrash ? "垃圾箱" : (LEAD_STATUS_LABEL[lead.status] || lead.status), inTrash ? "red" : (LEAD_STATUS_TONE[lead.status] || ""))}<button class="btn icon-only" id="leadDrawerClose" title="关闭">×</button></div>
    </div>
    ${lead.remark ? `<p class="lead-remark">${escapeHtml(lead.remark)}</p>` : ""}
    ${inTrash ? `
      <div class="lead-delete-audit">
        <div><span>删除原因</span><b>${escapeHtml(lead.deletedReason || "未填写")}</b></div>
        <div><span>删除时间</span><b>${escapeHtml(formatLeadDate(lead.deletedAt))}</b></div>
        <div><span>操作账号</span><b>${escapeHtml(lead.deletedBy || "—")}</b></div>
        <div><span>计划清理</span><b>${escapeHtml(formatLeadDate(lead.purgeAt))}</b></div>
      </div>
      <div class="lead-drawer-actions"><button class="btn primary" id="leadRestoreButton">恢复线索</button>${lead.convertedCustomerId ? `<span class="lead-retention-note">关联客户和商机仍在使用，不能永久删除来源记录</span>` : `<button class="btn danger" id="leadPermanentButton">永久删除</button>`}</div>
    ` : `
      <div class="lead-compose">
        <select id="leadNoteType"><option value="call">电话</option><option value="wechat">微信</option><option value="whatsapp">WhatsApp</option><option value="linkedin">LinkedIn</option><option value="email">邮件</option><option value="meeting">会面</option><option value="note">备注</option></select>
        <input id="leadNoteInput" placeholder="填写本次跟进内容" />
        <input id="leadNoteNext" placeholder="下次跟进时间（可选）" />
        <button class="btn primary" id="leadNoteButton">记录跟进</button>
      </div>
      <div class="lead-drawer-actions">
        <label>阶段<select id="leadStageSelect">${LEAD_STAGES.map((stage) => `<option ${stage === lead.stage ? "selected" : ""}>${stage}</option>`).join("")}</select></label>
        <div>
          ${lead.convertedCustomerId
            ? `${badge("已转客户", "green")}${lead.convertedDealId ? badge("已建商机", "green") : ""}`
            : `<button class="btn primary" id="leadConvertButton">转为客户</button>`}
          <button class="btn danger subtle" id="leadTrashButton">移入垃圾箱</button>
          ${sourceProspect ? `<button class="btn" id="leadBackToProspectButton">返回来源候选</button>` : ""}
        </div>
      </div>
    `}
    ${sourceProspect ? renderProcurementContextPanel(procurement, sourceProspect) : ""}
    <section class="lead-detail-section"><h3>联系与需求</h3><div class="info-grid">${fields.map(([label, value]) => `<div class="info"><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join("")}</div></section>
    <section class="lead-detail-section lead-inquiry-section"><div class="lead-section-head"><h3>询盘内容</h3><span>保存客户发来的原始需求，和内部备注分开管理</span></div><textarea id="leadInquiryContentInput" rows="7" placeholder="粘贴客户发来的询盘、邮件或平台留言">${escapeHtml(lead.inquiryContent || "")}</textarea><div class="lead-section-actions"><button class="btn" id="leadInquiryContentSaveButton">保存询盘内容</button></div></section>
    <section class="lead-detail-section">
      <h3>来源证据</h3>
      <div class="info-grid">${sourceFields.map(([label, value]) => `<div class="info"><span>${label}</span><b>${escapeHtml(value)}</b></div>`).join("")}</div>
      <div class="lead-dedupe"><span>去重依据</span><b>${escapeHtml(dedupeBasis)}</b><small>同一业务员、同一平台渠道和同一外部编号会复用原线索；不同业务员数据相互隔离。</small></div>
      ${sourceEvent?.rawPayload ? `<details class="lead-raw-payload"><summary>查看平台原始载荷</summary><pre>${escapeHtml(sourceEvent.rawPayload)}</pre></details>` : ""}
    </section>
    <section class="lead-detail-section"><h3>跟进记录</h3>
    <div class="timeline">
      ${activities.length ? activities.map((activity) => `<div class="timeline-item"><b>${LEAD_ACTIVITY_LABEL[activity.type] || activity.type}</b><span>${escapeHtml(activity.content)}</span><small>${new Date(activity.createdAt).toLocaleString("zh-CN")}${activity.nextFollowAt ? " · 下次：" + escapeHtml(activity.nextFollowAt) : ""}</small></div>`).join("") : `<div class="timeline-item"><span>暂无跟进记录</span></div>`}
    </div></section>`;

  qs("#leadDrawerClose", drawer)?.addEventListener("click", closeLeadDrawer);
  qs<HTMLButtonElement>("#leadWhatsAppButton", drawer)?.addEventListener("click", () => {
    void openWhatsAppForContact({ phone: lead.phone || "", displayName: lead.contact || lead.company });
  });
  qs<HTMLButtonElement>("#leadDevelopmentEmailButton", drawer)?.addEventListener("click", () => openDevelopmentEmail("lead", lead.id, lead.company, "leads", lead.phone || ""));
  qs<HTMLButtonElement>("#leadAiResearchButton", drawer)?.addEventListener("click", () => openBackgroundResearch("lead", lead.id, lead.company, "leads"));
  qs<HTMLSelectElement>("#leadStageSelect", drawer)?.addEventListener("change", (event) => {
    void changeLeadStage(lead.id, (event.target as HTMLSelectElement).value);
  });
  qs<HTMLButtonElement>("#leadConvertButton", drawer)?.addEventListener("click", () => void openLeadConversion(lead.id));
  qs<HTMLButtonElement>("#leadNoteButton", drawer)?.addEventListener("click", () => void addLeadActivity(lead.id));
  qs<HTMLButtonElement>("#leadInquiryContentSaveButton", drawer)?.addEventListener("click", () => void saveLeadInquiryContent(lead.id));
  qs<HTMLButtonElement>("#leadTrashButton", drawer)?.addEventListener("click", () => openLeadTrashModal(lead));
  qs<HTMLButtonElement>("#leadRestoreButton", drawer)?.addEventListener("click", () => void restoreLead(lead.id));
  qs<HTMLButtonElement>("#leadPermanentButton", drawer)?.addEventListener("click", () => openLeadPermanentModal(lead));
  qs<HTMLButtonElement>("#leadBackToProspectButton", drawer)?.addEventListener("click", () => {
    if (!sourceProspect) return;
    state.selectedProspectId = sourceProspect.id;
    state.prospectFilter = "all";
    const index = prospectFilteredRows().findIndex((item) => item.id === sourceProspect.id);
    state.prospectPage = index >= 0 ? Math.floor(index / PROSPECT_PAGE_SIZE) + 1 : 1;
    activateNavView("prospect-list", renderProspectList);
  });
  if (sourceProspect) {
    bindProcurementContextActions(drawer, sourceProspect, procurement);
  }
}

export async function reloadLeads() {
  const [active, trash] = await Promise.all([
    api<{ leads: Lead[] }>("/api/leads"),
    api<{ leads: Lead[] }>("/api/leads?trash=true")
  ]);
  state.leads = active.leads;
  state.leadTrash = trash.leads;
  renderLeads();
  await refreshDashboardOnly();
}

function openLeadTrashModal(lead: Lead) {
  openModal("移入垃圾箱", `
    <p class="modal-note">线索将退出日常跟进列表，并保留 30 天来源与删除审计。${lead.convertedCustomerId ? "已生成的客户和商机不会被删除，仍可在对应模块继续使用。" : "需要时可从垃圾箱恢复。"}</p>
    <div class="form-field full"><label>删除原因</label><textarea id="leadDeleteReason" rows="3" placeholder="例如：联系方式无效、非目标市场、重复询盘"></textarea></div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn danger" id="confirmLeadTrashButton">确认移入</button>`);
  qs<HTMLButtonElement>("#confirmLeadTrashButton")?.addEventListener("click", () => void trashLead(lead.id));
}

async function trashLead(id: string) {
  const reason = qs<HTMLTextAreaElement>("#leadDeleteReason")?.value.trim() || "";
  if (!reason) { toast("请填写删除原因", "error"); return; }
  try {
    await api(`/api/leads/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
    closeModal();
    closeLeadDrawer();
    state.selectedLeadId = null;
    await reloadLeads();
    toast("线索已移入垃圾箱");
  } catch (error) {
    toast(error instanceof Error ? error.message : "移入垃圾箱失败", "error");
  }
}

async function restoreLead(id: string) {
  try {
    await api(`/api/leads/${id}/restore`, { method: "POST" });
    closeLeadDrawer();
    state.selectedLeadId = null;
    await reloadLeads();
    toast("线索已恢复到处理中");
  } catch (error) {
    toast(error instanceof Error ? error.message : "恢复失败", "error");
  }
}

function openLeadPermanentModal(lead: Lead) {
  openModal("永久删除线索", `
    <div class="delete-warning"><b>${escapeHtml(lead.company)}</b><span>此操作会同时删除来源事件和全部跟进记录，且无法恢复。</span></div>
    <div class="form-field full"><label>输入“永久删除”进行二次确认</label><input id="leadPermanentConfirmInput" autocomplete="off"></div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn danger" id="confirmLeadPermanentButton">永久删除</button>`);
  qs<HTMLButtonElement>("#confirmLeadPermanentButton")?.addEventListener("click", () => void permanentlyDeleteLead(lead.id));
}

async function permanentlyDeleteLead(id: string) {
  if (qs<HTMLInputElement>("#leadPermanentConfirmInput")?.value.trim() !== "永久删除") {
    toast("请输入“永久删除”完成二次确认", "error");
    return;
  }
  try {
    await api(`/api/leads/${id}/permanent`, { method: "DELETE" });
    closeModal();
    closeLeadDrawer();
    state.selectedLeadId = null;
    await reloadLeads();
    toast("线索及来源记录已永久删除");
  } catch (error) {
    toast(error instanceof Error ? error.message : "永久删除失败", "error");
  }
}

async function changeLeadStage(id: string, stage: string) {
  try {
    await api(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify({ stage }) });
    await reloadLeads();
    await openLead(id);
    toast("阶段已更新");
  } catch (error) {
    toast(error instanceof Error ? error.message : "更新失败", "error");
  }
}

async function addLeadActivity(id: string) {
  const type = qs<HTMLSelectElement>("#leadNoteType")?.value || "note";
  const content = qs<HTMLInputElement>("#leadNoteInput")?.value.trim() || "";
  const nextFollowAt = qs<HTMLInputElement>("#leadNoteNext")?.value.trim() || "";
  if (!content) { toast("请填写跟进内容", "error"); return; }
  try {
    await api(`/api/leads/${id}/activities`, { method: "POST", body: JSON.stringify({ type, content, nextFollowAt }) });
    await reloadLeads();
    await openLead(id);
    toast("跟进已记录");
  } catch (error) {
    toast(error instanceof Error ? error.message : "记录失败", "error");
  }
}

async function saveLeadInquiryContent(id: string) {
  const content = qs<HTMLTextAreaElement>("#leadInquiryContentInput")?.value || "";
  try {
    await api(`/api/leads/${id}`, { method: "PATCH", body: JSON.stringify({ inquiryContent: content }) });
    await reloadLeads();
    await openLead(id);
    toast("询盘内容已保存");
  } catch (error) {
    toast(error instanceof Error ? error.message : "询盘内容保存失败", "error");
  }
}

function renderLeadConversionDealFields(visible: boolean) {
  const fields = qs<HTMLElement>("#leadConversionDealFields");
  if (fields) fields.classList.toggle("is-hidden", !visible);
}

export async function openLeadConversion(
  id: string,
  recommendation?: DealRecommendation
) {
  try {
    const preview = await api<{ lead: Lead; customerMatches: LeadConversionMatch[] }>(`/api/leads/${id}/conversion-preview`);
    const { lead, customerMatches } = preview;
    const conversionRequestId = prospectRequestId("prospect-customer");
    const suggestedQuantity = Number(recommendation?.suggestedQuantity || 0);
    const suggestedUnitPrice = Number(recommendation?.suggestedUnitPrice || 0);
    const suggestedAmount = Number(
      recommendation?.suggestedAmount
      || suggestedQuantity * suggestedUnitPrice
      || lead.estimatedAmount
      || 0
    );
    const matchRows = customerMatches.map((match, index) => `
      <label class="conversion-customer-option">
        <input type="radio" name="leadCustomerMode" value="existing:${escapeHtml(match.customer.id)}" ${index === 0 ? "checked" : ""}>
        <span><b>${escapeHtml(match.customer.company)}</b><small>${escapeHtml(match.customer.country)} · ${escapeHtml(match.customer.contact)} · ${match.activeDealCount} 个活跃商机</small><em>${escapeHtml(match.reasons.join("、"))} · 匹配 ${match.score} 分</em></span>
      </label>
    `).join("");
    openModal("转为客户", `
      <input id="leadConversionRequestId" type="hidden" value="${escapeHtml(conversionRequestId)}">
      <input id="leadConversionRecommendationId" type="hidden" value="${escapeHtml(recommendation?.id || "")}">
      <input id="leadConversionDealQuantity" type="hidden" value="${suggestedQuantity}">
      <input id="leadConversionDealUnitPrice" type="hidden" value="${suggestedUnitPrice}">
      <input id="leadConversionDealCurrency" type="hidden" value="${escapeHtml(recommendation?.currency || "USD")}">
      <input id="leadConversionDealNextActionAt" type="hidden" value="${escapeHtml(recommendation?.nextActionAt || defaultFutureDate(2))}">
      <input id="leadConversionDealExpectedCloseAt" type="hidden" value="${escapeHtml(recommendation?.expectedCloseAt || defaultFutureDate(21))}">
      <div class="conversion-lead-summary">
        <b>${escapeHtml(lead.company)}</b>
        <span>${escapeHtml(lead.contact || "联系人待补充")} · ${escapeHtml(lead.country || "国家待补充")} · ${escapeHtml(lead.sourceChannel || lead.source || "来源待确认")}</span>
        ${recommendation ? `<em>已带入采购信号建议，商机仍由你自主决定是否创建。</em>` : ""}
      </div>
      <div class="form-field full">
        <label>客户归属</label>
        <div class="conversion-customer-list" id="leadConversionCustomerList">
          ${matchRows || `<div class="conversion-no-match">未发现明显重复客户，可新建客户。</div>`}
          <label class="conversion-customer-option">
            <input type="radio" name="leadCustomerMode" value="create" ${customerMatches.length ? "" : "checked"}>
            <span><b>新建客户</b><small>以当前线索资料建立一条客户档案</small></span>
          </label>
        </div>
      </div>
      <label class="conversion-deal-toggle"><input id="leadCreateDealInput" type="checkbox" ${recommendation ? "checked" : ""}>同时创建商机</label>
      <div class="form-grid ${recommendation ? "" : "is-hidden"}" id="leadConversionDealFields">
        <div class="form-field full"><label>商机标题</label><input id="leadDealTitleInput" value="${escapeHtml(recommendation?.suggestedTitle || `${lead.company} 采购需求`)}"></div>
        <div class="form-field"><label>产品/需求</label><input id="leadDealProductInput" value="${escapeHtml(recommendation?.suggestedProduct || "")}" placeholder="请输入产品、数量或规格需求"></div>
        <div class="form-field"><label>预计金额</label><input id="leadDealAmountInput" type="number" min="0" value="${suggestedAmount}"></div>
        <div class="form-field full"><label>下一步动作</label><input id="leadDealNextActionInput" value="${escapeHtml(recommendation?.nextAction || lead.nextFollowAt || "确认产品、数量与报价要求")}"></div>
      </div>
    `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmLeadConversionButton" data-lead-id="${escapeHtml(id)}">确认转为客户</button>`);
    qs<HTMLInputElement>("#leadCreateDealInput")?.addEventListener("change", (event) => {
      renderLeadConversionDealFields((event.currentTarget as HTMLInputElement).checked);
    });
    qs<HTMLButtonElement>("#confirmLeadConversionButton")?.addEventListener("click", () => void confirmLeadConversion(id));
  } catch (error) {
    toast(error instanceof Error ? error.message : "加载入库信息失败", "error");
  }
}

async function confirmLeadConversion(id: string) {
  const selected = qs<HTMLInputElement>('input[name="leadCustomerMode"]:checked')?.value || "create";
  const createDeal = Boolean(qs<HTMLInputElement>("#leadCreateDealInput")?.checked);
  const button = qs<HTMLButtonElement>("#confirmLeadConversionButton");
  const customerMode = selected.startsWith("existing:") ? "existing" : "create";
  const sourceProspect = state.websiteOpportunities.find((item) =>
    item.leadId === id && Boolean(item.tenantProspectId)
  );
  const recommendationId = qs<HTMLInputElement>("#leadConversionRecommendationId")?.value.trim() || "";
  const dealTitle = qs<HTMLInputElement>("#leadDealTitleInput")?.value.trim() || "";
  const dealProduct = qs<HTMLInputElement>("#leadDealProductInput")?.value.trim() || "";
  const dealAmount = Number(qs<HTMLInputElement>("#leadDealAmountInput")?.value || 0);
  const dealNextAction = qs<HTMLInputElement>("#leadDealNextActionInput")?.value.trim() || "";
  const payload = {
    customerMode,
    customerId: customerMode === "existing" ? selected.slice("existing:".length) : "",
    createDeal,
    deal: createDeal ? {
      title: dealTitle,
      product: dealProduct,
      amount: dealAmount,
      nextAction: dealNextAction
    } : undefined
  };
  if (createDeal && (!dealTitle || !dealProduct || !dealNextAction)) {
    toast("请补齐商机标题、产品需求和下一步动作", "error");
    return;
  }
  try {
    if (button) {
      button.disabled = true;
      button.textContent = "入库中";
    }
    let result: { customer: Customer; deal?: Deal };
    if (sourceProspect?.tenantProspectId) {
      const conversionRequestId = qs<HTMLInputElement>("#leadConversionRequestId")?.value.trim()
        || prospectRequestId("prospect-customer");
      const conversion = await api<{ customer: Customer }>(
        `/api/prospects/${encodeURIComponent(sourceProspect.tenantProspectId)}/convert-to-customer`,
        {
          method: "POST",
          headers: { "Idempotency-Key": conversionRequestId },
          body: JSON.stringify({
            operationCode: "convert_prospect_to_customer_v1",
            leadId: id,
            mode: customerMode === "existing" ? "link_existing" : "create_new",
            existingCustomerId: customerMode === "existing"
              ? selected.slice("existing:".length)
              : undefined,
            company: customerMode === "create" ? previewLeadValue(id, "company") : undefined,
            contact: customerMode === "create" ? previewLeadValue(id, "contact") : undefined,
            country: customerMode === "create" ? previewLeadValue(id, "country") : undefined,
            nextReminder: customerMode === "create"
              ? previewLeadValue(id, "nextFollowAt")
              : undefined
          })
        }
      );
      sourceProspect.customerId = conversion.customer.id;
      result = { customer: conversion.customer };
      if (createDeal) {
        const suggestedQuantity = Number(qs<HTMLInputElement>("#leadConversionDealQuantity")?.value || 0);
        const suggestedUnitPrice = Number(qs<HTMLInputElement>("#leadConversionDealUnitPrice")?.value || 0);
        const quantity = suggestedQuantity > 0 ? suggestedQuantity : dealAmount > 0 ? 1 : 0;
        const unitPrice = suggestedUnitPrice > 0 ? suggestedUnitPrice : quantity > 0 ? dealAmount / quantity : 0;
        const dealResult = await api<{ deal: Deal }>("/api/deals", {
          method: "POST",
          body: JSON.stringify({
            customerId: conversion.customer.id,
            title: dealTitle,
            product: dealProduct,
            quantity,
            unitPrice,
            amount: dealAmount,
            currency: qs<HTMLInputElement>("#leadConversionDealCurrency")?.value || "USD",
            nextAction: dealNextAction,
            nextActionAt: qs<HTMLInputElement>("#leadConversionDealNextActionAt")?.value || defaultFutureDate(2),
            expectedCloseAt: qs<HTMLInputElement>("#leadConversionDealExpectedCloseAt")?.value || defaultFutureDate(21),
            recommendationId
          })
        });
        result.deal = dealResult.deal;
      }
    } else {
      result = await api<{ customer: Customer; deal?: Deal }>(`/api/leads/${id}/convert`, {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }
    const [leads, customers, deals] = await Promise.all([
      api<{ leads: Lead[] }>("/api/leads"),
      api<{ customers: Customer[] }>("/api/customers"),
      api<{ deals: Deal[] }>("/api/deals")
    ]);
    state.leads = leads.leads;
    state.customers = customers.customers;
    state.deals = deals.deals;
    renderLeads();
    renderCustomers(state.customers);
    renderPipeline(state.deals);
    closeModal();
    await openLead(id);
    void refreshDashboardOnly();
    toast(result.deal ? `已入客户并创建商机：${result.customer.company}` : `已入客户：${result.customer.company}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "入库失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "确认转为客户";
    }
  }
}

function previewLeadValue(
  id: string,
  field: "company" | "contact" | "country" | "nextFollowAt"
) {
  const lead = state.leads.find((item) => item.id === id)
    || state.leadTrash.find((item) => item.id === id);
  return lead?.[field] || "";
}

export async function createLead(form: HTMLFormElement) {
  const data = new FormData(form);
  const company = String(data.get("company") || "").trim();
  if (!company) { toast("请填写客户/公司名", "error"); return; }
  const payload = {
    company,
    contact: String(data.get("contact") || ""),
    country: String(data.get("country") || ""),
    email: String(data.get("email") || ""),
    phone: String(data.get("phone") || ""),
    wechat: String(data.get("wechat") || ""),
    source: String(data.get("source") || "手动录入"),
    sourceType: String(data.get("sourceType") || "outbound"),
    sourceChannel: String(data.get("sourceChannel") || "manual"),
    sourceCampaign: String(data.get("sourceCampaign") || ""),
    externalId: String(data.get("externalId") || ""),
    sourceUrl: String(data.get("sourceUrl") || ""),
    intent: String(data.get("intent") || "中"),
    estimatedAmount: Number(data.get("estimatedAmount") || 0),
    nextFollowAt: String(data.get("nextFollowAt") || ""),
    remark: String(data.get("remark") || ""),
    inquiryContent: String(data.get("inquiryContent") || "")
  };
  try {
    await api<{ lead: Lead }>("/api/leads", { method: "POST", body: JSON.stringify(payload) });
    form.reset();
    qs<HTMLElement>("#leadCreateForm")?.classList.add("is-hidden");
    state.selectedLeadId = null;
    closeLeadDrawer();
    await reloadLeads();
    toast("线索已创建");
  } catch (error) {
    toast(error instanceof Error ? error.message : "创建失败", "error");
  }
}

export function customerGradeValue(customer: Customer) {
  if (customer.grade && ["A", "B", "C", "D"].includes(customer.grade)) return customer.grade;
  if (customer.health >= 85) return "A";
  if (customer.health >= 70) return "B";
  if (customer.health >= 55) return "C";
  return "D";
}

export function customerDocumentName(customer: Customer) {
  return customer.companyFullName?.trim() || customer.billingName?.trim() || customer.company;
}

export function customerGradeLabel(grade: string) {
  return ({ A: "核心", B: "重点", C: "常规", D: "低优先" } as Record<string, string>)[grade] || "常规";
}

export function customerGradeHtml(customer: Customer) {
  const grade = customerGradeValue(customer);
  return `<span class="customer-grade customer-grade-${grade.toLowerCase()}"><b>${grade}</b><small>${customerGradeLabel(grade)}</small></span>`;
}

export function filteredCustomers(customers: Customer[]) {
  const query = state.customerSearch.trim().toLowerCase();
  return customers.filter((customer) => {
    const matchesQuery = !query || [customer.company, customer.companyFullName, customer.contact, customer.whatsapp, customer.country, customer.ownerName, customer.source, customer.id].some((value) => (value || "").toLowerCase().includes(query));
    const matchesOutcome = state.customerOutcomeFilter === "won" ? customer.hasWonDeal === true : customer.hasWonDeal !== true;
    const matchesQueue = state.customerQueueFilter === "all"
      || (state.customerQueueFilter === "overdue" && customer.nextReminder.includes("逾期"))
      || (state.customerQueueFilter === "no-activity" && !customer.lastActivityAt)
      || (state.customerQueueFilter === "no-deal" && !customer.activeDealCount);
    return matchesQuery && matchesOutcome && matchesQueue;
  });
}
