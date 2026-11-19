/**
 * 即时沟通、AI 背调、开发信工作室。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import {
  activateNavView, backgroundResearchLoading, backgroundResearchProgressNote, backgroundResearchResult,
  backgroundResearchStage, backgroundResearchSubject, confirmAction, runBackgroundResearch, state
} from "../prototype-api";
import {
  type AiEngineJobView, type BackgroundResearch, type BackgroundResearchEntity, type CompanyProfile,
  type DevelopmentEmailBriefInfo, type DevelopmentEmailDraft, type DevelopmentEmailQuality,
  type DevelopmentEmailReadiness, type DevelopmentEmailScenario, type DevelopmentEmailStageInfo,
  type EmailEngineSource, type ResearchEngineSource, type User
} from "./models";
import { appendHostThemeParams, markInstantCommunicationReady, normalizeWhatsAppPhone, setInstantCommunicationState } from "./customers";
import { prospectRequestId } from "./prospecting";
import { badge, developmentEmailScenarioDrafts, escapeHtml, qs, qsa, storage } from "./shared";
import { closeCustomerDrawer, renderCustomerDetailPage } from "./customer-detail";
import {
  aiEngineSourceHint, awaitAiEngineJob, cliWaitPanelHtml, effectiveEmailSource, effectiveResearchSource,
  engineSourceSelectHtml, ensureAiEngineSettings, startCliWaitTicker, stopCliWaitTicker
} from "./ai-engine-settings";
import { whatsAppWebLink } from "./whatsapp";
import { api, toast } from "./ui";
import { applyAuthedUser } from "./auth";
import { closeLeadDrawer } from "./leads";
import { formatDateTime } from "./deals";

let developmentEmailSubject: { entityType: BackgroundResearchEntity; entityId: string; company: string; backView: string; phone?: string } | null = null;
/** 发送通道：邮件（默认，走绑定 SMTP）或 WhatsApp（打开网页版预填消息，用户确认后发出） */
let developmentEmailChannel: "email" | "whatsapp" = "email";
let developmentEmailDraft: DevelopmentEmailDraft | null = null;
let developmentEmailReadiness: DevelopmentEmailReadiness | null = null;
let developmentEmailCompanyProfile: CompanyProfile | null = null;
/** 开发信技能：本封的阶段策略、依据与质量自检（后端返回，仅展示） */
let developmentEmailStageInfo: DevelopmentEmailStageInfo | null = null;
let developmentEmailBriefInfo: DevelopmentEmailBriefInfo | null = null;
let developmentEmailQuality: DevelopmentEmailQuality | null = null;
let developmentEmailLoading = false;
/**
 * 上一次生成开发信的失败原因。
 * 必须有这个状态：生成失败时页面不能一直停在「正在加载开发信工作区」——
 * 那样连「写作来源」选择器都渲染不出来，用户就没法把来源从本机 CLI 切回 AI API / 规则模板，
 * 等于被一次不可用的 Runner 卡死。失败时要落到一个能改来源、能重试的错误态。
 */
let developmentEmailLastError = "";
let developmentEmailSending = false;
let developmentEmailRequestId = "";
let developmentEmailTone: "professional" | "concise" | "warm" = "professional";
let developmentEmailScenario: DevelopmentEmailScenario = "first_touch";
let developmentEmailGoal = "";
let developmentEmailNextFollowAt = "";
let companyProfileCanManage = false;
/** 本次操作的来源覆盖：留空表示跟随团队默认值 */
export let backgroundResearchSourceOverride: ResearchEngineSource | "" = "";
export let developmentEmailSourceOverride: EmailEngineSource | "" = "";

function installInstantCommunicationFrame() {
  const frame = qs<HTMLIFrameElement>("#whatsapp .whatsapp-plugin-frame");
  const retry = qs<HTMLButtonElement>("#instantCommunicationRetry");
  if (!frame) return;
  if (frame.dataset.bound !== "true") {
    frame.dataset.bound = "true";
    frame.addEventListener("load", () => {
      if (frame.src !== "about:blank") markInstantCommunicationReady();
    });
  }
  if (retry && retry.dataset.bound !== "true") {
    retry.dataset.bound = "true";
    retry.addEventListener("click", () => void ensureInstantCommunicationLoaded(true));
  }
}

export async function ensureInstantCommunicationLoaded(force = false) {
  const frame = qs<HTMLIFrameElement>("#whatsapp .whatsapp-plugin-frame");
  if (!frame) return;
  installInstantCommunicationFrame();
  if (!force && frame.dataset.ready === "true") return;
  frame.hidden = true;
  frame.dataset.ready = "false";
  setInstantCommunicationState("loading", "正在连接即刻沟通", "正在检查 WhatsApp 会话服务与客户分析引擎。", false);
  try {
    const response = await fetch("/whatsapp-plugin/api/health/ready", {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000)
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string; error?: string };
      throw new Error(payload.message || payload.error || `服务返回 ${response.status}`);
    }
    const launch = new URLSearchParams({ embedded: "1", launch: String(Date.now()) });
    appendHostThemeParams(launch);
    frame.src = `/whatsapp-plugin/?${launch.toString()}`;
  } catch (error) {
    setInstantCommunicationState(
      "error",
      "即刻沟通暂不可用",
      error instanceof Error && error.message.includes("服务暂不可用")
        ? "会话服务尚未启动，请启动 CRM 全部服务后重试。"
        : "会话服务没有响应，请检查服务状态后重试。",
      true
    );
  }
}

/**
 * 打开与某个联系人（客户 / 线索）的 WhatsApp 对话。
 *
 * 走 web.whatsapp.com 直链，复用浏览器里**已扫码登录的网页版会话**：
 * 不请求插件、不建 socket、不经过 Baileys 通道，因此不受「仅官方通道」开关约束，
 * 也不存在非官方协议登录的封号风险。
 *
 * 为什么不用 wa.me：它是 universal 链接，装了 WhatsApp 桌面客户端的机器会被 App
 * 接管，消息落到另一个「关联设备」，而不是使用者已扫码登录的浏览器会话。
 * 与本文件 whatsAppWebLink() 及插件侧同名实现保持一致。
 *
 * 注：旧实现在这里查插件的 /v1/accounts + /v1/conversations 再切到「即刻沟通」的
 * 插件会话，没有 connected 账号时只会提示「WhatsApp 账号当前离线」，点了打不开。
 */
export async function openWhatsAppForContact(input: { phone: string; displayName: string }) {
  const phone = normalizeWhatsAppPhone(input.phone);
  if (!phone) {
    toast("该联系人没有 WhatsApp 号码", "error");
    return;
  }
  const url = whatsAppWebLink(phone);
  if (!url) {
    toast("WhatsApp 号码位数不足，无法打开", "error");
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/* 联系通道图标。通用通道（邮箱 / 电话）走 24 网格描边，与全站线性图标同密度。
   WhatsApp / 微信是品牌标识，用官方 glyph 实心绘制 —— 自绘“近似泡泡”在 16px 下会被一眼看成画错了；
   实心块天然更重，故用 --glyph-k 按视觉高度配重（微信 glyph 宽高比 1.46:1，天然横长，需单独放大）。 */
export function customerContactIcon(channel: "email" | "phone" | "whatsapp" | "wechat") {
  if (channel === "email") return `<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.99 5.73a2 2 0 0 1-2.02 0L2 7"/></svg>`;
  if (channel === "phone") return `<svg viewBox="0 0 24 24"><path d="M13.83 16.57a1 1 0 0 0 1.21-.3l.36-.47A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.47.35a1 1 0 0 0-.29 1.23 14 14 0 0 0 6.39 6.39"/></svg>`;
  if (channel === "whatsapp") return `<svg viewBox="0 0 24 24" class="contact-brand-glyph" style="--glyph-k:.9"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z"/></svg>`;
  return `<svg viewBox="0 0 24 24" class="contact-brand-glyph" style="--glyph-k:1.12"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348ZM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18Zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18Zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03Zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982Zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982Z"/></svg>`;
}

export function researchButtonIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></svg>`;
}

function backgroundResearchBack() {
  const backView = backgroundResearchSubject?.backView || (backgroundResearchSubject?.entityType === "lead" ? "leads" : "customers");
  if (backView === "customer-detail") {
    activateNavView("customer-detail", () => renderCustomerDetailPage());
    return;
  }
  activateNavView(backView);
}

export function renderBackgroundResearch() {
  const box = qs<HTMLElement>("#aiResearchPage");
  const subject = backgroundResearchSubject;
  if (!box || !subject) return;
  const stages = ["主体识别", "业务挖掘", "贸易信号", "风险核验", "综合结论"];
  if (backgroundResearchLoading) {
    box.innerHTML = `
      <header class="research-header">
        <div class="research-identity">
          <button class="customer-page-back" type="button" data-research-back title="返回" aria-label="返回"><svg viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg></button>
          <div><h1>${escapeHtml(subject.company)}</h1><span>${subject.entityType === "lead" ? "线索背调" : "客户背调"}</span></div>
        </div>
      </header>
      <section class="research-running">
        <div class="research-orbit"><span></span><b>${escapeHtml(backgroundResearchOrbitLabel())}</b></div>
        <div class="research-stage-list">${stages.map((stage, index) => `<div class="${index < backgroundResearchStage ? "done" : index === backgroundResearchStage ? "active" : ""}"><i>${index < backgroundResearchStage ? "✓" : String(index + 1)}</i><b>${stage}</b></div>`).join("")}</div>
        <div class="research-progress"><i style="width:${Math.min(92, 16 + backgroundResearchStage * 24)}%"></i></div>
        ${effectiveResearchSource() === "cli"
          ? `${cliWaitPanelHtml("research")}${backgroundResearchProgressNote ? `<p class="research-progress-note">${escapeHtml(backgroundResearchProgressNote)}</p>` : ""}`
          : backgroundResearchProgressNote
            ? `<p class="research-progress-note">${escapeHtml(backgroundResearchProgressNote)}</p>`
            : ""}
      </section>`;
    if (effectiveResearchSource() === "cli") startCliWaitTicker("research");
  } else if (!backgroundResearchResult) {
    box.innerHTML = `
      <header class="research-header">
        <div class="research-identity">
          <button class="customer-page-back" type="button" data-research-back title="返回" aria-label="返回"><svg viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg></button>
          <div><h1>${escapeHtml(subject.company)}</h1><span>${subject.entityType === "lead" ? "线索背调" : "客户背调"}</span></div>
        </div>
        <div class="research-source-row"><span>背调来源</span>${engineSourceSelectHtml("backgroundResearchSource", "research", effectiveResearchSource())}<small>${escapeHtml(aiEngineSourceHint(effectiveResearchSource()))}</small></div>
        <button class="btn primary research-run-button" type="button" data-research-run>${researchButtonIcon()}开始背调</button>
      </header>`;
  } else {
    const report = backgroundResearchResult;
    const scoreTone = report.score >= 78 ? "strong" : report.score >= 60 ? "steady" : "caution";
    const factSourceLink = (fact: BackgroundResearch["facts"][number]) => {
      if (!fact.sourceUrl || !/^https?:\/\//i.test(fact.sourceUrl)) return "";
      return `<a class="research-fact-source" href="${escapeHtml(fact.sourceUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(fact.sourceTitle || fact.sourceUrl)}">来源 ↗</a>`;
    };
    const angleChecks = (report.sourceChecks || []).filter((item) => item.providerId.startsWith("angle:"));
    box.innerHTML = `
      <header class="research-header">
        <div class="research-identity">
          <button class="customer-page-back" type="button" data-research-back title="返回" aria-label="返回"><svg viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg></button>
          <div><h1>${escapeHtml(report.company)}</h1><span>${report.entityType === "lead" ? "线索背调" : "客户背调"} · ${escapeHtml(formatDateTime(report.completedAt))}</span></div>
        </div>
        <div class="inline-actions">
          <div class="research-source-row"><span>背调来源</span>${engineSourceSelectHtml("backgroundResearchSource", "research", effectiveResearchSource())}</div>
          <button class="btn" type="button" data-research-copy>复制报告</button>
          <button class="btn research-run-button" type="button" data-research-run>${researchButtonIcon()}重新背调</button>
        </div>
      </header>

      <section class="research-verdict ${scoreTone}">
        <div class="research-score" style="--score:${report.score * 3.6}deg"><div><b>${report.score}</b><span>可信度</span></div></div>
        <div class="research-verdict-copy"><span>综合判断</span><h2>${escapeHtml(report.verdict)}</h2><p>${escapeHtml(report.summary)}</p>${report.scoreReason ? `<small class="research-score-reason">评分依据：${escapeHtml(report.scoreReason)}</small>` : ""}</div>
        <div class="research-next"><span>下一步</span><b>${escapeHtml(report.nextAction)}</b></div>
      </section>

      ${report.crmOnly ? `<section class="research-note warning">本轮未获取到公开网络证据（未配置可用模型、目标地区合规限制或检索失败），以下结论仅基于 CRM 内部资料，建议先补全 AI 模型配置后重新背调。</section>` : ""}

      <div class="research-layout">
        <main class="research-main">
          <section class="research-block">
            <h2>首聊切入点</h2>
            <div class="research-opportunities">${report.talkTracks?.length ? report.talkTracks.map((item, index) => `<article><i>${String(index + 1).padStart(2, "0")}</i><b>${escapeHtml(item)}</b></article>`).join("") : `<div class="research-empty">暂无首聊切入点（联网证据不足时不会生成）</div>`}</div>
          </section>
          <section class="research-block">
            <h2>业务机会</h2>
            <div class="research-opportunities">${report.opportunities.length ? report.opportunities.map((item, index) => `<article><i>${String(index + 1).padStart(2, "0")}</i><b>${escapeHtml(item)}</b></article>`).join("") : `<div class="research-empty">暂无明确机会</div>`}</div>
          </section>
          <section class="research-block">
            <h2>风险核验</h2>
            <div class="research-risks">${report.risks.map((risk) => `<article class="${risk.level}"><i></i><div><b>${escapeHtml(risk.title)}</b><span>${escapeHtml(risk.detail)}</span></div></article>`).join("")}</div>
          </section>
        </main>

        <aside class="research-side">
          <section class="research-block">
            <h2>公司事实</h2>
            <dl class="research-facts">${report.facts.map((fact) => `<div><dt>${escapeHtml(fact.label)}${fact.group ? ` <small class="research-fact-group">${escapeHtml(fact.group)}</small>` : ""}</dt><dd>${escapeHtml(fact.value)} ${factSourceLink(fact)}</dd></div>`).join("")}</dl>
          </section>
          <section class="research-block">
            <h2>关键联系人</h2>
            <dl class="research-facts">${report.contacts.length ? report.contacts.map((contact) => `<div><dt>${escapeHtml(contact.channel)}</dt><dd>${escapeHtml(contact.value)}</dd></div>`).join("") : `<div><dt>状态</dt><dd>待核实</dd></div>`}</dl>
          </section>
          <section class="research-block">
            <h2>证据来源</h2>
            <div class="research-sources">${report.sources.length ? report.sources.map((source) => {
              const validUrl = /^https?:\/\//i.test(source.url);
              const title = escapeHtml(source.title || source.url || "来源记录");
              const tag = source.detail ? `<small>${escapeHtml(source.detail)}</small>` : "";
              return validUrl
                ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer"><b>${title}</b>${tag}<span>${escapeHtml(source.observedAt ? formatDateTime(source.observedAt) : "")}</span></a>`
                : `<div><b>${title}</b>${tag}<span>${escapeHtml(source.observedAt ? formatDateTime(source.observedAt) : "")}</span></div>`;
            }).join("") : `<div class="research-empty">暂无公开来源</div>`}</div>
          </section>
          ${angleChecks.length ? `<section class="research-block"><h2>联网检索 · 四路角度</h2><dl class="research-facts">${angleChecks.map((item) => `<div><dt>${escapeHtml(item.providerName)}</dt><dd><span class="research-angle-status ${item.status}">${item.status === "matched" ? "命中" : item.status === "empty" ? "有来源" : item.status === "skipped" ? "跳过" : "失败"}</span> ${escapeHtml(item.message)}</dd></div>`).join("")}</dl></section>` : ""}
          <div class="research-engine"><span>分析引擎</span><b>${escapeHtml(report.engine)}</b></div>
        </aside>
      </div>`;
  }
  qsa<HTMLButtonElement>("[data-research-back]", box).forEach((button) => button.addEventListener("click", backgroundResearchBack));
  qsa<HTMLButtonElement>("[data-research-run]", box).forEach((button) => button.addEventListener("click", () => void runBackgroundResearch()));
  qs<HTMLSelectElement>("#backgroundResearchSource", box)?.addEventListener("change", (event) => {
    backgroundResearchSourceOverride = (event.currentTarget as HTMLSelectElement).value as ResearchEngineSource;
    renderBackgroundResearch();
  });
  qs<HTMLButtonElement>("[data-research-copy]", box)?.addEventListener("click", () => {
    const report = backgroundResearchResult;
    if (!report) return;
    const lines = [
      `${report.company} · AI 背调报告（${formatDateTime(report.completedAt)}）`,
      `可信度 ${report.score} · ${report.verdict}`,
      "",
      `【综合判断】${report.summary}`,
      report.scoreReason ? `评分依据：${report.scoreReason}` : "",
      "",
      `【公司事实】`,
      ...report.facts.map((fact) => `- ${fact.label}：${fact.value}${fact.sourceUrl ? `（来源：${fact.sourceUrl}）` : ""}`),
      "",
      `【首聊切入点】`,
      ...(report.talkTracks || []).map((item) => `- ${item}`),
      "",
      `【业务机会】`,
      ...report.opportunities.map((item) => `- ${item}`),
      "",
      `【风险】`,
      ...report.risks.map((risk) => `- [${risk.level}] ${risk.title}：${risk.detail}`),
      "",
      `【下一步】${report.nextAction}`,
      `【引擎】${report.engine}`
    ].filter((line) => line !== "").join("\n");
    void navigator.clipboard?.writeText(lines).then(() => toast("背调报告已复制到剪贴板")).catch(() => toast("复制失败，请手动选择文本", "error"));
  });
}

/** 运行中动画上的引擎标识：让用户一眼看出这次是谁在干活 */
function backgroundResearchOrbitLabel() {
  const source = effectiveResearchSource();
  return source === "cli" ? "CLI" : source === "crm" ? "CRM" : "AI";
}

function developmentEmailBack() {
  const subject = developmentEmailSubject;
  if (!subject) {
    activateNavView("leads");
    return;
  }
  if (subject.backView === "customer-detail") {
    activateNavView("customer-detail", () => renderCustomerDetailPage());
    return;
  }
  activateNavView(subject.backView);
}

function syncDevelopmentEmailDraft() {
  if (!developmentEmailDraft) return;
  developmentEmailDraft.to = qs<HTMLInputElement>("#developmentEmailTo")?.value.trim() || "";
  developmentEmailDraft.subject = qs<HTMLInputElement>("#developmentEmailSubject")?.value || "";
  developmentEmailDraft.body = qs<HTMLTextAreaElement>("#developmentEmailBody")?.value || "";
}

const developmentEmailScenarios: Array<{ id: DevelopmentEmailScenario; label: string }> = [
  { id: "first_touch", label: "首次触达" },
  { id: "daily_contact", label: "日常联系" },
  { id: "holiday_greeting", label: "节日问候" },
  { id: "new_product", label: "新产品介绍" },
  { id: "custom_goal", label: "自然语言目标" }
];

function rememberDevelopmentEmailScenarioDraft() {
  syncDevelopmentEmailDraft();
  if (!developmentEmailDraft) return;
  developmentEmailScenarioDrafts.set(developmentEmailScenario, {
    subject: developmentEmailDraft.subject,
    body: developmentEmailDraft.body,
    engine: developmentEmailDraft.engine,
    aiGenerated: Boolean(developmentEmailReadiness?.aiGenerated)
  });
}

async function switchDevelopmentEmailScenario(scenario: DevelopmentEmailScenario) {
  if (scenario === developmentEmailScenario || developmentEmailLoading) return;
  rememberDevelopmentEmailScenarioDraft();
  developmentEmailScenario = scenario;
  const remembered = developmentEmailScenarioDrafts.get(scenario);
  if (remembered && developmentEmailDraft) {
    Object.assign(developmentEmailDraft, remembered);
    if (developmentEmailReadiness) developmentEmailReadiness.aiGenerated = remembered.aiGenerated;
    developmentEmailRequestId = "";
    renderDevelopmentEmailPage();
    return;
  }
  await generateDevelopmentEmailDraftPage(false);
}

function renderDevelopmentEmailPage() {
  const box = qs<HTMLElement>("#developmentEmailPage");
  const subject = developmentEmailSubject;
  if (!box || !subject) return;
  if (!developmentEmailDraft || !developmentEmailReadiness) {
    const sourcePicker = engineSourceSelectHtml("developmentEmailSource", "email", effectiveEmailSource());
    // 加载中 vs 失败必须分开渲染：失败还画成「正在加载」会让用户永远等下去，且看不到来源选择器
    box.innerHTML = `
      <header class="mail-studio-header">
        <div class="research-identity"><button class="customer-page-back" type="button" data-mail-back title="返回" aria-label="返回"><svg viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg></button><div><h1>${escapeHtml(subject.company)}</h1><span>AI 开发信</span></div></div>
      </header>
      ${developmentEmailLoading
        ? (effectiveEmailSource() === "cli"
          ? `<div class="mail-studio-loading" style="display:block;place-content:start;padding:56px 40px;">${cliWaitPanelHtml("email")}<p style="text-align:center;font-size:12.5px;color:#68798f;margin:12px 0 0">本机智能体正在撰写这封开发信，通常 1-2 分钟；期间可切换其他页面，写完自动展示。</p></div>`
          : `<div class="mail-studio-loading"><i></i><b>正在加载开发信工作区</b></div>`)
        : `<div class="mail-studio-error">
            <b>这次没能生成开发信草稿</b>
            <p class="mail-studio-error-reason">${escapeHtml(developmentEmailLastError || "未取到开发信草稿，请重试或更换来源")}</p>
            <div class="mail-source-row"><span>写作来源</span>${sourcePicker}<small>${escapeHtml(aiEngineSourceHint(effectiveEmailSource()))}</small></div>
            <div class="inline-actions">
              <button class="btn primary" type="button" data-mail-retry>重新生成</button>
              <button class="btn" type="button" data-mail-config="profile">检查发件配置</button>
            </div>
          </div>`}`;
    if (developmentEmailLoading && effectiveEmailSource() === "cli") startCliWaitTicker("email");
    qs<HTMLButtonElement>("[data-mail-back]", box)?.addEventListener("click", developmentEmailBack);
    if (!developmentEmailLoading) {
      qs<HTMLSelectElement>("#developmentEmailSource", box)?.addEventListener("change", (event) => {
        developmentEmailSourceOverride = (event.currentTarget as HTMLSelectElement).value as EmailEngineSource;
        renderDevelopmentEmailPage();
      });
      qs<HTMLButtonElement>("[data-mail-retry]", box)?.addEventListener("click", () => void generateDevelopmentEmailDraftPage());
      qsa<HTMLButtonElement>("[data-mail-config]", box).forEach((button) => button.addEventListener("click", () => activateNavView(button.dataset.mailConfig || "profile")));
    }
    return;
  }
  const draft = developmentEmailDraft;
  const readiness = developmentEmailReadiness;
  const profile = developmentEmailCompanyProfile;
  const stageInfo = developmentEmailStageInfo;
  const briefInfo = developmentEmailBriefInfo;
  const qualityInfo = developmentEmailQuality;
  const sendReady = readiness.personalReady && readiness.companyReady && Boolean(draft.to && draft.subject && draft.body.trim().length >= 10);
  // WhatsApp 通道只看两件事：联系人有号码、正文写够了。邮件那套 SMTP/公司资料门禁与它无关。
  const bodyReady = draft.body.trim().length >= 10;
  const whatsappReady = Boolean(subject.phone) && bodyReady;
  const sendEnabled = developmentEmailChannel === "whatsapp" ? whatsappReady : sendReady;
  const sendButtonLabel = developmentEmailChannel === "whatsapp" ? (developmentEmailSending ? "打开中" : "发送 WhatsApp") : (developmentEmailSending ? "发送中" : "发送邮件");
  // 生成按钮按来源动态渲染：CLI 不依赖 AI 模型配置，不该被 aiReady 门禁挡住
  const mailSource = effectiveEmailSource();
  const generateButtonHtml = mailSource === "cli"
    ? `<button class="btn" type="button" data-mail-generate ${developmentEmailLoading ? "disabled" : ""}>${researchButtonIcon()}${developmentEmailLoading ? "CLI 生成中" : "本机 CLI 生成"}</button>`
    : `<button class="btn" type="button" data-mail-ai ${developmentEmailLoading ? "disabled" : ""}>${researchButtonIcon()}${developmentEmailLoading ? "AI 生成中" : readiness.aiReady ? readiness.aiGenerated ? "AI 重新生成" : "AI 生成" : "配置 AI"}</button>`;
  // 「这封信从哪来」：模板 / AI / CLI 必须一句话说清，不能只显示一个模型名
  const mailOriginLabel = /^固定模板/u.test(draft.engine)
    ? "固定模板（阶段蓝图 + 已留档事实，不联网编造）"
    : /CLI/u.test(draft.engine)
      ? `本机 CLI · ${draft.engine}`
      : `AI 模型 · ${draft.engine}`;
  const mailPersonalization = briefInfo?.personalization || null;
  const mailFactsUsed = mailPersonalization?.factsUsed || [];
  // 以后端判定为准：正文里真的出现了背调信号才算"用了背调"
  const mailResearchUsed = Boolean(qualityInfo?.researchUsed ?? briefInfo?.researchUsed);
  // 「为什么这么写」：后端按最终正文校准后给出，模板与 AI/CLI 两条路都有
  const mailReasons = mailPersonalization?.reasons || [];
  // 这一阶段按设计要不要用背调：流程确认 / 收尾信不需要，别把它渲染成"没做背调"
  const stageNeedsResearch = stageInfo?.personalizes !== false;
  box.innerHTML = `
    <header class="mail-studio-header">
      <div class="research-identity"><button class="customer-page-back" type="button" data-mail-back title="返回" aria-label="返回"><svg viewBox="0 0 24 24"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg></button><div><h1>${escapeHtml(draft.recipientCompany)}</h1><span>AI 开发信</span></div></div>
      <div class="mail-studio-actions">${generateButtonHtml}<button class="btn primary" type="button" data-mail-send ${sendEnabled && !developmentEmailSending && !developmentEmailLoading ? "" : "disabled"}>${sendButtonLabel}</button></div>
    </header>

    <div class="mail-studio-layout">
      <aside class="mail-studio-context">
        <section>
          <h2>收件人</h2>
          <label><span>邮箱</span><input id="developmentEmailTo" value="${escapeHtml(draft.to)}" placeholder="name@company.com"></label>
          <dl><div><dt>联系人</dt><dd>${escapeHtml(draft.recipientName)}</dd></div><div><dt>公司</dt><dd>${escapeHtml(draft.recipientCompany)}</dd></div></dl>
        </section>
        <section>
          <h2>发送设置</h2>
          <label><span>发送通道</span><select id="developmentEmailChannel"><option value="email" ${developmentEmailChannel === "email" ? "selected" : ""}>邮件</option><option value="whatsapp" ${developmentEmailChannel === "whatsapp" ? "selected" : ""} ${subject.phone ? "" : "disabled title=\"该联系人未维护 WhatsApp 号码\""}>WhatsApp</option></select></label>
          ${developmentEmailChannel === "whatsapp" ? `<label><span>WhatsApp 号码</span><input value="${escapeHtml(subject.phone)}" disabled></label>` : ""}
          <label><span>语气</span><select id="developmentEmailTone"><option value="professional" ${developmentEmailTone === "professional" ? "selected" : ""}>专业</option><option value="concise" ${developmentEmailTone === "concise" ? "selected" : ""}>简洁</option><option value="warm" ${developmentEmailTone === "warm" ? "selected" : ""}>友好</option></select></label>
          <label><span>下次跟进</span><input id="developmentEmailNext" value="${escapeHtml(developmentEmailNextFollowAt)}" placeholder="例如 3 天后"></label>
        </section>
      </aside>

      <main class="mail-studio-editor">
        <section class="mail-compose-config" aria-label="开发信写作配置">
          <div class="mail-scenario-row">
            <span>写作场景</span>
            <div class="mail-scenario-options">${developmentEmailScenarios.map((item) => `<button type="button" class="${item.id === developmentEmailScenario ? "active" : ""}" data-mail-scenario="${item.id}" ${developmentEmailLoading ? "disabled" : ""}>${item.label}</button>`).join("")}</div>
          </div>
          <label class="mail-goal-field"><span>写作目标${developmentEmailScenario === "custom_goal" ? "（必填）" : "（可选）"}</span><textarea id="developmentEmailGoal" maxlength="1000" placeholder="例如：邀请客户在本周安排 15 分钟视频会议，并突出交期稳定">${escapeHtml(developmentEmailGoal)}</textarea></label>
          <div class="mail-source-row">
            <span>写作来源</span>
            ${engineSourceSelectHtml("developmentEmailSource", "email", effectiveEmailSource())}
            <small>${escapeHtml(aiEngineSourceHint(effectiveEmailSource()))}</small>
          </div>
        </section>
        ${stageInfo || briefInfo ? `
        <section class="mail-brief" aria-label="AI 开发信">
          <div class="mail-brief-head">
            <span>AI 开发信 · 依据</span>
            <span class="mail-brief-badges">
              ${stageInfo ? badge(`当前阶段 · ${stageInfo.label}`, stageInfo.canSend ? "amber" : "red") : ""}
              ${briefInfo ? (mailPersonalization?.personalized ? badge("AI 开发信 · 已按背调写", "green") : badge("AI 开发信 · 仅按阶段写", "amber")) : ""}
            </span>
          </div>
          <p class="mail-brief-origin">这封由 <b>${escapeHtml(mailOriginLabel)}</b> 写成${stageInfo ? `，按阶段「${escapeHtml(stageInfo.label)}」` : ""}${briefInfo ? `，对<b>${escapeHtml(briefInfo.role.label)}</b>说话` : ""}。</p>
          ${mailReasons.length ? `
          <details class="mail-why" open>
            <summary class="mail-why-head">为什么这么写<span class="mail-why-count">${mailReasons.length} 条</span><svg class="mail-why-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>
            <ol class="mail-why-list">
              ${mailReasons.map((reason) => `<li class="mail-why-item${reason.weak ? " is-weak" : ""}">
                <span class="mail-why-part">${escapeHtml(reason.part)}</span>
                <span class="mail-why-why">${escapeHtml(reason.why)}</span>
                ${reason.text ? `<code class="mail-why-quote">${escapeHtml(reason.text)}</code>` : ""}
              </li>`).join("")}
            </ol>
          </details>` : ""}
          ${stageInfo ? `<p class="mail-brief-objective">${escapeHtml(stageInfo.objective)}</p>` : ""}
          ${briefInfo ? `<p class="mail-brief-note">对<b>${escapeHtml(briefInfo.role.label)}</b>说话：${escapeHtml(briefInfo.role.authority)}</p>` : ""}
          ${stageNeedsResearch
            ? (mailResearchUsed
              ? `<p class="mail-brief-note">已引用背调：${escapeHtml(briefInfo?.researchEngine || "本系统背调")}${typeof briefInfo?.researchScore === "number" ? ` · 评分 ${briefInfo.researchScore}` : ""}${briefInfo?.researchCreatedAt ? ` · ${escapeHtml(formatDateTime(briefInfo.researchCreatedAt))}` : ""}${briefInfo?.researchVerdict ? ` · ${escapeHtml(briefInfo.researchVerdict)}` : ""}</p>`
              : briefInfo?.researchUsed
                ? `<p class="mail-brief-note is-warn">有背调留档${briefInfo.researchEngine ? `（${escapeHtml(briefInfo.researchEngine)}）` : ""}，但这封正文没用上——按当前阶段写信即可。</p>`
                : `<p class="mail-brief-note is-warn">尚无背调留档：这一封只能按阶段蓝图加业务关键词写，换掉公司名就能发给下一家。</p>`)
            : `<p class="mail-brief-note">这一阶段是流程确认 / 收尾，按设计不引用背调——不是做漏了。</p>`}
          ${mailFactsUsed.length && mailPersonalization?.personalized
            ? `<div class="mail-brief-facts">${mailFactsUsed.map((fact) => `<span class="mail-brief-chip" title="${escapeHtml(fact.value)}">${escapeHtml(fact.label)}</span>`).join("")}</div>`
            : mailFactsUsed.length
              ? `<p class="mail-brief-note">手上有这些背调素材（${escapeHtml(mailFactsUsed.map((fact) => fact.label).join("、"))}），但没写进这封。</p>`
              : ""}
          ${mailPersonalization && mailPersonalization.angles.length
            ? `<p class="mail-brief-note">${mailPersonalization.personalized ? "应用角度" : "可切入角度（未用上）"}：${escapeHtml(mailPersonalization.angles.join(" · "))}</p>`
            : ""}
          ${mailPersonalization ? `<p class="mail-brief-diff">${escapeHtml(mailPersonalization.difference)}</p>` : ""}
          ${briefInfo && briefInfo.evidence.length ? `<p class="mail-brief-note">依据来源：${escapeHtml(briefInfo.evidence.join("、"))}</p>` : ""}
          ${briefInfo && briefInfo.missing.length ? `<p class="mail-brief-note is-warn">待补齐：${escapeHtml(briefInfo.missing.join("、"))}</p>` : ""}
          ${qualityInfo && qualityInfo.issues.length
            ? `<ul class="mail-brief-issues">${qualityInfo.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("")}</ul>`
            : qualityInfo ? `<p class="mail-brief-note is-ok">发送前自检：通过</p>` : ""}
          ${briefInfo && !briefInfo.researchUsed && stageNeedsResearch
            ? `<div class="mail-brief-action"><button class="btn" type="button" data-mail-research ${developmentEmailLoading ? "disabled" : ""}>先跑背调，再按背调重写</button><span>背调会留档；之后这封为什么这么写就有据可查。</span></div>`
            : ""}
        </section>` : ""}
        <label class="mail-subject-field"><span>主题</span><input id="developmentEmailSubject" value="${escapeHtml(draft.subject)}"></label>
        <label class="mail-body-field"><span>正文</span><textarea id="developmentEmailBody">${escapeHtml(draft.body)}</textarea></label>
        <footer><span id="developmentEmailCount">${draft.body.length} 字符</span><b>${escapeHtml(draft.engine)}</b></footer>
      </main>

      <aside class="mail-studio-checks">
        <section class="mail-readiness ${readiness.personalReady ? "ready" : "missing"}">
          <div><i></i><h2>个人发件配置</h2></div>
          <b>${readiness.personalReady ? `${escapeHtml(draft.senderName)} · ${escapeHtml(draft.from)}` : escapeHtml(readiness.personalMissing.join("、"))}</b>
          ${readiness.personalReady ? "" : `<button class="btn" type="button" data-mail-config="profile">完善个人配置</button>`}
        </section>
        <section class="mail-readiness ${readiness.companyReady ? "ready" : "missing"}">
          <div><i></i><h2>公司资料</h2></div>
          <b>${readiness.companyReady ? `${escapeHtml(profile?.companyName || "")} · ${escapeHtml(profile?.website || "")}` : escapeHtml(readiness.companyMissing.join("、"))}</b>
          ${readiness.companyReady ? "" : companyProfileCanManage ? `<button class="btn" type="button" data-mail-config="settings">维护公司资料</button>` : `<span>管理员维护</span>`}
        </section>
        <section class="mail-readiness ${readiness.aiReady ? "ready" : "missing"}">
          <div><i></i><h2>AI 写作模型</h2></div>
          <b>${readiness.aiReady ? escapeHtml(readiness.aiGenerated ? `${readiness.aiConfigName} · 当前草稿由 AI 生成` : `${readiness.aiConfigName} · ${readiness.aiError || "模型已就绪"}`) : "开发信模型、API Key"}</b>
          ${readiness.aiReady ? "" : `<button class="btn" type="button" data-mail-config="ai-config">配置 AI 模型</button>`}
        </section>
        <section class="mail-sender-card"><span>发件人</span><b>${escapeHtml(draft.senderName || "待配置")}</b><small>${escapeHtml(draft.from || "待配置")}</small></section>
      </aside>
    </div>`;
  qs<HTMLButtonElement>("[data-mail-back]", box)?.addEventListener("click", developmentEmailBack);
  // 本机 CLI 生成：不检查 AI 模型配置（CLI 用本机智能体，不需要 API Key）
  qs<HTMLButtonElement>("[data-mail-generate]", box)?.addEventListener("click", () => {
    developmentEmailGoal = qs<HTMLTextAreaElement>("#developmentEmailGoal", box)?.value.trim() || "";
    if (developmentEmailScenario === "custom_goal" && !developmentEmailGoal) {
      toast("请先填写自然语言写作目标", "error");
      qs<HTMLTextAreaElement>("#developmentEmailGoal", box)?.focus();
      return;
    }
    void generateDevelopmentEmailDraftPage(false);
  });
  qs<HTMLButtonElement>("[data-mail-ai]", box)?.addEventListener("click", () => {
    if (!developmentEmailReadiness?.aiReady) {
      activateNavView("ai-config");
      return;
    }
    developmentEmailGoal = qs<HTMLTextAreaElement>("#developmentEmailGoal", box)?.value.trim() || "";
    if (developmentEmailScenario === "custom_goal" && !developmentEmailGoal) {
      toast("请先填写自然语言写作目标", "error");
      qs<HTMLTextAreaElement>("#developmentEmailGoal", box)?.focus();
      return;
    }
    void generateDevelopmentEmailDraftPage(true);
  });
  qsa<HTMLButtonElement>("[data-mail-scenario]", box).forEach((button) => button.addEventListener("click", () => {
    void switchDevelopmentEmailScenario(button.dataset.mailScenario as DevelopmentEmailScenario);
  }));
  qs<HTMLButtonElement>("[data-mail-research]", box)?.addEventListener("click", () => void researchThenWriteDevelopmentEmail());
  qs<HTMLButtonElement>("[data-mail-send]", box)?.addEventListener("click", () => {
    if (developmentEmailChannel === "whatsapp") void sendDevelopmentWhatsAppFromStudio();
    else void sendDevelopmentEmailFromStudio();
  });
  qs<HTMLSelectElement>("#developmentEmailChannel", box)?.addEventListener("change", (event) => {
    developmentEmailChannel = (event.currentTarget as HTMLSelectElement).value as typeof developmentEmailChannel;
    renderDevelopmentEmailPage();
  });
  qsa<HTMLInputElement | HTMLTextAreaElement>("#developmentEmailTo, #developmentEmailSubject, #developmentEmailBody", box).forEach((input) => input.addEventListener("input", () => {
    syncDevelopmentEmailDraft();
    developmentEmailRequestId = "";
    const count = qs<HTMLElement>("#developmentEmailCount", box);
    if (count) count.textContent = `${developmentEmailDraft?.body.length || 0} 字符`;
    const send = qs<HTMLButtonElement>("[data-mail-send]", box);
    if (send && developmentEmailReadiness) {
      const bodyOk = (developmentEmailDraft?.body.trim().length || 0) >= 10;
      send.disabled = developmentEmailChannel === "whatsapp"
        ? !(Boolean(developmentEmailSubject?.phone) && bodyOk)
        : !(developmentEmailReadiness.personalReady && developmentEmailReadiness.companyReady && Boolean(developmentEmailDraft?.to && developmentEmailDraft.subject && bodyOk));
    }
  }));
  qs<HTMLSelectElement>("#developmentEmailTone", box)?.addEventListener("change", (event) => { developmentEmailTone = (event.currentTarget as HTMLSelectElement).value as typeof developmentEmailTone; });
  qs<HTMLSelectElement>("#developmentEmailSource", box)?.addEventListener("change", (event) => {
    developmentEmailSourceOverride = (event.currentTarget as HTMLSelectElement).value as EmailEngineSource;
    renderDevelopmentEmailPage();
  });
  qs<HTMLTextAreaElement>("#developmentEmailGoal", box)?.addEventListener("input", (event) => { developmentEmailGoal = (event.currentTarget as HTMLTextAreaElement).value; });
  qs<HTMLInputElement>("#developmentEmailNext", box)?.addEventListener("input", (event) => { developmentEmailNextFollowAt = (event.currentTarget as HTMLInputElement).value; });
  qsa<HTMLButtonElement>("[data-mail-config]", box).forEach((button) => button.addEventListener("click", () => activateNavView(button.dataset.mailConfig || "profile")));
}

interface DevelopmentEmailDraftResponse {
  draft: DevelopmentEmailDraft | null;
  readiness?: DevelopmentEmailReadiness;
  companyProfile?: CompanyProfile;
  stage?: DevelopmentEmailStageInfo | null;
  brief?: DevelopmentEmailBriefInfo | null;
  quality?: DevelopmentEmailQuality | null;
}

/** 落地一次草稿响应：直接返回和 CLI 轮询回来的是同一份结构 */
function applyDevelopmentEmailDraftResponse(result: DevelopmentEmailDraftResponse) {
  if (!result.draft) return false;
  developmentEmailStageInfo = result.stage || null;
  developmentEmailBriefInfo = result.brief || null;
  developmentEmailQuality = result.quality || null;
  developmentEmailDraft = result.draft;
  developmentEmailScenarioDrafts.set(developmentEmailScenario, {
    subject: result.draft.subject,
    body: result.draft.body,
    engine: result.draft.engine,
    aiGenerated: Boolean(result.readiness?.aiGenerated)
  });
  if (result.readiness) developmentEmailReadiness = result.readiness;
  if (result.companyProfile) developmentEmailCompanyProfile = result.companyProfile;
  return true;
}

/**
 * 「先跑背调，再按背调重写」。
 *
 * 之前这一步是断的：面板上写着"建议先跑一次背调"，但没有任何入口 ——
 * 业务员得自己跳到背调页找同一家公司再点一次，回来还得重新生成。
 * 这里一次点完：背调跑完会留档，重新取草稿时 useResearch 自然引用到它。
 */
async function researchThenWriteDevelopmentEmail() {
  const subject = developmentEmailSubject;
  if (!subject || developmentEmailLoading) return;
  developmentEmailLoading = true;
  developmentEmailLastError = "";
  renderDevelopmentEmailPage();
  try {
    const result = await api<{
      research: { id?: string } | null;
      pending?: boolean;
      engineJob?: AiEngineJobView;
      runnerName?: string;
      engine?: string;
    }>("/api/ai-background-research", {
      method: "POST",
      body: JSON.stringify({ entityType: subject.entityType, entityId: subject.entityId })
    });
    let research = result.research;
    if (result.pending && result.engineJob) {
      const payload = await awaitAiEngineJob(result.engineJob) as { research?: { id?: string } | null };
      research = payload.research || null;
    }
    if (!research) throw new Error("背调没有返回结果，请稍后重试");
    developmentEmailLoading = false;
    await generateDevelopmentEmailDraftPage(false);
    toast("已按新背调重写");
  } catch (error) {
    developmentEmailLoading = false;
    developmentEmailLastError = error instanceof Error ? error.message : "背调失败";
    toast(developmentEmailLastError, "error");
    renderDevelopmentEmailPage();
  }
}

async function generateDevelopmentEmailDraftPage(requireAi = false) {
  const subject = developmentEmailSubject;
  if (!subject || developmentEmailLoading) return;
  syncDevelopmentEmailDraft();
  developmentEmailTone = (qs<HTMLSelectElement>("#developmentEmailTone")?.value || developmentEmailTone) as typeof developmentEmailTone;
  developmentEmailGoal = qs<HTMLTextAreaElement>("#developmentEmailGoal")?.value.trim() || developmentEmailGoal;
  await ensureAiEngineSettings();
  const source = effectiveEmailSource();
  developmentEmailLoading = true;
  developmentEmailLastError = "";
  renderDevelopmentEmailPage();
  try {
    const result = await api<DevelopmentEmailDraftResponse & {
      pending?: boolean;
      engineJob?: AiEngineJobView;
      runnerName?: string;
      engine?: string;
    }>("/api/development-email/draft", {
      method: "POST",
      body: JSON.stringify({
        entityType: subject.entityType,
        entityId: subject.entityId,
        tone: developmentEmailTone,
        scenario: developmentEmailScenario,
        goal: developmentEmailGoal,
        requireAi,
        // 开发信技能：默认引用这家客户的背调结论，并按当前开发阶段写作；来源由设置或本次选择决定。
        useResearch: true,
        useAi: true,
        source
      })
    });
    if (result.pending && result.engineJob) {
      const payload = await awaitAiEngineJob(result.engineJob);
      applyDevelopmentEmailDraftResponse(payload as unknown as DevelopmentEmailDraftResponse);
    } else {
      applyDevelopmentEmailDraftResponse(result);
    }
  } catch (error) {
    developmentEmailLastError = error instanceof Error ? error.message : "开发信生成失败";
    toast(developmentEmailLastError, "error");
  } finally {
    stopCliWaitTicker("email");
    developmentEmailLoading = false;
    renderDevelopmentEmailPage();
  }
}

/**
 * WhatsApp 通道发送：打开 web.whatsapp.com 会话并预填正文，真正的「发送」由用户在
 * WhatsApp 里完成（本系统不代发）。发送动作本身无法被系统确认，所以只记一条
 * WhatsApp 跟进活动（type=whatsapp），不去碰开发阶段推导用的外发触点，避免虚报阶段。
 */
async function sendDevelopmentWhatsAppFromStudio() {
  const subject = developmentEmailSubject;
  if (!subject || !developmentEmailDraft || developmentEmailSending) return;
  syncDevelopmentEmailDraft();
  const draft = developmentEmailDraft;
  const body = draft.body.trim();
  if (body.length < 10) {
    toast("消息内容太短，写几句再发", "error");
    return;
  }
  const phone = normalizeWhatsAppPhone(subject.phone || "");
  const link = phone ? whatsAppWebLink(phone, body) : "";
  if (!phone || !link) {
    toast("该联系人没有可用的 WhatsApp 号码，请先补齐带国家码的手机号", "error");
    return;
  }
  if (!await confirmAction({
    title: "确认用 WhatsApp 发送",
    message: "将打开 WhatsApp 网页版并预填消息，发送由你在 WhatsApp 里点击完成；系统会同步写一条跟进记录。",
    detailLabel: "联系人 / 号码",
    detail: `${draft.recipientName || subject.company} → ${phone}`,
    consequences: [`公司：${subject.company}`, `消息开头：${body.slice(0, 60)}${body.length > 60 ? "…" : ""}`],
    confirmLabel: "打开 WhatsApp",
    tone: "normal"
  })) return;
  developmentEmailSending = true;
  renderDevelopmentEmailPage();
  try {
    window.open(link, "_blank", "noopener,noreferrer");
    const content = `[WhatsApp] ${body.slice(0, 500)}`;
    if (subject.entityType === "lead") {
      await api(`/api/leads/${subject.entityId}/activities`, { method: "POST", body: JSON.stringify({ type: "whatsapp", content }) });
    } else {
      await api(`/api/customers/${subject.entityId}/activities`, { method: "POST", body: JSON.stringify({ type: "whatsapp", content }) });
    }
    toast("已在 WhatsApp 预填消息，跟进记录已写入");
  } catch (error) {
    toast(error instanceof Error ? error.message : "跟进记录写入失败（WhatsApp 页面已打开）", "error");
  } finally {
    developmentEmailSending = false;
    renderDevelopmentEmailPage();
  }
}

async function sendDevelopmentEmailFromStudio() {
  const subject = developmentEmailSubject;
  if (!subject || !developmentEmailDraft || developmentEmailSending) return;
  syncDevelopmentEmailDraft();
  developmentEmailNextFollowAt = qs<HTMLInputElement>("#developmentEmailNext")?.value.trim() || developmentEmailNextFollowAt;
  if (!await confirmAction({
    title: "确认发送开发信",
    message: "邮件将通过绑定邮箱真实发出。打开和点击仅作为追踪信号，不能等同于客户意向。",
    detailLabel: "发件 / 收件",
    detail: `${developmentEmailDraft.from || state.user?.outboundEmail || "待配置"} → ${developmentEmailDraft.to}`,
    consequences: [`客户：${developmentEmailDraft.recipientCompany}`, `主题：${developmentEmailDraft.subject}`],
    confirmLabel: "确认发送",
    tone: "normal"
  })) return;
  developmentEmailRequestId ||= prospectRequestId("development-email-studio");
  developmentEmailSending = true;
  renderDevelopmentEmailPage();
  try {
    const result = await api<{ sent: { simulated: boolean; replayed?: boolean }; user: User }>("/api/development-email/send", {
      method: "POST",
      body: JSON.stringify({
        entityType: subject.entityType,
        entityId: subject.entityId,
        to: developmentEmailDraft.to,
        subject: developmentEmailDraft.subject,
        body: developmentEmailDraft.body,
        nextFollowAt: developmentEmailNextFollowAt,
        requestId: developmentEmailRequestId
      })
    });
    state.user = result.user;
    localStorage.setItem(storage.user, JSON.stringify(result.user));
    applyAuthedUser(result.user);
    developmentEmailRequestId = "";
    toast(result.sent.replayed ? "发送结果已确认，未重复发送" : result.sent.simulated ? "开发信已发送（测试记录）" : "开发信已发送");
  } catch (error) {
    toast(error instanceof Error ? error.message : "开发信发送失败", "error");
  } finally {
    developmentEmailSending = false;
    renderDevelopmentEmailPage();
  }
}

export function openDevelopmentEmail(entityType: BackgroundResearchEntity, entityId: string, company: string, backView: string, phone = "") {
  developmentEmailSubject = { entityType, entityId, company, backView, phone: phone || "" };
  developmentEmailChannel = "email";
  developmentEmailDraft = null;
  developmentEmailReadiness = null;
  developmentEmailTone = "professional";
  developmentEmailScenario = "first_touch";
  developmentEmailGoal = "";
  developmentEmailScenarioDrafts.clear();
  developmentEmailNextFollowAt = "";
  developmentEmailRequestId = "";
  closeLeadDrawer();
  closeCustomerDrawer();
  activateNavView("development-email", () => void generateDevelopmentEmailDraftPage());
}

function personalEmailReady(user = state.user) {
  return Boolean(user?.outboundEmail && user.emailSenderName && user.emailSignature && user.smtpHost && user.smtpUser && user.hasSmtpPassword);
}

export function renderEmailConfigurationReminders() {
  const personal = qs<HTMLElement>("#profileDevelopmentEmailReady");
  if (personal && state.user) {
    const ready = personalEmailReady(state.user);
    personal.className = `email-config-reminder ${ready ? "ready" : "missing"}`;
    personal.innerHTML = `<i></i><div><span>开发信发件配置</span><b>${ready ? "已完成 · 点此查看邮箱设置" : "点此去邮箱设置，补齐发件邮箱、SMTP 与签名"}</b></div>`;
  }
  const profile = developmentEmailCompanyProfile;
  const form = qs<HTMLElement>("#companyProfileForm");
  if (form && profile) {
    // 完整度口径与 developmentEmailReadiness 的公司部分一致：名称 / 主营 / 官网
    const missing = new Set([
      !String(profile.companyName || "").trim() ? "companyName" : "",
      !String(profile.productSummary || "").trim() ? "productSummary" : "",
      !String(profile.website || "").trim() ? "website" : ""
    ].filter(Boolean) as string[]);
    const missingLabels: Record<string, string> = { companyName: "公司名称", productSummary: "主营产品", website: "公司官网" };
    const fields: Array<[string, keyof CompanyProfile]> = [
      ["#companyProfileName", "companyName"], ["#companyProfileWebsite", "website"], ["#companyProfileProducts", "productSummary"],
      ["#companyProfileAddress", "address"], ["#companyProfilePhone", "phone"], ["#companyProfileEmail", "email"]
    ];
    fields.forEach(([selector, key]) => {
      const input = qs<HTMLInputElement | HTMLTextAreaElement>(selector);
      if (!input) return;
      input.value = String(profile[key] || "");
      input.disabled = !companyProfileCanManage;
      // 必填三项缺失 → 琥珀提示框；补齐即恢复
      if (missing.has(key)) input.dataset.missing = "1";
      else delete input.dataset.missing;
    });
    const save = qs<HTMLButtonElement>("#companyProfileSaveButton");
    if (save) save.classList.toggle("is-hidden", !companyProfileCanManage);
    const readiness = qs<HTMLElement>("#companyProfileReadiness");
    if (readiness) {
      const labels = [...missing].map((key) => missingLabels[key] || key);
      readiness.textContent = labels.length ? `缺 ${labels.length} 项：${labels.join("、")}` : "资料完整";
      readiness.className = `badge ${labels.length ? "amber" : "green"}`;
    }
  }
}

export async function loadCompanyProfile() {
  try {
    const result = await api<{ profile: CompanyProfile; canManage: boolean }>("/api/company-profile");
    developmentEmailCompanyProfile = result.profile;
    companyProfileCanManage = result.canManage;
    renderEmailConfigurationReminders();
  } catch {
  }
}

export async function saveCompanyProfile() {
  if (!companyProfileCanManage) return;
  const button = qs<HTMLButtonElement>("#companyProfileSaveButton");
  const restoreButton = () => {
    if (button) { button.disabled = false; button.textContent = "保存公司资料"; }
  };
  try {
    if (button) { button.disabled = true; button.textContent = "保存中"; }
    const result = await api<{ profile: CompanyProfile; canManage: boolean }>("/api/company-profile", {
      method: "PUT",
      body: JSON.stringify({
        companyName: qs<HTMLInputElement>("#companyProfileName")?.value.trim() || "",
        website: qs<HTMLInputElement>("#companyProfileWebsite")?.value.trim() || "",
        productSummary: qs<HTMLTextAreaElement>("#companyProfileProducts")?.value.trim() || "",
        address: qs<HTMLInputElement>("#companyProfileAddress")?.value.trim() || "",
        phone: qs<HTMLInputElement>("#companyProfilePhone")?.value.trim() || "",
        email: qs<HTMLInputElement>("#companyProfileEmail")?.value.trim() || ""
      })
    });
    developmentEmailCompanyProfile = result.profile;
    renderEmailConfigurationReminders();
    toast("公司资料已保存");
    // 「已保存 ✓」停留一下再复位，和徽标变绿是同一时刻
    if (button) {
      button.textContent = "已保存 ✓";
      window.setTimeout(restoreButton, 1300);
    } else {
      restoreButton();
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : "公司资料保存失败", "error");
    restoreButton();
  }
}
