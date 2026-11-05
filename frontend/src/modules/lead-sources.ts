/**
 * 数据源中心、CLI 获客、搜客主控台。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import * as XLSX from "xlsx";
import { type BlockedLeadSource, isLeadSourceAutoSelected, isLeadSourceExecutable } from "../lead-source-selection";
import {
  activateNavView, closeModal, confirmAction, createCliAcquireJob, leadFinderJobs, openModal, renderProspectList,
  state
} from "../prototype-api";
import { type LeadFinderJob, type LeadProviderStatus, type ProspectRunProcessPhase, type Todo, type WebsiteOpportunity } from "./models";
import { renderTodos, updateTodoChips } from "./dashboard";
import {
  currentLeadFinderResultJob, currentLeadFinderResults, formatProspectJoinedAt, leadFinderDuplicateState,
  leadFinderFilteredRows, leadFinderLiveElapsed, leadFinderLookupValue, leadFinderMode, leadFinderScore,
  normalizeWebsiteLink, prospectResearchRunning, prospectStatusMeta, renderSuperAiDiscoveryOption,
  renderSuperMapSearchOption, renderSuperSearchPreview, renderSuperWebSearchOption, renderWebsiteOpportunities,
  researchRunningBadgeHtml, selectedSuperAiDiscoveryProviderIds, selectedSuperMapProviderIds,
  selectedSuperWebProviderIds, websiteContactDisplay, websiteContactPersonDisplay, websiteDomain
} from "./prospecting";
import { currentDateTimeText, escapeHtml, qs, qsa } from "./shared";
import {
  collectLeadFinderRows, leadSearchReportMeta, leadTaskJobIsLive, openLeadCandidateResearch,
  openLeadFinderLookupReason, openLeadFinderNoResultReport, openLeadFinderVerificationDrawer, renderLeadFinderDetail,
  renderLeadFinderJobs, renderLeadFinderSearchLinks, renderLeadSearchReportCell
} from "./lead-finder";
import { api, toast } from "./ui";
import { renderTopbarStats } from "./navigation";

// ---------------------------------------------------------------------------
// 数据源中心 / 获客来源选择
// ---------------------------------------------------------------------------

function leadTierText(tier: string) {
  return tier === "free" ? "免费" : tier === "byok_free" ? "自带Key·免费额度" : tier === "ai" ? "AI 模型" : "付费·自带Key";
}

function leadCategoryText(provider: Pick<LeadProviderStatus, "category" | "capabilities">) {
  if (provider.capabilities.includes("procurement")) return "采购机会";
  if (provider.capabilities.includes("maps")) return "地图企业";
  return provider.category === "web" ? "Web搜索" : provider.category === "company" ? "公司库" : provider.category === "ai" ? "AI 生成" : "邮箱发现";
}

export function leadSourceBlockedMessage(blocked: BlockedLeadSource[]) {
  const labels = blocked.map((item) => state.leadProviders.find((provider) => provider.id === item.id)?.name || item.id);
  if (blocked.some((item) => item.id === "ai_search" && item.reason === "not_ready")) {
    const aiProvider = state.leadProviders.find((provider) => provider.id === "ai_search");
    return aiProvider?.lastTestMessage
      || "AI 搜索需要测试通过 OpenAI Web Search；其它模型请配置官网搜索 API";
  }
  if (blocked.some((item) => item.reason === "missing")) {
    return `数据源状态已变化，请重新选择：${labels.join("、")}`;
  }
  if (blocked.some((item) => item.reason === "disabled")) {
    return `所选数据源已停用，请先重新启用：${labels.join("、")}`;
  }
  if (blocked.some((item) => item.reason === "not_executable")) {
    return `所选来源仅支持导入或人工检索，不能直接执行：${labels.join("、")}`;
  }
  return `所选数据源尚未配置：${labels.join("、")}`;
}

export function renderLeadSourceChips() {
  const box = qs<HTMLElement>("#leadSourceChips");
  if (!box) return;
  const automaticProviders = state.leadProviders.filter((provider) => provider.accessMode === "api");
  if (!automaticProviders.length) {
    box.innerHTML = `<span class="empty-inline">暂无数据源</span>`;
    return;
  }
  const chipHtml = (provider: LeadProviderStatus) => {
    const executable = isLeadSourceExecutable(provider);
    const selected = executable && state.selectedLeadSources.includes(provider.id);
    const isAi = provider.tier === "ai";
    const cls = `${executable ? (selected ? "ready active" : "ready") : provider.ready ? "disabled" : "needkey"}${isAi ? " ai" : ""}`;
    const stateText = isAi
      ? (!provider.ready
          ? provider.hasApiKey
            ? state.aiConfig?.webSearchStatus === "unsupported"
              ? "模型不支持联网"
              : state.aiConfig?.webSearchStatus === "failed"
                ? "联网测试失败"
                : "Web Search 待测试"
            : "未配置"
          : provider.enabled ? "官网联网已验证" : "已停用")
      : !provider.ready ? "未配置" : !provider.enabled ? "已停用" : provider.requiresKey ? "已连接" : "内置";
    return `<button type="button" class="lead-source-chip ${cls}" data-lead-provider="${escapeHtml(provider.id)}"><span class="dot"></span><span class="ls-chip-name">${escapeHtml(provider.name)}</span><small>${stateText}</small></button>`;
  };
  const isFreeSource = (provider: LeadProviderStatus) => provider.tier === "free" || provider.tier === "byok_free";
  const freeSources = automaticProviders.filter(isFreeSource);
  const recommended = automaticProviders.filter((provider) => provider.recommended && !isFreeSource(provider));
  const extended = automaticProviders.filter((provider) =>
    !provider.recommended && !isFreeSource(provider)
  );
  box.innerHTML = `
    <div class="lead-source-primary">
      ${recommended.length ? recommended.map(chipHtml).join("") : `<span class="empty-inline">暂无可用推荐来源。</span>`}
    </div>
    ${freeSources.length ? `
      <details class="lead-source-more" open>
        <summary>更多免费来源（效果可能不佳，默认不勾选） <span>${freeSources.length} 个</span></summary>
        <div class="lead-source-more-grid">${freeSources.map(chipHtml).join("")}</div>
      </details>` : ""}
    ${extended.length ? `
      <details class="lead-source-more lead-source-extended" open>
        <summary>扩展与 AI 来源 <span>${extended.length} 个</span></summary>
        <div class="lead-source-more-grid">${extended.map(chipHtml).join("")}</div>
      </details>` : ""}
  `;
  qsa<HTMLButtonElement>("[data-lead-provider]", box).forEach((chip) => {
    chip.addEventListener("click", () => {
      const id = chip.dataset.leadProvider || "";
      const provider = state.leadProviders.find((item) => item.id === id);
      if (!provider) return;
      if (!isLeadSourceExecutable(provider)) {
        if (provider.ready && !provider.enabled) {
          if (provider.requiresKey) openLeadSourceCenter(id);
          toast(
            provider.requiresKey
              ? `${provider.name} 已停用，请在数据源中心保存并启用`
              : `${provider.name} 已停用，暂不能用于搜索`,
            "error"
          );
          return;
        }
        if (id === "ai_search") {
          activateNavView("ai-config", () => {
            qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
            toast("在此启用模型并勾选“自动获客”，即可把 AI 搜索作为获客来源");
          });
        } else {
          openLeadSourceCenter(id);
        }
        return;
      }
      state.leadSourceSelectionTouched = true;
      if (state.selectedLeadSources.includes(id)) state.selectedLeadSources = state.selectedLeadSources.filter((item) => item !== id);
      else state.selectedLeadSources = [...state.selectedLeadSources, id];
      if (leadFinderMode === "super" && provider.category === "web") {
        const checkbox = qs<HTMLInputElement>("#leadSuperWebSearch");
        if (checkbox) checkbox.checked = selectedSuperWebProviderIds().length > 0;
      }
      if (leadFinderMode === "super" && provider.capabilities.includes("maps")) {
        const checkbox = qs<HTMLInputElement>("#leadSuperMapSearch");
        if (checkbox) checkbox.checked = selectedSuperMapProviderIds().length > 0;
      }
      if (leadFinderMode === "super" && provider.id === "ai_search") {
        const checkbox = qs<HTMLInputElement>("#leadSuperAiDiscovery");
        if (checkbox) checkbox.checked = selectedSuperAiDiscoveryProviderIds().length > 0;
      }
      renderLeadSourceChips();
      renderSuperWebSearchOption();
      renderSuperMapSearchOption();
      renderSuperAiDiscoveryOption();
      renderSuperSearchPreview();
    });
  });
}

function leadSourceGroup(provider: LeadProviderStatus) {
  if (provider.accessMode !== "api") return "assisted";
  if (provider.capabilities.includes("procurement") || provider.capabilities.includes("business_signal")) return "procurement";
  if (provider.capabilities.includes("maps")) return "maps";
  if (provider.category === "web" || provider.category === "ai" || provider.category === "email") return "web";
  return "company";
}

function leadSourceAccessText(provider: LeadProviderStatus) {
  if (provider.accessMode === "bulk_file") return "官方文件人工筛选";
  if (provider.accessMode === "website_controlled") return "官方网页人工检索";
  if (provider.accessMode === "manual_assisted") return "人工检索并导入";
  return "";
}

function leadSourceCredentialLabel(provider: LeadProviderStatus) {
  return provider.id === "sec_edgar" ? "Fair Access User-Agent" : "API Key";
}

function leadSourceCardsHtml(focusId?: string) {
  const cardHtml = (provider: LeadProviderStatus) => {
    const executable = isLeadSourceExecutable(provider);
    const assisted = provider.accessMode !== "api";
    const statusCls = assisted ? "manual" : !provider.ready || !provider.enabled ? "warn" : provider.lastTestStatus === "failed" ? "fail" : "ok";
    const isAi = provider.id === "ai_search";
    const credentialLabel = leadSourceCredentialLabel(provider);
    const configurableApiKey = provider.requiresKey || provider.optionalKey;
    const statusText = assisted
      ? `${leadSourceAccessText(provider)}，不参与自动搜索`
      : isAi
      ? (!provider.ready
          ? "未配置，去「AI 模型配置」开启"
          : !provider.enabled
            ? "模型已配置，但该来源当前停用"
            : (provider.lastTestMessage || "已启用，可作为获客来源"))
      : !provider.ready
        ? `未配置 ${credentialLabel}`
      : !provider.enabled
          ? (provider.requiresKey ? `已保存 ${credentialLabel}，当前停用` : "该来源当前已停用")
          : !configurableApiKey
            ? "内置免费源，无需配置"
            : provider.optionalKey && !provider.hasApiKey
              ? "已启用，可选填写 API Key"
            : provider.ready
          ? (provider.lastTestStatus === "passed" ? "已连接并通过测试" : provider.lastTestStatus === "failed" ? `测试失败：${provider.lastTestMessage || `请检查 ${credentialLabel}`}` : `${credentialLabel} 已保存`)
          : `未配置 ${credentialLabel}`;
    const caps = provider.capabilities.map((cap) => `<span class="ls-cap">${escapeHtml(cap)}</span>`).join("");
    const form = assisted ? `
      <div class="ls-usage">${escapeHtml(provider.costNote)}</div>
      <div class="ls-form-actions">
        ${provider.docsUrl ? `<a class="btn" href="${escapeHtml(provider.docsUrl)}" target="_blank" rel="noreferrer">打开官方入口</a>` : ""}
        <button class="btn primary" type="button" data-ls-import="${escapeHtml(provider.id)}">返回并导入链接</button>
      </div>` : isAi ? `
      <div class="ls-usage">${escapeHtml(provider.costNote)}</div>
      <div class="ls-form-actions"><button class="btn" type="button" data-ls-ai-config>去 AI 模型配置</button></div>` : configurableApiKey ? `
      <div class="ls-form">
        <input type="${provider.id === "sec_edgar" ? "text" : "password"}" data-ls-key="${escapeHtml(provider.id)}" placeholder="${provider.hasApiKey ? `${credentialLabel} 已保存（留空不修改）` : provider.optionalKey ? `可选填写 ${credentialLabel}` : `填写 ${credentialLabel}`}" autocomplete="off">
        <div class="ls-form-actions">
          <button class="btn primary" type="button" data-ls-save="${escapeHtml(provider.id)}">保存并启用</button>
          <button class="btn" type="button" data-ls-test="${escapeHtml(provider.id)}">测试连接</button>
          ${provider.hasApiKey ? `<button class="btn" type="button" data-ls-delete="${escapeHtml(provider.id)}">清除</button>` : ""}
        </div>
        ${provider.usage ? `<div class="ls-usage">${escapeHtml(provider.usage)}</div>` : ""}
        <div class="ls-usage">${escapeHtml(provider.keyHint)}</div>
      </div>` : `<div class="ls-usage">${escapeHtml(provider.costNote)}</div>`;
    return `
      <div class="ls-card ${assisted ? "is-assisted" : ""} ${executable && provider.requiresKey ? "is-ready" : ""} ${focusId === provider.id ? "is-open" : ""}">
        <div class="ls-card-top">
          <div><h4>${escapeHtml(provider.name)}</h4><p>${leadCategoryText(provider)} · ${escapeHtml(provider.costNote)}</p></div>
          <span class="ls-tier ${assisted ? "assisted" : provider.tier}">${assisted ? "导入/人工检索" : leadTierText(provider.tier)}</span>
        </div>
        <div class="ls-caps">${caps}</div>
        <div class="ls-status ${statusCls}"><span class="dot"></span>${escapeHtml(statusText)}</div>
        ${form}
        ${!assisted && provider.docsUrl ? `<a class="ls-docs" href="${escapeHtml(provider.docsUrl)}" target="_blank" rel="noreferrer">查看官方文档 ↗</a>` : ""}
      </div>`;
  };
  const groups = [
    { id: "web", title: "Web 搜索" },
    { id: "maps", title: "地图企业" },
    { id: "company", title: "企业核验" },
    { id: "procurement", title: "采购信号" },
    { id: "assisted", title: "导入/人工情报" }
  ];
  const content = groups.map((group) => {
    const providers = state.leadProviders.filter((provider) => leadSourceGroup(provider) === group.id);
    if (!providers.length) return "";
    return `
      <section class="ls-group">
        <div class="ls-group-head"><div><h3>${group.title}</h3></div><span>${providers.length} 个来源</span></div>
        <div class="ls-grid">${providers.map(cardHtml).join("")}</div>
      </section>
    `;
  }).join("");
  return content;
}

function bindLeadSourceCards() {
  const modal = qs<HTMLElement>("#appModal");
  if (!modal) return;
  qsa<HTMLButtonElement>("[data-ls-save]", modal).forEach((button) => button.addEventListener("click", () => void saveLeadSourceConfig(button.dataset.lsSave || "", button)));
  qsa<HTMLButtonElement>("[data-ls-test]", modal).forEach((button) => button.addEventListener("click", () => void testLeadSourceConfig(button.dataset.lsTest || "", button)));
  qsa<HTMLButtonElement>("[data-ls-delete]", modal).forEach((button) => button.addEventListener("click", () => void deleteLeadSourceConfig(button.dataset.lsDelete || "")));
  qsa<HTMLButtonElement>("[data-ls-import]", modal).forEach((button) => {
    button.addEventListener("click", () => {
      const provider = state.leadProviders.find((item) => item.id === button.dataset.lsImport);
      closeModal();
      activateNavView("lead-finder", () => {
        qs<HTMLDetailsElement>(".lead-advanced-settings")?.setAttribute("open", "true");
        const input = qs<HTMLTextAreaElement>("#leadFinderUrlInput");
        input?.scrollIntoView({ behavior: "smooth", block: "center" });
        input?.focus();
        toast(`已返回链接导入入口，请粘贴从${provider?.name || "该来源"}核实到的企业或结果链接`);
      });
    });
  });
  qs<HTMLButtonElement>("[data-ls-ai-config]", modal)?.addEventListener("click", () => {
    closeModal();
    activateNavView("ai-config", () => {
      qs<HTMLInputElement>("#gptApiKeyInput")?.focus();
      toast("启用模型并勾选“自动获客”后，AI 搜索即可用");
    });
  });
}

export function openLeadSourceCenter(focusId?: string) {
  openModal("数据源中心", leadSourceCardsHtml(focusId), `<button class="btn" data-modal-close>关闭</button>`);
  bindLeadSourceCards();
}

function refreshLeadSourceCenter(providers?: LeadProviderStatus[]) {
  if (providers) state.leadProviders = providers;
  if (!state.leadSourceSelectionTouched) {
    state.selectedLeadSources = state.leadProviders
      .filter((item) => item.id !== "ai_search" && isLeadSourceAutoSelected(item))
      .map((item) => item.id);
  }
  renderLeadSourceChips();
  renderSuperWebSearchOption();
  renderSuperMapSearchOption();
  renderSuperAiDiscoveryOption();
  const modal = qs<HTMLElement>("#appModal");
  if (modal?.classList.contains("active")) {
    const body = qs<HTMLElement>("#modalBody");
    if (body) {
      body.innerHTML = leadSourceCardsHtml();
      bindLeadSourceCards();
    }
  }
}

async function saveLeadSourceConfig(providerId: string, button?: HTMLButtonElement) {
  if (!providerId) return;
  const input = qs<HTMLInputElement>(`[data-ls-key="${providerId}"]`);
  const key = input?.value.trim() || "";
  const provider = state.leadProviders.find((item) => item.id === providerId);
  if (provider?.requiresKey && !key && !provider.hasApiKey) {
    toast(`请先填写${leadSourceCredentialLabel(provider)}`, "error");
    return;
  }
  const original = button?.textContent || "";
  if (button) { button.disabled = true; button.textContent = "保存中"; }
  try {
    const result = await api<{ providers: LeadProviderStatus[] }>("/api/lead-finder/source-config", {
      method: "POST",
      body: JSON.stringify({ provider: providerId, apiKey: key, enabled: true })
    });
    state.leadSourceSelectionTouched = true;
    refreshLeadSourceCenter(result.providers);
    const nextProvider = state.leadProviders.find((item) => item.id === providerId);
    if (isLeadSourceExecutable(nextProvider)) {
      if (!state.selectedLeadSources.includes(providerId)) state.selectedLeadSources = [...state.selectedLeadSources, providerId];
      if (leadFinderMode === "super" && nextProvider?.category === "web") {
        const checkbox = qs<HTMLInputElement>("#leadSuperWebSearch");
        if (checkbox) checkbox.checked = true;
      }
      if (leadFinderMode === "super" && nextProvider?.capabilities.includes("maps")) {
        const checkbox = qs<HTMLInputElement>("#leadSuperMapSearch");
        if (checkbox) checkbox.checked = true;
      }
      renderLeadSourceChips();
      renderSuperWebSearchOption();
      renderSuperMapSearchOption();
      renderSuperSearchPreview();
      toast(`已保存并启用：${provider?.name || providerId}`);
    } else {
      state.selectedLeadSources = state.selectedLeadSources.filter((item) => item !== providerId);
      renderLeadSourceChips();
      toast(`${provider?.name || providerId} 已保存，但来源目录当前停用`, "error");
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存失败", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = original || "保存并启用"; }
  }
}

async function testLeadSourceConfig(providerId: string, button?: HTMLButtonElement) {
  if (!providerId) return;
  const input = qs<HTMLInputElement>(`[data-ls-key="${providerId}"]`);
  const key = input?.value.trim() || "";
  const provider = state.leadProviders.find((item) => item.id === providerId);
  const original = button?.textContent || "";
  if (button) { button.disabled = true; button.textContent = "测试中"; }
  try {
    // 若填了新 key，先静默保存再测试，保证“填上 key 就能测通”
    if ((provider?.requiresKey || provider?.optionalKey) && key) {
      await api("/api/lead-finder/source-config", { method: "POST", body: JSON.stringify({ provider: providerId, apiKey: key, enabled: true }) });
    }
    const result = await api<{
      ok: boolean;
      message: string;
      usage: string;
      errorCode: string;
      retryable: boolean;
      retryAfterAt: string | null;
      providers: LeadProviderStatus[];
    }>("/api/lead-finder/source-config/test", {
      method: "POST",
      body: JSON.stringify({ provider: providerId })
    });
    refreshLeadSourceCenter(result.providers);
    const retryAt = result.retryAfterAt ? new Date(result.retryAfterAt) : null;
    const retryHint = retryAt && !Number.isNaN(retryAt.getTime())
      ? ` · ${retryAt.toLocaleString("zh-CN", { hour12: false })} 后可重试`
      : result.retryable ? " · 可稍后重试" : "";
    toast(result.message + (result.usage ? ` · ${result.usage}` : "") + retryHint, result.ok ? "ok" : "error");
  } catch (error) {
    toast(error instanceof Error ? error.message : "测试失败", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = original || "测试连接"; }
  }
}

async function deleteLeadSourceConfig(providerId: string) {
  if (!providerId) return;
  const provider = state.leadProviders.find((item) => item.id === providerId);
  const confirmed = await confirmAction({
    title: "清除数据源密钥",
    message: "清除后，该数据源将停止执行需要认证的搜索任务。",
    detail: provider?.name || providerId,
    detailLabel: "数据源",
    consequences: ["已保存的 API Key 会被移除", "历史搜索结果与运行记录会保留", "重新配置密钥后可以恢复使用"],
    confirmLabel: "清除密钥",
    tone: "warning"
  });
  if (!confirmed) {
    openLeadSourceCenter(providerId);
    return;
  }
  try {
    const result = await api<{ providers: LeadProviderStatus[] }>(`/api/lead-finder/source-config/${encodeURIComponent(providerId)}`, { method: "DELETE" });
    state.selectedLeadSources = state.selectedLeadSources.filter((item) => item !== providerId);
    refreshLeadSourceCenter(result.providers);
    openLeadSourceCenter(providerId);
    toast("已清除该数据源的 API Key");
  } catch (error) {
    openLeadSourceCenter(providerId);
    toast(error instanceof Error ? error.message : "清除失败", "error");
  }
}

export function syncLeadRowFields(row: HTMLElement) {
  const id = row.dataset.leadId;
  const item = state.websiteOpportunities.find((o) => o.id === id);
  if (!item) return;
  const read = (field: string) => row.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-lead-field="${field}"]`)?.value.trim();
  const company = read("company");
  if (company) item.company = company;
  const business = read("business"); if (business !== undefined) item.business = business;
  const country = read("country"); if (country !== undefined) item.country = country;
  const website = read("website"); if (website) item.website = website;
  const contact = read("contact"); if (contact !== undefined) item.contact = contact;
  const contactInfo = read("contactInfo"); if (contactInfo !== undefined) item.contactInfo = contactInfo;
  const description = read("description"); if (description !== undefined) item.description = description;
}

function leadSourceTag(item: WebsiteOpportunity) {
  if (!item.source && !item.sourceLabel) return `<span class="lead-src-tag">导入</span>`;
  const provider = state.leadProviders.find((p) => p.id === item.source);
  const tier = provider?.tier || "byok_free";
  const label = item.sourceLabel || provider?.name || item.source || "来源";
  return `<span class="lead-src-tag ${tier}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

const leadFinderPageSize = 10;
let leadFinderRenderedJobId = "";

function updateLeadFinderSelectionCount() {
  const count = currentLeadFinderResults().filter((item) => item.selected).length;
  const label = qs<HTMLElement>("#leadFinderSelectedCount");
  const bar = qs<HTMLElement>("#leadFinderBulkbar");
  const syncButton = qs<HTMLButtonElement>("#leadFinderSyncButton");
  if (label) label.textContent = `已选 ${count} 条`;
  bar?.classList.toggle("is-empty", count === 0);
  if (syncButton) syncButton.disabled = count === 0;
}

export function canSelectLeadFinderItem(item: WebsiteOpportunity) {
  return !item.shortlistedAt
    && ["preview", "contactable", "contacted"].includes(item.status)
    && leadFinderDuplicateState(item).text === "新候选";
}

function setLeadFinderSelected(id: string, selected: boolean) {
  const item = state.websiteOpportunities.find((row) => row.id === id);
  if (!item || !canSelectLeadFinderItem(item)) return;
  item.selected = selected;
  qsa<HTMLInputElement>(`[data-lead-select][data-lead-select-id="${CSS.escape(id)}"]`).forEach((input) => {
    input.checked = selected;
  });
  qsa<HTMLElement>(`[data-lead-id="${CSS.escape(id)}"], [data-lead-mobile-id="${CSS.escape(id)}"]`).forEach((row) => {
    row.classList.toggle("is-checked", selected);
    row.setAttribute("aria-selected", String(selected));
  });
  updateLeadFinderSelectionCount();
}

function leadFinderMobileCard(item: WebsiteOpportunity) {
  const score = leadFinderScore(item);
  const duplicate = leadFinderDuplicateState(item);
  const disabled = !canSelectLeadFinderItem(item);
  const status = prospectStatusMeta(item);
  const contactDisplay = websiteContactDisplay(item);
  const contactPerson = websiteContactPersonDisplay(item);
  const displayStatus = item.shortlistedAt
    ? { label: "已入搜客清单", tone: "green" }
    : status;
  const reportMeta = leadSearchReportMeta(item);
  return `
    <article class="lead-mobile-card ${item.selected ? "is-checked" : ""}" data-lead-mobile-id="${escapeHtml(item.id)}" aria-selected="${item.selected ? "true" : "false"}">
      <div class="lead-mobile-card-head">
        <input type="checkbox" data-lead-select data-lead-select-id="${escapeHtml(item.id)}" ${item.selected ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="选择 ${escapeHtml(item.company)}">
        <div><h3><button type="button" class="lead-company-link" data-lead-company-open="${escapeHtml(item.id)}">${escapeHtml(item.company)}</button></h3><p>${escapeHtml(websiteDomain(item.website) || "官网待补")} / ${escapeHtml(item.country || "国家待确认")}</p></div>
        <span class="lead-mobile-score"><b>${score}</b><small>综合分</small></span>
      </div>
      <div class="lead-mobile-contact">
        <div><span>联系人</span>${leadFinderLookupValue(item, contactPerson, "联系人")}</div>
        <div><span>联系方式</span>${leadFinderLookupValue(item, contactDisplay, "联系方式")}</div>
      </div>
      <button class="lead-mobile-report is-${escapeHtml(reportMeta.tone)}" type="button" data-lead-report-open="${escapeHtml(item.id)}">${escapeHtml(reportMeta.authenticityLabel)} · ${escapeHtml(reportMeta.checkedCount)} 源 · ${escapeHtml(reportMeta.contactText)}</button>
      <div class="lead-mobile-meta">${leadSourceTag(item)}<span>${escapeHtml(displayStatus.label)}</span><span>${escapeHtml(duplicate.text)}</span>${prospectResearchRunning(item) ? researchRunningBadgeHtml() : ""}</div>
    </article>
  `;
}

// ── CLI 获客（后端 /api/ai-engine/acquire，结果自动同步进候选清单）──────────
// 口径与获客技能一致：本机 CLI 只用公开来源、先核实再产出；CRM 负责去重/合并入池。
// 202 表示 CLI 还在跑（获客比背调慢）——前端轮询作业，用户关页面也不影响入池。

interface CliAcquireStats { rawCount: number; qualifiedCount?: number; rejected?: number; created: number; evidenceUpdated?: number; unchanged?: number; excluded?: number }

export async function refreshCandidatesAfterAcquire() {
  try {
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-opportunities");
    state.websiteOpportunities = result.opportunities || [];
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
  } catch {
    // 刷新失败不打扰用户：下次进入页面会重新拉取，作业结果已由后端落库
  }
}

export type CliAcquirePayload = { goal: string; productKeywords: string; countries: string; industry: string; customerType: string; excludeKeywords: string; limit: number };
type CliAcquirePollFailReason = "completed" | "network" | "timeout";

/** CLI 获客任务卡的本地留档：让「挂起任务」在浏览器刷新后可恢复跟踪 */
interface CliAcquirePersistedJob {
  jobId: string;
  engineJobId?: string;
  payload: CliAcquirePayload;
  createdAt: string;
}

const CLI_ACQUIRE_STORE_KEY = "gj_cli_acquire_jobs_v1";

function readCliAcquireStore(): CliAcquirePersistedJob[] {
  try {
    const raw = window.localStorage.getItem(CLI_ACQUIRE_STORE_KEY);
    const list = raw ? (JSON.parse(raw) as CliAcquirePersistedJob[]) : [];
    return Array.isArray(list) ? list.filter((item) => item?.jobId && item?.payload) : [];
  } catch { return []; }
}

function writeCliAcquireStore(list: CliAcquirePersistedJob[]) {
  try { window.localStorage.setItem(CLI_ACQUIRE_STORE_KEY, JSON.stringify(list.slice(0, 6))); } catch { /* 隐私模式等场景静默忽略 */ }
}

export function upsertCliAcquireStore(entry: CliAcquirePersistedJob) {
  writeCliAcquireStore([entry, ...readCliAcquireStore().filter((item) => item.jobId !== entry.jobId)]);
}

function removeCliAcquireStore(jobId: string) {
  writeCliAcquireStore(readCliAcquireStore().filter((item) => item.jobId !== jobId));
}

/** 轮询引擎作业直到终态：网络抖动自动重连（连续 8 拍才放弃）；入池数真正增加才触发 onFound，避免每拍全量刷清单 */
async function pollCliAcquireJob(
  engineJobId: string,
  onFound?: (count: number) => void,
  onTick?: (info: { acquiredCount: number; status: string }) => void
): Promise<{ stats: CliAcquireStats | null; failReason: CliAcquirePollFailReason }> {
  let lastSeenCount = 0;
  let failures = 0;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    // 前 1 分钟 3 秒一拍（入池高峰），之后放宽到 4 秒，降低无谓请求
    await new Promise((resolve) => window.setTimeout(resolve, attempt < 20 ? 3000 : 4000));
    try {
      const result = await api<{ pending: boolean; payload: { acquisition?: CliAcquireStats | null } | null; acquiredCount?: number; engineJob?: { status?: string } }>(
        `/api/ai-engine/jobs/${encodeURIComponent(engineJobId)}`
      );
      failures = 0;
      const acquiredCount = typeof result.acquiredCount === "number" ? result.acquiredCount : 0;
      onTick?.({ acquiredCount, status: result.engineJob?.status || "running" });
      if (acquiredCount > 0 && acquiredCount !== lastSeenCount) {
        lastSeenCount = acquiredCount;
        onFound?.(acquiredCount);
      }
      if (!result.pending) return { stats: result.payload?.acquisition || null, failReason: "completed" };
    } catch {
      failures += 1;
      onTick?.({ acquiredCount: 0, status: "network" });
      if (failures >= 8) return { stats: null, failReason: "network" };
    }
  }
  return { stats: null, failReason: "timeout" };
}

export function openCliAcquireModal() {
  const body = `<p class="ob-note" style="margin:0 0 12px">只收<strong>决策人或采购人</strong>的具名邮箱（owner / founder / CEO / 总经理 / 采购 / sourcing / buyer）；info@、sales@ 这类公共信箱不算。找不到对应联系人的公司<strong>不会入池</strong>，宁缺毋滥。</p>
  <div class="form-grid">
    <div class="lead-field lead-goal-field" style="grid-column:1/-1"><label>获客目标（自然语言）</label><textarea id="cliAcquireGoalInput" placeholder="例如：寻找德国有水处理项目经验的分销商，最好是能做政府项目的。"></textarea></div>
    <div class="lead-field"><label>产品 / 关键词</label><input id="cliAcquireKeywordsInput" type="text" placeholder="例如：reverse osmosis, water treatment"></div>
    <div class="lead-field"><label>国家 / 地区</label><input id="cliAcquireCountriesInput" type="text" placeholder="例如：Germany, Austria"></div>
    <div class="lead-field"><label>行业 / 场景</label><input id="cliAcquireIndustryInput" type="text" placeholder="例如：municipal water works"></div>
    <div class="lead-field"><label>客户类型</label><input id="cliAcquireCustomerTypeInput" type="text" placeholder="例如：distributor, EPC contractor"></div>
    <div class="lead-field"><label>排除关键词</label><input id="cliAcquireExcludeInput" type="text" placeholder="例如：retail, home use"></div>
    <div class="lead-field"><label>目标数量（1-30）</label><input id="cliAcquireLimitInput" type="number" min="1" max="30" value="8"></div>
  </div>
  <p class="ob-note" style="margin-top:10px">点击开始后弹窗立即关闭，任务会挂到搜客任务队列实时显示进度与执行细节（每核实一家实时入池）；期间可自由操作其它界面，刷新页面后任务卡也会自动恢复跟踪，结果不会丢，候选清单自动按查重规则入池。</p>`;
  openModal("CLI 获客 · 本机智能体搜寻", body, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="cliAcquireSubmitButton" type="button">开始获客并同步候选清单</button>`, { closeOnBackdrop: false });
  qs<HTMLButtonElement>("#cliAcquireSubmitButton")?.addEventListener("click", () => void runCliAcquire());
}

/** 统一的任务卡阶段写入器 */
function cliAcquirePhaseSetter(job: LeadFinderJob) {
  return (index: number, status: ProspectRunProcessPhase["status"], result: string) => {
    const phase = job.processPhases?.[index];
    if (phase) { phase.status = status; if (result) phase.result = result; }
  };
}

/** 把本轮新入池的 CLI 候选收进任务卡（结果列表 + 阶段提示） */
function cliAcquireCollectFindings(job: LeadFinderJob, knownIds: Set<string>) {
  const fresh = state.websiteOpportunities
    .filter((item) => item.source === "cli_acquisition" && !knownIds.has(item.id))
    .map((item) => item.id);
  fresh.forEach((id) => knownIds.add(id));
  if (fresh.length) {
    job.resultIds = [...(job.resultIds || []), ...fresh];
    job.resultCount = job.resultIds.length;
    cliAcquirePhaseSetter(job)(2, "running", `已入池 ${job.resultCount} 家候选`);
  }
}

/** 任务卡成功终态：汇总统计 + 指引下一步 */
function finalizeCliAcquireCard(job: LeadFinderJob, stats: CliAcquireStats) {
  const setPhase = cliAcquirePhaseSetter(job);
  setPhase(1, "succeeded", `返回 ${stats.rawCount} 家`);
  setPhase(2, "succeeded", `入池 ${job.resultCount} 家`);
  setPhase(3, "succeeded", "完成");
  job.status = "done";
  job.progress = 100;
  job.elapsedText = "已结束";
  job.progressValue = "已完成";
  job.incrementalStats = {
    rawCount: stats.rawCount,
    returnedCount: stats.rawCount,
    deduplicatedCount: 0,
    newCount: stats.created,
    evidenceUpdatedCount: stats.evidenceUpdated || 0,
    multiSourceMergedCount: 0,
    unchangedCount: stats.unchanged || 0,
    excludedCount: stats.excluded || 0
  };
  job.detailLines = [
    `CLI 返回 ${stats.rawCount} 家 · 有决策人/采购人邮箱 ${stats.qualifiedCount ?? stats.rawCount} 家 · 新增 ${stats.created} 条候选 · 证据更新 ${stats.evidenceUpdated || 0} · 无变化 ${stats.unchanged || 0}`,
    ...(stats.rejected ? [`${stats.rejected} 家因找不到决策人/采购人邮箱未入池（只有 info@/sales@ 或没有具名联系人，不算）`] : []),
    "候选已在下方「可加入搜客清单的候选」列表，勾选后点「加入搜客清单」即可进入搜客清单"
  ];
  renderLeadFinderJobs();
  const rejectedNote = stats.rejected ? `，${stats.rejected} 家无决策人/采购人邮箱未入池` : "";
  toast(`CLI 获客完成：返回 ${stats.rawCount} 家${stats.created ? `，新增 ${stats.created} 条候选` : "，候选已实时同步进清单"}${rejectedNote}`, stats.created ? "success" : "info");
}

/** 正在跟踪的引擎作业 id：防止本地恢复 + 历史重建双路径重复起轮询 */
const cliAcquireTracking = new Set<string>();

/** 跟踪引擎作业直到终态：轮询写回任务卡；首次发起与刷新恢复共用 */
async function trackCliAcquireEngineJob(job: LeadFinderJob, engineJobId: string, restored = false) {
  if (cliAcquireTracking.has(engineJobId)) return;
  cliAcquireTracking.add(engineJobId);
  job.cliEngineJobId = engineJobId;
  try {
    await trackCliAcquireEngineJobBody(job, engineJobId, restored);
  } finally {
    cliAcquireTracking.delete(engineJobId);
  }
}

async function trackCliAcquireEngineJobBody(job: LeadFinderJob, engineJobId: string, restored = false) {
  const setPhase = cliAcquirePhaseSetter(job);
  const knownIds = new Set(state.websiteOpportunities.map((item) => item.id));
  setPhase(1, "running", `${restored ? "恢复跟踪" : "作业"} ${engineJobId.slice(-8)} 执行中`);
  job.detailLines = [
    `${restored ? "页面刷新后已恢复跟踪" : "后台作业已挂到搜客任务队列"}（${engineJobId.slice(-8)}）`,
    "本机 CLI 每核实一家就实时入池；期间可切换其它页面，结果不会丢"
  ];
  renderLeadFinderJobs();
  const { stats, failReason } = await pollCliAcquireJob(
    engineJobId,
    () => {
      void refreshCandidatesAfterAcquire().then(() => {
        cliAcquireCollectFindings(job, knownIds);
        renderLeadFinderJobs();
      });
    },
    ({ acquiredCount, status }) => {
      if (status === "network") {
        job.progressValue = "连接中断，正在重试…";
        setPhase(1, "running", "网络波动，正在重连引擎作业…");
        renderLeadFinderJobs();
        return;
      }
      if (restored && acquiredCount > 0 && !(job.resultIds || []).length) {
        // 刷新恢复无法逐条回填历史入池，用引擎作业的累计数补齐展示
        job.resultCount = acquiredCount;
        setPhase(2, "running", `已入池 ${acquiredCount} 家候选`);
      }
      job.elapsedText = leadFinderLiveElapsed(job);
      job.progress = Math.min(92, 10 + Math.round((Date.now() - new Date(job.createdAt).getTime()) / 2400));
      job.progressValue = acquiredCount > 0 ? `已实时入池 ${acquiredCount} 家` : "本机 CLI 执行中";
      setPhase(1, "running", acquiredCount > 0 ? `已核实并入池 ${acquiredCount} 家` : "正在联网检索与核实…");
      renderLeadFinderJobs();
    }
  );
  if (stats) {
    await refreshCandidatesAfterAcquire();
    cliAcquireCollectFindings(job, knownIds);
    finalizeCliAcquireCard(job, stats);
    removeCliAcquireStore(job.id);
    return;
  }
  if (failReason === "network" || failReason === "timeout") {
    // 任务可能仍在后台执行：卡片标记中断但保留本地留档，下次刷新自动恢复跟踪
    const label = failReason === "network" ? "连接中断" : "跟踪超时";
    setPhase(1, "failed", label);
    job.status = "failed";
    job.progress = 100;
    job.elapsedText = "已结束";
    job.progressValue = label;
    job.detailLines = [
      failReason === "network"
        ? "与后台任务的连接中断，任务可能仍在执行；候选数据不会丢失，刷新页面可恢复跟踪"
        : "跟踪超时：本机 CLI 可能仍在执行，结果不会丢失；稍后刷新页面或直接查看候选清单"
    ];
    renderLeadFinderJobs();
    toast(`CLI 获客跟踪${label}，结果不会丢失；刷新页面可恢复跟踪`, "error");
    return;
  }
  setPhase(1, "failed", "未返回结果");
  job.status = "failed";
  job.progress = 100;
  job.elapsedText = "已结束";
  job.progressValue = "失败";
  job.detailLines = ["本机 CLI 没有返回获客结果", "可到「集成中心 · 本地 Runner」查看执行日志后重试"];
  removeCliAcquireStore(job.id);
  renderLeadFinderJobs();
  toast("本机 CLI 没有返回获客结果，请到「集成中心 · 本地 Runner」查看执行日志", "error");
}

/** 发起 CLI 获客：先拿引擎作业，再交给跟踪器；失败时任务卡标红并清理留档 */
export async function runCliAcquireJob(job: LeadFinderJob, payload: CliAcquirePayload) {
  const setPhase = cliAcquirePhaseSetter(job);
  const knownIds = new Set(state.websiteOpportunities.map((item) => item.id));
  try {
    const result = await api<{ pending?: boolean; engineJob?: { id: string }; acquisition?: CliAcquireStats | null }>(
      "/api/ai-engine/acquire",
      { method: "POST", body: JSON.stringify(payload) }
    );
    if (result.engineJob?.id && !result.acquisition) {
      upsertCliAcquireStore({ jobId: job.id, engineJobId: result.engineJob.id, payload, createdAt: job.createdAt });
      await trackCliAcquireEngineJob(job, result.engineJob.id);
      return;
    }
    if (result.acquisition) {
      // 10 秒窗口内直接完成（罕见）：跳过轮询直接收尾
      await refreshCandidatesAfterAcquire();
      cliAcquireCollectFindings(job, knownIds);
      finalizeCliAcquireCard(job, result.acquisition);
      removeCliAcquireStore(job.id);
      return;
    }
    throw new Error("本机 CLI 没有返回获客结果，请到「集成中心 · 本地 Runner」查看执行日志");
  } catch (error) {
    setPhase(1, "failed", "执行失败");
    job.status = "failed";
    job.progress = 100;
    job.elapsedText = "已结束";
    job.progressValue = "失败";
    job.detailLines = [
      error instanceof Error ? error.message : "CLI 获客失败",
      "可到「集成中心 · 本地 Runner」查看执行日志后重试"
    ];
    removeCliAcquireStore(job.id);
    renderLeadFinderJobs();
    toast(error instanceof Error ? error.message : "CLI 获客失败", "error");
  }
}

/** 后端引擎作业留档的 CLI 获客历史记录（GET /api/ai-engine/acquire-history） */
interface CliAcquireHistoryRecord {
  engineJob: { id: string; status: string; errorMessage?: string; createdAt: string; finishedAt?: string };
  request: Partial<CliAcquirePayload>;
  acquisition: CliAcquireStats | null;
}

/**
 * 任务历史沉淀：CLI 获客的引擎作业本就全量落库（ai_engine_jobs），这里把它
 * 翻译回任务卡——运行中的恢复跟踪，终态的固化为历史卡片。搜客任务队列从此
 * 以数据库为准，刷新 / 换浏览器都不再丢历史（本地 localStorage 只服务在途跟踪）。
 */
export async function loadCliAcquireHistory(): Promise<LeadFinderJob[]> {
  if (!state.user) return [];
  try {
    const result = await api<{ jobs: CliAcquireHistoryRecord[] }>("/api/ai-engine/acquire-history");
    const known = new Set<string>();
    leadFinderJobs.forEach((job) => { if (job.cliEngineJobId) known.add(job.cliEngineJobId); });
    const jobs: LeadFinderJob[] = [];
    for (const record of result.jobs || []) {
      const engineJobId = record.engineJob?.id;
      if (!engineJobId || known.has(engineJobId)) continue;
      known.add(engineJobId);
      const job = cliAcquireHistoryJob(record);
      jobs.push(job);
      if (job.status === "running") void trackCliAcquireEngineJob(job, engineJobId, true);
    }
    return jobs;
  } catch {
    return [];
  }
}

function cliAcquireHistoryJob(record: CliAcquireHistoryRecord): LeadFinderJob {
  const engineJob = record.engineJob;
  const payload = record.request || {};
  const focus = (payload.goal || payload.productKeywords || payload.industry || "CLI 获客").slice(0, 30);
  const running = engineJob.status === "running" || engineJob.status === "pending" || engineJob.status === "queued";
  const failed = engineJob.status === "failed" || engineJob.status === "cancelled";
  const stats = record.acquisition;
  const finishedText = new Date(engineJob.finishedAt || engineJob.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const job: LeadFinderJob = {
    cliEngineJobId: engineJob.id,
    id: `lf_cli_${engineJob.id}`,
    title: `CLI 获客 · ${focus}`,
    subtitle: "联网核实公司，并找决策人/采购人邮箱，命中即入池",
    status: running ? "running" : failed ? "failed" : "done",
    resultCount: stats ? (stats.created || 0) : 0,
    channelCount: 1,
    elapsedText: running ? "执行中" : `结束于 ${finishedText}`,
    progress: running ? 50 : 100,
    steps: ["解析获客目标", "CLI 联网搜寻核实", "候选实时入池", "同步完成"],
    createdAt: engineJob.createdAt,
    expanded: false,
    resultIds: [],
    detailLines: running
      ? ["历史恢复：该任务仍在后台执行，已自动恢复跟踪", "本机 CLI 每核实一家就实时入池；结果不会丢"]
      : failed
        ? [engineJob.errorMessage || "本机 CLI 没有返回获客结果", "可到「集成中心 · 本地 Runner」查看执行日志后重试"]
        : [
            `CLI 返回 ${stats?.rawCount || 0} 家 · 新增 ${stats?.created || 0} 条候选 · 证据更新 ${stats?.evidenceUpdated || 0} · 无变化 ${stats?.unchanged || 0}`,
            "候选已沉淀：候选清单按来源「CLI 获客」可筛出本轮全部结果"
          ],
    progressLabel: "执行进度",
    progressValue: running ? "执行中" : failed ? (engineJob.status === "cancelled" ? "已取消" : "失败") : "已完成",
    processPhases: [
      { id: "parse", name: "解析获客目标", status: "succeeded", result: focus },
      { id: "search", name: "本机 CLI 联网搜寻核实", status: running ? "running" : failed ? "failed" : "succeeded", result: running ? "正在恢复跟踪…" : failed ? (engineJob.errorMessage || "执行失败") : `返回 ${stats?.rawCount || 0} 家` },
      { id: "sync", name: "候选实时入池", status: running ? "pending" : failed ? "pending" : "succeeded", result: failed ? "" : running ? "" : `入池 ${stats?.created || 0} 家候选` },
      { id: "finish", name: "同步完成", status: running ? "pending" : failed ? "pending" : "succeeded", result: running ? "" : finishedText }
    ]
  };
  if (stats && !running && !failed) {
    job.incrementalStats = {
      rawCount: stats.rawCount,
      returnedCount: stats.rawCount,
      deduplicatedCount: 0,
      newCount: stats.created,
      evidenceUpdatedCount: stats.evidenceUpdated || 0,
      multiSourceMergedCount: 0,
      unchangedCount: stats.unchanged || 0,
      excludedCount: stats.excluded || 0
    };
  }
  return job;
}

/**
 * 本地留档（localStorage）现在只服务「点开始 → 拿到 engineJobId」的短暂窗口；
 * 在途任务的恢复与终态历史一律以引擎作业库为准（loadCliAcquireHistory），
 * 这里只清理过期窗口，不再重建任务卡，避免与历史重建双路径竞态。
 */
export async function restoreCliAcquireJobs() {
  const fresh = readCliAcquireStore().filter((entry) =>
    Boolean(entry.engineJobId) && Date.now() - new Date(entry.createdAt).getTime() < 30 * 60_000);
  writeCliAcquireStore(fresh);
}

async function runCliAcquire() {
  const read = (selector: string) => (qs<HTMLInputElement | HTMLTextAreaElement>(selector)?.value || "").trim();
  const payload = {
    goal: read("#cliAcquireGoalInput"),
    productKeywords: read("#cliAcquireKeywordsInput"),
    countries: read("#cliAcquireCountriesInput"),
    industry: read("#cliAcquireIndustryInput"),
    customerType: read("#cliAcquireCustomerTypeInput"),
    excludeKeywords: read("#cliAcquireExcludeInput"),
    limit: Math.max(1, Math.min(30, Number(read("#cliAcquireLimitInput") || "8") || 8))
  };
  if (!payload.goal && !payload.productKeywords && !payload.industry) {
    toast("请至少填写获客目标、产品关键词或行业之一", "error");
    return;
  }
  // 点开始立即关弹窗：任务挂到搜客任务队列（流式框）实时刷进度与执行细节，
  // 轮询在后台独立进行——用户可继续操作其它界面，回到搜客页即见任务卡与候选。
  closeModal();
  const job = createCliAcquireJob(payload);
  void runCliAcquireJob(job, payload);
}

export function renderLeadFinder(opportunities = state.websiteOpportunities) {
  const rows = qs<HTMLElement>("#leadFinderResultRows");
  const mobileRows = qs<HTMLElement>("#leadFinderMobileRows");
  const total = qs<HTMLElement>("#leadFinderTotalCount");
  const pending = qs<HTMLElement>("#leadFinderPendingCount");
  const synced = qs<HTMLElement>("#leadFinderSyncedCount");
  const aiState = qs<HTMLElement>("#leadFinderAiState");
  const aiSub = qs<HTMLElement>("#leadFinderAiSub");
  const aiBadge = qs<HTMLElement>("#leadFinderAiBadge");
  const sourceAiBadge = qs<HTMLElement>("#leadFinderSourceAiBadge");
  const resultJob = currentLeadFinderResultJob();
  const resultJobId = resultJob?.id || "";
  if (leadFinderRenderedJobId !== resultJobId) {
    state.websiteOpportunities.forEach((item) => { item.selected = false; });
    state.leadFinderPage = 1;
    state.selectedLeadFinderId = null;
    leadFinderRenderedJobId = resultJobId;
  }
  opportunities = currentLeadFinderResults(opportunities);
  opportunities.forEach((item) => {
    if (item.selected && !canSelectLeadFinderItem(item)) item.selected = false;
  });
  const ready = Boolean(state.aiConfig?.enabled && state.aiConfig?.hasApiKey && state.aiConfig?.useLeadFinder);
  const sortedAll = [...opportunities].sort((a, b) => {
    // 本轮搜客/勾选的新结果置顶，避免被历史高分种子埋没
    const aSel = a.selected ? 1 : 0;
    const bSel = b.selected ? 1 : 0;
    if (aSel !== bSel) return bSel - aSel;
    if (a.status !== b.status) return a.status === "synced" ? 1 : -1;
    const createdDiff = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (Number.isFinite(createdDiff) && createdDiff !== 0) return createdDiff;
    return leadFinderScore(b) - leadFinderScore(a);
  });
  const sorted = leadFinderFilteredRows(sortedAll);
  const pageCount = Math.max(1, Math.ceil(sorted.length / leadFinderPageSize));
  state.leadFinderPage = Math.min(Math.max(1, state.leadFinderPage), pageCount);
  const pageStart = (state.leadFinderPage - 1) * leadFinderPageSize;
  const pageRows = sorted.slice(pageStart, pageStart + leadFinderPageSize);
  if (!state.selectedLeadFinderId || !sortedAll.some((item) => item.id === state.selectedLeadFinderId)) {
    state.selectedLeadFinderId = sortedAll[0]?.id || null;
  }
  if (total) total.textContent = String(sortedAll.length);
  if (pending) pending.textContent = String(sortedAll.filter((item) => !item.shortlistedAt).length);
  if (synced) synced.textContent = String(sortedAll.filter((item) => Boolean(item.shortlistedAt)).length);
  if (aiState) aiState.textContent = ready ? "AI" : "规则";
  if (aiSub) aiSub.textContent = ready ? `${state.aiConfig?.model || "已配置"} 可用于授权来源归纳` : "未启用 AI 时使用授权来源字段归纳";
  [aiBadge, sourceAiBadge].forEach((node) => {
    if (!node) return;
    node.className = `badge ${ready ? "green" : ""}`;
    node.textContent = ready ? "AI已配置" : "来源归纳";
  });
  const useAi = qs<HTMLInputElement>("#leadFinderUseAiInput");
  if (useAi) useAi.disabled = !ready;
  if (!rows) return;
  qsa<HTMLButtonElement>("[data-lead-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.leadFilter === state.leadFinderFilter);
  });
  const emptyResult = sortedAll.length
    ? `<div>当前筛选条件下没有候选。</div>`
    : resultJob && leadTaskJobIsLive(resultJob)
      ? `<div>本次搜索仍在进行，候选形成后会自动显示。</div>`
      : resultJob
        ? `<div><b>本次未找到可入池候选</b><br><span>可能是来源无返回、历史重复或清洗规则过滤。</span><br><button class="lead-no-result-action" type="button" data-lead-empty-report>查看原因详情</button></div>`
        : `<div>暂无候选客户，请先开始一次搜索。</div>`;
  rows.innerHTML = pageRows.length ? pageRows.map((item) => {
    const score = leadFinderScore(item);
    const duplicate = leadFinderDuplicateState(item);
    const disabled = !canSelectLeadFinderItem(item);
    const status = prospectStatusMeta(item);
    const displayStatus = item.shortlistedAt
      ? { label: "已入搜客清单", tone: "green" }
      : status;
    const verificationText = item.verificationReport?.level && item.verificationReport.level !== "L0"
      ? item.verificationReport.levelLabel
      : item.websiteProbeAttempts?.some((attempt) => attempt.status === "running" || attempt.status === "queued")
        ? "自动补全中"
        : "待业务核对";
    const parseMode = item.parseMode === "reference" ? "链接导入" : item.parseMode === "ai" ? "AI 归纳" : "规则归纳";
    const contactDisplay = websiteContactDisplay(item);
    const contactPerson = websiteContactPersonDisplay(item);
    return `
      <tr data-lead-id="${escapeHtml(item.id)}" class="${item.selected ? "is-checked" : ""}" aria-selected="${item.selected ? "true" : "false"}">
        <td class="lead-candidate-pick"><input type="checkbox" data-lead-select data-lead-select-id="${escapeHtml(item.id)}" ${item.selected ? "checked" : ""} ${disabled ? "disabled" : ""} aria-label="选择 ${escapeHtml(item.company)}"></td>
        <td class="lead-company-cell">
          <div class="lead-cell-title">
            <button type="button" class="lead-company-link" data-lead-company-open="${escapeHtml(item.id)}">${escapeHtml(item.company || "公司待确认")}</button>
            <a href="${escapeHtml(normalizeWebsiteLink(item.website))}" target="_blank" rel="noreferrer" class="lead-cell-domain">${escapeHtml(websiteDomain(item.website) || "官网待补")}</a>
            <time datetime="${escapeHtml(item.createdAt)}">加入 ${escapeHtml(formatProspectJoinedAt(item.createdAt))}</time>
          </div>
          <input type="hidden" data-lead-field="company" value="${escapeHtml(item.company)}"><input type="hidden" data-lead-field="website" value="${escapeHtml(item.website)}"><input type="hidden" data-lead-field="description" value="${escapeHtml(item.description)}">
        </td>
        <td><div class="lead-candidate-source">${leadSourceTag(item)}<span>${escapeHtml(parseMode)}</span></div></td>
        <td>
          <div class="lead-candidate-profile"><b>${escapeHtml(item.country || "国家待确认")}</b><input class="lead-candidate-business-value" data-lead-field="business" value="${escapeHtml(item.business)}" title="${escapeHtml(item.business || "业务待维护")}" aria-label="业务方向" readonly tabindex="-1"></div>
          <input type="hidden" data-lead-field="country" value="${escapeHtml(item.country)}">
        </td>
        <td>${renderLeadSearchReportCell(item)}</td>
        <td><div class="lead-candidate-contact">${leadFinderLookupValue(item, contactPerson, "联系人")}<span>${escapeHtml(contactPerson.detail)}</span></div><input type="hidden" data-lead-field="contact" value="${escapeHtml(item.contact)}"></td>
        <td><div class="lead-candidate-contact">${leadFinderLookupValue(item, contactDisplay, "联系方式")}<span>${escapeHtml(contactDisplay.detail)}</span></div><input type="hidden" data-lead-field="contactInfo" value="${escapeHtml(item.contactInfo)}"></td>
        <td><div class="lead-candidate-score"><strong>${score}</strong><span>综合评分</span><small>${escapeHtml(verificationText)}</small></div></td>
        <td><div class="lead-candidate-state"><b class="is-${escapeHtml(displayStatus.tone || "neutral")}">${escapeHtml(displayStatus.label)}</b><span>${escapeHtml(duplicate.text)}</span>${prospectResearchRunning(item) ? researchRunningBadgeHtml() : ""}</div><button class="btn lead-row-research-btn" type="button" data-lead-research="${escapeHtml(item.id)}" title="使用本机 CLI 对该候选执行 AI 背调">CLI 背调</button></td>
      </tr>
    `;
  }).join("") : `<tr><td colspan="9" class="empty-cell">${emptyResult}</td></tr>`;
  if (mobileRows) mobileRows.innerHTML = pageRows.length ? pageRows.map(leadFinderMobileCard).join("") : `<div class="empty-cell">${emptyResult}</div>`;
  const pageSummary = qs<HTMLElement>("#leadFinderPageSummary");
  const pageNumber = qs<HTMLElement>("#leadFinderPageNumber");
  const prev = qs<HTMLButtonElement>("#leadFinderPrevPage");
  const next = qs<HTMLButtonElement>("#leadFinderNextPage");
  if (pageSummary) pageSummary.textContent = sorted.length ? `显示 ${pageStart + 1}-${Math.min(pageStart + leadFinderPageSize, sorted.length)}，共 ${sorted.length} 条` : "0 条结果";
  if (pageNumber) pageNumber.textContent = `${state.leadFinderPage} / ${pageCount}`;
  if (prev) prev.disabled = state.leadFinderPage <= 1;
  if (next) next.disabled = state.leadFinderPage >= pageCount;
  qsa<HTMLElement>("#leadFinderResultRows tr[data-lead-id]").forEach((row) => {
    // 行内编辑即时同步到 state，保证重渲染与详情面板反映最新编辑
    qsa<HTMLInputElement | HTMLTextAreaElement>("[data-lead-field]", row).forEach((field) => {
      field.addEventListener("input", () => syncLeadRowFields(row));
    });
  });
  qsa<HTMLInputElement>("[data-lead-select]").forEach((input) => {
    input.addEventListener("change", () => setLeadFinderSelected(input.dataset.leadSelectId || "", input.checked));
  });
  qsa<HTMLButtonElement>("[data-lead-company-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.websiteOpportunities.find((row) =>
        row.id === button.dataset.leadCompanyOpen
      );
      if (item) openLeadFinderVerificationDrawer(item);
    });
  });
  // 行内「CLI 背调」：开抽屉并自动发起，无需先找详情面板
  qsa<HTMLButtonElement>("[data-lead-research]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.websiteOpportunities.find((row) =>
        row.id === button.dataset.leadResearch
      );
      if (item) openLeadCandidateResearch(item);
    });
  });
  qsa<HTMLButtonElement>("[data-lead-lookup-reason]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.websiteOpportunities.find((row) => row.id === button.dataset.leadLookupReason);
      if (item) openLeadFinderLookupReason(item);
    });
  });
  qsa<HTMLButtonElement>("[data-lead-report-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.websiteOpportunities.find((row) => row.id === button.dataset.leadReportOpen);
      if (item) openLeadFinderVerificationDrawer(item);
    });
  });
  qsa<HTMLButtonElement>("[data-lead-empty-report]").forEach((button) => {
    button.addEventListener("click", () => {
      if (resultJob) openLeadFinderNoResultReport(resultJob);
    });
  });
  updateLeadFinderSelectionCount();
  renderLeadFinderDetail(sortedAll.find((item) => item.id === state.selectedLeadFinderId));
  renderLeadFinderSearchLinks();
  renderLeadFinderJobs();
}

export function leadFinderValues(selector: string) {
  return (qs<HTMLInputElement>(selector)?.value.trim() || "")
    .split(/,|，|\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function createLeadFinderTodos(button?: HTMLButtonElement) {
  const opportunities = collectLeadFinderRows();
  if (!opportunities.length) {
    toast("请先勾选需要跟进的候选客户", "error");
    return;
  }
  const unsynced = opportunities.filter((item) => state.websiteOpportunities.find((row) => row.id === item.id)?.status !== "synced");
  if (unsynced.length) {
    toast("请先确认并加入线索，再创建首个正式待办", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "生成中";
  }
  try {
    const created: Todo[] = [];
    for (const item of opportunities) {
      const synced = state.websiteOpportunities.find((row) => row.id === item.id);
      const result = await api<{ todo: Todo }>("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          title: `首次跟进线索：${item.company}`,
          type: "customer",
          priority: "medium",
          dueAt: currentDateTimeText(),
          related: `${synced?.leadId || item.id} · ${item.company}`
        })
      });
      created.push(result.todo);
    }
    state.todos.unshift(...created);
    renderTodos(state.todos);
    updateTodoChips(state.todos);
    renderTopbarStats();
    toast(`已生成 ${created.length} 条首个跟进待办`);
  } catch (error) {
    toast(`生成待办失败：${error instanceof Error ? error.message : "请检查网络后重试"}`, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "生成待办";
    }
  }
}

export function exportLeadFinderRows() {
  const rows = collectLeadFinderRows();
  const source = rows.length ? rows : currentLeadFinderResults();
  if (!source.length) {
    toast("暂无搜客结果可导出", "error");
    return;
  }
  const worksheet = XLSX.utils.json_to_sheet(source.map((item) => ({
    "公司名": item.company,
    "业务": item.business,
    "国家": item.country,
    "官网": item.website,
    "联系人": item.contact,
    "联系方式": item.contactInfo,
    "说明": item.description,
    "评分": "status" in item ? leadFinderScore(item as WebsiteOpportunity) : "",
    "状态": "status" in item ? ((item as WebsiteOpportunity).status === "synced" ? "已同步" : "待确认") : "待确认"
  })));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "智能搜客结果");
  XLSX.writeFile(workbook, `GoodJob智能搜客结果-${Date.now()}.xlsx`);
  toast("搜客结果已导出");
}

export async function registerWebsiteReferences(button?: HTMLButtonElement) {
  const input = qs<HTMLTextAreaElement>("#websiteUrlInput");
  const urls = (input?.value || "").split(/\n|,|，/).map((item) => item.trim()).filter(Boolean);
  if (!urls.length) {
    toast("请先粘贴官网地址", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "正在登记链接";
  }
  try {
    const result = await api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-scrape/preview", {
      method: "POST",
      body: JSON.stringify({ urls })
    });
    const existing = state.websiteOpportunities
      .filter((item) => !result.opportunities.some((next) => next.website === item.website))
      .map((item) => ({ ...item, selected: false }));
    state.websiteOpportunities = [...result.opportunities.map((item) => ({ ...item, selected: true })), ...existing];
    renderWebsiteOpportunities(state.websiteOpportunities);
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    toast(`已登记 ${result.opportunities.length} 个官网链接，公开资料待补全`);
  } catch (error) {
    toast(`链接登记失败：${error instanceof Error ? error.message : "请检查网址格式后重试"}`, "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = "登记链接";
    }
  }
}
