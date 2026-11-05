/**
 * 智能获客：官网机会、资格审核、身份确认、搜客清单、超级搜索、雷达。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { isLeadSourceExecutable } from "../lead-source-selection";
import { type ProspectRadarCandidate, type ProspectRadarController, type ProspectRadarFrame, type ProspectRadarFrameTone, type ProspectRadarModel, type ProspectRadarRelation } from "../prospect-radar";
import { activateNavView, closeModal, leadBriefMode, leadFinderJobs, openModal, renderProspectList, state } from "../prototype-api";
import {
  type AiEngineJobView, type DealRecommendation, type EmailEngineSource, type LeadFinderJob,
  type LeadFinderSourceStat, type LeadSyncResult, type LeadTaskStreamLog, type ProcurementContext,
  type ProcurementEvidenceType, type ProcurementSignal, type ProspectIdentityAuthorityProvider,
  type ProspectIdentityBootstrapAttempt, type ProspectIdentityBootstrapProgress,
  type ProspectIdentityBootstrapProviderGuide, type ProspectIdentityBootstrapView, type ProspectOutreachChannel,
  type ProspectQualificationViewApi, type ProspectReplyClassification, type ProspectTouchpoint,
  type ResearchEngineSource, type Todo, type User, type WebsiteOpportunity, type WebsiteProbeAttempt,
  type WebsiteProbeEvent, type WebsiteProbeStage
} from "./models";
import { formatTime, loadLeadProviders, renderTodos, requestDashboardRefresh, updateTodoChips } from "./dashboard";
import { type LeadAiParsed, badge, escapeHtml, leadFinderDisplayText, prospectQualificationLoading, qs, qsa } from "./shared";
import {
  leadFinderStreamConnected, leadFinderStreamRunId, leadTaskDetailLogs, leadTaskDetailTime, renderLeadFinderDetail,
  renderProspectScorecard, scheduleWebsiteProbeRefresh
} from "./lead-finder";
import {
  aiEngineSourceHint, aiEngineSourceLabelValue, awaitAiEngineJob, cliWaitPanelHtml, effectiveEmailSource,
  effectiveResearchSource, engineSourceOptionsFor, startCliWaitTicker, stopCliWaitTicker
} from "./ai-engine-settings";
import { api, toast } from "./ui";
import { updateStoredUser } from "./profile";
import { customerDocumentName, openLead, openLeadConversion, renderLeads } from "./leads";
import { formatDateTime, openDealModal } from "./deals";
import { leadFinderValues, openLeadSourceCenter, refreshCandidatesAfterAcquire, renderLeadFinder, renderLeadSourceChips } from "./lead-sources";
import { localDateTimeValue } from "./plan-tasks";
import { renderTopbarStats } from "./navigation";

export let prospectRadarController: ProspectRadarController | null = null;
export let prospectRadarActiveJobId = "";
let prospectRadarLoading = false;
export let leadFinderMode: "standard" | "super" = "standard";
let leadSuperPreviewTimer = 0;

export function renderWebsiteOpportunities(opportunities: WebsiteOpportunity[]) {
  const tbody = qs<HTMLElement>("#websiteOpportunityRows");
  const count = qs<HTMLElement>("#websiteOpportunityCount");
  const status = qs<HTMLElement>("#websiteScrapeStatus");
  const modeText = (mode?: WebsiteOpportunity["parseMode"]) => mode === "reference" ? "链接登记" : mode === "ai" ? "AI归纳" : mode === "fallback" ? "AI回退" : "来源归纳";
  const modeTone = (mode?: WebsiteOpportunity["parseMode"]) => mode === "ai" ? "green" : mode === "fallback" ? "amber" : "";
  if (count) count.textContent = `${opportunities.length} 条`;
  if (status && opportunities.length) {
    const synced = opportunities.filter((item) => item.status === "synced").length;
    const aiCount = opportunities.filter((item) => item.parseMode === "ai").length;
    status.innerHTML = `<b>${opportunities.length}</b><span>已登记链接</span>${badge(`${synced} 条已同步`, synced ? "green" : "")}${badge(aiCount ? `${aiCount} 条AI归纳` : "公开资料待补全", aiCount ? "green" : "")}`;
  }
  if (!tbody) return;
  tbody.innerHTML = opportunities.length ? opportunities.map((item) => `
    <tr data-website-opportunity-id="${escapeHtml(item.id)}">
      <td><input type="checkbox" ${item.selected ?? item.status !== "synced" ? "checked" : ""} data-website-select></td>
      <td><input value="${escapeHtml(item.company)}" data-website-field="company"></td>
      <td><input value="${escapeHtml(item.business)}" data-website-field="business"></td>
      <td><input value="${escapeHtml(item.country)}" data-website-field="country"></td>
      <td><input value="${escapeHtml(item.website)}" data-website-field="website"></td>
      <td><input value="${escapeHtml(item.contact)}" data-website-field="contact"></td>
      <td><input value="${escapeHtml(item.contactInfo)}" data-website-field="contactInfo"></td>
      <td><textarea data-website-field="description">${escapeHtml(item.description)}</textarea></td>
      <td>${badge(item.status === "synced" ? "已入线索" : "待处理", item.status === "synced" ? "green" : "amber")}${badge(modeText(item.parseMode), modeTone(item.parseMode))}</td>
    </tr>
  `).join("") : `<tr><td colspan="9" class="empty-cell">暂无待核验企业</td></tr>`;
}

export function collectWebsiteRows() {
  return qsa<HTMLTableRowElement>("#websiteOpportunityRows tr[data-website-opportunity-id]")
    .filter((row) => row.querySelector<HTMLInputElement>("[data-website-select]")?.checked)
    .map((row) => {
      const value = (field: string) => {
        const node = row.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-website-field="${field}"]`);
        return node?.value.trim() || "";
      };
      return {
        id: row.dataset.websiteOpportunityId || "",
        company: value("company"),
        business: value("business"),
        country: value("country"),
        website: value("website"),
        contact: value("contact"),
        contactInfo: value("contactInfo"),
        description: value("description")
      };
    }).filter((item) => item.company && item.website);
}

export function websiteDomain(value: string) {
  try {
    return new URL(value.startsWith("http") ? value : `https://${value}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].toLowerCase();
  }
}

export function normalizeWebsiteLink(value: string) {
  const trimmed = (value || "").trim();
  if (!trimmed) return "#";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function leadFinderScore(item: WebsiteOpportunity) {
  return Math.max(0, Math.min(100, Math.round(
    item.scorecard?.actionPriority.score || 0
  )));
}

export function leadFinderDuplicateState(item: WebsiteOpportunity) {
  const domain = websiteDomain(item.website);
  const duplicatedCustomer = state.customers.find((customer) => {
    const sameCompany = customer.company.trim().toLowerCase() === item.company.trim().toLowerCase();
    const docText = `${customerDocumentName(customer)} ${customer.documentContact || ""}`.toLowerCase();
    return sameCompany || (domain && docText.includes(domain));
  });
  if (item.customerId || duplicatedCustomer) return { text: "已有客户", tone: "amber" };
  if (item.leadId || item.status === "synced") return { text: "已入线索", tone: "green" };
  return { text: "新候选", tone: "green" };
}

export function leadFinderFilteredRows(opportunities: WebsiteOpportunity[]) {
  return opportunities.filter((item) => {
    const duplicate = leadFinderDuplicateState(item);
    const score = leadFinderScore(item);
    if (state.leadFinderFilter === "pending") return !item.shortlistedAt;
    if (state.leadFinderFilter === "high") return score >= 76;
    if (state.leadFinderFilter === "duplicate") return duplicate.text === "已有客户";
    if (state.leadFinderFilter === "shortlisted") return Boolean(item.shortlistedAt);
    return true;
  });
}

function contactEmail(value: string) {
  return value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "";
}

export const PROSPECT_PAGE_SIZE = 10;

const PROSPECT_STATUS_META: Record<WebsiteOpportunity["status"], { label: string; tone: string; action: string }> = {
  preview: { label: "待处理", tone: "amber", action: "查找公开联系人与联系方式" },
  contactable: { label: "可联系", tone: "green", action: "发送开发信或加入线索" },
  contacted: { label: "已联系", tone: "green", action: "等待回复，必要时加入线索跟进" },
  synced: { label: "已入线索", tone: "green", action: "在线索中心继续跟进" },
  excluded: { label: "已排除", tone: "gray", action: "确认原因，必要时恢复处理" }
};

const PROSPECT_CHANNEL_LABELS: Record<ProspectOutreachChannel, string> = {
  email: "邮件",
  whatsapp: "WhatsApp",
  call: "电话"
};

const PROSPECT_REPLY_LABELS: Record<ProspectReplyClassification, string> = {
  clear_demand: "明确需求",
  interested_nurture: "有兴趣待培育",
  referral: "转介绍",
  no_current_demand: "当前无需求",
  rejected: "明确拒绝",
  unsubscribed: "要求退订",
  bounced: "联系方式退信",
  auto_unknown: "自动回复/待判断"
};
const PROCUREMENT_EVIDENCE_LABELS: Record<ProcurementEvidenceType, string> = {
  quote_request: "要求报价",
  product_requirement: "产品明确",
  quantity: "数量明确",
  sample_request: "样品需求",
  purchase_timeline: "采购时间",
  target_price: "目标价格",
  certification: "认证要求",
  delivery: "交付要求",
  project_tender: "项目/招标",
  manual_confirmation: "业务员确认"
};
const prospectProcurementLoading = new Set<string>();

export function renderProcurementContextPanel(
  context: ProcurementContext | undefined,
  item: WebsiteOpportunity
) {
  if (!context) {
    return `<section class="procurement-panel"><div class="procurement-panel-head"><div><span>采购信号</span><b>正在读取</b></div></div></section>`;
  }
  const signal = context.signals[0];
  const recommendation = context.recommendations[0];
  if (!signal && !recommendation) return "";
  const canWrite = item.ownerId === state.user?.id;
  const signalDetails = signal ? [
    signal.product,
    signal.specification,
    signal.quantity ? `数量 ${signal.quantity}` : "",
    signal.targetPrice ? `${signal.currency} ${signal.targetPrice}` : "",
    signal.purchaseTimeline
  ].filter(Boolean).join(" · ") : "";
  const recommendationAction = recommendation?.status === "generated" && canWrite
    ? item.customerId
      ? `<button class="btn primary tiny" data-use-deal-recommendation="${escapeHtml(recommendation.id)}">使用建议</button>`
      : item.leadId
        ? `<button class="btn primary tiny" data-convert-with-recommendation="${escapeHtml(recommendation.id)}">转客户并使用</button>`
        : `<span class="procurement-action-hint">先加入线索，再确认客户和商机</span>`
    : "";
  return `
    <section class="procurement-panel">
      <div class="procurement-panel-head">
        <div><span>采购信号</span><b>${signal?.status === "confirmed" ? "已确认" : signal ? "待补充" : "暂无有效信号"}</b></div>
        ${recommendation ? badge(`建议 ${recommendation.recommendationScore} 分`, recommendation.status === "generated" ? "green" : "gray") : ""}
      </div>
      ${signal ? `
        <p>${escapeHtml(signal.evidenceSummary || "已记录客户明确需求")}</p>
        ${signalDetails ? `<small>${escapeHtml(signalDetails)}</small>` : ""}
        <div class="procurement-tags">${signal.evidenceTypes.map((type) => badge(PROCUREMENT_EVIDENCE_LABELS[type] || type, "gray")).join("")}</div>
      ` : ""}
      ${recommendation ? `
        <div class="procurement-recommendation">
          <div><b>${escapeHtml(recommendation.suggestedTitle)}</b><span>${escapeHtml(recommendation.nextAction)}</span></div>
          <small>推荐依据：${escapeHtml(recommendation.reasonTexts.join("、") || "客户明确回复")}</small>
          ${recommendation.missingFields.length ? `<small>待补充：${escapeHtml(recommendation.missingFields.join("、"))}</small>` : ""}
          ${recommendation.duplicateDeals.length ? `
            <div class="procurement-duplicates">
              <span>发现相似活跃商机</span>
              ${recommendation.duplicateDeals.map((deal) => `<button class="btn tiny" data-link-recommendation="${escapeHtml(recommendation.id)}" data-link-deal="${escapeHtml(deal.id)}">${escapeHtml(deal.title)} · ${escapeHtml(deal.stage)}</button>`).join("")}
            </div>
          ` : ""}
          <div class="procurement-actions">
            ${recommendationAction}
            ${recommendation.status === "generated" && canWrite ? `<button class="btn tiny" data-dismiss-recommendation="${escapeHtml(recommendation.id)}">暂不建立</button>` : ""}
            ${recommendation.linkedDealId ? `<span>已关联商机</span>` : ""}
          </div>
        </div>
      ` : signal?.status === "needs_review" ? `<div class="procurement-note">已保留需求证据；产品或真实采购动作不足时，系统不会建议建立商机。</div>` : ""}
    </section>
  `;
}

async function loadProspectProcurementContext(
  item: WebsiteOpportunity,
  force = false
) {
  if (!force && state.procurementContexts[item.id]) return;
  if (prospectProcurementLoading.has(item.id)) return;
  prospectProcurementLoading.add(item.id);
  try {
    const context = await api<ProcurementContext>(
      `/api/prospect-list/${encodeURIComponent(item.id)}/procurement-context`
    );
    state.procurementContexts[item.id] = context;
    if (state.selectedProspectId === item.id) renderProspectDetail(item);
  } catch (error) {
    if (force) toast(error instanceof Error ? error.message : "读取采购信号失败", "error");
  } finally {
    prospectProcurementLoading.delete(item.id);
  }
}

export function bindProcurementContextActions(
  root: ParentNode,
  item: WebsiteOpportunity,
  context?: ProcurementContext
) {
  qsa<HTMLButtonElement>("[data-use-deal-recommendation]", root).forEach((button) => {
    button.addEventListener("click", () => {
      const recommendation = context?.recommendations.find((row) =>
        row.id === button.dataset.useDealRecommendation
      );
      if (recommendation) openDealModal(undefined, recommendation, item.customerId);
    });
  });
  qsa<HTMLButtonElement>("[data-convert-with-recommendation]", root).forEach((button) => {
    button.addEventListener("click", () => {
      const recommendation = context?.recommendations.find((row) =>
        row.id === button.dataset.convertWithRecommendation
      );
      if (!recommendation || !item.leadId) return;
      void openLeadConversion(item.leadId, recommendation);
    });
  });
  qsa<HTMLButtonElement>("[data-dismiss-recommendation]", root).forEach((button) => {
    button.addEventListener("click", () => void dismissDealRecommendation(
      item,
      button.dataset.dismissRecommendation || ""
    ));
  });
  qsa<HTMLButtonElement>("[data-link-recommendation]", root).forEach((button) => {
    button.addEventListener("click", () => void linkDealRecommendation(
      item,
      button.dataset.linkRecommendation || "",
      button.dataset.linkDeal || ""
    ));
  });
}

async function dismissDealRecommendation(
  item: WebsiteOpportunity,
  recommendationId: string
) {
  if (!recommendationId) return;
  try {
    await api(`/api/deal-recommendations/${encodeURIComponent(recommendationId)}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ reason: "业务员判断暂不建立商机" })
    });
    delete state.procurementContexts[item.id];
    await loadProspectProcurementContext(item, true);
    toast("已保留采购信号，暂不建立商机");
  } catch (error) {
    toast(error instanceof Error ? error.message : "处理商机建议失败", "error");
  }
}

async function linkDealRecommendation(
  item: WebsiteOpportunity,
  recommendationId: string,
  dealId: string
) {
  if (!recommendationId || !dealId) return;
  try {
    await api(`/api/deal-recommendations/${encodeURIComponent(recommendationId)}/link-deal`, {
      method: "POST",
      body: JSON.stringify({ dealId })
    });
    delete state.procurementContexts[item.id];
    await loadProspectProcurementContext(item, true);
    toast("已关联现有商机");
  } catch (error) {
    toast(error instanceof Error ? error.message : "关联商机失败", "error");
  }
}

export function prospectStatusMeta(item: WebsiteOpportunity) {
  return PROSPECT_STATUS_META[item.status] || PROSPECT_STATUS_META.preview;
}

function prospectJoinedTime(item: WebsiteOpportunity) {
  const value = new Date(item.shortlistedAt || item.createdAt).getTime();
  return Number.isFinite(value) ? value : null;
}

function localDateInputBoundary(value: string, dayOffset = 0) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) return null;
  date.setDate(date.getDate() + dayOffset);
  return date.getTime();
}

function prospectJoinedWindow(now = new Date()) {
  if (state.prospectJoinedRange === "all") return null;
  if (state.prospectJoinedRange === "custom") {
    const start = state.prospectJoinedFrom ? localDateInputBoundary(state.prospectJoinedFrom) : null;
    const end = state.prospectJoinedTo ? localDateInputBoundary(state.prospectJoinedTo, 1) : null;
    return start === null && end === null ? null : { start, end };
  }
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (state.prospectJoinedRange === "7d") start.setDate(start.getDate() - 6);
  if (state.prospectJoinedRange === "30d") start.setDate(start.getDate() - 29);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

export function formatProspectJoinedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

/**
 * 「决策人 / 采购人」联系人：CLI 获客入库时把角色写进 extractedContacts[].reasonCodes
 * （decision_maker / purchasing）。通用 info@、部门信箱在入库前就被挡掉了，这里只做读取，
 * 不再重算职位正则——两处判定迟早会分叉。
 */
function prospectBuyerContacts(item: WebsiteOpportunity) {
  return (item.extractedContacts || []).filter((contact) =>
    (contact.emails || []).length > 0
    && (contact.reasonCodes || []).some((code) => code === "decision_maker" || code === "purchasing")
  );
}

/** 列表行上的角色徽章：决策人优先，其次采购；没有合格联系人的候选不显示 */
export function prospectBuyerRoleBadge(item: WebsiteOpportunity) {
  const contacts = prospectBuyerContacts(item);
  if (!contacts.length) return "";
  const codes = new Set(contacts.flatMap((contact) => contact.reasonCodes || []));
  return codes.has("decision_maker") ? badge("决策人邮箱", "green") : badge("采购人邮箱", "blue");
}

export function prospectFilteredRows() {
  const keyword = qs<HTMLInputElement>("#prospectSearchInput")?.value.trim().toLowerCase() || "";
  const joinedWindow = prospectJoinedWindow();
  const statusWeight: Record<WebsiteOpportunity["status"], number> = {
    contactable: 0,
    preview: 1,
    contacted: 2,
    synced: 3,
    excluded: 4
  };
  return state.websiteOpportunities
    .filter((item) => Boolean(item.shortlistedAt))
    .slice()
    .filter((item) => {
      const haystack = `${item.company} ${item.business} ${item.country} ${item.website} ${item.contact} ${item.contactInfo} ${item.description}`.toLowerCase();
      if (keyword && !haystack.includes(keyword)) return false;
      if (state.prospectFilter !== "all" && item.status !== state.prospectFilter) return false;
      if (state.prospectBuyerOnly && !prospectBuyerContacts(item).length) return false;
      if (joinedWindow) {
        const joinedAt = prospectJoinedTime(item);
        if (joinedAt === null) return false;
        if (joinedWindow.start !== null && joinedAt < joinedWindow.start) return false;
        if (joinedWindow.end !== null && joinedAt >= joinedWindow.end) return false;
      }
      return true;
    })
    .sort((left, right) => {
      const leftJoined = prospectJoinedTime(left);
      const rightJoined = prospectJoinedTime(right);
      let difference = 0;
      if (state.prospectSort === "joined_desc" || state.prospectSort === "joined_asc") {
        if (leftJoined === null && rightJoined !== null) return 1;
        if (leftJoined !== null && rightJoined === null) return -1;
        difference = ((rightJoined || 0) - (leftJoined || 0)) * (state.prospectSort === "joined_desc" ? 1 : -1);
      } else if (state.prospectSort === "status_changed") {
        const leftChanged = new Date(left.statusChangedAt || left.createdAt).getTime();
        const rightChanged = new Date(right.statusChangedAt || right.createdAt).getTime();
        difference = (Number.isFinite(rightChanged) ? rightChanged : 0) - (Number.isFinite(leftChanged) ? leftChanged : 0);
      } else {
        difference = statusWeight[left.status] - statusWeight[right.status];
        if (!difference) difference = leadFinderScore(right) - leadFinderScore(left);
      }
      return difference || left.id.localeCompare(right.id);
    });
}

export function selectedProspect() {
  return state.websiteOpportunities.find((item) =>
    item.id === state.selectedProspectId && Boolean(item.shortlistedAt)
  ) || null;
}

let prospectTechnicalAuditOpenId = "";
/** AI 背调折叠区的展开状态（按候选记忆）：列表刷新重绘详情面板后不再自己收起来 */
let prospectResearchOpenId = "";
/** 本会话内正在执行 CLI 背调的候选 id：点按钮立即亮标，列表刷新后由后端 researchRunning 字段接管 */
const localResearchRunningIds = new Set<string>();
/** 列表行 / 详情区的「背调中」呼吸徽章 */
export function researchRunningBadgeHtml() {
  return `<span class="badge amber research-running-badge"><i aria-hidden="true"></i>背调中</span>`;
}
export function prospectResearchRunning(item: WebsiteOpportunity) {
  return Boolean(item.researchRunning) || localResearchRunningIds.has(item.id);
}
let prospectOutreachGateOpenId = "";

export function renderProspectMailPreview() {
  const preview = qs<HTMLElement>("#prospectMailPreview");
  const item = selectedProspect();
  if (!preview) return;
  const sender = state.user?.emailSenderName || state.user?.name || "GoodJob Sales";
  const from = state.user?.outboundEmail || "";
  preview.textContent = [
    `From: ${sender}${from ? ` <${from}>` : " <未绑定发件邮箱>"}`,
    `To: ${qs<HTMLInputElement>("#prospectMailTo")?.value.trim() || "未填写"}`,
    `Subject: ${qs<HTMLInputElement>("#prospectMailSubject")?.value.trim() || "未填写"}`,
    "",
    qs<HTMLTextAreaElement>("#prospectMailBody")?.value.trim() || "暂无开发信"
  ].join("\n");
}

function localProspectMailTemplate(item: WebsiteOpportunity) {
  const sender = state.user?.emailSenderName || state.user?.name || "GoodJob Sales";
  const signature = state.user?.emailSignature?.trim() || `Best regards,\n${sender}\nGoodJob Sales Team`;
  return {
    subject: `${item.business || "Product"} supplier support for ${item.company}`,
    body: [
      `Dear ${item.company} team,`,
      "",
      `I noticed your company is active in ${item.business || "international sourcing and distribution"}${item.country ? ` in ${item.country}` : ""}.`,
      "GoodJob supports overseas buyers with product selection, specifications, certificates, quotations and sample coordination.",
      "",
      "May I know which product categories you are currently sourcing, and whether you have any upcoming project requirements?",
      "",
      signature
    ].join("\n")
  };
}

/**
 * W3 · 候选开发信草稿生成：统一走 /api/development-email/draft（entityType=prospect），
 * AI 不可用时后端自动回落基础模板；接口异常时再退回本地模板，保证按钮永远有产出。
 */
/** 背调/开发信按钮文案跟随所选来源，让 CLI 入口一眼可见 */
export function prospectResearchButtonLabel(source: string) {
  if (source === "cli") return "CLI 一键背调";
  if (source === "ai") return "AI 一键背调";
  return "本地背调";
}

export function prospectMailGenerateLabel(source: string) {
  if (source === "cli") return "本机 CLI 生成";
  if (source === "ai") return "AI 生成";
  return "模板生成";
}

/** 背调「执行方式」选择器：搜客清单详情面板与候选校验抽屉共用，默认跟随团队设置 */
export function fillProspectResearchSourceSelect(root?: HTMLElement | null, selectId = "prospectResearchSourceSelect") {
  const select = qs<HTMLSelectElement>(`#${selectId}`, root || undefined);
  if (!select) return;
  const current = select.value || effectiveResearchSource();
  select.innerHTML = engineSourceOptionsFor("research")
    .map((value) => `<option value="${value}"${value === current ? " selected" : ""}>${escapeHtml(aiEngineSourceLabelValue(value))}</option>`)
    .join("");
  select.title = aiEngineSourceHint(current);
  const button = qs<HTMLButtonElement>(
    selectId === "prospectResearchSourceSelect" ? "#prospectBackgroundResearchButton" : "#leadFinderResearchButton",
    root || undefined
  );
  if (button) button.textContent = prospectResearchButtonLabel(current);
  // 面板/抽屉每次打开都会重建 DOM，这里的监听不会累积
  select.addEventListener("change", () => {
    if (button) button.textContent = prospectResearchButtonLabel(select.value);
    select.title = aiEngineSourceHint(select.value);
  });
}

/** 候选详情面板的「撰写方式」选择器：选项与写信工作室一致，默认跟随团队设置 */
function fillProspectMailSourceSelect() {
  const select = qs<HTMLSelectElement>("#prospectMailSourceSelect");
  if (!select) return;
  const current = select.value || effectiveEmailSource();
  select.innerHTML = engineSourceOptionsFor("email")
    .map((value) => `<option value="${value}"${value === current ? " selected" : ""}>${escapeHtml(aiEngineSourceLabelValue(value))}</option>`)
    .join("");
  // 生成按钮文案跟随来源：选本机 CLI 时按钮直接显示「本机 CLI 生成」
  const generateButton = qs<HTMLButtonElement>("#prospectGenerateMailButton");
  if (generateButton && !generateButton.disabled) generateButton.textContent = prospectMailGenerateLabel(current);
}

export async function generateProspectMailDraft(button?: HTMLButtonElement) {
  const item = selectedProspect();
  if (!item) {
    toast("请先选择一条搜客线索", "error");
    return;
  }
  const mailTo = qs<HTMLInputElement>("#prospectMailTo");
  const subject = qs<HTMLInputElement>("#prospectMailSubject");
  const body = qs<HTMLTextAreaElement>("#prospectMailBody");
  const approvedEmail = state.prospectQualifications[item.id]
    ?.approvedChannel?.channelType === "email"
    ? state.prospectQualifications[item.id]!.approvedChannel!.value
    : (item.emailEligibility?.recipient || "");
  if (mailTo && !mailTo.value.trim()) mailTo.value = approvedEmail;
  const source = (qs<HTMLSelectElement>("#prospectMailSourceSelect")?.value || effectiveEmailSource()) as EmailEngineSource;
  let draft = localProspectMailTemplate(item);
  let engineNote = "本地模板";
  if (button) button.disabled = true;
  const workspace = qs<HTMLElement>("#prospectMailWorkspace");
  // 选了本机 CLI 就立刻亮等待动画（点按钮即出现，不等接口返回）——
  // 后端约 10 秒才回 202+jobId，CLI 完整写作要 1-2 分钟。
  if (source === "cli" && workspace && !workspace.querySelector(".cli-wait")) {
    qs<HTMLElement>(".prospect-action-row", workspace)?.insertAdjacentHTML("beforebegin", cliWaitPanelHtml("email", "本机 CLI"));
    startCliWaitTicker("email");
  }
  try {
    const result = await api<{
      draft: { subject: string; body: string } | null;
      readiness?: { aiGenerated: boolean; aiError: string };
      pending?: boolean;
      engineJob?: AiEngineJobView;
      runnerName?: string;
      engine?: string;
    }>("/api/development-email/draft", {
      method: "POST",
      body: JSON.stringify({
        entityType: "prospect",
        entityId: item.id,
        scenario: "first_touch",
        source
      })
    });
    if (result.draft?.subject && result.draft?.body) {
      draft = { subject: result.draft.subject, body: result.draft.body };
      engineNote = result.readiness?.aiGenerated ? "AI 生成" : source === "cli" ? "本机 CLI" : "基础模板";
    } else if (result.pending && result.engineJob) {
      // 后端约 10 秒就返回 202+jobId：轮询到终态再回填正文。
      // 期间可切换页面，作业由后端留档，回到本页可重新点一次生成取回结果。
      toast("已形成后台任务，本机智能体正在撰写开发信；期间可以切换页面，写完自动回填", "info");
      const payload = await awaitAiEngineJob(result.engineJob, (job) => {
        qsa<HTMLElement>("#prospectMailWorkspace .cli-wait-found").forEach((node) => {
          node.textContent = job.status === "running" ? `本机 CLI 执行中 · 作业号 ${job.id.slice(-8)}` : "";
          node.toggleAttribute("hidden", !node.textContent);
        });
      });
      const written = (payload as { draft?: { subject: string; body: string } }).draft;
      if (written?.subject && written?.body) {
        draft = { subject: written.subject, body: written.body };
        engineNote = (payload as { readiness?: { aiGenerated?: boolean } }).readiness?.aiGenerated ? "AI 生成" : "本机 CLI";
      } else {
        engineNote = "本地模板（CLI 未返回草稿）";
        toast("本机 CLI 没有返回开发信正文，请到「集成中心 · 本地 Runner」查看执行日志", "error");
      }
    }
  } catch {
    engineNote = "本地模板（服务不可用）";
  } finally {
    stopCliWaitTicker("email");
    qs<HTMLElement>("#prospectMailWorkspace .cli-wait")?.remove();
    if (button) button.disabled = false;
  }
  if (subject) subject.value = draft.subject;
  if (body) body.value = draft.body;
  renderProspectMailPreview();
  toast(`开发信草稿已生成（${engineNote}）`);
}

const PROSPECT_QUALIFICATION_REASON_LABELS: Record<string, string> = {
  CANDIDATE_FORMAL_IDENTITY_MISSING: "尚未完成正式企业身份归一",
  CANDIDATE_FORMAL_IDENTITY_STALE: "企业身份关联已失效",
  CAMPAIGN_CONTEXT_MISSING: "缺少原始获客项目版本",
  PROSPECT_DO_NOT_CONTACT: "企业处于永久禁止联系状态",
  PROSPECT_NOT_ACTIVE: "候选不在可审查状态",
  COMPANY_VERIFICATION_MISSING_OR_EXPIRED: "企业核验缺失或已过期",
  COMPANY_UNVERIFIED: "企业身份未验证",
  COMPANY_INACTIVE: "企业登记状态非存续",
  COMPANY_IDENTITY_CONFLICT: "企业身份来源存在冲突",
  ICP_ASSESSMENT_MISSING: "尚未完成 ICP 评估",
  ICP_REVIEW_REQUIRED: "ICP 评估等待人工批准",
  ICP_NOT_QUALIFIED: "ICP 评估未达到准入条件",
  CONTACT_VERIFICATION_MISSING_OR_EXPIRED: "联系方式验证缺失或已过期",
  CONTACT_DISCOVERED: "联系方式仅为发现状态",
  CONTACT_SYNTAX_VALID: "联系方式仅通过格式校验",
  CONTACT_DOMAIN_VALID: "联系方式仅通过域名校验",
  CONTACT_BOUNCED: "联系方式已退信",
  CONTACT_OPTED_OUT: "联系人已退订",
  CONTACT_INVALID: "联系方式无效",
  SUPPRESSED: "当前存在有效抑制记录",
  QUALIFICATION_FACTS_CHANGED: "资格事实已变化，需要重新评估",
  QUALIFICATION_CONTRACT_CHANGED: "资格门禁规则已升级，需要重新评估并批准",
  CANDIDATE_IDENTITY_CHANGED: "企业资料已变化，需要重新核验",
  CANDIDATE_ICP_INPUT_CHANGED: "ICP 输入已变化，需要重新评估",
  CANDIDATE_CHANNEL_CHANGED: "渠道资料已变化，需要重新核验"
};

function qualificationReasonLabel(code: string) {
  return PROSPECT_QUALIFICATION_REASON_LABELS[code]
    || code.split("_").join(" ");
}

function prospectQualificationResult(
  result: { qualification: ProspectQualificationViewApi; opportunity: WebsiteOpportunity }
) {
  state.prospectQualifications[result.opportunity.id] = result.qualification;
  const existing = state.websiteOpportunities.find((item) =>
    item.id === result.opportunity.id
  );
  if (existing) Object.assign(existing, result.opportunity);
  renderProspectList();
  renderLeadFinder(state.websiteOpportunities);
}

export async function loadProspectQualification(
  item: WebsiteOpportunity,
  quiet = true,
  force = false
) {
  if (!force && state.prospectQualifications[item.id]) {
    return state.prospectQualifications[item.id];
  }
  if (prospectQualificationLoading.has(item.id)) return null;
  prospectQualificationLoading.add(item.id);
  if (state.selectedProspectId === item.id) renderProspectDetail(item);
  try {
    const result = await api<{
      qualification: ProspectQualificationViewApi;
      opportunity: WebsiteOpportunity;
    }>(`/api/prospect-list/${encodeURIComponent(item.id)}/qualification`);
    state.prospectQualifications[item.id] = result.qualification;
    Object.assign(item, result.opportunity);
    if (state.selectedProspectId === item.id) renderProspectDetail(item);
    return result.qualification;
  } catch (error) {
    if (!quiet) {
      toast(error instanceof Error ? error.message : "资格状态读取失败", "error");
    }
    return null;
  } finally {
    prospectQualificationLoading.delete(item.id);
  }
}

function qualificationStep(
  label: string,
  stateText: string,
  tone: "passed" | "current" | "blocked" | "pending"
) {
  return `<div class="prospect-qualification-step ${tone}"><span></span><div><b>${escapeHtml(label)}</b><small>${escapeHtml(stateText)}</small></div></div>`;
}

function qualificationSummaryItem(
  label: string,
  value: string,
  detail: string,
  tone: "passed" | "current" | "pending"
) {
  return `<div class="prospect-qualification-summary-item ${tone}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b><small>${escapeHtml(detail)}</small></div>`;
}

function focusProspectQualification(item: WebsiteOpportunity, step?: ProspectQualificationViewApi["nextStep"]) {
  state.selectedProspectId = item.id;
  prospectOutreachGateOpenId = item.id;
  if (step === "resolve_identity") prospectTechnicalAuditOpenId = item.id;
  renderProspectList();
  window.requestAnimationFrame(() => {
    const detail = qs<HTMLElement>("#prospectDetail");
    const audit = detail?.querySelector<HTMLDetailsElement>(".prospect-technical-audit");
    if (step === "resolve_identity") audit?.setAttribute("open", "");
    const panel = detail?.querySelector<HTMLElement>("#prospectQualificationPanel");
    panel?.classList.add("is-attention");
    panel?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => panel?.classList.remove("is-attention"), 1600);
  });
}

function openProspectQualificationStep(item: WebsiteOpportunity, step: ProspectQualificationViewApi["nextStep"]) {
  if (step === "ready") {
    const workspace = qs<HTMLDetailsElement>("#prospectMailWorkspace");
    if (workspace) {
      workspace.open = true;
      workspace.scrollIntoView({ behavior: "smooth", block: "center" });
      qs<HTMLButtonElement>("#prospectGenerateMailButton")?.focus();
    }
    toast("资格审核已通过，可以转为线索或继续编写开发信");
    return;
  }
  if (step === "resolve_campaign") {
    toast("请回到获客任务，为该候选补充获客项目后再继续审核", "error");
    return;
  }
  if (step === "resolve_identity") {
    void openProspectIdentityConfirmation(item);
    return;
  }
  const actionIds: Partial<Record<Exclude<ProspectQualificationViewApi["nextStep"], "ready" | "resolve_campaign" | "resolve_identity">, string>> = {
    verify_company: "prospectVerifyCompanyButton",
    assess_icp: "prospectAssessIcpButton",
    approve_icp: "prospectApproveIcpButton",
    verify_channel: "prospectVerifyChannelButton",
    evaluate_contactability: "prospectEvaluateContactabilityButton",
    approve_contactability: "prospectApproveContactabilityButton"
  };
  const actionId = actionIds[step as keyof typeof actionIds];
  const action = actionId ? qs<HTMLButtonElement>(`#${actionId}`) : null;
  if (action && !action.disabled) {
    action.click();
    return;
  }
  focusProspectQualification(item, step);
  toast("请先完成前置审核步骤，系统会在完成后开放此操作", "error");
}

async function mutateProspectQualification(
  item: WebsiteOpportunity,
  path: string,
  body: Record<string, unknown>,
  button: HTMLButtonElement | undefined,
  successMessage: string
) {
  if (button) button.disabled = true;
  try {
    const result = await api<{
      qualification: ProspectQualificationViewApi;
      opportunity: WebsiteOpportunity;
    }>(`/api/prospect-list/${encodeURIComponent(item.id)}/qualification${path}`, {
      method: "POST",
      body: JSON.stringify(body)
    });
    prospectQualificationResult(result);
    closeModal();
    toast(successMessage);
    return result.qualification;
  } catch (error) {
    toast(error instanceof Error ? error.message : "资格审查操作失败", "error");
    return null;
  } finally {
    if (button) button.disabled = false;
  }
}

function daysFromNow(days: number) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

function openProspectCompanyQualification(item: WebsiteOpportunity) {
  const provider = item.country.toUpperCase() === "GB" ? "companies_house"
    : item.country.toUpperCase() === "US" ? "sec_edgar"
      : item.country.toUpperCase() === "FR" ? "fr_company_search" : "gleif";
  openModal(`企业核验 · ${item.company}`, `
    <div class="form-grid">
      <div class="form-field"><label>权威登记源</label><select id="prospectCompanyProvider"><option value="companies_house" ${provider === "companies_house" ? "selected" : ""}>UK Companies House</option><option value="sec_edgar" ${provider === "sec_edgar" ? "selected" : ""}>SEC EDGAR</option><option value="fr_company_search" ${provider === "fr_company_search" ? "selected" : ""}>法国政府企业库</option><option value="gleif" ${provider === "gleif" ? "selected" : ""}>GLEIF</option></select></div>
      <div class="form-field"><label>注册号 / LEI</label><input id="prospectCompanyRegistration" placeholder="Companies House 8 位；CIK:10 位；SIREN:9 位"></div>
      <div class="form-field"><label>登记状态</label><select id="prospectCompanyStatus"><option value="active">存续 / Active</option><option value="registered">已登记 / Registered</option><option value="inactive">非活跃 / Inactive</option><option value="dissolved">已注销 / Dissolved</option></select></div>
      <div class="form-field"><label>司法辖区</label><input id="prospectCompanyJurisdiction" value="${escapeHtml(item.country || "GLOBAL")}"></div>
      <div class="form-field full"><label>权威来源 URL</label><input id="prospectCompanySource" placeholder="https:// 官方登记详情页"></div>
      <div class="form-field"><label>登记机关代码</label><input id="prospectCompanyAuthority" value="${provider === "companies_house" ? "GB-COMPANIES-HOUSE" : provider === "sec_edgar" ? "US-SEC" : provider === "fr_company_search" ? "FR-INPI" : "GLOBAL-LEI"}"></div>
      <div class="form-field"><label>有效至</label><input id="prospectCompanyValidUntil" type="date" value="${daysFromNow(90)}"></div>
      <div class="form-field full"><label>人工确认的官网</label><input id="prospectCompanyOfficialDomain" value="${escapeHtml(item.website)}"></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="prospectCompanySubmit">保存企业核验</button>`);
  qs<HTMLButtonElement>("#prospectCompanySubmit")?.addEventListener("click", (event) => {
    const value = (selector: string) => qs<HTMLInputElement | HTMLSelectElement>(selector)?.value.trim() || "";
    const validDate = value("#prospectCompanyValidUntil");
    void mutateProspectQualification(item, "/company", {
      requestId: prospectRequestId("company-qualification"),
      providerCode: value("#prospectCompanyProvider"),
      registrationNumber: value("#prospectCompanyRegistration"),
      operatingStatus: value("#prospectCompanyStatus"),
      jurisdiction: value("#prospectCompanyJurisdiction"),
      sourceRef: value("#prospectCompanySource"),
      authorityCode: value("#prospectCompanyAuthority"),
      observedAt: new Date().toISOString(),
      validUntil: new Date(`${validDate}T23:59:59.000Z`).toISOString(),
      officialDomain: value("#prospectCompanyOfficialDomain")
    }, event.currentTarget as HTMLButtonElement, "企业核验快照已保存");
  });
}

function openProspectIcpQualification(item: WebsiteOpportunity) {
  openModal(`ICP 评估 · ${item.company}`, `
    <div class="form-grid prospect-icp-form">
      <div class="form-field full"><label>产品 / 应用匹配证据</label><textarea id="prospectIcpEvidence" placeholder="填写来源页面中能支持目标产品与应用匹配的事实"></textarea></div>
      <div class="form-field full"><label>证据来源 URL</label><input id="prospectIcpSource" value="${escapeHtml(item.website)}"></div>
      ${[["Product", "产品应用", 30], ["Customer", "客户类型", 15], ["Market", "市场国家", 10], ["Authenticity", "企业真实性", 15], ["Purchase", "采购渠道能力", 15], ["Contact", "可联系性", 10], ["Freshness", "新鲜度", 5]].map(([id, label, max]) => `<div class="form-field"><label>${label}（0-${max}）</label><input id="prospectIcp${id}" type="number" min="0" max="${max}" value="0"></div>`).join("")}
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="prospectIcpSubmit">生成评估快照</button>`);
  qs<HTMLButtonElement>("#prospectIcpSubmit")?.addEventListener("click", (event) => {
    const value = (selector: string) => qs<HTMLInputElement | HTMLTextAreaElement>(selector)?.value.trim() || "";
    const score = (id: string) => Number(value(`#prospectIcp${id}`) || 0);
    void mutateProspectQualification(item, "/icp", {
      requestId: prospectRequestId("icp-qualification"),
      dimensionScores: {
        productApplicationMatch: score("Product"),
        customerType: score("Customer"),
        marketCountry: score("Market"),
        companyAuthenticity: score("Authenticity"),
        purchasingChannelCapability: score("Purchase"),
        contactability: score("Contact"),
        freshness: score("Freshness")
      },
      evidence: [{
        field: "product_match",
        value: value("#prospectIcpEvidence"),
        sourceType: "official_website",
        providerCode: "official_website_manual_review",
        sourceRef: value("#prospectIcpSource"),
        excerpt: value("#prospectIcpEvidence"),
        observedAt: new Date().toISOString(),
        expiresAt: new Date(`${daysFromNow(90)}T23:59:59.000Z`).toISOString()
      }],
      hardGateReasonCodes: []
    }, event.currentTarget as HTMLButtonElement, "ICP 评估已生成，等待人工批准");
  });
}

function openProspectChannelQualification(item: WebsiteOpportunity) {
  const email = contactEmail(item.contactInfo) || contactEmail(item.contact);
  openModal(`渠道核验 · ${item.company}`, `
    <div class="form-grid">
      <div class="form-field"><label>联系人类型</label><select id="prospectChannelContactType"><option value="department">部门</option><option value="named_person">具名联系人</option><option value="company_public">企业公开通道</option></select></div>
      <div class="form-field"><label>姓名</label><input id="prospectChannelName" value="${escapeHtml(item.contact)}"></div>
      <div class="form-field"><label>部门</label><input id="prospectChannelDepartment" value="${escapeHtml(item.contact || "Sales")}"></div>
      <div class="form-field"><label>通道</label><select id="prospectChannelType"><option value="email">Email</option><option value="phone">电话</option><option value="whatsapp">WhatsApp</option><option value="website_form">官网表单</option></select></div>
      <div class="form-field full"><label>联系方式</label><input id="prospectChannelValue" value="${escapeHtml(email || item.contactInfo)}"></div>
      <div class="form-field full"><label>公开来源 URL</label><input id="prospectChannelSource" value="${escapeHtml(item.website)}"></div>
      <div class="form-field"><label>有效至</label><input id="prospectChannelExpires" type="date" value="${daysFromNow(30)}"></div>
      <label class="form-check full"><input id="prospectChannelConfirmed" type="checkbox">我已打开证据链接，确认该联系方式仍在官网公开展示，可以用于本次业务触达</label>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="prospectChannelSubmit">保存渠道核验</button>`);
  qs<HTMLButtonElement>("#prospectChannelSubmit")?.addEventListener("click", (event) => {
    const value = (selector: string) => qs<HTMLInputElement | HTMLSelectElement>(selector)?.value.trim() || "";
    if (!qs<HTMLInputElement>("#prospectChannelConfirmed")?.checked) {
      toast("请先完成官方来源逐字核对", "error");
      return;
    }
    const contactType = value("#prospectChannelContactType");
    const contactValue = value("#prospectChannelValue");
    void mutateProspectQualification(item, "/channel", {
      requestId: prospectRequestId("channel-qualification"),
      contactType,
      name: value("#prospectChannelName"),
      department: value("#prospectChannelDepartment"),
      title: "",
      identityStatus: "source_confirmed",
      channelType: value("#prospectChannelType"),
      value: contactValue,
      sourceType: "official_website",
      sourceProviderCode: "official_website_manual_review",
      sourceRef: value("#prospectChannelSource"),
      excerpt: `人工核对公开联系方式：${contactValue}`,
      acquiredAt: new Date().toISOString(),
      verificationBasis: "official_source_manual",
      verificationProviderCode: "human_official_source_review",
      verificationReasonCode: "public_channel_confirmed",
      verifiedAt: new Date().toISOString(),
      expiresAt: new Date(`${value("#prospectChannelExpires")}T23:59:59.000Z`).toISOString(),
      humanConfirmed: true
    }, event.currentTarget as HTMLButtonElement, "联系方式来源和有效期已保存");
  });
}

function openProspectSuppression(item: WebsiteOpportunity) {
  openModal(`禁止联系 · ${item.company}`, `
    <div class="form-field"><label>原因</label><textarea id="prospectSuppressionReason" placeholder="例如：明确退订、法务要求、客户明确拒绝"></textarea></div>
    <label class="form-check"><input id="prospectSuppressionDnc" type="checkbox" checked>永久禁止联系（普通恢复操作不能撤销）</label>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn danger" id="prospectSuppressionSubmit">确认禁止联系</button>`);
  qs<HTMLButtonElement>("#prospectSuppressionSubmit")?.addEventListener("click", (event) => {
    const reason = qs<HTMLTextAreaElement>("#prospectSuppressionReason")?.value.trim() || "";
    const dnc = Boolean(qs<HTMLInputElement>("#prospectSuppressionDnc")?.checked);
    if (!reason) {
      toast("请填写禁止联系原因", "error");
      return;
    }
    void mutateProspectQualification(item, "/suppress", {
      requestId: prospectRequestId("suppression"),
      scope: "organization_all",
      action: "imposed",
      reasonCode: dnc ? "HUMAN_DO_NOT_CONTACT" : "HUMAN_TEMPORARY_SUPPRESSION",
      reasonNote: reason,
      effectiveAt: new Date().toISOString(),
      expiresAt: dnc ? "" : new Date(`${daysFromNow(90)}T23:59:59.000Z`).toISOString(),
      doNotContact: dnc
    }, event.currentTarget as HTMLButtonElement, "禁止联系状态已生效");
  });
}

const prospectIdentityBootstrapViews = new Map<string, ProspectIdentityBootstrapView>();
const prospectIdentityBootstrapProgress = new Map<string, ProspectIdentityBootstrapProgress>();
const prospectIdentityBootstrapLoading = new Set<string>();
let prospectIdentityBootstrapPollKey = "";
let prospectIdentityBootstrapPollTimer = 0;

const PROSPECT_IDENTITY_OUTCOME_LABELS: Record<ProspectIdentityBootstrapAttempt["outcome"], string> = {
  pending: "等待权威来源结果",
  linked: "正式企业身份已绑定",
  not_found: "权威来源未找到该注册号",
  identity_conflict: "企业身份存在冲突，等待人工复核",
  failed: "权威来源任务失败"
};

function latestProspectIdentityBootstrap(item: WebsiteOpportunity) {
  return [...(item.identityBootstrapAttempts || [])]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function identityBootstrapProviderHint(provider?: ProspectIdentityBootstrapProviderGuide) {
  if (!provider) return "请选择权威企业注册来源。";
  if (!provider.runtime?.ready) {
    return provider.runtime?.requiresKey && !provider.runtime.hasApiKey
      ? provider.credentialKind === "fair_access_user_agent"
        ? `${provider.name} 需要先配置 Fair Access User-Agent（系统名 联系邮箱），无需申请 API Key。`
        : `${provider.name} 需要先配置 API Key；任务不会在未配置时创建。`
      : `${provider.name} 当前不可执行，请先到数据源中心检查连接。`;
  }
  return `${provider.name} is ready. ${provider.setupNote} This source uses official APIs only and does not review company websites.`;
}

async function loadProspectIdentityBootstrap(item: WebsiteOpportunity, quiet = true) {
  if (item.ownerId !== state.user?.id || prospectIdentityBootstrapLoading.has(item.id)) return;
  prospectIdentityBootstrapLoading.add(item.id);
  try {
    const view = await api<ProspectIdentityBootstrapView>(
      `/api/prospect-list/${encodeURIComponent(item.id)}/identity-bootstrap`
    );
    prospectIdentityBootstrapViews.set(item.id, view);
    item.identityBootstrapAttempts = view.attempts;
    if (state.selectedProspectId === item.id) renderProspectDetail(item);
  } catch (error) {
    if (!quiet) toast(error instanceof Error ? error.message : "企业身份引导加载失败", "error");
  } finally {
    prospectIdentityBootstrapLoading.delete(item.id);
  }
}

async function openProspectIdentityConfirmation(item: WebsiteOpportunity) {
  if (!prospectIdentityBootstrapViews.has(item.id)) {
    await loadProspectIdentityBootstrap(item, false);
  }
  const view = prospectIdentityBootstrapViews.get(item.id);
  if (!view) return;
  const country = item.country.trim().toLocaleUpperCase("en-US");
  const preferredId: ProspectIdentityAuthorityProvider = ["GB", "UK", "UNITED KINGDOM"].includes(country)
    ? "companies_house"
    : ["US", "USA", "UNITED STATES"].includes(country)
      ? "sec_edgar"
      : ["FR", "FRANCE", "法国"].includes(country)
        ? "fr_company_search"
        : "gleif";
  const defaultProvider = view.providers.find((provider) =>
    provider.id === preferredId && provider.runtime?.ready
  ) || view.providers.find((provider) => provider.runtime?.ready)
    || view.providers[0];
  const options = view.providers.map((provider) => `
    <option value="${escapeHtml(provider.id)}" ${provider.id === defaultProvider?.id ? "selected" : ""}>${escapeHtml(provider.name)}${provider.runtime?.ready ? "" : "（暂不可用）"}</option>`).join("");
  openModal(`确认公司 · ${item.company}`, `
    <div class="inline-alert"><b>只需确认一次</b><span>系统会通过官方企业登记接口核对公司主体，后续审核会自动沿用结果。</span></div>
    <div class="form-grid" style="margin-top:12px">
      <div class="form-field"><label>登记来源</label><select id="prospectIdentityModalProvider">${options}</select></div>
      <div class="form-field"><label>公司注册号</label><input id="prospectIdentityModalRegistration" maxlength="80" placeholder="${escapeHtml(defaultProvider?.example || "填写公开注册号")}"></div>
      <div class="form-field full"><small id="prospectIdentityModalHint">${escapeHtml(identityBootstrapProviderHint(defaultProvider))}</small></div>
    </div>
    <div class="prospect-company-discovery" id="prospectIdentityDiscoveryResults"><span>不知道注册号时，可让系统从所选官方来源按公司名查找。</span></div>
    <div class="prospect-company-confirm-note"><b>注册号在哪里找</b><span>可从客户官网页脚、公司注册证书或当地官方企业查询结果中取得。系统不会用 AI 猜测注册号。</span></div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn" id="prospectIdentityModalDiscover">自动查找</button><button class="btn primary" id="prospectIdentityModalSubmit">确认公司</button>`);
  const providerSelect = qs<HTMLSelectElement>("#prospectIdentityModalProvider");
  const registrationInput = qs<HTMLInputElement>("#prospectIdentityModalRegistration");
  const hint = qs<HTMLElement>("#prospectIdentityModalHint");
  providerSelect?.addEventListener("change", () => {
    const provider = view.providers.find((entry) => entry.id === providerSelect.value);
    if (hint) hint.textContent = identityBootstrapProviderHint(provider);
    if (registrationInput) registrationInput.placeholder = provider?.example || "填写公开注册号";
  });
  qs<HTMLButtonElement>("#prospectIdentityModalDiscover")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const resultsBox = qs<HTMLElement>("#prospectIdentityDiscoveryResults");
    const providerId = (providerSelect?.value || "") as ProspectIdentityAuthorityProvider;
    if (!providerId || !resultsBox) return;
    button.disabled = true;
    button.textContent = "查找中";
    resultsBox.innerHTML = `<span>正在查询官方企业登记记录...</span>`;
    try {
      const result = await api<{
        candidates: Array<{ company: string; country: string; registrationNumber: string; evidenceSummary: string }>;
        provider: string;
        query: string;
      }>(`/api/prospect-list/${encodeURIComponent(item.id)}/identity-bootstrap/discover`, {
        method: "POST",
        body: JSON.stringify({ providerId })
      });
      resultsBox.innerHTML = result.candidates.length
        ? `<div class="prospect-company-discovery-head"><b>请选择正确公司</b><span>${escapeHtml(result.provider)} 返回 ${result.candidates.length} 条</span></div>${result.candidates.map((candidate) => `<button type="button" data-identity-registration="${escapeHtml(candidate.registrationNumber)}"><b>${escapeHtml(candidate.company)}</b><span>${escapeHtml([candidate.country, candidate.registrationNumber].filter(Boolean).join(" · "))}</span><small>${escapeHtml(candidate.evidenceSummary || "官方登记记录")}</small></button>`).join("")}`
        : `<div class="prospect-company-discovery-empty"><b>未找到匹配记录</b><span>可更换登记来源，或从客户资料中取得注册号后手工填写。</span></div>`;
      resultsBox.querySelectorAll<HTMLButtonElement>("[data-identity-registration]").forEach((candidateButton) => {
        candidateButton.addEventListener("click", () => {
          if (registrationInput) registrationInput.value = candidateButton.dataset.identityRegistration || "";
          resultsBox.querySelectorAll("button").forEach((node) => node.classList.toggle("selected", node === candidateButton));
        });
      });
    } catch (error) {
      resultsBox.innerHTML = `<div class="prospect-company-discovery-empty"><b>自动查找未完成</b><span>${escapeHtml(error instanceof Error ? error.message : "请稍后重试或手工填写")}</span></div>`;
    } finally {
      button.disabled = false;
      button.textContent = "自动查找";
    }
  });
  qs<HTMLButtonElement>("#prospectIdentityModalSubmit")?.addEventListener("click", (event) => {
    void startProspectIdentityBootstrap(item, event.currentTarget as HTMLButtonElement, {
      providerId: (providerSelect?.value || "") as ProspectIdentityAuthorityProvider,
      registrationNumber: registrationInput?.value.trim() || ""
    });
  });
  registrationInput?.focus();
}

function stopProspectIdentityBootstrapPolling() {
  if (prospectIdentityBootstrapPollTimer) window.clearTimeout(prospectIdentityBootstrapPollTimer);
  prospectIdentityBootstrapPollTimer = 0;
  prospectIdentityBootstrapPollKey = "";
}

function pollProspectIdentityBootstrap(item: WebsiteOpportunity, attemptId: string) {
  const key = `${item.id}:${attemptId}`;
  if (prospectIdentityBootstrapPollKey === key) return;
  stopProspectIdentityBootstrapPolling();
  prospectIdentityBootstrapPollKey = key;
  const tick = async () => {
    if (state.selectedProspectId !== item.id || prospectIdentityBootstrapPollKey !== key) {
      stopProspectIdentityBootstrapPolling();
      return;
    }
    try {
      const result = await api<{
        taskStatus: "running" | "ended";
        attempt: ProspectIdentityBootstrapAttempt;
        candidate: WebsiteOpportunity;
        progress: ProspectIdentityBootstrapProgress | null;
      }>(`/api/prospect-list/${encodeURIComponent(item.id)}/identity-bootstrap/${encodeURIComponent(attemptId)}/reconcile`, {
        method: "POST",
        body: JSON.stringify({})
      });
      Object.assign(item, result.candidate);
      item.identityBootstrapAttempts ||= [];
      const index = item.identityBootstrapAttempts.findIndex((entry) => entry.id === result.attempt.id);
      if (index >= 0) item.identityBootstrapAttempts[index] = result.attempt;
      else item.identityBootstrapAttempts.unshift(result.attempt);
      const view = prospectIdentityBootstrapViews.get(item.id);
      if (view) view.attempts = item.identityBootstrapAttempts;
      if (result.progress) prospectIdentityBootstrapProgress.set(attemptId, result.progress);
      renderProspectDetail(item);
      renderProspectList();
      if (result.taskStatus === "ended") {
        stopProspectIdentityBootstrapPolling();
        if (result.attempt.outcome === "linked") {
          await loadProspectQualification(item, true, true);
          toast("身份核验已结束，正式企业身份已建立");
        } else {
          toast("身份核验已结束，可在详情查看结果");
        }
        return;
      }
    } catch {
      // The next reconciliation can recover from a short API interruption.
    }
    prospectIdentityBootstrapPollTimer = window.setTimeout(tick, 900);
  };
  prospectIdentityBootstrapPollTimer = window.setTimeout(tick, 100);
}

async function startProspectIdentityBootstrap(
  item: WebsiteOpportunity,
  button: HTMLButtonElement,
  input?: { providerId: ProspectIdentityAuthorityProvider | ""; registrationNumber: string }
) {
  const providerId = input?.providerId
    || qs<HTMLSelectElement>("#prospectIdentityProvider")?.value as ProspectIdentityAuthorityProvider | "";
  const registrationNumber = input?.registrationNumber
    || qs<HTMLInputElement>("#prospectIdentityRegistration")?.value.trim()
    || "";
  const view = prospectIdentityBootstrapViews.get(item.id);
  const provider = view?.providers.find((entry) => entry.id === providerId);
  if (!providerId || !registrationNumber) {
    toast("请选择权威来源并填写正式注册号", "error");
    return;
  }
  if (!provider?.runtime?.ready) {
    toast(identityBootstrapProviderHint(provider), "error");
    return;
  }
  button.disabled = true;
  button.textContent = "Creating task";
  try {
    const result = await api<{
      taskStatus: "running" | "ended";
      attempt: ProspectIdentityBootstrapAttempt;
    }>(`/api/prospect-list/${encodeURIComponent(item.id)}/identity-bootstrap`, {
      method: "POST",
      body: JSON.stringify({
        providerId,
        registrationNumber,
        requestId: prospectRequestId("identity-bootstrap")
      })
    });
    item.identityBootstrapAttempts ||= [];
    const existing = item.identityBootstrapAttempts.findIndex((entry) => entry.id === result.attempt.id);
    if (existing >= 0) item.identityBootstrapAttempts[existing] = result.attempt;
    else item.identityBootstrapAttempts.unshift(result.attempt);
    if (view) view.attempts = item.identityBootstrapAttempts;
    closeModal();
    renderProspectDetail(item);
    if (result.taskStatus === "ended") toast("Identity review completed. See the detail panel for results.");
    else pollProspectIdentityBootstrap(item, result.attempt.id);
  } catch (error) {
    toast(error instanceof Error ? error.message : "企业身份核验启动失败", "error");
    button.disabled = false;
    button.textContent = "开始身份核验";
  }
}

function bindProspectIdentityBootstrapActions(root: ParentNode, item: WebsiteOpportunity) {
  const select = qs<HTMLSelectElement>("#prospectIdentityProvider", root);
  const hint = qs<HTMLElement>("#prospectIdentityProviderHint", root);
  const registration = qs<HTMLInputElement>("#prospectIdentityRegistration", root);
  select?.addEventListener("change", () => {
    const provider = prospectIdentityBootstrapViews.get(item.id)?.providers.find((entry) => entry.id === select.value);
    if (hint) hint.textContent = identityBootstrapProviderHint(provider);
    if (registration) registration.placeholder = provider?.example || "输入正式注册号";
  });
  qs<HTMLButtonElement>("#prospectIdentityStartButton", root)?.addEventListener("click", (event) => {
    void startProspectIdentityBootstrap(item, event.currentTarget as HTMLButtonElement);
  });
}

const WEBSITE_PROBE_STAGE_LABELS: Record<WebsiteProbeStage, string> = {
  queued: "Queued",
  dns: "DNS check",
  robots: "Access policy check",
  head: "Homepage pre-check",
  body: "Public content review",
  contact_page: "Contact page review",
  ai_extract: "AI-assisted extraction",
  evidence: "Evidence review",
  completed: "Completed",
  failed: "Ended"
};

const WEBSITE_PROBE_OUTCOME_LABELS: Record<WebsiteProbeAttempt["outcome"], string> = {
  pending: "Pending",
  evidence_found: "Public evidence identified",
  no_evidence: "No reliable public contact or organization evidence",
  robots_denied: "Site access policy declined",
  unreachable: "Official site temporarily unavailable",
  policy_blocked: "Security policy blocked the request",
  rate_limited: "Site request limit reached",
  circuit_open: "Temporary same-domain pause",
  interrupted: "Review interrupted"
};

let activeWebsiteProbeStream: EventSource | null = null;

export function latestWebsiteProbe(item: WebsiteOpportunity) {
  return [...(item.websiteProbeAttempts || [])]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function latestWebsiteDiscovery(item: WebsiteOpportunity) {
  return [...(item.websiteDiscoveryAttempts || [])]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

export function latestContactEnrichment(item: WebsiteOpportunity) {
  return [...(item.contactEnrichmentAttempts || [])]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

const WEBSITE_DISCOVERY_PROVIDER_IDS = new Set([
  "ai_search",
  "anysearch",
  "wikidata",
  "brave",
  "serper",
  "serpapi",
  "google_places"
]);

function renderWebsiteDiscoverySourceGuide() {
  const providers = state.leadProviders.filter((provider) =>
    WEBSITE_DISCOVERY_PROVIDER_IDS.has(provider.id)
  );
  if (!providers.length) return "";
  const configurable = providers.find((provider) =>
    provider.requiresKey && (!provider.ready || !provider.enabled)
  );
  return `
    <div class="prospect-website-source-guide">
      <div class="prospect-website-source-guide-head">
        <div><b>Available official-site sources</b><span>Coverage from free sources is limited. Configured search sources will be checked in sequence.</span></div>
        ${configurable ? `<button class="btn" type="button" data-website-source-config="${escapeHtml(configurable.id)}">Configure source</button>` : ""}
      </div>
      <div class="prospect-website-source-list">
        ${providers.map((provider) => {
          const ready = provider.ready && provider.enabled;
          const isAiSearch = provider.id === "ai_search";
          const stateText = isAiSearch
            ? ready ? "Web Search verified" : provider.hasApiKey ? "Web Search not tested" : "Model not configured"
            : provider.requiresKey
            ? ready ? "Connected" : "Not configured"
            : "Built-in free source";
          const note = isAiSearch
            ? `${provider.costNote} Official-site discovery requires a model interface with Responses Web Search.`
            : provider.costNote;
          return `<div><b>${escapeHtml(provider.name)}</b><span>${escapeHtml(note)}</span><em class="${ready ? "is-ready" : ""}">${stateText}</em></div>`;
        }).join("")}
      </div>
    </div>`;
}

export function renderWebsiteDiscoveryPanel(item: WebsiteOpportunity) {
  const attempt = latestWebsiteDiscovery(item);
  if (!attempt) {
    return `
      <section class="prospect-probe-panel">
        <div class="prospect-probe-head"><div><b>Official-site discovery</b><small>Source website · Search API · Domain validation</small></div>${badge("Pending", "gray")}</div>
        <p class="prospect-probe-summary">After candidate review, the system confirms the official site before reviewing public contact channels for eligible international sites.</p>
      </section>`;
  }
  const successful = attempt.outcome === "source_provided" || attempt.outcome === "discovered";
  const outcomeLabel = attempt.outcome === "source_provided"
        ? "Source provided"
    : attempt.outcome === "discovered"
      ? "Search confirmed"
      : attempt.outcome === "not_found"
        ? "Not confirmed"
        : attempt.outcome === "provider_unavailable"
          ? "Search source unavailable"
          : "Search failed";
  const candidates = attempt.candidates.length
    ? `<div class="prospect-probe-detail"><b>候选域名</b><span>${attempt.candidates.map((candidate) => `${escapeHtml(candidate.website)}（${candidate.score} 分）`).join("；")}</span></div>`
    : "";
  return `
    <section class="prospect-probe-panel">
      <div class="prospect-probe-head"><div><b>Official-site discovery</b><small>${escapeHtml(attempt.providerId || "Original source")} · Name and domain validation</small></div>${badge(outcomeLabel, successful ? "green" : "amber")}</div>
      <div class="prospect-probe-result ${successful ? "has-evidence" : "is-neutral"}">
        <b>${escapeHtml(attempt.selectedWebsite || "No trusted official site identified")}</b>
        <span>${escapeHtml(attempt.reason)}</span>
      </div>
      ${candidates}
      ${successful ? "" : renderWebsiteDiscoverySourceGuide()}
      <div class="prospect-probe-timeline">
        ${attempt.events.map((entry) => `<div class="prospect-probe-event ${escapeHtml(entry.status)}"><span></span><div><b>${escapeHtml(entry.stage)}</b><small>${escapeHtml(leadFinderDisplayText(entry.message))}</small></div><time>${formatTime(entry.createdAt)}</time></div>`).join("")}
      </div>
    </section>`;
}

export function websiteProbePolicyBlockReason(item: WebsiteOpportunity) {
  const country = String(item.country || "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[.\s_()\-]+/gu, "");
  const blockedCountries = new Set([
    "", "unknown", "未知", "待维护", "na", "n/a",
    "cn", "chn", "china", "中国", "中国大陆", "mainlandchina",
    "hk", "hkg", "hongkong", "香港", "中国香港",
    "mo", "mac", "macao", "macau", "澳门", "中国澳门",
    "tw", "twn", "taiwan", "台湾", "中国台湾"
  ]);
  if (blockedCountries.has(country)) {
    return country
      ? "Under the access policy, sites in China, Hong Kong, Macao, and Taiwan are not reviewed automatically"
      : "The country is unclear, so the access policy will not review the site automatically";
  }
  try {
    const hostname = new URL(item.website).hostname.toLocaleLowerCase("en-US");
    if (/\.(?:cn|中国|hk|mo|tw)$/iu.test(hostname)) {
      return "This domain is within China, Hong Kong, Macao, or Taiwan; it will not be reviewed automatically";
    }
  } catch {
    return "The website address is invalid and cannot enter the secure review queue";
  }
  return "";
}

function candidateContactFieldIsTrusted(item: WebsiteOpportunity, field: "contact" | "contactInfo") {
  if (!["ai_search", "openai_web_search"].includes(item.source || "")) return true;
  return (item.sourceEvidence || []).some((evidence) =>
    evidence.matchedFields.includes(field)
    && ["official", "corroborated"].includes(evidence.fieldAuthority?.[field] || "")
  );
}

export function websiteContactDisplay(item: WebsiteOpportunity) {
  const recommended = latestContactEnrichment(item)?.recommendedContact;
  if (recommended?.channelValue) {
    return {
      value: recommended.channelValue,
      detail: `${recommended.sourceLabel} · ${recommended.reason}`,
      tone: "ready"
    };
  }
  const extracted = (item.extractedContacts || []).flatMap((contact) => [
    ...contact.emails,
    ...contact.phones,
    ...contact.whatsapp
  ]).find(Boolean) || "";
  const value = (candidateContactFieldIsTrusted(item, "contactInfo")
    ? item.contactInfo?.trim()
    : "") || extracted;
  if (value) {
    return {
      value,
      detail: item.contact?.trim() || "Public contact detail from the official site; confirm it before outreach",
      tone: "ready"
    };
  }
  if (!item.website?.trim()) {
    const discovery = latestWebsiteDiscovery(item);
    return {
      value: "Official site pending",
      detail: discovery?.reason || "Official-site discovery is not complete",
      tone: discovery?.status === "failed" ? "blocked" : "empty"
    };
  }
  if (!/^https:\/\//iu.test(item.website)) {
    return { value: "Website address needs review", detail: "Automated review accepts HTTPS websites only", tone: "empty" };
  }
  const policyBlockReason = websiteProbePolicyBlockReason(item);
  if (policyBlockReason) {
    return { value: "Automatic review unavailable", detail: policyBlockReason, tone: "blocked" };
  }
  const attempt = latestWebsiteProbe(item);
  if (!attempt) {
    return { value: "Pending background review", detail: "The task will run through the controlled queue", tone: "pending" };
  }
  if (attempt.status === "queued") {
    return { value: "Pending background review", detail: "The website review task is queued", tone: "pending" };
  }
  if (attempt.status === "running") {
    const stage = attempt.events.at(-1)?.stage;
    return {
      value: "Official-site review in progress",
      detail: stage ? `Current stage: ${WEBSITE_PROBE_STAGE_LABELS[stage]}` : "Reviewing public company information under controlled access rules",
      tone: "running"
    };
  }
  if (attempt.outcome === "interrupted") {
    return {
      value: "Official-site review interrupted",
      detail: attempt.failureMessage || "The background service restarted or the task made no progress. You can start it again.",
      tone: "blocked"
    };
  }
  if (["unreachable", "rate_limited", "circuit_open"].includes(attempt.outcome)) {
    const failureLabels: Record<string, string> = {
      HTTP_404: "Website address is no longer valid",
      DNS_NOT_FOUND: "Website domain could not be resolved",
      NETWORK_TIMEOUT: "Website response timed out",
      TLS_CERTIFICATE_INVALID: "Website certificate issue",
      CONNECTION_REFUSED: "Website declined the HTTPS connection",
      HTTP_401: "Website declined the request",
      HTTP_403: "Website declined the request",
      HTTP_406: "Website declined the request",
      DOMAIN_CIRCUIT_OPEN: "Website review is temporarily paused"
    };
    return {
      value: failureLabels[attempt.failureCode] || "Official site temporarily unavailable",
      detail: attempt.failureMessage || WEBSITE_PROBE_OUTCOME_LABELS[attempt.outcome],
      tone: "blocked"
    };
  }
  if (attempt.outcome === "robots_denied") {
    return { value: "Site policy declined the request", detail: "Open the official site manually to verify", tone: "blocked" };
  }
  if (attempt.outcome === "policy_blocked") {
    return { value: "Access policy not satisfied", detail: attempt.failureMessage || "Manual website verification is required", tone: "blocked" };
  }
  return {
    value: "No public contact details identified",
    detail: "Review completed. See the report on the right for the process.",
    tone: "empty"
  };
}

export function websiteContactPersonDisplay(item: WebsiteOpportunity) {
  const recommended = latestContactEnrichment(item)?.recommendedContact;
  if (recommended?.contactName
    && !/^(?:待维护|待确认|未知|-|—)$/u.test(recommended.contactName)) {
    return {
      value: recommended.contactName,
      detail: recommended.contactTitle || `${recommended.sourceLabel} public contact`,
      tone: "ready"
    };
  }
  const explicit = item.contact?.trim() || "";
  const matchedExtracted = (item.extractedContacts || []).find((contact) =>
    contact.kind === "person" && contact.name.trim() === explicit
  );
  const extracted = (item.extractedContacts || []).find((contact) =>
    contact.kind === "person"
    && contact.name.trim().split(/\s+/u).length >= 2
  );
  const extractedExplicitLooksLikeName = !matchedExtracted
    || explicit.split(/\s+/u).length >= 2;
  const explicitTrusted = candidateContactFieldIsTrusted(item, "contact")
    || Boolean(matchedExtracted);
  if (explicitTrusted
    && explicit
    && !/^(?:待维护|待确认|未知|-|—)$/u.test(explicit)
    && extractedExplicitLooksLikeName) {
    return {
      value: explicit,
      detail: extracted?.title || "Contact title not identified",
      tone: "ready"
    };
  }
  if (extracted) {
    return {
      value: extracted.name,
      detail: extracted.title || "Public contact from the official site; manual confirmation recommended",
      tone: "ready"
    };
  }
  const attempt = latestWebsiteProbe(item);
  if (attempt?.status === "queued" || attempt?.status === "running") {
    return { value: "Contact review in progress", detail: "Reviewing public information from an eligible international site", tone: "pending" };
  }
  return { value: "Contact name pending", detail: "No contact name was provided by the public sources", tone: "empty" };
}

function prospectLookupDiagnosis(item: WebsiteOpportunity) {
  const person = websiteContactPersonDisplay(item);
  const channel = websiteContactDisplay(item);
  const attempt = latestWebsiteProbe(item);
  const personReady = person.tone === "ready";
  const channelReady = channel.tone === "ready";
  const pending = [person.tone, channel.tone].some((tone) => ["pending", "running"].includes(tone));
  if (personReady && channelReady) return null;

  const reasons: string[] = [];
  const suggestions: string[] = [];
  if (!item.website?.trim()) {
    const discovery = latestWebsiteDiscovery(item);
    reasons.push(discovery?.reason || "The candidate source did not provide an official site, and official-site discovery is not complete.");
    suggestions.push(discovery?.outcome === "provider_unavailable"
      ? "The system will first try OpenAI Web Search and free Wikidata. You can configure Brave Search, Serper, SerpApi, or Google Places if needed."
      : "Review the candidate domains and confidence scores in Official-site discovery, or add the official site manually.");
  } else if (!/^https:\/\//iu.test(item.website)) {
    reasons.push("The current address is not an HTTPS official site and does not meet the secure review requirements.");
    suggestions.push("Confirm the address manually, replace it with the correct HTTPS link, and try again.");
  } else if (websiteProbePolicyBlockReason(item)) {
    reasons.push(websiteProbePolicyBlockReason(item));
    suggestions.push("Open the official site manually. The system will not bypass country or domain restrictions.");
  } else if (!attempt) {
    reasons.push("The candidate is eligible for background completion, but no website review record exists yet.");
    suggestions.push("Wait for the background queue, or start one website review from the report below.");
  } else if (attempt.status === "queued") {
    reasons.push("The website review task is queued and has not started yet.");
    suggestions.push("No resubmission is needed. Results will update when the task runs.");
  } else if (attempt.status === "running") {
    const stage = attempt.events.at(-1)?.stage;
    reasons.push(stage
      ? `Official-site review is in progress at “${WEBSITE_PROBE_STAGE_LABELS[stage]}”.`
      : "Official-site review is in progress under controlled access rules; this is not the final result.");
    suggestions.push("Wait for the task to finish. The page will update the contact details automatically.");
  } else {
    reasons.push(WEBSITE_PROBE_OUTCOME_LABELS[attempt.outcome]);
    if (attempt.failureMessage) reasons.push(attempt.failureMessage);
    if (attempt.outcome === "interrupted") {
      suggestions.push("This task did not establish site availability. You can start the review again.");
    } else if (attempt.failureCode === "HTTP_404" || attempt.failureCode === "DNS_NOT_FOUND") {
      suggestions.push("Confirm the official site address. The system will try the same-domain homepage before treating the site as unavailable.");
    } else if (attempt.failureCode === "TLS_CERTIFICATE_INVALID") {
      suggestions.push("The website certificate has a security issue. The system will not bypass certificate validation; verify manually or wait for the site to be fixed.");
    } else if (["HTTP_401", "HTTP_403", "HTTP_406"].includes(attempt.failureCode)) {
      suggestions.push("The site declined the request. Open the official site manually; the system will not imitate a login or bypass site restrictions.");
    } else if (["unreachable", "rate_limited", "circuit_open"].includes(attempt.outcome)) {
      suggestions.push("The site may be responding slowly or limiting requests. Try the review again later.");
    } else if (["robots_denied", "policy_blocked"].includes(attempt.outcome)) {
      suggestions.push("The system will not bypass website rules. Ask the account owner to verify the official site manually.");
    } else {
      suggestions.push("Review the official contact page manually, or add a business contact from the original public source.");
    }
  }
  if (!personReady && channelReady) {
    reasons.push("A company-level channel was found, but no reliable contact name or title was identified on the public pages.");
    suggestions.push("Use the company-level channel first and confirm the right contact in the first message.");
  } else if (personReady && !channelReady) {
    reasons.push("A contact name was identified, but no matching email, phone number, or WhatsApp channel was found on the public pages.");
    suggestions.push("Do not guess an email address. Confirm the channel through the official contact form or company switchboard.");
  }
  return {
    pending,
    title: pending
      ? "Contact review is still in progress"
      : !personReady && !channelReady
        ? "No contact or contact channel was identified"
        : !personReady
          ? "No verifiable contact name was identified"
          : "No usable contact channel was identified",
    summary: pending
      ? "The background task will update this automatically when it finishes; you do not need to wait here."
      : "This does not mean the company is inactive. It means the available authorized sources and controlled site review did not provide enough evidence.",
    reasons: [...new Set(reasons)],
    suggestions: [...new Set(suggestions)],
    attempt
  };
}

export function renderProspectLookupDiagnosis(item: WebsiteOpportunity) {
  const diagnosis = prospectLookupDiagnosis(item);
  if (!diagnosis) return "";
  const latestEvent = diagnosis.attempt?.events.at(-1);
  return `
    <section class="lead-lookup-diagnosis ${diagnosis.pending ? "is-pending" : ""}" id="leadFinderLookupDiagnosis" tabindex="-1">
      <div class="lead-lookup-diagnosis-head">
        <div><b>${escapeHtml(diagnosis.title)}</b><span>${escapeHtml(diagnosis.summary)}</span></div>
        ${badge(diagnosis.pending ? "In progress" : "Not identified", diagnosis.pending ? "blue" : "amber")}
      </div>
      <div><b>Reason</b><ul>${diagnosis.reasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></div>
      <div><b>Next step</b><ul>${diagnosis.suggestions.map((suggestion) => `<li>${escapeHtml(suggestion)}</li>`).join("")}</ul></div>
      <div class="lead-lookup-diagnosis-facts">
        <span>Source: ${escapeHtml(item.sourceLabel || item.source || "Manual entry")}</span>
        <span>Website review: ${escapeHtml(diagnosis.attempt ? WEBSITE_PROBE_OUTCOME_LABELS[diagnosis.attempt.outcome] : "Not started")}</span>
        <span>Latest stage: ${escapeHtml(latestEvent ? WEBSITE_PROBE_STAGE_LABELS[latestEvent.stage] : "No record")}</span>
      </div>
    </section>`;
}

export function leadFinderLookupValue(
  item: WebsiteOpportunity,
  display: { value: string; detail: string; tone: string },
  label: string
) {
  if (display.tone === "ready") {
    return `<b class="is-ready" title="${escapeHtml(display.detail)}">${escapeHtml(display.value)}</b>`;
  }
  return `<button class="lead-lookup-status is-${escapeHtml(display.tone)}" type="button" data-lead-lookup-reason="${escapeHtml(item.id)}" title="${escapeHtml(display.detail)}" aria-label="${escapeHtml(label)}：${escapeHtml(display.value)}，查看原因"><b>${escapeHtml(display.value)}</b><small>查看原因</small></button>`;
}

export function renderWebsiteProbePanel(
  item: WebsiteOpportunity,
  buttonId = "prospectWebsiteProbeButton"
) {
  const attempt = latestWebsiteProbe(item);
  const canStart = item.ownerId === state.user?.id && /^https:\/\//iu.test(item.website);
  if (!attempt) {
    return `
      <section class="prospect-probe-panel">
        <div class="prospect-probe-head"><div><b>Official-site review</b><small>Eligible international sites · Homepage + one same-domain contact page</small></div>${badge("Not started", "gray")}</div>
        <p class="prospect-probe-summary">Only eligible international sites are reviewed under controlled access rules. AI organizes public contact details that actually appear on the reviewed pages; it does not guess data, download files, or retain source text.</p>
        ${canStart ? `<button class="btn" type="button" id="${buttonId}">Review site for public contacts</button>` : ""}
      </section>`;
  }
  const terminal = attempt.status === "completed" || attempt.status === "failed";
  const evidence = attempt.evidence;
  return `
    <section class="prospect-probe-panel">
      <div class="prospect-probe-head">
        <div><b>Official-site review</b><small>${escapeHtml(attempt.domain)} · ${escapeHtml(attempt.policyVersion)}</small></div>
        ${badge(terminal ? "Ended" : attempt.status === "running" ? "In progress" : "Queued", terminal ? "gray" : "amber")}
      </div>
      <div class="prospect-probe-result ${attempt.outcome === "evidence_found" ? "has-evidence" : "is-neutral"}">
        <b>${escapeHtml(WEBSITE_PROBE_OUTCOME_LABELS[attempt.outcome])}</b>
        <span>${terminal ? "The result does not change company or ICP gates; site evidence is used only for supporting cross-checks." : "Stages are running and results will be appended in real time."}</span>
      </div>
      ${evidence ? `<dl class="prospect-probe-evidence">
        <div><dt>Organization</dt><dd>${escapeHtml(evidence.legalName || evidence.organizationName || "Not identified")}</dd></div>
        <div><dt>Country / language</dt><dd>${escapeHtml([evidence.addressCountry, evidence.language].filter(Boolean).join(" · ") || "Not identified")}</dd></div>
        <div><dt>Business category</dt><dd>${escapeHtml(evidence.businessCategory || "Not identified")}</dd></div>
        <div><dt>Public business email</dt><dd>${escapeHtml(evidence.publicContactEmail || "Not identified")}</dd></div>
        <div><dt>Page title</dt><dd>${escapeHtml(evidence.pageTitle || "Not identified")}</dd></div>
      </dl>` : ""}
      <div class="prospect-probe-timeline">
        ${attempt.events.map((event) => `<div class="prospect-probe-event ${event.status}"><span></span><div><b>${escapeHtml(WEBSITE_PROBE_STAGE_LABELS[event.stage])}</b><small>${escapeHtml(leadFinderDisplayText(event.message))}</small></div><time>${formatTime(event.createdAt)}</time></div>`).join("")}
      </div>
      ${attempt.failureMessage ? `<div class="prospect-probe-detail"><b>Detailed result</b><span>${escapeHtml(leadFinderDisplayText(attempt.failureMessage))}</span></div>` : ""}
      <div class="prospect-probe-foot"><span>Access policy: ${escapeHtml(attempt.robotsDecision)}</span><span>Response: ${attempt.httpStatus || "-"}</span><span>Content: ${attempt.responseBytes} B</span><span>Redirects: ${attempt.redirected ? "1" : "None"}</span></div>
      ${canStart && terminal ? `<button class="btn" type="button" id="${buttonId}">Review site again</button>` : ""}
    </section>`;
}

export function renderExtractedContactsPanel(item: WebsiteOpportunity) {
  const contacts = item.extractedContacts || [];
  const attempt = latestContactEnrichment(item);
  const running = attempt?.status === "queued" || attempt?.status === "running";
  const attemptStartedAt = new Date(attempt?.startedAt || attempt?.createdAt || 0).getTime();
  const attemptDeadlineAt = new Date(attempt?.deadlineAt || 0).getTime();
  const recoverable = Boolean(
    running
    && Number.isFinite(attemptStartedAt)
    && Date.now() > (Number.isFinite(attemptDeadlineAt) && attemptDeadlineAt > 0
      ? attemptDeadlineAt + 5_000
      : attemptStartedAt + 4 * 60_000)
    && !(item.websiteProbeAttempts || []).some((probe) =>
      new Date(probe.createdAt).getTime() >= attemptStartedAt
      && (probe.status === "queued" || probe.status === "running")
    )
  );
  const legacyContact = contacts.find((contact) =>
    contact.emails[0] || contact.whatsapp[0] || contact.phones[0]
  );
  const legacyChannel = legacyContact?.emails[0]
    ? { type: "email" as const, value: legacyContact.emails[0] }
    : legacyContact?.whatsapp[0]
      ? { type: "whatsapp" as const, value: legacyContact.whatsapp[0] }
      : legacyContact?.phones[0]
        ? { type: "phone" as const, value: legacyContact.phones[0] }
        : null;
  const recommendation = attempt?.recommendedContact || (legacyContact && legacyChannel ? {
    contactName: legacyContact.name,
    contactTitle: legacyContact.title,
    channelType: legacyChannel.type,
    channelValue: legacyChannel.value,
    sourceId: legacyContact.source,
    sourceLabel: legacyContact.sourceLabel || (legacyContact.source === "website_probe" ? "Foreign company website" : legacyContact.source),
    confidence: legacyContact.confidence ?? (legacyContact.source === "website_probe" ? 82 : 65),
    verificationStatus: legacyContact.verificationStatus || (legacyContact.source === "website_probe" ? "source_confirmed" : "unverified"),
    reason: legacyContact.source === "website_probe"
      ? "Public official-site page"
      : "Existing public-source record"
  } : null);
  const statusText = running
    ? "Multi-source review in progress"
    : recommendation
      ? "Contact found"
      : attempt
        ? "Review complete"
        : "Not started";
  const statusTone = running ? "blue" : recommendation ? "green" : "gray";
  const verificationLabel = (status: string) => status === "verified"
    ? "Verified"
    : status === "source_confirmed"
      ? "Source confirmed"
      : status === "syntax_valid"
        ? "Format valid"
        : "Manual confirmation pending";
  const sourceState = (source: NonNullable<WebsiteOpportunity["contactEnrichmentAttempts"]>[number]["sources"][number]) => {
    if (source.status === "queued" || source.status === "running") return { text: "In progress", cls: "is-running" };
    if (source.outcome === "contact_found") return { text: `Found ${source.contactCount}`, cls: "is-found" };
    if (source.outcome === "not_needed") return { text: "Not needed", cls: "is-muted" };
    if (source.outcome === "not_configured") return { text: "Not configured", cls: "is-muted" };
    if (source.outcome === "timed_out") return { text: "Timed out", cls: "is-blocked" };
    if (source.status === "blocked") return { text: "Policy blocked", cls: "is-blocked" };
    if (source.status === "failed") return { text: "Review failed", cls: "is-blocked" };
    return { text: "Not identified", cls: "is-muted" };
  };
  const channelLine = (c: { emails: string[]; phones: string[]; whatsapp: string[] }) => {
    const parts: string[] = [];
    if (c.emails.length) parts.push(`<span class="pe-tag">Email ${escapeHtml(c.emails.join(", "))}</span>`);
    if (c.phones.length) parts.push(`<span class="pe-tag">Phone ${escapeHtml(c.phones.join(", "))}</span>`);
    if (c.whatsapp.length) parts.push(`<span class="pe-tag">WhatsApp ${escapeHtml(c.whatsapp.join(", "))}</span>`);
    return parts.join(" ") || `<span class="pe-tag">No channel</span>`;
  };
  return `
    <section class="prospect-contact-hub">
      <div class="prospect-contact-hub-head">
        <div><b>Contact enrichment</b><small>Public sources · Contact providers · Eligible international official sites</small></div>
        ${badge(statusText, statusTone)}
      </div>
      ${recommendation ? `
        <div class="prospect-contact-recommendation">
          <div><span>Recommended contact</span><b>${escapeHtml(recommendation.channelValue)}</b><small>${escapeHtml([recommendation.contactName, recommendation.contactTitle].filter(Boolean).join(" · ") || "Public company channel")}</small></div>
          <div class="prospect-contact-trust"><strong>${Math.round(recommendation.confidence)}%</strong><span>${escapeHtml(verificationLabel(recommendation.verificationStatus))}</span></div>
          <p>${escapeHtml(recommendation.sourceLabel)} · ${escapeHtml(recommendation.reason)}</p>
        </div>`
        : `<div class="prospect-contact-empty"><b>${running ? "Reviewing multiple sources" : "No usable contact channel identified from the available sources"}</b><span>${escapeHtml(attempt?.summary || "Start the review and continue working; results will update in the background.")}</span></div>`}
      ${attempt?.sources.length ? `<div class="prospect-contact-sources">
        ${attempt.sources.map((source) => {
          const state = sourceState(source);
          const retryAt = source.retryAfterAt ? new Date(source.retryAfterAt) : null;
          const retryHint = retryAt && !Number.isNaN(retryAt.getTime())
            ? ` · Retry after ${retryAt.toLocaleString("en-US", { hour12: false })}`
            : source.retryable ? " · Retry later" : "";
          const taskHint = source.taskId ? ` · Task ${source.taskId}` : "";
          const evidenceLinks = (source.evidenceUrls || []).slice(0, 3).map((url, index) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">Evidence ${index + 1}</a>`).join("");
          return `<div><span class="prospect-contact-source-mark ${state.cls}"></span><p><b>${escapeHtml(leadFinderDisplayText(source.sourceLabel))}</b><small>${escapeHtml(leadFinderDisplayText(source.message) + retryHint + taskHint)}</small>${source.suggestion ? `<small class="prospect-contact-source-advice">Next step: ${escapeHtml(source.suggestion)}</small>` : ""}${evidenceLinks ? `<span class="prospect-contact-source-links">${evidenceLinks}</span>` : ""}</p><em class="${state.cls}">${escapeHtml(state.text)}</em></div>`;
        }).join("")}
      </div>` : ""}
      <div class="prospect-contact-actions">
        ${item.ownerId === state.user?.id ? `<button class="btn prospect-contact-enrichment-button" type="button" id="prospectContactEnrichmentButton" ${running && !recoverable ? "disabled" : ""}>${running && !recoverable ? "查询中" : "深入查询"}</button>` : ""}
        <span>No qualification review is required first; AI organizes public contact details from the reviewed pages and does not guess channels.</span>
      </div>
      ${contacts.length ? `<details class="prospect-contact-evidence"><summary>View ${contacts.length} source record(s)</summary>
        <div class="prospect-extracted-list">
          ${contacts.map((c) => `
            <div class="prospect-extracted-row ${c.kind === "person" ? "is-person" : "is-company"}">
              <div class="prospect-extracted-head">
                <b>${escapeHtml(c.name || (c.kind === "person" ? "Contact" : "Public company channel"))}</b>
                <span class="prospect-extracted-kind">${escapeHtml(c.sourceLabel || (c.source === "website_probe" ? "Foreign company website" : c.source))} · ${escapeHtml(verificationLabel(c.verificationStatus || (c.source === "website_probe" ? "source_confirmed" : "unverified")))}</span>
              </div>
              ${c.title ? `<div class="prospect-extracted-title">${escapeHtml(c.title)}</div>` : ""}
              <div class="prospect-extracted-channels">${channelLine(c)}</div>
              ${c.evidenceExcerpt ? `<blockquote class="prospect-contact-evidence-quote">${escapeHtml(c.evidenceExcerpt)}</blockquote>` : ""}
              <div class="prospect-extracted-meta"><span>Confidence ${Math.round(c.confidence ?? (c.source === "website_probe" ? 82 : 65))}%</span><span>${(c.corroboratedSources || []).length > 1 ? `${c.corroboratedSources!.length} sources cross-checked` : "Single source"}</span>${c.evidenceUrl ? `<a class="prospect-extracted-src" href="${escapeHtml(c.evidenceUrl)}" target="_blank" rel="noopener">View evidence</a>` : ""}</div>
            </div>`).join("")}
        </div>
      </details>` : ""}
    </section>`;
}

export async function startContactEnrichment(item: WebsiteOpportunity, button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "查询中";
  }
  try {
    const result = await api<{
      attempt: NonNullable<WebsiteOpportunity["contactEnrichmentAttempts"]>[number] | null;
      opportunity: WebsiteOpportunity;
      replayed: boolean;
    }>(`/api/prospect-list/${encodeURIComponent(item.id)}/contact-enrichment`, {
      method: "POST",
      body: JSON.stringify({ force: true })
    });
    Object.assign(item, result.opportunity);
    renderProspectDetail(item);
    renderLeadFinder(state.websiteOpportunities);
    if (qs<HTMLElement>("#leadFinderVerificationDrawer")?.classList.contains("open")) {
      renderLeadFinderDetail(item);
    }
    scheduleWebsiteProbeRefresh();
    toast(result.replayed ? "Contact review is already in progress" : "Multi-source contact review started");
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not start contact review", "error");
    if (button) {
      button.disabled = false;
      button.textContent = "深入查询";
    }
  }
}

export async function enrichSelectedProspectContacts(button?: HTMLButtonElement) {
  const candidates = state.websiteOpportunities.filter((item) =>
    state.selectedProspectIds.includes(item.id)
    && item.ownerId === state.user?.id
    && item.status !== "excluded"
  );
  if (!candidates.length) {
    toast("Select at least one candidate for contact review", "error");
    return;
  }
  const originalText = button?.textContent || "Review selected contacts";
  if (button) button.disabled = true;
  let started = 0;
  let failed = 0;
  for (const [index, item] of candidates.entries()) {
    if (button) button.textContent = `Starting ${index + 1}/${candidates.length}`;
    try {
      const result = await api<{
        opportunity: WebsiteOpportunity;
      }>(`/api/prospect-list/${encodeURIComponent(item.id)}/contact-enrichment`, {
        method: "POST",
        body: JSON.stringify({ force: true })
      });
      Object.assign(item, result.opportunity);
      started += 1;
    } catch {
      failed += 1;
    }
  }
  renderProspectList();
  renderLeadFinder(state.websiteOpportunities);
  scheduleWebsiteProbeRefresh();
  if (button) {
    button.disabled = false;
    button.textContent = originalText;
  }
  toast(failed
    ? `${started} started; ${failed} could not start`
    : `${started} contact review(s) started; results will update automatically`, failed ? "error" : "success");
}

async function refreshWebsiteProbe(
  item: WebsiteOpportunity,
  attemptId: string
) {
  const result = await api<{
    attempt: WebsiteProbeAttempt;
    terminal: boolean;
    opportunity: WebsiteOpportunity;
  }>(`/api/prospect-list/${encodeURIComponent(item.id)}/website-probe/${encodeURIComponent(attemptId)}`);
  Object.assign(item, result.opportunity);
  renderWebsiteOpportunities(state.websiteOpportunities);
  renderLeadFinder(state.websiteOpportunities);
  renderProspectList();
  return result;
}

async function pollWebsiteProbe(item: WebsiteOpportunity, attemptId: string) {
  const deadline = Date.now() + 2 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const result = await refreshWebsiteProbe(item, attemptId);
      if (result.terminal) return;
    } catch {
      // A later poll can recover from a short API interruption.
    }
    await new Promise((resolve) => window.setTimeout(resolve, 700));
  }
}

function streamWebsiteProbe(item: WebsiteOpportunity, attemptId: string) {
  activeWebsiteProbeStream?.close();
  const attempt = item.websiteProbeAttempts?.find((row) => row.id === attemptId);
  const after = attempt?.events.at(-1)?.sequence || 0;
  const stream = new EventSource(`/api/prospect-list/${encodeURIComponent(item.id)}/website-probe/${encodeURIComponent(attemptId)}/events?after=${after}`);
  activeWebsiteProbeStream = stream;
  stream.addEventListener("probe_event", (raw) => {
    const event = JSON.parse((raw as MessageEvent).data) as WebsiteProbeEvent;
    const current = item.websiteProbeAttempts?.find((row) => row.id === attemptId);
    if (current && !current.events.some((row) => row.id === event.id)) {
      current.events.push(event);
      if (current.status === "queued" && event.stage !== "queued") current.status = "running";
      if (state.selectedProspectId === item.id) renderProspectDetail(item);
    }
  });
  stream.addEventListener("done", () => {
    stream.close();
    if (activeWebsiteProbeStream === stream) activeWebsiteProbeStream = null;
    void refreshWebsiteProbe(item, attemptId);
  });
  stream.onerror = () => {
    stream.close();
    if (activeWebsiteProbeStream === stream) activeWebsiteProbeStream = null;
    void pollWebsiteProbe(item, attemptId);
  };
}

export async function startWebsiteProbe(item: WebsiteOpportunity, button?: HTMLButtonElement) {
  if (button) {
    button.disabled = true;
    button.textContent = "Queuing";
  }
  try {
    const result = await api<{
      attempt: WebsiteProbeAttempt;
      replayed: boolean;
      opportunity: WebsiteOpportunity;
    }>(`/api/prospect-list/${encodeURIComponent(item.id)}/website-probe`, {
      method: "POST",
      body: JSON.stringify({})
    });
    Object.assign(item, result.opportunity);
    renderProspectDetail(item);
    renderLeadFinder(state.websiteOpportunities);
    const terminal = result.attempt.status === "completed" || result.attempt.status === "failed";
    if (terminal) {
      toast("Official-site review completed. See the detail panel for results.");
    } else {
      streamWebsiteProbe(item, result.attempt.id);
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : "Could not start official-site review", "error");
    if (button) {
      button.disabled = false;
      button.textContent = "Review site for public contacts";
    }
  }
}

export function renderProspectDetail(item?: WebsiteOpportunity | null) {
  const box = qs<HTMLElement>("#prospectDetail");
  const sender = qs<HTMLElement>("#prospectSenderStatus");
  const mailWorkspace = qs<HTMLDetailsElement>("#prospectMailWorkspace");
  if (sender) {
    sender.innerHTML = state.user?.outboundEmail
      ? `当前发件人：${escapeHtml(state.user.emailSenderName || state.user.name)} &lt;${escapeHtml(state.user.outboundEmail)}&gt;`
      : `请先到个人主页绑定发件邮箱，再发送开发信。`;
  }
  if (!box) return;
  if (!item) {
    box.innerHTML = `<div class="empty-cell">未选择线索</div>`;
    if (mailWorkspace) {
      mailWorkspace.open = false;
      delete mailWorkspace.dataset.prospectId;
    }
    renderProspectMailPreview();
    return;
  }
  fillProspectMailSourceSelect();
  const score = leadFinderScore(item);
  const duplicate = leadFinderDuplicateState(item);
  const status = prospectStatusMeta(item);
  const qualification = state.prospectQualifications[item.id];
  const owner = state.prospectAssignees.find((assignee) => assignee.id === item.ownerId);
  // 资格审核链已移除：触达补录/回复记录不再依赖资格审核结果。
  const canContact = true;
  const canWriteOutreach = item.ownerId === state.user?.id;
  const dnc = qualification?.blockers.includes("PROSPECT_DO_NOT_CONTACT");
  const readonly = item.status === "synced" ? "disabled" : "";
  const procurementContext = state.procurementContexts[item.id];
  box.innerHTML = `
    <div class="prospect-detail-hero">
      ${badge(status.label, status.tone)} ${badge(`行动优先 ${score}`, score >= 76 ? "green" : score >= 60 ? "amber" : "gray")} ${badge(duplicate.text, duplicate.tone)} ${prospectEmailEligibilityBadge(item)}${prospectResearchRunning(item) ? researchRunningBadgeHtml() : ""}
      <h2>${escapeHtml(item.company)}</h2>
      <p>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(item.business || "业务待维护")} · ${escapeHtml(websiteDomain(item.website || ""))}</p>
      <p>加入搜客清单：${escapeHtml(formatProspectJoinedAt(item.shortlistedAt || item.createdAt))}</p>
    </div>
    ${renderExtractedContactsPanel(item)}
    <div class="prospect-field-grid">
      <div class="form-field"><label>公司</label><input id="prospectEditCompany" value="${escapeHtml(item.company)}" ${readonly}></div>
      <div class="form-field"><label>官网</label><input id="prospectEditWebsite" value="${escapeHtml(item.website)}" ${readonly}></div>
      <div class="form-field"><label>业务方向</label><input id="prospectEditBusiness" value="${escapeHtml(item.business)}" ${readonly}></div>
      <div class="form-field"><label>国家/地区</label><input id="prospectEditCountry" value="${escapeHtml(item.country)}" ${readonly}></div>
      <div class="form-field"><label>联系人</label><input id="prospectEditContact" value="${escapeHtml(item.contact)}" ${readonly}></div>
      <div class="form-field"><label>联系方式</label><input id="prospectEditContactInfo" value="${escapeHtml(item.contactInfo)}" ${readonly}></div>
      <div class="prospect-field"><span>归属业务员</span><b>${escapeHtml(owner?.name || (item.ownerId === state.user?.id ? state.user?.name || "本人" : item.ownerId || "待分配"))}</b></div>
      <div class="prospect-field"><span>来源</span><b>${escapeHtml(item.sourceLabel || item.source || "自动获客")}</b></div>
      <div class="prospect-field"><span>最近开发信</span><b>${item.lastDevelopmentEmailAt ? `${formatTime(item.lastDevelopmentEmailAt)} · ${escapeHtml(item.lastDevelopmentEmailSubject || "开发信")}` : "尚未发送"}</b></div>
      <div class="prospect-field"><span>最近触达</span><b>${item.lastTouchpointAt ? `${formatTime(item.lastTouchpointAt)} · ${escapeHtml(PROSPECT_CHANNEL_LABELS[item.lastTouchpointChannel || "email"])}` : "尚未记录"}</b></div>
      <div class="prospect-field"><span>最近回复</span><b>${item.lastReplyClassification ? escapeHtml(PROSPECT_REPLY_LABELS[item.lastReplyClassification]) : "尚未记录"}</b></div>
      <div class="prospect-field"><span>下次跟进</span><b>${escapeHtml(item.nextFollowAt || "待安排")}</b></div>
      <div class="form-field" style="grid-column:1/-1"><label>候选备注</label><textarea id="prospectEditDescription" ${readonly}>${escapeHtml(item.description || "")}</textarea></div>
      ${item.excludedReason ? `<div class="prospect-field" style="grid-column:1/-1"><span>排除原因</span><b>${escapeHtml(item.excludedReason)}</b></div>` : ""}
    </div>
    <details class="prospect-technical-audit" ${prospectTechnicalAuditOpenId === item.id ? "open" : ""}>
      <summary><span>技术核验记录</span><small>企业身份、官网证据</small></summary>
      <div class="prospect-technical-audit-body">
        ${renderProspectScorecard(item)}
        ${renderWebsiteProbePanel(item)}
      </div>
    </details>
    <details class="prospect-ai-research" ${prospectResearchOpenId === item.id ? "open" : ""}>
      <summary><span>AI 背调</span><small>联网证据 + 本库资料；只作参考，写回需逐字段确认</small></summary>
      <div id="prospectResearchResult" class="prospect-research-body">正在读取背调记录…</div>
      <div class="prospect-action-row">
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:#4a5a70">执行方式
          <select id="prospectResearchSourceSelect" class="engine-source-select" title="选择这次背调由谁执行"></select>
        </label>
        <button class="btn primary" id="prospectBackgroundResearchButton">一键背调</button>
      </div>
    </details>
    <div class="inline-alert"><b>下一步</b><span>${escapeHtml(status.action)}</span></div>
    ${renderProcurementContextPanel(procurementContext, item)}
    <div class="prospect-action-row">
      ${item.status !== "synced" ? `<button class="btn" id="prospectSaveButton">保存候选资料</button>` : ""}
      ${item.status === "excluded" && !dnc ? `<button class="btn" id="prospectRestoreButton">恢复待核验</button>` : ""}
      ${item.status !== "synced" ? `<button class="btn primary" id="prospectDetailSyncButton">转为线索</button>` : ""}
      ${item.status === "synced" && item.leadId ? `<button class="btn primary" id="prospectViewLeadButton">查看线索</button>` : ""}
      ${canWriteOutreach && canContact ? `<button class="btn" id="prospectTouchpointButton">补录历史触达</button><button class="btn" id="prospectReplyButton">记录回复</button>` : ""}
      ${item.lastTouchpointAt ? `<button class="btn" id="prospectTouchpointHistoryButton">查看记录</button>` : ""}
      ${canWriteOutreach && item.status === "synced" && item.leadId ? `<button class="btn" id="prospectTodoButton">生成待办</button>` : ""}
    </div>
  `;
  qs<HTMLButtonElement>("#prospectSaveButton", box)?.addEventListener("click", (event) => void saveProspectVerification(item, event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectRestoreButton", box)?.addEventListener("click", (event) => void updateProspectBatch("restore", [item.id], event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectDetailSyncButton", box)?.addEventListener("click", (event) => void syncProspects([item.id], event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectViewLeadButton", box)?.addEventListener("click", () => void openProspectLead(item));
  qs<HTMLButtonElement>("#prospectTodoButton", box)?.addEventListener("click", (event) => void createSelectedProspectTodo(event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectTouchpointButton", box)?.addEventListener("click", () => openProspectTouchpointModal(item));
  qs<HTMLButtonElement>("#prospectReplyButton", box)?.addEventListener("click", () => openProspectReplyModal(item));
  qs<HTMLButtonElement>("#prospectTouchpointHistoryButton", box)?.addEventListener("click", () => void openProspectTouchpointHistory(item));
  qs<HTMLDetailsElement>(".prospect-technical-audit", box)?.addEventListener("toggle", (event) => {
    prospectTechnicalAuditOpenId = (event.currentTarget as HTMLDetailsElement).open ? item.id : "";
  });
  qs<HTMLDetailsElement>(".prospect-ai-research", box)?.addEventListener("toggle", (event) => {
    prospectResearchOpenId = (event.currentTarget as HTMLDetailsElement).open ? item.id : "";
  });
  bindProspectIdentityBootstrapActions(box, item);
  qs<HTMLButtonElement>("#prospectContactEnrichmentButton", box)?.addEventListener("click", (event) => void startContactEnrichment(item, event.currentTarget as HTMLButtonElement));
  qs<HTMLButtonElement>("#prospectBackgroundResearchButton", box)?.addEventListener("click", (event) => {
    const source = (qs<HTMLSelectElement>("#prospectResearchSourceSelect", box)?.value || effectiveResearchSource()) as ResearchEngineSource;
    void runProspectBackgroundResearch(item, event.currentTarget as HTMLButtonElement, null, source);
  });
  fillProspectResearchSourceSelect(box);
  const researchResultBox = qs<HTMLElement>("#prospectResearchResult");
  if (prospectResearchRunning(item) && researchResultBox) {
    // 背调进行中：列表刷新重绘面板时保持等待动画，不打断（终态后 refresh 会带回结果卡）
    researchResultBox.innerHTML = `${cliWaitPanelHtml("research", "本机 CLI")}
      <p class="research-progress-note">正在调研 ${escapeHtml(item.company)}，完成后自动显示证据卡…</p>`;
    startCliWaitTicker("research");
  } else {
    void loadProspectResearchHistory(item, researchResultBox);
  }
  qs<HTMLButtonElement>("#prospectWebsiteProbeButton", box)?.addEventListener("click", (event) => void startWebsiteProbe(item, event.currentTarget as HTMLButtonElement));
  bindProcurementContextActions(box, item, procurementContext);
  if (!procurementContext) void loadProspectProcurementContext(item);
  if (!prospectIdentityBootstrapViews.has(item.id)
    && !prospectIdentityBootstrapLoading.has(item.id)) {
    void loadProspectIdentityBootstrap(item);
  }
  const identityAttempt = latestProspectIdentityBootstrap(item);
  if (identityAttempt?.taskStatus === "running") {
    pollProspectIdentityBootstrap(item, identityAttempt.id);
  }
  if (mailWorkspace && mailWorkspace.dataset.prospectId !== item.id) {
    mailWorkspace.open = Boolean(item.lastDevelopmentEmailAt);
    mailWorkspace.dataset.prospectId = item.id;
  }
  // 资格审核链已移除：收件邮箱不再锁定人工批准邮箱，按候选资料自动带入。
  const suggestedEmail = (item.contactInfo || "")
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0] || "";
  const mailTo = qs<HTMLInputElement>("#prospectMailTo");
  if (mailTo) {
    if (suggestedEmail && !mailTo.value) mailTo.value = suggestedEmail;
    mailTo.readOnly = false;
    mailTo.placeholder = "收件邮箱";
  }
  renderProspectMailPreview();
}

interface ProspectBackgroundResearchView {
  research: {
    id: string;
    company: string;
    country: string;
    score: number;
    verdict: string;
    summary: string;
    facts: Array<{ label: string; value: string }>;
    contacts: Array<{ channel: string; value: string }>;
    opportunities: string[];
    risks: Array<{ level: "high" | "medium" | "low"; title: string; detail: string }>;
    sources: Array<{ title: string; url: string; observedAt: string; detail?: string; authority?: string }>;
    sourceChecks: Array<{ providerName?: string; status: string; message: string }>;
    nextAction: string;
    engine: string;
    completedAt: string;
  };
}

const PROSPECT_RESEARCH_FACT_FIELD_MAP: Array<{ label: RegExp; field: "company" | "website" | "business" | "country" }> = [
  { label: /^主体$/u, field: "company" },
  { label: /^官网\s*\/\s*域名$/u, field: "website" },
  { label: /^业务$/u, field: "business" },
  { label: /^国家\s*\/\s*地区$/u, field: "country" }
];

function prospectResearchConfidence(authority?: string) {
  switch (authority) {
    case "controlled_website": return "高（受控官网）";
    case "native_web_search": return "中（联网检索引用）";
    default: return "参考";
  }
}

/**
 * W3 · 候选一键背调：调用 /api/ai-background-research（entityType=prospect），
 * 以证据卡呈现，落实「不自动覆盖候选资料」——写回必须逐字段勾选确认。
 */
/** 候选背调历史缓存：详情/抽屉打开时回填最近一次背调卡，60 秒内不重复拉取 */
const prospectResearchCache = new Map<string, { at: number; research: ProspectBackgroundResearchView["research"] | null }>();
const prospectResearchDismissed = new Set<string>();

type ProspectResearchWriteBackField = { field: "company" | "website" | "business" | "country"; label: string; value: string; current: string };

function prospectResearchWriteBackFields(item: WebsiteOpportunity, research: ProspectBackgroundResearchView["research"]): ProspectResearchWriteBackField[] {
  return research.facts
    .map((fact) => {
      const mapped = PROSPECT_RESEARCH_FACT_FIELD_MAP.find((rule) => rule.label.test(fact.label));
      if (!mapped) return null;
      const current = (item[mapped.field] || "").trim();
      const value = fact.value.trim();
      if (!value || value === "待核实" || value === current) return null;
      return { field: mapped.field, label: fact.label, value, current };
    })
    .filter((row): row is ProspectResearchWriteBackField => Boolean(row));
}

/** 背调证据卡：新跑的背调与历史回填共用同一渲染；非归属人查看时只读 */
function renderProspectResearchCard(item: WebsiteOpportunity, research: ProspectBackgroundResearchView["research"], box: HTMLElement, allowWriteback = true) {
  const writeBackFields = allowWriteback ? prospectResearchWriteBackFields(item, research) : [];
  const riskTone = { high: "red", medium: "amber", low: "gray" } as const;
  box.innerHTML = `
    <div class="prospect-research-card">
      <div class="prospect-research-head">
        ${badge(`背调评分 ${research.score}`, research.score >= 78 ? "green" : research.score >= 60 ? "amber" : "red")}
        ${badge(escapeHtml(research.verdict), research.score >= 60 ? "green" : "amber")}
        <small>引擎：${escapeHtml(research.engine)} · ${escapeHtml(formatDateTime(research.completedAt))}</small>
      </div>
      <p class="prospect-research-summary">${escapeHtml(research.summary)}</p>
      <dl class="prospect-research-facts">
        ${research.facts.map((fact) => `<div><dt>${escapeHtml(fact.label)}</dt><dd>${escapeHtml(fact.value)}</dd></div>`).join("")}
      </dl>
      ${research.contacts.length ? `<p class="prospect-research-line"><b>联系方式</b>${research.contacts.map((contact) => `${escapeHtml(contact.channel)}：${escapeHtml(contact.value)}`).join(" · ")}</p>` : ""}
      ${research.opportunities.length ? `<p class="prospect-research-line"><b>机会点</b>${research.opportunities.map((row) => escapeHtml(row)).join("；")}</p>` : ""}
      ${research.risks.map((risk) => `<p class="prospect-research-line">${badge(risk.title, riskTone[risk.level])}<span>${escapeHtml(risk.detail)}</span></p>`).join("")}
      <p class="prospect-research-line"><b>下一步</b>${escapeHtml(research.nextAction)}</p>
      <details class="prospect-research-sources">
        <summary>证据来源（${research.sources.length}）与检查记录（${research.sourceChecks.length}）</summary>
        <ul>
          ${research.sources.map((source) => `<li>
            <span>[${escapeHtml(prospectResearchConfidence(source.authority))}]</span>
            ${/^https?:\/\//i.test(source.url) ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(source.title || source.url)}</a>` : `<b>${escapeHtml(source.title)}</b>`}
            <small>${source.observedAt ? escapeHtml(formatDateTime(source.observedAt)) : ""}${source.detail ? ` · ${escapeHtml(source.detail)}` : ""}</small>
          </li>`).join("") || "<li>无外部来源</li>"}
          ${research.sourceChecks.map((check) => `<li><span>[${escapeHtml(check.providerName || "检查")} · ${escapeHtml(check.status)}]</span><small>${escapeHtml(check.message)}</small></li>`).join("")}
        </ul>
      </details>
      <div class="prospect-action-row">
        ${writeBackFields.length ? `<div class="prospect-research-writeback">
          ${writeBackFields.map((row, index) => `<label class="prospect-research-field"><input type="checkbox" data-research-field="${row.field}" data-research-value="${escapeHtml(row.value)}" ${index === 0 ? "checked" : ""}> ${escapeHtml(row.label)}：${escapeHtml(row.current || "（空）")} → <b>${escapeHtml(row.value)}</b></label>`).join("")}
        </div>` : `<small class="prospect-research-note">${allowWriteback ? "本次背调没有与候选字段冲突的可写回信息。" : "该候选归属其他业务员，背调结果仅供参考。"}</small>`}
        ${writeBackFields.length ? `<button class="btn" id="prospectResearchWritebackButton">采信并写回</button>` : ""}
        <button class="btn" id="prospectResearchDismissButton">仅参考</button>
      </div>
    </div>`;
  qs<HTMLButtonElement>("#prospectResearchDismissButton", box)?.addEventListener("click", () => {
    box.innerHTML = `<div class="empty-cell">已按「仅参考」关闭本次背调结果，未修改任何候选资料。</div>`;
    prospectResearchDismissed.add(item.id);
    toast("背调结果仅作参考，未写回任何字段");
  });
  qs<HTMLButtonElement>("#prospectResearchWritebackButton", box)?.addEventListener("click", (event) =>
    void applyProspectResearchWriteback(item, writeBackFields, event.currentTarget as HTMLButtonElement, box));
}

/** 打开详情/抽屉时回填最近一次背调记录（后端留档 background_research_records） */
export async function loadProspectResearchHistory(item: WebsiteOpportunity, box: HTMLElement | null) {
  if (!box || box.dataset.researchBusy === "1") return;
  const allowWriteback = !item.ownerId || item.ownerId === state.user?.id;
  const cached = prospectResearchCache.get(item.id);
  if (cached && Date.now() - cached.at < 60_000) {
    if (cached.research && !prospectResearchDismissed.has(item.id)) {
      renderProspectResearchCard(item, cached.research, box, allowWriteback);
      box.closest<HTMLDetailsElement>("details") && (box.closest<HTMLDetailsElement>("details")!.open = true);
    }
    return;
  }
  try {
    const result = await api<{ research: ProspectBackgroundResearchView["research"] | null }>(
      `/api/prospect-list/${encodeURIComponent(item.id)}/background-research`
    );
    prospectResearchCache.set(item.id, { at: Date.now(), research: result.research || null });
    // 拉取期间用户可能已点了新背调（busy）或容器已换内容，避免覆盖
    if (box.isConnected && box.dataset.researchBusy !== "1" && !box.querySelector(".prospect-research-card")) {
      if (result.research && !prospectResearchDismissed.has(item.id)) {
        renderProspectResearchCard(item, result.research, box, allowWriteback);
        const details = box.closest<HTMLDetailsElement>("details");
        if (details) details.open = true;
      } else if (!result.research) {
        box.innerHTML = `<div class="empty-cell">暂无背调记录。点击下方按钮发起 AI 背调。</div>`;
      }
    }
  } catch {
    // 历史读取失败不打扰：占位文案保留，点击背调按钮仍可正常执行
  }
}

export async function runProspectBackgroundResearch(
  item: WebsiteOpportunity,
  button: HTMLButtonElement,
  resultBox?: HTMLElement | null,
  sourceOverride?: ResearchEngineSource
) {
  const box = resultBox || qs<HTMLElement>("#prospectResearchResult");
  const allowWriteback = !item.ownerId || item.ownerId === state.user?.id;
  const source = (sourceOverride || effectiveResearchSource()) as ResearchEngineSource;
  button.disabled = true;
  if (source === "cli") {
    // 立即登记「背调中」：所有相关列表的行内徽章在下一次重绘时亮起（后端 researchRunning 随后接管）
    localResearchRunningIds.add(item.id);
    item.researchRunning = true;
  }
  if (box) {
    box.dataset.researchBusy = "1";
    box.innerHTML = `<div class="empty-cell">背调执行中：正在汇集本库资料与合规联网证据…</div>`;
  }
  // 选了本机 CLI 就立刻亮等待动画（点按钮即出现，不等接口返回）——
  // 后端约 10 秒才回 202+jobId，CLI 完整调研要 1-2 分钟。
  if (source === "cli" && box) {
    box.innerHTML = `${cliWaitPanelHtml("research", "本机 CLI")}
      <p class="research-progress-note">正在派给本机 Runner 调研 ${escapeHtml(item.company)}…</p>`;
    startCliWaitTicker("research");
  }
  try {
    const result = await api<ProspectBackgroundResearchView & {
      pending?: boolean;
      engineJob?: AiEngineJobView;
      runnerName?: string;
      engine?: string;
    }>("/api/ai-background-research", {
      method: "POST",
      body: JSON.stringify({ entityType: "prospect", entityId: item.id, source })
    });
    let research: ProspectBackgroundResearchView["research"] | null = result.research;
    if (!research && result.pending && result.engineJob) {
      // 后端约 10 秒就返回 202+jobId：立即亮出 CLI 等待动画（点按钮即出现，不等响应），
      // 轮询到终态再渲染证据卡；期间可切换页面，作业结果由后端落档不会丢。
      if (box) {
        box.innerHTML = `${cliWaitPanelHtml("research", result.engine || "本机 CLI")}
          <p class="research-progress-note">已派给 ${escapeHtml(result.runnerName || "本机 Runner")}，正在调研 ${escapeHtml(item.company)}…</p>`;
        startCliWaitTicker("research");
      }
      toast("已形成后台任务，本机 CLI 正在调研；期间可以切换页面，结果不会丢", "info");
      const payload = await awaitAiEngineJob(result.engineJob, (job) => {
        qsa<HTMLElement>(".cli-wait-found", box || undefined).forEach((node) => {
          node.textContent = job.status === "running" ? `本机 CLI 执行中 · 作业号 ${job.id.slice(-8)}` : "";
          node.toggleAttribute("hidden", !node.textContent);
        });
      });
      research = (payload.research || null) as ProspectBackgroundResearchView["research"] | null;
    }
    if (!research) {
      throw new Error("本机 CLI 没有返回背调结果，请到「集成中心 · 本地 Runner」查看执行日志");
    }
    if (box) renderProspectResearchCard(item, research, box, allowWriteback);
    prospectResearchCache.set(item.id, { at: Date.now(), research });
    prospectResearchDismissed.delete(item.id);
    toast(research.sources.length ? `背调完成：${research.sources.length} 条来源证据` : "背调完成：暂无外部来源，结果仅基于本库资料");
  } catch (error) {
    if (box) box.innerHTML = `<div class="empty-cell">${escapeHtml(error instanceof Error ? error.message : "背调失败，请稍后重试")}</div>`;
    toast(error instanceof Error ? error.message : "背调失败", "error");
  } finally {
    stopCliWaitTicker("research");
    if (box) delete box.dataset.researchBusy;
    button.disabled = false;
    if (source === "cli") {
      // 终态：撤掉本会话「背调中」标记并刷新列表（徽章由后端 researchRunning=false 接管，历史结果卡从缓存回填）
      localResearchRunningIds.delete(item.id);
      item.researchRunning = false;
      void refreshCandidatesAfterAcquire();
    }
  }
}

async function applyProspectResearchWriteback(
  item: WebsiteOpportunity,
  fields: Array<{ field: "company" | "website" | "business" | "country"; label: string; value: string; current: string }>,
  button: HTMLButtonElement,
  root?: HTMLElement | null
) {
  const checked = qsa<HTMLInputElement>("input[data-research-field]", root || undefined)
    .filter((input) => input.checked);
  if (!checked.length) {
    toast("请至少勾选一个要写回的字段", "error");
    return;
  }
  const patch: Record<string, string> = {};
  checked.forEach((input) => {
    const field = input.dataset.researchField || "";
    const value = input.dataset.researchValue || "";
    if (field && value) patch[field] = value;
  });
  if (!patch.company || !patch.website) {
    if (!patch.company && !item.company) {
      toast("公司名不能为空，无法写回", "error");
      return;
    }
    if (!patch.website && !item.website) {
      toast("官网不能为空，无法写回", "error");
      return;
    }
    if (!patch.company) patch.company = item.company;
    if (!patch.website) patch.website = item.website;
  }
  button.disabled = true;
  try {
    const result = await api<{ opportunity: WebsiteOpportunity; qualificationInvalidated: boolean }>(
      `/api/prospect-list/${encodeURIComponent(item.id)}/details`,
      {
        method: "PATCH",
        body: JSON.stringify({
          ...patch,
          business: patch.business ?? item.business,
          country: patch.country ?? item.country,
          contact: item.contact,
          contactInfo: item.contactInfo,
          description: item.description,
          requestId: prospectRequestId("research-writeback")
        })
      }
    );
    Object.assign(item, result.opportunity);
    renderProspectList();
    renderProspectDetail();
    toast(`已采信写回 ${Object.keys(patch).length} 个字段${result.qualificationInvalidated ? "；受影响资格步骤已失效，请重新核验" : ""}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "写回失败", "error");
  } finally {
    button.disabled = false;
  }
}

async function saveProspectVerification(item: WebsiteOpportunity, button?: HTMLButtonElement) {
  const value = (selector: string) => qs<HTMLInputElement | HTMLTextAreaElement>(selector)?.value.trim() || "";
  const payload = {
    company: value("#prospectEditCompany"),
    website: value("#prospectEditWebsite"),
    business: value("#prospectEditBusiness"),
    country: value("#prospectEditCountry"),
    contact: value("#prospectEditContact"),
    contactInfo: value("#prospectEditContactInfo"),
    description: value("#prospectEditDescription"),
    requestId: prospectRequestId("candidate-details")
  };
  if (!payload.company || !payload.website) {
    toast("公司和官网不能为空", "error");
    return;
  }
  if (button) button.disabled = true;
  try {
    const result = await api<{
      opportunity: WebsiteOpportunity;
      qualification: ProspectQualificationViewApi | null;
      qualificationInvalidated: boolean;
      changedFields: string[];
    }>(`/api/prospect-list/${encodeURIComponent(item.id)}/details`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    Object.assign(item, result.opportunity);
    if (result.qualification) {
      state.prospectQualifications[item.id] = result.qualification;
    }
    renderProspectList();
    toast(result.qualificationInvalidated
      ? "资料已保存；受影响的资格步骤已失效，请按提示重新核验"
      : "核验资料已保存");
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存核验资料失败", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * W2 · 发信资格灯：把后端下发的 emailEligibility 渲染成三态徽标。
 * 绿=可发信、黄=缺邮箱、红=已抑制；title 带原始原因码与说明，便于排查。
 * 判定完全在后端（复用 assertProspectEmailOutreachEligible 的同一套分支），前端只负责呈现。
 */
export function prospectEmailEligibilityBadge(item: WebsiteOpportunity) {
  const eligibility = item.emailEligibility;
  if (!eligibility) return "";
  const tone = eligibility.ready ? "green" : eligibility.state === "missing_email" ? "amber" : "red";
  const title = `[${eligibility.code}] ${eligibility.message}`;
  return `<span class="prospect-eligibility" title="${escapeHtml(title)}">${badge(eligibility.label, tone)}</span>`;
}

function prospectsAsSyncRows(ids: string[]) {
  return state.websiteOpportunities.filter((item) => ids.includes(item.id)).map((item) => ({
    id: item.id,
    company: item.company,
    business: item.business,
    country: item.country,
    website: item.website,
    contact: item.contact,
    contactInfo: item.contactInfo,
    description: item.description,
    source: item.source || "",
    sourceLabel: item.sourceLabel || ""
  }));
}

async function syncProspects(ids: string[], button?: HTMLButtonElement) {
  const opportunities = prospectsAsSyncRows(ids);
  const originalButtonText = button?.textContent || "";
  if (!opportunities.length) {
    toast("请先选择要入线索的候选", "error");
    return;
  }
  const selectedCandidates = state.websiteOpportunities.filter((item) =>
    ids.includes(item.id)
  );
  // 资格审核链已移除：转线索不再要求资格审核通过。
  const invalid = state.websiteOpportunities.filter((item) => ids.includes(item.id) && !["preview", "contactable", "contacted"].includes(item.status));
  if (invalid.length) {
    toast("已排除或已入线索的候选不能重复同步", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "加入中";
  }
  try {
    const result = await api<{ created: LeadSyncResult[] }>("/api/tools/website-scrape/sync-opportunities", {
      method: "POST",
      body: JSON.stringify({
        requestId: prospectRequestId("lead-conversion"),
        opportunities
      })
    });
    result.created.forEach((item) => {
      if (!state.leads.some((lead) => lead.id === item.lead.id)) state.leads.unshift(item.lead);
      const existing = state.websiteOpportunities.find((row) => row.id === item.opportunity.id || row.website === item.opportunity.website);
      if (existing) Object.assign(existing, item.opportunity);
      else state.websiteOpportunities.unshift(item.opportunity);
      state.selectedProspectId = item.opportunity.id;
    });
    state.selectedProspectIds = state.selectedProspectIds.filter((id) => !ids.includes(id));
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    renderLeads();
    requestDashboardRefresh();
    toast(`已加入 ${result.created.length} 条线索`);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalButtonText;
    }
  }
}

export async function syncSelectedProspects(button?: HTMLButtonElement) {
  await syncProspects(state.selectedProspectIds, button);
}

export function requestProspectExclusion(ids: string[], button?: HTMLButtonElement) {
  if (!ids.length) {
    toast("请先选择候选", "error");
    return;
  }
  openModal(
    "排除候选",
    `<div class="form-field"><label>排除原因</label><textarea id="prospectExcludeReasonInput" placeholder="例如：非目标行业、官网失效、联系方式无效"></textarea></div>`,
    `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="confirmProspectExcludeButton">确认排除</button>`
  );
  qs<HTMLButtonElement>("#confirmProspectExcludeButton")?.addEventListener("click", async (event) => {
    const reason = qs<HTMLTextAreaElement>("#prospectExcludeReasonInput")?.value.trim() || "";
    closeModal();
    await updateProspectBatch("exclude", ids, button || event.currentTarget as HTMLButtonElement, reason);
  });
}

export async function updateProspectBatch(
  action: "shortlist" | "exclude" | "restore" | "assign",
  ids: string[],
  button?: HTMLButtonElement,
  reason = ""
) {
  if (!ids.length) {
    toast("请先选择候选", "error");
    return;
  }
  const ownerId = action === "assign" ? qs<HTMLSelectElement>("#prospectAssigneeSelect")?.value || "" : "";
  if (action === "assign" && !ownerId) {
    toast("请选择目标业务员", "error");
    return;
  }
  if (button) button.disabled = true;
  try {
    const requestId = globalThis.crypto?.randomUUID?.()
      || `prospect-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const effectiveAt = new Date().toISOString();
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/prospect-list/batch", {
      method: "PATCH",
      body: JSON.stringify({
        ids,
        action,
        ownerId: ownerId || undefined,
        reason,
        requestId,
        effectiveAt
      })
    });
    result.opportunities.forEach((updated) => {
      const existing = state.websiteOpportunities.find((item) => item.id === updated.id);
      if (existing) Object.assign(existing, updated);
    });
    state.selectedProspectIds = state.selectedProspectIds.filter((id) => !ids.includes(id));
    renderProspectList();
    toast(action === "shortlist" ? "已加入搜客清单" : action === "exclude" ? "已排除所选候选" : action === "restore" ? "已恢复为待核验" : "已完成分配");
  } catch (error) {
    toast(error instanceof Error ? error.message : "批量处理失败", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

export async function openProspectLead(item: WebsiteOpportunity) {
  if (!item.leadId) {
    toast("该候选尚未生成线索", "error");
    return;
  }
  activateNavView("leads");
  await openLead(item.leadId);
}

async function createSelectedProspectTodo(button?: HTMLButtonElement) {
  const item = selectedProspect();
  if (!item) {
    toast("请先选择一条搜客线索", "error");
    return;
  }
  if (item.ownerId !== state.user?.id) {
    toast("只有归属业务员可以生成跟进待办", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "生成中";
  }
  try {
    const result = await api<{ todo: Todo; opportunity: WebsiteOpportunity }>(`/api/prospect-list/${encodeURIComponent(item.id)}/follow-up`, {
      method: "POST",
      body: JSON.stringify({
        channel: item.lastTouchpointChannel || "email",
        priority: leadFinderScore(item) >= 76 ? "high" : "medium"
      })
    });
    syncProspectTodo(result.todo);
    Object.assign(item, result.opportunity);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    renderTopbarStats();
    renderProspectList();
    toast("已生成搜客跟进待办");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "生成待办";
    }
  }
}

function syncProspectTodo(todo?: Todo) {
  if (!todo) return;
  const existing = state.todos.find((item) => item.id === todo.id);
  if (existing) Object.assign(existing, todo);
  else state.todos.unshift(todo);
}

export function prospectRequestId(prefix: string) {
  return globalThis.crypto?.randomUUID?.()
    || `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function openProspectTouchpointModal(item: WebsiteOpportunity) {
  openModal("补录历史触达", `
    <div class="form-grid">
      <div class="form-field"><label>触达方式</label><select id="prospectTouchChannel"><option value="email">邮件</option><option value="whatsapp">WhatsApp</option><option value="call">电话</option></select></div>
      <div class="form-field"><label>触达时间</label><input id="prospectTouchOccurredAt" type="datetime-local" value="${escapeHtml(localDateTimeValue())}"></div>
      <div class="form-field full"><label>联系方式</label><input id="prospectTouchContact" value="${escapeHtml(item.contactInfo || item.contact || "")}" placeholder="邮箱、WhatsApp 或电话号码"></div>
      <div class="form-field full"><label>主题/目的</label><input id="prospectTouchSubject" placeholder="例如：首次产品介绍"></div>
      <div class="form-field full"><label>沟通摘要</label><textarea id="prospectTouchContent" placeholder="记录发送内容、电话结论或下一步约定"></textarea></div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveProspectTouchpointButton">保存历史记录</button>`);
  qs<HTMLButtonElement>("#saveProspectTouchpointButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const occurredValue = qs<HTMLInputElement>("#prospectTouchOccurredAt")?.value || "";
    button.disabled = true;
    try {
      const result = await api<{ touchpoint: ProspectTouchpoint; todo?: Todo; opportunity: WebsiteOpportunity }>(`/api/prospect-list/${encodeURIComponent(item.id)}/touchpoints`, {
        method: "POST",
        body: JSON.stringify({
          recordMode: "historical",
          channel: qs<HTMLSelectElement>("#prospectTouchChannel")?.value || "email",
          contactValue: qs<HTMLInputElement>("#prospectTouchContact")?.value.trim() || "",
          subject: qs<HTMLInputElement>("#prospectTouchSubject")?.value.trim() || "",
          content: qs<HTMLTextAreaElement>("#prospectTouchContent")?.value.trim() || "",
          occurredAt: occurredValue ? new Date(occurredValue).toISOString() : undefined,
          requestId: prospectRequestId("touchpoint")
        })
      });
      Object.assign(item, result.opportunity);
      closeModal();
      renderProspectList();
      toast("历史触达事实已保存，当前状态和待办未变更");
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存触达失败", "error");
      button.disabled = false;
    }
  });
}

function openProspectReplyModal(item: WebsiteOpportunity) {
  openModal("记录客户回复", `
    <div class="form-grid">
      <div class="form-field"><label>回复渠道</label><select id="prospectReplyChannel"><option value="email">邮件</option><option value="whatsapp">WhatsApp</option><option value="call">电话</option></select></div>
      <div class="form-field"><label>回复结论</label><select id="prospectReplyClassification">
        <option value="clear_demand">明确需求</option>
        <option value="interested_nurture">有兴趣待培育</option>
        <option value="referral">转介绍</option>
        <option value="no_current_demand">当前无需求</option>
        <option value="auto_unknown">自动回复/待判断</option>
        <option value="rejected">明确拒绝</option>
        <option value="unsubscribed">要求退订</option>
        <option value="bounced">联系方式退信</option>
      </select></div>
      <div class="form-field"><label>回复时间</label><input id="prospectReplyOccurredAt" type="datetime-local" value="${escapeHtml(localDateTimeValue())}"></div>
      <div class="form-field"><label>联系方式</label><input id="prospectReplyContact" value="${escapeHtml(item.contactInfo || item.contact || "")}"></div>
      <div class="form-field full"><label>回复内容</label><textarea id="prospectReplyContent" placeholder="记录客户原意和关键需求"></textarea></div>
      <div class="form-grid" id="prospectProcurementFields" style="grid-column:1/-1">
        <div class="form-field full"><label>产品 / 应用</label><input id="prospectProcurementProduct" placeholder="客户明确提到的产品、型号或应用"></div>
        <div class="form-field full"><label>规格要求</label><input id="prospectProcurementSpecification" placeholder="材质、尺寸、包装或技术参数"></div>
        <div class="form-field"><label>数量</label><input id="prospectProcurementQuantity" type="number" min="0" step="1" value="0"></div>
        <div class="form-field"><label>数量口径</label><select id="prospectProcurementQuantityType"><option value="unknown">待确认</option><option value="sample">样品</option><option value="trial">试单</option><option value="forecast">预测用量</option><option value="order">正式订单</option></select></div>
        <div class="form-field"><label>目标单价</label><input id="prospectProcurementTargetPrice" type="number" min="0" step="0.01" value="0"></div>
        <div class="form-field"><label>币种</label><select id="prospectProcurementCurrency"><option>USD</option><option>EUR</option><option>GBP</option><option>CNY</option><option>JPY</option><option>AED</option></select></div>
        <div class="form-field"><label>采购时间</label><input id="prospectProcurementTimeline" placeholder="例如：8 月前完成首单"></div>
        <div class="form-field"><label>买方角色</label><input id="prospectProcurementBuyerRole" placeholder="采购经理、项目负责人等"></div>
        <div class="form-field"><label>交付要求</label><input id="prospectProcurementDelivery" placeholder="交期、目的港或贸易条款"></div>
        <div class="form-field"><label>认证要求</label><input id="prospectProcurementCertification" placeholder="CE、FDA、RoHS 等"></div>
        <div class="form-field full"><label>明确采购动作</label><div class="procurement-evidence-inputs">
          <label><input type="checkbox" value="quote_request">要求报价</label>
          <label><input type="checkbox" value="sample_request">具体样品</label>
          <label><input type="checkbox" value="project_tender">项目/招标</label>
          <label><input type="checkbox" value="manual_confirmation">业务员确认真实推进</label>
        </div></div>
        <div class="form-field full"><label>下一步动作</label><input id="prospectProcurementNextAction" placeholder="例如：明天下午发送正式报价并确认样品数量"></div>
      </div>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveProspectReplyButton">保存回复</button>`);
  qs<HTMLSelectElement>("#prospectReplyChannel")!.value = item.lastTouchpointChannel || "email";
  const toggleProcurementFields = () => {
    const clearDemand = qs<HTMLSelectElement>("#prospectReplyClassification")?.value === "clear_demand";
    qs<HTMLElement>("#prospectProcurementFields")?.classList.toggle("is-hidden", !clearDemand);
  };
  qs<HTMLSelectElement>("#prospectReplyClassification")?.addEventListener("change", toggleProcurementFields);
  toggleProcurementFields();
  qs<HTMLButtonElement>("#saveProspectReplyButton")?.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const occurredValue = qs<HTMLInputElement>("#prospectReplyOccurredAt")?.value || "";
    const classification = (qs<HTMLSelectElement>("#prospectReplyClassification")?.value || "auto_unknown") as ProspectReplyClassification;
    const procurement = classification === "clear_demand" ? {
      product: qs<HTMLInputElement>("#prospectProcurementProduct")?.value.trim() || "",
      specification: qs<HTMLInputElement>("#prospectProcurementSpecification")?.value.trim() || "",
      quantity: Number(qs<HTMLInputElement>("#prospectProcurementQuantity")?.value || 0),
      quantityType: qs<HTMLSelectElement>("#prospectProcurementQuantityType")?.value || "unknown",
      targetPrice: Number(qs<HTMLInputElement>("#prospectProcurementTargetPrice")?.value || 0),
      currency: qs<HTMLSelectElement>("#prospectProcurementCurrency")?.value || "USD",
      purchaseTimeline: qs<HTMLInputElement>("#prospectProcurementTimeline")?.value.trim() || "",
      buyerRole: qs<HTMLInputElement>("#prospectProcurementBuyerRole")?.value.trim() || "",
      deliveryRequirement: qs<HTMLInputElement>("#prospectProcurementDelivery")?.value.trim() || "",
      certificationRequirement: qs<HTMLInputElement>("#prospectProcurementCertification")?.value.trim() || "",
      evidenceTypes: qsa<HTMLInputElement>("#prospectProcurementFields input[type=checkbox]:checked").map((input) => input.value),
      nextAction: qs<HTMLInputElement>("#prospectProcurementNextAction")?.value.trim() || ""
    } : undefined;
    button.disabled = true;
    try {
      const result = await api<{
        touchpoint: ProspectTouchpoint;
        todo?: Todo;
        cancelled?: Todo[];
        opportunity: WebsiteOpportunity;
        procurement?: {
          signal: ProcurementSignal;
          recommendation?: DealRecommendation;
          recommendationCreated: boolean;
        };
      }>(`/api/prospect-list/${encodeURIComponent(item.id)}/replies`, {
        method: "POST",
        body: JSON.stringify({
          channel: qs<HTMLSelectElement>("#prospectReplyChannel")?.value || "email",
          classification,
          contactValue: qs<HTMLInputElement>("#prospectReplyContact")?.value.trim() || "",
          content: qs<HTMLTextAreaElement>("#prospectReplyContent")?.value.trim() || "",
          occurredAt: occurredValue ? new Date(occurredValue).toISOString() : undefined,
          requestId: prospectRequestId("reply"),
          procurement
        })
      });
      Object.assign(item, result.opportunity);
      syncProspectTodo(result.todo);
      result.cancelled?.forEach(syncProspectTodo);
      closeModal();
      delete state.procurementContexts[item.id];
      void loadProspectProcurementContext(item, true);
      renderProspectList();
      renderTodos(state.todos);
      updateTodoChips(state.todos);
      const savedClassification = result.touchpoint.replyClassification;
      toast(
        result.procurement?.recommendationCreated
          ? "客户需求已保存，并生成可解释商机建议"
          : savedClassification === "rejected" || savedClassification === "unsubscribed"
          ? "客户回复已保存，相关跟进待办已取消"
          : savedClassification === "bounced"
            ? "退信已记录，请补充有效联系方式"
            : "客户回复已保存，下一次跟进已联动"
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : "保存回复失败", "error");
      button.disabled = false;
    }
  });
}

async function openProspectTouchpointHistory(item: WebsiteOpportunity) {
  try {
    const result = await api<{ touchpoints: ProspectTouchpoint[] }>(`/api/prospect-list/${encodeURIComponent(item.id)}/touchpoints`);
    openModal(`触达记录 · ${item.company}`, result.touchpoints.length ? `
      <div class="activity-list">
        ${result.touchpoints.map((touchpoint) => `
          <div class="activity-item">
            <b>${escapeHtml(PROSPECT_CHANNEL_LABELS[touchpoint.channel])} · ${touchpoint.direction === "inbound" ? "客户回复" : "主动触达"}</b>
            <span>${escapeHtml(formatTime(touchpoint.occurredAt))}${touchpoint.replyClassification ? ` · ${escapeHtml(PROSPECT_REPLY_LABELS[touchpoint.replyClassification])}` : ""}</span>
            <p>${escapeHtml(touchpoint.subject || touchpoint.content || "未填写摘要")}</p>
          </div>
        `).join("")}
      </div>
    ` : `<div class="empty-cell">暂无触达记录。</div>`, `<button class="btn primary" data-modal-close>关闭</button>`);
  } catch (error) {
    toast(error instanceof Error ? error.message : "读取触达记录失败", "error");
  }
}

export async function sendProspectDevelopmentEmail(button?: HTMLButtonElement) {
  const item = selectedProspect();
  if (!item) {
    toast("请先选择一条搜客线索", "error");
    return;
  }
  // 资格审核链已移除：有发件邮箱即可发送。
  if (!state.user?.outboundEmail) {
    toast("请先在个人主页绑定发件邮箱", "error");
    return;
  }
  const to = qs<HTMLInputElement>("#prospectMailTo")?.value.trim() || "";
  const subject = qs<HTMLInputElement>("#prospectMailSubject")?.value.trim() || "";
  const body = qs<HTMLTextAreaElement>("#prospectMailBody")?.value.trim() || "";
  if (!to || !subject || body.length < 10) {
    toast("请补齐收件邮箱、主题和正文", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    const result = await api<{ sent: { simulated: boolean; replayed?: boolean }; opportunity: WebsiteOpportunity; user: User; todo?: Todo }>(`/api/prospect-list/${encodeURIComponent(item.id)}/send-development-email`, {
      method: "POST",
      body: JSON.stringify({ to, subject, body, requestId: prospectRequestId("development-email") })
    });
    updateStoredUser(result.user);
    syncProspectTodo(result.todo);
    const existing = state.websiteOpportunities.find((row) => row.id === result.opportunity.id);
    if (existing) Object.assign(existing, result.opportunity);
    renderProspectList();
    renderLeadFinder(state.websiteOpportunities);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    toast(result.sent.replayed ? "开发信发送结果已确认，无重复发送" : result.sent.simulated ? "开发信已发送（测试模拟记录）" : "开发信已发送");
  } catch (error) {
    toast(error instanceof Error ? error.message : "开发信发送失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "发送开发信";
    }
  }
}

export function currentLeadFinderTitle() {
  const product = qs<HTMLInputElement>("#leadProductKeywords")?.value.trim().split(/,|，/)[0]?.trim() || "产品";
  const country = qs<HTMLInputElement>("#leadCountries")?.value.trim().split(/,|，/)[0]?.trim() || "目标市场";
  const customerType = qs<HTMLSelectElement>("#leadCustomerTypes");
  const type = customerType?.value === "*"
    ? "全部客户"
    : customerType?.value.split("/")[0]?.trim() || "客户";
  return `${country} · ${product} · ${type}`;
}

export function currentLeadFinderSubtitle() {
  const industry = qs<HTMLInputElement>("#leadIndustryInput")?.value.trim().split(/,|，/)[0]?.trim() || "行业待补充";
  const limit = qs<HTMLSelectElement>("#leadLimit")?.value || "20";
  return `${industry} · 目标 ${limit} 条 · 人工核验后入线索`;
}

export function currentLeadFinderSources() {
  return state.selectedLeadSources
    .map((id) => state.leadProviders.find((provider) => provider.id === id)?.name || id)
    .filter(Boolean);
}

const superWebProviderPriority = ["anysearch", "serper", "brave", "serpapi"];

export function superWebProviders(executableOnly = false) {
  return state.leadProviders
    .filter((provider) =>
      provider.category === "web"
      && provider.accessMode === "api"
      && provider.capabilities.includes("web")
      && (!executableOnly || isLeadSourceExecutable(provider))
    )
    .sort((left, right) => {
      const leftIndex = superWebProviderPriority.indexOf(left.id);
      const rightIndex = superWebProviderPriority.indexOf(right.id);
      return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
    });
}

export function selectedSuperWebProviderIds() {
  const webIds = new Set(superWebProviders().map((provider) => provider.id));
  return state.selectedLeadSources.filter((providerId) => webIds.has(providerId));
}

export function superMapProviders(executableOnly = false) {
  return state.leadProviders.filter((provider) =>
    provider.accessMode === "api"
    && provider.capabilities.includes("maps")
    && (!executableOnly || isLeadSourceExecutable(provider))
  );
}

export function selectedSuperMapProviderIds() {
  const mapIds = new Set(superMapProviders().map((provider) => provider.id));
  return state.selectedLeadSources.filter((providerId) => mapIds.has(providerId));
}

function superAiDiscoveryProvider() {
  return state.leadProviders.find((provider) =>
    provider.id === "ai_search"
    && provider.accessMode === "api"
    && provider.capabilities.includes("ai")
  );
}

export function selectedSuperAiDiscoveryProviderIds() {
  const provider = superAiDiscoveryProvider();
  return provider && state.selectedLeadSources.includes(provider.id) ? [provider.id] : [];
}

export function superWebSearchMode(): "off" | "api" {
  return leadFinderMode === "super" && Boolean(qs<HTMLInputElement>("#leadSuperWebSearch")?.checked)
    ? "api"
    : "off";
}

export function superMapSearchMode(): "off" | "google_places" {
  return leadFinderMode === "super" && Boolean(qs<HTMLInputElement>("#leadSuperMapSearch")?.checked)
    ? "google_places"
    : "off";
}

export function superAiDiscoveryMode(): "off" | "model" {
  return leadFinderMode === "super" && Boolean(qs<HTMLInputElement>("#leadSuperAiDiscovery")?.checked)
    ? "model"
    : "off";
}

export function renderSuperWebSearchOption() {
  const checkbox = qs<HTMLInputElement>("#leadSuperWebSearch");
  const status = qs<HTMLElement>("#leadSuperWebStatus");
  if (!checkbox || !status) return;
  const selectedNames = selectedSuperWebProviderIds().map((providerId) =>
    state.leadProviders.find((provider) => provider.id === providerId)?.name || providerId
  );
  status.textContent = checkbox.checked
    ? selectedNames.length ? selectedNames.join("、") : "等待配置可用来源"
    : "未启用";
}

export function renderSuperMapSearchOption() {
  const checkbox = qs<HTMLInputElement>("#leadSuperMapSearch");
  const status = qs<HTMLElement>("#leadSuperMapStatus");
  if (!checkbox || !status) return;
  const selectedNames = selectedSuperMapProviderIds().map((providerId) =>
    state.leadProviders.find((provider) => provider.id === providerId)?.name || providerId
  );
  status.textContent = checkbox.checked
    ? selectedNames.length ? selectedNames.join("、") : "等待配置可用来源"
    : "未启用";
}

export function renderSuperAiDiscoveryOption() {
  const checkbox = qs<HTMLInputElement>("#leadSuperAiDiscovery");
  const status = qs<HTMLElement>("#leadSuperAiStatus");
  if (!checkbox || !status) return;
  const provider = superAiDiscoveryProvider();
  status.textContent = checkbox.checked
    ? provider && isLeadSourceExecutable(provider) ? provider.name : "等待配置可用模型"
    : "未启用";
}

export async function toggleSuperWebSearch(enabled: boolean) {
  const checkbox = qs<HTMLInputElement>("#leadSuperWebSearch");
  if (!checkbox) return;
  if (!enabled) {
    const webIds = new Set(superWebProviders().map((provider) => provider.id));
    state.selectedLeadSources = state.selectedLeadSources.filter((providerId) => !webIds.has(providerId));
    state.leadSourceSelectionTouched = true;
    renderLeadSourceChips();
    renderSuperWebSearchOption();
    renderSuperSearchPreview();
    return;
  }
  await loadLeadProviders();
  const selectedExecutable = selectedSuperWebProviderIds().filter((providerId) =>
    superWebProviders(true).some((provider) => provider.id === providerId)
  );
  if (!selectedExecutable.length) {
    const provider = superWebProviders(true)[0];
    if (provider) {
      state.selectedLeadSources = [...new Set([...state.selectedLeadSources, provider.id])];
      state.leadSourceSelectionTouched = true;
    } else {
      checkbox.checked = false;
      renderSuperWebSearchOption();
      openLeadSourceCenter(superWebProviders()[0]?.id);
      toast("请先配置并启用一个 Web Search API", "error");
      return;
    }
  }
  renderLeadSourceChips();
  renderSuperWebSearchOption();
  renderSuperSearchPreview();
}

export async function toggleSuperMapSearch(enabled: boolean) {
  const checkbox = qs<HTMLInputElement>("#leadSuperMapSearch");
  if (!checkbox) return;
  if (!enabled) {
    const mapIds = new Set(superMapProviders().map((provider) => provider.id));
    state.selectedLeadSources = state.selectedLeadSources.filter((providerId) => !mapIds.has(providerId));
    state.leadSourceSelectionTouched = true;
    renderLeadSourceChips();
    renderSuperMapSearchOption();
    renderSuperSearchPreview();
    return;
  }
  await loadLeadProviders();
  const provider = superMapProviders(true).find((item) => item.id === "google_places");
  if (!provider) {
    checkbox.checked = false;
    renderSuperMapSearchOption();
    openLeadSourceCenter("google_places");
    toast("请先配置并启用 Google Places API", "error");
    return;
  }
  state.selectedLeadSources = [...new Set([...state.selectedLeadSources, provider.id])];
  state.leadSourceSelectionTouched = true;
  renderLeadSourceChips();
  renderSuperMapSearchOption();
  renderSuperSearchPreview();
}

export async function toggleSuperAiDiscovery(enabled: boolean) {
  const checkbox = qs<HTMLInputElement>("#leadSuperAiDiscovery");
  if (!checkbox) return;
  if (!enabled) {
    state.selectedLeadSources = state.selectedLeadSources.filter((providerId) => providerId !== "ai_search");
    state.leadSourceSelectionTouched = true;
    renderLeadSourceChips();
    renderSuperAiDiscoveryOption();
    renderSuperSearchPreview();
    return;
  }
  await loadLeadProviders();
  const provider = superAiDiscoveryProvider();
  if (!isLeadSourceExecutable(provider)) {
    checkbox.checked = false;
    renderSuperAiDiscoveryOption();
    activateNavView("ai-config", () => {
      qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
      toast("启用模型并勾选自动获客后，即可使用 AI 深度发现", "error");
    });
    return;
  }
  state.selectedLeadSources = [...new Set([...state.selectedLeadSources, "ai_search"])];
  state.leadSourceSelectionTouched = true;
  renderLeadSourceChips();
  renderSuperAiDiscoveryOption();
  renderSuperSearchPreview();
}

export function renderSuperSearchPreview() {
  const box = qs<HTMLElement>("#leadSuperPlan");
  if (!box) return;
  if (leadFinderMode !== "super") return;
  const products = leadFinderValues("#leadProductKeywords");
  const markets = leadFinderValues("#leadCountries");
  const customerTypes = leadFinderValues("#leadCustomerTypes");
  const industries = leadFinderValues("#leadIndustryInput");
  renderSuperWebSearchOption();
  const webSearchMode = superWebSearchMode();
  renderSuperMapSearchOption();
  const mapSearchMode = superMapSearchMode();
  renderSuperAiDiscoveryOption();
  const aiDiscoveryMode = superAiDiscoveryMode();
  const providerIds = state.selectedLeadSources.filter((id) => state.leadProviders.some((provider) =>
    provider.id === id
    && provider.accessMode === "api"
    && (webSearchMode === "api" || provider.category !== "web")
    && (mapSearchMode === "google_places" || !provider.capabilities.includes("maps"))
    && (aiDiscoveryMode === "model" || provider.id !== "ai_search")
  ));
  if (!products.length || !markets.length || !customerTypes.length || !providerIds.length) {
    box.innerHTML = `<span>填写产品、市场、客户类型并选择数据源后生成搜索计划</span>`;
    return;
  }
  window.clearTimeout(leadSuperPreviewTimer);
  leadSuperPreviewTimer = window.setTimeout(async () => {
    try {
      const result = await api<{ preview: { maxRounds: number; maximumCells: number; cellsPerRound: number; coverageCombinations: number; providerCount: number; webProviderCount: number; mapProviderCount: number; aiDiscoveryProviderCount: number; targetCandidateCount: number; maxDurationMinutes: number } }>("/api/prospect-super-search/preview", {
        method: "POST",
        body: JSON.stringify({
          products, markets, customerTypes, industries, providerIds, webSearchMode, mapSearchMode, aiDiscoveryMode,
          depth: qs<HTMLSelectElement>("#leadSuperDepth")?.value || "deep",
          targetCandidateCount: Number(qs<HTMLInputElement>("#leadSuperTarget")?.value || 300),
          maxDurationMinutes: Number(qs<HTMLSelectElement>("#leadSuperDuration")?.value || 480),
          costLimit: Number(qs<HTMLInputElement>("#leadSuperCost")?.value || 0),
          currency: Number(qs<HTMLInputElement>("#leadSuperCost")?.value || 0) > 0 ? "USD" : ""
        })
      });
      const plan = result.preview;
      box.innerHTML = `<span><b>${plan.coverageCombinations}</b> 个覆盖组合</span><span><b>${plan.maximumCells}</b> 个来源执行单元</span>${plan.webProviderCount ? `<span><b>${plan.webProviderCount}</b> 个实时 Web API</span>` : ""}${plan.mapProviderCount ? `<span><b>${plan.mapProviderCount}</b> 个地图来源</span>` : ""}${plan.aiDiscoveryProviderCount ? `<span><b>${plan.aiDiscoveryProviderCount}</b> 个 AI 发现来源</span>` : ""}<span><b>${plan.maxRounds}</b> 轮</span><span>目标 <b>${plan.targetCandidateCount}</b> 条</span>`;
    } catch {
      box.innerHTML = `<span>搜索计划暂不可用，请检查条件和数据源</span>`;
    }
  }, 280);
}

export function setLeadFinderMode(mode: "standard" | "super") {
  leadFinderMode = mode;
  qsa<HTMLButtonElement>("[data-lead-search-mode]").forEach((button) => button.classList.toggle("active", button.dataset.leadSearchMode === mode));
  const config = qs<HTMLElement>("#leadSuperSearchConfig");
  if (config) config.hidden = mode !== "super";
  const webSearch = qs<HTMLInputElement>("#leadSuperWebSearch");
  if (mode === "super" && webSearch) {
    webSearch.checked = selectedSuperWebProviderIds().length > 0;
  }
  const mapSearch = qs<HTMLInputElement>("#leadSuperMapSearch");
  if (mode === "super" && mapSearch) {
    mapSearch.checked = selectedSuperMapProviderIds().length > 0;
  }
  const aiDiscovery = qs<HTMLInputElement>("#leadSuperAiDiscovery");
  if (mode === "super" && aiDiscovery) {
    aiDiscovery.checked = selectedSuperAiDiscoveryProviderIds().length > 0;
  }
  const schedule = qs<HTMLInputElement>("#leadFinderScheduleInput");
  const scheduleLine = schedule?.closest<HTMLElement>(".lead-schedule-toggle");
  if (schedule) {
    schedule.disabled = mode === "super";
    if (mode === "super") schedule.checked = false;
  }
  scheduleLine?.classList.toggle("is-disabled", mode === "super");
  // 目标搜索（超级搜索）下隐藏简报方式与表单搜索
  applyBriefMode();
  const title = qs<HTMLButtonElement>("#leadFinderStartButton");
  const inline = qs<HTMLButtonElement>("#leadFinderStartButtonInline");
  [title, inline].forEach((button) => {
    if (button) button.textContent = mode === "super" ? "启动超级搜索" : "开始搜客";
  });
  renderSuperWebSearchOption();
  renderSuperMapSearchOption();
  renderSuperAiDiscoveryOption();
  renderSuperSearchPreview();
  syncLeadFinderStartState();
}

const OFFICIAL_WEBSITE_SEARCH_PROVIDER_IDS = new Set(["anysearch", "brave", "serper", "serpapi", "google_places"]);

export function leadFinderAiReadiness() {
  const config = state.aiConfig;
  if (!config?.enabled || !config.hasApiKey || !config.useLeadFinder) {
    return {
      ready: false,
      message: "请先在「AI 配置」中保存 API Key、启用模型并勾选搜客"
    };
  }
  if (config.webSearchStatus === "passed") {
    return {
      ready: true,
      message: "OpenAI Web Search 已验证，官网将从联网引用中确认"
    };
  }
  const externalSearchReady = state.leadProviders.some((provider) =>
    OFFICIAL_WEBSITE_SEARCH_PROVIDER_IDS.has(provider.id)
    && provider.ready
    && provider.enabled
  );
  if (config.webSearchStatus === "unsupported" && config.lastTestStatus === "passed") {
    return externalSearchReady
      ? {
          ready: true,
          message: "普通 AI 负责生成候选，官网由已配置的搜索 API 补查"
        }
      : {
          ready: false,
          message: "当前模型可以生成企业候选，但不能联网确认官网。请在数据源中心配置 Brave、Serper、SerpApi 或 Google Places"
        };
  }
  if (config.webSearchStatus === "failed") {
    return {
      ready: false,
      message: "普通 AI 调用可用，但 Web Search 测试失败。请检查 Base URL、模型权限后重新测试，或更换 OpenAI 配置"
    };
  }
  return {
    ready: false,
    message: "请先在「AI 配置」中点击测试连接；普通 AI 调用成功不代表可以联网确认官网"
  };
}

// 搜客按钮始终可点击：未配置 AI 模型且未贴链接时，点击后由 runLeadFinder 提示先配置 AI 模型
export function syncLeadFinderStartState() {
  const aiReady = leadFinderAiReadiness().ready;
  const hasExecutableApiSource = state.leadProviders.some((provider) =>
    provider.id !== "ai_search"
    && isLeadSourceExecutable(provider)
  );
  const urlInput = qs<HTMLTextAreaElement>("#leadFinderUrlInput");
  const urlCount = (urlInput?.value || "").split(/\n|,|，/).map((item) => item.trim()).filter(Boolean).length;
  const needsSource = !aiReady && !hasExecutableApiSource && urlCount === 0;
  ["#leadFinderStartButton", "#leadFinderStartButtonInline", "[data-lead-empty-start]"].forEach((sel) => {
    const button = qs<HTMLButtonElement>(sel);
    if (!button) return;
    button.disabled = false;
    button.title = needsSource ? "自动搜客需要至少一个可执行来源：可配置搜索 API，或启用 AI 搜索" : "";
    button.classList.remove("is-blocked");
  });
  const hint = qs<HTMLElement>("#leadFinderAiRequiredHint");
  if (hint) hint.hidden = !needsSource;
}

// 自然语言 / 结构化表单 互斥：仅生效的那一组参与搜索
export function applyBriefMode() {
  const bp = qs<HTMLElement>(".lead-brief-prompt");
  const fg = qs<HTMLElement>(".lead-form-grid");
  const bm = qs<HTMLElement>(".lead-brief-mode");
  // 超级搜索同样需要搜索条件（目标/产品/市场），因此保留简报与表单，
  // 仅把超级搜索专有的运行配置（目标候选数、时长、深度、费用、来源）叠加在其下方展示
  if (bp) bp.hidden = false;
  if (fg) fg.hidden = false;
  if (bm) bm.hidden = false;
  const nl = leadBriefMode === "nl";
  document.querySelectorAll<HTMLElement>("[data-brief='nl']").forEach((el) => { el.hidden = !nl; });
  // AI 解析预览面板仅在 NL 模式下、且已解析后由解析逻辑显示；切换模式时此处负责收起
  const leadAiPreview = qs<HTMLElement>("#leadAiPreview");
  if (leadAiPreview && !nl) leadAiPreview.hidden = true;
  document.querySelectorAll<HTMLElement>("[data-brief='form']").forEach((el) => { el.hidden = nl; });
  const links = qs<HTMLElement>("#leadFinderSearchLinks");
  if (links) links.hidden = nl; // 人工检索链接由表单派生，自然语言模式下无意义
  qsa<HTMLButtonElement>("[data-lead-brief-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.leadBriefMode === leadBriefMode);
  });
}

export function fillLeadAiPreview(data: LeadAiParsed) {
  const preview = qs<HTMLElement>("#leadAiPreview");
  if (preview) preview.hidden = false;
  const set = (sel: string, value: string) => {
    const el = qs<HTMLInputElement>(sel);
    if (el) el.value = value;
  };
  set("#leadAiName", data.name || "");
  set("#leadAiMarkets", data.markets.join(", "));
  set("#leadAiProducts", data.products.join(", "));
  set("#leadAiIndustries", data.industries.join(", "));
  set("#leadAiExclusions", data.exclusions.join(", "));
  const ct = qs<HTMLSelectElement>("#leadAiCustomerType");
  if (ct) ct.value = data.customerType || "*";
}

const LEAD_COUNTRY_OPTIONS = [
  "Global", "United States", "China", "Germany", "United Kingdom", "France", "Japan", "South Korea",
  "India", "Canada", "Mexico", "Brazil", "Turkey", "Italy", "Spain", "Netherlands", "Poland", "Australia",
  "Singapore", "Thailand", "Vietnam", "Malaysia", "Indonesia", "Philippines", "Russia", "UAE", "Saudi Arabia",
  "South Africa", "Chile", "Argentina", "Colombia", "Egypt", "Nigeria", "Sweden", "Switzerland", "Belgium",
  "Austria", "Denmark", "Norway", "Finland", "Portugal", "Ireland", "New Zealand", "Israel", "Qatar",
  "Bangladesh", "Pakistan", "Kazakhstan", "Ukraine", "Southeast Asia", "Europe", "Middle East", "South America",
  "North America"
];

// 给 AI 解析结果提供可编辑的标准英文市场候选。
export function populateLeadCountryDatalist() {
  const list = qs<HTMLDataListElement>("#leadCountryList");
  if (!list) return;
  list.innerHTML = LEAD_COUNTRY_OPTIONS.map((country) => `<option value="${escapeHtml(country)}"></option>`).join("");
}

export function buildLeadFinderJobDetails(resultIds: string[] = []) {
  const product = qs<HTMLInputElement>("#leadProductKeywords")?.value.trim() || "未填写产品";
  const countries = qs<HTMLInputElement>("#leadCountries")?.value.trim() || "未填写市场";
  const industry = qs<HTMLInputElement>("#leadIndustryInput")?.value.trim() || "未填写行业";
  const customerTypeValue = qs<HTMLSelectElement>("#leadCustomerTypes")?.value || "*";
  const customerType = customerTypeValue === "*" ? "全部客户类型" : customerTypeValue;
  const sourceText = currentLeadFinderSources().join("、") || "默认公开源";
  const lines = [
    `产品：${product}`,
    `市场：${countries}`,
    `行业：${industry}`,
    `客户类型：${customerType}`,
    `渠道：${sourceText}`
  ];
  if (resultIds.length) lines.unshift(`本次已搜到 ${resultIds.length} 条候选，展开可查看公司、国家和官网。`);
  return lines;
}

export function leadFinderJobStatusText(job: LeadFinderJob) {
  if (["done", "partial", "failed", "cancelled"].includes(job.status)) return "已结束";
  if (job.status === "paused") return "已暂停";
  if (job.status === "needs_input" || job.status === "ready") return "等待中";
  return "执行中";
}

export function leadFinderJobStatusTone(job: LeadFinderJob) {
  if (["done", "partial", "failed", "cancelled"].includes(job.status)) return "";
  if (job.status === "paused") return "amber";
  if (job.status === "needs_input") return "amber";
  if (job.status === "running") return "blue";
  return "";
}

export function isLeadFinderJobTerminal(job: LeadFinderJob) {
  return ["done", "partial", "failed", "cancelled"].includes(job.status);
}

export function primaryLeadFinderLiveJob() {
  const active = leadFinderJobs.find((job) => ["running", "paused", "needs_input", "ready"].includes(job.status));
  return active || leadFinderJobs[0] || null;
}

export function currentLeadFinderResultJob() {
  return leadFinderJobs[0] || null;
}

export function currentLeadFinderResults(opportunities = state.websiteOpportunities) {
  const ids = new Set(currentLeadFinderResultJob()?.resultIds || []);
  // CLI 获客不经过搜客任务流水线（没有任务的 resultIds 可挂），结果由后端直接同步进候选池；
  // 若只按任务 resultIds 过滤，这些候选在「可加入搜客清单的候选」里永远不可见
  // （2026-10-07 用户反馈：新增候选在候选与搜客清单都看不到）。这里把本机 CLI 获客的
  // 候选并入候选列表，业务员照常勾选后「加入搜客清单」即可进入搜客清单页。
  return opportunities.filter((item) => ids.has(item.id) || item.source === "cli_acquisition");
}

export function leadFinderLiveStage(job: LeadFinderJob) {
  const phases = job.processPhases || [];
  const current = phases.find((phase) => phase.status === "running")
    || phases.find((phase) => ["failed", "blocked", "partial"].includes(phase.status))
    || [...phases].reverse().find((phase) => phase.status === "succeeded");
  if (current) return { name: current.name, result: current.result };
  if (job.superSearchRound) return {
    name: `超级搜索第 ${job.superSearchRound}/${job.superSearchMaxRounds || job.superSearchRound} 轮`,
    result: job.progressValue || "等待当前轮次回传"
  };
  return {
    name: ["done", "partial", "failed", "cancelled"].includes(job.status) ? "任务已结束" : "正在建立搜索任务",
    result: job.progressValue || job.subtitle
  };
}

export function leadFinderLiveElapsed(job: LeadFinderJob) {
  if (["done", "partial", "failed", "cancelled"].includes(job.status)) return job.elapsedText;
  const startedAt = new Date(job.createdAt).getTime();
  if (!Number.isFinite(startedAt)) return job.elapsedText;
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours ? `${hours} 小时 ` : ""}${minutes} 分钟`;
}

function leadFinderWaitElapsed(value?: string) {
  const startedAt = new Date(value || "").getTime();
  if (!Number.isFinite(startedAt)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export function leadFinderSourceWaitText(source: LeadFinderSourceStat, job: LeadFinderJob) {
  const status = source.status || "queued";
  const candidateCount = Math.max(source.candidateCount || 0, job.resultIds?.length || 0);
  const waitStartedAt = source.updatedAt || source.createdAt || job.createdAt;
  const waited = leadFinderWaitElapsed(waitStartedAt);
  const waitedMs = Date.now() - new Date(waitStartedAt || "").getTime();
  const waitSuffix = waited ? ` · 已等待 ${waited}` : "";
  if (["queued", "running", "retry_scheduled", "pause_requested"].includes(status)
    && Number.isFinite(waitedMs)
    && waitedMs >= 130_000) {
    return source.id === "ai_search"
      ? `响应超时：AI 模型超过 2 分钟没有新返回，后台应结束本次调用。调整建议：检查 API Key、额度、Base URL 与模型联网能力，并减少单次结果数量${waitSuffix}`
      : `响应超时：数据源超过 2 分钟没有新返回，后台应结束本次调用。调整建议：检查数据源连接、限流状态，或减少同时启用的来源${waitSuffix}`;
  }
  if (status === "retry_scheduled") {
    return source.id === "ai_search"
      ? `模型服务限流或临时失败，等待自动重试${waitSuffix}`
      : `来源暂时不可用，等待自动重试${waitSuffix}`;
  }
  if (["queued", "pause_requested"].includes(status)) {
    return source.id === "ai_search"
      ? "AI 搜索正在等待空闲执行通道"
      : "正在等待空闲执行通道";
  }
  if (status === "running") {
    if (source.id === "ai_search") {
      return candidateCount
        ? `已有 ${candidateCount} 个候选先展示，AI 模型仍在补充${waitSuffix}`
        : `AI 模型正在生成候选${waitSuffix}`;
    }
    return candidateCount
      ? `已有 ${candidateCount} 个候选先展示，仍在等待该来源补充${waitSuffix}`
      : `正在等待来源返回${waitSuffix}`;
  }
  if (status === "failed") return source.error || "来源执行失败，可在失败报文中查看原因";
  return "";
}

export function leadFinderWaitState(job: LeadFinderJob) {
  if (isLeadFinderJobTerminal(job) || job.status === "paused") return null;
  const planningEvent = [...(job.liveEvents || [])].reverse().find((event) =>
    ["mission.ai_planning_started", "mission.ai_planning_completed", "mission.ai_planning_fallback"].includes(event.type)
  );
  if (planningEvent?.type === "mission.ai_planning_started") {
    const waited = leadFinderWaitElapsed(planningEvent.occurredAt);
    return {
      tone: "is-ai",
      title: job.resultIds?.length ? `已先展示 ${job.resultIds.length} 个候选，AI 正在规划下一轮` : "AI 正在规划下一轮搜索",
      detail: `${waited ? `AI 规划已等待 ${waited}；` : ""}其他来源结果和已入池客户会继续实时展示`
    };
  }
  const activeSources = (job.sourceStats || []).filter((source) =>
    ["queued", "running", "retry_scheduled", "pause_requested"].includes(source.status || "queued")
  );
  const aiSource = activeSources.find((source) => source.id === "ai_search");
  const source = aiSource || activeSources.find((item) => item.status === "retry_scheduled") || activeSources[0];
  if (!source) {
    return {
      tone: "is-queued",
      title: "正在分配搜索执行通道",
      detail: "任务不会阻塞页面，来源结果会在保存后立即出现"
    };
  }
  const detail = leadFinderSourceWaitText(source, job);
  return {
    tone: source.status === "retry_scheduled" ? "is-retry" : source.id === "ai_search" ? "is-ai" : "is-source",
    title: source.id === "ai_search"
      ? source.status === "queued" ? "AI 搜索正在排队" : source.status === "retry_scheduled" ? "AI 搜索准备重试" : "AI 模型响应中"
      : source.status === "retry_scheduled" ? `${source.name} 准备重试` : `等待 ${source.name} 返回`,
    detail
  };
}

export function leadFinderLiveTransportLabel(job: LeadFinderJob) {
  const live = leadFinderStreamConnected && leadFinderStreamRunId === job.backendRunId;
  if (live) return { text: "事实事件实时连接", tone: "is-live" };
  if (["done", "partial", "failed", "cancelled"].includes(job.status)) return { text: "任务记录已归档", tone: "" };
  if (!job.backendRunId) return { text: "本地解析自动更新", tone: "is-live" };
  return { text: "实时连接中断，5 秒自动刷新", tone: "is-fallback" };
}

function prospectRadarTone(value: string): ProspectRadarFrameTone {
  if (value.includes("failed")) return "failed";
  if (value.includes("gain")) return "gain";
  if (value.includes("review")) return "review";
  return "live";
}

function prospectRadarFrameKind(log: LeadTaskStreamLog): ProspectRadarFrame["kind"] {
  const text = `${log.source} ${log.title} ${log.detail}`;
  if (/关系/u.test(text)) return "relation";
  if (/证据|深挖/u.test(text)) return "evidence";
  if (/验证|官网/u.test(text)) return "verification";
  if (/候选|入池/u.test(text)) return "candidate";
  return "source";
}

function buildProspectRadarModel(job: LeadFinderJob): ProspectRadarModel {
  const opportunities = (job.resultIds || [])
    .map((id) => state.websiteOpportunities.find((item) => item.id === id))
    .filter((item): item is WebsiteOpportunity => Boolean(item));
  const opportunityById = new Map(opportunities.map((item) => [item.id, item]));
  const candidates: ProspectRadarCandidate[] = [];
  const candidateRadarIdByCandidateId = new Map<string, string>();

  (job.deepMining?.nodes || []).forEach((node) => {
    const opportunity = opportunityById.get(node.candidateId);
    const score = node.enterpriseVerificationScore || opportunity?.scorecard?.enterpriseConfidence.score || 0;
    candidates.push({
      id: node.id,
      candidateId: node.candidateId,
      company: node.company || opportunity?.company || "企业名称待确认",
      country: node.country || opportunity?.country || "",
      website: node.website || opportunity?.website || "",
      createdAt: node.createdAt || opportunity?.createdAt || job.createdAt,
      kind: node.depth > 0 ? "related" : "candidate",
      verificationScore: Math.max(0, Math.min(100, Math.round(score)))
    });
    candidateRadarIdByCandidateId.set(node.candidateId, node.id);
  });

  opportunities.forEach((item) => {
    if (candidateRadarIdByCandidateId.has(item.id)) return;
    const radarId = `candidate:${item.id}`;
    candidates.push({
      id: radarId,
      candidateId: item.id,
      company: item.company || websiteDomain(item.website || "") || "企业名称待确认",
      country: item.country || "",
      website: item.website || "",
      createdAt: item.createdAt || job.createdAt,
      kind: "candidate",
      verificationScore: Math.max(0, Math.min(100, Math.round(item.scorecard?.enterpriseConfidence.score || item.confidence || 0)))
    });
    candidateRadarIdByCandidateId.set(item.id, radarId);
  });

  const relations: ProspectRadarRelation[] = (job.deepMining?.edges || []).map((edge) => ({
    id: edge.id,
    fromId: edge.fromNodeId,
    toId: edge.toNodeId,
    relationType: edge.relationType || "企业关系",
    confidence: Math.max(0, Math.min(100, edge.confidence <= 1 ? Math.round(edge.confidence * 100) : Math.round(edge.confidence))),
    verified: edge.verified,
    createdAt: edge.createdAt || job.createdAt
  }));
  const candidateById = new Map(candidates.map((item) => [item.id, item]));
  const frames: ProspectRadarFrame[] = leadTaskDetailLogs(job).map((log) => ({
    id: `log:${log.key}`,
    at: log.at || job.createdAt,
    kind: prospectRadarFrameKind(log),
    tone: prospectRadarTone(log.tone),
    source: log.source,
    title: log.title,
    detail: log.detail,
    result: log.result
  }));

  candidates.forEach((candidate) => {
    frames.push({
      id: `discovery:${candidate.id}`,
      at: candidate.createdAt || job.createdAt,
      kind: "candidate",
      tone: "gain",
      source: candidate.kind === "related" ? "深挖关系图" : "候选池",
      title: candidate.kind === "related" ? "发现关联企业" : "新候选已进入搜索视野",
      detail: [candidate.company, candidate.country, candidate.website].filter(Boolean).join(" / "),
      result: candidate.verificationScore ? `企业验证 ${candidate.verificationScore} 分` : "等待验证",
      country: candidate.country,
      candidateId: candidate.id
    });
  });

  (job.deepMining?.evidence || []).forEach((evidence) => {
    const candidate = candidateById.get(evidence.nodeId);
    frames.push({
      id: `evidence:${evidence.id}`,
      at: evidence.observedAt || job.createdAt,
      kind: "evidence",
      tone: evidence.authority === "official" || evidence.authority === "corroborated" ? "gain" : "review",
      source: evidence.providerId || "证据搜索",
      title: evidence.authority === "official" ? "发现官方来源证据" : "发现可核验来源",
      detail: evidence.summary || evidence.sourceUrl || "来源已写入证据图谱",
      result: evidence.authority === "official" ? "官方来源" : evidence.authority === "corroborated" ? "交叉印证" : "待验证",
      country: candidate?.country,
      candidateId: evidence.nodeId
    });
  });

  relations.forEach((relation) => {
    const target = candidateById.get(relation.toId);
    frames.push({
      id: `relation:${relation.id}`,
      at: relation.createdAt || job.createdAt,
      kind: "relation",
      tone: relation.verified ? "gain" : "review",
      source: "关系验证",
      title: relation.relationType || "发现企业关系",
      detail: relation.verified ? "关系已有来源证据支持" : "关系已记录，等待更多来源交叉验证",
      result: `${relation.confidence} 分置信度`,
      country: target?.country,
      relationId: relation.id
    });
  });

  opportunities.forEach((item) => {
    if (!item.verificationReport && !item.verifiedAt) return;
    const radarId = candidateRadarIdByCandidateId.get(item.id);
    frames.push({
      id: `verification:${item.id}:${item.verifiedAt || item.verificationReport?.generatedAt || item.createdAt}`,
      at: item.verifiedAt || item.verificationReport?.generatedAt || item.createdAt || job.createdAt,
      kind: "verification",
      tone: item.verificationReport?.level === "L0" ? "review" : "gain",
      source: "官网验证",
      title: `${item.company || "候选企业"}：验证已更新`,
      detail: item.verificationReport?.conclusion || "验证结果已写入候选档案",
      result: item.verificationReport?.levelLabel || item.verificationReport?.level || "已验证",
      country: item.country,
      candidateId: radarId
    });
  });

  if (isLeadFinderJobTerminal(job)) {
    const lastAt = [
      job.deepMining?.endedAt,
      ...frames.map((item) => item.at)
    ].filter(Boolean).sort().at(-1) || job.createdAt;
    frames.push({
      id: `complete:${job.id}:${job.status}`,
      at: lastAt,
      kind: "complete",
      tone: job.status === "failed" ? "failed" : "complete",
      source: "任务报告",
      title: "任务已结束",
      detail: `候选 ${opportunities.length || job.resultCount || 0} 家，证据 ${job.deepMining?.summary.evidenceCount || 0} 条，关系 ${job.deepMining?.summary.relationCount || 0} 条`,
      result: job.status === "failed" ? "查看详细失败项" : "结果已归档"
    });
  }

  const frameOrder: Record<ProspectRadarFrame["kind"], number> = {
    source: 0,
    candidate: 1,
    evidence: 2,
    relation: 3,
    verification: 4,
    complete: 5
  };
  frames.sort((left, right) => {
    const byTime = new Date(left.at).getTime() - new Date(right.at).getTime();
    return (Number.isFinite(byTime) && byTime !== 0 ? byTime : 0)
      || frameOrder[left.kind] - frameOrder[right.kind]
      || left.id.localeCompare(right.id);
  });
  if (!frames.length) {
    frames.push({
      id: `ready:${job.id}`,
      at: job.createdAt,
      kind: "source",
      tone: "live",
      source: "任务调度",
      title: "搜索任务已建立",
      detail: "等待真实来源事件回传",
      result: "等待中"
    });
  }

  const focusCountries = new Set(candidates.map((item) => item.country).filter(Boolean));
  (job.detailLines || []).forEach((line) => {
    const match = line.match(/^(?:市场|本轮市场)：(.+)$/u);
    if (!match) return;
    match[1].split(/[、,，/]/u).map((item) => item.trim()).filter((item) => item && item !== "全球").forEach((item) => focusCountries.add(item));
  });
  return {
    title: job.title,
    live: !isLeadFinderJobTerminal(job),
    frames,
    candidates,
    relations,
    focusCountries: [...focusCountries]
  };
}

function renderProspectRadarMetrics(job: LeadFinderJob, model: ProspectRadarModel) {
  const pipeline = job.cleaningReport?.summary;
  const values: Record<string, string> = {
    prospectRadarSourceCount: String(job.sourceStats?.length || job.channelCount || 0),
    prospectRadarCandidateCount: String(model.candidates.filter((item) => item.kind === "candidate").length || job.resultCount || 0),
    prospectRadarEvidenceCount: String(job.deepMining?.summary.evidenceCount || 0),
    prospectRadarReadyCount: String(job.deepMining?.summary.researchReadyCount || 0),
    prospectRadarRemovedCount: String(pipeline
      ? pipeline.providerInvalidCount + pipeline.providerDuplicateCount + pipeline.rejectedCount + pipeline.suppressedCount + pipeline.mergedCount
      : job.incrementalStats?.deduplicatedCount || 0)
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = qs<HTMLElement>(`#${id}`);
    if (element) element.textContent = value;
  });
}

export function buildProspectPoolRadarModel(): ProspectRadarModel {
  const opportunities = [...state.websiteOpportunities]
    .filter((item) => item.createdAt)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const candidates: ProspectRadarCandidate[] = opportunities.map((item) => ({
    id: `candidate:${item.id}`,
    candidateId: item.id,
    company: item.company || websiteDomain(item.website || "") || "企业名称待确认",
    country: item.country || "",
    website: item.website || "",
    createdAt: item.createdAt,
    kind: "candidate",
    verificationScore: leadFinderScore(item)
  }));
  const frames: ProspectRadarFrame[] = [];
  opportunities.forEach((item) => {
    const candidateId = `candidate:${item.id}`;
    frames.push({
      id: `pool:${item.id}`,
      at: item.createdAt,
      kind: "candidate",
      tone: "gain",
      source: item.sourceLabel || item.source || "候选池",
      title: "候选企业加入记录",
      detail: [item.company, item.country, item.business, item.website].filter(Boolean).join(" / "),
      result: `搜索验证 ${leadFinderScore(item)} 分`,
      country: item.country,
      candidateId
    });
    (item.sourceEvidence || []).forEach((evidence, index) => {
      frames.push({
        id: `pool-evidence:${item.id}:${evidence.payloadHash || index}`,
        at: evidence.fetchedAt || item.createdAt,
        kind: "evidence",
        tone: evidence.sourceLevel === "official" ? "gain" : "review",
        source: evidence.providerId || item.sourceLabel || "来源证据",
        title: evidence.sourceLevel === "official" ? "官方来源已归档" : "来源记录已归档",
        detail: evidence.evidenceSummary || evidence.sourceUrl || "来源记录已写入候选档案",
        result: evidence.sourceLevel || "可核验来源",
        country: item.country,
        candidateId
      });
    });
    if (item.verificationReport || item.verifiedAt) {
      frames.push({
        id: `pool-verification:${item.id}:${item.verifiedAt || item.verificationReport?.generatedAt || item.createdAt}`,
        at: item.verifiedAt || item.verificationReport?.generatedAt || item.createdAt,
        kind: "verification",
        tone: item.verificationReport?.level === "L0" ? "review" : "gain",
        source: "搜索验证",
        title: `${item.company || "候选企业"}：验证已更新`,
        detail: item.verificationReport?.conclusion || "验证结果已写入候选档案",
        result: item.verificationReport?.levelLabel || item.verificationReport?.level || "已验证",
        country: item.country,
        candidateId
      });
    }
  });
  frames.sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  // 空候选池也保留一个真实的“待命”帧，让雷达入口始终可用；不生成虚假的企业点位。
  if (!frames.length) {
    frames.push({
      id: "pool:ready",
      at: new Date().toISOString(),
      kind: "source",
      tone: "live",
      source: "全球雷达",
      title: "全球雷达已就绪",
      detail: "候选池暂时为空，新的搜索结果会在任务完成后按真实事件显示",
      result: "等待首个候选"
    });
  }
  return {
    title: "当前候选池探索图",
    live: false,
    frames,
    candidates,
    relations: [],
    focusCountries: [...new Set(candidates.map((item) => item.country).filter(Boolean))]
  };
}

export function renderProspectPoolRadarMetrics(model: ProspectRadarModel) {
  const opportunities = state.websiteOpportunities;
  const values: Record<string, string> = {
    prospectRadarSourceCount: String(new Set(opportunities.map((item) => item.sourceLabel || item.source).filter(Boolean)).size),
    prospectRadarCandidateCount: String(model.candidates.length),
    prospectRadarEvidenceCount: String(opportunities.reduce((sum, item) => sum + (item.sourceEvidence?.length || 0), 0)),
    prospectRadarReadyCount: String(opportunities.filter((item) => item.scorecard?.vqa.qualified).length),
    prospectRadarRemovedCount: "--"
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = qs<HTMLElement>(`#${id}`);
    if (element) element.textContent = value;
  });
}

function renderProspectRadarFrame(frame: ProspectRadarFrame, index: number, total: number) {
  const dialog = qs<HTMLDialogElement>("#prospectRadarDialog");
  if (!dialog) return;
  dialog.dataset.tone = frame.tone;
  const values: Record<string, string> = {
    prospectRadarFrameSource: frame.source,
    prospectRadarFrameTitle: frame.title,
    prospectRadarFrameDetail: frame.detail,
    prospectRadarFrameResult: frame.result,
    prospectRadarFrameTime: leadTaskDetailTime(frame.at),
    prospectRadarFrameCount: `${index + 1} / ${total}`
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = qs<HTMLElement>(`#${id}`);
    if (element) element.textContent = value;
  });
  const progress = qs<HTMLElement>("#prospectRadarTimelineProgress");
  if (progress) progress.style.transform = `scaleX(${total > 1 ? index / (total - 1) : 1})`;
}

function setProspectRadarPlaybackUi(playing: boolean) {
  const button = qs<HTMLButtonElement>("#prospectRadarPlayButton");
  if (!button) return;
  button.dataset.playing = String(playing);
  button.textContent = playing ? "暂停" : "继续";
  button.setAttribute("aria-label", playing ? "暂停动画" : "继续动画");
}

export function destroyProspectRadar() {
  prospectRadarController?.destroy();
  prospectRadarController = null;
  qs<HTMLElement>("#prospectRadarGlobe")?.replaceChildren();
  prospectRadarActiveJobId = "";
  prospectRadarLoading = false;
  document.body.classList.remove("prospect-radar-open");
}

export function closeProspectRadar() {
  const dialog = qs<HTMLDialogElement>("#prospectRadarDialog");
  if (dialog?.open) dialog.close();
  else destroyProspectRadar();
}

async function openProspectRadarStage(
  stageId: string,
  model: ProspectRadarModel,
  labels: { title: string; mode: string; state: string },
  renderMetrics: () => void
) {
  const dialog = qs<HTMLDialogElement>("#prospectRadarDialog");
  const host = qs<HTMLElement>("#prospectRadarGlobe");
  if (!dialog || !host || prospectRadarLoading) return;
  prospectRadarActiveJobId = stageId;
  renderMetrics();
  qs<HTMLElement>("#prospectRadarTaskTitle")!.textContent = labels.title;
  qs<HTMLElement>("#prospectRadarTaskMode")!.textContent = labels.mode;
  qs<HTMLElement>("#prospectRadarLiveState")!.textContent = labels.state;
  host.innerHTML = `<div class="prospect-radar-loading"><i></i><b>正在建立全球搜索视图</b><span>只读取真实候选、来源证据和已记录关系</span></div>`;
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("prospect-radar-open");
  prospectRadarLoading = true;
  try {
    const { createProspectRadar } = await import("../prospect-radar");
    if (!dialog.open || prospectRadarActiveJobId !== stageId) return;
    prospectRadarController?.destroy();
    host.innerHTML = "";
    prospectRadarController = createProspectRadar({
      host,
      model,
      onFrameChange: renderProspectRadarFrame,
      onPlaybackChange: setProspectRadarPlaybackUi
    });
  } catch (error) {
    host.innerHTML = `<div class="prospect-radar-error"><b>动画加载失败</b><span>${escapeHtml(error instanceof Error ? error.message : "当前浏览器不支持 WebGL")}</span><button type="button" data-prospect-radar-close>关闭</button></div>`;
    qs<HTMLButtonElement>("[data-prospect-radar-close]", host)?.addEventListener("click", closeProspectRadar);
  } finally {
    prospectRadarLoading = false;
  }
}

export async function openProspectRadar(job: LeadFinderJob) {
  const model = buildProspectRadarModel(job);
  await openProspectRadarStage(job.id, model, {
    title: job.title,
    mode: job.superSearchMissionId ? "超级搜索实况" : "标准搜索实况",
    state: isLeadFinderJobTerminal(job) ? "任务记录回放" : "正在跟随实时事件"
  }, () => renderProspectRadarMetrics(job, model));
}

export async function openProspectPoolRadar() {
  const model = buildProspectPoolRadarModel();
  await openProspectRadarStage("prospect-pool", model, {
    title: model.title,
    mode: model.candidates.length ? "候选池历史数据" : "全球雷达待命",
    state: model.candidates.length ? "按真实加入时间回放" : "等待首个真实候选"
  }, () => renderProspectPoolRadarMetrics(model));
}

export function syncProspectRadar(job: LeadFinderJob) {
  const dialog = qs<HTMLDialogElement>("#prospectRadarDialog");
  if (!dialog?.open || prospectRadarActiveJobId !== job.id || !prospectRadarController) return;
  const model = buildProspectRadarModel(job);
  renderProspectRadarMetrics(job, model);
  qs<HTMLElement>("#prospectRadarLiveState")!.textContent = isLeadFinderJobTerminal(job) ? "任务记录回放" : "正在跟随实时事件";
  prospectRadarController.update(model);
}

export function scrollLeadFinderLiveToLatest() {
  const thread = qs<HTMLElement>("#leadFinderLiveOverview .lead-live-thread");
  const button = qs<HTMLButtonElement>("#leadFinderLiveOverview [data-lead-live-follow]");
  if (!thread) return;
  const previousBehavior = thread.style.scrollBehavior;
  thread.style.scrollBehavior = "auto";
  thread.dataset.follow = "true";
  thread.scrollTop = thread.scrollHeight;
  if (button) button.hidden = true;
  requestAnimationFrame(() => { thread.style.scrollBehavior = previousBehavior; });
}
