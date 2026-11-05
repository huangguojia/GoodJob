/**
 * 快捷联系条、客户详情页与抽屉、客户情报、客户旅程、会议记录。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import isoCountries from "i18n-iso-countries";
import { activateNavView, closeModal, countryFlagAssets, openBackgroundResearch, openModal, state } from "../prototype-api";
import { type Customer, type CustomerIntelligenceFieldKey, type Deal, type DealItem, type Lead, type Todo } from "./models";
import { updateTodoChips } from "./dashboard";
import {
  type WhatsAppConversationInsight, type WhatsAppPluginConversation, customerContactDetails, customerRelatedDeals,
  customerWonLabel, dealTone, loadCustomerOrders, normalizeWhatsAppPhone, openCustomerReleaseModal,
  renderCustomerDealProgress, renderCustomerOrders, renderCustomers, whatsappPluginRequest
} from "./customers";
import { badge, currentDateTimeText, escapeHtml, money, qs, qsa } from "./shared";
import { customerContactIcon, openDevelopmentEmail, openWhatsAppForContact, researchButtonIcon } from "./development-email";
import { launchCustomerContact } from "./ai-engine-settings";
import { whatsAppEntryAttrs, whatsAppEntryClass, whatsAppEntryHref, whatsAppWebLink } from "./whatsapp";
import { type OutreachJourneyView, openOutreachCustomerJourney, outreachBadgeTone } from "./outreach";
import { api, setButtonPending, toast } from "./ui";
import { customerDocumentName, customerGradeHtml, customerGradeLabel, customerGradeValue } from "./leads";
import { dealEventLabel, dealMoney, formatDateTime } from "./deals";
import { addFollowRecord, openCustomerModal } from "./customer-intake";
import { renderTopbarStats } from "./navigation";

let customerClockTimer = 0;

/* ===== 列表页「快捷联系条」（客户 / 线索 / 客户公池共用） =====
 * 用户需求：在这三处列表里点某一行后，把该行的联系方式浮到该页筛选 / 批量操作条的右端
 * （批量导出右侧那片空位）——邮箱 / 电话 / WhatsApp / 微信，点击直接跳转，不必先打开详情抽屉。
 * 形态上刻意「去按钮化」：只有图标 + 文字，无外框、无底色、无关闭按钮；
 * 选择只改行高亮、不打开抽屉；内容签名不变时跳过重绘，避免筛选 / 翻页触发列表重渲染时闪动重播动画。 */
type ContactDockChannel = "email" | "phone" | "whatsapp" | "wechat";

interface ContactDockSubject {
  name: string;
  meta?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  wechat?: string;
  /** 该渠道没有值时的处理：客户走维护弹窗，线索 / 公池只提示 */
  onMissing?: (channel: ContactDockChannel) => void;
}

const CONTACT_DOCK_CHANNELS: ContactDockChannel[] = ["email", "phone", "whatsapp", "wechat"];

const CONTACT_DOCK_LABEL: Record<ContactDockChannel, string> = {
  email: "邮箱",
  phone: "电话",
  whatsapp: "WhatsApp",
  wechat: "微信"
};

/* 联系条挂到该页「筛选 / 批量操作条」的右端（批量导出右侧那片空位），而不是表格上方另起一块横幅 */
const CONTACT_DOCK_HOSTS: Record<string, { view: string; container: string }> = {
  customers: { view: "#customers", container: "#customerBulkToolbar" },
  leads: { view: "#leads", container: ".lead-filter-row" },
  "customer-pool": { view: "#customer-pool", container: ".customer-pool-toolbar" }
};

/** 当前选中的行。存模块级而不是只存在 DOM 上 —— 客户页批量工具条会整块重写 innerHTML，
 *  联系条得跟着活下来；同时用签名判断内容没变就跳过重绘，避免列表重渲染时闪动。 */
const contactDockSelection: Record<string, { id: string; signature: string } | undefined> = {};

function contactDockValue(subject: ContactDockSubject, channel: ContactDockChannel) {
  if (channel === "email") return String(subject.email || "").trim();
  if (channel === "phone") return String(subject.phone || "").trim();
  if (channel === "whatsapp") {
    return whatsAppEntryHref(subject.whatsapp || "") ? normalizeWhatsAppPhone(subject.whatsapp || "") : "";
  }
  return String(subject.wechat || "").trim();
}

function launchContactDockChannel(subject: ContactDockSubject, channel: ContactDockChannel) {
  const value = contactDockValue(subject, channel);
  if (!value) {
    if (subject.onMissing) subject.onMissing(channel);
    else toast(`该联系人还没有${CONTACT_DOCK_LABEL[channel]}，先补齐再联系`);
    return;
  }
  if (channel === "email") {
    window.location.href = `mailto:${value}?subject=${encodeURIComponent(`GoodJob CRM · ${subject.name}`)}`;
    return;
  }
  if (channel === "phone") {
    window.location.href = `tel:${value.replace(/[^+\d]/g, "")}`;
    return;
  }
  if (channel === "whatsapp") {
    void openWhatsAppForContact({ phone: value, displayName: subject.name });
    return;
  }
  void navigator.clipboard?.writeText(value)
    .then(() => toast(`微信号 ${value} 已复制，去微信添加或搜索即可`))
    .catch(() => toast(`微信号：${value}（复制失败，请手动记录）`));
}

function contactDockHostView(hostKey: string) {
  const host = CONTACT_DOCK_HOSTS[hostKey];
  return host ? qs<HTMLElement>(host.view) : null;
}

export function contactDockElement(hostKey: string) {
  const view = contactDockHostView(hostKey);
  return view ? qs<HTMLElement>(`.contact-dock[data-contact-dock="${hostKey}"]`, view) : null;
}

/**
 * 联系条只认「当前这一屏里真的渲染出来的那一行」。
 *
 * 换标签（未成交 / 已成交）、换筛选、翻页、搜索之后，先前点的那一行可能已经不在列表里了，
 * 这时候联系条必须跟着消失 —— 否则界面上会出现「一个客户都没点，却挂着上一次点的那行的联系方式」，
 * 而且会让人以为这条联系方式属于眼下看到的列表（用户口径 2026-10-14：不点客户就不显示）。
 */
const CONTACT_DOCK_ROW_SELECTOR: Record<string, (subjectId: string) => string> = {
  customers: (id) => `#customers tbody tr[data-customer-id="${CSS.escape(id)}"], #customerMobileList [data-customer-mobile-id="${CSS.escape(id)}"]`,
  leads: (id) => `#leadsTableBody tr[data-lead-id="${CSS.escape(id)}"], #leadMobileList [data-lead-id="${CSS.escape(id)}"]`,
  "customer-pool": (id) => `#customerPoolTableBody tr[data-pool-customer-id="${CSS.escape(id)}"], #customerPoolMobileList [data-pool-customer-id="${CSS.escape(id)}"]`
};

function contactDockRowRendered(hostKey: string, subjectId: string) {
  const view = contactDockHostView(hostKey);
  const selector = CONTACT_DOCK_ROW_SELECTOR[hostKey];
  return Boolean(view && selector && qs<HTMLElement>(selector(subjectId), view));
}

function contactDockSignature(subject: ContactDockSubject) {
  return CONTACT_DOCK_CHANNELS.map((channel) => contactDockValue(subject, channel)).join("\u0001");
}

/** 渲染联系条：只放图标 + 文字（无外框、无底色、无关闭按钮），落到宿主筛选条的最右端 */
function renderContactDockContent(hostKey: string, subject: ContactDockSubject, subjectId: string) {
  const view = contactDockHostView(hostKey);
  if (!view) return;
  const container = qs<HTMLElement>(CONTACT_DOCK_HOSTS[hostKey].container, view);
  if (!container) {
    const orphan = contactDockElement(hostKey);
    if (orphan) orphan.hidden = true;
    return;
  }
  const signature = contactDockSignature(subject);
  const previous = contactDockSelection[hostKey];
  const unchanged = previous?.id === subjectId && previous.signature === signature;
  contactDockSelection[hostKey] = { id: subjectId, signature };
  let dock = contactDockElement(hostKey);
  if (!dock) {
    dock = document.createElement("div");
    dock.className = "contact-dock";
    dock.dataset.contactDock = hostKey;
    dock.setAttribute("role", "group");
    dock.setAttribute("aria-label", "快捷联系");
  }
  if (dock.parentElement !== container) container.appendChild(dock);
  dock.hidden = false;
  if (unchanged && dock.childElementCount > 0) return;
  dock.innerHTML = CONTACT_DOCK_CHANNELS.map((channel) => {
    const value = contactDockValue(subject, channel);
    const label = CONTACT_DOCK_LABEL[channel];
    return `<button class="contact-dock-action ${value ? "is-ready" : "is-empty"}" type="button" data-contact-dock-channel="${channel}" title="${escapeHtml(value ? `${label}：${value}` : `${label}未维护，点击补充`)}">${customerContactIcon(channel)}<span>${escapeHtml(label)}</span></button>`;
  }).join("");
  qsa<HTMLButtonElement>("[data-contact-dock-channel]", dock).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      launchContactDockChannel(subject, (button.dataset.contactDockChannel || "email") as ContactDockChannel);
    });
  });
}

function showContactDock(hostKey: string, subjectId: string, subject: ContactDockSubject) {
  renderContactDockContent(hostKey, subject, subjectId);
}

/** 列表重渲染后按 id 重新取数，让已展开的联系条跟着最新资料走（对象已不存在、或那一行已不在当前列表里，则收起） */
export function refreshContactDock(hostKey: string, resolve: (id: string) => ContactDockSubject | null) {
  const selection = contactDockSelection[hostKey];
  if (!selection) return;
  const subject = resolve(selection.id);
  if (!subject || !contactDockRowRendered(hostKey, selection.id)) {
    hideContactDock(hostKey);
    return;
  }
  renderContactDockContent(hostKey, subject, selection.id);
}

export function hideContactDock(hostKey: string) {
  contactDockSelection[hostKey] = undefined;
  const dock = contactDockElement(hostKey);
  if (!dock) return;
  dock.hidden = true;
  dock.innerHTML = "";
}

/** 客户（未成交 / 已成交）列表行 → 联系条数据 */
export function customerContactDockSubject(customer: Customer): ContactDockSubject {
  const contacts = customerContactDetails(customer);
  return {
    name: customer.company,
    meta: [customer.country, customer.contact, customer.ownerName || "未分配"].filter(Boolean).join(" · "),
    email: contacts.email,
    phone: contacts.phone,
    whatsapp: contacts.whatsapp,
    wechat: contacts.wechat,
    onMissing: (channel) => {
      toast(`请先补充客户${CONTACT_DOCK_LABEL[channel]}，再发起联系`);
      openCustomerModal(customer);
    }
  };
}

export function selectCustomerForContact(customer: Customer) {
  state.selectedCustomerId = customer.id;
  qsa<HTMLElement>("#customers tbody tr").forEach((row) => row.classList.toggle("selected", row.dataset.customerId === customer.id));
  showContactDock("customers", customer.id, customerContactDockSubject(customer));
}

/** 线索列表行 → 联系条数据（线索只有一列电话，WhatsApp 复用该号码，与线索详情一致） */
export function leadContactDockSubject(lead: Lead): ContactDockSubject {
  return {
    name: lead.company,
    meta: [lead.contact || "联系人待补充", lead.country || "国家待补充", lead.stage].filter(Boolean).join(" · "),
    email: lead.email || "",
    phone: lead.phone || "",
    whatsapp: lead.phone || "",
    wechat: lead.wechat || "",
    onMissing: (channel) => toast(`该线索还没有${CONTACT_DOCK_LABEL[channel]}，可在线索详情里补充`)
  };
}

export function selectLeadForContact(lead: Lead) {
  state.selectedLeadId = lead.id;
  qsa<HTMLElement>("#leadsTableBody tr[data-lead-id]").forEach((row) => row.classList.toggle("selected", row.dataset.leadId === lead.id));
  showContactDock("leads", lead.id, leadContactDockSubject(lead));
}

/** 客户公池行 → 联系条数据（未领取的客户只能看与联系，不能改资料） */
export function poolCustomerContactDockSubject(customer: Customer): ContactDockSubject {
  const contacts = customerContactDetails(customer);
  return {
    name: customer.company,
    meta: [customer.country, customer.contact || "联系人待维护", customer.previousOwnerName || "原负责人未记录"].filter(Boolean).join(" · "),
    email: contacts.email,
    phone: contacts.phone,
    whatsapp: contacts.whatsapp,
    wechat: contacts.wechat,
    onMissing: (channel) => toast(`该公池客户还没有${CONTACT_DOCK_LABEL[channel]}，领取后可在客户资料里补充`)
  };
}

export function selectPoolCustomerForContact(customer: Customer) {
  const view = qs<HTMLElement>("#customer-pool");
  if (view) qsa<HTMLElement>("[data-pool-customer-id]", view).forEach((row) => row.classList.toggle("selected", row.dataset.poolCustomerId === customer.id));
  showContactDock("customer-pool", customer.id, poolCustomerContactDockSubject(customer));
}

/** 行点击守卫：行内的按钮 / 勾选框 / 链接有自己的动作，不触发「选中 + 出联系条」 */
export function isContactDockRowAction(target: EventTarget | null) {
  const node = target instanceof HTMLElement ? target : null;
  return Boolean(node?.closest("button, a, input, select, label, textarea"));
}

export function renderCustomerDetailPage(customer?: Customer) {
  const box = qs<HTMLElement>("#customerDetailPage");
  if (!box) return;
  const current = customer
    ? state.customers.find((item) => item.id === customer.id) || customer
    : state.customers.find((item) => item.id === state.selectedCustomerId);
  if (!current) {
    box.innerHTML = `<div class="customer-page-empty">未找到客户资料，请返回客户列表重新选择。</div>`;
    return;
  }
  state.selectedCustomerId = current.id;
  const grade = customerGradeValue(current);
  const deals = customerRelatedDeals(current);
  const activities = current.activities || [];
  const contacts = customerContactDetails(current);
  // 号码能拼出网页版直链才算「可联系」；只填了位数不够的号码同样按未维护处理。
  const whatsappHref = whatsAppEntryHref(contacts.whatsapp);
  const activeDeals = deals.filter((deal) => !deal.archivedAt && !["成交", "丢单"].includes(deal.stage));
  box.innerHTML = `
    <header class="customer-page-header">
      <div class="customer-page-identity">
        <button class="customer-page-back" type="button" data-customer-page-back title="返回客户列表" aria-label="返回客户列表"><svg viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg></button>
        <div class="customer-page-copy">
          <div class="customer-page-title"><h1>${escapeHtml(current.company)}</h1>${customerGradeHtml(current)}${badge(current.hasWonDeal ? "成交客户" : "未成交", current.hasWonDeal ? "green" : "gray")}</div>
          <p>${escapeHtml(current.country)} · ${escapeHtml(current.contact)} · 负责人 ${escapeHtml(current.ownerName || "未分配")}</p>
        </div>
      </div>
      <div class="customer-page-actions"><button class="${whatsAppEntryClass(contacts.whatsapp)}" type="button" data-customer-page-whatsapp ${whatsAppEntryAttrs(contacts.whatsapp)}>WhatsApp</button><button class="btn primary ai-entry-button" type="button" data-customer-page-research>${researchButtonIcon()}AI 背调</button><button class="btn" type="button" data-customer-page-email>写开发信</button><button class="btn" type="button" data-customer-page-journey>开发信过程</button><button class="btn" type="button" data-customer-page-edit>编辑客户</button><button class="btn" type="button" data-customer-page-follow>新增跟进</button><button class="btn" type="button" data-customer-page-release>放入公池</button></div>
    </header>

    <section class="customer-page-summary" aria-label="客户摘要">
      <div><span>客户分级</span><b>${grade} · ${customerGradeLabel(grade)}</b><small>人工维护的业务优先级</small></div>
      <div class="${current.hasWonDeal ? "is-positive" : ""}"><span>成交历史</span><b>${current.hasWonDeal ? customerWonLabel(current) : "尚未成交"}</b><small>${current.lastWonAt ? `最近 ${escapeHtml(formatDateTime(current.lastWonAt))}` : current.hasWonDeal ? "由导入状态确认" : "商机成交后自动转入"}</small></div>
      <div><span>活跃商机</span><b>${activeDeals.length} 个</b><small>在手金额 ${money(current.pipelineAmount || 0)}</small></div>
      <div><span>健康度</span><b>${current.health}%</b><small>人工评分，低于 60 进入风险提醒</small></div>
      <div><span>跟进记录</span><b>${activities.length} 条</b><small>${current.lastActivityAt ? `最近 ${escapeHtml(formatDateTime(current.lastActivityAt))}` : "暂无跟进"}</small></div>
    </section>

    <div class="customer-page-grid">
      <section class="customer-page-section">
        <div class="customer-page-section-head"><div><h2>客户信息</h2><p>主档、单据与交易基础资料</p></div><button class="btn" type="button" data-customer-page-edit>维护</button></div>
        <div class="customer-profile-grid">
          <div class="customer-profile-field"><span>公司名称</span><b>${escapeHtml(current.company)}</b></div>
          <div class="customer-profile-field"><span>国家 / 地区</span><b>${escapeHtml(current.country)}</b></div>
          <div class="customer-profile-field"><span>客户来源</span><b>${escapeHtml(current.source || "未登记")}</b></div>
          <div class="customer-profile-field"><span>主联系人</span><b>${escapeHtml(current.contact)}</b></div>
          <div class="customer-profile-field"><span>WhatsApp</span><b>${escapeHtml(contacts.whatsapp || "待维护")}</b></div>
          <div class="customer-profile-field"><span>单据联系人</span><b>${escapeHtml(current.documentContact || "待维护")}</b></div>
          <div class="customer-profile-field"><span>公司全名</span><b>${escapeHtml(customerDocumentName(current))}</b></div>
          <div class="customer-profile-field"><span>账单地址</span><b>${escapeHtml(current.billingAddress || "待维护")}</b></div>
          <div class="customer-profile-field"><span>贸易 / 付款条款</span><b>${escapeHtml(current.defaultIncoterm || "待维护")} · ${escapeHtml(current.defaultPaymentTerm || "待维护")}</b></div>
          <div class="customer-profile-field"><span>默认目的港</span><b>${escapeHtml(current.defaultPortDischarge || "待维护")}</b></div>
          <div class="customer-profile-field full"><span>其它说明</span><b>${escapeHtml(current.otherNotes || "待维护")}</b></div>
        </div>
      </section>

      <section class="customer-page-section">
        <div class="customer-page-section-head"><div><h2>联系中心</h2><p>直接联系方式与通讯工具接入点</p></div>${badge("企业微信待接入", "gray")}</div>
        <div class="customer-contact-list">
          <div class="customer-contact-row"><span>联系人</span><b>${escapeHtml(current.contact)}</b><small>主联系人</small></div>
          <div class="customer-contact-row"><span>邮箱</span><b>${escapeHtml(contacts.email || "未维护")}</b><small>${contacts.email ? "可直接发邮件" : "待补充"}</small></div>
          <div class="customer-contact-row"><span>电话</span><b>${escapeHtml(contacts.phone || "未维护")}</b><small>${contacts.phone ? "可直接拨号" : "待补充"}</small></div>
          <div class="customer-contact-row"><span>WhatsApp</span><b>${contacts.whatsapp && whatsAppWebLink(contacts.whatsapp) ? `<a class="wa-web-link" href="${whatsAppWebLink(contacts.whatsapp)}" target="_blank" rel="noopener noreferrer">${escapeHtml(contacts.whatsapp)}</a>` : escapeHtml(contacts.whatsapp || "未维护")}</b><small>${contacts.whatsapp ? "点击直接打开 WhatsApp 网页版" : "待补充"}</small></div>
          <div class="customer-contact-row"><span>微信</span><b>${escapeHtml(contacts.wechat || "未维护")}</b><small>${contacts.wechat ? "点击下方按钮复制" : "待补充"}</small></div>
          <div class="customer-contact-row"><span>其它渠道</span><b>${escapeHtml(current.contactRemark || "未维护")}</b><small>${current.contactRemark ? "已登记备注" : "可补充 LinkedIn / 微信等"}</small></div>
        </div>
        <div class="customer-contact-actions">
          <button class="customer-contact-action ${contacts.email ? "is-ready" : "is-empty"}" type="button" data-customer-contact="email">${customerContactIcon("email")}<span>邮件${contacts.email ? "" : " · 待维护"}</span></button>
          <button class="customer-contact-action ${contacts.phone ? "is-ready" : "is-empty"}" type="button" data-customer-contact="phone">${customerContactIcon("phone")}<span>电话${contacts.phone ? "" : " · 待维护"}</span></button>
          <button class="customer-contact-action ${whatsappHref ? "is-ready" : "is-empty"}" type="button" data-customer-contact="whatsapp" ${whatsAppEntryAttrs(contacts.whatsapp)}>${customerContactIcon("whatsapp")}<span>WhatsApp · ${whatsappHref ? "直接沟通" : "未维护"}</span></button>
          <button class="customer-contact-action ${contacts.wechat ? "is-ready" : "is-empty"}" type="button" data-customer-contact="wechat">${customerContactIcon("wechat")}<span>微信 · ${contacts.wechat ? "点击复制" : "未维护"}</span></button>
        </div>
      </section>

      <section class="customer-page-section full">
        <div class="customer-page-section-head"><div><h2>相关商机</h2><p>成交、推进中和历史关闭商机统一展示</p></div><button class="btn" type="button" data-customer-page-pipeline>打开商机管道</button></div>
        <div class="customer-page-deals">${deals.length ? deals.map((deal) => `
          <article class="customer-page-deal">
            <div><b>${escapeHtml(deal.title)}</b><span>${escapeHtml(dealProductsText(deal))} · ${escapeHtml(deal.nextAction || "下一动作待维护")}</span></div>
            <div><b>${escapeHtml(deal.nextActionAt || "时间待定")}</b><span>下一动作时间</span></div>
            ${badge(deal.stage, dealTone(deal))}
            <strong>${escapeHtml(dealMoney(deal.amount, deal.currency))}</strong>
          </article>`).join("") : `<div class="customer-page-empty">暂无关联商机</div>`}</div>
      </section>

      <section class="customer-page-section full customer-communication-section" id="customerCommunicationInsights">
        <div class="customer-page-section-head"><div><h2>WhatsApp 客户洞察</h2><p>实时会话、客户特点、风险与下一动作</p></div><span class="communication-sync-status"><i></i>正在同步</span></div>
        <div class="communication-insight-loading"><span class="loading-dot"></span><b>正在读取即刻沟通客户画像</b><small>只读同步，不会发送任何消息</small></div>
      </section>

      <section class="customer-page-section full customer-page-journey">
        <div class="customer-page-section-head"><div><h2>客户旅程</h2><p>建档、沟通、商机到成交的触点时间轴，WhatsApp 自动同步的跟进同样上墙</p></div></div>
        <div id="customerPageJourneyTimeline"><div style="padding:12px;text-align:center;color:var(--muted);font-size:12px;">加载中...</div></div>
      </section>

      <section class="customer-page-section full" id="customerDevEmailHistory">
        <div class="customer-page-section-head"><div><h2>开发信历史</h2><p>发出去的每一封开发信与客户的反馈记录</p></div><button class="btn" type="button" data-cust-email-journey>查看完整过程</button></div>
        <div class="communication-insight-loading"><span class="loading-dot"></span><b>正在读取开发信历史</b><small>发送、打开、回复与退信记录都会归档在这里</small></div>
      </section>

      <section class="customer-page-section full">
        <div class="customer-page-section-head"><div><h2>跟进记录</h2><p>电话、邮件、会议与社媒沟通的连续时间线</p></div><button class="btn primary" type="button" data-customer-page-follow>新增跟进</button></div>
        <div class="customer-page-followups">${activities.length ? activities.map((activity) => `
          <article class="customer-page-followup">
            <time>${escapeHtml(formatDateTime(activity.createdAt))}</time>
            <div><b>${escapeHtml(customerActivityLabel(activity.type))} · ${escapeHtml(activity.operatorName || "未知操作人")}</b><span>${escapeHtml(activity.content)}</span></div>
            <small>${activity.nextReminder ? `下次：${escapeHtml(activity.nextReminder)}` : "未设置下次提醒"}</small>
            ${activityHasTranscript(activity) && activity.id ? `<button class="btn" type="button" data-activity-transcript="${escapeHtml(activity.id)}" data-activity-name="${escapeHtml(current.contact || current.company)}" title="查看当天对话记录">${customerContactIcon("whatsapp")} 对话</button>` : ""}
          </article>`).join("") : `<div class="customer-page-empty">暂无跟进记录。新增首条联系记录后会在这里形成时间线。</div>`}</div>
      </section>
    </div>
  `;
  qs<HTMLButtonElement>("[data-customer-page-back]", box)?.addEventListener("click", () => activateNavView("customers"));
  qsa<HTMLButtonElement>("[data-customer-page-edit]", box).forEach((button) => button.addEventListener("click", () => openCustomerModal(current)));
  qs<HTMLButtonElement>("[data-customer-page-whatsapp]", box)?.addEventListener("click", () => {
    void openWhatsAppForContact({ phone: contacts.whatsapp, displayName: current.contact || current.company });
  });
  qs<HTMLButtonElement>("[data-customer-page-release]", box)?.addEventListener("click", () => openCustomerReleaseModal(current));
  qs<HTMLButtonElement>("[data-customer-page-research]", box)?.addEventListener("click", () => openBackgroundResearch("customer", current.id, current.company, "customer-detail"));
  qs<HTMLButtonElement>("[data-customer-page-email]", box)?.addEventListener("click", () => openDevelopmentEmail("customer", current.id, current.company, "customer-detail", customerContactDetails(current).whatsapp));
  qs<HTMLButtonElement>("[data-customer-page-journey]", box)?.addEventListener("click", () =>
    void openOutreachCustomerJourney("customer", current.id, current.company, "customer-detail"));
  qsa<HTMLButtonElement>("[data-customer-page-follow]", box).forEach((button) => button.addEventListener("click", () => addFollowRecord(current)));
  qsa<HTMLButtonElement>("[data-activity-transcript]", box).forEach((button) => button.addEventListener("click", () =>
    void openWhatsappTranscriptModal(button.dataset.activityTranscript || "", button.dataset.activityName || "客户")));
  qs<HTMLButtonElement>("[data-customer-page-pipeline]", box)?.addEventListener("click", () => activateNavView("pipeline"));
  qsa<HTMLButtonElement>("[data-cust-email-journey]", box).forEach((button) => button.addEventListener("click", () =>
    void openOutreachCustomerJourney("customer", current.id, current.company, "customer-detail")));
  qsa<HTMLButtonElement>("[data-customer-contact]", box).forEach((button) => {
    button.addEventListener("click", () => launchCustomerContact(current, button.dataset.customerContact as "email" | "phone" | "whatsapp" | "wechat"));
  });
  void loadCustomerCommunicationInsights(current);
  void loadCustomerDevEmailHistory(current);
  renderCustomerJourney(current, qs<HTMLElement>("#customerPageJourneyTimeline", box));
}

/** 客户详情页内嵌「开发信历史」：复用 outreach-journey 档案接口，按客户聚合已发邮件 */
async function loadCustomerDevEmailHistory(customer: Customer) {
  const box = qs<HTMLElement>("#customerDevEmailHistory");
  if (!box || state.selectedCustomerId !== customer.id) return;
  try {
    const view = await api<OutreachJourneyView>(
      `/api/outreach-journey?entityType=customer&entityId=${encodeURIComponent(customer.id)}`
    );
    if (state.selectedCustomerId !== customer.id || !box.isConnected) return;
    renderCustomerDevEmailHistory(box, customer, view);
  } catch (error) {
    if (state.selectedCustomerId !== customer.id || !box.isConnected) return;
    const message = error instanceof Error ? error.message : "开发信历史加载失败";
    box.innerHTML = `
      <div class="customer-page-section-head"><div><h2>开发信历史</h2><p>发出去的每一封开发信与客户的反馈记录</p></div><button class="btn" type="button" data-cust-email-journey>查看完整过程</button></div>
      <div class="communication-insight-empty compact"><b>暂无法读取开发信历史</b><span>${escapeHtml(message)}</span></div>`;
    qs<HTMLButtonElement>("[data-cust-email-journey]", box)?.addEventListener("click", () =>
      void openOutreachCustomerJourney("customer", customer.id, customer.company, "customer-detail"));
  }
}

function renderCustomerDevEmailHistory(box: HTMLElement, customer: Customer, view: OutreachJourneyView) {
  const stats = view.stats;
  const stage = view.stage;
  const tone = outreachBadgeTone(stage.tone);
  const emails = view.emails.slice().reverse();
  const emailsHtml = emails.map((email) => {
    const flags = [
      email.dispatchStatus === "sent" ? badge("已投递", "green") : email.dispatchStatus === "pending" ? badge("投递中", "amber") : badge("结果待确认", "red"),
      email.openCount ? badge(`打开 ${email.openCount}`, "blue") : "",
      email.clickCount ? badge(`点击 ${email.clickCount}`, "blue") : "",
      email.repliedAt ? badge("已回复", "green") : "",
      email.bouncedAt ? badge("已退信", "red") : ""
    ].filter(Boolean).join("");
    return `<article class="cust-email-row">
      <time>${escapeHtml(formatDateTime(email.sentAt))}</time>
      <div class="cust-email-main">
        <b>第 ${email.index} 封 · ${escapeHtml(email.subject || "（无主题）")}</b>
        <small>收件人 ${escapeHtml(email.recipient || "未记录")} · ${escapeHtml(email.sourceLabel || "手动发送")}${email.batchName ? ` · 批次 ${escapeHtml(email.batchName)}` : ""}</small>
        ${email.dispatchError ? `<small style="color:#b33d35">投递异常：${escapeHtml(email.dispatchError)}</small>` : ""}
        ${email.body ? `<details><summary>查看完整正文</summary><pre>${escapeHtml(email.body)}</pre></details>` : email.bodyPreview ? `<small>${escapeHtml(email.bodyPreview)}</small>` : ""}
      </div>
      <div class="cust-email-flags">${flags}</div>
    </article>`;
  }).join("");
  const replies = view.replies.slice().reverse();
  const repliesHtml = replies.length ? `<div class="cust-email-replies">${replies.map((reply) => {
    const isBounce = reply.eventType === "bounce" || reply.classification === "bounced";
    const isNegative = reply.classification === "rejected" || reply.classification === "unsubscribed";
    return `<div class="cust-email-reply${isBounce || isNegative ? " is-bad" : ""}">
      <b>${escapeHtml(isBounce ? "退信" : reply.classificationLabel || "客户回复")} · ${escapeHtml(formatDateTime(reply.occurredAt))}</b>
      <p>${escapeHtml(reply.content || reply.subject || "（无正文）")}</p>
    </div>`;
  }).join("")}</div>` : "";
  const bodyHtml = emails.length
    ? emailsHtml + repliesHtml
    : `<div class="communication-insight-empty compact"><b>还没有给这家客户发过开发信</b><span>发出第一封后，发送、打开、回复与退信记录都会自动归档在这里。</span><button class="btn primary" type="button" data-cust-email-write>写开发信</button></div>`;
  box.innerHTML = `
    <div class="customer-page-section-head"><div><h2>开发信历史</h2><p>${escapeHtml(stats.outboundCount ? `已发 ${stats.outboundCount} 封 · 最近 ${stats.lastSentAt ? formatDateTime(stats.lastSentAt) : "—"}` : "发出去的每一封开发信与客户的反馈记录")}</p></div><button class="btn" type="button" data-cust-email-journey>查看完整过程</button></div>
    <div class="cust-email-summary">
      <span><small>已发送</small><b>${stats.outboundCount} 封</b></span>
      <span><small>回复</small><b class="${stats.replyCount ? "is-good" : ""}">${stats.replyCount} 条</b></span>
      <span><small>打开</small><b>${stats.openCount} 次</b></span>
      <span><small>点击</small><b>${stats.clickCount} 次</b></span>
      <span><small>退信</small><b class="${stats.bounceCount ? "is-bad" : ""}">${stats.bounceCount} 封</b></span>
      <span class="cust-email-stage">${badge(stage.label, tone)}<small>${escapeHtml(stage.nextStepLabel || stage.description || "")}</small></span>
    </div>
    ${bodyHtml}`;
  qs<HTMLButtonElement>("[data-cust-email-journey]", box)?.addEventListener("click", () =>
    void openOutreachCustomerJourney("customer", customer.id, customer.company, "customer-detail"));
  qs<HTMLButtonElement>("[data-cust-email-write]", box)?.addEventListener("click", () =>
    openDevelopmentEmail("customer", customer.id, customer.company, "customer-detail"));
}

function communicationLevelLabel(value: "high" | "medium" | "low") {
  return value === "high" ? "高" : value === "medium" ? "中" : "低";
}

function communicationDueLabel(value: string) {
  if (!value) return "未安排时间";
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return value;
  const delta = due.getTime() - Date.now();
  const hours = Math.ceil(Math.abs(delta) / 3_600_000);
  const relative = delta < 0 ? `已逾期 ${hours} 小时` : hours < 24 ? `${hours} 小时内` : `${Math.ceil(hours / 24)} 天内`;
  return `${relative} · ${formatDateTime(value)}`;
}

function communicationTodoTriggerKey(customerId: string, followupId: string) {
  return `whatsapp-insight:${customerId}:${followupId}`;
}

function todoMatchesCommunicationFollowup(todo: Todo, customer: Customer, followup: WhatsAppConversationInsight["followups"][number]) {
  const triggerKey = communicationTodoTriggerKey(customer.id, followup.id);
  if (todo.triggerKey === triggerKey) return true;
  const belongsToCustomer = todo.customerId === customer.id || (!todo.customerId && (todo.related || "").includes(customer.company));
  return belongsToCustomer && todo.title.trim() === followup.title.trim() && (todo.related || "").includes("WhatsApp");
}

async function createCustomerCommunicationTodo(customer: Customer, followup: WhatsAppConversationInsight["followups"][number], button: HTMLButtonElement) {
  try {
    button.disabled = true;
    button.textContent = "创建中";
    const result = await api<{ todo: Todo }>("/api/todos", {
      method: "POST",
      body: JSON.stringify({
        title: followup.title,
        type: "customer",
        priority: followup.priority,
        dueAt: followup.dueAt,
        related: `WhatsApp · ${customer.company} · ${followup.reason}`,
        customerId: customer.id,
        triggerKey: communicationTodoTriggerKey(customer.id, followup.id)
      })
    });
    if (!state.todos.some((todo) => todo.id === result.todo.id)) state.todos.unshift(result.todo);
    button.textContent = "已加入待办";
    toast("已加入 GoodJob 待办");
  } catch (error) {
    button.disabled = false;
    button.textContent = "转为待办";
    toast(error instanceof Error ? error.message : "待办创建失败", "error");
  }
}

async function loadCustomerCommunicationInsights(customer: Customer) {
  const box = qs<HTMLElement>("#customerCommunicationInsights");
  if (!box || state.selectedCustomerId !== customer.id) return;
  const phone = normalizeWhatsAppPhone(customerContactDetails(customer).whatsapp);
  if (!phone) {
    box.innerHTML = `<div class="customer-page-section-head"><div><h2>WhatsApp 客户洞察</h2><p>实时会话、客户特点、风险与下一动作</p></div>${badge("待绑定号码", "gray")}</div><div class="communication-insight-empty"><b>尚未维护 WhatsApp 号码</b><span>补充号码后，客户会话分析将自动汇总到这里。</span><button class="btn" type="button" data-communication-edit>维护客户资料</button></div>`;
    qs<HTMLButtonElement>("[data-communication-edit]", box)?.addEventListener("click", () => openCustomerModal(customer));
    return;
  }
  try {
    const conversations = await whatsappPluginRequest<WhatsAppPluginConversation[]>("/v1/conversations");
    const conversation = conversations.find((item) => normalizeWhatsAppPhone(item.contactPhone) === phone);
    if (!conversation) {
      box.innerHTML = `<div class="customer-page-section-head"><div><h2>WhatsApp 客户洞察</h2><p>实时会话、客户特点、风险与下一动作</p></div>${badge("等待首条消息", "gray")}</div><div class="communication-insight-empty"><b>尚未收到该客户的 Meta 会话</b><span>客户通过 WhatsApp 发来首条消息后，系统会自动建档、分析并在此展示；无需从 CRM 主动发送。</span></div>`;
      return;
    }
    const insight = await whatsappPluginRequest<WhatsAppConversationInsight>(`/v1/conversations/${encodeURIComponent(conversation.id)}/intelligence`);
    if (state.selectedCustomerId !== customer.id) return;
    const analysis = insight.analysis;
    const pending = insight.followups.filter((item) => item.status === "pending");
    const relatedTodos = state.todos.filter((todo) => todo.customerId === customer.id || (!todo.customerId && (todo.related || "").includes(customer.company)));
    const unmatchedLinkedTodos = relatedTodos.filter((todo) => !todo.done && (todo.related || "").includes("WhatsApp") && !pending.some((item) => todoMatchesCommunicationFollowup(todo, customer, item)));
    box.innerHTML = `
      <div class="customer-page-section-head"><div><h2>WhatsApp 客户洞察</h2><p>${escapeHtml(conversation.contactName || customer.contact)} · ${escapeHtml(conversation.contactPhone)} · ${conversation.lastMessageAt ? `最近消息 ${escapeHtml(formatDateTime(conversation.lastMessageAt))}` : "等待新消息"}</p></div><span class="communication-sync-status is-ready"><i></i>实时同步</span></div>
      ${analysis ? `<div class="communication-command-center">
        <div><span>现在最重要</span><h3>${escapeHtml(analysis.nextAction)}</h3><p>${escapeHtml(analysis.summary)}</p></div>
        <div class="communication-score-grid"><span class="intent-${analysis.buyingIntent}"><small>购买意向</small><b>${communicationLevelLabel(analysis.buyingIntent)}</b></span><span class="risk-${analysis.riskLevel}"><small>风险等级</small><b>${communicationLevelLabel(analysis.riskLevel)}</b></span><span><small>分析证据</small><b>${analysis.sourceMessageCount} 条</b></span></div>
      </div>
      <div class="communication-insight-grid">
        <div><h3>客户特点</h3><div class="communication-traits">${analysis.traits.length ? analysis.traits.map((trait) => `<span><b>${escapeHtml(trait.label)}</b><small>${escapeHtml(trait.value || "已识别")} · ${Math.round(trait.confidence * 100)}% 可信 · ${trait.evidenceMessageIds.length} 条证据</small></span>`).join("") : `<span class="is-empty">当前会话证据不足</span>`}</div></div>
        <div><h3>关键决策信号</h3><div class="communication-points">${analysis.keyPoints.length ? analysis.keyPoints.map((point) => `<span><i>✓</i>${escapeHtml(point)}</span>`).join("") : `<span>尚未提取到明确采购信号</span>`}</div></div>
      </div>` : `<div class="communication-insight-empty"><b>客户画像正在等待首次分析</b><span>周期分析任务会自动生成客户特点、风险和跟进建议。</span></div>`}
      <div class="communication-followup-block"><div class="communication-block-head"><div><h3>最近要跟进的事项</h3><p>即刻沟通建议与 GoodJob 待办统一呈现</p></div><b>${pending.length + unmatchedLinkedTodos.length}</b></div><div class="communication-followups">
        ${pending.map((item) => {
          const linkedTodo = relatedTodos.find((todo) => todoMatchesCommunicationFollowup(todo, customer, item));
          const buttonLabel = linkedTodo ? (linkedTodo.done ? "待办已完成" : "已加入待办") : "转为待办";
          return `<article class="priority-${item.priority}${linkedTodo ? " is-crm-todo" : ""}"><i></i><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(communicationDueLabel(item.dueAt))}</span><p>${escapeHtml(linkedTodo ? (linkedTodo.done ? "关联待办已完成" : "已进入 GoodJob 待办") : item.reason)}</p></div><button class="btn" type="button" data-communication-todo="${escapeHtml(item.id)}"${linkedTodo ? " disabled" : ""}>${buttonLabel}</button></article>`;
        }).join("")}
        ${unmatchedLinkedTodos.slice(0, 4).map((todo) => `<article class="is-crm-todo"><i></i><div><b>${escapeHtml(todo.title)}</b><span>${escapeHtml(communicationDueLabel(todo.dueAt))}</span><p>已进入 GoodJob 待办</p></div><em>CRM</em></article>`).join("")}
        ${pending.length + unmatchedLinkedTodos.length === 0 ? `<div class="communication-insight-empty compact"><b>暂无未完成事项</b><span>新消息完成分析后，行动建议会自动出现。</span></div>` : ""}
      </div></div>`;
    qsa<HTMLButtonElement>("[data-communication-todo]", box).forEach((button) => {
      const followup = pending.find((item) => item.id === button.dataset.communicationTodo);
      if (followup) button.addEventListener("click", () => void createCustomerCommunicationTodo(customer, followup, button));
    });
  } catch (error) {
    if (state.selectedCustomerId !== customer.id) return;
    box.innerHTML = `<div class="customer-page-section-head"><div><h2>WhatsApp 客户洞察</h2><p>实时会话、客户特点、风险与下一动作</p></div>${badge("暂不可用", "red")}</div><div class="communication-insight-empty"><b>即刻沟通数据读取失败</b><span>${escapeHtml(error instanceof Error ? error.message : "请稍后重试")}</span><button class="btn" type="button" data-communication-retry>重新读取</button></div>`;
    qs<HTMLButtonElement>("[data-communication-retry]", box)?.addEventListener("click", () => void loadCustomerCommunicationInsights(customer));
  }
}

export function openCustomerDetailPage(customer: Customer) {
  state.selectedCustomerId = customer.id;
  closeCustomerDrawer();
  activateNavView("customer-detail", () => renderCustomerDetailPage(customer));
}

function customerTimeZone(country = "") {
  const normalized = country.trim().toLowerCase();
  const zones: Record<string, string> = {
    中国: "Asia/Shanghai",
    china: "Asia/Shanghai",
    瑞典: "Europe/Stockholm",
    sweden: "Europe/Stockholm",
    美国: "America/New_York",
    usa: "America/New_York",
    "united states": "America/New_York",
    日本: "Asia/Tokyo",
    japan: "Asia/Tokyo",
    韩国: "Asia/Seoul",
    korea: "Asia/Seoul",
    "south korea": "Asia/Seoul",
    新加坡: "Asia/Singapore",
    singapore: "Asia/Singapore",
    越南: "Asia/Ho_Chi_Minh",
    vietnam: "Asia/Ho_Chi_Minh",
    泰国: "Asia/Bangkok",
    thailand: "Asia/Bangkok",
    马来西亚: "Asia/Kuala_Lumpur",
    malaysia: "Asia/Kuala_Lumpur",
    印尼: "Asia/Jakarta",
    indonesia: "Asia/Jakarta",
    阿联酋: "Asia/Dubai",
    uae: "Asia/Dubai",
    德国: "Europe/Berlin",
    germany: "Europe/Berlin",
    法国: "Europe/Paris",
    france: "Europe/Paris",
    意大利: "Europe/Rome",
    italy: "Europe/Rome",
    西班牙: "Europe/Madrid",
    spain: "Europe/Madrid",
    荷兰: "Europe/Amsterdam",
    netherlands: "Europe/Amsterdam",
    英国: "Europe/London",
    uk: "Europe/London",
    印度: "Asia/Kolkata",
    india: "Asia/Kolkata",
    澳大利亚: "Australia/Sydney",
    australia: "Australia/Sydney",
    土耳其: "Europe/Istanbul",
    turkey: "Europe/Istanbul",
    智利: "America/Santiago",
    chile: "America/Santiago",
    巴西: "America/Sao_Paulo",
    brazil: "America/Sao_Paulo",
    墨西哥: "America/Mexico_City",
    mexico: "America/Mexico_City",
    加拿大: "America/Toronto",
    canada: "America/Toronto",
    俄罗斯: "Europe/Moscow",
    russia: "Europe/Moscow",
    南非: "Africa/Johannesburg",
    "south africa": "Africa/Johannesburg",
    波兰: "Europe/Warsaw",
    poland: "Europe/Warsaw",
    比利时: "Europe/Brussels",
    belgium: "Europe/Brussels",
    奥地利: "Europe/Vienna",
    austria: "Europe/Vienna",
    瑞士: "Europe/Zurich",
    switzerland: "Europe/Zurich",
    丹麦: "Europe/Copenhagen",
    denmark: "Europe/Copenhagen",
    挪威: "Europe/Oslo",
    norway: "Europe/Oslo",
    芬兰: "Europe/Helsinki",
    finland: "Europe/Helsinki",
    葡萄牙: "Europe/Lisbon",
    portugal: "Europe/Lisbon",
    爱尔兰: "Europe/Dublin",
    ireland: "Europe/Dublin",
    捷克: "Europe/Prague",
    czechia: "Europe/Prague",
    新西兰: "Pacific/Auckland",
    "new zealand": "Pacific/Auckland",
    沙特: "Asia/Riyadh",
    saudi: "Asia/Riyadh",
    埃及: "Africa/Cairo",
    egypt: "Africa/Cairo",
    菲律宾: "Asia/Manila",
    philippines: "Asia/Manila",
    柬埔寨: "Asia/Phnom_Penh",
    cambodia: "Asia/Phnom_Penh",
    老挝: "Asia/Vientiane",
    laos: "Asia/Vientiane",
    缅甸: "Asia/Yangon",
    myanmar: "Asia/Yangon",
    巴基斯坦: "Asia/Karachi",
    pakistan: "Asia/Karachi",
    孟加拉国: "Asia/Dhaka",
    bangladesh: "Asia/Dhaka",
    斯里兰卡: "Asia/Colombo",
    sri_lanka: "Asia/Colombo",
    尼泊尔: "Asia/Kathmandu",
    nepal: "Asia/Kathmandu",
    哈萨克斯坦: "Asia/Almaty",
    kazakhstan: "Asia/Almaty",
    乌兹别克斯坦: "Asia/Tashkent",
    uzbekistan: "Asia/Tashkent",
    以色列: "Asia/Jerusalem",
    israel: "Asia/Jerusalem",
    约旦: "Asia/Amman",
    jordan: "Asia/Amman",
    黎巴嫩: "Asia/Beirut",
    lebanon: "Asia/Beirut",
    卡塔尔: "Asia/Qatar",
    qatar: "Asia/Qatar",
    科威特: "Asia/Kuwait",
    kuwait: "Asia/Kuwait",
    伊朗: "Asia/Tehran",
    iran: "Asia/Tehran",
    伊拉克: "Asia/Baghdad",
    iraq: "Asia/Baghdad",
    尼日利亚: "Africa/Lagos",
    nigeria: "Africa/Lagos",
    肯尼亚: "Africa/Nairobi",
    kenya: "Africa/Nairobi",
    摩洛哥: "Africa/Casablanca",
    morocco: "Africa/Casablanca",
    阿根廷: "America/Argentina/Buenos_Aires",
    argentina: "America/Argentina/Buenos_Aires",
    哥伦比亚: "America/Bogota",
    colombia: "America/Bogota",
    秘鲁: "America/Lima",
    peru: "America/Lima",
    委内瑞拉: "America/Caracas",
    venezuela: "America/Caracas",
    乌克兰: "Europe/Kyiv",
    ukraine: "Europe/Kyiv",
    罗马尼亚: "Europe/Bucharest",
    romania: "Europe/Bucharest",
    希腊: "Europe/Athens",
    greece: "Europe/Athens",
    匈牙利: "Europe/Budapest",
    hungary: "Europe/Budapest",
    斯洛伐克: "Europe/Bratislava",
    slovakia: "Europe/Bratislava",
    保加利亚: "Europe/Sofia",
    bulgaria: "Europe/Sofia",
    克罗地亚: "Europe/Zagreb",
    croatia: "Europe/Zagreb",
    塞尔维亚: "Europe/Belgrade",
    serbia: "Europe/Belgrade",
    冰岛: "Atlantic/Reykjavik",
    iceland: "Atlantic/Reykjavik",
    卢森堡: "Europe/Luxembourg",
    luxembourg: "Europe/Luxembourg",
    斯洛文尼亚: "Europe/Ljubljana",
    slovenia: "Europe/Ljubljana",
    爱沙尼亚: "Europe/Tallinn",
    estonia: "Europe/Tallinn",
    拉脱维亚: "Europe/Riga",
    latvia: "Europe/Riga",
    立陶宛: "Europe/Vilnius",
    lithuania: "Europe/Vilnius",
    白俄罗斯: "Europe/Minsk",
    belarus: "Europe/Minsk",
    蒙古: "Asia/Ulaanbaatar",
    mongolia: "Asia/Ulaanbaatar",
    中国香港: "Asia/Hong_Kong",
    "hong kong": "Asia/Hong_Kong",
    中国澳门: "Asia/Shanghai",
    macau: "Asia/Shanghai",
    macao: "Asia/Shanghai",
    中国台湾: "Asia/Shanghai",
    taiwan: "Asia/Shanghai"
  };
  return zones[normalized] || zones[country.trim()] || null;
}

function customerWorldTimeParts(country: string) {
  const timeZone = customerTimeZone(country);
  if (!timeZone) {
    return { time: "--:--", date: "时区未维护", timeZone: "未配置", dayPart: "未知", contactHint: "未维护该国家时区" };
  }
  const now = new Date();
  try {
    const time = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
    const date = new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      weekday: "short",
      month: "2-digit",
      day: "2-digit"
    }).format(now);
    const hourText = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hour12: false }).format(now);
    const hour = Number(hourText);
    const dayPart = hour >= 6 && hour < 12 ? "上午" : hour >= 12 && hour < 18 ? "下午" : hour >= 18 && hour < 22 ? "晚上" : "深夜";
    const contactHint = hour >= 8 && hour < 18 ? "适合联系" : hour >= 18 && hour < 22 ? "谨慎联系" : "建议预约";
    return { time, date, timeZone, dayPart, contactHint };
  } catch {
    return { time: now.toLocaleTimeString("zh-CN"), date: now.toLocaleDateString("zh-CN"), timeZone: "UTC", dayPart: "未知", contactHint: "待确认" };
  }
}

function renderCustomerWorldClock(customer: Customer) {
  const clock = qs<HTMLElement>("#customerWorldClock");
  const date = qs<HTMLElement>("#customerWorldDate");
  const zone = qs<HTMLElement>("#customerWorldZone");
  const status = qs<HTMLElement>("#customerWorldStatus");
  if (!clock || !date || !zone || !status) return;
  const parts = customerWorldTimeParts(customer.country);
  clock.textContent = parts.time;
  date.textContent = `${customer.country}当地 · ${parts.date}`;
  zone.textContent = parts.timeZone;
  status.textContent = `${parts.dayPart} · ${parts.contactHint}`;
}

function customerMeetingTriggerKey(customerId: string, activityId: string) {
  return `customer-meeting:${customerId}:${activityId}`;
}

function customerUpcomingMeeting(customer: Customer) {
  const activity = [...(customer.activities || [])]
    .filter((item) => item.type === "meeting"
      && !item.content.startsWith("【会议纪要】")
      && Boolean(item.nextReminder || /(约定|预约|安排|schedule|meeting on|周[一二三四五六日天]|星期[一二三四五六日天])/iu.test(item.content)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!activity) return null;
  const sections = activity.content.split(/[；;]/u).map((item) => item.trim()).filter(Boolean);
  const timeMatch = activity.content.match(/(?:周[一二三四五六日天]|星期[一二三四五六日天]|今天|明天|后天)(?:上午|下午|晚上)?\s*\d{1,2}(?::|：)\d{2}/u)
    || activity.content.match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b(?:\s+at)?\s+\d{1,2}:\d{2}/iu);
  const preparationSection = sections.find((item) => /(会前准备|提前准备|需提前)/u.test(item));
  const preparation = preparationSection
    ? preparationSection.replace(/^(?:会前准备|提前准备|需提前准备)[:：]?/u, "").trim()
    : "待补充会前准备清单";
  const reminderDate = activity.nextReminder ? new Date(activity.nextReminder) : null;
  const reminderText = reminderDate && !Number.isNaN(reminderDate.getTime()) ? formatDateTime(activity.nextReminder) : activity.nextReminder;
  return {
    activity,
    time: timeMatch?.[0] || reminderText || "时间待确认",
    subject: sections[0] || activity.content,
    preparation,
    linkedTodo: state.todos.find((todo) => todo.triggerKey === customerMeetingTriggerKey(customer.id, activity.id))
  };
}

function renderCustomerMeetingBrief(customer: Customer) {
  const meeting = customerUpcomingMeeting(customer);
  if (!meeting) return "";
  return `<section class="customer-meeting-brief">
    <div class="customer-meeting-brief-head"><div><span>关键安排</span><h3>客户会议</h3></div>${badge(meeting.linkedTodo ? "待办已创建" : "待准备", meeting.linkedTodo ? "green" : "amber")}</div>
    <div class="customer-meeting-brief-main">
      <div class="customer-meeting-time"><span>会议时间</span><strong>${escapeHtml(meeting.time)}</strong><small>以客户所在时区再次确认</small></div>
      <div class="customer-meeting-topic"><span>会议议题</span><b>${escapeHtml(meeting.subject)}</b><small>会前准备：${escapeHtml(meeting.preparation)}</small></div>
    </div>
    <div class="customer-meeting-brief-actions"><button class="btn primary" type="button" data-customer-meeting-todo="${escapeHtml(meeting.activity.id)}" ${meeting.linkedTodo ? "disabled" : ""}>${meeting.linkedTodo ? "已加入待办" : "生成会前待办"}</button></div>
  </section>`;
}

async function createCustomerMeetingTodo(customer: Customer, activityId: string, button: HTMLButtonElement) {
  const meeting = customerUpcomingMeeting(customer);
  if (!meeting || meeting.activity.id !== activityId) {
    toast("会议安排已更新，请重新打开客户详情", "error");
    return;
  }
  setButtonPending(button, true, "生成会前待办", "创建中");
  try {
    const result = await api<{ todo: Todo }>("/api/todos", {
      method: "POST",
      body: JSON.stringify({
        title: `准备客户会议：${customer.company}`,
        type: "customer",
        priority: "high",
        dueAt: meeting.activity.nextReminder || customer.nextReminder || currentDateTimeText(),
        related: `会议准备：${customer.company}；${meeting.preparation}`,
        customerId: customer.id,
        triggerKey: customerMeetingTriggerKey(customer.id, meeting.activity.id)
      })
    });
    if (!state.todos.some((todo) => todo.id === result.todo.id)) state.todos.unshift(result.todo);
    button.textContent = "已加入待办";
    button.disabled = true;
    const status = button.closest<HTMLElement>(".customer-meeting-brief")?.querySelector<HTMLElement>(".badge");
    if (status) {
      status.className = "badge green";
      status.textContent = "待办已创建";
    }
    updateTodoChips(state.todos);
    renderTopbarStats();
    toast("会前准备已加入 GoodJob 待办");
  } catch (error) {
    setButtonPending(button, false, "生成会前待办", "创建中");
    toast(error instanceof Error ? error.message : "会前待办创建失败", "error");
  }
}

export function renderCustomerDrawer(customer?: Customer) {
  const drawer = qs<HTMLElement>("#customerDrawer");
  if (!drawer || !customer) return;
  const contacts = customerContactDetails(customer);
  const billingName = customerDocumentName(customer);
  const billingAddress = customer.billingAddress || `${customer.country} / 地址待维护`;
  const documentContact = customer.documentContact || customer.contact;
  const portDischarge = customer.defaultPortDischarge || "待确认";
  const incoterm = customer.defaultIncoterm || "待维护";
  const paymentTerm = customer.defaultPaymentTerm || "待维护";
  const pipelineStage = customer.pipelineStage || "暂无活跃商机";
  const pipelineAmount = customer.pipelineAmount || 0;
  const activeDealCount = customer.activeDealCount || 0;
  drawer.innerHTML = `
    <div class="drawer-head">
      <div><h2>${escapeHtml(customer.company)}</h2><p>${escapeHtml(customer.country)} · ${escapeHtml(customer.contact)} · ${escapeHtml(customer.ownerName || "未分配")} · ${escapeHtml(pipelineStage)}</p></div>
      <div class="inline-actions">${customer.nextReminder.includes("逾期") ? badge("报价未回复", "red") : badge("跟进中", "green")}<button class="btn" type="button" data-open-customer-page>客户全景</button><button class="btn icon-only" id="customerDrawerClose" title="关闭" aria-label="关闭客户详情">×</button></div>
    </div>
    <section class="customer-time-card" aria-label="客户世界时间">
      <div>
        <span>客户世界时间</span>
        <strong id="customerWorldClock">--:--:--</strong>
        <small id="customerWorldDate">当地日期加载中</small>
      </div>
      <div class="customer-time-side">
        <b id="customerWorldStatus">待确认</b>
        <em id="customerWorldZone">UTC</em>
      </div>
    </section>
    <div class="score-card">
      <div class="score-ring"><span>${customer.health}</span></div>
      <div><b>健康度：${customer.health >= 80 ? "健康" : customer.health >= 60 ? "需保持" : "需关注"}</b></div>
    </div>
    <div class="info-grid">
      <div class="info"><span>健康度</span><b>${customer.health}%</b></div>
      <div class="info"><span>客户分级</span><b>${customerGradeValue(customer)} · ${customerGradeLabel(customerGradeValue(customer))}</b></div>
      <div class="info"><span>客户来源</span><b>${escapeHtml(customer.source || "未登记")}</b></div>
      <div class="info"><span>成交历史</span><b>${customer.hasWonDeal ? customerWonLabel(customer) : "尚未成交"}</b></div>
      <div class="info"><span>最高活跃阶段</span><b>${escapeHtml(pipelineStage)}</b></div>
      <div class="info"><span>活跃商机数</span><b>${activeDealCount}</b></div>
      <div class="info"><span>在手商机额</span><b>${money(pipelineAmount)}</b></div>
      <div class="info"><span>下一提醒</span><b>${escapeHtml(customer.nextReminder)}</b></div>
    </div>
    <section class="customer-doc-info">
      <div class="customer-deals-head"><h3>联系方式</h3><button class="btn" data-edit-customer-drawer>维护信息</button></div>
      <div class="info-grid">
        <div class="info"><span>主联系人</span><b>${escapeHtml(customer.contact || "待维护")}</b></div>
        <div class="info"><span>邮箱</span><b>${escapeHtml(contacts.email || "未维护")}</b></div>
        <div class="info"><span>电话</span><b>${escapeHtml(contacts.phone || "未维护")}</b></div>
        <div class="info"><span>WhatsApp</span><b>${contacts.whatsapp && whatsAppWebLink(contacts.whatsapp) ? `<a class="wa-web-link" href="${whatsAppWebLink(contacts.whatsapp)}" target="_blank" rel="noopener noreferrer">${escapeHtml(contacts.whatsapp)}</a>` : escapeHtml(contacts.whatsapp || "未维护")}</b></div>
        <div class="info"><span>微信</span><b>${escapeHtml(contacts.wechat || "未维护")}</b></div>
        <div class="info"><span>官网</span><b>${escapeHtml(customer.website || "未维护")}</b></div>
        <div class="info"><span>其它渠道</span><b>${escapeHtml(customer.contactRemark || "未维护")}</b></div>
        <div class="info"><span>其它说明</span><b>${escapeHtml(customer.otherNotes || "未维护")}</b></div>
      </div>
    </section>
    <div class="inline-actions"><button class="${whatsAppEntryClass(contacts.whatsapp)}" data-customer-whatsapp-drawer ${whatsAppEntryAttrs(contacts.whatsapp)}>WhatsApp</button><button class="btn primary ai-entry-button" data-customer-research>${researchButtonIcon()}AI 背调</button><button class="btn" data-customer-email>写开发信</button><button class="btn" data-customer-journey-drawer>开发信过程</button><button class="btn" data-customer-meeting><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2"/><path d="M12 19v3"/></svg>录制会议</button><button class="btn" data-add-follow>新增跟进记录</button><button class="btn" data-edit-customer-drawer>编辑客户</button><button class="btn" data-customer-release-drawer>放入公池</button></div>
    ${renderCustomerMeetingBrief(customer)}
    ${renderCustomerIntelligence(customer)}
    <section class="customer-communication-drawer" id="customerCommunicationDrawerInsights">
      <div class="customer-deals-head"><h3>WhatsApp 行动摘要</h3><small>只读同步</small></div>
      <div class="communication-drawer-loading">正在读取客户会话...</div>
    </section>
    <section class="customer-doc-info">
      <div class="customer-deals-head"><h3>单据基础信息</h3><button class="btn" data-edit-customer-document-info>维护信息</button></div>
      <div class="info-grid">
        <div class="info"><span>单据抬头</span><b>${escapeHtml(billingName)}</b></div>
        <div class="info"><span>单据联系人</span><b>${escapeHtml(documentContact)}</b></div>
        <div class="info"><span>目的港</span><b>${escapeHtml(portDischarge)}</b></div>
        <div class="info"><span>贸易条款</span><b>${escapeHtml(incoterm)}</b></div>
      </div>
      <div class="timeline-item"><b>账单地址</b><span>${escapeHtml(billingAddress)}</span></div>
      <div class="timeline-item"><b>付款条款</b><span>${escapeHtml(paymentTerm)}</span></div>
    </section>
    <div class="journey-timeline-section">
      <div class="section-head" style="margin-bottom:8px"><div><h3>客户旅程</h3></div></div>
      <div id="customerJourneyTimeline"><div style="padding:12px;text-align:center;color:var(--muted);font-size:12px;">加载中...</div></div>
    </div>
    <details class="timeline-details">
      <summary class="timeline-details-summary">完整跟进记录 (${(customer.activities || []).length})</summary>
      <div class="timeline">
        ${(customer.activities || []).length ? (customer.activities || []).map((activity) => `<div class="timeline-item"><b>${escapeHtml(customerActivityLabel(activity.type))}</b><span>${escapeHtml(activity.content)}</span><small>${escapeHtml(activity.operatorName || "未知操作人")} · ${escapeHtml(formatDateTime(activity.createdAt))}${activity.nextReminder ? ` · 下次：${escapeHtml(activity.nextReminder)}` : ""}</small></div>`).join("") : `<div class="timeline-item"><b>暂无跟进记录</b></div>`}
      </div>
    </details>
    ${renderCustomerDealProgress(customer)}
    ${renderCustomerOrders(customer)}
  `;
  if (customerClockTimer) window.clearInterval(customerClockTimer);
  renderCustomerWorldClock(customer);
  customerClockTimer = window.setInterval(() => renderCustomerWorldClock(customer), 1000);
  void renderCustomerJourney(customer);
  void loadCustomerOrders(customer);
  void loadCustomerCommunicationDrawerInsights(customer);
  qs("#customerDrawerClose", drawer)?.addEventListener("click", closeCustomerDrawer);
  qs<HTMLButtonElement>("[data-open-customer-page]", drawer)?.addEventListener("click", () => openCustomerDetailPage(customer));
  qs<HTMLButtonElement>("[data-customer-whatsapp-drawer]", drawer)?.addEventListener("click", () => {
    void openWhatsAppForContact({ phone: customerContactDetails(customer).whatsapp, displayName: customer.contact || customer.company });
  });
  qs<HTMLButtonElement>("[data-customer-release-drawer]", drawer)?.addEventListener("click", () => openCustomerReleaseModal(customer));
  qs<HTMLButtonElement>("[data-customer-research]", drawer)?.addEventListener("click", () => openBackgroundResearch("customer", customer.id, customer.company, "customers"));
  qs<HTMLButtonElement>("[data-customer-email]", drawer)?.addEventListener("click", () => openDevelopmentEmail("customer", customer.id, customer.company, "customers", customerContactDetails(customer).whatsapp));
  qs<HTMLButtonElement>("[data-customer-meeting]", drawer)?.addEventListener("click", () => openMeetingRecorder(customer));
  qs<HTMLButtonElement>("[data-customer-meeting-todo]", drawer)?.addEventListener("click", (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    void createCustomerMeetingTodo(customer, button.dataset.customerMeetingTodo || "", button);
  });
  qs<HTMLButtonElement>("[data-add-follow]", drawer)?.addEventListener("click", () => addFollowRecord(customer));
  qs<HTMLButtonElement>("[data-customer-journey-drawer]", drawer)?.addEventListener("click", () =>
    void openOutreachCustomerJourney("customer", customer.id, customer.company, "customer-drawer"));
  qsa<HTMLButtonElement>("[data-edit-customer-drawer]", drawer).forEach((button) => {
    button.addEventListener("click", () => openCustomerModal(customer));
  });
  qsa<HTMLButtonElement>("[data-edit-customer-document-info]", drawer).forEach((button) => {
    button.addEventListener("click", () => openCustomerModal(customer));
  });
  qsa<HTMLButtonElement>("[data-accept-customer-intelligence]", drawer).forEach((button) => {
    button.addEventListener("click", () => void acceptCustomerIntelligenceSuggestion(
      customer,
      button.dataset.acceptCustomerIntelligence || "",
      button
    ));
  });
  qsa<HTMLButtonElement>("[data-reject-customer-intelligence]", drawer).forEach((button) => {
    button.addEventListener("click", () => openCustomerIntelligenceRejectModal(
      customer,
      button.dataset.rejectCustomerIntelligence || "",
      button
    ));
  });
  qs<HTMLButtonElement>("[data-view-related-deals]", drawer)?.addEventListener("click", () => activateNavView("pipeline"));
  qs<HTMLButtonElement>("[data-customer-orders-all]", drawer)?.addEventListener("click", () => {
    closeCustomerDrawer();
    activateNavView("orders");
  });
}

function renderCustomerIntelligence(customer: Customer) {
  const suggestions = customer.pendingIntelligence || [];
  if (!suggestions.length) return "";
  const canReview = customer.ownerId === state.user?.id;
  return `<section class="customer-intelligence">
    <div class="customer-deals-head">
      <h3>待采纳情报 <span>${suggestions.length}</span></h3>
      <small>${canReview ? "人工核对后更新客户资料" : "由归属业务员处理"}</small>
    </div>
    <div class="customer-intelligence-list">
      ${suggestions.map((suggestion) => {
        const facts = [
          suggestion.website ? `官网：${suggestion.website}` : "",
          suggestion.business ? `业务：${suggestion.business}` : "",
          suggestion.contactInfo ? `联系：${suggestion.contactInfo}` : ""
        ].filter(Boolean);
        return `<article class="customer-intelligence-item" data-customer-intelligence-id="${escapeHtml(suggestion.id)}">
          <div class="customer-intelligence-source">
            <b>${escapeHtml(suggestion.sourceLabel || "智能获客")}</b>
            <time>${escapeHtml(formatDateTime(suggestion.createdAt))}</time>
          </div>
          <p>${escapeHtml(suggestion.evidenceSummary || "发现新的客户资料")}</p>
          ${facts.length ? `<div class="customer-intelligence-facts">${facts.map((fact) => `<span>${escapeHtml(fact)}</span>`).join("")}</div>` : ""}
          ${suggestion.suggestedFields.length ? `<div class="customer-intelligence-fields">${suggestion.suggestedFields.map((field) => `
            <label>
              <input type="checkbox" data-intelligence-field="${escapeHtml(field.key)}" checked ${canReview ? "" : "disabled"}>
              <span><b>${escapeHtml(field.label)}</b><small>${escapeHtml(field.currentValue || "空")} → ${escapeHtml(field.suggestedValue)}</small></span>
            </label>
          `).join("")}</div>` : `<div class="customer-intelligence-evidence">本条仅补充来源证据，不改客户主档。</div>`}
          <div class="customer-intelligence-actions">
            <button class="btn" data-reject-customer-intelligence="${escapeHtml(suggestion.id)}" ${canReview ? "" : "disabled"}>忽略</button>
            <button class="btn primary" data-accept-customer-intelligence="${escapeHtml(suggestion.id)}" ${canReview ? "" : "disabled"}>采纳所选</button>
          </div>
        </article>`;
      }).join("")}
    </div>
  </section>`;
}

async function loadCustomerCommunicationDrawerInsights(customer: Customer) {
  const box = qs<HTMLElement>("#customerCommunicationDrawerInsights");
  if (!box || state.selectedCustomerId !== customer.id) return;
  const phone = normalizeWhatsAppPhone(customerContactDetails(customer).whatsapp);
  if (!phone) {
    box.innerHTML = `<div class="customer-deals-head"><h3>WhatsApp 行动摘要</h3>${badge("待绑定号码", "gray")}</div><div class="communication-drawer-empty">补充 WhatsApp 号码后，客户画像和跟进建议会自动出现在这里。</div>`;
    return;
  }
  try {
    const conversations = await whatsappPluginRequest<WhatsAppPluginConversation[]>("/v1/conversations");
    const conversation = conversations.find((item) => normalizeWhatsAppPhone(item.contactPhone) === phone);
    if (!conversation) {
      box.innerHTML = `<div class="customer-deals-head"><h3>WhatsApp 行动摘要</h3>${badge("等待首条消息", "gray")}</div><div class="communication-drawer-empty">尚未收到该客户的 WhatsApp 消息。Meta 入站后会自动更新这里。</div>`;
      return;
    }
    const insight = await whatsappPluginRequest<WhatsAppConversationInsight>(`/v1/conversations/${encodeURIComponent(conversation.id)}/intelligence`);
    const analysis = insight.analysis;
    const pending = insight.followups.filter((item) => item.status === "pending");
    box.innerHTML = `<div class="customer-deals-head"><h3>WhatsApp 行动摘要</h3><span class="communication-drawer-live"><i></i>已同步</span></div>${analysis ? `<div class="communication-drawer-command"><span>下一动作</span><b>${escapeHtml(analysis.nextAction)}</b><p>${escapeHtml(analysis.summary)}</p></div><div class="communication-drawer-metrics"><span>意向 <b>${communicationLevelLabel(analysis.buyingIntent)}</b></span><span>风险 <b>${communicationLevelLabel(analysis.riskLevel)}</b></span><span>待跟进 <b>${pending.length}</b></span></div>${pending.slice(0, 3).map((item) => `<div class="communication-drawer-followup"><i class="priority-${item.priority}"></i><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(communicationDueLabel(item.dueAt))}</small></span></div>`).join("")}` : `<div class="communication-drawer-empty">会话已同步，周期分析尚未生成。分析完成后会显示客户特点和下一动作。</div>`}`;
  } catch (error) {
    box.innerHTML = `<div class="customer-deals-head"><h3>WhatsApp 行动摘要</h3>${badge("暂不可用", "red")}</div><div class="communication-drawer-empty">${escapeHtml(error instanceof Error ? error.message : "暂时无法读取即刻沟通")}</div>`;
  }
}

async function acceptCustomerIntelligenceSuggestion(
  customer: Customer,
  suggestionId: string,
  button: HTMLButtonElement
) {
  const card = button.closest<HTMLElement>("[data-customer-intelligence-id]");
  if (!card || !suggestionId) return;
  const selectedFields = qsa<HTMLInputElement>(
    "[data-intelligence-field]:checked",
    card
  ).map((input) => input.dataset.intelligenceField as CustomerIntelligenceFieldKey);
  try {
    button.disabled = true;
    button.textContent = "采纳中";
    const result = await api<{ customer: Customer }>(
      `/api/customer-intelligence/${encodeURIComponent(suggestionId)}/accept`,
      {
        method: "POST",
        body: JSON.stringify({ selectedFields })
      }
    );
    state.customers = state.customers.map((item) =>
      item.id === customer.id ? result.customer : item
    );
    renderCustomers(state.customers);
    renderCustomerDrawer(result.customer);
    toast(selectedFields.length ? "客户资料已按所选字段更新" : "来源证据已记入客户时间线");
  } catch (error) {
    button.disabled = false;
    button.textContent = "采纳所选";
    toast(error instanceof Error ? error.message : "采纳客户情报失败", "error");
  }
}

function openCustomerIntelligenceRejectModal(
  customer: Customer,
  suggestionId: string,
  sourceButton: HTMLButtonElement
) {
  if (!suggestionId) return;
  const suggestion = customer.pendingIntelligence?.find((item) => item.id === suggestionId);
  openModal("忽略客户情报", `
    <div class="form-field full"><label>情报来源</label><input value="${escapeHtml(suggestion?.sourceLabel || "智能获客")}" disabled></div>
    <div class="form-field full"><label>忽略原因</label><textarea id="customerIntelligenceRejectReason" rows="4" placeholder="可选，例如：来源过旧、主体不匹配或已有更可靠资料"></textarea><small>原因会保留在情报审核记录中，便于后续复盘。</small></div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn warning" id="confirmCustomerIntelligenceRejectButton">确认忽略</button>`);
  qs<HTMLButtonElement>("#confirmCustomerIntelligenceRejectButton")?.addEventListener("click", (event) => void rejectCustomerIntelligenceSuggestion(
    customer,
    suggestionId,
    qs<HTMLTextAreaElement>("#customerIntelligenceRejectReason")?.value.trim() || "",
    event.currentTarget as HTMLButtonElement,
    sourceButton
  ));
}

async function rejectCustomerIntelligenceSuggestion(
  customer: Customer,
  suggestionId: string,
  reason: string,
  button: HTMLButtonElement,
  sourceButton: HTMLButtonElement
) {
  setButtonPending(button, true, "确认忽略", "处理中");
  try {
    const result = await api<{ customer: Customer }>(
      `/api/customer-intelligence/${encodeURIComponent(suggestionId)}/reject`,
      {
        method: "POST",
        body: JSON.stringify({ reason })
      }
    );
    closeModal();
    state.customers = state.customers.map((item) =>
      item.id === customer.id ? result.customer : item
    );
    renderCustomers(state.customers);
    renderCustomerDrawer(result.customer);
    toast("该条客户情报已忽略");
  } catch (error) {
    setButtonPending(button, false, "确认忽略", "处理中");
    sourceButton.disabled = false;
    toast(error instanceof Error ? error.message : "忽略客户情报失败", "error");
  }
}

function customerActivityLabel(type: string) {
  const labels: Record<string, string> = { call: "电话", email: "邮件", whatsapp: "WhatsApp", wechat: "微信", meeting: "会议", note: "备注" };
  return labels[type] || "跟进";
}

/* 客户旅程节点详情浮层。
 *
 * 浮层刻意挂在 <body> 上而不是节点内部：.journey-track 是横向滚动容器
 * （overflow-x: auto），浏览器会把它的 overflow-y 由 visible 强制计算成 auto，
 * 于是向上溢出的浮层会被整块裁掉（实测浮层高 94px，只有底部 12px 可见）。
 * 挂到 body + fixed 定位可以完全绕开这层裁切。 */
let journeyTooltipEl: HTMLElement | null = null;
let journeyTooltipGlobalsBound = false;

function ensureJourneyTooltip() {
  if (!journeyTooltipEl || !journeyTooltipEl.isConnected) {
    journeyTooltipEl = document.createElement("div");
    journeyTooltipEl.className = "journey-tooltip";
    document.body.appendChild(journeyTooltipEl);
  }
  return journeyTooltipEl;
}

function hideJourneyTooltip() {
  journeyTooltipEl?.classList.remove("visible");
}

function showJourneyTooltip(node: HTMLElement) {
  const label = node.dataset.label || "";
  const detail = node.dataset.detail || "";
  const date = node.dataset.date || "";
  if (!label && !detail) return;
  const tooltip = ensureJourneyTooltip();
  tooltip.innerHTML = `<b>${escapeHtml(label)}</b>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}${date ? `<small>${escapeHtml(date)}</small>` : ""}`;

  const anchor = (node.querySelector(".journey-dot") || node).getBoundingClientRect();
  const half = tooltip.offsetWidth / 2;
  const centerX = anchor.left + anchor.width / 2;
  // 贴住视口左右边缘时把浮层收回来，否则会被视口裁掉。
  tooltip.style.left = `${Math.round(Math.min(Math.max(centerX, half + 8), window.innerWidth - half - 8))}px`;
  // 上方空间不足时翻到节点下方，避免浮层顶到视口外。
  const above = anchor.top - 8;
  if (above - tooltip.offsetHeight >= 4) {
    tooltip.style.transform = "translate(-50%, -100%)";
    tooltip.style.top = `${Math.round(above)}px`;
  } else {
    tooltip.style.transform = "translate(-50%, 0)";
    tooltip.style.top = `${Math.round(anchor.bottom + 8)}px`;
  }
  tooltip.classList.add("visible");
}

function bindJourneyTooltipGlobals() {
  if (journeyTooltipGlobalsBound) return;
  journeyTooltipGlobalsBound = true;
  // 滚动 / 缩放后浮层的 fixed 坐标会失效，直接收起，避免停在错位的地方。
  window.addEventListener("scroll", hideJourneyTooltip, true);
  window.addEventListener("resize", hideJourneyTooltip);
}

/* 客户旅程节点图标（线性描边，24×24）。
 *
 * 为什么不用 emoji：emoji 是彩色位图，会盖掉节点自身的 --node-color，
 * 且形状/基线在不同系统字体下不一致 —— 整条时间轴看着像贴了一排贴纸。
 * 描边图标用 currentColor 取色，颜色完全由节点语义决定，粗细也统一。
 *
 * 表要覆盖两类 type：客户跟进（customerActivityLabel 的 6 种）与
 * 商机事件（dealEventLabel 的 12 种）。**任一遗漏都会静默退化成同一个图标** ——
 * 此前 updated / stage / follow_up / payment / document / archived 六种就没登记，
 * 商机时间轴上一眼全是「备注」图标。
 */
const JOURNEY_GLYPHS: Record<string, string> = {
  users: '<path d="M16 20v-1.5a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4V20"/><circle cx="9.5" cy="7.5" r="3.5"/><path d="M21 20v-1.5a4 4 0 0 0-3-3.87"/><path d="M15.5 4.1a3.5 3.5 0 0 1 0 7"/>',
  pencil: '<path d="M4 20h4L19.5 8.5a2.12 2.12 0 0 0-3-3L5 17z"/><path d="m14.5 6.5 3 3"/>',
  plusCircle: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.5v7M8.5 12h7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  flag: '<path d="M5 3v18"/><path d="M5 4h13l-2.5 4L18 12H5"/>',
  calendarCheck: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M8 3v4M16 3v4M3.5 9.5h17"/><path d="m9.5 14.5 1.8 1.8 3.6-3.8"/>',
  tag: '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  package: '<path d="M20.5 7.8v8.4a2 2 0 0 1-1 1.74l-6.5 3.7a2 2 0 0 1-2 0l-6.5-3.7a2 2 0 0 1-1-1.74V7.8a2 2 0 0 1 1-1.74l6.5-3.7a2 2 0 0 1 2 0l6.5 3.7a2 2 0 0 1 1 1.74Z"/><path d="m3.6 6.9 8.4 4.8 8.4-4.8"/><path d="M12 21.5v-9.8"/>',
  exchange: '<path d="M4 8h13l-3.5-3.5"/><path d="M20 16H7l3.5 3.5"/>',
  banknote: '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>',
  file: '<path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8z"/><path d="M14 3v5h5"/><path d="M9 13.5h6M9 17h4"/>',
  trophy: '<path d="M6 3h12v6a6 6 0 0 1-12 0z"/><path d="M6 5H4.2a1.8 1.8 0 0 0 0 3.6H6"/><path d="M18 5h1.8a1.8 1.8 0 0 1 0 3.6H18"/><path d="M12 15v4"/><path d="M8 21h8"/>',
  xCircle: '<circle cx="12" cy="12" r="8.5"/><path d="m14.8 9.2-5.6 5.6M9.2 9.2l5.6 5.6"/>',
  archive: '<rect x="3" y="4" width="18" height="4.5" rx="1.2"/><path d="M5 8.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5"/><path d="M10 12.5h4"/>'
};

function journeyGlyph(name: string) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${JOURNEY_GLYPHS[name] || JOURNEY_GLYPHS.pencil}</svg>`;
}

/**
 * 「跟进/旅程 → 查看对话」弹层：从 CRM 后端代理读插件会话库里的当天文字版。
 * 原文不落 CRM 库，所以这里是**按需拉取**——图标点了才请求，拉不到就如实说原因。
 */
async function openWhatsappTranscriptModal(activityId: string, contactName: string) {
  openModal(`对话记录 · ${contactName}`, `<div style="padding:24px;text-align:center;color:var(--muted);font-size:13px;">正在读取对话文字版…</div>`, `<button class="btn" type="button" data-modal-close>关闭</button>`);
  try {
    const transcript = await api<{ runDate: string; timezone: string; contactName: string; contactPhone: string; messages: Array<{ direction: "inbound" | "outbound"; occurredAt: string; body: string; kind: string }> }>(`/api/whatsapp/followup-transcript/${encodeURIComponent(activityId)}`);
    const bubbles = transcript.messages.map((message) => {
      const outbound = message.direction === "outbound";
      const time = Number.isFinite(Date.parse(message.occurredAt)) ? new Date(message.occurredAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
      return `<div style="display:flex;justify-content:${outbound ? "flex-end" : "flex-start"};">
        <div style="max-width:78%;padding:8px 12px;border-radius:12px;${outbound ? "background:var(--brand);color:#fff;border-bottom-right-radius:4px;" : "background:var(--surface);border:1px solid var(--border);border-bottom-left-radius:4px;"} font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;">${escapeHtml(message.body)}</div>
      </div>
      <div style="font-size:11px;color:var(--muted);text-align:${outbound ? "right" : "left"};margin-top:-6px;">${time}${outbound ? " · 我方" : ""}</div>`;
    }).join("");
    const body = `
      <div style="font-size:12px;color:var(--muted);margin-bottom:12px;">同步日期 ${escapeHtml(transcript.runDate)}（${escapeHtml(transcript.timezone)}） · ${transcript.messages.length} 条消息 · 附件以 [文件] 占位，媒体内容不在文字版里</div>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:52vh;overflow:auto;padding:4px 6px;">${bubbles || `<div style="text-align:center;color:var(--muted);padding:24px;">这一天没有可显示的消息</div>`}</div>`;
    openModal(`对话记录 · ${contactName}`, body, `<button class="btn" type="button" data-modal-close>关闭</button>`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取失败";
    openModal(`对话记录 · ${contactName}`, `<div style="padding:24px;text-align:center;color:var(--danger);font-size:13px;">${escapeHtml(message)}</div>`, `<button class="btn" type="button" data-modal-close>关闭</button>`);
  }
}

/** WhatsApp 自动同步的跟进才有对话原文可看（手工写的 WhatsApp 跟进没有会话导入）。 */
function activityHasTranscript(activity: { type: string; content: string }): boolean {
  return activity.type === "whatsapp" && activity.content.startsWith("[WhatsApp 自动同步");
}

function renderCustomerJourney(customer: Customer, host?: HTMLElement | null) {
  // 容器可传入：客户全景页与客户抽屉各自持有自己的时间轴节点，
  // 两块 DOM 可能同时挂在文档里，绝不能共用一个全局 id 去查找。
  const container = host || qs<HTMLElement>("#customerJourneyTimeline");
  if (!container) return;
  bindJourneyTooltipGlobals();
  const activities = customer.activities || [];
  const deals = customerRelatedDeals(customer);
  const dealEvents = state.dealEvents.filter((e) => deals.some((d) => d.id === e.dealId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  type JourneyNode = { type: string; icon: string; label: string; date: string; detail: string; color: string; activityId: string; hasTranscript: boolean };
  const nodes: JourneyNode[] = [];

  // 联系类四个渠道直接复用全站唯一的 customerContactIcon()，保证同一个 WhatsApp
  // 在联系方式条与旅程里长得一样；其余用 journeyGlyph()。
  const journeyIcons: Record<string, { icon: string; color: string }> = {
    call: { icon: customerContactIcon("phone"), color: "var(--brand)" },
    email: { icon: customerContactIcon("email"), color: "var(--amber)" },
    whatsapp: { icon: customerContactIcon("whatsapp"), color: "var(--green)" },
    wechat: { icon: customerContactIcon("wechat"), color: "var(--aqua)" },
    meeting: { icon: journeyGlyph("users"), color: "var(--brand)" },
    note: { icon: journeyGlyph("pencil"), color: "var(--muted)" },
    created: { icon: journeyGlyph("plusCircle"), color: "var(--aqua)" },
    updated: { icon: journeyGlyph("refresh"), color: "var(--muted)" },
    stage: { icon: journeyGlyph("flag"), color: "var(--brand)" },
    follow_up: { icon: journeyGlyph("calendarCheck"), color: "var(--brand)" },
    quote: { icon: journeyGlyph("tag"), color: "var(--amber)" },
    sample: { icon: journeyGlyph("package"), color: "var(--rose)" },
    negotiation: { icon: journeyGlyph("exchange"), color: "var(--brand)" },
    payment: { icon: journeyGlyph("banknote"), color: "var(--green)" },
    document: { icon: journeyGlyph("file"), color: "var(--amber)" },
    won: { icon: journeyGlyph("trophy"), color: "var(--green)" },
    lost: { icon: journeyGlyph("xCircle"), color: "var(--rose)" },
    archived: { icon: journeyGlyph("archive"), color: "var(--muted)" }
  };

  for (const activity of activities) {
    const config = journeyIcons[activity.type] || journeyIcons.note;
    nodes.push({ type: activity.type, icon: config.icon, label: customerActivityLabel(activity.type), date: activity.createdAt, detail: activity.content, color: config.color, activityId: activity.id || "", hasTranscript: activityHasTranscript(activity) });
  }
  for (const event of dealEvents) {
    const config = journeyIcons[event.type] || journeyIcons.note;
    const deal = deals.find((d) => d.id === event.dealId);
    nodes.push({ type: event.type, icon: config.icon, label: dealEventLabel(event.type), date: event.createdAt, detail: `${deal?.title || ""}: ${event.content}`, color: config.color, activityId: "", hasTranscript: false });
  }
  nodes.sort((a, b) => a.date.localeCompare(b.date));

  if (nodes.length === 0) {
    hideJourneyTooltip();
    container.innerHTML = `<div style="padding:16px;text-align:center;color:var(--muted);font-size:12px;">暂无旅程数据</div>`;
    return;
  }

  const maxNodes = 12;
  const displayNodes = nodes.length > maxNodes ? nodes.slice(-maxNodes) : nodes;
  container.innerHTML = `
    <div class="journey-track">
      <div class="journey-line"></div>
      ${displayNodes.map((node, index) => `
        <div class="journey-node${index === displayNodes.length - 1 ? " is-latest" : ""}" style="--delay:${index * 0.12}s" data-label="${escapeHtml(node.label)}" data-detail="${escapeHtml(node.detail)}" data-date="${escapeHtml(formatDateTime(node.date))}"${node.hasTranscript && node.activityId ? ` data-transcript-activity="${escapeHtml(node.activityId)}" data-transcript-name="${escapeHtml(customer.contact || customer.company)}" title="点击查看当天对话记录"` : ""}>
          <div class="journey-dot" style="--node-color:${node.color}">${node.icon}</div>
          <span class="journey-label">${escapeHtml(node.label)}</span>
          <span class="journey-date">${escapeHtml(node.date.slice(5, 10))}</span>
        </div>
      `).join("")}
    </div>`;
  qsa<HTMLElement>(".journey-node", container).forEach((node) => {
    node.addEventListener("mouseenter", () => showJourneyTooltip(node));
    node.addEventListener("mouseleave", hideJourneyTooltip);
    const transcriptId = node.dataset.transcriptActivity;
    if (transcriptId) {
      node.style.cursor = "pointer";
      node.addEventListener("click", () => void openWhatsappTranscriptModal(transcriptId, node.dataset.transcriptName || "客户"));
    }
  });
  requestAnimationFrame(() => {
    qsa<HTMLElement>(".journey-node", container).forEach((node) => node.classList.add("visible"));
  });
}

let meetingRecognition: any = null;
let meetingTranscript = "";

function openMeetingRecorder(customer: Customer) {
  meetingTranscript = "";
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SR) {
    toast("当前浏览器不支持语音识别，请使用 Chrome/Edge 浏览器");
    return;
  }
  openModal("录制会议纪要", `
    <div class="meeting-recorder">
      <div class="meeting-info">
        <span>客户：${escapeHtml(customer.company)}</span>
        <span>${escapeHtml(customer.contact)}</span>
      </div>
      <div class="meeting-mic-section" id="meetingMicSection">
        <button class="btn primary meeting-mic-btn" id="meetingMicBtn">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2"/><path d="M12 19v3"/></svg>
          <span>开始录音</span>
        </button>
        <span class="meeting-status" id="meetingStatus">点击按钮开始录音</span>
      </div>
      <div class="meeting-transcript-wrap" id="meetingTranscriptWrap" style="display:none">
        <label>实时转写</label>
        <div class="meeting-transcript" id="meetingTranscript"></div>
      </div>
      <div class="meeting-actions" id="meetingActions" style="display:none">
        <button class="btn" id="meetingStopBtn">停止录音</button>
        <button class="btn primary" id="meetingSummarizeBtn" disabled>AI 生成纪要</button>
      </div>
      <div class="meeting-result" id="meetingResult"></div>
    </div>
  `, `<button class="btn" data-modal-close>关闭</button>`);

  const micBtn = qs<HTMLButtonElement>("#meetingMicBtn");
  const status = qs<HTMLElement>("#meetingStatus");
  const transcriptWrap = qs<HTMLElement>("#meetingTranscriptWrap");
  const transcriptDiv = qs<HTMLElement>("#meetingTranscript");
  const actionsDiv = qs<HTMLElement>("#meetingActions");
  const stopBtn = qs<HTMLButtonElement>("#meetingStopBtn");
  const summarizeBtn = qs<HTMLButtonElement>("#meetingSummarizeBtn");

  micBtn?.addEventListener("click", () => {
    meetingRecognition = new SR();
    meetingRecognition.lang = "zh-CN";
    meetingRecognition.continuous = true;
    meetingRecognition.interimResults = true;
    meetingRecognition.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          meetingTranscript += transcript;
        } else {
          interim += transcript;
        }
      }
      if (transcriptDiv) transcriptDiv.innerHTML = `${escapeHtml(meetingTranscript)} <span style="color:var(--muted)">${escapeHtml(interim)}</span>`;
    };
    meetingRecognition.onerror = (event: any) => {
      if (status) status.textContent = `录音错误: ${event.error}`;
    };
    meetingRecognition.onend = () => {
      if (status) status.textContent = "录音已停止";
      if (summarizeBtn) summarizeBtn.disabled = !meetingTranscript.trim();
    };
    meetingRecognition.start();
    if (micBtn) micBtn.style.display = "none";
    if (status) status.textContent = "录音中...";
    if (transcriptWrap) transcriptWrap.style.display = "block";
    if (actionsDiv) actionsDiv.style.display = "flex";
  });

  stopBtn?.addEventListener("click", () => {
    if (meetingRecognition) meetingRecognition.stop();
  });

  summarizeBtn?.addEventListener("click", () => void summarizeMeeting(customer));
}

async function summarizeMeeting(customer: Customer) {
  const resultDiv = qs<HTMLElement>("#meetingResult");
  const summarizeBtn = qs<HTMLButtonElement>("#meetingSummarizeBtn");
  if (!resultDiv || !meetingTranscript.trim()) return;
  if (summarizeBtn) { summarizeBtn.disabled = true; summarizeBtn.textContent = "AI 分析中..."; }
  resultDiv.innerHTML = `<div style="padding:16px;text-align:center;color:var(--muted);font-size:12px;">AI 正在分析会议内容...</div>`;
  try {
    const result = await api<{ summary: string; actionItems: string[]; keyPoints: string[]; activityId: string }>("/api/customers/" + encodeURIComponent(customer.id) + "/meeting-notes", {
      method: "POST",
      body: JSON.stringify({ transcript: meetingTranscript })
    });
    resultDiv.innerHTML = `
      <div class="meeting-note-card">
        <div class="meeting-note-section">
          <h4>会议摘要</h4>
          <p>${escapeHtml(result.summary)}</p>
        </div>
        ${result.keyPoints.length ? `<div class="meeting-note-section"><h4>关键要点</h4><ul>${result.keyPoints.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul></div>` : ""}
        ${result.actionItems.length ? `<div class="meeting-note-section"><h4>行动项（已自动创建待办）</h4><ul>${result.actionItems.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul></div>` : ""}
        <div class="meeting-note-footer">
          <span>已保存为客户跟进记录</span>
          ${result.actionItems.length ? "<span>已创建待办事项</span>" : ""}
        </div>
      </div>`;
    if (summarizeBtn) summarizeBtn.style.display = "none";
    state.customers = state.customers.map((c) => {
      if (c.id !== customer.id) return c;
      const updated = { ...c, activities: [{ id: result.activityId, customerId: c.id, type: "meeting", content: `【会议纪要】${result.summary}`, operatorId: state.user?.id || "", operatorName: state.user?.name || "我", nextReminder: "", createdAt: new Date().toISOString() }, ...(c.activities || [])] };
      return updated;
    });
    const updatedCustomer = state.customers.find((c) => c.id === customer.id);
    if (updatedCustomer) renderCustomerDrawer(updatedCustomer);
  } catch (err) {
    resultDiv.innerHTML = `<div style="padding:12px;color:var(--rose);font-size:12px;">AI 分析失败，请稍后重试。${escapeHtml(String(err))}</div>`;
    if (summarizeBtn) { summarizeBtn.disabled = false; summarizeBtn.textContent = "重新生成纪要"; }
  }
}

export function openCustomerDrawer() {
  qs("#customerDrawer")?.classList.add("open");
  qs("#customerDrawerBackdrop")?.classList.add("active");
  document.body.classList.add("customer-drawer-open");
}

export function closeCustomerDrawer() {
  hideJourneyTooltip();
  qs("#customerDrawer")?.classList.remove("open");
  qs("#customerDrawerBackdrop")?.classList.remove("active");
  document.body.classList.remove("customer-drawer-open");
  if (customerClockTimer) window.clearInterval(customerClockTimer);
}

export function countryFlag(country: string) {
  const normalized = country.trim();
  const aliases: Record<string, string> = {
    中国大陆: "CN", 中国: "CN", 中国香港: "HK", 香港: "HK", 中国澳门: "MO", 澳门: "MO", 中国台湾: "CN", 台湾: "CN",
    美国: "US", 英国: "GB", 德国: "DE", 法国: "FR", 瑞典: "SE", 日本: "JP", 韩国: "KR", 新加坡: "SG", 阿联酋: "AE",
    越南: "VN", 泰国: "TH", 马来西亚: "MY", 印度尼西亚: "ID", 俄罗斯: "RU", 捷克: "CZ", 荷兰: "NL", 西班牙: "ES",
    意大利: "IT", 加拿大: "CA", 墨西哥: "MX", 巴西: "BR", 澳大利亚: "AU", 新西兰: "NZ", 南非: "ZA", 沙特: "SA",
    沙特阿拉伯: "SA", 土耳其: "TR", 印度: "IN", 菲律宾: "PH", 波兰: "PL", 比利时: "BE", 瑞士: "CH", 奥地利: "AT",
    "UNITED STATES OF AMERICA": "US", USA: "US", UK: "GB", UAE: "AE", TW: "CN"
  };
  const alias = aliases[normalized] || aliases[normalized.toUpperCase()];
  const alpha2 = alias
    || (/^[a-z]{2}$/i.test(normalized) ? normalized.toUpperCase() : "")
    || isoCountries.getAlpha2Code(normalized, "zh")
    || isoCountries.getAlpha2Code(normalized, "en")
    || (/^[a-z]{3}$/i.test(normalized) ? isoCountries.alpha3ToAlpha2(normalized.toUpperCase()) : "");
  const label = normalized ? `${normalized}国旗` : "国家待补充";
  const assetUrl = alpha2 ? countryFlagAssets[alpha2.toLowerCase()] : "";
  return assetUrl
    ? `<span class="flag customer-country-flag" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(normalized)}"><img src="${escapeHtml(assetUrl)}" alt="" aria-hidden="true"></span>`
    : `<span class="flag customer-country-flag is-unknown" role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(normalized || "国家待补充")}"><span aria-hidden="true">?</span></span>`;
}

function health(value: number) {
  const active = Math.max(1, Math.round(value / 20));
  return `<span class="health ${value < 60 ? "bad" : value < 75 ? "warn" : ""}">${[1, 2, 3, 4, 5].map((item) => `<i class="${item <= active ? "on" : ""}"></i>`).join("")}</span>`;
}

export function dealItemsOf(deal: Deal): DealItem[] {
  if (deal.items?.length) return deal.items;
  return [{
    id: `legacy_${deal.id || "new"}`,
    product: deal.product?.trim() || "",
    model: "",
    quantity: Number(deal.quantity || 0) || 1,
    unitPrice: Number(deal.unitPrice || 0) || (Number(deal.amount || 0) / Math.max(1, Number(deal.quantity || 1)))
  }];
}

export function dealProductsText(deal: Deal) {
  const items = dealItemsOf(deal).filter((item) => item.product);
  if (!items.length) return "产品待维护";
  const names = items.slice(0, 2).map((item) => item.product);
  return items.length > 2 ? `${names.join("、")} 等 ${items.length} 项` : names.join("、");
}

export function dealItemsSummary(deal: Deal) {
  const items = dealItemsOf(deal).filter((item) => item.product);
  if (items.length === 1) return `${items[0].product} · ${items[0].quantity || "-"} × ${dealMoney(items[0].unitPrice, deal.currency)}`;
  return `${dealProductsText(deal)} · ${items.length} 项产品`;
}
