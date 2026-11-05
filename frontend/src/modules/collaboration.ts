/**
 * 日报、站内信。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { activateNavView, closeModal, dailyAutoDate, openModal, state } from "../prototype-api";
import { type CollaborationUser, type DailyReport, type DailyReportComment, type InternalMessage } from "./models";
import { integrationCenterController } from "./events";
import { badge, escapeHtml, qs, qsa, roleLabel, setFieldValue } from "./shared";
import { api, setButtonPending, toast } from "./ui";
import { openLead, reloadLeads } from "./leads";
import { setDocumentWorkspaceMode } from "./trade-documents";
import { LOG_CATEGORY_LABEL, LOG_LEVEL_ICON, type LogCategory } from "./logs";
import { collaborationAvatar, collaborationDate, collaborationDateTime, localDateValue, updateInternalMessageBadge } from "./reports";
import { openEmailReturnDetail } from "./email-return-flow";

function renderDailyReports() {
  const list = qs<HTMLElement>("#dailyReportList");
  const detail = qs<HTMLElement>("#dailyReportDetail");
  const count = qs<HTMLElement>("#dailyReportListCount");
  const ownerFilter = qs<HTMLSelectElement>("#dailyReportOwnerFilter");
  const ownerWrap = qs<HTMLElement>("#dailyReportOwnerFilterWrap");
  const kpis = qs<HTMLElement>("#dailyReportKpis");
  if (!list || !detail) return;

  if (ownerWrap) ownerWrap.hidden = !state.dailyReportCanViewTeam;
  if (ownerFilter) {
    ownerFilter.innerHTML = `<option value="">全部成员</option>${state.dailyReportOwners.map((owner) =>
      `<option value="${escapeHtml(owner.id)}">${escapeHtml(owner.name)} · ${escapeHtml(roleLabel[owner.role])}</option>`
    ).join("")}`;
    ownerFilter.value = state.dailyReportOwnerId;
  }
  setFieldValue("#dailyReportFromInput", state.dailyReportFrom);
  setFieldValue("#dailyReportToInput", state.dailyReportTo);
  if (count) count.textContent = `${state.dailyReports.length} 份`;

  const now = new Date();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const weekStart = localDateValue(monday);
  const weekCount = state.dailyReports.filter((item) => item.reportDate >= weekStart).length;
  const ownerCount = new Set(state.dailyReports.map((item) => item.ownerId)).size;
  const commentCount = state.dailyReports.reduce((sum, item) => sum + Number(item.commentCount || 0), 0);
  if (kpis) {
    kpis.innerHTML = `
      <div><span>可见日报</span><b>${state.dailyReports.length}</b><small>当前筛选结果</small></div>
      <div><span>本周提交</span><b>${weekCount}</b><small>按日报日期统计</small></div>
      <div><span>提交成员</span><b>${ownerCount}</b><small>当前可见范围</small></div>
      <div><span>协作评论</span><b>${commentCount}</b><small>评论与回复留痕</small></div>
    `;
  }

  list.innerHTML = state.dailyReports.length ? state.dailyReports.map((report) => `
    <button class="daily-report-row ${report.id === state.selectedDailyReportId ? "active" : ""}" data-daily-report-id="${escapeHtml(report.id)}" type="button">
      <span class="daily-report-row-top">
        ${collaborationAvatar(report.owner)}
        <b>${escapeHtml(report.owner.name)}</b>
        <time>${escapeHtml(collaborationDate(report.reportDate))}</time>
      </span>
      <p>${escapeHtml(report.completedWork || "未填写完成工作")}</p>
      <span class="daily-report-row-foot"><span>${escapeHtml(report.results || report.customerProgress || "暂无结果摘要")}</span><span>${report.commentCount || 0} 条评论</span></span>
    </button>
  `).join("") : `<div class="collab-empty"><b>当前范围暂无日报</b></div>`;

  qsa<HTMLButtonElement>("[data-daily-report-id]", list).forEach((button) => {
    button.addEventListener("click", () => void loadDailyReportDetail(button.dataset.dailyReportId || ""));
  });

  if (!state.selectedDailyReportId) {
    detail.innerHTML = `<div class="collab-empty"><b>选择一份日报</b><span>工作进展、风险和管理反馈会显示在这里。</span></div>`;
  }
}

export async function refreshDailyReports(showToast = false) {
  try {
    const query = new URLSearchParams();
    if (state.dailyReportFrom) query.set("from", state.dailyReportFrom);
    if (state.dailyReportTo) query.set("to", state.dailyReportTo);
    if (state.dailyReportOwnerId) query.set("ownerId", state.dailyReportOwnerId);
    const result = await api<{ reports: DailyReport[]; owners: CollaborationUser[]; canViewTeam: boolean }>(
      `/api/daily-reports${query.size ? `?${query.toString()}` : ""}`
    );
    state.dailyReports = result.reports;
    state.dailyReportOwners = result.owners;
    state.dailyReportCanViewTeam = result.canViewTeam;
    if (!state.dailyReports.some((item) => item.id === state.selectedDailyReportId)) {
      state.selectedDailyReportId = state.dailyReports[0]?.id || null;
      state.dailyReportComments = [];
    }
    renderDailyReports();
    if (state.selectedDailyReportId) await loadDailyReportDetail(state.selectedDailyReportId, false);
    if (showToast) toast("团队日报已刷新");
  } catch (error) {
    toast(error instanceof Error ? error.message : "团队日报加载失败", "error");
  }
}

function reportSection(title: string, content: string, className = "", full = false) {
  return `
    <section class="daily-report-section ${className} ${full ? "full" : ""}">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(content || "未填写")}</p>
    </section>
  `;
}

function reportCommentHtml(comment: DailyReportComment, comments: DailyReportComment[], depth = 0): string {
  const children = comments.filter((item) => item.parentId === comment.id);
  return `
    <article class="report-comment ${depth ? "reply" : ""}">
      <div class="report-comment-head">
        ${collaborationAvatar(comment.author)}
        <b>${escapeHtml(comment.author.name)} · ${escapeHtml(roleLabel[comment.author.role])}</b>
        <time>${escapeHtml(collaborationDateTime(comment.createdAt))}</time>
      </div>
      <p>${escapeHtml(comment.content)}</p>
      <div class="report-comment-actions"><button type="button" data-reply-daily-comment="${escapeHtml(comment.id)}">回复</button></div>
    </article>
    ${children.map((child) => reportCommentHtml(child, comments, depth + 1)).join("")}
  `;
}

function renderDailyReportDetail(report: DailyReport, comments: DailyReportComment[]) {
  const detail = qs<HTMLElement>("#dailyReportDetail");
  if (!detail) return;
  const roots = comments.filter((item) => !item.parentId || !comments.some((candidate) => candidate.id === item.parentId));
  const canEdit = report.ownerId === state.user?.id;
  detail.innerHTML = `
    <div class="collab-detail-head">
      <div class="collab-author">
        ${collaborationAvatar(report.owner)}
        <div>
          <h2>${escapeHtml(report.owner.name)} · ${escapeHtml(collaborationDate(report.reportDate))}日报</h2>
          <p>${escapeHtml(roleLabel[report.owner.role])} · 提交于 ${escapeHtml(collaborationDateTime(report.submittedAt))}${report.updatedAt !== report.createdAt ? ` · 最近更新 ${escapeHtml(collaborationDateTime(report.updatedAt))}` : ""}</p>
        </div>
      </div>
      ${canEdit ? `<button class="btn" id="editDailyReportButton" type="button">修改日报</button>` : ""}
    </div>
    <div class="daily-report-content">
      ${reportSection("今日完成工作", report.completedWork, "", true)}
      ${reportSection("重点客户进展", report.customerProgress)}
      ${reportSection("结果与数据", report.results)}
      ${reportSection("风险与阻塞", report.risks, "is-risk")}
      ${reportSection("下一步计划", report.nextPlan)}
      ${reportSection("需要协助", report.supportNeeded, "", true)}
    </div>
    <section class="report-comments">
      <div class="report-comments-head"><h3>评论与回复</h3><span class="badge">${comments.length} 条</span></div>
      <div class="report-comment-list">${roots.length ? roots.map((comment) => reportCommentHtml(comment, comments)).join("") : `<div class="collab-empty" style="min-height:120px"><b>暂无评论</b><span>留下明确反馈，后续回复会自动通知相关成员。</span></div>`}</div>
      <div class="report-comment-composer">
        <textarea id="dailyReportCommentInput" placeholder="输入评论、建议或需要确认的问题"></textarea>
        <button class="btn primary" id="submitDailyReportCommentButton" type="button">发表评论</button>
      </div>
    </section>
  `;
  qs<HTMLButtonElement>("#editDailyReportButton", detail)?.addEventListener("click", () => openDailyReportModal(report));
  qs<HTMLButtonElement>("#submitDailyReportCommentButton", detail)?.addEventListener("click", (event) => {
    const content = qs<HTMLTextAreaElement>("#dailyReportCommentInput", detail)?.value.trim() || "";
    void submitDailyReportComment(report.id, "", content, event.currentTarget as HTMLButtonElement);
  });
  qsa<HTMLButtonElement>("[data-reply-daily-comment]", detail).forEach((button) => {
    button.addEventListener("click", () => {
      const comment = comments.find((item) => item.id === button.dataset.replyDailyComment);
      if (comment) openDailyReportReplyModal(report, comment);
    });
  });
}

async function loadDailyReportDetail(id: string, rerenderList = true) {
  if (!id) return;
  const detail = qs<HTMLElement>("#dailyReportDetail");
  if (detail) detail.innerHTML = `<div class="collab-empty"><b>正在读取日报</b><span>正在加载正文与评论。</span></div>`;
  try {
    const result = await api<{ report: DailyReport; comments: DailyReportComment[] }>(`/api/daily-reports/${encodeURIComponent(id)}`);
    state.selectedDailyReportId = result.report.id;
    state.dailyReportComments = result.comments;
    const index = state.dailyReports.findIndex((item) => item.id === result.report.id);
    if (index >= 0) state.dailyReports[index] = result.report;
    if (rerenderList) renderDailyReports();
    renderDailyReportDetail(result.report, result.comments);
  } catch (error) {
    if (detail) detail.innerHTML = `<div class="collab-empty"><b>日报读取失败</b><span>${escapeHtml(error instanceof Error ? error.message : "请稍后重试")}</span></div>`;
  }
}

export function openDailyReportModal(editing?: DailyReport) {
  if (editing && editing.ownerId !== state.user?.id) {
    toast("只能修改本人提交的日报", "error");
    return;
  }
  const todayReport = !editing
    ? state.dailyReports.find((item) => item.ownerId === state.user?.id && item.reportDate === localDateValue())
    : undefined;
  const report = editing || todayReport;
  openModal(report ? "修改日报" : "填写日报", `
    <div class="form-grid daily-report-form">
      <div class="form-field"><label>日报日期</label><input id="dailyReportDateInput" type="date" value="${escapeHtml(report?.reportDate || localDateValue())}"></div>
      <div class="form-field"><label>提交人</label><input value="${escapeHtml(state.user?.name || "")}" disabled></div>
      <div class="form-field full report-form-primary"><label>今日完成工作（必填）</label><textarea id="dailyReportCompletedInput" placeholder="写清完成事项、推进对象和当前状态">${escapeHtml(report?.completedWork || "")}</textarea></div>
      <div class="form-field full"><label>重点客户进展</label><textarea id="dailyReportCustomerInput" placeholder="客户、联系人、需求、报价或跟进结论">${escapeHtml(report?.customerProgress || "")}</textarea></div>
      <div class="form-field"><label>结果与数据</label><textarea id="dailyReportResultsInput" placeholder="询盘、报价、样品、成交金额等可量化结果">${escapeHtml(report?.results || "")}</textarea></div>
      <div class="form-field"><label>风险与阻塞</label><textarea id="dailyReportRisksInput" placeholder="客户异议、交期、价格、内部协同等风险">${escapeHtml(report?.risks || "")}</textarea></div>
      <div class="form-field"><label>下一步计划</label><textarea id="dailyReportNextPlanInput" placeholder="下一工作日准备推进的事项">${escapeHtml(report?.nextPlan || "")}</textarea></div>
      <div class="form-field"><label>需要协助</label><textarea id="dailyReportSupportInput" placeholder="需要主管或团队支持的事项">${escapeHtml(report?.supportNeeded || "")}</textarea></div>
      <p class="modal-note full">同一账号同一日期再次提交会更新原日报，不会产生重复记录。</p>
    </div>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveDailyReportButton">${report ? "保存更新" : "提交日报"}</button>`);
  qs<HTMLButtonElement>("#saveDailyReportButton")?.addEventListener("click", (event) => void saveDailyReport(event.currentTarget as HTMLButtonElement));
}

async function saveDailyReport(button: HTMLButtonElement) {
  const reportDate = qs<HTMLInputElement>("#dailyReportDateInput")?.value || "";
  const completedWork = qs<HTMLTextAreaElement>("#dailyReportCompletedInput")?.value.trim() || "";
  if (!reportDate || !completedWork) {
    toast("请选择日报日期并填写今日完成工作", "error");
    return;
  }
  button.disabled = true;
  button.textContent = "提交中";
  try {
    const result = await api<{ report: DailyReport; created: boolean }>("/api/daily-reports", {
      method: "POST",
      body: JSON.stringify({
        reportDate,
        completedWork,
        customerProgress: qs<HTMLTextAreaElement>("#dailyReportCustomerInput")?.value.trim() || "",
        results: qs<HTMLTextAreaElement>("#dailyReportResultsInput")?.value.trim() || "",
        risks: qs<HTMLTextAreaElement>("#dailyReportRisksInput")?.value.trim() || "",
        nextPlan: qs<HTMLTextAreaElement>("#dailyReportNextPlanInput")?.value.trim() || "",
        supportNeeded: qs<HTMLTextAreaElement>("#dailyReportSupportInput")?.value.trim() || ""
      })
    });
    closeModal();
    state.dailyReportFrom = "";
    state.dailyReportTo = "";
    state.dailyReportOwnerId = "";
    state.selectedDailyReportId = result.report.id;
    await Promise.all([refreshDailyReports(false), refreshInternalMessages(false)]);
    toast(result.created ? "日报已提交，管理者已收到站内通知" : "日报已更新");
  } catch (error) {
    toast(error instanceof Error ? error.message : "日报提交失败", "error");
  } finally {
    button.disabled = false;
    button.textContent = "提交日报";
  }
}

// ===== 日报自动生成（基于系统操作日志与业务数据） =====
interface DailyDraft {
  date: string;
  total: number;
  logins: number;
  productCreated: number; productUpdated: number; productDeleted: number;
  shipmentCreated: number; shipmentUpdated: number; shipmentDeleted: number; shipmentStatus: number;
  warnings: number; errors: number; exceptions: number;
  completedWork: string; customerProgress: string; results: string; risks: string; nextPlan: string; supportNeeded: string;
  attentionHtml: string; breakdownHtml: string; markdown: string;
}

function metaVal(meta: Record<string, unknown> | undefined, key: string): string {
  const v = meta ? meta[key] : undefined;
  return v === undefined || v === null ? "" : String(v);
}

export function nl2br(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

export function buildDailyDraft(dateStr: string): DailyDraft {
  const logs = (state.logs || []).filter((l) => (l.createdAt || "").slice(0, 10) === dateStr);
  const byCat: Record<string, number> = {};
  let logins = 0, productCreated = 0, productUpdated = 0, productDeleted = 0;
  let shipmentCreated = 0, shipmentUpdated = 0, shipmentDeleted = 0, shipmentStatus = 0;
  let warnings = 0, errors = 0;
  const productNames: string[] = [];
  const shipmentRefs: string[] = [];
  const actors = new Set<string>();
  for (const l of logs) {
    byCat[l.category] = (byCat[l.category] || 0) + 1;
    if (l.actorName) actors.add(l.actorName);
    if (l.level === "warning") warnings++;
    if (l.level === "error") errors++;
    switch (l.action) {
      case "login": logins++; break;
      case "create_product": { productCreated++; const n = metaVal(l.meta, "nameZh"); if (n) productNames.push(n); } break;
      case "update_product": productUpdated++; break;
      case "delete_product":
      case "bulk_delete_product": productDeleted++; break;
      case "create_shipment": { shipmentCreated++; const no = metaVal(l.meta, "shipmentNo"); if (no) shipmentRefs.push(no); } break;
      case "update_shipment": shipmentUpdated++; break;
      case "delete_shipment": shipmentDeleted++; break;
      case "change_status": { shipmentStatus++; const no = metaVal(l.meta, "shipmentNo"); if (no) shipmentRefs.push(no); } break;
      default: break;
    }
  }
  const exceptions = (state.shipments || []).filter((s) => s.status === "exception");
  const inTransit = (state.shipments || []).filter((s) => s.status === "in_transit" || s.status === "shipped").length;
  const uniqueRefs = Array.from(new Set(shipmentRefs));
  const actorText = actors.size ? `（${Array.from(actors).join("、")}）` : "";

  const completed: string[] = [];
  if (logins) completed.push(`系统登录 ${logins} 次${actorText}`);
  if (productCreated) completed.push(`新增产品 ${productCreated} 个${productNames.length ? `：${productNames.join("、")}` : ""}`);
  if (productUpdated) completed.push(`更新产品 ${productUpdated} 个`);
  if (productDeleted) completed.push(`删除产品 ${productDeleted} 个`);
  if (shipmentCreated) completed.push(`新增发货单 ${shipmentCreated} 个${uniqueRefs.length ? `（${uniqueRefs.slice(0, 3).join("、")}${uniqueRefs.length > 3 ? " 等" : ""}）` : ""}`);
  if (shipmentUpdated) completed.push(`更新发货单 ${shipmentUpdated} 个`);
  if (shipmentStatus) completed.push(`完成状态流转 ${shipmentStatus} 次`);
  if (shipmentDeleted) completed.push(`删除发货单 ${shipmentDeleted} 个`);
  if (warnings) completed.push(`产生 ${warnings} 条警告`);
  if (errors) completed.push(`产生 ${errors} 条错误`);
  if (!completed.length) completed.push("今日暂无系统操作记录");
  const completedWork = completed.map((c) => `· ${c}`).join("\n");

  const custLines = logs.filter((l) => l.category === "shipment").map((l) => `· ${l.message}`);
  const customerProgress = custLines.length ? custLines.join("\n") : "· 今日无发货相关客户进展";

  const results = [
    `新增产品 ${productCreated} 个，更新 ${productUpdated} 个`,
    `新增发货单 ${shipmentCreated} 个，状态流转 ${shipmentStatus} 次`,
    `当前在途发货 ${inTransit} 单，异常发货 ${exceptions.length} 单`,
    `今日系统操作合计 ${logs.length} 条（登录 ${logins} 次）`
  ].map((c) => `· ${c}`).join("\n");

  const riskLines: string[] = [];
  if (exceptions.length) riskLines.push(`· ${exceptions.length} 个发货单处于异常状态，需核实运单号与物流：${exceptions.map((e) => e.shipmentNo || e.dealTitle || e.id).join("、")}`);
  const warnLogs = logs.filter((l) => l.level === "warning" || l.level === "error");
  if (warnLogs.length) riskLines.push(`· ${warnLogs.length} 条警告/错误日志待关注`);
  if (!riskLines.length) riskLines.push("· 暂无重大风险");
  const risks = riskLines.join("\n");

  const nextPlan = [
    exceptions.length ? `跟进 ${exceptions.length} 个异常发货单，核实运单与物流状态` : "",
    `推进 ${inTransit} 个运输中/已发货单，预计到达前主动同步客户`,
    `梳理今日新增询盘与商机，安排次日跟进`,
    `对今日新增产品更新目录与报价资料`
  ].filter(Boolean).map((c) => `· ${c}`).join("\n");

  const supportNeeded = errors ? `· ${errors} 个系统错误待技术排查` : "· 暂无需要协助事项";

  const attItems: string[] = [];
  exceptions.forEach((e) => {
    attItems.push(`<div class="dy-att-item dy-att-ex"><span class="dy-att-ico">${LOG_LEVEL_ICON.error}</span><div><b>${escapeHtml(e.shipmentNo || e.dealTitle || "发货单")}</b><span>异常 · ${escapeHtml(e.customerName || "")}</span></div></div>`);
  });
  warnLogs.forEach((l) => {
    attItems.push(`<div class="dy-att-item dy-att-warn"><span class="dy-att-ico">${LOG_LEVEL_ICON[l.level]}</span><div><b>${escapeHtml(l.message)}</b><span>${LOG_CATEGORY_LABEL[l.category]} · ${escapeHtml(l.actorName || "")}</span></div></div>`);
  });
  const attentionHtml = attItems.length ? attItems.join("") : `<div class="dy-att-empty">暂无需要关注的事项</div>`;

  const cats: LogCategory[] = ["auth", "product", "shipment", "system"];
  const maxCat = Math.max(1, ...cats.map((c) => byCat[c] || 0));
  const breakdownHtml = cats.map((c) => {
    const v = byCat[c] || 0;
    const pct = v ? Math.round((v / maxCat) * 100) : 0;
    return `<div class="dy-bar"><span class="dy-bar-label">${LOG_CATEGORY_LABEL[c]}</span><span class="dy-bar-track"><i style="width:${pct}%"></i></span><span class="dy-bar-val">${v}</span></div>`;
  }).join("");

  const markdown = `# GoodJob CRM 每日经营日报（${dateStr}）

## 今日完成工作
${completedWork}

## 重点客户进展
${customerProgress}

## 结果与数据
${results}

## 风险与阻塞
${risks}

## 下一步计划
${nextPlan}

## 需要协助
${supportNeeded}

---
> 本报告由系统根据操作日志与业务数据自动生成。
`;

  return {
    date: dateStr, total: logs.length, logins,
    productCreated, productUpdated, productDeleted,
    shipmentCreated, shipmentUpdated, shipmentDeleted, shipmentStatus,
    warnings, errors, exceptions: exceptions.length,
    completedWork, customerProgress, results, risks, nextPlan, supportNeeded,
    attentionHtml, breakdownHtml, markdown
  };
}

export function fillDailyReportFromDraft(): void {
  const draft = buildDailyDraft(dailyAutoDate || localDateValue());
  openDailyReportModal();
  window.setTimeout(() => {
    const setVal = (sel: string, v: string) => { const el = qs<HTMLTextAreaElement>(sel); if (el) el.value = v; };
    setVal("#dailyReportCompletedInput", draft.completedWork);
    setVal("#dailyReportCustomerInput", draft.customerProgress);
    setVal("#dailyReportResultsInput", draft.results);
    setVal("#dailyReportRisksInput", draft.risks);
    setVal("#dailyReportNextPlanInput", draft.nextPlan);
    setVal("#dailyReportSupportInput", draft.supportNeeded);
  }, 0);
  toast("已自动生成并填入日报，请检查后提交", "ok");
}

async function submitDailyReportComment(reportId: string, parentId: string, content: string, button?: HTMLButtonElement) {
  if (!content) {
    toast("请输入评论内容", "error");
    return;
  }
  if (button) {
    button.disabled = true;
    button.textContent = "发送中";
  }
  try {
    await api(`/api/daily-reports/${encodeURIComponent(reportId)}/comments`, {
      method: "POST",
      body: JSON.stringify({ content, parentId })
    });
    closeModal();
    await Promise.all([loadDailyReportDetail(reportId), refreshInternalMessages(false)]);
    toast(parentId ? "回复已发送" : "评论已发表");
  } catch (error) {
    toast(error instanceof Error ? error.message : "评论发送失败", "error");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = parentId ? "发送回复" : "发表评论";
    }
  }
}

function openDailyReportReplyModal(report: DailyReport, comment: DailyReportComment) {
  openModal(`回复 ${comment.author.name}`, `
    <div class="form-field full">
      <label>回复内容</label>
      <textarea id="dailyReportReplyInput" rows="6" placeholder="针对这条评论继续沟通"></textarea>
    </div>
    <p class="modal-note">回复会保留在 ${escapeHtml(collaborationDate(report.reportDate))} 日报下，并通过消息通知提醒对方。</p>
  `, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="sendDailyReportReplyButton">发送回复</button>`);
  qs<HTMLButtonElement>("#sendDailyReportReplyButton")?.addEventListener("click", (event) => {
    const content = qs<HTMLTextAreaElement>("#dailyReportReplyInput")?.value.trim() || "";
    void submitDailyReportComment(report.id, comment.id, content, event.currentTarget as HTMLButtonElement);
  });
}

function internalMessageActionLabel(message: InternalMessage) {
  if (message.relatedType === "daily_report" && message.relatedId) return "查看日报";
  if (message.relatedType === "lead" && message.relatedId) return "查看线索";
  if (message.relatedType === "email_return" && message.relatedId) return "查看邮件回流";
  if (message.relatedType === "quote_history" && message.relatedId) return "查看报价变化";
  if (message.relatedType === "integration_approval") return "处理审批";
  if (message.relatedType === "integration_call") return "查看运行记录";
  if (message.relatedType === "integration_connection") return "查看连接";
  if (message.relatedType === "integration_event") return "查看事件";
  if (message.relatedType === "integration_connector") return "查看连接器审核";
  return "查看消息";
}

function internalMessageIcon(message: InternalMessage) {
  if (message.relatedType === "daily_report") {
    return `<svg viewBox="0 0 24 24"><path d="M6 3h12a2 2 0 0 1 2 2v16H4V5a2 2 0 0 1 2-2Z"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24"><path d="M4 5h16v12H8l-4 4V5Z"/><path d="M8 9h8M8 13h5"/></svg>`;
}

function showInternalMessage(message: InternalMessage) {
  openModal("消息详情", `
    <div class="collab-detail-head">
      <div class="collab-author">
        ${collaborationAvatar(message.sender)}
        <div>
          <h2>${escapeHtml(message.subject)}</h2>
          <p>${escapeHtml(message.sender.name)} · ${escapeHtml(roleLabel[message.sender.role])} · ${escapeHtml(collaborationDateTime(message.createdAt))}</p>
        </div>
      </div>
      ${message.type === "system" ? badge("系统通知", "amber") : badge("团队消息", "green")}
    </div>
    <div class="inbox-message-content">${escapeHtml(message.content)}</div>
  `, `<button class="btn primary" data-modal-close>关闭</button>`);
}

function navigateFromInternalMessage(message: InternalMessage) {
  if (message.relatedType === "daily_report" && message.relatedId) {
    state.dailyReportFrom = "";
    state.dailyReportTo = "";
    state.dailyReportOwnerId = "";
    state.selectedDailyReportId = message.relatedId;
    activateNavView("daily-reports");
    return;
  }
  if (message.relatedType === "lead" && message.relatedId) {
    activateNavView("leads");
    void reloadLeads().then(() => openLead(message.relatedId)).catch((error) => {
      toast(error instanceof Error ? error.message : "线索加载失败", "error");
    });
    return;
  }
  if (message.relatedType === "email_return" && message.relatedId) {
    activateNavView("email-return-flow");
    void openEmailReturnDetail(message.relatedId);
    return;
  }
  if (message.relatedType === "quote_history" && message.relatedId) {
    state.quoteHistoryFocusId = message.relatedId;
    state.quoteHistoryPage = 1;
    activateNavView("documents");
    setDocumentWorkspaceMode("quote-history");
    return;
  }
  if (["integration_approval", "integration_call", "integration_connection", "integration_event", "integration_connector"].includes(message.relatedType)) {
    activateNavView("integration-center");
    void integrationCenterController?.refresh(false).finally(() => {
      const tab = message.relatedType === "integration_approval" ? "approvals"
        : message.relatedType === "integration_connection" ? "connected"
          : message.relatedType === "integration_event" ? "events"
            : message.relatedType === "integration_connector" ? "connector-reviews" : "activity";
      qs<HTMLButtonElement>(`#integration-center [data-integration-tab="${tab}"]`)?.click();
    });
    return;
  }
  showInternalMessage(message);
}

function renderInbox() {
  const list = qs<HTMLElement>("#inboxMessageList");
  if (!list) return;
  updateInternalMessageBadge();
  list.innerHTML = state.internalMessages.length ? state.internalMessages.map((message) => {
    const unread = !message.readAt;
    return `
      <button class="notification-message-row ${unread ? "unread" : ""}" data-internal-message-id="${escapeHtml(message.id)}" type="button">
        <span class="notification-message-icon">${internalMessageIcon(message)}</span>
        <span class="notification-message-body">
          <span class="notification-message-meta">
            <strong>${escapeHtml(message.sender.name)} · ${message.type === "system" ? "系统提醒" : "团队消息"}</strong>
            <time>${escapeHtml(collaborationDateTime(message.createdAt))}</time>
          </span>
          <b>${escapeHtml(message.subject)}</b>
          <p>${escapeHtml(message.content)}</p>
        </span>
        <span class="notification-message-action">
          <span>${internalMessageActionLabel(message)} →</span>
          <small>${unread ? "未读" : "已读"}</small>
        </span>
      </button>
    `;
  }).join("") : `<div class="notification-center-empty"><span class="notification-empty-icon" aria-hidden="true">✓</span><b>消息已全部处理</b><span>每日跟进待办、客户风险和系统提醒会集中显示在这里。</span></div>`;
  qsa<HTMLButtonElement>("[data-internal-message-id]", list).forEach((button) => {
    button.addEventListener("click", () => void openInternalMessage(button.dataset.internalMessageId || ""));
  });
}

export async function refreshInternalMessages(showToast = false) {
  const list = qs<HTMLElement>("#inboxMessageList");
  const refreshButton = qs<HTMLButtonElement>("#inboxRefreshButton");
  if (!state.internalMessages.length && list) {
    list.innerHTML = `<div class="notification-skeleton" role="status" aria-label="正在加载消息通知">${Array.from({ length: 4 }, () => `<div class="notification-skeleton-row"><i></i><span><b></b><small></small><small></small></span><em></em></div>`).join("")}</div>`;
  }
  if (showToast) setButtonPending(refreshButton, true, "刷新", "正在刷新");
  try {
    const messages = await api<{ messages: InternalMessage[]; unreadCount: number }>("/api/internal-messages?box=inbox");
    state.internalMessages = messages.messages;
    state.internalUnreadCount = messages.unreadCount;
    renderInbox();
    if (showToast) toast("消息通知已刷新");
  } catch (error) {
    if (!state.internalMessages.length && list) {
      list.innerHTML = `<div class="notification-center-error" role="alert"><span class="notification-error-icon" aria-hidden="true">!</span><b>消息暂时无法加载</b><span>${escapeHtml(error instanceof Error ? error.message : "请检查网络后重试")}</span><button class="btn" id="inboxInlineRetryButton" type="button">重新加载</button></div>`;
      qs<HTMLButtonElement>("#inboxInlineRetryButton")?.addEventListener("click", () => void refreshInternalMessages(false));
    }
    toast(error instanceof Error ? error.message : "消息通知加载失败", "error");
  } finally {
    if (showToast) setButtonPending(refreshButton, false, "刷新", "正在刷新");
  }
}

export async function refreshInternalMessageBadge() {
  if (!state.user) return;
  try {
    const result = await api<{ unreadCount: number }>("/api/internal-messages/unread-count");
    state.internalUnreadCount = Math.max(0, Number(result.unreadCount || 0));
    updateInternalMessageBadge();
  } catch {
    // The full inbox refresh will surface an actionable error when the user opens messages.
  }
}

export async function markAllInternalMessagesRead() {
  const button = qs<HTMLButtonElement>("#inboxMarkAllReadButton");
  if (button) setButtonPending(button, true, "全部已读", "处理中");
  try {
    const result = await api<{ updatedCount: number; unreadCount: number }>("/api/internal-messages/read-all", { method: "POST" });
    const readAt = new Date().toISOString();
    state.internalMessages.forEach((message) => {
      if (!message.readAt) message.readAt = readAt;
    });
    state.internalUnreadCount = result.unreadCount;
    renderInbox();
    toast(result.updatedCount ? `已标记 ${result.updatedCount} 条消息为已读` : "没有未读消息");
  } catch (error) {
    toast(error instanceof Error ? error.message : "批量标记已读失败", "error");
  } finally {
    if (button) setButtonPending(button, false, "全部已读", "处理中");
  }
}

async function openInternalMessage(id: string) {
  const message = state.internalMessages.find((item) => item.id === id);
  if (!message) return;
  if (!message.readAt) {
    try {
      const result = await api<{ message: InternalMessage }>(`/api/internal-messages/${encodeURIComponent(id)}/read`, { method: "POST" });
      Object.assign(message, result.message);
      state.internalUnreadCount = Math.max(0, state.internalUnreadCount - 1);
    } catch (error) {
      toast(error instanceof Error ? error.message : "消息已打开，但已读状态更新失败", "error");
    }
  }
  renderInbox();
  navigateFromInternalMessage(message);
}
