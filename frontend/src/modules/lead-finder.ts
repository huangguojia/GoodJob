/**
 * AI 搜客任务、清洗统计、候选、深挖、反馈、运行计划。
 *
 * 由 prototype-api.ts 拆分而来：代码逐字迁移。本模块只包含函数、类型和字面量初始化的状态，
 * 加载期执行的代码（顶层语句与依赖其他变量的初始化）都留在入口 prototype-api.ts，按原顺序执行。
 */
import {
  activateNavView, confirmAction, createLeadFinderJob, leadFinderCleaningFilter, leadFinderJobs, loadProspectRuns,
  renderLeadFinderResultView, renderProspectList, shortlistLeadFinderRows, state
} from "../prototype-api";
import {
  type LeadFinderIncrementalStats, type LeadFinderJob, type LeadFinderSourceStat, type LeadTaskStreamLog,
  type OrganizationIdentityConflictItem, type ProspectAcceptanceApi, type ProspectDeepMiningApi,
  type ProspectLiveEventApiRecord, type ProspectPendingCandidatePreview, type ProspectPerformance,
  type ProspectQualificationViewApi, type ProspectRunApiRecord, type ProspectRunApiStatus,
  type ProspectRunCleaningReport, type ProspectRunDetailApiResponse, type ProspectRunEventApiRecord,
  type ProspectRunShardApiRecord, type ProspectScheduleApiRecord, type ProspectScoreComponentApi,
  type ProspectStrategySuggestion, type ProspectStrategySuggestionType, type ProspectSuperSearchMissionApi,
  type ResearchEngineSource, type WebsiteOpportunity
} from "./models";
import { formatTime, ownerName } from "./dashboard";
import {
  buildLeadFinderJobDetails, buildProspectPoolRadarModel, currentLeadFinderResults, currentLeadFinderTitle,
  fillProspectResearchSourceSelect, isLeadFinderJobTerminal, latestWebsiteProbe, leadFinderDuplicateState,
  leadFinderJobStatusText, leadFinderJobStatusTone, leadFinderLiveElapsed, leadFinderLiveStage,
  leadFinderLiveTransportLabel, leadFinderScore, leadFinderSourceWaitText, leadFinderWaitState,
  loadProspectResearchHistory, normalizeWebsiteLink, openProspectLead, openProspectPoolRadar, openProspectRadar,
  primaryLeadFinderLiveJob, prospectRadarActiveJobId, prospectRadarController, prospectRequestId,
  prospectResearchButtonLabel, prospectResearchRunning, prospectStatusMeta, renderExtractedContactsPanel,
  renderProspectLookupDiagnosis, renderProspectPoolRadarMetrics, renderWebsiteDiscoveryPanel,
  renderWebsiteOpportunities, renderWebsiteProbePanel, researchRunningBadgeHtml, runProspectBackgroundResearch,
  startContactEnrichment, startWebsiteProbe, syncProspectRadar, websiteContactDisplay, websiteContactPersonDisplay,
  websiteDomain, websiteProbePolicyBlockReason
} from "./prospecting";
import { badge, escapeHtml, leadFinderDisplayText, leadFinderStreamCursors, qs, qsa } from "./shared";
import { cliWaitPanelHtml, effectiveResearchSource, startCliWaitTicker } from "./ai-engine-settings";
import { api, toast } from "./ui";
import { hasIamCapability } from "./auth";
import { dealMoney } from "./deals";
import { canSelectLeadFinderItem, openLeadSourceCenter, renderLeadFinder, syncLeadRowFields } from "./lead-sources";

let leadFinderRunPollTimer = 0;
let leadFinderStreamAbort: AbortController | null = null;
export let leadFinderStreamRunId = "";
export let leadFinderStreamConnected = false;
let leadFinderStreamRefreshTimer = 0;
let leadFinderOpportunityRefreshPending = false;
let websiteProbeRefreshTimer = 0;
let websiteProbeRefreshDeadline = 0;
export let activeLeadFinderJobId: string | null = null;
let leadTaskDetailClockTimer = 0;
let prospectFeedbackLoading = false;
let prospectFeedbackLoadedAt = 0;

function renderLeadFinderLiveOverview() {
  const box = qs<HTMLElement>("#leadFinderLiveOverview");
  if (!box) return;
  const job = primaryLeadFinderLiveJob();
  if (!job) {
    box.innerHTML = `
      <div class="lead-live-empty">
        <div class="lead-live-empty-mark" aria-hidden="true">AI</div>
        <div>
          <span>搜客助手</span>
          <h2>从一份客户简报开始</h2>
          <p>任务启动后，检索、验证、清洗和候选入池会在这里按事实持续打印。</p>
          <div class="lead-live-empty-actions">
            <button class="lead-live-empty-action" type="button" data-lead-empty-start>新建搜客任务</button>
            <button class="lead-live-empty-action" type="button" data-lead-empty-cli data-permission="prospect.execute">CLI 获客</button>
            <button class="lead-radar-launch" type="button" data-lead-pool-radar><span aria-hidden="true">▶</span>${state.websiteOpportunities.length ? "回放候选池" : "打开全球雷达"}</button>
          </div>
        </div>
      </div>`;
    qs<HTMLButtonElement>("[data-lead-pool-radar]", box)?.addEventListener("click", () => void openProspectPoolRadar());
    return;
  }
  const pipeline = job.cleaningReport?.summary;
  const rawCount = pipeline?.providerRawCount ?? job.incrementalStats?.rawCount ?? 0;
  const cleaningCount = pipeline
    ? pipeline.providerInvalidCount + pipeline.providerDuplicateCount + pipeline.rejectedCount + pipeline.suppressedCount + pipeline.mergedCount
    : job.incrementalStats?.deduplicatedCount ?? 0;
  const candidateCount = pipeline?.candidateCount ?? job.incrementalStats?.newCount ?? job.resultCount ?? 0;
  const sourceCount = job.sourceStats?.length || job.channelCount;
  const settledSourceCount = (job.sourceStats || []).filter((source) =>
    ["succeeded", "succeeded_empty", "partial_success", "failed", "cancelled", "success", "success_empty"].includes(source.status || "")
  ).length;
  const stage = leadFinderLiveStage(job);
  const waitState = leadFinderWaitState(job);
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const transport = leadFinderLiveTransportLabel(job);
  const allLogs = leadTaskDetailLogs(job);
  const logs = allLogs.slice(-12);
  const hiddenLogCount = Math.max(0, allLogs.length - logs.length);
  const lastUpdatedAt = logs[logs.length - 1]?.at || job.createdAt;
  const statusText = leadFinderJobStatusText(job);
  const terminal = isLeadFinderJobTerminal(job);
  const sourceFact = job.backendRunId
    ? `${settledSourceCount}/${sourceCount} 来源结束`
    : terminal
      ? `${candidateCount} 条链接已解析`
      : `${sourceCount} 个搜索入口`;
  const requestLines = (job.detailLines || [job.subtitle])
    .filter(Boolean)
    .slice(0, 5)
    .map((line) => line === "客户类型：*" ? "客户类型：全部客户类型" : line);
  const discoveries = (job.resultIds || [])
    .map((id) => state.websiteOpportunities.find((item) => item.id === id))
    .filter(Boolean) as WebsiteOpportunity[];
  const deepMining = job.deepMining;
  const activeDeepTask = deepMining?.tasks.find((item) => item.id === deepMining.activeTaskId)
    || [...(deepMining?.tasks || [])].reverse().find((item) => ["searching", "verifying", "completed"].includes(item.status));
  const activeDeepNode = activeDeepTask
    ? deepMining?.nodes.find((item) => item.id === activeDeepTask.nodeId)
    : undefined;
  const latestDeepEvidence = deepMining?.evidence[deepMining.evidence.length - 1];
  const previousThread = qs<HTMLElement>(".lead-live-thread", box);
  const previousConsole = qs<HTMLElement>(".lead-live-console", box);
  const sameJob = previousConsole?.dataset.leadLiveJobId === job.id;
  const previousScrollTop = sameJob ? previousThread?.scrollTop || 0 : 0;
  const wasFollowing = !sameJob
    || previousThread?.dataset.follow !== "false"
    || Boolean(previousThread && previousThread.scrollHeight - previousThread.scrollTop - previousThread.clientHeight < 72);
  const previousLastEventKey = sameJob ? previousThread?.dataset.lastEventKey || "" : "";
  const lastEventKey = logs[logs.length - 1]?.key || "";
  const hasNewEvent = Boolean(lastEventKey && lastEventKey !== previousLastEventKey);
  box.innerHTML = `
    <div class="lead-live-console" data-lead-live-job-id="${escapeHtml(job.id)}">
      <div class="lead-live-console-head">
        <div>
          <div class="lead-live-kicker"><span>${terminal ? "最近一次执行" : "当前任务"}</span><span class="lead-live-connection ${transport.tone}" id="leadFinderLiveConnection">${escapeHtml(transport.text)}</span></div>
          <div class="lead-live-title-line"><h2>${escapeHtml(job.title)}</h2>${terminal ? "" : badge(statusText, leadFinderJobStatusTone(job))}</div>
          <div class="lead-live-meta"><span>${job.superSearchMissionId ? "超级搜索" : "标准搜索"}</span><span>开始于 ${escapeHtml(leadTaskDetailDateTime(job.createdAt))}</span><span>已耗时 ${escapeHtml(leadFinderLiveElapsed(job))}</span><span>更新于 ${escapeHtml(leadTaskDetailTime(lastUpdatedAt))}</span></div>
        </div>
        <div class="lead-live-actions">
          <button class="lead-radar-launch" type="button" data-lead-live-radar><span aria-hidden="true">▶</span>${terminal ? "重新演示" : "实时回放"}</button>
          <button class="btn" type="button" data-lead-live-open>查看详情</button>
          ${job.backendRunId && job.backendRunStatus === "queued" ? `<button class="btn" type="button" data-lead-live-action="pause">暂停</button>` : ""}
          ${job.backendRunId && job.backendRunStatus === "paused" ? `<button class="btn primary" type="button" data-lead-live-action="resume">恢复</button>` : ""}
          ${job.backendRunId && ["queued", "paused"].includes(job.backendRunStatus || "") ? `<button class="btn danger" type="button" data-lead-live-action="cancel">取消</button>` : ""}
        </div>
      </div>
      <div class="lead-live-thread" role="log" tabindex="0" aria-label="任务执行动态" aria-live="polite" aria-relevant="additions text" data-follow="${wasFollowing ? "true" : "false"}" data-last-event-key="${escapeHtml(lastEventKey)}">
        <article class="lead-live-message is-request">
          <div class="lead-live-avatar" aria-hidden="true">你</div>
          <div class="lead-live-bubble">
            <div class="lead-live-message-meta"><b>本次搜索目标</b><time>${escapeHtml(leadTaskDetailTime(job.createdAt))}</time></div>
            <div class="lead-live-request-copy">${requestLines.map((line) => `<span>${escapeHtml(line)}</span>`).join("")}</div>
          </div>
        </article>
        <article class="lead-live-message is-assistant ${terminal ? "is-terminal" : "is-active"}">
          <div class="lead-live-avatar" aria-hidden="true">AI</div>
          <div class="lead-live-bubble">
            <div class="lead-live-message-meta"><b>${terminal ? "任务已结束" : escapeHtml(stage.name)}</b>${terminal ? "" : `<span>${progress}%</span>`}</div>
            ${terminal ? "" : `<p>${escapeHtml(stage.result || "等待事实回传")}</p>`}
            ${waitState ? `<div class="lead-live-wait-reason ${escapeHtml(waitState.tone)}" role="status"><i aria-hidden="true"></i><span><b>${escapeHtml(waitState.title)}</b><small>${escapeHtml(waitState.detail)}</small></span></div>` : ""}
            ${terminal ? `<span class="lead-live-terminal-progress" role="progressbar" aria-label="${escapeHtml(job.title)}执行进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="100"></span>` : `<div class="lead-live-progress" role="progressbar" aria-label="${escapeHtml(job.title)}执行进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
              <div class="lead-live-progress-track"><i style="--p:${progress}%"></i></div>
            </div>`}
            <div class="lead-live-facts" aria-label="本次搜索事实摘要">
              <span><b>${escapeHtml(sourceFact.split(" ")[0])}</b> ${escapeHtml(sourceFact.split(" ").slice(1).join(" "))}</span>
              <span><b>${rawCount}</b> 原始命中</span>
              <span><b>${cleaningCount}</b> 清洗去除</span>
              <span><b>${candidateCount}</b> 候选入池</span>
              <span><b>${job.deepMining?.summary.researchReadyCount || 0}</b> 研究就绪</span>
              <span><b>${job.deepMining?.summary.evidenceCount || 0}</b> 来源证据</span>
            </div>
          </div>
        </article>
        ${deepMining && deepMining.summary.rootCandidateCount ? `
          <article class="lead-live-message is-deep-mining ${deepMining.status === "completed" ? "is-complete" : "is-active"}">
            <div class="lead-live-avatar" aria-hidden="true">研</div>
            <div class="lead-live-bubble">
              <div class="lead-live-message-meta"><b>候选关系深挖</b><span>${deepMining.status === "completed" ? "已归档" : activeDeepTask?.status === "verifying" ? "官网验证中" : "证据搜索中"}</span></div>
              <p><strong>${escapeHtml(activeDeepNode?.company || "正在选择高优先级候选")}</strong><span>${activeDeepTask ? `第 ${activeDeepTask.depth + 1}/${deepMining.maxDepth} 层 · 查询 ${deepMining.queriesUsed}/${deepMining.maxQueries}` : `根候选 ${deepMining.summary.rootCandidateCount} 个`}</span></p>
              <em>${escapeHtml(latestDeepEvidence?.summary || deepMining.stopReason || "仅归档带真实来源的企业、关系与公开联系证据")}</em>
              <div class="lead-live-deep-line"><span>${deepMining.summary.researchedCandidateCount} 个研究节点</span><span>${deepMining.summary.relationCount} 条关系</span><span>${deepMining.summary.evidenceCount} 条证据</span><span>${deepMining.summary.researchReadyCount} 个研究就绪</span></div>
            </div>
          </article>` : ""}
        <div class="lead-live-event-stream" aria-label="搜索过程">
          ${hiddenLogCount ? `<p class="lead-live-history-note">较早的 ${hiddenLogCount} 条事实记录已收纳在执行详情</p>` : ""}
          ${logs.length ? logs.map((log, index) => `
            <article class="lead-live-message is-event ${log.tone} ${hasNewEvent && index === logs.length - 1 ? "is-latest" : ""}" data-lead-event-key="${escapeHtml(log.key)}">
              <div class="lead-live-avatar" aria-hidden="true">${escapeHtml((log.source || "搜").slice(0, 1))}</div>
              <div class="lead-live-bubble">
                <div class="lead-live-message-meta"><b>${escapeHtml(log.source)}</b><time>${escapeHtml(leadTaskDetailTime(log.at))}</time></div>
                <p><strong>${escapeHtml(log.title)}</strong><span>${escapeHtml(log.detail)}</span></p>
                <em>${escapeHtml(log.result)}</em>
              </div>
            </article>
          `).join("") : `
            <article class="lead-live-message is-event is-latest">
              <div class="lead-live-avatar" aria-hidden="true">搜</div>
              <div class="lead-live-bubble">
                <div class="lead-live-message-meta"><b>任务调度</b><time>--:--:--</time></div>
                <p><strong>任务已建立</strong><span>等待来源与清洗事件回传</span></p>
                <em>等待中</em>
              </div>
            </article>`}
        </div>
        ${discoveries.length ? `
          <article class="lead-live-message is-discovery">
            <div class="lead-live-avatar" aria-hidden="true">客</div>
            <div class="lead-live-bubble">
              <div class="lead-live-message-meta"><b>新候选已进入池</b><span>${discoveries.length} 条查得结果（全部展示）</span></div>
              <div class="lead-live-discoveries">
                ${discoveries.map((item) => `
                  <button type="button" data-lead-live-candidate="${escapeHtml(item.id)}">
                    <span><b>${escapeHtml(item.company || websiteDomain(item.website || "") || "公司待确认")}</b><small>${escapeHtml([item.country, item.sourceLabel || item.source, item.contactInfo, `加入 ${leadTaskDetailDateTime(item.createdAt)}`].filter(Boolean).join(" / "))}</small></span>
                    <em>${leadFinderScore(item)} 分</em>
                  </button>
                `).join("")}
              </div>
            </div>
          </article>` : ""}
        ${terminal ? "" : `
          <div class="lead-live-stream-tail" role="status">
            <i aria-hidden="true"></i>
            <span><b>任务进行中</b><small>${escapeHtml(stage.name)} · 新事件将在这里继续追加</small></span>
          </div>`}
      </div>
      <button class="lead-live-jump-latest" type="button" data-lead-live-follow ${wasFollowing ? "hidden" : ""}>回到最新</button>
    </div>`;
  const thread = qs<HTMLElement>(".lead-live-thread", box);
  const jumpLatest = qs<HTMLButtonElement>("[data-lead-live-follow]", box);
  if (thread) {
    let programmaticScroll = false;
    const atBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 72;
    const followLatest = () => {
      programmaticScroll = true;
      const previousBehavior = thread.style.scrollBehavior;
      thread.style.scrollBehavior = "auto";
      thread.dataset.follow = "true";
      thread.scrollTop = thread.scrollHeight;
      if (jumpLatest) jumpLatest.hidden = true;
      requestAnimationFrame(() => { thread.style.scrollBehavior = previousBehavior; });
      window.setTimeout(() => { programmaticScroll = false; }, 80);
    };
    if (wasFollowing) {
      followLatest();
      requestAnimationFrame(() => followLatest());
    } else {
      thread.scrollTop = Math.min(previousScrollTop, Math.max(0, thread.scrollHeight - thread.clientHeight));
    }
    // 滚动位置是跟随状态的唯一事实源：贴底=持续跟随（流式打印）；向上翻=暂停；回到贴底=自动恢复。
    // 不用 wheel/touchmove 判定——触控板惯性、页面滚动手势、横向触摸滑动都会误置 follow=false，
    // 且该状态会跨重渲染持久化，导致视图永久卡在顶部。
    thread.addEventListener("scroll", () => {
      if (programmaticScroll) return;
      const following = atBottom();
      thread.dataset.follow = following ? "true" : "false";
      if (jumpLatest) jumpLatest.hidden = following;
    }, { passive: true });
    thread.addEventListener("keydown", (event) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
        event.preventDefault();
        const top = event.key === "Home"
          ? 0
          : Math.max(0, thread.scrollTop - (event.key === "PageUp" ? thread.clientHeight * 0.8 : 48));
        const previousBehavior = thread.style.scrollBehavior;
        thread.style.scrollBehavior = "auto";
        thread.scrollTop = top;
        thread.style.scrollBehavior = previousBehavior;
        thread.dataset.follow = "false";
        if (jumpLatest) jumpLatest.hidden = false;
      } else if (event.key === "End") {
        event.preventDefault();
        followLatest();
      }
    });
    jumpLatest?.addEventListener("click", (event) => {
      event.preventDefault();
      followLatest();
    });
  }
  qs<HTMLButtonElement>("[data-lead-live-radar]", box)?.addEventListener("click", () => void openProspectRadar(job));
  qs<HTMLButtonElement>("[data-lead-live-open]", box)?.addEventListener("click", () => openLeadTaskDetail(job));
  qsa<HTMLButtonElement>("[data-lead-live-candidate]", box).forEach((button) => {
    button.addEventListener("click", () => {
      const item = state.websiteOpportunities.find((candidate) => candidate.id === button.dataset.leadLiveCandidate);
      if (item) openLeadFinderVerificationDrawer(item);
    });
  });
  qsa<HTMLButtonElement>("[data-lead-live-action]", box).forEach((button) => {
    button.addEventListener("click", () => void transitionLeadFinderRun(job, button.dataset.leadLiveAction as "pause" | "resume" | "cancel", button));
  });
  syncProspectRadar(job);
}

function leadFinderCleaningOutcomeLabel(outcome: ProspectRunCleaningReport["records"][number]["outcome"]) {
  if (outcome === "merged") return "已归并";
  if (outcome === "suppressed") return "规则排除";
  if (outcome === "rejected") return "数据无效";
  if (outcome === "accepted") return "已入池";
  return "待处理";
}

export function leadFinderRemovedTotal(report?: ProspectRunCleaningReport | null) {
  const data = report?.summary;
  if (!data) return 0;
  return data.providerInvalidCount
    + data.providerDuplicateCount
    + data.rejectedCount
    + data.suppressedCount
    + data.mergedCount;
}

export function leadFinderRemovalSummary(report?: ProspectRunCleaningReport | null) {
  const data = report?.summary;
  if (!data) return "";
  return [
    data.providerInvalidCount ? `字段无效 ${data.providerInvalidCount} 条` : "",
    data.providerDuplicateCount ? `来源内重复 ${data.providerDuplicateCount} 条` : "",
    data.rejectedCount ? `数据无效 ${data.rejectedCount} 条` : "",
    data.suppressedCount ? `历史或规则排除 ${data.suppressedCount} 条` : "",
    data.mergedCount ? `身份归并 ${data.mergedCount} 条` : ""
  ].filter(Boolean).join("；");
}

export function renderLeadFinderCleaningLedger() {
  const job = primaryLeadFinderLiveJob();
  const report = job?.cleaningReport;
  const rows = qs<HTMLElement>("#leadFinderCleaningRows");
  const summary = qs<HTMLElement>("#leadFinderCleaningSummary");
  const scope = qs<HTMLElement>("#leadFinderCleaningScope");
  const count = qs<HTMLElement>("#leadFinderCleaningCount");
  if (!rows || !summary || !scope || !count) return;
  const removedRecords = (report?.records || []).filter((record) => ["merged", "suppressed", "rejected"].includes(record.outcome));
  const filtered = leadFinderCleaningFilter === "all"
    ? removedRecords
    : removedRecords.filter((record) => record.outcome === leadFinderCleaningFilter);
  const removedTotal = leadFinderRemovedTotal(report);
  count.textContent = String(removedTotal);
  scope.textContent = job ? `${isLeadFinderJobTerminal(job) ? "最近任务" : (job.superSearchMissionId ? "当前超级搜索轮次" : "当前任务")} · ${removedTotal} 条已分流` : "等待任务数据";
  qsa<HTMLButtonElement>("[data-lead-cleaning-filter]").forEach((button) => {
    const active = button.dataset.leadCleaningFilter === leadFinderCleaningFilter;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  const data = report?.summary;
  summary.innerHTML = data ? `
    <div><span>原始命中</span><b>${data.providerRawCount}</b></div>
    <div><span>解析无效</span><b>${data.providerInvalidCount}</b></div>
    <div><span>来源内重复</span><b>${data.providerDuplicateCount}</b></div>
    <div><span>已归并</span><b>${data.mergedCount}</b></div>
    <div><span>规则排除</span><b>${data.suppressedCount}</b></div>
    <div><span>数据无效</span><b>${data.rejectedCount}</b></div>
  ` : `<div class="empty-cell">等待清洗统计</div>`;
  const sourceAggregates = (report?.sources || []).flatMap((source) => [
    ...(source.invalidCount > 0 ? [{
      providerCode: source.providerCode,
      count: source.invalidCount,
      title: "来源字段不完整",
      reason: "来源记录缺少企业名称、国家或可识别的主体信息，未进入候选清洗管线。",
      code: "PROVIDER_INVALID_RECORD",
      tone: "rejected"
    }] : []),
    ...(source.duplicateCount > 0 ? [{
      providerCode: source.providerCode,
      count: source.duplicateCount,
      title: "来源内重复",
      reason: "同一数据源本批返回了重复主体，系统按来源记录标识或企业身份去重，仅保留一条继续处理。",
      code: "PROVIDER_DUPLICATE_RECORD",
      tone: "merged"
    }] : [])
  ]);
  const visibleAggregates = leadFinderCleaningFilter === "all" ? sourceAggregates : [];
  const aggregateHtml = visibleAggregates.map((record) => {
    const provider = state.leadProviders.find((item) => item.id === record.providerCode);
    return `
      <article class="lead-cleaning-row is-source-summary">
        <div class="lead-cleaning-source"><b>${escapeHtml(provider?.name || record.providerCode || "未知来源")}</b><span>${escapeHtml(record.providerCode || "未标记来源")}</span></div>
        <div class="lead-cleaning-record"><b>${escapeHtml(record.title)}</b><span>来源预处理阶段按数量汇总</span></div>
        <span class="lead-cleaning-outcome is-${record.tone}">${escapeHtml(record.title)} × ${record.count}</span>
        <div class="lead-cleaning-reason"><b>${escapeHtml(record.reason)}</b><span>${record.code} · 此阶段未保存无效或重复记录的公司名称</span></div>
      </article>`;
  }).join("");
  const detailHtml = filtered.map((record) => {
    const provider = state.leadProviders.find((item) => item.id === record.providerCode);
    const recordTitle = record.sourceCompany || record.candidateName || "未识别企业";
    const sourceFacts = [record.sourceCountry, record.sourceDomain].filter(Boolean).join(" / ") || "未提供国家或官网域名";
    const sourceRecordId = record.sourceRecordId || record.hitId;
    return `
      <article class="lead-cleaning-row">
        <div class="lead-cleaning-source"><b>${escapeHtml(provider?.name || record.providerCode || "未知来源")}</b><span>${escapeHtml(record.providerCode || "未标记来源")}</span></div>
        <div class="lead-cleaning-record"><b>${escapeHtml(recordTitle)}</b><span title="${escapeHtml(sourceFacts)}">${escapeHtml(sourceFacts)}</span><span title="${escapeHtml(sourceRecordId)}">来源记录 ${escapeHtml(sourceRecordId)}</span></div>
        <span class="lead-cleaning-outcome is-${escapeHtml(record.outcome)}">${escapeHtml(leadFinderCleaningOutcomeLabel(record.outcome))}</span>
        <div class="lead-cleaning-reason"><b>${escapeHtml(record.reason || "未提供清洗原因")}</b><span>${escapeHtml(record.reasonCode || "未标记原因码")}</span>${record.candidateId ? `<button class="lead-cleaning-candidate" type="button" data-lead-cleaning-candidate="${escapeHtml(record.candidateId)}">查看关联候选 ${escapeHtml(record.candidateName || "")}</button>` : ""}</div>
        <time class="lead-cleaning-time" datetime="${escapeHtml(record.processedAt)}">${escapeHtml(leadTaskDetailDateTime(record.processedAt))}</time>
      </article>`;
  }).join("");
  rows.innerHTML = aggregateHtml || detailHtml
    ? `${aggregateHtml}${detailHtml}`
    : `<div class="empty-cell">${job ? "当前筛选下暂无清洗去除记录" : "暂无任务清洗记录"}</div>`;
  qsa<HTMLButtonElement>("[data-lead-cleaning-candidate]", rows).forEach((button) => {
    button.addEventListener("click", () => {
      const candidateId = button.dataset.leadCleaningCandidate || "";
      if (!state.websiteOpportunities.some((item) => item.id === candidateId)) return;
      state.selectedProspectId = candidateId;
      activateNavView("prospect-list", renderProspectList);
    });
  });
}

function renderLeadFinderJobDetails(job: LeadFinderJob) {
  const found = (job.resultIds || [])
    .map((id) => state.websiteOpportunities.find((item) => item.id === id))
    .filter(Boolean) as WebsiteOpportunity[];
  const foundHtml = found.length ? `
    <div class="lead-job-found-head"><b>本次候选公司</b><span>${found.length} 条，可滚动查看</span></div>
    <div class="lead-job-found-list">
      ${found.map((item) => `
        <button type="button" data-lead-job-pick="${escapeHtml(item.id)}">
          <b>${escapeHtml(item.company || "公司待确认")}</b>
          <span>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(websiteDomain(item.website || ""))}</span>
          <em>${leadFinderScore(item)}分</em>
        </button>
      `).join("")}
    </div>
  ` : `<div class="lead-job-loading">${job.backendRunId
    ? job.status === "running"
      ? "后台获客任务正在执行，结果将进入统一候选客户池。"
      : "后台任务已保存，候选结果将在搜客清单中统一核验。"
    : job.status === "running"
      ? "正在解析导入网址并等待候选结果..."
      : "本次任务暂无候选结果，可导入官网或平台链接继续解析。"}</div>`;
  const pipeline = job.cleaningReport?.summary;
  const incrementalHtml = pipeline ? `
    <div class="lead-job-detail-lines">
      <span>原始命中 ${pipeline.providerRawCount} 条</span>
      <span>进入候选池 ${pipeline.candidateCount} 条</span>
      <span>来源内重复 ${pipeline.providerDuplicateCount} 条</span>
      <span>身份合并 ${pipeline.mergedCount} 条</span>
      <span>抑制 ${pipeline.suppressedCount} 条</span>
      <span>待处理 ${pipeline.pendingCount} 条</span>
    </div>
  ` : job.incrementalStats ? `
    <div class="lead-job-detail-lines">
      <span>原始命中 ${job.incrementalStats.rawCount} 条</span>
      <span>净新增 ${job.incrementalStats.newCount} 条</span>
      <span>新证据 ${job.incrementalStats.evidenceUpdatedCount} 条</span>
      <span>历史未变化 ${job.incrementalStats.unchangedCount} 条</span>
      <span>同批去重 ${job.incrementalStats.deduplicatedCount} 条</span>
      ${job.incrementalStats.existingFilteredCount ? `<span>已有客户/线索过滤 ${job.incrementalStats.existingFilteredCount} 条</span>` : ""}
      ${job.incrementalStats.multiSourceMergedCount ? `<span>多来源合并 ${job.incrementalStats.multiSourceMergedCount} 条</span>` : ""}
      ${job.incrementalStats.excludedCount ? `<span>已排除 ${job.incrementalStats.excludedCount} 条</span>` : ""}
    </div>
  ` : "";
  const sourceStatsHtml = job.sourceStats?.length ? `
    <div class="lead-job-source-list">
      ${job.sourceStats.map((source) => {
        const failed = Boolean(source.error || source.status === "failed");
        const retryAt = source.retryAfterAt ? new Date(source.retryAfterAt) : null;
        const retryHint = retryAt && !Number.isNaN(retryAt.getTime())
          ? ` · ${retryAt.toLocaleString("zh-CN", { hour12: false })} 后可重试`
          : source.retryable ? " · 可重试" : "";
        const successText = source.statusLabel
          || (source.count === undefined
            ? "执行完成"
            : `${source.count} 条 · ${source.status === "success_empty" ? "成功无结果" : "执行成功"}`);
        return `<div class="${failed ? "is-failed" : "is-success"}"><b>${escapeHtml(source.name)}</b><span>${failed ? escapeHtml(source.error || "执行失败") : escapeHtml(successText)}${escapeHtml(retryHint)}</span></div>`;
      }).join("")}
    </div>
  ` : "";
  return `
    <div class="lead-job-detail" ${job.expanded ? "" : "hidden"}>
      ${incrementalHtml}
      ${sourceStatsHtml}
      <div class="lead-job-detail-lines">${(job.detailLines || buildLeadFinderJobDetails(job.resultIds)).map((line) => `<span>${escapeHtml(line)}</span>`).join("")}</div>
      ${foundHtml}
    </div>
  `;
}

function leadTaskDetailStatusClass(job: LeadFinderJob) {
  if (job.status === "done") return "is-done";
  if (["partial", "paused", "cancelled", "needs_input"].includes(job.status)) return "is-warning";
  if (job.status === "failed") return "is-failed";
  return "is-running";
}

export function leadTaskJobIsLive(job?: LeadFinderJob | null) {
  return job?.status === "running";
}

function leadTaskDetailEventText(event: ProspectRunEventApiRecord) {
  const copy: Record<ProspectRunEventApiRecord["eventType"], [string, string]> = {
    created: ["任务创建完成", "搜索策略与来源计划已冻结，等待执行器接管"],
    started: ["后台执行已启动", "多个数据源开始并行搜索目标企业"],
    pause_requested: ["已提交暂停请求", event.reason || "将在安全检查点暂停任务"],
    paused: ["任务已暂停", event.reason || "已有结果和执行位置均已保留"],
    resumed: ["任务已恢复", event.reason || "从上次安全检查点继续执行"],
    cancel_requested: ["已提交取消请求", event.reason || "正在停止未完成的数据源"],
    cancelled: ["任务已取消", event.reason || "已保留取消前的有效结果"],
    completed: ["任务执行完成", event.reason || "来源结果已进入清洗与候选归并流程"],
    failed: ["任务执行失败", event.reason || "请检查数据源连接或任务配置"]
  };
  return copy[event.eventType];
}

export function leadTaskDetailTime(value?: string) {
  if (!value) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

function leadTaskDetailDateTime(value?: string) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function leadTaskDetailLogs(job: LeadFinderJob): LeadTaskStreamLog[] {
  if (job.backendRunId) {
    if (job.liveEvents?.length) {
      return job.liveEvents.map(leadTaskLiveEventLog);
    }
    return (job.runEvents || []).map((event) => {
      const [title, detail] = leadTaskDetailEventText(event);
      return {
        key: event.id,
        at: event.createdAt,
        source: "任务",
        title,
        detail,
        result: prospectRunStatusLabel(event.toStatus),
        tone: event.eventType === "failed"
          ? "is-failed"
          : ["pause_requested", "paused", "cancel_requested", "cancelled"].includes(event.eventType)
            ? "is-review"
            : ""
      };
    });
  }
  const logs: LeadTaskStreamLog[] = [{
    key: `${job.id}:strategy`,
    at: job.createdAt,
    source: "策略",
    title: "客户画像与检索条件已解析",
    detail: "产品、市场、行业和排除条件已载入本次任务",
    result: "已就绪",
    tone: ""
  }];
  (job.superSearchRounds || []).forEach((round) => {
    const query = round.queryPlanSnapshot;
    const scope = [
      query?.countries.join("、") || "全球",
      query?.languages.join("、") || "自动语言",
      query?.customerTypes.join("、") || "不限买家类型"
    ].join(" · ");
    logs.push({
      key: `${job.id}:plan:${round.roundNo}:${round.queryPlanFingerprint || "legacy"}`,
      at: round.createdAt,
      source: "规划器",
      title: `第 ${round.roundNo} 轮 · ${superSearchThemeLabel(round.queryTheme)}`,
      detail: `${scope}；${round.coverageGaps?.join("；") || "建立覆盖基线"}`,
      result: round.completedAt
        ? `原始 ${round.rawCount} / 候选 ${round.candidateCount}`
        : `${round.queryCells?.length || job.channelCount} 单元执行中`,
      tone: round.candidateCount ? "is-gain" : round.completedAt ? "is-review" : "is-live"
    });
  });
  const currentSuperRound = (job.superSearchRounds || []).find((round) =>
    round.roundNo === job.superSearchRound
  );
  const currentSuperRoundCreatedAt = currentSuperRound?.createdAt || job.createdAt;
  (currentSuperRound?.queryCells || []).forEach((cell) => {
    const sourceName = state.leadProviders.find((item) => item.id === cell.providerId)?.name || cell.providerId;
    const failed = cell.status === "failed";
    const settled = cell.status !== "planned";
    logs.push({
      key: `${job.id}:cell:${cell.fingerprint}:${cell.status}`,
      at: cell.completedAt || currentSuperRoundCreatedAt,
      source: sourceName,
      title: failed
        ? "查询单元执行失败"
        : cell.status === "succeeded_empty"
          ? "查询单元完成，无返回"
          : settled
            ? "查询单元已完成"
            : "查询单元正在执行",
      detail: failed
        ? `${cell.errorCode || "PROVIDER_EXECUTION_FAILED"} · ${cell.errorMessage || "查看来源失败报文"}`
        : `${cell.market} · ${cell.language} · 原始 ${cell.rawCount || 0} · 无效 ${cell.invalidCount || 0} · 重复 ${cell.duplicateCount || 0}`,
      result: failed ? "失败" : settled ? `${cell.candidateCount || 0} 候选` : "执行中",
      tone: failed ? "is-failed" : cell.candidateCount ? "is-gain" : settled ? "is-review" : "is-live"
    });
  });
  (job.processPhases || []).forEach((phase, index) => {
    logs.push({
      key: `${job.id}:phase:${phase.id}:${phase.status}:${phase.result}`,
      at: job.runEvents?.[Math.min(index, Math.max(0, job.runEvents.length - 1))]?.createdAt || job.createdAt,
      source: "流程",
      title: phase.name,
      detail: phase.result,
      result: phase.status === "succeeded" ? "完成" : phase.status === "partial" ? "有产出" : phase.status === "failed" ? "失败" : phase.status === "blocked" ? "受阻" : phase.status === "running" ? "进行中" : "等待",
      tone: phase.status === "failed" || phase.status === "blocked" ? "is-failed" : phase.status === "succeeded" ? "is-gain" : phase.status === "partial" ? "is-review" : ""
    });
  });
  (job.runEvents || []).forEach((event) => {
    const [title, detail] = leadTaskDetailEventText(event);
    logs.push({
      key: event.id,
      at: event.createdAt,
      source: "任务",
      title,
      detail,
      result: prospectRunStatusLabel(event.toStatus),
      tone: event.eventType === "failed" ? "is-failed" : event.eventType === "completed" ? "is-gain" : ["pause_requested", "paused", "cancel_requested", "cancelled"].includes(event.eventType) ? "is-review" : ""
    });
  });
  (job.sourceStats || []).forEach((source) => {
    const status = source.status || "queued";
    const failed = Boolean(source.error || status === "failed");
    const succeeded = ["succeeded", "succeeded_empty", "partial_success", "success", "success_empty"].includes(status);
    const title = failed
      ? `${source.name} 返回异常`
      : succeeded
        ? `${source.name} 已完成本轮检索`
        : status === "running"
          ? `${source.name} 正在检索与解析`
          : status === "retry_scheduled"
            ? `${source.name} 等待自动重试`
            : `${source.name} 已进入执行队列`;
    logs.push({
      key: `${job.id}:${source.id}:${status}:${source.updatedAt || ""}`,
      at: source.updatedAt || source.createdAt || job.createdAt,
      source: source.name,
      title,
      detail: failed ? source.error || "来源执行失败" : source.statusLabel || "等待状态更新",
      result: source.count === undefined ? (source.statusLabel || "进行中") : `${source.count} 条`,
      tone: failed ? "is-failed" : succeeded ? "is-gain" : status === "retry_scheduled" ? "is-review" : ""
    });
  });
  logs.sort((left, right) => left.at.localeCompare(right.at) || left.key.localeCompare(right.key));
  return logs;
}

function leadTaskStreamLogHtml(log: LeadTaskStreamLog) {
  const livePhases = log.live && log.phases?.length ? log.phases : null;
  const tone = log.live ? (log.tone ? `${log.tone} is-live` : "is-live") : log.tone;
  const detailHtml = livePhases
    ? `<span class="task-run-log-live-text" data-live-phases="${escapeHtml(JSON.stringify(livePhases))}" data-live-detail="${escapeHtml(log.detail)}" data-live-index="0">${escapeHtml(livePhases[0] || log.detail)}</span>`
    : `<span>${escapeHtml(log.detail)}</span>`;
  return `
    <div class="task-run-log ${tone}" data-task-log-key="${escapeHtml(log.key)}">
      <time>${escapeHtml(leadTaskDetailTime(log.at))}</time>
      <span class="task-run-log-source" title="${escapeHtml(log.source)}">${escapeHtml(log.source)}</span>
      <div class="task-run-log-copy"><b>${escapeHtml(log.title)}</b>${detailHtml}</div>
      <strong class="task-run-log-result">${escapeHtml(log.result)}</strong>
    </div>
  `;
}

let leadTaskLiveTickerTimer: ReturnType<typeof setInterval> | undefined;

function stopLeadTaskLiveTicker() {
  if (leadTaskLiveTickerTimer !== undefined) {
    clearInterval(leadTaskLiveTickerTimer);
    leadTaskLiveTickerTimer = undefined;
  }
}

function leadTaskLiveTickerTick() {
  const nodes = qsa<HTMLElement>("#leadTaskStream [data-live-phases]");
  if (!nodes.length) {
    stopLeadTaskLiveTicker();
    return;
  }
  nodes.forEach((node) => {
    let phases: string[] = [];
    try {
      phases = JSON.parse(node.dataset.livePhases || "[]") as string[];
    } catch {
      return;
    }
    if (phases.length < 2) return;
    const next = (Number(node.dataset.liveIndex || "0") + 1) % phases.length;
    node.dataset.liveIndex = String(next);
    node.textContent = phases[next] || "";
  });
}

function ensureLeadTaskLiveTicker() {
  if (leadTaskLiveTickerTimer === undefined) {
    leadTaskLiveTickerTimer = setInterval(leadTaskLiveTickerTick, 2600);
  }
}

function demoteLeadTaskLiveLogNodes(stream: HTMLElement) {
  qsa<HTMLElement>("[data-live-phases]", stream).forEach((node) => {
    node.textContent = node.dataset.liveDetail || node.textContent;
    node.classList.remove("task-run-log-live-text");
    node.removeAttribute("data-live-phases");
    node.removeAttribute("data-live-index");
    node.removeAttribute("data-live-detail");
  });
}

function syncLeadTaskStreamStateUi() {
  const job = leadFinderJobs.find((item) => item.id === activeLeadFinderJobId);
  const live = leadTaskJobIsLive(job);
  const stateNode = qs<HTMLElement>("#leadTaskStreamState");
  if (stateNode) {
    stateNode.textContent = live ? "事实事件同步" : job?.status === "paused" ? "执行已暂停" : "记录已归档";
    stateNode.classList.toggle("is-terminal", !live);
  }
}

function renderLeadTaskStream(job: LeadFinderJob) {
  const stream = qs<HTMLElement>("#leadTaskStream");
  if (!stream) return;
  stream.classList.remove("is-verbose");
  stream.dataset.streamMode = "facts";
  const logs = leadTaskDetailLogs(job);
  const live = leadTaskJobIsLive(job);
  if (live && logs.length && logs[logs.length - 1].phases?.length) {
    logs[logs.length - 1].live = true;
  }
  const signature = `${logs.map((item) => item.key).join("|")}#${live ? "live" : "done"}`;
  if (stream.dataset.signature === signature) return;
  const wasFollowing = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 72;
  const previousCount = Number(stream.dataset.logCount || 0);
  const existingKeys = qsa<HTMLElement>("[data-task-log-key]", stream).map((item) => item.dataset.taskLogKey || "");
  const canAppend = existingKeys.length > 0
    && existingKeys.length <= logs.length
    && existingKeys.every((key, index) => logs[index]?.key === key);
  if (canAppend) {
    demoteLeadTaskLiveLogNodes(stream);
    logs.slice(existingKeys.length).forEach((log) => stream.insertAdjacentHTML("beforeend", leadTaskStreamLogHtml(log)));
  } else {
    stream.innerHTML = logs.map(leadTaskStreamLogHtml).join("");
  }
  stream.dataset.signature = signature;
  stream.dataset.logCount = String(logs.length);
  if (logs.some((log) => log.live)) ensureLeadTaskLiveTicker();
  const newEventsButton = qs<HTMLButtonElement>("#leadTaskNewEvents");
  if (wasFollowing || !previousCount) {
    stream.scrollTop = stream.scrollHeight;
    requestAnimationFrame(() => stream.scrollTo({ top: stream.scrollHeight, behavior: previousCount ? "smooth" : "auto" }));
    if (newEventsButton) newEventsButton.hidden = true;
  } else if (newEventsButton && logs.length > previousCount) {
    newEventsButton.textContent = `${logs.length - previousCount} 条新动态`;
    newEventsButton.hidden = false;
  }
  syncLeadTaskStreamStateUi();
}

function leadTaskDetailSourceStep(status = "queued") {
  if (["succeeded", "succeeded_empty", "partial_success", "success", "success_empty"].includes(status)) return 5;
  if (["failed", "cancelled"].includes(status)) return 4;
  if (["running", "pause_requested", "paused", "retry_scheduled", "cancel_requested"].includes(status)) return 1;
  return 0;
}

function renderLeadTaskSources(job: LeadFinderJob) {
  const box = qs<HTMLElement>("#leadTaskSources");
  const summary = qs<HTMLElement>("#leadTaskSourcesSummary");
  if (!box || !summary) return;
  const sources = job.sourceStats || [];
  const settled = sources.filter((source) => ["succeeded", "succeeded_empty", "partial_success", "failed", "cancelled", "success", "success_empty"].includes(source.status || "")).length;
  summary.textContent = `${settled} / ${sources.length || job.channelCount} 个来源已结束`;
  if (!sources.length) {
    box.innerHTML = `<div class="task-run-insight-empty">任务正在建立来源连接，执行矩阵会随状态回传自动展开。</div>`;
    return;
  }
  const stepLabels = ["搜索", "解析", "清洗", "入池", "完成"];
  box.innerHTML = sources.map((source) => {
    const current = leadTaskDetailSourceStep(source.status);
    const terminal = current === 5;
    const returned = source.rawCount ?? source.count;
    const waitText = leadFinderSourceWaitText(source, job);
    const resultText = returned === undefined
      ? "等待来源返回"
      : returned === 0
        ? terminal || ["failed", "cancelled"].includes(source.status || "") ? "无返回" : "暂未返回"
        : `返回 ${returned} 条 · 入池 ${source.candidateCount || 0} 条`;
    return `
      <div class="task-run-source-row">
        <div class="task-run-source-name"><b>${escapeHtml(source.name)}</b><span>${escapeHtml(source.id)}</span></div>
        <div class="task-run-source-steps">${stepLabels.map((label, index) => `<span class="task-run-source-step ${terminal || index < current ? "is-done" : index === current ? "is-current" : ""}">${label}</span>`).join("")}</div>
        <div class="task-run-source-result">
          <span class="task-run-source-status">${escapeHtml(source.statusLabel || "等待执行")}</span>
          <span class="task-run-source-count">${escapeHtml(resultText)}</span>
          ${waitText ? `<span class="task-run-source-wait ${/响应超时/u.test(waitText) ? "is-timeout" : source.id === "ai_search" ? "is-ai" : ""}">${escapeHtml(waitText)}</span>` : ""}
          ${source.failure ? `<button type="button" data-lead-source-failure="${escapeHtml(source.id)}">查看失败报文</button>` : ""}
        </div>
        <time class="task-run-source-time">${escapeHtml(leadTaskDetailTime(source.updatedAt || source.createdAt))}</time>
      </div>
    `;
  }).join("");
  qsa<HTMLButtonElement>("[data-lead-source-failure]", box).forEach((button) => {
    button.addEventListener("click", () => openLeadTaskFailureReport(job, button.dataset.leadSourceFailure || ""));
  });
}

function renderLeadTaskPhases(job: LeadFinderJob) {
  const box = qs<HTMLElement>("#leadTaskPhases");
  const summary = qs<HTMLElement>("#leadTaskPhasesSummary");
  if (!box || !summary) return;
  const phases = job.processPhases?.length
    ? job.processPhases
    : job.steps.map((name, index) => ({ id: `local-${index}`, name, status: index === 0 ? "succeeded" as const : job.status === "failed" ? "blocked" as const : "pending" as const, result: index === 0 ? "任务条件已生成" : "等待后台结果" }));
  const done = phases.filter((item) => item.status === "succeeded").length;
  const failed = phases.filter((item) => ["failed", "blocked"].includes(item.status)).length;
  summary.textContent = failed ? `${failed} 个流程异常` : `${done} / ${phases.length} 已完成`;
  box.innerHTML = phases.map((phase, index) => `
    <article class="task-run-phase is-${escapeHtml(phase.status)}">
      <span>${String(index + 1).padStart(2, "0")}</span>
      <div><b>${escapeHtml(phase.name)}</b><small>${escapeHtml(phase.result)}</small></div>
      <em>${phase.status === "succeeded" ? "完成" : phase.status === "partial" ? "有产出" : phase.status === "failed" ? "失败" : phase.status === "blocked" ? "受阻" : phase.status === "running" ? "进行中" : "等待"}</em>
    </article>
  `).join("");
}

function openLeadTaskFailureReport(job: LeadFinderJob, sourceId: string) {
  const source = (job.sourceStats || []).find((item) => item.id === sourceId);
  const dialog = qs<HTMLDialogElement>("#leadTaskFailureDialog");
  const title = qs<HTMLElement>("#leadTaskFailureTitle");
  const summary = qs<HTMLElement>("#leadTaskFailureSummary");
  const body = qs<HTMLElement>("#leadTaskFailureBody");
  if (!source?.failure || !dialog || !title || !summary || !body) return;
  title.textContent = `${source.name} · 失败报文`;
  summary.textContent = `${source.failure.stage} · ${source.failure.errorCode}`;
  const failureText = `${source.failure.errorCode} ${source.failure.errorMessage}`;
  const advice = /429|quota|rate|额度|限流/iu.test(failureText)
    ? "检查接口额度和限流时间，稍后重试，并减少单次返回数量。"
    : /401|403|auth|key|认证|密钥/iu.test(failureText)
      ? "检查 API Key、账号权限、Base URL 和模型名称，然后在数据源中心重新测试连接。"
      : /timeout|timed|超时|network|fetch|连接/iu.test(failureText)
        ? "检查网络与上游服务状态；减少同时启用的数据源，确认后台 Worker 正常运行后重试。"
        : "根据错误码检查对应数据源配置；不要反复提交相同任务，可先调整一个搜索条件后重试。";
  body.textContent = `失败原因\n${source.failure.errorMessage || source.error || "来源执行失败"}\n\n调整建议\n${advice}\n\n技术记录\n${JSON.stringify({
    taskId: job.backendRunId || job.id,
    provider: source.id,
    status: source.status,
    failure: source.failure,
    job: source.job,
    checkpoint: source.checkpoint,
    attempts: source.attempts || [],
    requests: source.requests || []
  }, null, 2)}`;
  if (!dialog.open) dialog.showModal();
}

function leadFinderNoResultReasons(job: LeadFinderJob) {
  const reasons: string[] = [];
  (job.sourceStats || []).forEach((source) => {
    const returned = source.rawCount ?? source.count;
    const candidateCount = source.candidateCount || 0;
    if (source.status === "failed" || source.failure) {
      reasons.push(`${source.name}：${source.error || source.failure?.errorMessage || "来源执行失败，未返回可用记录"}`);
    } else if ((returned || 0) > 0 && candidateCount === 0) {
      reasons.push(`${source.name}：返回 ${returned} 条原始记录，但清洗后没有形成新候选。`);
    } else if (["succeeded_empty", "success_empty"].includes(source.status || "") || returned === 0) {
      reasons.push(`${source.name}：本次没有返回匹配当前条件的记录。`);
    }
  });
  (job.cleaningReport?.reasons || []).filter((reason) => reason.count > 0).forEach((reason) => {
    reasons.push(`清洗规则“${reason.label}”处理 ${reason.count} 条。`);
  });
  (job.processPhases || []).filter((phase) => ["failed", "blocked", "partial"].includes(phase.status)).forEach((phase) => {
    reasons.push(`${phase.name}：${phase.result}`);
  });
  if (job.status === "cancelled") reasons.push("任务在完成全部来源前被取消。");
  if (!reasons.length) reasons.push("已启用来源没有返回可识别的新企业，或返回内容与历史企业重复。 ");
  return [...new Set(reasons)];
}

export function openLeadFinderNoResultReport(job: LeadFinderJob) {
  const dialog = qs<HTMLDialogElement>("#leadTaskFailureDialog");
  const title = qs<HTMLElement>("#leadTaskFailureTitle");
  const summary = qs<HTMLElement>("#leadTaskFailureSummary");
  const body = qs<HTMLElement>("#leadTaskFailureBody");
  if (!dialog || !title || !summary || !body) return;
  const reasons = leadFinderNoResultReasons(job);
  title.textContent = "本次未找到候选的原因";
  summary.textContent = `${job.title} · ${leadTaskDetailTime(job.createdAt)}`;
  body.textContent = [
    "本次结果",
    "没有形成可加入搜客清单的新候选。",
    "",
    "系统记录到的原因",
    ...reasons.map((reason, index) => `${index + 1}. ${reason}`),
    "",
    "建议下一步",
    "1. 放宽一个条件，例如市场、客户类型或排除词，不要同时大范围改动。",
    "2. 查看清洗去除记录，确认结果是否因历史重复或 ICP 条件被过滤。",
    "3. 来源失败时可稍后重试；系统不会通过绕过网站规则的方式补数据。"
  ].join("\n");
  if (!dialog.open) dialog.showModal();
}

function renderLeadTaskInsights(job: LeadFinderJob) {
  const gains = qs<HTMLElement>("#leadTaskGains");
  const cleaned = qs<HTMLElement>("#leadTaskCleaned");
  const gainSummary = qs<HTMLElement>("#leadTaskGainSummary");
  const cleanSummary = qs<HTMLElement>("#leadTaskCleanSummary");
  if (!gains || !cleaned || !gainSummary || !cleanSummary) return;
  const live = leadTaskJobIsLive(job);
  const found = (job.resultIds || [])
    .map((id) => state.websiteOpportunities.find((item) => item.id === id))
    .filter(Boolean) as WebsiteOpportunity[];
  const stats = job.incrementalStats;
  gainSummary.textContent = stats ? `净新增 ${stats.newCount} 条` : found.length ? `${found.length} 条候选` : live ? "持续更新" : "本轮无新增";
  if (found.length) {
    gains.innerHTML = found.map((item) => `
      <div class="task-run-insight-row is-gain"><div><b>${escapeHtml(item.company || "公司待确认")}</b><span>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(websiteDomain(item.website || ""))}</span></div><em>${leadFinderScore(item)} 分</em></div>
    `).join("");
  } else if (stats && (stats.newCount || stats.evidenceUpdatedCount)) {
    gains.innerHTML = `
      <div class="task-run-insight-row is-gain"><div><b>新增候选企业</b><span>通过本轮身份归一与去重</span></div><em>+${stats.newCount}</em></div>
      <div class="task-run-insight-row is-gain"><div><b>已有企业新增证据</b><span>补充来源或联系线索</span></div><em>+${stats.evidenceUpdatedCount}</em></div>
    `;
  } else {
    gains.innerHTML = `<div class="task-run-insight-empty">${live ? "来源正在检索与归并。发现可核验企业后，会在这里持续追加当前收获。" : "本轮任务已结束，未形成可入池的候选企业。"}</div>`;
  }
  const cleanRows: Array<[string, string, number | null]> = [
    ["域名或企业身份重复", "同批候选只保留一条主记录", stats?.deduplicatedCount ?? null],
    ["已有客户或线索", "客户库/有效线索已存在的企业不再入搜客清单", stats?.existingFilteredCount ?? null],
    ["命中排除条件", "按排除词与业务规则停止入池", stats?.excludedCount ?? null],
    ["历史记录无新增证据", "避免重复进入人工核验队列", stats?.unchangedCount ?? null],
    ["多来源身份合并", "来源证据归并到同一企业", stats?.multiSourceMergedCount ?? null]
  ];
  const cleanedTotal = stats ? stats.deduplicatedCount + (stats.existingFilteredCount || 0) + stats.excludedCount + stats.unchangedCount : null;
  cleanSummary.textContent = cleanedTotal === null ? live ? "规则监测中" : "本轮已结束" : `已分流 ${cleanedTotal} 条`;
  cleaned.innerHTML = cleanRows.map(([title, detail, count]) => `
    <div class="task-run-insight-row"><div><b>${escapeHtml(title)}</b><span>${escapeHtml(detail)}</span></div><em>${count === null ? "监测中" : `${count} 条`}</em></div>
  `).join("");
}

function renderLeadTaskCleaningReport(job: LeadFinderJob) {
  const box = qs<HTMLElement>("#leadTaskCleaningReport");
  const summary = qs<HTMLElement>("#leadTaskCleaningSummary");
  const importButton = qs<HTMLButtonElement>("#leadTaskImportPending");
  if (!box || !summary || !importButton) return;
  const report = job.cleaningReport;
  if (!report) {
    summary.textContent = "等待清洗记录";
    importButton.hidden = true;
    importButton.style.display = "none";
    box.innerHTML = `<div class="task-run-insight-empty">清洗流水尚未回传。</div>`;
    return;
  }
  const providerName = (code: string) =>
    state.leadProviders.find((item) => item.id === code)?.name || code;
  const pendingCandidates = job.pendingCandidates || [];
  const selectedPending = new Set(job.selectedPendingHitIds || []);
  summary.textContent = `${report.summary.processedCount}/${report.summary.pipelineHitCount} 已处理 · ${report.summary.candidateCount} 条入池 · 官网 ${report.summary.websiteResolvedCount || 0}/${report.summary.candidateCount}${job.superSearchMissionId && job.pendingCandidatesLoaded ? ` · 全任务待决定 ${pendingCandidates.length}` : ""}`;
  const showImportButton = Boolean(
    job.backendRunId
    && (pendingCandidates.length > 0 || (!job.pendingCandidatesLoaded && report.summary.pendingCount > 0))
  );
  importButton.hidden = !showImportButton;
  importButton.style.display = showImportButton ? "" : "none";
  importButton.disabled = leadTaskJobIsLive(job) || Boolean(job.pendingCandidatesLoaded && !selectedPending.size);
  importButton.textContent = leadTaskJobIsLive(job)
    ? `等待任务结束（${pendingCandidates.length || report.summary.pendingCount}）`
    : job.pendingCandidatesLoaded
      ? `纳入候选池（${selectedPending.size}）`
      : "查看待决定记录";
  importButton.onclick = () => {
    if (job.pendingCandidatesLoaded) void importPendingLeadTaskResults(job, importButton);
    else void loadLeadTaskPendingCandidates(job);
  };
  const stages = report.stages.map((stage) => `
    <div class="task-run-clean-stage">
      <span>${escapeHtml(stage.name)}</span>
      <b>${stage.input} → ${stage.output}</b>
      <small>${escapeHtml(stage.result)}</small>
    </div>
  `).join("");
  const sources = report.sources.length ? report.sources.map((source) => `
    <div class="task-run-clean-reason">
      <div><b>${escapeHtml(providerName(source.providerCode))}</b><code>返回 ${source.rawCount} · 无效 ${source.invalidCount} · 重复 ${source.duplicateCount} · 拒绝 ${source.rejectedCount}</code></div>
      <strong>${source.candidateCount} 入池</strong>
    </div>
  `).join("") : `<div class="task-run-insight-empty">暂无来源清洗统计。</div>`;
  const reasons = report.reasons.length ? report.reasons.map((reason) => `
    <div class="task-run-clean-reason">
      <div><b>${escapeHtml(reason.label)}</b><code>${escapeHtml(reason.code)}</code></div>
      <strong>${reason.count} 条</strong>
    </div>
  `).join("") : `<div class="task-run-insight-empty">本轮没有淘汰、合并或分流记录。</div>`;
  const outcomeLabels: Record<ProspectRunCleaningReport["records"][number]["outcome"], string> = {
    pending: "等待清洗",
    accepted: "进入候选池",
    merged: "合并到已有候选",
    suppressed: "规则分流",
    rejected: "清洗淘汰"
  };
  const processedRecords = report.records.filter((record) => record.outcome !== "pending");
  const processedRows = processedRecords.map((record) => `
    <tr>
      <td><span>--</span></td>
      <td><b>${escapeHtml(providerName(record.providerCode))}</b><span title="${escapeHtml(record.hitId)}">${escapeHtml(record.hitId.slice(-12))}</span></td>
      <td><span class="task-run-clean-outcome is-${escapeHtml(record.outcome)}">${escapeHtml(outcomeLabels[record.outcome])}</span></td>
      <td><b>${escapeHtml(record.reason)}</b><span>${escapeHtml(record.reasonCode)}</span></td>
      <td><b>${escapeHtml(record.candidateName || "未进入候选池")}</b><span>${escapeHtml(record.website || record.websiteReason || (record.candidateId ? "官网发现待处理" : "无候选记录"))}${record.websiteProvider ? ` · ${escapeHtml(record.websiteProvider)}` : ""}</span></td>
      <td>${escapeHtml(leadTaskDetailTime(record.processedAt))}</td>
    </tr>
  `).join("");
  const pendingRows = pendingCandidates.map((record) => `
    <tr class="task-run-pending-row">
      <td><input type="checkbox" data-pending-hit-id="${escapeHtml(record.hitId)}" ${selectedPending.has(record.hitId) ? "checked" : ""} aria-label="选择 ${escapeHtml(record.company)}"></td>
      <td><b>${escapeHtml(providerName(record.providerCode))}</b><span title="${escapeHtml(record.hitId)}">${escapeHtml(record.hitId.slice(-12))}</span></td>
      <td><span class="task-run-clean-outcome is-pending">等待决定</span></td>
      <td><b>${escapeHtml(record.company || "公司名待确认")}</b><span>${escapeHtml([record.country, record.business].filter(Boolean).join(" · ") || record.previewError || "资料待核验")}</span></td>
      <td><b>${escapeHtml(record.contact || "联系人待确认")}</b><span>${escapeHtml(record.contactInfo || record.website || record.sourceUrl || "暂无联系方式")}</span></td>
      <td>${escapeHtml(leadTaskDetailTime(record.fetchedAt))}</td>
    </tr>
  `).join("");
  const records = pendingRows || processedRows
    ? `${pendingRows}${processedRows}`
    : `<tr><td colspan="6" class="empty-cell">暂无逐条处理记录</td></tr>`;
  box.innerHTML = `
    <div class="task-run-clean-stages">${stages}</div>
    <div class="task-run-clean-body">
      <div class="task-run-clean-reasons">
        <div class="task-run-clean-subhead"><span>按来源核对</span><span>${report.sources.length} 个来源</span></div>
        <div class="task-run-clean-reason-list">${sources}</div>
        <div class="task-run-clean-subhead"><span>淘汰与合并原因</span><span>${report.reasons.reduce((sum, item) => sum + item.count, 0)} 条</span></div>
        <div class="task-run-clean-reason-list">${reasons}</div>
      </div>
      <div>
        <div class="task-run-clean-subhead"><span>逐条去向与人工决定</span><span>最近 ${report.records.length} 条</span></div>
        <div class="task-run-clean-table-wrap">
          <table class="task-run-clean-table">
            <thead><tr><th>选择</th><th>来源 / 记录</th><th>处理结果</th><th>公司 / 业务</th><th>联系线索</th><th>时间</th></tr></thead>
            <tbody>${records}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
  qsa<HTMLInputElement>("[data-pending-hit-id]", box).forEach((input) => {
    input.onchange = () => {
      const selected = new Set(job.selectedPendingHitIds || []);
      if (input.checked) selected.add(input.dataset.pendingHitId || "");
      else selected.delete(input.dataset.pendingHitId || "");
      selected.delete("");
      job.selectedPendingHitIds = [...selected];
      renderLeadTaskCleaningReport(job);
    };
  });
}

function leadTaskResultCandidates(job: LeadFinderJob) {
  const resultIds = new Set(job.resultIds || []);
  return state.websiteOpportunities.filter((item) => resultIds.has(item.id));
}

function renderLeadTaskCandidates(job: LeadFinderJob) {
  const box = qs<HTMLElement>("#leadTaskCandidates");
  const summary = qs<HTMLElement>("#leadTaskCandidatesSummary");
  const selectAll = qs<HTMLInputElement>("#leadTaskSelectAllCandidates");
  const syncButton = qs<HTMLButtonElement>("#leadTaskSyncCandidates");
  const openButton = qs<HTMLButtonElement>("#leadTaskOpenCandidateList");
  if (!box || !summary || !selectAll || !syncButton || !openButton) return;
  const candidates = leadTaskResultCandidates(job);
  const available = candidates.filter(canSelectLeadFinderItem);
  const availableIds = new Set(available.map((item) => item.id));
  const selected = new Set((job.selectedResultIds || []).filter((id) => availableIds.has(id)));
  job.selectedResultIds = [...selected];
  summary.textContent = `${available.length} 条可选 · 已选 ${selected.size} 条`;
  syncButton.disabled = selected.size === 0;
  syncButton.textContent = selected.size ? `加入搜客清单（${selected.size}）` : "加入搜客清单";
  selectAll.disabled = available.length === 0;
  selectAll.checked = available.length > 0 && selected.size === available.length;
  selectAll.indeterminate = selected.size > 0 && selected.size < available.length;
  openButton.onclick = () => activateNavView("prospect-list", () => {
    state.prospectFilter = "all";
    state.prospectPage = 1;
    renderProspectList();
  });
  syncButton.onclick = () => void syncSelectedLeadTaskCandidates(job, syncButton);
  selectAll.onchange = () => {
    job.selectedResultIds = selectAll.checked ? available.map((item) => item.id) : [];
    renderLeadTaskCandidates(job);
  };
  if (!candidates.length) {
    const missingCount = job.resultIds?.length || 0;
    box.innerHTML = `<div class="task-run-insight-empty">${missingCount
      ? "正在读取本任务候选资料。"
      : leadTaskJobIsLive(job)
        ? "任务仍在搜索和清洗，形成候选后会显示在这里。"
        : `本任务未形成可加入搜客清单的候选。<br><button class="lead-no-result-action" type="button" data-task-empty-report>查看未找到原因</button>`}</div>`;
    qs<HTMLButtonElement>("[data-task-empty-report]", box)?.addEventListener("click", () => openLeadFinderNoResultReport(job));
    return;
  }
  box.innerHTML = `<div class="task-run-candidate-list">${candidates.map((item) => {
    const selectable = canSelectLeadFinderItem(item);
    const duplicate = leadFinderDuplicateState(item);
    const status = prospectStatusMeta(item);
    const stateText = selectable
      ? "可加入搜客清单"
      : item.shortlistedAt
        ? "已在搜客清单"
        : item.status === "synced"
          ? "已加入线索"
        : duplicate.text !== "新候选"
          ? duplicate.text
          : status.label;
    const contactPerson = websiteContactPersonDisplay(item);
    const contactDisplay = websiteContactDisplay(item);
    return `
      <label class="task-run-candidate-row ${selectable ? "" : "is-disabled"}">
        <input type="checkbox" data-task-candidate-id="${escapeHtml(item.id)}" ${selected.has(item.id) ? "checked" : ""} ${selectable ? "" : "disabled"} aria-label="选择 ${escapeHtml(item.company)}">
        <div><b>${escapeHtml(item.company || "公司待确认")}</b><span>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(websiteDomain(item.website) || "官网待补充")}</span></div>
        <div><b>${escapeHtml(item.sourceLabel || state.leadProviders.find((provider) => provider.id === item.source)?.name || item.source || "来源待确认")}</b><span>${escapeHtml(item.business || "业务待核验")}</span></div>
        <div><b>${escapeHtml(contactPerson.value)}</b><span>${escapeHtml(contactDisplay.value)}</span></div>
        <strong class="task-run-candidate-score">${leadFinderScore(item)} 分</strong>
        <em class="task-run-candidate-state ${selectable ? "" : "is-disabled"}">${escapeHtml(stateText)}</em>
        ${prospectResearchRunning(item) ? researchRunningBadgeHtml() : ""}
        <button class="btn lead-task-research-btn" type="button" data-task-research-id="${escapeHtml(item.id)}" title="对该候选执行 AI 背调">背调</button>
      </label>
    `;
  }).join("")}</div>`;
  qsa<HTMLInputElement>("[data-task-candidate-id]", box).forEach((input) => {
    input.onchange = () => {
      const next = new Set(job.selectedResultIds || []);
      const id = input.dataset.taskCandidateId || "";
      if (input.checked) next.add(id);
      else next.delete(id);
      next.delete("");
      job.selectedResultIds = [...next];
      renderLeadTaskCandidates(job);
    };
  });
  // 行内「背调」：外层是 label，必须阻止默认行为，否则会误触勾选框
  qsa<HTMLButtonElement>("[data-task-research-id]", box).forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const item = state.websiteOpportunities.find((row) => row.id === button.dataset.taskResearchId);
      if (item) openLeadCandidateResearch(item);
    });
  });
}

async function syncSelectedLeadTaskCandidates(job: LeadFinderJob, button: HTMLButtonElement) {
  const selectedIds = [...new Set(job.selectedResultIds || [])];
  if (!selectedIds.length) return;
  const completed = await shortlistLeadFinderRows(button, selectedIds, job.backendRunId || job.id);
  if (!completed) return;
  job.selectedResultIds = [];
  renderLeadTaskCandidates(job);
}

async function loadLeadTaskPendingCandidates(job: LeadFinderJob) {
  if (!job.backendRunId || job.pendingCandidatesLoaded) return;
  const path = job.superSearchMissionId
    ? `/api/prospect-super-search/${encodeURIComponent(job.superSearchMissionId)}/pending-candidates`
    : `/api/prospect-runs/${encodeURIComponent(job.backendRunId)}/pending-candidates`;
  try {
    const result = await api<{ candidates: ProspectPendingCandidatePreview[] }>(path);
    job.pendingCandidates = result.candidates || [];
    job.selectedPendingHitIds = (job.selectedPendingHitIds || []).filter((id) =>
      job.pendingCandidates?.some((item) => item.hitId === id)
    );
    job.pendingCandidatesLoaded = true;
    if (activeLeadFinderJobId === job.id) renderLeadTaskCleaningReport(job);
  } catch (error) {
    if (!leadTaskJobIsLive(job)) {
      toast(error instanceof Error ? error.message : "待清洗结果读取失败", "error");
    }
  }
}

async function importPendingLeadTaskResults(
  job: LeadFinderJob,
  button: HTMLButtonElement
) {
  const hitIds = [...new Set(job.selectedPendingHitIds || [])];
  if (!job.backendRunId || !hitIds.length) return;
  const original = button.textContent || "纳入候选池";
  button.disabled = true;
  button.textContent = "正在处理";
  try {
    const path = job.superSearchMissionId
      ? `/api/prospect-super-search/${encodeURIComponent(job.superSearchMissionId)}/import-pending`
      : `/api/prospect-runs/${encodeURIComponent(job.backendRunId)}/import-pending`;
    const response = await api<{
      result: {
        attempted: number;
        processed: number;
        created: number;
        updated: number;
        suppressed: number;
        skipped: number;
        failures: Array<{ code: string }>;
      };
      detail: ProspectRunDetailApiResponse | { mission: ProspectSuperSearchMissionApi };
    }>(path, {
      method: "POST",
      body: JSON.stringify({ hitIds })
    });
    job.pendingCandidatesLoaded = false;
    job.pendingCandidates = [];
    job.selectedPendingHitIds = [];
    await loadProspectRuns(true);
    const refreshedJob = leadFinderJobs.find((item) => item.id === activeLeadFinderJobId);
    if (refreshedJob) await loadLeadTaskPendingCandidates(refreshedJob);
    const opportunities = await api<{ opportunities: WebsiteOpportunity[] }>("/api/tools/website-opportunities");
    state.websiteOpportunities = opportunities.opportunities || [];
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    renderLeadTaskDetail();
    toast(
      response.result.failures.length
        ? `已处理 ${response.result.processed} 条，${response.result.failures.length} 条仍未完成`
        : `已选记录已纳入候选池：新增 ${response.result.created} 条，合并更新 ${response.result.updated} 条；可在下方选择并加入线索`
    );
  } catch (error) {
    toast(error instanceof Error ? error.message : "纳入候选池失败", "error");
    button.disabled = false;
    button.textContent = original;
  }
}

function renderLeadTaskStrategy(job: LeadFinderJob) {
  const box = qs<HTMLElement>("#leadTaskStrategyGrid");
  if (!box) return;
  const pairs = (job.detailLines || []).map((line) => {
    const separator = line.indexOf("：");
    return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : ["任务条件", line];
  });
  box.innerHTML = pairs.map(([label, value]) => `
    <div class="task-run-strategy-item"><span>${escapeHtml(label)}</span><b title="${escapeHtml(value)}">${escapeHtml(value)}</b></div>
  `).join("");
}

function updateLeadTaskDetailClock() {
  if (qs<HTMLElement>(".view.active")?.id !== "lead-task-detail") return;
  const job = leadFinderJobs.find((item) => item.id === activeLeadFinderJobId);
  if (!job) return;
  const elapsed = qs<HTMLElement>("[data-task-run-elapsed]");
  if (elapsed) {
    if (["done", "partial", "failed", "cancelled"].includes(job.status)) {
      elapsed.textContent = job.elapsedText;
      return;
    }
    const start = new Date(job.createdAt).getTime();
    const seconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    elapsed.textContent = `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }
}

export function syncLeadTaskDetailClock(active: boolean) {
  const job = leadFinderJobs.find((item) => item.id === activeLeadFinderJobId);
  const shouldRun = active && leadTaskJobIsLive(job);
  if (!shouldRun) {
    if (leadTaskDetailClockTimer) window.clearInterval(leadTaskDetailClockTimer);
    leadTaskDetailClockTimer = 0;
    updateLeadTaskDetailClock();
    return;
  }
  if (!leadTaskDetailClockTimer) {
    leadTaskDetailClockTimer = window.setInterval(updateLeadTaskDetailClock, 1_000);
  }
  updateLeadTaskDetailClock();
}

function renderLeadTaskAcceptance(job: LeadFinderJob) {
  const box = qs<HTMLElement>("#leadTaskAcceptance");
  if (!box) return;
  const acceptance = job.acceptance;
  if (!acceptance) {
    box.innerHTML = `<div class="task-run-insight-empty">正在等待任务验收数据。</div>`;
    return;
  }
  const labels: Record<ProspectAcceptanceApi["outcome"], string> = {
    running: "执行中",
    success: "成功",
    partial_success: "部分成功",
    failed: "失败",
    empty: "无有效结果",
    cancelled: "已取消"
  };
  const costs = acceptance.costs?.length
    ? acceptance.costs.map((item) =>
        `${item.currency} ${item.amount.toFixed(4)}`
      ).join(" + ")
    : acceptance.totalCost
      ? `${acceptance.currency || ""} ${acceptance.totalCost.toFixed(4)}`.trim()
      : "0";
  box.innerHTML = `
    <div class="task-acceptance-result is-${escapeHtml(acceptance.outcome)}"><span>验收结论</span><b>${escapeHtml(labels[acceptance.outcome])}</b></div>
    <div><span>来源返回 / 候选池 / 待审核 / 审核通过 · 深挖研究就绪</span><b>${acceptance.sourceReturnedCount || 0} / ${acceptance.candidateCount} / ${acceptance.reviewReadyCount || 0} / ${acceptance.vqaCount} · ${acceptance.researchReadyCount || 0}${acceptance.targetCandidateCount ? ` / 候选目标 ${acceptance.targetCandidateCount}` : acceptance.targetVqaCount ? ` / 审核目标 ${acceptance.targetVqaCount}` : ""}</b></div>
    <div><span>来源成功 / 失败 / 跳过</span><b>${acceptance.sourceSuccessCount} / ${acceptance.sourceFailureCount} / ${acceptance.sourceSkippedCount}</b></div>
    <div><span>实际费用</span><b>${escapeHtml(costs)}${acceptance.costUnknownCount ? ` · ${acceptance.costUnknownCount} 笔未知` : ""}</b></div>
    <div class="task-acceptance-wide"><span>结束原因</span><b>${escapeHtml(acceptance.stopReason || (acceptance.outcome === "running" ? "任务仍在执行" : "执行器已结束"))}</b></div>
    <div class="task-acceptance-wide"><span>建议下一步</span><b>${escapeHtml(acceptance.recommendedNextAction)}</b></div>
  `;
}

function deepRelationLabel(type = "") {
  const labels: Record<string, string> = {
    parent_subsidiary: "母子公司",
    brand_distributor: "品牌与经销",
    buyer_supplier: "买卖方",
    project_owner_contractor: "业主与承包商",
    procurement_award: "采购中标",
    certified_partner: "认证伙伴",
    regional_representative: "区域代表",
    contact_channel: "公开联系渠道",
    related_company: "来源关联企业"
  };
  return labels[type] || "待核验关系";
}

function renderLeadTaskDeepMining(job: LeadFinderJob) {
  const section = qs<HTMLElement>("#leadTaskDeepMiningSection");
  const box = qs<HTMLElement>("#leadTaskDeepMining");
  const summaryBox = qs<HTMLElement>("#leadTaskDeepMiningSummary");
  if (!section || !box || !summaryBox) return;
  const mining = job.deepMining;
  section.hidden = !mining;
  if (!mining) return;
  summaryBox.textContent = mining.status === "completed"
    ? "深挖已归档"
    : mining.status === "verifying" ? "官网验证中" : "深挖执行中";
  const nodes = [...mining.nodes].sort((left, right) =>
    left.rootCandidateId.localeCompare(right.rootCandidateId)
    || left.depth - right.depth
    || left.createdAt.localeCompare(right.createdAt)
  );
  box.innerHTML = `
    <div class="task-deep-summary-line">
      <span>根候选<b>${mining.summary.rootCandidateCount}</b></span>
      <span>研究节点<b>${mining.summary.researchedCandidateCount}</b></span>
      <span>关系<b>${mining.summary.relationCount}</b></span>
      <span>来源证据<b>${mining.summary.evidenceCount}</b></span>
      <span>研究就绪<b>${mining.summary.researchReadyCount}</b></span>
      <span>查询预算<b>${mining.queriesUsed}/${mining.maxQueries}</b></span>
    </div>
    ${nodes.length ? `<div class="task-deep-list">${nodes.map((node) => {
      const parent = mining.nodes.find((item) => item.id === node.parentNodeId);
      const edge = mining.edges.find((item) => item.toNodeId === node.id);
      const evidence = node.evidenceIds
        .map((id) => mining.evidence.find((item) => item.id === id))
        .filter((item): item is ProspectDeepMiningApi["evidence"][number] => Boolean(item));
      const latestEvidence = evidence[evidence.length - 1];
      const task = mining.tasks.find((item) => item.nodeId === node.id);
      const source = latestEvidence ? normalizeWebsiteLink(latestEvidence.sourceUrl) : "#";
      return `<article class="task-deep-row">
        <div><b>${escapeHtml(node.company || "企业名称待确认")}</b><span>${escapeHtml(node.country || "国家待确认")} · 第 ${node.depth} 层</span><small>加入研究 ${escapeHtml(leadTaskDetailDateTime(node.createdAt))}</small></div>
        <div><span>${node.depth === 0 ? "根候选" : escapeHtml(deepRelationLabel(edge?.relationType))}</span><b>${escapeHtml(parent?.company || (node.depth === 0 ? "本次研究起点" : "父节点待恢复"))}</b><small>${edge ? `关系验证 ${edge.confidence} 分${edge.verified ? " · 已交叉佐证" : " · 待复核"}` : "等待关系证据"}</small></div>
        <div class="task-deep-scores"><span>企业验证 ${node.enterpriseVerificationScore}</span><span>联系就绪 ${node.contactReadinessScore}</span><span>行动优先 ${node.actionPriorityScore}</span><small>${node.conflict ? "存在证据冲突" : escapeHtml(node.verificationStatus)}</small></div>
        <div><span>${latestEvidence ? escapeHtml(latestEvidence.providerId) : "尚无来源证据"}</span><b>${escapeHtml(latestEvidence?.summary || task?.stopReason || "等待带来源的搜索结果")}</b>${source !== "#" ? `<a href="${escapeHtml(source)}" target="_blank" rel="noreferrer">打开原始来源</a>` : ""}<small>${escapeHtml(task?.stopReason || (task ? `状态：${task.status}` : "仅作为关系节点归档"))}</small></div>
      </article>`;
    }).join("")}</div>` : `<div class="task-run-insight-empty">候选入池后会自动选择高优先级根候选开始深挖。</div>`}
    ${mining.stopReason ? `<div class="task-deep-summary-line"><span>深挖停止原因<b>${escapeHtml(mining.stopReason)}</b></span></div>` : ""}
  `;
}

export function renderLeadTaskDetail() {
  const job = leadFinderJobs.find((item) => item.id === activeLeadFinderJobId);
  if (!job) {
    activeLeadFinderJobId = leadFinderJobs[0]?.id || null;
    if (!activeLeadFinderJobId) {
      activateNavView("lead-finder");
      return;
    }
    return renderLeadTaskDetail();
  }
  const live = leadTaskJobIsLive(job);
  const status = qs<HTMLElement>("#leadTaskDetailStatus");
  const title = qs<HTMLElement>("#leadTaskDetailTitle");
  const meta = qs<HTMLElement>("#leadTaskDetailMeta");
  const actions = qs<HTMLElement>("#leadTaskDetailActions");
  const stage = qs<HTMLElement>("#leadTaskDetailStage");
  const metrics = qs<HTMLElement>("#leadTaskDetailMetrics");
  if (!status || !title || !meta || !actions || !stage || !metrics) return;
  title.textContent = job.title;
  status.className = `task-run-status ${leadTaskDetailStatusClass(job)}`;
  status.innerHTML = `<i class="task-run-status-dot"></i><span>${escapeHtml(leadFinderJobStatusText(job))}</span>`;
  meta.innerHTML = `
    <span>任务编号 <code>${escapeHtml(job.backendRunId || job.id)}</code></span>
    <span>开始于 ${escapeHtml(leadTaskDetailDateTime(job.createdAt))}</span>
    <span>已持续 <b data-task-run-elapsed>00:00</b></span>
  `;
  actions.innerHTML = `
    ${job.backendRunId && job.backendRunStatus === "queued" ? `<button class="btn" data-lead-detail-action="pause">暂停</button>` : ""}
    ${job.backendRunId && job.backendRunStatus === "paused" ? `<button class="btn primary" data-lead-detail-action="resume">恢复</button>` : ""}
    ${job.backendRunId && ["queued", "paused"].includes(job.backendRunStatus || "") ? `<button class="btn danger" data-lead-detail-action="cancel">取消任务</button>` : ""}
  `;
  const currentStep = job.steps[Math.min(job.steps.length - 1, Math.floor((Math.max(job.progress, 1) / 100) * job.steps.length))] || "准备执行";
  stage.innerHTML = `
    <div><small>当前执行阶段</small><b>${escapeHtml(currentStep)}</b><p>${live ? "任务在后台持续推进，离开此页面不会中断执行。" : "任务状态与过程记录已保存，可随时返回查看。"}</p></div>
    <span class="task-run-progress-text">${escapeHtml(job.progressValue || leadFinderJobStatusText(job))}</span>
    <div class="task-run-progress-track ${live ? "is-running" : ""}"><i style="--p:${Math.max(2, job.progress)}%"></i></div>
  `;
  const stats = job.incrementalStats;
  const cleaningSummary = job.cleaningReport?.summary;
  const metricRows: Array<[string, string, string, string]> = [
    ["来源返回", cleaningSummary ? String(cleaningSummary.providerRawCount) : stats ? String(stats.rawCount) : "--", "所有来源原始命中", ""],
    ["进入候选池", cleaningSummary ? String(cleaningSummary.candidateCount) : String(job.resultIds?.length || 0), "已通过清洗，可继续核验", "is-gain"],
    ["研究就绪", String(job.deepMining?.summary.researchReadyCount || 0), "企业验证和来源证据达到研究门槛", job.deepMining?.summary.researchReadyCount ? "is-gain" : ""],
    ["关系 / 证据", job.deepMining ? `${job.deepMining.summary.relationCount} / ${job.deepMining.summary.evidenceCount}` : "0 / 0", "候选级证据图谱累计", job.deepMining?.summary.evidenceCount ? "is-gain" : ""],
  ];
  metrics.innerHTML = metricRows.map(([label, value, hint, tone]) => `<div class="task-run-metric ${tone}"><span>${label}</span><b>${escapeHtml(value)}</b><small>${hint}</small></div>`).join("");
  renderLeadTaskAcceptance(job);
  renderLeadTaskDeepMining(job);
  renderLeadTaskStream(job);
  renderLeadTaskPhases(job);
  renderLeadTaskInsights(job);
  renderLeadTaskSources(job);
  renderLeadTaskCleaningReport(job);
  renderLeadTaskCandidates(job);
  renderLeadTaskStrategy(job);
  // 获客效果复盘与搜索入口已移入任务详情，打开/刷新详情时同步最新内容
  renderProspectFeedback();
  renderLeadFinderSearchLinks();
  void loadProspectFeedback(true);
  qs<HTMLButtonElement>("#leadTaskDetailBack")!.onclick = () => activateNavView("lead-finder");
  qs<HTMLButtonElement>("#leadTaskNewEvents")!.onclick = () => {
    const stream = qs<HTMLElement>("#leadTaskStream");
    if (stream) stream.scrollTop = stream.scrollHeight;
    const button = qs<HTMLButtonElement>("#leadTaskNewEvents");
    if (button) {
      button.hidden = true;
      button.dataset.pending = "0";
    }
  };
  qsa<HTMLButtonElement>("[data-lead-detail-action]", actions).forEach((button) => {
    button.addEventListener("click", () => void transitionLeadFinderRun(job, button.dataset.leadDetailAction as "pause" | "resume" | "cancel", button));
  });
  const failureDialog = qs<HTMLDialogElement>("#leadTaskFailureDialog");
  const closeFailureDialog = qs<HTMLButtonElement>("#leadTaskFailureClose");
  if (failureDialog && closeFailureDialog) closeFailureDialog.onclick = () => failureDialog.close();
  syncLeadTaskDetailClock(qs<HTMLElement>(".view.active")?.id === "lead-task-detail");
  if (job.backendRunId && qs<HTMLElement>(".view.active")?.id === "lead-task-detail") {
    void startLeadTaskEventStream(job);
  }
}

function openLeadTaskDetail(job: LeadFinderJob) {
  activeLeadFinderJobId = job.id;
  activateNavView("lead-task-detail", () => {
    renderLeadTaskDetail();
    void startLeadTaskEventStream(job);
  });
  void Promise.all([
    loadLeadTaskPendingCandidates(job),
    refreshLeadFinderOpportunities()
  ]).then(() => {
    if (activeLeadFinderJobId === job.id) renderLeadTaskDetail();
  });
}

export function renderLeadFinderJobs() {
  const box = qs<HTMLElement>("#leadFinderJobList");
  renderLeadFinderLiveOverview();
  renderLeadFinderResultView();
  if (!box) return;
  if (!leadFinderJobs.length) {
    box.innerHTML = `<div class="empty-cell">暂无搜客任务</div>`;
    return;
  }
  box.innerHTML = leadFinderJobs.map((job) => `
    <article class="lead-job-card" data-lead-job-id="${escapeHtml(job.id)}">
      <div class="lead-job-top">
        <button class="lead-job-toggle" type="button" data-lead-job-toggle aria-label="${job.expanded ? "收起任务详情" : "展开任务详情"}">${job.expanded ? "▾" : "▸"}</button>
        <div><h3>${escapeHtml(job.title)}</h3><p>${escapeHtml(job.subtitle)}</p></div>
        ${badge(leadFinderJobStatusText(job), leadFinderJobStatusTone(job))}
      </div>
      <div class="lead-job-metrics">
        <div><span>${escapeHtml(job.metricLabel || (job.incrementalStats ? "净新增 / 命中" : "线索进度"))}</span><b>${escapeHtml(job.metricValue || (job.incrementalStats ? `${job.incrementalStats.newCount} / ${job.incrementalStats.returnedCount}` : `${job.resultCount}/目标`))}</b></div>
        <div><span>已耗时</span><b>${escapeHtml(job.elapsedText)}</b></div>
        <div><span>启用渠道</span><b>${job.channelCount} 个</b></div>
        <div><span>${escapeHtml(job.progressLabel || "预计进度")}</span><b>${escapeHtml(job.progressValue || `${job.progress}%`)}</b></div>
      </div>
      <div class="lead-job-progress"><i style="--p:${job.progress}%"></i></div>
      <div class="lead-job-steps">${job.steps.map((step, index) => `<span>${index + 1} ${escapeHtml(step)}</span>`).join("")}</div>
      ${renderLeadFinderJobDetails(job)}
      <div class="lead-job-actions">
        <button class="lead-job-open-hint" type="button" data-lead-job-open><span><svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg></span>查看详情</button>
        ${job.backendRunId && job.backendRunStatus === "queued" ? `<button class="btn" data-lead-run-action="pause">暂停任务</button>` : ""}
        ${job.backendRunId && job.backendRunStatus === "paused" ? `<button class="btn primary" data-lead-run-action="resume">恢复任务</button>` : ""}
        ${job.backendRunId && ["queued", "paused"].includes(job.backendRunStatus || "") ? `<button class="btn danger" data-lead-run-action="cancel">取消任务</button>` : ""}
      </div>
    </article>
  `).join("");
  qsa<HTMLButtonElement>("[data-lead-job-open]", box).forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.closest<HTMLElement>("[data-lead-job-id]")?.dataset.leadJobId;
      const job = leadFinderJobs.find((item) => item.id === id);
      if (job) openLeadTaskDetail(job);
    });
  });
  qsa<HTMLButtonElement>("[data-lead-job-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.closest<HTMLElement>("[data-lead-job-id]")?.dataset.leadJobId;
      const job = leadFinderJobs.find((item) => item.id === id);
      if (!job) return;
      job.expanded = !job.expanded;
      renderLeadFinderJobs();
    });
  });
  qsa<HTMLButtonElement>("[data-lead-job-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedLeadFinderId = button.dataset.leadJobPick || null;
      renderLeadFinder(state.websiteOpportunities);
    });
  });
  qsa<HTMLButtonElement>("[data-lead-run-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.closest<HTMLElement>("[data-lead-job-id]")?.dataset.leadJobId;
      const job = leadFinderJobs.find((item) => item.id === id);
      const action = button.dataset.leadRunAction as "pause" | "resume" | "cancel";
      if (job) void transitionLeadFinderRun(job, action, button);
    });
  });
}

async function transitionLeadFinderRun(
  job: LeadFinderJob,
  action: "pause" | "resume" | "cancel",
  button: HTMLButtonElement
) {
  if (!job.backendRunId || !job.backendRunRevision) return;
  const original = button.textContent || "";
  button.disabled = true;
  button.textContent = action === "pause" ? "暂停中" : action === "resume" ? "恢复中" : "取消中";
  try {
    const path = job.superSearchMissionId
      ? `/api/prospect-super-search/${encodeURIComponent(job.superSearchMissionId)}/${action}`
      : `/api/prospect-runs/${encodeURIComponent(job.backendRunId)}/${action}`;
    const revision = job.superSearchMissionId ? job.superSearchRevision : job.backendRunRevision;
    await api(path, {
      method: "POST",
      headers: { "If-Match": `"${job.superSearchMissionId || job.backendRunId}:${revision}"` },
      body: JSON.stringify({
        reason: action === "pause" ? "用户从获客任务队列暂停" : action === "resume" ? "用户从获客任务队列恢复" : "用户从获客任务队列取消"
      })
    });
    await loadProspectRuns(false);
    toast(action === "pause" ? "获客任务已暂停" : action === "resume" ? "获客任务已恢复" : "获客任务已取消");
  } catch (error) {
    await loadProspectRuns(true);
    toast(error instanceof Error ? error.message : "任务状态变更失败", "error");
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function prospectSuggestionLabel(type: ProspectStrategySuggestionType) {
  const labels: Record<ProspectStrategySuggestionType, string> = {
    refine_targeting_keywords: "优化目标关键词",
    increase_provider_priority: "提高来源优先级",
    decrease_provider_priority: "降低来源优先级",
    review_icp_exclusions: "复核 ICP 排除条件",
    review_icp_weights: "复核 ICP 评分权重"
  };
  return labels[type];
}

function prospectRevenueText(rows: Array<{ currency: string; amount: number }>) {
  if (!rows.length) return "暂无";
  return rows.map((row) => dealMoney(row.amount, row.currency)).join(" + ");
}

function renderProspectFeedback() {
  const metricsBox = qs<HTMLElement>("#prospectPerformanceMetrics");
  const suggestionsBox = qs<HTMLElement>("#prospectStrategySuggestionList");
  const countBox = qs<HTMLElement>("#prospectSuggestionCount");
  if (!metricsBox || !suggestionsBox || !countBox) return;
  const metrics = state.prospectPerformance?.metrics;
  if (!metrics) {
    metricsBox.innerHTML = `<div class="prospect-performance-empty">效果数据加载中...</div>`;
  } else {
    const metricRows = [
      ["候选", metrics.candidates],
      ["已触达", metrics.contacted],
      ["有效回复", `${metrics.validReplies} · ${metrics.validReplyRate}%`],
      ["已入线索", metrics.leads],
      ["已转客户", metrics.customers],
      ["已建商机", metrics.deals],
      ["成交 / 丢单", `${metrics.won} / ${metrics.lost}`]
    ];
    metricsBox.innerHTML = `
      ${metricRows.map(([label, value]) => `<div><span>${escapeHtml(String(label))}</span><b>${escapeHtml(String(value))}</b></div>`).join("")}
      <div class="prospect-performance-revenue"><span>获客成交额</span><b>${escapeHtml(prospectRevenueText(metrics.wonRevenue))}</b></div>
    `;
  }
  const suggestions = state.prospectStrategySuggestions;
  countBox.textContent = suggestions.length ? `${suggestions.length} 条待审核` : "暂无待审核建议";
  suggestionsBox.innerHTML = suggestions.length ? suggestions.map((suggestion) => `
    <article class="prospect-suggestion-row" data-prospect-suggestion-id="${escapeHtml(suggestion.id)}">
      <div>
        <span>${escapeHtml(prospectSuggestionLabel(suggestion.suggestionType))}</span>
        <b>${escapeHtml(suggestion.rationale)}</b>
      </div>
      <div class="prospect-suggestion-actions">
        <button class="btn primary" type="button" data-prospect-suggestion-review="accept">记录采纳</button>
        <button class="btn" type="button" data-prospect-suggestion-review="reject">暂不采用</button>
      </div>
    </article>
  `).join("") : `<div class="prospect-performance-empty">暂无策略建议</div>`;
  qsa<HTMLButtonElement>("[data-prospect-suggestion-review]", suggestionsBox).forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest<HTMLElement>("[data-prospect-suggestion-id]");
      const action = button.dataset.prospectSuggestionReview === "accept" ? "accept" : "reject";
      if (row?.dataset.prospectSuggestionId) {
        void reviewProspectSuggestion(row.dataset.prospectSuggestionId, action, button);
      }
    });
  });
}

export async function loadProspectFeedback(quiet = false, force = false) {
  if (!state.user || prospectFeedbackLoading) return;
  if (!force && Date.now() - prospectFeedbackLoadedAt < 15_000) return;
  prospectFeedbackLoading = true;
  try {
    const performanceResult = await api<{ performance: ProspectPerformance }>("/api/prospect-performance");
    const suggestionResult = await api<{ suggestions: ProspectStrategySuggestion[] }>("/api/prospect-strategy-suggestions?status=pending");
    state.prospectPerformance = performanceResult.performance;
    state.prospectStrategySuggestions = suggestionResult.suggestions;
    prospectFeedbackLoadedAt = Date.now();
    renderProspectFeedback();
  } catch (error) {
    if (!quiet) {
      toast(error instanceof Error ? `获客复盘加载失败：${error.message}` : "获客复盘加载失败", "error");
    }
  } finally {
    prospectFeedbackLoading = false;
  }
}

async function reviewProspectSuggestion(
  id: string,
  action: "accept" | "reject",
  button: HTMLButtonElement
) {
  button.disabled = true;
  try {
    await api(`/api/prospect-strategy-suggestions/${encodeURIComponent(id)}/${action}`, {
      method: "POST",
      body: JSON.stringify({})
    });
    await loadProspectFeedback(false, true);
    toast(action === "accept" ? "已记录采纳，现有策略未被自动修改" : "已记录暂不采用");
  } catch (error) {
    toast(error instanceof Error ? error.message : "策略建议处理失败", "error");
  } finally {
    button.disabled = false;
  }
}

export function recordLeadFinderLaunchFailure(phase: string, error: unknown) {
  const reason = error instanceof Error ? error.message : "请检查网络、AI 配置和数据源状态后重试";
  const job = createLeadFinderJob("failed");
  job.title = `搜客启动失败 · ${currentLeadFinderTitle()}`;
  job.subtitle = "任务未获得后台执行确认，请按失败原因调整后重试";
  job.elapsedText = "已结束";
  job.progress = 100;
  job.steps = ["解析搜索目标", "校验来源与权限", "提交后台任务", "根据原因重试"];
  job.expanded = true;
  job.detailLines = [
    ...buildLeadFinderJobDetails(),
    `失败阶段：${phase}`,
    `失败原因：${reason}`,
    "调整建议：先处理上面的失败原因，再重新点击新建搜客任务；本条记录不会伪装成已启动。"
  ];
  renderLeadFinderJobs();
}

export function updateLeadFinderJob(
  jobId: string,
  resultIds: string[],
  status: LeadFinderJob["status"],
  incrementalStats?: LeadFinderIncrementalStats,
  sourceStats?: LeadFinderSourceStat[]
) {
  const job = leadFinderJobs.find((item) => item.id === jobId);
  if (!job) return;
  job.status = status;
  job.resultCount = resultIds.length;
  job.elapsedText = ["done", "partial", "failed"].includes(status) ? "已结束" : "待导入";
  job.progress = ["done", "partial", "failed"].includes(status) ? 100 : 52;
  job.steps = status === "done"
    ? ["生成搜索语法", "检索公开API", "提取公司资料", "等待同步"]
    : status === "partial"
      ? ["生成搜索语法", "检索公开API", "保留成功结果", "重试失败来源"]
      : status === "failed"
        ? ["生成搜索语法", "来源执行失败", "检查配置或网络", "重新运行任务"]
        : ["生成搜索语法", "打开平台入口", "导入官网/询盘链接"];
  job.resultIds = resultIds;
  job.incrementalStats = incrementalStats;
  job.sourceStats = sourceStats;
  job.detailLines = buildLeadFinderJobDetails(resultIds);
  renderLeadFinderJobs();
  if (qs<HTMLElement>(".view.active")?.id === "lead-task-detail" && activeLeadFinderJobId === job.id) {
    renderLeadTaskDetail();
  }
}

const prospectRunTerminalStatuses = new Set<ProspectRunApiStatus>([
  "cancelled",
  "succeeded",
  "succeeded_empty",
  "partial_success",
  "failed"
]);

export const prospectRunActiveStatuses = new Set<ProspectRunApiStatus>([
  "queued",
  "running",
  "pause_requested",
  "paused",
  "cancel_requested"
]);

function prospectRunJobStatus(status: ProspectRunApiStatus): LeadFinderJob["status"] {
  if (status === "succeeded" || status === "succeeded_empty") return "done";
  if (status === "partial_success") return "partial";
  if (status === "failed") return "failed";
  if (status === "paused") return "paused";
  if (status === "cancelled") return "cancelled";
  return "running";
}

export function prospectRunStatusLabel(status: ProspectRunApiStatus) {
  const labels: Record<ProspectRunApiStatus, string> = {
    queued: "等待中",
    running: "执行中",
    pause_requested: "执行中",
    paused: "已暂停",
    cancel_requested: "正在结束",
    cancelled: "已结束",
    succeeded: "已结束",
    succeeded_empty: "已结束",
    partial_success: "已结束",
    failed: "已结束"
  };
  return labels[status];
}

function prospectRunActivityLabel(status: ProspectRunApiStatus) {
  if (prospectRunTerminalStatuses.has(status)) return "执行已结束";
  if (["paused", "pause_requested"].includes(status)) return "执行已暂停";
  if (status === "cancel_requested") return "正在取消";
  return "后台持续执行";
}

function prospectShardStatusLabel(status: ProspectRunShardApiRecord["status"]) {
  const labels: Record<ProspectRunShardApiRecord["status"], string> = {
    queued: "等待执行",
    running: "正在执行",
    retry_scheduled: "等待重试",
    pause_requested: "正在暂停",
    paused: "已暂停",
    cancel_requested: "正在取消",
    cancelled: "已取消",
    succeeded: "执行完成",
    succeeded_empty: "完成无结果",
    partial_success: "结果已保存",
    failed: "执行失败"
  };
  return labels[status];
}

function prospectRunElapsedText(run: ProspectRunApiRecord) {
  const startedAt = new Date(run.createdAt).getTime();
  const finishedAt = prospectRunTerminalStatuses.has(run.status)
    ? new Date(run.updatedAt).getTime()
    : Date.now();
  const seconds = Math.max(0, Math.round((finishedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function prospectRunProgress(shards: ProspectRunShardApiRecord[], run: ProspectRunApiRecord) {
  if (prospectRunTerminalStatuses.has(run.status)) return 100;
  if (!shards.length) return 0;
  const progressUnits = shards.reduce((total, shard) => {
    if (["succeeded", "succeeded_empty", "partial_success", "failed", "cancelled"].includes(shard.status)) return total + 1;
    if (["running", "pause_requested", "cancel_requested"].includes(shard.status)) return total + 0.5;
    return total;
  }, 0);
  return Math.round((progressUnits / shards.length) * 100);
}

function prospectRunSteps(run: ProspectRunApiRecord, shards: ProspectRunShardApiRecord[]) {
  const completed = shards.filter((shard) => ["succeeded", "succeeded_empty", "partial_success"].includes(shard.status)).length;
  const failed = shards.filter((shard) => shard.status === "failed").length;
  if (run.status === "failed") return ["项目与策略已保存", "数据源执行失败", "查看来源配置", "可重新发起任务"];
  if (run.status === "partial_success") return ["项目与策略已保存", "数据源并行执行", `成功 ${completed} 个来源`, `失败 ${failed} 个来源`];
  if (run.status === "succeeded" || run.status === "succeeded_empty") return ["项目与策略已保存", "数据源执行完成", "结果已清洗入池", "等待业务核验"];
  if (run.status === "paused" || run.status === "pause_requested") return ["项目与策略已保存", "任务已进入队列", "执行暂停", "等待恢复"];
  if (run.status === "cancelled" || run.status === "cancel_requested") return ["项目与策略已保存", "任务已进入队列", "执行已取消", "可重新发起"];
  return ["项目与策略已保存", "任务已进入队列", "数据源后台执行", "结果清洗入池"];
}

export function prospectRunJob(detail: ProspectRunDetailApiResponse): LeadFinderJob {
  const run = detail.run;
  const snapshot = run.executionSnapshot;
  const campaign = snapshot?.campaign;
  const query = snapshot?.resolvedQuery;
  const settled = detail.shards.filter((shard) =>
    ["succeeded", "succeeded_empty", "partial_success", "failed", "cancelled"].includes(shard.status)
  ).length;
  const existingJob = leadFinderJobs.find((job) => job.backendRunId === run.id);
  const expanded = existingJob?.expanded || false;
  const providerName = (providerId: string) =>
    state.leadProviders.find((provider) => provider.id === providerId)?.name || providerId;
  const diagnosticsBySource = new Map((detail.diagnostics?.sources || []).map((item) => [item.shardId, item]));
  const cleaningBySource = new Map((detail.diagnostics?.cleaningReport?.sources || []).map((item) => [item.providerCode, item]));
  const processSummary = detail.diagnostics?.summary;
  const products = campaign?.snapshot.products || query?.positiveKeywords || [];
  const markets = campaign?.snapshot.markets || query?.countries || [];
  const industries = campaign?.snapshot.applicationScenarios || query?.industryTerms || [];
  const customerTypes = campaign?.snapshot.customerTypes || query?.customerTypes || [];
  return {
    id: run.id,
    backendRunId: run.id,
    backendRunRevision: run.revision,
    backendRunStatus: run.status,
    title: campaign?.name || `获客任务 ${run.id.slice(-8)}`,
    subtitle: `${industries.join("、") || "行业待补充"} · ${markets.join("、") || "目标市场"} · ${prospectRunActivityLabel(run.status)}`,
    status: prospectRunJobStatus(run.status),
    resultCount: processSummary?.accepted || 0,
    channelCount: detail.shards.length,
    elapsedText: prospectRunElapsedText(run),
    progress: prospectRunProgress(detail.shards, run),
    progressLabel: "执行状态",
    progressValue: prospectRunStatusLabel(run.status),
    metricLabel: processSummary ? "候选入池" : "分片进度",
    metricValue: processSummary ? String(processSummary.accepted) : `${settled} / ${detail.shards.length}`,
    steps: prospectRunSteps(run, detail.shards),
    createdAt: run.createdAt,
    runEvents: detail.events || [],
    processPhases: detail.diagnostics?.phases || [],
    cleaningReport: detail.diagnostics?.cleaningReport,
    acceptance: detail.diagnostics?.acceptance,
    pendingCandidates: existingJob?.pendingCandidates,
    selectedPendingHitIds: existingJob?.selectedPendingHitIds,
    pendingCandidatesLoaded: existingJob?.pendingCandidatesLoaded,
    liveEvents: existingJob?.liveEvents || [],
    expanded,
    resultIds: processSummary?.candidateIds || [],
    incrementalStats: processSummary ? {
      rawCount: processSummary.rawHits,
      returnedCount: processSummary.accepted + processSummary.rejected,
      deduplicatedCount: 0,
      newCount: processSummary.accepted,
      evidenceUpdatedCount: 0,
      multiSourceMergedCount: 0,
      unchangedCount: 0,
      excludedCount: processSummary.rejected
    } : undefined,
    detailLines: [
      `产品：${products.join("、") || "未填写"}`,
      `市场：${markets.join("、") || "未填写"}`,
      `行业：${industries.join("、") || "未填写"}`,
      `客户类型：${customerTypes.join("、") || "未填写"}`,
      `任务编号：${run.id}`
    ],
    sourceStats: detail.shards.map((shard) => {
      const diagnostics = diagnosticsBySource.get(shard.id);
      const cleaning = cleaningBySource.get(shard.providerCode);
      return {
        id: shard.providerCode,
        name: providerName(shard.providerCode),
        count: cleaning?.rawCount,
        rawCount: cleaning?.rawCount,
        invalidCount: cleaning?.invalidCount,
        duplicateCount: cleaning?.duplicateCount,
        processedCount: cleaning?.processedCount,
        rejectedCount: cleaning?.rejectedCount,
        candidateCount: cleaning?.candidateCount,
        status: shard.status,
        statusLabel: prospectShardStatusLabel(shard.status),
        error: diagnostics?.failure?.errorMessage || (shard.status === "failed" ? "执行失败，点击查看失败报文" : undefined),
        errorCode: diagnostics?.failure?.errorCode,
        retryable: diagnostics?.failure?.retryable ?? shard.status === "retry_scheduled",
        retryAfterAt: diagnostics?.failure?.retryAfterAt,
        createdAt: shard.createdAt,
        updatedAt: shard.updatedAt,
        failure: diagnostics?.failure,
        job: diagnostics?.job,
        checkpoint: diagnostics?.checkpoint,
        attempts: diagnostics?.attempts || [],
        requests: diagnostics?.requests || []
      };
    })
  };
}

function superSearchStatusLabel(status: ProspectSuperSearchMissionApi["status"]) {
  const labels: Record<ProspectSuperSearchMissionApi["status"], string> = {
    queued: "等待中",
    running: "执行中",
    paused: "已暂停",
    cancelled: "已结束",
    succeeded: "已结束",
    partial_success: "已结束",
    failed: "已结束"
  };
  return labels[status];
}

function superSearchThemeLabel(theme = "") {
  const labels: Record<string, string> = {
    baseline: "基础覆盖",
    local_channel: "当地语言渠道",
    procurement: "采购与招标",
    project_engineering: "项目与工程",
    trade_channel: "进口与批发渠道",
    oem_integration: "OEM 与系统集成",
    vendor_registration: "供应商准入",
    directory_association: "行业协会与目录",
    aftermarket_service: "售后与 MRO",
    contract_award: "中标与框架合同",
    expansion_signal: "扩产与新建项目",
    certification_ecosystem: "认证与授权生态",
    regional_long_tail: "区域长尾渠道",
    application_specialist: "应用方案商",
    replacement_demand: "改造与替换需求",
    coverage_recovery: "覆盖缺口恢复",
    deep_candidate: "候选关系深挖"
  };
  return labels[theme] || theme || "覆盖规划";
}

export function applySuperSearchMission(job: LeadFinderJob, mission: ProspectSuperSearchMissionApi) {
  // Older launch responses may omit the embedded round list; keep the first
  // render usable while the normal polling request refreshes the full mission.
  const rounds = Array.isArray(mission.rounds) ? mission.rounds : [];
  const maxRounds = Math.max(1, Number(mission.maxRounds) || rounds.length || 1);
  const active = ["queued", "running"].includes(mission.status);
  const status: LeadFinderJob["status"] = active
    ? "running"
    : mission.status === "paused" ? "paused"
      : mission.status === "cancelled" ? "cancelled"
        : mission.status === "failed" ? "failed"
          : mission.status === "partial_success" ? "partial" : "done";
  job.id = mission.id;
  job.title = `超级搜索 · ${job.title}`;
  job.subtitle = `第 ${mission.currentRound}/${maxRounds} 轮 · ${superSearchStatusLabel(mission.status)}`;
  job.status = status;
  job.resultCount = mission.candidateCount;
  job.progress = mission.status === "succeeded" || mission.status === "partial_success" || mission.status === "failed" || mission.status === "cancelled"
    ? 100
    : Math.round((Math.max(0, mission.currentRound - 1) / maxRounds) * 100 + 100 / maxRounds * (job.progress / 100));
  job.progressLabel = "轮次进度";
  job.progressValue = `${mission.currentRound} / ${mission.maxRounds} 轮`;
  job.metricLabel = "候选目标";
  job.metricValue = `${mission.candidateCount || 0} / ${mission.targetCandidateCount}`;
  job.acceptance = mission.acceptance;
  const currentRound = rounds.find((item) => item.roundNo === mission.currentRound)
    || rounds[rounds.length - 1];
  const query = currentRound?.queryPlanSnapshot;
  const theme = superSearchThemeLabel(currentRound?.queryTheme);
  const gaps = currentRound?.coverageGaps || [];
  const deepSummary = mission.deepMining?.summary;
  const webProviderNames = (mission.webProviderIds || []).map((providerId) =>
    state.leadProviders.find((provider) => provider.id === providerId)?.name || providerId
  );
  const mapProviderNames = (mission.mapProviderIds || []).map((providerId) =>
    state.leadProviders.find((provider) => provider.id === providerId)?.name || providerId
  );
  const aiDiscoveryProviderNames = (mission.aiDiscoveryProviderIds || []).map((providerId) =>
    state.leadProviders.find((provider) => provider.id === providerId)?.name || providerId
  );
  job.steps = ["生成覆盖矩阵", `${theme}检索`, "清洗与身份归一", "候选关系深挖", active ? "等待下一步事实" : "执行报告已生成"];
  job.detailLines = [
    ...(job.detailLines || []),
    `超级搜索：${superSearchStatusLabel(mission.status)}`,
    `本轮主题：${theme}`,
    `规划方式：${currentRound?.planningMode === "ai_enhanced" ? "AI 增强 + 规则校验" : "规则规划"}`,
    `本轮市场：${query?.countries?.join("、") || "全球"}`,
    `查询语言：${query?.languages?.join("、") || "自动"}`,
    `买家角色：${query?.customerTypes?.join("、") || "不限"}`,
    `覆盖缺口：${gaps.join("；") || "正在建立覆盖基线"}`,
    `查询矩阵：${currentRound?.queryCells?.length || job.channelCount} 个执行单元`,
    `实时网页搜索：${mission.webSearchMode === "api" ? webProviderNames.join("、") || "已启用" : "未启用"}`,
    `地图企业搜索：${mission.mapSearchMode === "google_places" ? mapProviderNames.join("、") || "Google Places" : "未启用"}`,
    `AI 查询辅助：${mission.aiDiscoveryMode === "model" ? aiDiscoveryProviderNames.join("、") || "AI 搜索" : "未启用"}`,
    `候选深挖：${deepSummary ? `${deepSummary.researchedCandidateCount || 0} 个节点 · ${deepSummary.relationCount || 0} 条关系 · ${deepSummary.evidenceCount || 0} 条证据` : "等待根候选"}`,
    `累计原始命中：${mission.rawCount} · 已过滤：${mission.filteredCount} · 待清洗：${mission.pendingCount}`,
    `轮次：${mission.currentRound}/${maxRounds} · 目标：${mission.targetCandidateCount}`,
    mission.stopReason ? `结束原因：${mission.stopReason}` : "任务会在达到目标、时长、预算或收敛条件后结束"
  ];
  job.superSearchMissionId = mission.id;
  job.superSearchRevision = mission.revision;
  job.superSearchStatus = mission.status;
  job.superSearchRound = mission.currentRound;
  job.superSearchMaxRounds = mission.maxRounds;
  job.superSearchTarget = mission.targetCandidateCount;
  job.superSearchRounds = rounds;
  job.deepMining = mission.deepMining;
  job.resultIds = mission.candidateIds || job.resultIds || [];
  return job;
}

function leadTaskLiveEventPhases(event: ProspectLiveEventApiRecord, providerName: string): string[] {
  const sourceLabel = providerName || "数据源";
  const pageLimit = Number(event.metrics.pageLimit || 0);
  const pageSequence = Number(event.metrics.pageSequence || 0);
  const accepted = Number(event.metrics.acceptedCount || 0);
  const raw = Number(event.metrics.rawCount || 0);
  const copy: Record<string, string[]> = {
    "execution.claimed": [
      `正在领取 ${sourceLabel} 执行任务`,
      "正在加载数据源凭据与限额",
      "正在建立检索连接"
    ],
    "attempt.claimed": [
      `正在领取 ${sourceLabel} 执行任务`,
      "正在准备检索参数"
    ],
    "execution.request_started": [
      `已向 ${sourceLabel} 发出请求，等待返回`,
      "正在等待数据源响应",
      "正在保持执行租约心跳"
    ],
    "attempt.request_started": [
      `已向 ${sourceLabel} 发出请求，等待返回`,
      "正在等待数据源响应"
    ],
    "execution.page_accepted": [
      `正在验收 ${sourceLabel} 返回的数据页`,
      "正在解析原始条目并校验有效性",
      "正在与候选池去重比对"
    ],
    "page.persisted": [
      pageSequence ? `第 ${pageSequence} 页已保存：原始 ${raw} · 接受 ${accepted}` : `正在保存 ${sourceLabel} 数据页`,
      accepted > 0 ? `已入库 ${accepted} 条有效条目，继续检索下一页` : "本页暂无有效条目，继续检索",
      pageLimit ? `检索持续推进中（上限 ${pageLimit} 页）` : "正在检索下一页"
    ],
    "candidate.persisted": [
      "候选已写入候选池",
      "正在继续累积有效候选"
    ],
    "candidate.rejected": [
      "候选未通过校验，已记录原因",
      "正在继续处理后续条目"
    ],
    "cell.planned": [
      "查询单元已规划完成，等待领取",
      "正在排队等待数据源执行"
    ],
    "mission.ai_planning_started": [
      "AI 正在生成查询矩阵",
      "正在校验市场与语言覆盖缺口",
      "正在生成查询单元"
    ],
    "run.started": [
      "任务开始执行，正在分发数据源",
      "正在并行推进各查询单元"
    ]
  };
  return copy[event.type] || [];
}

function leadTaskLiveEventLog(event: ProspectLiveEventApiRecord): LeadTaskStreamLog {
  const providerId = typeof event.metrics.providerId === "string"
    ? event.metrics.providerId
    : "";
  const source = providerId
    ? state.leadProviders.find((item) => item.id === providerId)?.name || providerId
    : event.stage === "deep_mining" ? "深挖"
      : event.entityType === "run" ? "任务"
      : event.entityType === "mission" ? "超级搜客"
        : event.entityType === "query_cell" ? "查询单元"
          : event.entityType === "candidate" ? "候选"
            : "执行器";
  let result = event.status || "已记录";
  if (event.type === "page.persisted") {
    result = `接受 ${Number(event.metrics.acceptedCount || 0)} / 原始 ${Number(event.metrics.rawCount || 0)}`;
  } else if (event.type === "candidate.persisted") {
    result = "已入候选池";
  } else if (event.type === "candidate.rejected") {
    result = "未入池";
  } else if (event.type.startsWith("run.")) {
    result = prospectRunStatusLabel(event.status as ProspectRunApiStatus);
  } else if (event.type === "cell.completed") {
    result = `${Number(event.metrics.candidateCount || 0)} 候选`;
  } else if (event.type.startsWith("attempt.")) {
    result = event.failureCode ? event.retryable ? "失败，可重试" : "失败" : "请求已结算";
  } else if (event.type === "mission.deep_evidence_found") {
    result = `${Number(event.metrics.evidenceCount || 0)} 条证据`;
  } else if (event.type === "mission.deep_relation_found") {
    result = `${Number(event.metrics.relationCount || 0)} 条关系`;
  } else if (event.type.startsWith("mission.deep_")) {
    result = event.type.endsWith("completed") ? "已归档" : "研究中";
  } else if (event.type === "mission.ai_planning_started") {
    result = "规划中";
  } else if (event.type === "mission.ai_planning_completed") {
    result = "已完成";
  } else if (event.type === "mission.ai_planning_fallback") {
    result = "规则已接管";
  }
  const failed = Boolean(event.failureCode)
    || ["failed", "rejected", "request_outcome_unknown"].includes(event.status);
  const gained = event.type === "candidate.persisted"
    || Number(event.metrics.acceptedCount || 0) > 0
    || Number(event.metrics.candidateCount || 0) > 0;
  const shardDetail = (() => {
    if (event.entityType !== "shard") return "";
    const providerName = typeof event.metrics.providerId === "string" && event.metrics.providerId
      ? state.leadProviders.find((item) => item.id === event.metrics.providerId)?.name || event.metrics.providerId
      : "";
    const parts = [
      providerName ? `数据源 ${providerName}` : "",
      Number(event.metrics.shardTotal || 0) > 0 ? `分片 ${Number(event.metrics.shardPosition || 0)}/${Number(event.metrics.shardTotal)}` : "",
      Number(event.metrics.pageLimit || 0) > 0 ? `限 ${Number(event.metrics.pageLimit)} 页 / ${Number(event.metrics.resultLimit || 0)} 条` : ""
    ].filter(Boolean);
    return parts.length ? parts.join(" · ") : `分片 ${event.entityId}`;
  })();
  return {
    key: `feed:${event.id}`,
    at: event.occurredAt,
    source,
    title: shardDetail
      ? leadFinderDisplayText(event.message.split("：")[0])
      : leadFinderDisplayText(event.message),
    detail: event.failureCode
      ? `${event.failureCode}${event.retryable ? " · 系统允许重试" : " · 不自动重试"}`
      : event.stage === "deep_mining"
        ? `候选级证据图谱 · ${event.entityId}`
        : shardDetail || `${event.stage} · ${event.entityType} ${event.entityId}`,
    result,
    tone: failed ? "is-failed" : gained ? "is-gain" : event.retryable ? "is-review" : "",
    phases: leadTaskLiveEventPhases(
      event,
      typeof event.metrics.providerId === "string" && event.metrics.providerId
        ? state.leadProviders.find((item) => item.id === event.metrics.providerId)?.name || event.metrics.providerId
        : ""
    )
  };
}

export function stopLeadTaskEventStream(enablePolling = true) {
  leadFinderStreamAbort?.abort();
  leadFinderStreamAbort = null;
  leadFinderStreamRunId = "";
  leadFinderStreamConnected = false;
  if (leadFinderStreamRefreshTimer) window.clearTimeout(leadFinderStreamRefreshTimer);
  leadFinderStreamRefreshTimer = 0;
  if (enablePolling) syncLeadFinderRunPolling();
}

function scheduleLeadTaskEventRefresh(event: ProspectLiveEventApiRecord) {
  const job = leadFinderJobs.find((item) => item.backendRunId === event.runId);
  if (["page.persisted", "candidate.persisted", "candidate.rejected"].includes(event.type)) {
    leadFinderOpportunityRefreshPending = true;
  }
  if (job && event.type === "candidate.persisted" && event.entityType === "candidate" && event.entityId) {
    job.resultIds = [...new Set([...(job.resultIds || []), event.entityId])];
    job.resultCount = Math.max(job.resultCount, job.resultIds.length);
    if (job.incrementalStats) job.incrementalStats.newCount = Math.max(job.incrementalStats.newCount, job.resultIds.length);
    if (job.cleaningReport) job.cleaningReport.summary.candidateCount = Math.max(job.cleaningReport.summary.candidateCount, job.resultIds.length);
  }
  if (job && event.progress !== null) job.progress = event.progress;
  if (job && activeLeadFinderJobId === job.id) {
    renderLeadTaskStream(job);
    syncLeadTaskStreamStateUi();
  }
  if (job && primaryLeadFinderLiveJob()?.id === job.id && qs<HTMLElement>(".view.active")?.id === "lead-finder") {
    renderLeadFinderLiveOverview();
  }
  if (leadFinderStreamRefreshTimer) return;
  leadFinderStreamRefreshTimer = window.setTimeout(() => {
    leadFinderStreamRefreshTimer = 0;
    const refreshOpportunities = leadFinderOpportunityRefreshPending;
    leadFinderOpportunityRefreshPending = false;
    void (async () => {
      await loadProspectRuns(true);
      if (refreshOpportunities) await refreshLeadFinderOpportunities();
    })();
  }, 350);
}

async function consumeLeadTaskEventStream(
  response: Response,
  onEvent: (event: ProspectLiveEventApiRecord) => void
) {
  if (!response.body) throw new Error("当前浏览器不支持流式任务事件");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = (block: string) => {
    const eventName = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim() || "message";
    if (eventName !== "prospect") return;
    const dataText = block.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!dataText) return;
    onEvent(JSON.parse(dataText) as ProspectLiveEventApiRecord);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r\n/gu, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  if (buffer.trim()) consume(buffer.trim());
}

async function startLeadTaskEventStream(job: LeadFinderJob) {
  const runId = job.backendRunId;
  if (!runId || !state.user) return;
  if (leadFinderStreamRunId === runId && leadFinderStreamAbort) return;
  stopLeadTaskEventStream(false);
  const controller = new AbortController();
  leadFinderStreamAbort = controller;
  leadFinderStreamRunId = runId;
  const cursor = leadFinderStreamCursors.get(runId) || "0";
  try {
    const response = await fetch(`/api/prospect-runs/${encodeURIComponent(runId)}/events/stream`, {
      method: "GET",
      credentials: "same-origin",
      headers: cursor !== "0" ? { "Last-Event-ID": cursor } : {},
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`实时事件连接失败：HTTP ${response.status}`);
    if (leadFinderStreamAbort !== controller) return;
    leadFinderStreamConnected = true;
    stopLeadFinderRunPolling();
    syncLeadTaskStreamStateUi();
    renderLeadFinderLiveOverview();
    await consumeLeadTaskEventStream(response, (event) => {
      if (leadFinderStreamAbort !== controller || event.runId !== runId) return;
      const current = leadFinderJobs.find((item) => item.backendRunId === runId);
      if (!current) return;
      current.liveEvents ||= [];
      if (!current.liveEvents.some((item) => item.id === event.id)) {
        current.liveEvents.push(event);
        current.liveEvents.sort((left, right) => left.sequence - right.sequence);
        if (current.liveEvents.length > 500) current.liveEvents.splice(0, current.liveEvents.length - 500);
      }
      leadFinderStreamCursors.set(runId, event.id);
      scheduleLeadTaskEventRefresh(event);
    });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "AbortError") && leadFinderStreamAbort === controller) {
      console.warn("[prospect-events]", error);
    }
  } finally {
    if (leadFinderStreamAbort !== controller) return;
    leadFinderStreamAbort = null;
    leadFinderStreamRunId = "";
    leadFinderStreamConnected = false;
    await loadProspectRuns(true);
    syncLeadFinderRunPolling();
    renderLeadFinderLiveOverview();
    const current = leadFinderJobs.find((item) => item.backendRunId === runId);
    if (current && !prospectRunTerminalStatuses.has(current.backendRunStatus || "queued")
      && ["lead-finder", "lead-task-detail"].includes(qs<HTMLElement>(".view.active")?.id || "")
      && (qs<HTMLElement>(".view.active")?.id === "lead-finder" || activeLeadFinderJobId === current.id)) {
      window.setTimeout(() => void startLeadTaskEventStream(current), 1_500);
    }
  }
}

export function syncLeadFinderLiveTransport(view = qs<HTMLElement>(".view.active")?.id || "") {
  if (document.hidden || !state.user || !["lead-finder", "lead-task-detail"].includes(view)) {
    stopLeadTaskEventStream(false);
    return;
  }
  const job = view === "lead-task-detail"
    ? leadFinderJobs.find((item) => item.id === activeLeadFinderJobId) || null
    : primaryLeadFinderLiveJob();
  if (view === "lead-finder") renderLeadFinderLiveOverview();
  if (!job?.backendRunId || prospectRunTerminalStatuses.has(job.backendRunStatus || "queued")) {
    if (leadFinderStreamAbort) stopLeadTaskEventStream(true);
    else syncLeadFinderRunPolling();
    return;
  }
  void startLeadTaskEventStream(job);
}

export function stopLeadFinderRunPolling() {
  if (!leadFinderRunPollTimer) return;
  window.clearInterval(leadFinderRunPollTimer);
  leadFinderRunPollTimer = 0;
}

export function syncLeadFinderRunPolling() {
  if (leadFinderStreamConnected) {
    stopLeadFinderRunPolling();
    return;
  }
  const hasActiveRun = leadFinderJobs.some((job) =>
    job.backendRunId && ["running", "paused"].includes(job.status)
  );
  const hasActiveSchedule = state.prospectSchedules.some((schedule) =>
    schedule.status === "active"
  );
  if (!hasActiveRun && !hasActiveSchedule) {
    stopLeadFinderRunPolling();
    return;
  }
  if (leadFinderRunPollTimer) return;
  leadFinderRunPollTimer = window.setInterval(() => {
    if (!state.user || document.hidden) return;
    void loadProspectRuns(true);
    void loadProspectSchedules(true);
  }, 5_000);
}

export async function refreshLeadFinderOpportunities() {
  const result = await api<{ opportunities: WebsiteOpportunity[] }>(
    "/api/tools/website-opportunities"
  );
  const selectedIds = new Set(state.websiteOpportunities
    .filter((item) => item.selected)
    .map((item) => item.id));
  state.websiteOpportunities = (result.opportunities || []).map((item) => ({
    ...item,
    selected: selectedIds.has(item.id)
  }));
  renderWebsiteOpportunities(state.websiteOpportunities);
  renderLeadFinder(state.websiteOpportunities);
  renderProspectList();
  renderLeadFinderJobs();
  if (activeLeadFinderJobId && qs<HTMLElement>(".view.active")?.id === "lead-task-detail") {
    renderLeadTaskDetail();
  }
  if (prospectRadarActiveJobId === "prospect-pool" && prospectRadarController) {
    const model = buildProspectPoolRadarModel();
    renderProspectPoolRadarMetrics(model);
    prospectRadarController.update(model);
  } else if (prospectRadarActiveJobId) {
    const activeJob = leadFinderJobs.find((item) => item.id === prospectRadarActiveJobId);
    if (activeJob) syncProspectRadar(activeJob);
  }
  scheduleWebsiteProbeRefresh();
}

export function scheduleWebsiteProbeRefresh(windowMs = 5 * 60 * 1000) {
  const active = state.websiteOpportunities.some((item) =>
    (item.contactEnrichmentAttempts || []).some((attempt) =>
      attempt.status === "queued" || attempt.status === "running"
    )
    ||
    (item.websiteProbeAttempts || []).some((attempt) =>
      attempt.status === "queued" || attempt.status === "running"
    )
    || Boolean(
      !item.contactInfo?.trim()
      && /^https:\/\//iu.test(item.website || "")
      && !websiteProbePolicyBlockReason(item)
      && !(item.websiteProbeAttempts || []).length
    )
  );
  if (!active) {
    if (websiteProbeRefreshTimer) window.clearTimeout(websiteProbeRefreshTimer);
    websiteProbeRefreshTimer = 0;
    websiteProbeRefreshDeadline = 0;
    return;
  }
  if (!websiteProbeRefreshDeadline) {
    websiteProbeRefreshDeadline = Date.now() + windowMs;
  }
  if (Date.now() > websiteProbeRefreshDeadline) {
    websiteProbeRefreshDeadline = 0;
    return;
  }
  if (websiteProbeRefreshTimer) return;
  websiteProbeRefreshTimer = window.setTimeout(async () => {
    websiteProbeRefreshTimer = 0;
    if (!state.user || Date.now() > websiteProbeRefreshDeadline) {
      websiteProbeRefreshDeadline = 0;
      return;
    }
    try {
      await refreshLeadFinderOpportunities();
    } catch {
      // Keep the short refresh window alive across a transient API failure.
    }
    scheduleWebsiteProbeRefresh();
  }, 1_500);
}

export function prospectScheduleFrequencyLabel(frequency: ProspectScheduleApiRecord["frequency"]) {
  return frequency === "daily" ? "每天" : frequency === "weekly" ? "每周" : "每月";
}

export function renderProspectSchedules() {
  const box = qs<HTMLElement>("#leadFinderScheduleList");
  const count = qs<HTMLElement>("#leadFinderScheduleCount");
  if (!box || !count) return;
  const activeCount = state.prospectSchedules.filter((item) => item.status === "active").length;
  count.textContent = `${activeCount} 个启用中`;
  if (!state.prospectSchedules.length) {
    box.innerHTML = `<div class="empty-cell">暂无定期搜索计划。</div>`;
    return;
  }
  box.innerHTML = state.prospectSchedules.map((schedule) => {
    const mine = schedule.ownerId === state.user?.id;
    const nextRunAt = new Date(schedule.nextRunAt);
    const nextText = Number.isNaN(nextRunAt.getTime())
      ? "执行时间待刷新"
      : nextRunAt.toLocaleString("zh-CN", { hour12: false });
    const failure = schedule.lastFailureReason
      ? ` · ${schedule.lastFailureReason}`
      : "";
    const orchestration = schedule.orchestrationMode === "campaign_rotation_v1"
      ? ` · 轮换 ${schedule.rotatableStrategyCount || 0}/${schedule.approvedStrategyCount || 0} 个策略`
      : "";
    const review = schedule.dueReviewCount
      ? ` · 待复查 ${schedule.dueReviewCount} 个`
      : "";
    return `
      <article class="lead-schedule-row" data-prospect-schedule-id="${escapeHtml(schedule.id)}">
        <div class="lead-schedule-row-main">
          <b>${escapeHtml(prospectScheduleFrequencyLabel(schedule.frequency))}继续搜索 · ${schedule.status === "active" ? "运行中" : "已暂停"}</b>
          <span>下次 ${escapeHtml(nextText)}${escapeHtml(orchestration)}${escapeHtml(review)}${escapeHtml(failure)}</span>
        </div>
        ${badge(schedule.status === "active" ? "启用" : "暂停", schedule.status === "active" ? "green" : "gray")}
        <div class="lead-schedule-row-actions">
          ${mine ? `<button class="btn" type="button" data-prospect-schedule-action="${schedule.status === "active" ? "pause" : "resume"}">${schedule.status === "active" ? "暂停" : "恢复"}</button><button class="btn" type="button" data-prospect-schedule-action="delete">删除</button>` : `<span class="badge gray">团队计划</span>`}
        </div>
      </article>
    `;
  }).join("");
  qsa<HTMLButtonElement>("[data-prospect-schedule-action]", box).forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest<HTMLElement>("[data-prospect-schedule-id]");
      const schedule = state.prospectSchedules.find((item) =>
        item.id === row?.dataset.prospectScheduleId
      );
      const action = button.dataset.prospectScheduleAction as "pause" | "resume" | "delete";
      if (schedule) void mutateProspectSchedule(schedule, action, button);
    });
  });
}

export async function loadProspectSchedules(quiet = false) {
  if (!state.user) return;
  try {
    const result = await api<{ schedules: ProspectScheduleApiRecord[] }>(
      "/api/prospect-schedules"
    );
    state.prospectSchedules = result.schedules || [];
    renderProspectSchedules();
    syncLeadFinderRunPolling();
  } catch (error) {
    state.prospectSchedules = [];
    renderProspectSchedules();
    if (!quiet && state.iamCapabilities?.source !== "platform") {
      toast(error instanceof Error ? error.message : "定期搜索计划加载失败", "error");
    }
  }
}

function canReviewOrganizationIdentityConflicts() {
  return hasIamCapability("prospect.execute");
}

function organizationIdentityConflictTypeLabel(
  type: OrganizationIdentityConflictItem["conflictType"]
) {
  const labels: Record<
    OrganizationIdentityConflictItem["conflictType"],
    string
  > = {
    identifier_split: "多个企业命中同一身份标识",
    identifier_slot_conflict: "企业身份标识位置冲突",
    binding_conflict: "来源记录归属冲突"
  };
  return labels[type];
}

function renderIdentityConflicts() {
  const section = qs<HTMLElement>("#identityConflictReviewSection");
  const list = qs<HTMLElement>("#identityConflictReviewList");
  const count = qs<HTMLElement>("#identityConflictReviewCount");
  if (!section || !list || !count) return;
  const allowed = canReviewOrganizationIdentityConflicts();
  section.hidden = !allowed;
  if (!allowed) {
    state.identityConflicts = [];
    return;
  }
  count.textContent = `${state.identityConflicts.length} 条待处理`;
  if (!state.identityConflicts.length) {
    list.innerHTML =
      `<div class="empty-cell">暂无待复核的企业身份冲突。</div>`;
    return;
  }
  list.innerHTML = state.identityConflicts.map((conflict) => {
    const options = conflict.organizations.map((organization, index) => `
      <label class="identity-conflict-option">
        <input type="radio"
          name="identity-conflict-${escapeHtml(conflict.id)}"
          value="${escapeHtml(organization.id)}"
          ${index === 0 ? "checked" : ""}>
        <span>${escapeHtml(organization.name)}</span>
      </label>
    `).join("");
    return `
      <article class="identity-conflict-row"
        data-identity-conflict-id="${escapeHtml(conflict.id)}">
        <div class="identity-conflict-row-head">
          <div>
            <b>${escapeHtml(organizationIdentityConflictTypeLabel(conflict.conflictType))}</b>
            <span>${conflict.organizations.length} 个企业主体 · ${conflict.identifierCount} 个身份标识 · 影响 ${conflict.candidateCount} 条候选</span>
          </div>
          ${badge("待人工判断", "orange")}
        </div>
        <div class="identity-conflict-options">${options}</div>
        <textarea class="identity-conflict-note"
          maxlength="1000"
          placeholder="填写判断依据，例如：官网、企业注册信息或来源记录核验结果"></textarea>
        <div class="identity-conflict-actions">
          <button class="btn" type="button"
            data-identity-conflict-action="keep_separate">保持独立</button>
          <button class="btn primary" type="button"
            data-identity-conflict-action="merge">合并企业</button>
        </div>
      </article>
    `;
  }).join("");
  qsa<HTMLButtonElement>(
    "[data-identity-conflict-action]",
    list
  ).forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest<HTMLElement>(
        "[data-identity-conflict-id]"
      );
      const action = button.dataset.identityConflictAction === "merge"
        ? "merge"
        : "keep_separate";
      if (row?.dataset.identityConflictId) {
        void reviewIdentityConflict(
          row.dataset.identityConflictId,
          action,
          button
        );
      }
    });
  });
}

export async function loadIdentityConflicts(quiet = false) {
  if (!canReviewOrganizationIdentityConflicts()) {
    state.identityConflicts = [];
    renderIdentityConflicts();
    return;
  }
  try {
    const result = await api<{
      conflicts: OrganizationIdentityConflictItem[];
    }>("/api/organization-identity-conflicts?status=open");
    state.identityConflicts = result.conflicts || [];
    renderIdentityConflicts();
  } catch (error) {
    state.identityConflicts = [];
    renderIdentityConflicts();
    if (!quiet) {
      toast(
        error instanceof Error
          ? `企业身份复核加载失败：${error.message}`
          : "企业身份复核加载失败",
        "error"
      );
    }
  }
}

async function reviewIdentityConflict(
  conflictId: string,
  action: "keep_separate" | "merge",
  button: HTMLButtonElement
) {
  const conflict = state.identityConflicts.find(
    (item) => item.id === conflictId
  );
  const row = button.closest<HTMLElement>("[data-identity-conflict-id]");
  const note = qs<HTMLTextAreaElement>(
    ".identity-conflict-note",
    row || undefined
  )?.value.trim() || "";
  const canonicalOrganizationId = qs<HTMLInputElement>(
    ".identity-conflict-option input:checked",
    row || undefined
  )?.value || "";
  if (!conflict) {
    toast("冲突记录已变化，请刷新后重试", "error");
    return;
  }
  if (note.length < 2) {
    toast("请先填写至少 2 个字的复核依据", "error");
    return;
  }
  if (action === "merge" && !canonicalOrganizationId) {
    toast("请选择要保留的规范企业", "error");
    return;
  }
  const buttons = qsa<HTMLButtonElement>(
    "[data-identity-conflict-action]",
    row || undefined
  );
  buttons.forEach((item) => {
    item.disabled = true;
  });
  try {
    await api(
      `/api/organization-identity-conflicts/${encodeURIComponent(conflict.id)}/review`,
      {
        method: "POST",
        headers: { "If-Match": conflict.etag },
        body: JSON.stringify({
          action,
          canonicalOrganizationId:
            action === "merge" ? canonicalOrganizationId : "",
          note
        })
      }
    );
    await loadIdentityConflicts();
    if (action === "merge") {
      const result = await api<{ opportunities: WebsiteOpportunity[] }>(
        "/api/tools/website-opportunities"
      );
      state.websiteOpportunities = result.opportunities || [];
      renderWebsiteOpportunities(state.websiteOpportunities);
      renderLeadFinder(state.websiteOpportunities);
      renderProspectList();
    }
    toast(action === "merge" ? "企业归一映射已保存" : "已记录保持独立");
  } catch (error) {
    toast(
      error instanceof Error ? error.message : "企业身份复核失败",
      "error"
    );
  } finally {
    buttons.forEach((item) => {
      item.disabled = false;
    });
  }
}

async function mutateProspectSchedule(
  schedule: ProspectScheduleApiRecord,
  action: "pause" | "resume" | "delete",
  button: HTMLButtonElement
) {
  if (action === "delete" && !await confirmAction({
    title: "删除定期搜索计划",
    message: "该计划将停止后续自动搜客。",
    consequences: ["定期执行配置会被删除", "已产生的搜客任务和结果会保留"],
    confirmLabel: "删除计划"
  })) return;
  button.disabled = true;
  try {
    const path = action === "delete"
      ? `/api/prospect-schedules/${encodeURIComponent(schedule.id)}`
      : `/api/prospect-schedules/${encodeURIComponent(schedule.id)}/${action}`;
    await api(path, {
      method: action === "delete" ? "DELETE" : "POST",
      headers: { "If-Match": `"${schedule.id}:${schedule.revision}"` },
      ...(action === "delete" ? {} : { body: JSON.stringify({}) })
    });
    await loadProspectSchedules();
    toast(action === "delete" ? "定期搜索计划已删除" : action === "pause" ? "定期搜索计划已暂停" : "定期搜索计划已恢复");
  } catch (error) {
    toast(error instanceof Error ? error.message : "定期搜索计划操作失败", "error");
  } finally {
    button.disabled = false;
  }
}

export function renderLeadFinderSearchLinks() {
  const box = qs<HTMLElement>("#leadFinderSearchLinks");
  if (!box) return;
  const keywords = qs<HTMLInputElement>("#leadProductKeywords")?.value.trim() || "product supplier";
  const countries = (qs<HTMLInputElement>("#leadCountries")?.value.trim() || "Germany").split(/,|，/).map((item) => item.trim()).filter(Boolean).slice(0, 3);
  const industries = (qs<HTMLInputElement>("#leadIndustryInput")?.value.trim() || "").split(/,|，/).map((item) => item.trim()).filter(Boolean).slice(0, 2);
  const customerTypeValue = qs<HTMLSelectElement>("#leadCustomerTypes")?.value || "*";
  const customerType = customerTypeValue === "*" ? "" : customerTypeValue.split("/")[1]?.trim() || customerTypeValue;
  const exclude = (qs<HTMLInputElement>("#leadExcludeKeywords")?.value.trim() || "").split(/,|，/).map((item) => item.trim()).filter(Boolean).map((item) => `-${item}`).join(" ");
  // 免费搜索入口：读取用户勾选的平台开关
  const enabledSources = qsa<HTMLButtonElement>(".lead-entry-chip.active").map((item) => item.dataset.leadEntry || "google");
  const activeSources = enabledSources.length ? enabledSources : ["google"];
  const countryList = countries.length ? countries : ["Germany", "UK", "Turkey"];
  const industryText = industries.length ? industries.join(" ") : "";
  const sourceTemplates: Record<string, { label: string; query: (country: string) => string }> = {
    google: { label: "Google/Web", query: (country) => `${keywords} ${industryText} ${customerType} ${country} company website ${exclude}` },
    alibaba: { label: "Alibaba询盘", query: (country) => `site:alibaba.com/rfq ${keywords} ${industryText} ${country} buyer inquiry ${exclude}` },
    madein: { label: "Made-in-China询盘", query: (country) => `site:made-in-china.com ${keywords} ${industryText} ${country} sourcing request buyer ${exclude}` },
    globalsources: { label: "Global Sources", query: (country) => `site:globalsources.com ${keywords} ${industryText} ${country} buyer request ${exclude}` },
    europages: { label: "Europages", query: (country) => `site:europages.com ${keywords} ${industryText} ${customerType} ${country} ${exclude}` }
  };
  const rows = countryList.flatMap((country) => activeSources.map((source) => {
    const template = sourceTemplates[source] || sourceTemplates.google;
    const query = template.query(country).replace(/\s+/g, " ").trim();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    return `<a href="${url}" target="_blank" rel="noreferrer"><b>${escapeHtml(template.label)}</b><span>${escapeHtml(query)}</span></a>`;
  })).slice(0, 6);
  box.innerHTML = rows.length ? rows.join("") : `<span class="empty-inline">勾选上方“免费搜索入口”后生成检索链接。</span>`;
}

export function collectLeadFinderRows() {
  qsa<HTMLTableRowElement>("#leadFinderResultRows tr[data-lead-id]").forEach(syncLeadRowFields);
  return currentLeadFinderResults()
    .filter((item) => item.selected)
    .map((item) => ({
      id: item.id,
      company: item.company,
      business: item.business,
      country: item.country,
      website: item.website,
      contact: item.contact,
      contactInfo: item.contactInfo,
      description: item.description,
      source: item.source,
      sourceLabel: item.sourceLabel
    }))
    .filter((item) => item.company && item.website);
}

function verificationCheckMeta(status: NonNullable<WebsiteOpportunity["verificationReport"]>["checks"][number]["status"]) {
  if (status === "passed") return { label: "已通过", tone: "green" };
  if (status === "partial") return { label: "部分有据", tone: "amber" };
  if (status === "manual_required") return { label: "需人工核验", tone: "amber" };
  return { label: "未核实", tone: "gray" };
}

function verificationLevelTone(level?: NonNullable<WebsiteOpportunity["verificationReport"]>["level"]) {
  if (level === "L5" || level === "L4") return "green";
  if (level === "L3" || level === "L2") return "amber";
  return "gray";
}

export function leadSearchReportMeta(item: WebsiteOpportunity) {
  const report = item.searchReport;
  const checkedCount = report?.checkedSources?.length || item.sourceEvidence?.length || 0;
  const verifiedFields = report?.verifiedFields?.length
    ? report.verifiedFields
    : [...new Set((item.sourceEvidence || []).flatMap((source) => source.matchedFields || []))];
  const contactStatus = report?.contactFinding?.status || (item.contactInfo ? "unverified" : "missing");
  const contactReady = contactStatus === "source_confirmed";
  const authenticity = report?.sourceAuthenticity || (checkedCount > 1 ? "multi_source_supported" : checkedCount ? "single_source_supported" : "unknown");
  const authenticityLabel = authenticity === "official_confirmed"
    ? "官网/权威来源"
    : authenticity === "multi_source_supported"
      ? "多来源支持"
      : authenticity === "single_source_supported"
        ? "单来源支持"
        : authenticity === "weak"
          ? "弱证据"
          : "待补来源";
  return {
    checkedCount,
    verifiedFields,
    contactReady,
    contactText: contactReady ? "联系方式有来源" : "缺联系方式来源",
    authenticity,
    authenticityLabel,
    tone: contactReady ? (authenticity === "official_confirmed" || authenticity === "multi_source_supported" ? "green" : "amber") : "red",
    summary: report?.summary || (checkedCount
      ? `已核验 ${checkedCount} 个来源，${verifiedFields.length ? `确认 ${verifiedFields.join("、")}` : "字段待补"}`
      : "暂无来源报告"),
    nextAction: report?.nextAction || (contactReady ? "复核后可加入搜客清单" : "先补充公开联系方式")
  };
}

export function renderLeadSearchReportCell(item: WebsiteOpportunity) {
  const meta = leadSearchReportMeta(item);
  return `
    <button class="lead-candidate-report is-${escapeHtml(meta.tone)}" type="button" data-lead-report-open="${escapeHtml(item.id)}" title="${escapeHtml(meta.summary)}">
      <b>${escapeHtml(meta.authenticityLabel)}</b>
      <span>${escapeHtml(`${meta.checkedCount} 源 · ${meta.contactText}`)}</span>
      <small>${escapeHtml(meta.verifiedFields.slice(0, 3).join("、") || meta.nextAction)}</small>
    </button>
  `;
}

function renderLeadSearchReportPanel(item: WebsiteOpportunity) {
  const report = item.searchReport;
  const meta = leadSearchReportMeta(item);
  const sources = report?.checkedSources?.length
    ? report.checkedSources
    : (item.sourceEvidence || []).map((source) => ({
        url: source.sourceUrl || source.officialWebsite || "",
        title: source.providerId || item.sourceLabel || "公开来源",
        authenticity: "search_result" as const,
        verifiedFields: source.matchedFields || [],
        finding: source.evidenceSummary || "公开来源记录"
      }));
  const authenticityLabel = (value: string) =>
    value === "official" ? "官网"
      : value === "registry" ? "登记/权威库"
        : value === "reputable_directory" ? "可信目录"
          : value === "search_result" ? "搜索结果"
            : "弱证据";
  return `
    <section class="lead-search-report" id="leadFinderSearchReport" tabindex="-1">
      <div class="lead-evidence-head"><span>搜索报告</span><b>${escapeHtml(meta.authenticityLabel)}</b></div>
      <div class="lead-search-report-summary is-${escapeHtml(meta.tone)}">
        <b>${escapeHtml(meta.contactText)}</b>
        <p>${escapeHtml(meta.summary)}</p>
        <small>${escapeHtml(meta.nextAction)}</small>
      </div>
      <div class="lead-search-report-grid">
        <div><span>数据源真实性</span><b>${escapeHtml(meta.authenticityLabel)}</b></div>
        <div><span>已验证字段</span><b>${escapeHtml(meta.verifiedFields.join("、") || "待补充")}</b></div>
        <div><span>联系方式来源</span><b>${escapeHtml(report?.contactFinding?.sourceUrl || "待补充")}</b></div>
      </div>
      <div class="lead-search-report-sources">
        ${sources.length ? sources.map((source) => {
          const url = normalizeWebsiteLink(source.url || "");
          return `
            <div class="lead-search-report-source">
              <div><b>${escapeHtml(source.title || source.url || "公开来源")}</b>${badge(authenticityLabel(source.authenticity), source.authenticity === "weak" ? "gray" : "")}</div>
              <p>${escapeHtml(source.finding || "公开来源记录")}</p>
              <small>${escapeHtml(source.verifiedFields?.length ? `验证：${source.verifiedFields.join("、")}` : "验证字段待补")}</small>
              ${url !== "#" ? `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">打开来源</a>` : ""}
            </div>
          `;
        }).join("") : `<div class="lead-report-empty">暂无来源报告。请重新执行深入查询或等待联系方式补全。</div>`}
      </div>
    </section>
  `;
}

const PROSPECT_SCORE_REASON_LABELS: Record<string, string> = {
  RESOLVED_ORGANIZATION_MISSING: "企业主体尚未完成唯一身份归一",
  ENTERPRISE_VERIFICATION_NOT_PASSED: "企业可信度门禁未通过",
  ICP_GATE_NOT_PASSED: "ICP 评估未达标或尚未审核",
  CONTACTABILITY_GATE_NOT_PASSED: "联系方式未验证或尚未人工批准",
  COMPLIANCE_BLOCKED: "存在排除、退订或禁止联系限制",
  ICP_ASSESSMENT_MISSING: "尚未执行正式 ICP 评估",
  VERIFIED_CONTACT_CHANNEL_MISSING: "尚无已验证联系渠道",
  CANDIDATE_IDENTITY_CHANGED: "企业资料已变化，需要重新核验",
  CANDIDATE_ICP_INPUT_CHANGED: "ICP 输入已变化，需要重新评估",
  CANDIDATE_CHANNEL_CHANGED: "渠道资料已变化，需要重新核验",
  COMPANY_EVIDENCE_MISSING: "尚无企业身份来源证据",
  DISCOVERY_EVIDENCE_ONLY: "当前只有发现类证据，不能证明企业身份",
  PURCHASE_SIGNAL_MISSING: "尚无采购或互动信号"
};

function prospectScoreReason(code: string) {
  return PROSPECT_SCORE_REASON_LABELS[code] || code.replace(/_/gu, " ");
}

export function renderProspectScorecard(item: WebsiteOpportunity) {
  const scorecard = item.scorecard;
  if (!scorecard) {
    return `<section class="prospect-scorecard"><div class="prospect-scorecard-head"><b>搜索验证评分</b>${badge("等待评分", "gray")}</div><p>刷新候选后生成基于来源证据和资格门禁的四项评分。</p></section>`;
  }
  const rows: Array<[string, ProspectScoreComponentApi]> = [
    ["企业可信度", scorecard.enterpriseConfidence],
    ["ICP 匹配", scorecard.icpMatch],
    ["联系就绪", scorecard.contactReadiness],
    ["行动优先级", scorecard.actionPriority]
  ];
  const reasons = scorecard.vqa.reasonCodes.length
    ? scorecard.vqa.reasonCodes.map((code) => prospectScoreReason(code)).join("；")
    : "企业、ICP、有效渠道、合规与人工批准均已通过。";
  return `
    <section class="prospect-scorecard">
      <div class="prospect-scorecard-head"><b>搜索验证评分</b>${badge(scorecard.vqa.qualified ? "验证通过" : "待验证", scorecard.vqa.qualified ? "green" : "amber")}</div>
      <div class="prospect-score-grid">${rows.map(([label, entry]) => `
        <div><span>${label}</span><b>${entry.score}</b><i style="--p:${entry.score}%"></i><small>${entry.status === "verified" ? "已验证" : entry.status === "blocked" ? "受阻" : entry.status === "partial" ? "待补证" : "未验证"}</small></div>
      `).join("")}</div>
      <p>${escapeHtml(reasons)}</p>
    </section>
  `;
}

export function closeLeadFinderVerificationDrawer() {
  qs<HTMLElement>("#leadFinderVerificationDrawer")?.classList.remove("open");
  qs<HTMLElement>("#leadFinderVerificationBackdrop")?.classList.remove("active");
  document.body.classList.remove("lead-verification-drawer-open");
}

export function openLeadFinderVerificationDrawer(item: WebsiteOpportunity, autoResearch = false) {
  state.selectedLeadFinderId = item.id;
  qsa<HTMLElement>("[data-lead-id]").forEach((row) =>
    row.classList.toggle("selected", row.dataset.leadId === item.id)
  );
  qsa<HTMLElement>("[data-lead-mobile-id]").forEach((card) =>
    card.classList.toggle("selected", card.dataset.leadMobileId === item.id)
  );
  renderLeadFinderDetail(item);
  qs<HTMLElement>("#leadFinderVerificationDrawer")?.classList.add("open");
  qs<HTMLElement>("#leadFinderVerificationBackdrop")?.classList.add("active");
  document.body.classList.add("lead-verification-drawer-open");
  if (autoResearch) {
    // 从任务详情「背调」/候选行「CLI 背调」跳转而来：抽屉展开后按 CLI 口径自动发起背调
    requestAnimationFrame(() => {
      const select = qs<HTMLSelectElement>("#leadFinderResearchSourceSelect");
      if (select) select.value = "cli";
      const button = qs<HTMLButtonElement>("#leadFinderResearchButton");
      if (button) button.textContent = prospectResearchButtonLabel("cli");
      button?.click();
    });
  }
}

/** 行内「背调」入口（任务详情候选区 / 候选清单行）：切回搜客页、展开候选抽屉并自动发起背调 */
export function openLeadCandidateResearch(item: WebsiteOpportunity) {
  activateNavView("lead-finder", () => {
    openLeadFinderVerificationDrawer(item, true);
  });
}

export function openLeadFinderLookupReason(item: WebsiteOpportunity) {
  openLeadFinderVerificationDrawer(item);
  requestAnimationFrame(() => {
    const diagnosis = qs<HTMLElement>("#leadFinderLookupDiagnosis");
    diagnosis?.scrollIntoView({ behavior: "smooth", block: "start" });
    diagnosis?.focus({ preventScroll: true });
  });
}

export function renderLeadFinderDetail(item?: WebsiteOpportunity) {
  const box = qs<HTMLElement>("#leadFinderDetail");
  if (!box) return;
  if (!item) {
    box.innerHTML = "";
    return;
  }
  const score = leadFinderScore(item);
  const duplicate = leadFinderDuplicateState(item);
  const domain = websiteDomain(item.website);
  const owner = item.ownerId ? ownerName(item.ownerId) : (state.user?.name || "当前账号");
  const externalId = item.id || `website_${domain}`;
  const status = prospectStatusMeta(item);
  const evidence = item.sourceEvidence || [];
  const report = item.verificationReport;
  const websiteProbe = latestWebsiteProbe(item);
  const contactDisplay = websiteContactDisplay(item);
  const controlledWebsiteAccess = Boolean(
    websiteProbe || report?.accessMode === "controlled_probe"
  );
  const readonly = item.status === "synced" ? "disabled" : "";
  const canResearch = !item.ownerId || item.ownerId === state.user?.id;
  const reportChecks = report?.checks?.length
    ? report.checks.map((entry) => {
      const meta = verificationCheckMeta(entry.status);
      return `
        <div class="lead-report-check">
          <div><b>${escapeHtml(leadFinderDisplayText(entry.label))}</b>${badge(meta.label, meta.tone)}</div>
          <p>${escapeHtml(leadFinderDisplayText(entry.summary))}</p>
          <small>${escapeHtml(leadFinderDisplayText(entry.source || "待补充来源"))} · ${escapeHtml(entry.checkedAt ? formatTime(entry.checkedAt) : "时间待确认")}</small>
        </div>
      `;
    }).join("")
    : `<div class="lead-report-empty">校验报告待刷新，请重新执行搜索或刷新清单。</div>`;
  const evidenceHtml = evidence.length
    ? evidence.map((entry, index) => {
      const sourceUrl = normalizeWebsiteLink(entry.sourceUrl || entry.officialWebsite);
      const fetchedAt = entry.fetchedAt ? formatTime(entry.fetchedAt) : "时间待确认";
      const matched = entry.matchedFields?.length ? entry.matchedFields.join("、") : "企业基础信息";
      return `
        <div class="lead-evidence-row">
          <div>
            <b>${escapeHtml(entry.providerId || item.sourceLabel || item.source || `来源 ${index + 1}`)}</b>
            <small>${escapeHtml(fetchedAt)} · 命中 ${escapeHtml(matched)}</small>
          </div>
          <p>${escapeHtml(entry.evidenceSummary || "公开来源记录，需人工复核。")}</p>
          ${sourceUrl !== "#" ? `<a href="${escapeHtml(sourceUrl)}" target="_blank" rel="noreferrer">打开原始来源</a>` : ""}
        </div>
      `;
    }).join("")
    : `
      <div class="lead-evidence-row">
        <div><b>${escapeHtml(item.sourceLabel || item.source || "链接登记")}</b><small>当前候选暂无结构化 Provider 证据</small></div>
        <p>${websiteProbe ? "系统已完成官网公开资料核验；执行过程与结果见下方核验记录。" : "官网公开资料尚待补全。请等待后台处理或由业务员人工核对企业主体、业务范围和联系方式。"}</p>
        ${item.website ? `<a href="${escapeHtml(normalizeWebsiteLink(item.website))}" target="_blank" rel="noreferrer">人工打开参考链接</a>` : ""}
      </div>
    `;
  box.innerHTML = `
    <div class="lead-verification-drawer-head">
      <div>
        <span class="lead-verification-kicker">候选校验报告</span>
        <h2>${escapeHtml(item.company)}</h2>
        <p>${escapeHtml(item.country || "国家待确认")} · ${escapeHtml(domain || "官网待补")} · ${escapeHtml(item.business || "业务待维护")}</p>
      </div>
      <button class="btn icon-only" id="leadFinderVerificationClose" type="button" title="关闭">×</button>
    </div>
    ${renderProspectLookupDiagnosis(item)}
    <section class="lead-report-summary">
      <div class="lead-report-level">
        ${badge(report?.level || "L0", verificationLevelTone(report?.level))}
        <div><b>${escapeHtml(report?.levelLabel || "报告待生成")}</b><small>${escapeHtml(report?.generatedAt ? `生成于 ${formatTime(report.generatedAt)}` : "刷新后生成")}</small></div>
      </div>
      ${badge(controlledWebsiteAccess ? "官网资料已核验" : "官网资料待补全", controlledWebsiteAccess ? "amber" : "green")}
      <p>${escapeHtml(report?.conclusion || "当前仅展示候选资料，企业真实性和联系方式需要人工确认。")}</p>
      <div class="lead-report-policy"><b>资料范围</b><span>${controlledWebsiteAccess ? "仅核验境外 HTTPS 官网中的公开企业资料与业务联系方式，不处理受限内容，也不保存原始页面内容。" : "当前仅完成官网链接登记，公开资料尚待补全。"}</span></div>
    </section>
    ${renderProspectScorecard(item)}
    ${renderLeadSearchReportPanel(item)}
    ${renderExtractedContactsPanel(item)}
    <section class="lead-report-checks">
      <div class="lead-evidence-head"><span>校验检查</span><b>${report?.checks?.length || 0} 项</b></div>
      ${reportChecks}
    </section>
    ${renderWebsiteDiscoveryPanel(item)}
    ${renderWebsiteProbePanel(item, "leadFinderWebsiteProbeButton")}
    <div class="lead-profile-head">
      <div><h3>人工核验资料</h3><p>人工修正会保存到当前团队候选记录</p></div>
      <div class="lead-profile-score" title="行动优先级">${score}</div>
    </div>
    <div class="lead-verification-grid">
      <label><span>公司</span><input id="leadFinderDetailCompany" value="${escapeHtml(item.company)}" ${readonly}></label>
      <label><span>官网</span><input id="leadFinderDetailWebsite" value="${escapeHtml(item.website)}" ${readonly}></label>
      <label><span>业务方向</span><input id="leadFinderDetailBusiness" value="${escapeHtml(item.business)}" ${readonly}></label>
      <label><span>国家/地区</span><input id="leadFinderDetailCountry" value="${escapeHtml(item.country)}" ${readonly}></label>
      <label><span>联系人</span><input id="leadFinderDetailContact" value="${escapeHtml(item.contact)}" ${readonly}></label>
      <label><span>联系方式</span><input id="leadFinderDetailContactInfo" value="${escapeHtml(item.contactInfo)}" ${readonly}></label>
      <label class="full"><span>核验说明</span><textarea id="leadFinderDetailDescription" ${readonly}>${escapeHtml(item.description || "")}</textarea></label>
    </div>
    <div class="lead-detail-stack">
      <div class="lead-detail-card"><span>ICP 判断</span><b>${item.scorecard?.icpMatch.status === "verified" ? `已通过正式 ICP 评估（${item.scorecard.icpMatch.score}）` : `未通过正式 ICP 门禁（${item.scorecard?.icpMatch.score || 0}）`}</b></div>
      <div class="lead-detail-card"><span>联系方式</span><b title="${escapeHtml(contactDisplay.detail)}">${escapeHtml(contactDisplay.value)}</b></div>
      <div class="lead-detail-card"><span>来源与外部编号</span><b>${escapeHtml(item.sourceLabel || item.source || "链接登记")} · ${escapeHtml(externalId)} · ${evidence.length || 1} 个核验入口</b></div>
      <div class="lead-detail-card"><span>重复与归属</span><b>${badge(duplicate.text, duplicate.tone)} ${escapeHtml(owner)}</b></div>
      <div class="lead-detail-card"><span>行动优先级</span><b>${badge(item.parseMode === "reference" ? "链接登记" : item.parseMode === "ai" ? "AI辅助" : "规则归纳", item.parseMode === "ai" ? "green" : "")} ${badge(`${score}分`, score >= 76 ? "green" : score >= 60 ? "amber" : "gray")} · AI 结论不作为事实门禁</b></div>
      <div class="lead-detail-card"><span>当前状态与下一步</span><b>${badge(status.label, status.tone)} ${escapeHtml(status.action)}</b></div>
    </div>
    <div class="lead-evidence-section">
      <div class="lead-evidence-head"><span>来源证据</span><b>${evidence.length ? `${evidence.length} 条证据记录` : "官网人工核验"}</b></div>
      ${evidenceHtml}
    </div>
    <section class="lead-report-checks">
      <div class="lead-evidence-head"><span>AI 背调</span><b>联网证据 + 本库资料</b></div>
      <div id="leadFinderResearchResult" class="prospect-research-body">正在读取背调记录…</div>
      ${canResearch ? `<div class="prospect-action-row">
        <label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:#4a5a70">执行方式
          <select id="leadFinderResearchSourceSelect" class="engine-source-select" title="选择这次背调由谁执行"></select>
        </label>
        <button class="btn primary" id="leadFinderResearchButton">一键背调</button>
      </div>` : `<small class="prospect-research-note">该候选归属其他业务员，仅可查看。</small>`}
      ${canResearch ? `<div class="prospect-action-row" style="margin-top:-6px"><button class="btn" id="leadFinderWriteEmailButton">用本机 CLI 写开发信</button><small class="prospect-research-note">跳到搜客清单并自动按 CLI 口径生成草稿</small></div>` : ""}
    </section>
    <div class="lead-detail-actions">
      ${item.status !== "synced" ? `<button class="btn" id="leadFinderDetailSaveButton">保存核验资料</button>` : ""}
      ${canSelectLeadFinderItem(item) ? `<button class="btn primary" id="leadFinderDetailShortlistButton">加入搜客清单</button>` : ""}
      ${item.shortlistedAt && item.status !== "synced" ? `<button class="btn primary" id="leadFinderDetailOpenShortlistButton">去搜客清单</button>` : ""}
      ${item.status === "synced" && item.leadId ? `<button class="btn primary" id="leadFinderDetailOpenLeadButton">查看线索</button>` : ""}
    </div>
  `;
  qs<HTMLButtonElement>("#leadFinderVerificationClose", box)?.addEventListener("click", closeLeadFinderVerificationDrawer);
  qsa<HTMLButtonElement>("[data-website-source-config]", box).forEach((button) => {
    button.addEventListener("click", () => openLeadSourceCenter(button.dataset.websiteSourceConfig || ""));
  });
  qs<HTMLButtonElement>("#leadFinderWebsiteProbeButton", box)?.addEventListener("click", (event) => {
    void startWebsiteProbe(item, event.currentTarget as HTMLButtonElement);
  });
  qs<HTMLButtonElement>("#prospectContactEnrichmentButton", box)?.addEventListener("click", (event) => {
    void startContactEnrichment(item, event.currentTarget as HTMLButtonElement);
  });
  qs<HTMLButtonElement>("#leadFinderDetailSaveButton", box)?.addEventListener("click", (event) => {
    void saveLeadFinderVerification(item, event.currentTarget as HTMLButtonElement);
  });
  qs<HTMLButtonElement>("#leadFinderDetailShortlistButton", box)?.addEventListener("click", (event) => {
    void shortlistLeadFinderRows(event.currentTarget as HTMLButtonElement, [item.id]);
  });
  qs<HTMLButtonElement>("#leadFinderDetailOpenShortlistButton", box)?.addEventListener("click", () => {
    closeLeadFinderVerificationDrawer();
    state.selectedProspectId = item.id;
    activateNavView("prospect-list", () => {
      renderProspectList();
    });
  });
  qs<HTMLButtonElement>("#leadFinderDetailOpenLeadButton", box)?.addEventListener("click", () => {
    void openProspectLead(item);
  });
  qs<HTMLButtonElement>("#leadFinderResearchButton", box)?.addEventListener("click", (event) => {
    const source = (qs<HTMLSelectElement>("#leadFinderResearchSourceSelect", box)?.value || effectiveResearchSource()) as ResearchEngineSource;
    void runProspectBackgroundResearch(item, event.currentTarget as HTMLButtonElement, qs<HTMLElement>("#leadFinderResearchResult"), source);
  });
  fillProspectResearchSourceSelect(box, "leadFinderResearchSourceSelect");
  // 抽屉直达开发信：切到搜客清单选中该候选，写信区按 CLI 口径自动生成
  qs<HTMLButtonElement>("#leadFinderWriteEmailButton", box)?.addEventListener("click", () => {
    closeLeadFinderVerificationDrawer();
    state.selectedProspectId = item.id;
    activateNavView("prospect-list", () => {
      renderProspectList();
      const select = qs<HTMLSelectElement>("#prospectMailSourceSelect");
      if (select) select.value = "cli";
      const workspace = qs<HTMLDetailsElement>("#prospectMailWorkspace");
      if (workspace) workspace.open = true;
      qs<HTMLButtonElement>("#prospectGenerateMailButton")?.click();
    });
  });
  const drawerResearchBox = qs<HTMLElement>("#leadFinderResearchResult");
  if (prospectResearchRunning(item) && drawerResearchBox) {
    drawerResearchBox.innerHTML = `${cliWaitPanelHtml("research", "本机 CLI")}
      <p class="research-progress-note">正在调研 ${escapeHtml(item.company)}，完成后自动显示证据卡…</p>`;
    startCliWaitTicker("research");
  } else {
    void loadProspectResearchHistory(item, drawerResearchBox);
  }
}

function leadFinderVerificationPayload() {
  const value = (selector: string) => qs<HTMLInputElement | HTMLTextAreaElement>(selector)?.value.trim() || "";
  return {
    company: value("#leadFinderDetailCompany"),
    website: value("#leadFinderDetailWebsite"),
    business: value("#leadFinderDetailBusiness"),
    country: value("#leadFinderDetailCountry"),
    contact: value("#leadFinderDetailContact"),
    contactInfo: value("#leadFinderDetailContactInfo"),
    description: value("#leadFinderDetailDescription"),
    requestId: prospectRequestId("candidate-details")
  };
}

async function saveLeadFinderVerification(item: WebsiteOpportunity, button?: HTMLButtonElement, notify = true) {
  const payload = leadFinderVerificationPayload();
  if (!payload.company || !payload.website) {
    toast("公司和官网不能为空", "error");
    return false;
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
    renderLeadFinder(state.websiteOpportunities);
    renderProspectList();
    if (notify) toast(result.qualificationInvalidated
      ? "资料已保存；受影响的资格步骤已失效，请重新核验"
      : "核验资料已保存");
    return true;
  } catch (error) {
    toast(error instanceof Error ? error.message : "保存核验资料失败", "error");
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}
