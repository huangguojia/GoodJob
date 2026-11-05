/**
 * 经营汇报。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import { closeModal, openModal, state } from "../prototype-api";
import { type CollaborationUser, type ExecutiveReport } from "./models";
import { badge, escapeHtml, qs } from "./shared";
import { api, toast } from "./ui";
import { reportMoneyHtml, reportMoneyText } from "./customer-intake";

function renderExecutiveReport(report: ExecutiveReport) {
  state.executiveReport = report;
  state.reportNote = report.reportNote || "";
  const generatedAt = new Date(report.period.asOf);
  const generatedText = Number.isFinite(generatedAt.getTime())
    ? generatedAt.toLocaleString("zh-CN", { hour12: false })
    : report.period.asOf;
  const setText = (selector: string, value: string) => {
    const node = qs<HTMLElement>(selector);
    if (node) node.textContent = value;
  };
  const setHtml = (selector: string, value: string) => {
    const node = qs<HTMLElement>(selector);
    if (node) node.innerHTML = value;
  };
  setText("#reportPeriod", `${report.title} · ${report.period.label}`);
  setText("#reportGeneratedAt", `GoodJob CRM · 生成于 ${generatedText}`);
  setText("#reportHeadline", report.headline);
  setText("#reportHeroNote", state.reportNote || report.note);
  setText("#reportScope", `范围：${report.scope.label}`);
  setText("#reportAmountBasis", `金额口径：${report.amountBasis.label}`);
  setText("#reportDataStatus", `数据状态：${report.dataStatus}`);
  setHtml("#reportWeightedForecast", reportMoneyHtml(report.metrics.weightedForecast));
  setHtml("#reportExpectedAmount", reportMoneyHtml(report.metrics.expectedThisMonth));
  setHtml("#reportRiskAmount", reportMoneyHtml(report.metrics.riskAmounts));
  setHtml("#reportWinRate", `<b>${report.metrics.winRate === null ? "暂无可计算数据" : `${report.metrics.winRate}%`}</b><span>${report.metrics.closedCount} 个本月已关闭商机</span>`);
  setHtml("#reportConclusions", report.conclusions.map((item, index) => `
    <div class="summary-card"><strong>结论 ${index + 1}：${escapeHtml(item.title)}</strong><p>${escapeHtml(item.detail)}</p></div>
  `).join(""));
  setHtml("#reportFunnel", report.funnel.map((row) => `
    <div class="funnel-step">
      <b>${escapeHtml(row.stage)}</b>
      <div class="bar" style="--w:${Math.max(0, Math.min(100, row.width))}%"></div>
      <span>${row.count} 单</span>
      <strong title="${escapeHtml(reportMoneyText(row.amounts))}">${escapeHtml(reportMoneyText(row.amounts))}${row.riskCount ? ` · 风险 ${row.riskCount}` : ""}</strong>
    </div>
  `).join(""));
  setHtml("#reportActions", report.actions.length ? report.actions.map((item, index) => `
    <div class="insight-item"><i>${index + 1}</i><div><b>${escapeHtml(item.title)}</b><span>${escapeHtml(item.detail)}</span></div></div>
  `).join("") : `<div class="insight-item"><i>✓</i><div><b>暂无紧急行动项</b><span>当前范围未识别到风险商机或本月预计成交商机。</span></div></div>`);
  const marketColors = ["var(--brand)", "var(--green)", "var(--amber)", "var(--violet)", "var(--rose)"];
  setHtml("#reportMarket", report.market.length ? report.market.map((row, index) => `
    <span><i style="--color:${marketColors[index % marketColors.length]}"></i>${escapeHtml(row.region)} ${row.share}% · ${row.count} 单 · ${escapeHtml(reportMoneyText(row.amounts))}${row.riskCount ? ` · 风险 ${row.riskCount}` : ""}</span>
  `).join("") : `<span class="report-empty">暂无市场数据</span>`);
  const donut = qs<HTMLElement>("#reports .donut");
  if (donut) {
    let cursor = 0;
    const segments = report.market.map((row, index) => {
      const start = cursor;
      cursor += row.share;
      return `${marketColors[index % marketColors.length]} ${start}% ${cursor}%`;
    });
    donut.style.background = segments.length ? `conic-gradient(${segments.join(",")})` : "#e8edf5";
  }
  const maxForecastCount = Math.max(...report.forecastByStage.map((row) => row.count), 1);
  setHtml("#reportForecast", report.forecastByStage.map((row, index) => `
    <div><i style="--h:${row.count ? Math.max(18, Math.round((row.count / maxForecastCount) * 150)) : 4}px; --c:${marketColors[index % marketColors.length]}"></i>
    <span>${escapeHtml(row.stage)} ${Math.round(row.weight * 100)}%<br>${escapeHtml(reportMoneyText(row.weightedAmounts))}</span></div>
  `).join(""));
  setText("#reportPerformanceTitle", report.performanceTitle);
  setHtml("#reportPerformanceRows", report.performance.length ? report.performance.map((row) => `
    <tr><td>${escapeHtml(row.owner)}</td><td>${row.customerCount}</td><td>${row.followUpCount}</td><td>${row.activeDealCount}</td><td>${escapeHtml(reportMoneyText(row.forecastAmounts))}</td><td>${badge(row.riskLabel, row.riskCount ? "amber" : "green")}</td></tr>
  `).join("") : `<tr><td colspan="6">暂无可展示人员数据</td></tr>`);
  setHtml("#reportPerformanceCards", report.performance.length ? report.performance.map((row) => `
    <article class="report-performance-card">
      <header><b>${escapeHtml(row.owner)}</b>${badge(row.riskLabel, row.riskCount ? "amber" : "green")}</header>
      <dl>
        <div><dt>客户</dt><dd>${row.customerCount}</dd></div>
        <div><dt>本月跟进</dt><dd>${row.followUpCount}</dd></div>
        <div><dt>活跃商机</dt><dd>${row.activeDealCount}</dd></div>
        <div><dt>加权预测</dt><dd>${escapeHtml(reportMoneyText(row.forecastAmounts))}</dd></div>
      </dl>
    </article>
  `).join("") : `<div class="report-empty">暂无可展示人员数据</div>`);
  setHtml("#reportDefinitions", report.definitions.map((item) => `<li>${escapeHtml(item)}</li>`).join(""));
  const riskButton = qs<HTMLButtonElement>("#reportRiskDetailButton");
  if (riskButton) {
    riskButton.textContent = `查看风险明细（${report.riskRows.length}）`;
    riskButton.disabled = report.riskRows.length === 0;
  }
}

export async function refreshExecutiveReport(showToast = false) {
  const button = qs<HTMLButtonElement>("#reportRefreshButton");
  try {
    if (button) { button.disabled = true; button.textContent = "刷新中"; }
    const report = await api<ExecutiveReport>("/api/reports/executive");
    renderExecutiveReport(report);
    if (showToast) toast("经营快照已刷新");
  } catch (error) {
    toast(error instanceof Error ? error.message : "经营快照加载失败", "error");
  } finally {
    if (button) { button.disabled = false; button.textContent = "刷新数据"; }
  }
}

export function openReportRiskModal() {
  const rows = state.executiveReport?.riskRows || [];
  if (!rows.length) {
    toast("当前范围暂无风险商机");
    return;
  }
  openModal("风险商机明细", `
    <div class="insight-list">${rows.map((row, index) => `
      <div class="insight-item">
        <i>${index + 1}</i>
        <div><b>${escapeHtml(row.customer)} · ${escapeHtml(row.stage)} · ${escapeHtml(row.currency)} ${Number(row.amount).toLocaleString("en-US")}</b>
        <span>${escapeHtml(row.owner)} · ${escapeHtml(row.riskReasons.join("、"))}<br>下一动作：${escapeHtml(row.nextAction || "待补充")} · 预计成交：${escapeHtml(row.expectedCloseAt || "待补充")}</span></div>
      </div>
    `).join("")}</div>
  `, `<button class="btn primary" data-modal-close>关闭</button>`);
}

export async function exportReport() {
  const report = state.executiveReport || await api<ExecutiveReport>("/api/reports/executive");
  if (!state.executiveReport) renderExecutiveReport(report);
  const content = [
    report.title,
    `统计范围：${report.scope.label}`,
    `统计期间：${report.period.label}`,
    `生成时间：${report.period.asOf}`,
    `金额口径：${report.amountBasis.label}`,
    `数据状态：${report.dataStatus}`,
    "",
    report.headline,
    state.reportNote || report.note,
    "",
    `活跃管道：${reportMoneyText(report.metrics.activePipeline)}`,
    `阶段加权预测：${reportMoneyText(report.metrics.weightedForecast)}`,
    `本月预计成交：${reportMoneyText(report.metrics.expectedThisMonth)}`,
    `本月已成交：${reportMoneyText(report.metrics.wonThisMonth)}`,
    `风险商机：${report.metrics.riskDealCount} 个，${reportMoneyText(report.metrics.riskAmounts)}`,
    `本月赢单率：${report.metrics.winRate === null ? "暂无可计算数据" : `${report.metrics.winRate}%`}`,
    "",
    "经营结论",
    ...report.conclusions.map((item, index) => `${index + 1}. ${item.title}：${item.detail}`),
    "",
    "管理动作",
    ...(report.actions.length ? report.actions.map((item, index) => `${index + 1}. ${item.title}：${item.detail}`) : ["暂无紧急行动项"]),
    "",
    "统计定义",
    ...report.definitions.map((item, index) => `${index + 1}. ${item}`)
  ].join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "GoodJob-CRM-经营汇报.txt";
  link.click();
  URL.revokeObjectURL(link.href);
  toast("汇报已生成下载");
}

export function openReportNoteModal() {
  openModal("汇报备注", `<div class="form-field full"><label>备注</label><input id="reportNoteInput" value="${escapeHtml(state.reportNote)}" placeholder="补充本周管理重点，不会覆盖系统统计结论"></div>`, `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="saveReportNoteButton">保存备注</button>`);
  qs("#saveReportNoteButton")?.addEventListener("click", saveReportNote);
}

async function saveReportNote() {
  const note = qs<HTMLInputElement>("#reportNoteInput")?.value.trim() || "";
  const result = await api<{ note: string }>("/api/reports/executive/note", {
    method: "PATCH",
    body: JSON.stringify({ note })
  });
  state.reportNote = result.note;
  const hero = qs<HTMLElement>("#reportHeroNote");
  if (hero) hero.textContent = state.reportNote || state.executiveReport?.note || "";
  closeModal();
  toast("汇报备注已保存");
}

export function localDateValue(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function collaborationDate(value: string) {
  if (!value) return "日期待确认";
  const date = new Date(`${value}T00:00:00`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" })
    : value;
}

export function collaborationDateTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    : value;
}

export function collaborationAvatar(user?: CollaborationUser) {
  return `<span class="collab-avatar">${escapeHtml(user?.avatar || user?.name?.slice(0, 2) || "--")}</span>`;
}

export function updateInternalMessageBadge() {
  const unread = Math.max(0, state.internalUnreadCount);
  const bell = qs<HTMLButtonElement>("#notificationBellButton");
  const bellBadge = qs<HTMLElement>("#notificationBellBadge");
  const count = qs<HTMLElement>("#inboxUnreadCount");
  if (count) count.textContent = String(unread);
  if (bell) {
    bell.classList.toggle("has-unread", unread > 0);
    bell.title = unread ? `消息通知，${unread} 条未读` : "消息通知";
    bell.setAttribute("aria-label", bell.title);
  }
  if (bellBadge) {
    bellBadge.hidden = unread === 0;
    bellBadge.textContent = unread > 99 ? "99+" : String(unread);
  }
}
