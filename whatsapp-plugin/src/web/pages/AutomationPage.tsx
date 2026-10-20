import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, BellRing, BrainCircuit, CalendarClock, CheckCircle2, ChevronDown, Clock3, Play, Radio, RefreshCw, Save, Sparkles, TimerReset, RotateCcw } from "lucide-react";
import { api } from "../api";
import { queryKeys } from "../data";
import { Spinner, Toggle } from "../components/ui";
import type { FollowupSyncEngine, FollowupSyncItemStatus, FollowupSyncRun } from "@shared/types";

function formatTime(value?: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "尚未安排"; }

const FOLLOWUP_ENGINE_LABEL: Record<FollowupSyncEngine, string> = { cli: "CLI 整理", ai: "AI 整理", none: "未配置引擎" };
const FOLLOWUP_ITEM_STATUS: Record<FollowupSyncItemStatus, string> = { written: "已写入", existing: "已有跟进", skipped: "跳过", failed: "失败" };
const FOLLOWUP_KIND_LABEL: Record<string, string> = { customer: "客户", lead: "新线索", skipped: "未匹配" };

/** 展开某一轮同步记录时显示的逐条明细：谁、写成了什么、失败原因。 */
function FollowupRunDetail({ runId }: { runId: string }) {
  const itemsQuery = useQuery({ queryKey: ["followup-sync-items", runId], queryFn: () => api.followupSyncRunItems(runId) });
  if (itemsQuery.isLoading) return <div className="followup-detail loading"><Spinner /> 正在读取明细...</div>;
  if (itemsQuery.isError) return <div className="followup-detail error-text">明细读取失败，请重试。</div>;
  const items = itemsQuery.data ?? [];
  if (!items.length) return <div className="followup-detail">这一轮没有处理任何会话。</div>;
  return <ul className="followup-detail">
    {items.map((item) => <li key={item.id} className={item.status}>
      <span className={`followup-item-status is-${item.status}`}>{FOLLOWUP_ITEM_STATUS[item.status]}</span>
      <div><strong>{item.contactName || item.contactPhone}</strong>
        <small>{FOLLOWUP_KIND_LABEL[item.kind] ?? item.kind} · {item.messageCount} 条消息{item.activityId ? ` · CRM 活动 ${item.activityId.slice(0, 10)}` : ""}</small>
        {item.summary && <p>{item.summary}</p>}
        {item.error && <p className="error-text">{item.error}</p>}
      </div>
    </li>)}
  </ul>;
}

export function AutomationPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: queryKeys.automation, queryFn: api.automationSettings, refetchInterval: 30_000 });
  const runsQuery = useQuery({ queryKey: queryKeys.automationRuns, queryFn: () => api.automationRuns(10), refetchInterval: 10_000 });
  const deliveriesQuery = useQuery({ queryKey: ["automation-deliveries"], queryFn: () => api.automationDeliveries(30), refetchInterval: 10_000 });
  const providersQuery = useQuery({ queryKey: queryKeys.aiProviders, queryFn: api.aiProviders });
  const settings = query.data;
  const [interval, setInterval] = useState(6);
  const [intelligenceMode, setIntelligenceMode] = useState<"rules" | "ai">("rules");
  const [intelligenceProviderId, setIntelligenceProviderId] = useState<string>("");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [enabled, setEnabled] = useState(true);
  // ---- 跟进同步（WhatsApp 对话 → CRM 客户跟进，默认关闭）----
  const [followupEnabled, setFollowupEnabled] = useState(false);
  const [followupHour, setFollowupHour] = useState(19);
  const [followupMinute, setFollowupMinute] = useState(0);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  useEffect(() => { if (settings) { setInterval(settings.analysisIntervalHours); setIntelligenceMode(settings.intelligenceMode); setIntelligenceProviderId(settings.intelligenceProviderId ?? ""); setHour(settings.dailyTodoHour); setMinute(settings.dailyTodoMinute); setTimezone(settings.timezone); setEnabled(settings.enabled); setFollowupEnabled(settings.followupSyncEnabled); setFollowupHour(settings.followupSyncHour); setFollowupMinute(settings.followupSyncMinute); } }, [settings]);
  const save = useMutation({ mutationFn: api.updateAutomationSettings, onSuccess: (next) => { queryClient.setQueryData(queryKeys.automation, next); } });
  const run = useMutation({ mutationFn: api.runAutomation, onSettled: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.automation }); void queryClient.invalidateQueries({ queryKey: queryKeys.automationRuns }); } });
  const saveSettings = () => save.mutate({ analysisIntervalHours: interval, intelligenceMode, intelligenceProviderId: intelligenceMode === "ai" ? intelligenceProviderId || null : null, dailyTodoHour: hour, dailyTodoMinute: minute, timezone, enabled });
  const followupRunsQuery = useQuery({ queryKey: queryKeys.followupSyncRuns, queryFn: () => api.followupSyncRuns(10), refetchInterval: 15_000, enabled: followupEnabled || Boolean(settings?.followupSyncEnabled) });
  const saveFollowup = useMutation({
    mutationFn: () => api.updateFollowupSyncSettings({ enabled: followupEnabled, hour: followupHour, minute: followupMinute }),
    onSuccess: (next) => { queryClient.setQueryData(queryKeys.automation, next); void queryClient.invalidateQueries({ queryKey: queryKeys.followupSyncRuns }); }
  });
  const syncNow = useMutation({
    mutationFn: api.runFollowupSync,
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: queryKeys.automation }); void queryClient.invalidateQueries({ queryKey: queryKeys.followupSyncRuns }); }
  });
  const engineBadge = (engine: FollowupSyncEngine, model: string | null) => <span className={`followup-engine is-${engine}`}>{FOLLOWUP_ENGINE_LABEL[engine]}{model ? ` · ${model}` : ""}</span>;
  const providers = providersQuery.data ?? [];
  const selectedProvider = providers.find((provider) => provider.id === intelligenceProviderId);
  return <div className="page page-automation">
    <div className="page-heading"><div><span className="eyebrow">AUTOMATION RHYTHM</span><h1>自动化节奏</h1><p>实时接收、周期分析和每日跟进各自运行，所有结果都会留下可追踪记录。</p></div><button className="button primary" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? <Spinner /> : <Play size={16} />} 立即运行一轮</button></div>
    <div className="rhythm-hero"><div><span className="live-dot is-online" /><strong>实时同步在线</strong><p>WhatsApp 新消息到达后立即入库、更新未读数并推送到会话工作台。</p></div><div className="rhythm-hero-meta"><span>运行状态</span><b>{enabled ? "自动运行" : "已暂停"}</b><small>最后运行 {formatTime(settings?.updatedAt)}</small></div></div>
    <div className="automation-grid">
      <section className="automation-card"><div className="automation-card-icon blue"><Radio size={20} /></div><div className="automation-card-copy"><span className="card-kicker">01 · 事件驱动</span><h2>实时同步</h2><p>每条消息实时写入加密 Inbox，并通过 WebSocket 更新客户会话。</p><div className="automation-status"><CheckCircle2 size={15} /> 正常监听中</div></div></section>
      <section className="automation-card"><div className="automation-card-icon purple"><BrainCircuit size={20} /></div><div className="automation-card-copy"><span className="card-kicker">02 · 周期分析</span><h2>客户画像更新</h2><p>按周期重算客户意向、风险、特征和证据，避免每条消息触发昂贵分析。</p><div className={`automation-status ${settings?.intelligenceMode === "ai" ? "ai-engine" : ""}`}><BrainCircuit size={15} />{settings?.intelligenceMode === "ai" ? "AI 深度分析" : "规则识别"}</div><div className="automation-stat-row"><span><small>上次分析</small><b>{formatTime(settings?.lastAnalysisAt)}</b></span><span><small>下次分析</small><b>{formatTime(settings?.nextAnalysisAt)}</b></span></div></div></section>
      <section className="automation-card"><div className="automation-card-icon amber"><BellRing size={20} /></div><div className="automation-card-copy"><span className="card-kicker">03 · 每日批处理</span><h2>待办与站内信</h2><p>待办按客户和跟进项永久去重，未完成事项每天最多发送一封站内信。</p><div className="automation-stat-row"><span><small>上次生成</small><b>{formatTime(settings?.lastDailyTodoAt)}</b></span><span><small>下次生成</small><b>{formatTime(settings?.nextDailyTodoAt)}</b></span></div></div></section>
      <section className="automation-card"><div className="automation-card-icon green"><CalendarClock size={20} /></div><div className="automation-card-copy"><span className="card-kicker">04 · 每日同步</span><h2>客户跟进同步</h2><p>每天把当天 WhatsApp 对话同步进 CRM：跟进即时写入（基础信息立即可见），本机 CLI 在后台生成 AI 进展总结并自动补全。</p><div className="automation-stat-row"><span><small>上次同步</small><b>{formatTime(settings?.lastFollowupSyncAt)}</b></span><span><small>下次同步</small><b>{formatTime(settings?.nextFollowupSyncAt)}</b></span></div><div className={`automation-status ${settings?.followupSyncEnabled ? "" : "muted"}`}><CalendarClock size={15} />{settings?.followupSyncEnabled ? `每天 ${String(settings.followupSyncHour).padStart(2, "0")}:${String(settings.followupSyncMinute).padStart(2, "0")} 自动同步` : "未开启"}</div></div></section>
    </div>
    <section className="settings-section followup-sync">
      <header><CalendarClock size={18} /><div><h2>客户跟进同步</h2><p>把当天有往来的 WhatsApp 会话归纳成一条跟进，写进 CRM 客户动态或新线索。默认关闭——写入的是考核数据，请确认后再开。</p></div><span className={`run-health ${settings?.followupSyncEnabled ? "success" : "idle"}`}>{settings?.followupSyncEnabled ? "已开启" : "未开启"}</span></header>
      <div className="settings-fields rhythm-fields">
        <Toggle checked={followupEnabled} onChange={setFollowupEnabled} label="启用每日跟进同步" />
        <label><span>同步时间</span><div className="time-pair"><select value={followupHour} onChange={(e) => setFollowupHour(Number(e.target.value))} disabled={!followupEnabled}>{Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, "0")} 时</option>)}</select><select value={followupMinute} onChange={(e) => setFollowupMinute(Number(e.target.value))} disabled={!followupEnabled}><option value={0}>00 分</option><option value={15}>15 分</option><option value={30}>30 分</option><option value={45}>45 分</option></select></div></label>
        <label><span>时区</span><b className="followup-timezone">{timezone === "Asia/Shanghai" ? "中国标准时间" : timezone === "Asia/Tokyo" ? "日本标准时间" : timezone === "Europe/London" ? "英国时间" : timezone === "America/New_York" ? "纽约时间" : timezone}</b><small className="followup-timezone-hint">跟随上方「运行节奏」里的时区设置</small></label>
        <div className="followup-actions">
          <button className="button primary" disabled={saveFollowup.isPending} onClick={() => saveFollowup.mutate()}>{saveFollowup.isPending ? <Spinner /> : <Save size={16} />} 保存设置</button>
          <button className="button" disabled={syncNow.isPending} onClick={() => syncNow.mutate()}>{syncNow.isPending ? <Spinner /> : <RefreshCw size={16} />} 立即同步今天</button>
        </div>
      </div>
      {saveFollowup.isSuccess && <div className="notice success-notice"><CheckCircle2 size={16} /><span>跟进同步设置已保存{followupEnabled ? `，每天 ${String(followupHour).padStart(2, "0")}:${String(followupMinute).padStart(2, "0")} 自动运行。` : "，已关闭。"}</span></div>}
      {saveFollowup.error && <div className="notice error-notice"><AlertTriangle size={16} /><span>{saveFollowup.error.message}</span></div>}
      {syncNow.data && <div className="notice success-notice"><Sparkles size={17} /><div><strong>本轮同步完成（{FOLLOWUP_ENGINE_LABEL[syncNow.data.engine]}）</strong><span>{syncNow.data.summary}</span></div></div>}
      {syncNow.error && <div className="notice error-notice"><AlertTriangle size={17} /><div><strong>同步没有完成</strong><span>{syncNow.error.message}</span></div></div>}
      {followupRunsQuery.isError ? <div className="automation-history-empty error-text">同步记录读取失败，请刷新重试。</div>
        : followupRunsQuery.data?.length ? <div className="automation-run-list">{followupRunsQuery.data.map((item: FollowupSyncRun) => {
          const statusLabel = item.status === "running" ? "执行中" : item.status === "success" ? "已完成" : item.status === "partial" ? "部分完成" : "失败";
          const expanded = expandedRunId === item.id;
          return <article className={`automation-run-row ${item.status === "partial" ? "failed" : item.status}`} key={item.id}>
            <div className="automation-run-main">
              <span className="automation-run-status"><i />{statusLabel}</span>
              <strong>{item.trigger === "manual" ? "手动同步" : "定时同步"}</strong>
              <time>{item.runDate} · {formatTime(item.startedAt)}</time>
              {engineBadge(item.engine, item.model)}
              {item.error && <small className="error-text">{item.error}</small>}
              <button type="button" className="button compact followup-expand" onClick={() => setExpandedRunId(expanded ? null : item.id)}><ChevronDown size={13} style={{ transform: expanded ? "rotate(180deg)" : undefined, transition: "transform .15s" }} /> {expanded ? "收起明细" : "查看明细"}</button>
            </div>
            <div className="automation-run-progress">
              <div className="automation-run-stats"><span>写入跟进 {item.activitiesWritten}</span><span>新线索 {item.leadsCreated}</span><span>已有 {item.leadsExisting}</span><span>跳过 {item.skipped}</span>{item.ambiguous > 0 && <span>存疑 {item.ambiguous}</span>}<span>消息 {item.messageCount}</span></div>
              <p className="followup-run-summary">{item.summary}</p>
            </div>
            {expanded && <FollowupRunDetail runId={item.id} />}
          </article>;
        })}</div>
        : <div className="automation-history-empty">{settings?.followupSyncEnabled ? "还没有同步记录，点「立即同步今天」或等每日定时任务跑完。" : "开启后每次同步都会在这里留下记录。"}</div>}
    </section>
    <section className="settings-section rhythm-settings"><header><TimerReset size={18} /><div><h2>运行节奏</h2><p>分析引擎、执行周期和通知时间统一在这里管理。</p></div></header><div className="settings-fields rhythm-fields"><Toggle checked={enabled} onChange={setEnabled} label="启用自动运行" /><label><span>客户分析引擎</span><select value={intelligenceMode} onChange={(e) => setIntelligenceMode(e.target.value as "rules" | "ai")}><option value="rules">规则识别（零模型成本）</option><option value="ai">AI 深度分析（推荐商业使用）</option></select></label>{intelligenceMode === "ai" && <label><span>深度分析 Provider</span><select value={intelligenceProviderId} onChange={(e) => setIntelligenceProviderId(e.target.value)}><option value="">请选择已测试 Provider</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}{provider.lastTestStatus === "success" ? " · 已测试" : " · 未验证"}</option>)}</select></label>}<label><span>客户分析间隔</span><select value={interval} onChange={(e) => setInterval(Number(e.target.value))}><option value={1}>每 1 小时</option><option value={3}>每 3 小时</option><option value={6}>每 6 小时</option><option value={12}>每 12 小时</option><option value={24}>每天 1 次</option></select></label><label><span>每日待办生成时间</span><div className="time-pair"><select value={hour} onChange={(e) => setHour(Number(e.target.value))}>{Array.from({ length: 24 }, (_, i) => <option key={i} value={i}>{String(i).padStart(2, "0")} 时</option>)}</select><select value={minute} onChange={(e) => setMinute(Number(e.target.value))}><option value={0}>00 分</option><option value={15}>15 分</option><option value={30}>30 分</option><option value={45}>45 分</option></select></div></label><label><span>时区</span><select value={timezone} onChange={(e) => setTimezone(e.target.value)}><option value="Asia/Shanghai">中国标准时间 · Asia/Shanghai</option><option value="Asia/Tokyo">日本标准时间 · Asia/Tokyo</option><option value="Europe/London">英国时间 · Europe/London</option><option value="America/New_York">纽约时间 · America/New_York</option></select></label>{intelligenceMode === "ai" && (!intelligenceProviderId || selectedProvider?.lastTestStatus !== "success") && <div className="notice warning-notice intelligence-warning"><AlertTriangle size={16} /><span>{!intelligenceProviderId ? "请选择 Provider 后再保存。" : "该 Provider 尚未通过连通性测试，建议先到 AI 翻译页面完成测试。"}</span></div>}<div className="rhythm-save"><span><CalendarClock size={15} /> {settings?.lastRunSummary ?? "配置保存后生效"}</span><button className="button primary" disabled={save.isPending || (intelligenceMode === "ai" && !intelligenceProviderId)} onClick={saveSettings}>{save.isPending ? <Spinner /> : <Save size={16} />} 保存节奏</button></div></div>{save.error && <div className="form-error">{save.error.message}</div>}</section>
    {run.data && <div className="notice success-notice"><Sparkles size={17} /><span>本轮完成：分析 {run.data.analysisUpdated} 个会话，新增 {run.data.todosCreated} 条待办，发送 {run.data.notificationsSent} 条站内信，安全跳过 {run.data.skipped} 个重复或无需处理项。</span></div>}
    {run.error && <div className="notice error-notice"><AlertTriangle size={17} /><div><strong>本轮没有完整交付</strong><span>{run.error.message}</span></div></div>}
    <section className="settings-section automation-history"><header><Clock3 size={18} /><div><h2>运行记录</h2><p>每次自动分析都会保留执行进度和结果，方便核对失败项。</p></div><span className={`run-health ${settings?.lastRunStatus ?? "idle"}`}>{settings?.lastRunStatus === "running" ? "执行中" : settings?.lastRunStatus === "failed" ? "需要关注" : settings?.lastRunStatus === "success" ? "最近成功" : "尚未运行"}</span></header>
      {runsQuery.isLoading ? <div className="automation-history-empty">正在读取运行记录...</div> : runsQuery.isError ? <div className="automation-history-empty error-text">运行记录读取失败，请刷新重试。</div> : runsQuery.data?.length ? <div className="automation-run-list">{runsQuery.data.map((item) => {
        const progress = item.totalConversations ? Math.min(100, Math.round(item.processedConversations / item.totalConversations * 100)) : item.status === "running" ? 8 : 100;
        const statusLabel = item.status === "running" ? "执行中" : item.status === "success" ? "已完成" : "失败";
        return <article className={`automation-run-row ${item.status}`} key={item.id}><div className="automation-run-main"><span className="automation-run-status"><i />{statusLabel}</span><strong>{item.trigger === "manual" ? "手动运行" : "定时运行"}</strong><time>{formatTime(item.startedAt)}</time>{item.currentConversation && <small>正在分析：{item.currentConversation}</small>}{item.error && <small className="error-text">{item.error}</small>}{item.status === "failed" && <button type="button" className="button compact retry-run" disabled={run.isPending} onClick={() => run.mutate()}><RotateCcw size={13} /> 再次运行</button>}</div><div className="automation-run-progress"><div className="automation-progress-meta"><span>{item.processedConversations}/{item.totalConversations} 个会话</span><b>{progress}%</b></div><div className="automation-progress-track" aria-label={`已处理 ${progress}%`}><span style={{ width: `${progress}%` }} /></div><div className="automation-run-stats"><span>更新分析 {item.analysisUpdated}</span><span>新增待办 {item.todosCreated}</span><span>站内信 {item.notificationsSent}</span><span>安全跳过 {item.skipped}</span></div></div></article>;
      })}</div> : <div className="automation-history-empty">暂无运行记录，启用自动运行后会在这里留下历史。</div>}
    </section>
    <section className="settings-section automation-history"><header><BellRing size={18} /><div><h2>交付明细</h2><p>逐条查看 CRM 待办和站内信的成功、失败与重试次数。</p></div><span className={`run-health ${deliveriesQuery.data?.some((item) => item.status === "failed") ? "failed" : "success"}`}>{deliveriesQuery.data?.some((item) => item.status === "failed") ? "存在失败" : "交付正常"}</span></header>
      {deliveriesQuery.isLoading ? <div className="automation-history-empty">正在读取交付明细...</div> : deliveriesQuery.isError ? <div className="automation-history-empty error-text">交付明细读取失败，请刷新重试。</div> : deliveriesQuery.data?.length ? <div className="delivery-list">{deliveriesQuery.data.map((item) => <article className={`delivery-row ${item.status}`} key={item.id}><span className="automation-run-status"><i />{item.status === "success" ? "已送达" : item.status === "failed" ? "待重试" : "投递中"}</span><div><strong>{item.deliveryType === "todo" ? "CRM 待办" : "站内信通知"}</strong><small>{item.runDate} · 尝试 {item.attempts} 次{item.externalId ? ` · 外部编号 ${item.externalId}` : ""}</small>{item.lastError && <p className="error-text">{item.lastError}</p>}</div><time>{formatTime(item.updatedAt)}</time></article>)}</div> : <div className="automation-history-empty">还没有交付记录，运行每日待办后会在这里显示。</div>}
    </section>
  </div>;
}
