import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bot,
  BookOpen,
  Check,
  CheckCircle2,
  Download,
  FileDown,
  GraduationCap,
  Library,
  ListChecks,
  MessagesSquare,
  Play,
  Plus,
  Quote,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  Wand2,
  X
} from "lucide-react";
import type {
  AutoChatDraft,
  AutoChatDraftStatus,
  AutoChatEngine,
  AutoChatMode,
  ChannelAccount,
  TrainingExportFormat,
  TrainingLibraryEntry,
  TrainingLibraryKind,
  TrainingProfile
} from "@shared/types";
import { api, type TrainingExportClientResult } from "../api";
import { queryKeys, useAccounts } from "../data";
import { ConfirmModal, EmptyState, Spinner, Toggle } from "../components/ui";

const languages = [
  ["auto", "跟随客户语言"], ["zh-CN", "简体中文"], ["en", "English"], ["es", "Español"],
  ["pt", "Português"], ["fr", "Français"], ["de", "Deutsch"], ["ja", "日本語"]
];

const formats: Array<{ value: TrainingExportFormat; label: string; hint: string }> = [
  { value: "jsonl", label: "JSONL", hint: "每行一个会话，最适合喂给训练流水线" },
  { value: "json", label: "JSON", hint: "单个数组文件，便于程序读取" },
  { value: "txt", label: "TXT", hint: "WhatsApp 导出格式，便于人工核对" }
];

const modes: Array<{ value: AutoChatMode; label: string; hint: string }> = [
  { value: "off", label: "关闭", hint: "不生成任何回复" },
  { value: "draft", label: "草稿待确认", hint: "生成草稿，人工确认后发送（最稳）" },
  { value: "auto", label: "自动回复", hint: "达标即自动发出，不达标仍留草稿" }
];

const engines: Array<{ value: AutoChatEngine; label: string; hint: string }> = [
  { value: "auto", label: "自动选择（推荐）", hint: "配了 AI Provider 就用它；否则用本机 CLI；都没有才退到训练话术库" },
  { value: "cli", label: "本机 WorkBuddy CLI", hint: "用本机已登录的 CLI 生成，不需要任何 API Key" },
  { value: "ai", label: "AI Provider", hint: "调用上面登记的 OpenAI 兼容模型" },
  { value: "rules", label: "只用训练话术库", hint: "零模型成本，检索历史相似问答" }
];

/**
 * 训练库四类条目。问法/答法的字段含义每类都不同，界面必须按类换标签与示例，
 * 否则用户会把「禁用短语」填成「处置说明」——那会让禁用语检查永远不命中。
 */
const libraryKinds: Array<{
  value: TrainingLibraryKind;
  label: string;
  hint: string;
  questionLabel: string;
  questionPlaceholder: string;
  answerLabel: string;
  answerPlaceholder: string;
}> = [
  {
    value: "qa",
    label: "标准问答对",
    hint: "客户这么问、我们这么答；命中即作为回复的内容基准（优先级最高）",
    questionLabel: "客户问法",
    questionPlaceholder: "例如：你们最小的型号是什么？",
    answerLabel: "标准答法",
    answerPlaceholder: "例如：我们最小的机型是 X-20，适合小批量试单……"
  },
  {
    value: "snippet",
    label: "口径片段",
    hint: "固定说法（认证口径、公司表述等），生成时会按客户语言改写后使用",
    questionLabel: "片段名称（可选）",
    questionPlaceholder: "例如：付款方式",
    answerLabel: "固定口径",
    answerPlaceholder: "例如：常规是 30% 定金 + 70% 见提单副本，具体可在确认订单时再谈。"
  },
  {
    value: "policy",
    label: "政策",
    hint: "硬约束，会并入护栏一起写进提示词；触碰它的回复不会自动发送",
    questionLabel: "政策名称（可选）",
    questionPlaceholder: "例如：报价权限",
    answerLabel: "政策内容",
    answerPlaceholder: "例如：任何情况下不得在聊天里给出具体价格，统一回复安排报价。"
  },
  {
    value: "forbidden",
    label: "禁用场景 / 禁用语",
    hint: "答法填「禁用短语」（回复里出现即拦下不自动发送）；问法填触发场景（客户这么说就转人工）",
    questionLabel: "触发场景（可选）",
    questionPlaceholder: "例如：索赔",
    answerLabel: "禁用短语",
    answerPlaceholder: "例如：我们承担全部损失"
  }
];

/** 真正生效的通道在界面上的说法（`auto` 会被解析成这三者之一）。 */const effectiveEngineLabels: Record<"rules" | "ai" | "cli", string> = {
  cli: "本机 WorkBuddy CLI",
  ai: "AI Provider",
  rules: "训练话术库"
};

/** 与后端 MAX_RULE_CONFIDENCE 保持一致：话术库检索的置信度上限。 */
const RULE_CONFIDENCE_CAP = 0.9;

const draftStatusLabels: Record<AutoChatDraftStatus, string> = {
  pending: "待确认",
  sending: "发送中",
  sent: "已发送",
  dismissed: "已忽略",
  failed: "发送失败",
  skipped: "已跳过"
};

function formatTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function download(fileName: string, content: string): void {
  const blob = new Blob([content], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function TrainingPage() {
  const queryClient = useQueryClient();
  const accountsQuery = useAccounts();
  const accounts = accountsQuery.data ?? [];
  const [accountId, setAccountId] = useState<string>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [format, setFormat] = useState<TrainingExportFormat>("jsonl");
  const [profileName, setProfileName] = useState("");
  const [useAi, setUseAi] = useState(false);
  const [aiProviderId, setAiProviderId] = useState("");
  const [exportResult, setExportResult] = useState<TrainingExportClientResult>();
  const [deleteCandidate, setDeleteCandidate] = useState<TrainingProfile | null>(null);
  /** 训练结果与「是否复用」分开记：复用时界面要说清楚「没花钱跑模型」，不能让人以为白等了。 */
  const [trainOutcome, setTrainOutcome] = useState<{ profile: TrainingProfile; reused: boolean }>();
  /** 训练是同步接口（CLI 提炼可能要几十秒），等待期间必须给出活着的时间反馈，不能只有一个转圈。 */
  const [trainElapsed, setTrainElapsed] = useState(0);

  const profilesQuery = useQuery({ queryKey: queryKeys.trainingProfiles, queryFn: api.trainingProfiles });
  const providersQuery = useQuery({ queryKey: queryKeys.aiProviders, queryFn: api.aiProviders });
  const settingsQuery = useQuery({
    queryKey: queryKeys.autoChatSettings(accountId || undefined),
    queryFn: () => api.autoChatSettings(accountId || undefined)
  });
  const draftsQuery = useQuery({
    queryKey: queryKeys.autoChatDrafts(),
    queryFn: () => api.autoChatDrafts({ limit: 60 }),
    refetchInterval: 15_000
  });
  // 本机 CLI 能力。后端自带 5 分钟成功缓存 / 20 秒失败缓存，所以按需刷新即可。
  const engineQuery = useQuery({ queryKey: queryKeys.autoChatEngine, queryFn: () => api.autoChatEngine() });
  const refreshEngine = useMutation({
    mutationFn: () => api.autoChatEngine(true),
    onSuccess: (status) => queryClient.setQueryData(queryKeys.autoChatEngine, status)
  });

  const profiles = profilesQuery.data ?? [];
  const providers = providersQuery.data ?? [];
  const settings = settingsQuery.data;
  const drafts = draftsQuery.data ?? [];
  const cli = engineQuery.data;

  /**
   * 「自动」到底会走哪条通道——与后端 resolveEngine 同一口径。
   * 界面必须把它讲明白，否则用户选了「自动」却不知道钱花在哪、或者回复为什么突然变味。
   */
  const effectiveEngine = useMemo<"rules" | "ai" | "cli">(() => {
    if (!settings) return "rules";
    if (settings.engine === "rules") return "rules";
    if (settings.engine === "cli") return cli?.available ? "cli" : "rules";
    if (settings.engine === "ai") return settings.providerId ? "ai" : "rules";
    if (settings.providerId) return "ai";
    return cli?.available ? "cli" : "rules";
  }, [settings, cli]);

  const scope = useMemo(() => ({
    accountId: accountId || undefined,
    from: from || undefined,
    to: to || undefined
  }), [accountId, from, to]);

  const exportMutation = useMutation({
    mutationFn: () => api.exportTrainingData({ ...scope, format }),
    onSuccess: (result) => setExportResult(result)
  });
  const trainMutation = useMutation({
    mutationFn: () => api.trainProfile({
      ...scope,
      name: profileName.trim() || `训练档案 ${new Date().toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
      useAi,
      providerId: useAi && aiProviderId ? aiProviderId : undefined
    }),
    onSuccess: ({ profile, reused }) => {
      setProfileName("");
      if (!reused) {
        queryClient.setQueryData(queryKeys.trainingProfiles, (current: TrainingProfile[] | undefined) => [profile, ...(current ?? [])]);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.trainingProfiles });
      setTrainOutcome({ profile, reused });
    }
  });

  // 训练等待计时：同步接口最长可能等几分钟（CLI 提炼），每秒报一次「还活着」。
  useEffect(() => {
    if (!trainMutation.isPending) {
      setTrainElapsed(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => setTrainElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [trainMutation.isPending]);
  const removeMutation = useMutation({
    mutationFn: api.deleteTrainingProfile,
    onSuccess: () => {
      setDeleteCandidate(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.trainingProfiles });
      void queryClient.invalidateQueries({ queryKey: queryKeys.autoChatSettings(accountId || undefined) });
    }
  });
  const saveSettings = useMutation({
    mutationFn: api.updateAutoChatSettings,
    onSuccess: (next) => queryClient.setQueryData(queryKeys.autoChatSettings(accountId || undefined), next)
  });
  const runAutoChat = useMutation({
    mutationFn: () => api.runAutoChat(accountId ? { accountId } : {}),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["auto-chat-drafts"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.autoChatSettings(accountId || undefined) });
    }
  });
  const sendDraft = useMutation({
    mutationFn: ({ id, body }: { id: string; body?: string }) => api.sendAutoChatDraft(id, body),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["auto-chat-drafts"] })
  });
  const dismissDraft = useMutation({
    mutationFn: api.dismissAutoChatDraft,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["auto-chat-drafts"] })
  });

  const pendingDrafts = drafts.filter((draft) => draft.status === "pending");
  const historyDrafts = drafts.filter((draft) => draft.status !== "pending");
  const readyProfiles = profiles.filter((profile) => profile.status === "ready");

  return (
    <div className="page page-training">
      <div className="page-heading">
        <div>
          <span className="eyebrow">REPLY TRAINING & AUTO CHAT</span>
          <h1>训练与自动回复</h1>
          <p>导出真实聊天记录 → 训练出团队专属话术档案 → 让系统按这份口吻起草回复，或在你设定的边界内自动应答。</p>
        </div>
      </div>

      <section className="training-steps">
        <article className="training-step">
          <div className="training-step-head"><span className="training-step-index">01</span><div><h2>导出聊天记录</h2><p>按账号和时间范围打包，导出内容就是训练原料。</p></div></div>
          <div className="training-fields">
            <label><span>账号范围</span><select value={accountId} onChange={(event) => setAccountId(event.target.value)}><option value="">全部账号</option>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
            <div className="training-field-pair">
              <label><span>起始日期</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
              <label><span>结束日期</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
            </div>
            <div className="training-format-group">
              <span className="training-group-label">导出格式</span>
              <div className="training-format-options">
                {formats.map((item) => (
                  <button key={item.value} type="button" className={`training-format ${format === item.value ? "is-active" : ""}`} onClick={() => setFormat(item.value)}>
                    <strong>{item.label}</strong><small>{item.hint}</small>
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="training-actions">
            <button className="button primary" disabled={exportMutation.isPending} onClick={() => exportMutation.mutate()}>
              {exportMutation.isPending ? <Spinner /> : <FileDown size={16} />} 预览导出
            </button>
            {exportResult && <button className="button" type="button" onClick={() => download(exportResult.fileName, exportResult.content)}><Download size={16} /> 下载文件</button>}
          </div>
          {exportMutation.error && <div className="notice error-notice"><AlertTriangle size={16} /><span>{exportMutation.error.message}</span></div>}
          {exportResult && (
            <div className="training-export">
              <div className="training-metrics">
                <span><small>会话</small><b>{formatNumber(exportResult.conversationCount)}</b></span>
                <span><small>消息</small><b>{formatNumber(exportResult.messageCount)}</b></span>
                <span><small>问答对</small><b>{formatNumber(exportResult.exchangeCount)}</b></span>
                <span><small>字符</small><b>{formatNumber(exportResult.characters)}</b></span>
              </div>
              <div className="training-export-file"><FileDown size={15} /><span>{exportResult.fileName}</span>{exportResult.skippedConversations > 0 && <em>另有 {exportResult.skippedConversations} 个会话被跳过</em>}</div>
              <div className="training-sample">
                <div className="training-sample-head"><MessagesSquare size={15} /><span>样例（{exportResult.sample.length} 条）</span></div>
                {exportResult.sample.map((message, index) => (
                  <div className={`training-sample-row is-${message.role}`} key={`${message.conversationId}-${index}`}>
                    <span className="training-sample-who">{message.role === "customer" ? message.contactName || "客户" : "我方"}</span>
                    <p>{message.body || "（空）"}</p>
                    <time>{formatTime(message.at)}</time>
                  </div>
                ))}
              </div>
            </div>
          )}
        </article>

        <article className="training-step">
          <div className="training-step-head"><span className="training-step-index">02</span><div><h2>训练话术档案</h2><p>从历史记录里提炼语气、结构与高频表达。</p></div></div>
          <div className="training-fields">
            <label><span>档案名称</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="例如：欧洲区跟进话术" /></label>
            <Toggle checked={useAi} onChange={setUseAi} label="使用 AI 深度提炼（需要可用的 Provider）" />
            {useAi && (
              <label><span>提炼用 Provider</span>
                <select value={aiProviderId} onChange={(event) => setAiProviderId(event.target.value)}>
                  <option value="">请选择 Provider</option>
                  {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}{provider.lastTestStatus === "success" ? " · 已测试" : " · 未验证"}</option>)}
                </select>
                {providers.length === 0 && <small>还没有 Provider，请先到「AI 翻译」页添加。</small>}
              </label>
            )}
          </div>
          <div className="training-actions">
            <button className="button primary" disabled={trainMutation.isPending || (useAi && !aiProviderId)} onClick={() => trainMutation.mutate()}>
              {trainMutation.isPending ? <Spinner /> : <Wand2 size={16} />} {trainMutation.isPending ? `提炼中… ${trainElapsed}s` : "开始训练"}
            </button>
            <span className="training-hint">训练不会修改或删除任何聊天记录。走 CLI / AI 提炼时可能需要几十秒。</span>
          </div>
          {trainMutation.error && <div className="notice error-notice"><AlertTriangle size={16} /><span>{trainMutation.error.message}</span></div>}
          {trainOutcome?.reused && <div className="notice"><CheckCircle2 size={16} /><span>输入与上次完全一致，已直接复用「{trainOutcome.profile.name}」，没有再调用模型。改时间范围或换个名字可以强制重训。</span></div>}
          {trainOutcome && !trainOutcome.reused && (
            <div className="notice success-notice"><CheckCircle2 size={16} /><span>已生成「{trainOutcome.profile.name}」：{trainOutcome.profile.sampleCount} 组话术样板，{trainOutcome.profile.conversationCount} 个会话。</span></div>
          )}
        </article>
      </section>

      <section className="settings-section training-profiles">
        <header>
          <GraduationCap size={18} />
          <div><h2>训练档案</h2><p>自动聊只使用状态为「可用」的档案。</p></div>
          {profilesQuery.isLoading && <Spinner />}
        </header>
        {profiles.length === 0
          ? <EmptyState icon={<GraduationCap size={22} />} title="还没有训练档案" description="先导出并训练一份，自动聊才有可用的口吻依据。" />
          : (
            <div className="training-profile-list">
              {profiles.map((profile) => (
                <article className={`training-profile ${profile.status}`} key={profile.id}>
                  <header>
                    <div className="training-profile-title">
                      <strong>{profile.name}</strong>
                      <span className={`training-profile-status is-${profile.status}`}>{profile.status === "ready" ? "可用" : "样本不足"}</span>
                      <span className={`training-profile-engine is-${profile.engine}`}>{profile.engine === "cli" ? `CLI 提炼${profile.model ? ` · ${profile.model}` : ""}` : profile.engine === "ai" ? `AI 提炼${profile.model ? ` · ${profile.model}` : ""}` : profile.engine === "web-import" ? "浏览器归档导入" : "规则提炼"}</span>
                    </div>
                    <button className="icon-button danger" type="button" title="删除训练档案" aria-label={`删除 ${profile.name}`} disabled={removeMutation.isPending} onClick={() => setDeleteCandidate(profile)}><Trash2 size={16} /></button>
                  </header>
                  <div className="training-profile-metrics">
                    <span><small>账号</small><b>{profile.accountName ?? "全部账号"}</b></span>
                    <span><small>样本</small><b>{formatNumber(profile.sampleCount)}</b></span>
                    <span><small>问答对</small><b>{formatNumber(profile.exchangeCount)}</b></span>
                    <span><small>消息</small><b>{formatNumber(profile.messageCount)}</b></span>
                    <span><small>被自动聊引用</small><b>{formatNumber(profile.hitCount)}</b>{profile.lastHitAt && <small>最近 {formatTime(profile.lastHitAt)}</small>}</span>
                    <span><small>训练时间</small><b>{formatTime(profile.trainedAt)}</b></span>
                  </div>
                  {profile.error && <div className="training-profile-warning"><AlertTriangle size={14} /><span>{profile.error}</span></div>}
                  <p className="training-profile-summary">{profile.summary}</p>
                  <div className="training-profile-block"><span className="training-block-label">语气</span><p>{profile.tone || "—"}</p></div>
                  {profile.guidelines.length > 0 && (
                    <div className="training-profile-block"><span className="training-block-label">写作准则</span><ul>{profile.guidelines.map((item) => <li key={item}>{item}</li>)}</ul></div>
                  )}
                  {profile.signaturePhrases.length > 0 && (
                    <div className="training-profile-block"><span className="training-block-label">高频表达</span><div className="training-chips">{profile.signaturePhrases.map((item) => <span className="training-chip" key={item}>{item}</span>)}</div></div>
                  )}
                  {profile.guardrails.length > 0 && (
                    <div className="training-profile-block is-guardrail"><span className="training-block-label"><ShieldCheck size={13} /> 护栏</span><ul className="training-guardrails">{profile.guardrails.map((item) => <li key={item}>{item}</li>)}</ul></div>
                  )}
                  {profile.examples.length > 0 && (
                    <details className="training-examples">
                      <summary><Quote size={14} /> 话术样板（{profile.examples.length}）</summary>
                      <div className="training-example-list">
                        {profile.examples.slice(0, 6).map((example, index) => (
                          <div className="training-example" key={`${profile.id}-${index}`}>
                            <p className="is-customer">{example.inbound}</p>
                            <p className="is-agent">{example.reply}</p>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </article>
              ))}
            </div>
          )}
      </section>

      <TrainingLibrarySection accounts={accounts} profiles={readyProfiles} />

      <section className="settings-section auto-chat">
        <header><Bot size={18} /><div><h2>自动回复</h2><p>用训练出来的话术档案自动回客户。默认走本机 WorkBuddy CLI（不需要 API Key）；选「自动回复」后，置信度达标就真的发出，不达标仍留草稿。</p></div></header>
        {!settings ? <div className="center-loading"><Spinner /> 加载自动聊设置</div> : (
          <>
            <div className="auto-chat-mode">
              {modes.map((mode) => (
                <button key={mode.value} type="button" className={`auto-chat-mode-option ${settings.mode === mode.value ? "is-active" : ""}`} onClick={() => saveSettings.mutate({ enabled: mode.value !== "off", mode: mode.value, accountId: accountId || null })}>
                  <strong>{mode.label}</strong><small>{mode.hint}</small>
                </button>
              ))}
            </div>
            <div className="settings-fields auto-chat-fields">
              <div className="auto-chat-group-head"><strong>生成通道</strong><span>话术依据、生成引擎与模型</span></div>
              <label className="auto-chat-wide"><span>生成引擎</span>
                <select value={settings.engine} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, engine: event.target.value as AutoChatEngine })}>
                  {engines.map((engine) => <option key={engine.value} value={engine.value}>{engine.label}</option>)}
                </select>
                <small>{engines.find((engine) => engine.value === settings.engine)?.hint}　当前实际使用：<strong>{effectiveEngineLabels[effectiveEngine]}</strong>{settings.engine === "auto" && effectiveEngine !== "cli" && cli?.available ? "（配了 AI Provider，CLI 让位）" : ""}</small>
              </label>
              <label><span>训练档案</span>
                <select value={settings.profileId ?? ""} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, profileId: event.target.value || null })}>
                  <option value="">尚未选择</option>
                  {readyProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.accountName ? ` · ${profile.accountName}` : ""}</option>)}
                </select>
                {readyProfiles.length === 0 && <small>还没有可用的训练档案，请先完成第 2 步。</small>}
              </label>
              <label><span>AI Provider（引擎选 AI 或自动时生效）</span>
                <select value={settings.providerId ?? ""} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, providerId: event.target.value || null })}>
                  <option value="">未配置（跳过 AI 通道）</option>
                  {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.model}</option>)}
                </select>
                <small>{providers.length === 0 ? "还没有 AI Provider。不用配也能自动回复：本机 CLI 或训练话术库都能顶。" : "留空则自动选择时不走 AI 通道。"}</small>
              </label>
              {(settings.engine === "cli" || settings.engine === "auto") && (
                <>
                  <label><span>CLI 模型</span>
                    <select value={settings.cliModel} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, cliModel: event.target.value })}>
                      <option value="">跟随 CLI 默认</option>
                      {(cli?.models ?? []).map((model) => <option key={model} value={model}>{model}{model === cli?.defaultModel ? " · 系统默认" : ""}</option>)}
                    </select>
                    <small>跟随默认时用哪个模型由当前登录的 CLI 账号决定，换账号就会变；要稳定就显式选一个。</small>
                  </label>
                  <label><span>思考档位</span>
                    <select value={settings.cliEffort} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, cliEffort: event.target.value })}>
                      <option value="">跟随 CLI 默认</option>
                      {(cli?.efforts ?? []).map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                    </select>
                    <small>自动回复是短任务；档位越低越快，单次生成超时上限 60 秒。</small>
                  </label>
                </>
              )}
              <div className="auto-chat-group-head"><strong>回复内容</strong><span>生成时使用的语言</span></div>
              <label className="auto-chat-wide"><span>回复语言</span>
                <select value={settings.language} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, language: event.target.value })}>
                  {languages.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <div className="auto-chat-group-head"><strong>发送节流</strong><span>控制自动发送的频率与条数</span></div>
              <label><span>每日自动发送上限</span><input type="number" min={0} max={1000} value={settings.dailyLimit} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, dailyLimit: Number(event.target.value) })} /></label>
              <label><span>两条回复最小间隔（分钟）</span><input type="number" min={0} max={1440} value={settings.minIntervalMinutes} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, minIntervalMinutes: Number(event.target.value) })} /></label>
              <div className="auto-chat-group-head"><strong>活跃时段</strong><span>只在这个时间窗内自动回复</span></div>
              <div className="training-field-pair">
                <label><span>活跃开始（时）</span><input type="number" min={0} max={23} value={settings.activeHoursStart} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, activeHoursStart: Number(event.target.value) })} /></label>
                <label><span>活跃结束（时）</span><input type="number" min={0} max={23} value={settings.activeHoursEnd} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, activeHoursEnd: Number(event.target.value) })} /></label>
              </div>
              <label className="auto-chat-wide"><span>时区</span>
                <select value={settings.timezone} disabled={saveSettings.isPending} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, timezone: event.target.value })}>
                  <option value="Asia/Shanghai">中国标准时间 · Asia/Shanghai</option>
                  <option value="Asia/Tokyo">日本标准时间 · Asia/Tokyo</option>
                  <option value="Europe/London">英国时间 · Europe/London</option>
                  <option value="America/New_York">纽约时间 · America/New_York</option>
                </select>
              </label>
              <div className="auto-chat-group-head"><strong>安全边界</strong><span>达到什么标准才敢替人把话发出去</span></div>
              <label className="auto-chat-wide"><span>自动发送置信度门槛（{settings.confidenceThreshold.toFixed(2)}）</span><input type="range" min={0.3} max={0.95} step={0.05} value={settings.confidenceThreshold} disabled={saveSettings.isPending || settings.mode !== "auto"} onChange={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, confidenceThreshold: Number(event.target.value) })} />
                <small>话术库匹配的置信度上限是 {RULE_CONFIDENCE_CAP.toFixed(2)}：门槛高于它，就只有 AI 生成的内容会自动发出。</small>
              </label>
              <label className="auto-chat-wide"><span>升级关键词（命中即转人工，逗号分隔）</span><input defaultValue={settings.escalateKeywords.join(", ")} disabled={saveSettings.isPending} onBlur={(event) => saveSettings.mutate({ enabled: settings.enabled, mode: settings.mode, accountId: accountId || null, escalateKeywords: event.target.value.split(/[，,]/u).map((item) => item.trim()).filter(Boolean) })} /></label>
            </div>
            {(settings.engine === "cli" || settings.engine === "auto") && (
              <div className={`cli-status ${cli?.available ? "is-ok" : "is-bad"}`}>
                <div className="cli-status-head">
                  <Terminal size={15} />
                  <strong>{cli ? (cli.available ? `本机 CLI 可用 · ${cli.version}` : "本机 CLI 不可用") : "正在探测本机 CLI…"}</strong>
                  <button type="button" className="button compact" disabled={refreshEngine.isPending} onClick={() => refreshEngine.mutate()}>
                    {refreshEngine.isPending ? <Spinner /> : <RefreshCw size={14} />} 重新探测
                  </button>
                </div>
                <span className="cli-status-detail">
                  {cli?.available
                    ? cli.binary
                    : cli?.reason || "探测中。CLI 未登录、二进制被升级替换都会让这里变红。"}
                </span>
                {/* 技能装载是「静默降档」的：技能没扫到，任务照常跑，只是不再按技能里的方法论写回复。
                    所以这里必须明说装没装上，不能等用户从回复质量上体感发现。 */}
                {cli?.available && (
                  <span className={`cli-status-detail ${cli.skills.includes(cli.autoReplySkill) ? "" : "is-warn"}`}>
                    {cli.skills.includes(cli.autoReplySkill)
                      ? `自动回复技能已装载：${cli.autoReplySkill}（共扫到 ${cli.skills.length} 个技能）`
                      : `⚠️ 未扫到自动回复技能 ${cli.autoReplySkill}，当前是降级运行（回复仍会生成，但不走技能里的转人工纪律）。扫描目录：${cli.skillsDirs || "（未配置）"}`}
                  </span>
                )}
                {!cli?.available && settings.engine === "cli" && (
                  <span className="cli-status-detail">引擎选的是「本机 CLI」，此时会退到训练话术库，并且不自动发送。</span>
                )}
              </div>
            )}
            <div className="auto-chat-actions">
              <button className="button primary" disabled={runAutoChat.isPending || !settings.enabled} onClick={() => runAutoChat.mutate()}>{runAutoChat.isPending ? <Spinner /> : <Play size={16} />} 立即运行一轮</button>
              <span className="training-hint">平时每分钟自动补扫一次最近 48 小时内「客户已发、我方未回」的会话，不需要手动点。</span>
            </div>
            {saveSettings.error && <div className="notice error-notice"><AlertTriangle size={16} /><span>{saveSettings.error.message}</span></div>}
            {!settings.enabled && <div className="notice subtle-notice"><ShieldCheck size={16} /><span>自动回复当前关闭，不会生成或发送任何回复。</span></div>}
            {settings.enabled && settings.mode === "auto" && (
              <div className="notice success-notice"><Sparkles size={16} /><span>自动回复已开启：命中升级词转人工；置信度 ≥ {settings.confidenceThreshold.toFixed(2)} 且不触碰护栏时直接发出，其余留草稿。
                {" "}当前通道：<strong>{effectiveEngineLabels[effectiveEngine]}</strong>{effectiveEngine === "rules" ? "（没有可用模型通道，只做话术库检索，命中就按门槛发出）" : effectiveEngine === "cli" && !cli?.available ? "（CLI 探测未通过，实际会退到话术库且不自动发送）" : ""}</span></div>
            )}
            {settings.enabled && settings.mode === "draft" && (
              <div className="notice subtle-notice"><Bot size={16} /><span>草稿模式：只生成可编辑草稿，任何情况下都不会自动发出。</span></div>
            )}
            {runAutoChat.data && (
              <div className="notice success-notice"><Sparkles size={16} /><span>本轮：扫描 {runAutoChat.data.scanned} 个会话，生成 {runAutoChat.data.drafted} 份草稿，自动发送 {runAutoChat.data.sent} 条，跳过 {runAutoChat.data.skipped} 条，失败 {runAutoChat.data.failed} 条。</span></div>
            )}
            {runAutoChat.error && <div className="notice error-notice"><AlertTriangle size={16} /><span>{runAutoChat.error.message}</span></div>}
          </>
        )}
      </section>

      <section className="settings-section auto-chat-drafts">
        <header><MessagesSquare size={18} /><div><h2>草稿与发送记录</h2><p>待确认草稿可以直接改写后发送。</p></div><span className="run-health">{pendingDrafts.length ? `${pendingDrafts.length} 份待确认` : "暂无待确认"}</span></header>
        {pendingDrafts.length === 0 && historyDrafts.length === 0
          ? <div className="automation-history-empty">还没有草稿。启用自动聊后，客户消息会在这里生成可编辑的回复。</div>
          : (
            <div className="auto-chat-draft-list">
              {[...pendingDrafts, ...historyDrafts].map((draft) => <DraftRow key={draft.id} draft={draft} busy={sendDraft.isPending || dismissDraft.isPending} onSend={(body) => sendDraft.mutate({ id: draft.id, body })} onDismiss={() => dismissDraft.mutate(draft.id)} />)}
            </div>
          )}
      </section>

      {deleteCandidate && (
        <ConfirmModal
          title="删除训练档案"
          message={`确认删除「${deleteCandidate.name}」？`}
          consequences={["档案与其话术样板会被移除", "若自动聊正在使用该档案，会自动取消绑定"]}
          pending={removeMutation.isPending}
          onClose={() => setDeleteCandidate(null)}
          onConfirm={() => removeMutation.mutate(deleteCandidate.id)}
        />
      )}
    </div>
  );
}

/**
 * 训练库：自动回复的**专用语料库**（跨会话、跨账号复用的长期资产）。
 *
 * 与「训练档案」的分工是刻意的：档案是某一批聊天记录的风格快照（提供语气与语感），
 * 训练库是「客户这么问该怎么答」的内容本身。自动回复的检索顺序是**训练库优先、档案兜底**，
 * 所以库里的条目应当由人来确认——这里提供录入、导入、命中体检与导出四条通路。
 */
function TrainingLibrarySection({ accounts, profiles }: { accounts: ChannelAccount[]; profiles: TrainingProfile[] }) {
  const queryClient = useQueryClient();
  const libraryQuery = useQuery({ queryKey: queryKeys.trainingLibrary, queryFn: () => api.trainingLibrary() });
  const entries = libraryQuery.data ?? [];
  /**
   * 候选池单独取（`status=candidate`）。
   *
   * 默认列表与提示词同口径（只出 active），所以导入进来的样本在默认列表里**一条都看不到** ——
   * 不给它们单开一块，用户导完 45 条档案会以为「导入失败了」。
   */
  const candidatesQuery = useQuery({
    queryKey: queryKeys.trainingLibraryCandidates,
    queryFn: () => api.trainingLibrary({ status: "candidate" })
  });
  const candidates = candidatesQuery.data ?? [];

  const [kind, setKind] = useState<TrainingLibraryKind>("qa");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [priority, setPriority] = useState(100);
  const [scopeAccountId, setScopeAccountId] = useState("");
  const [importProfileId, setImportProfileId] = useState("");
  const [matchBody, setMatchBody] = useState("");
  const [notice, setNotice] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<TrainingLibraryEntry | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [candidateFilter, setCandidateFilter] = useState("");

  const kindMeta = libraryKinds.find((item) => item.value === kind) ?? libraryKinds[0];
  const kindLabel = (value: TrainingLibraryKind) => libraryKinds.find((item) => item.value === value)?.label ?? value;
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: queryKeys.trainingLibrary });
  const canSave = answer.trim().length > 0 && (kind !== "qa" || question.trim().length > 0);

  /** 服务端一次最多收 20 条（`/training/library/confirm` 的 zod 上限），界面按同一个数拦住。 */
  const MAX_CANDIDATE_BATCH = 20;
  const visibleCandidates = useMemo(() => {
    const keyword = candidateFilter.trim().toLowerCase();
    if (!keyword) return candidates;
    return candidates.filter((entry) =>
      `${entry.question}\n${entry.answer}\n${entry.tags.join(" ")}`.toLowerCase().includes(keyword)
    );
  }, [candidates, candidateFilter]);
  const allVisibleSelected = visibleCandidates.length > 0 && visibleCandidates.every((entry) => selectedCandidateIds.includes(entry.id));

  const toggleCandidate = (id: string) => {
    setSelectedCandidateIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= MAX_CANDIDATE_BATCH) {
        setNotice(`一次最多处理 ${MAX_CANDIDATE_BATCH} 条，先确认或丢弃已勾选的再继续`);
        return current;
      }
      return [...current, id];
    });
  };
  const toggleAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedCandidateIds((current) => current.filter((id) => !visibleCandidates.some((entry) => entry.id === id)));
      return;
    }
    setSelectedCandidateIds(visibleCandidates.slice(0, MAX_CANDIDATE_BATCH).map((entry) => entry.id));
    if (visibleCandidates.length > MAX_CANDIDATE_BATCH) {
      setNotice(`已勾选前 ${MAX_CANDIDATE_BATCH} 条（一次上限），处理完再继续`);
    }
  };

  /**
   * 死条目：建了 90 天、一次都没被命中过。它占着提示词预算却不产生价值，
   * 列表里给它排最前面并标出来，用户一眼能决定留还是清。
   */
  const STALE_ENTRY_MS = 90 * 86_400_000;
  const isStaleEntry = (entry: TrainingLibraryEntry) =>
    entry.hitCount === 0 && Date.now() - Date.parse(entry.createdAt) > STALE_ENTRY_MS;

  const createEntry = useMutation({
    mutationFn: () => api.saveTrainingLibraryEntry({
      kind,
      question: question.trim() || undefined,
      answer: answer.trim(),
      priority,
      accountId: scopeAccountId || null
    }),
    onSuccess: (entry) => {
      setQuestion("");
      setAnswer("");
      setNotice(`已入库：${entry.question || entry.answer.slice(0, 24)}`);
      invalidate();
    }
  });
  const toggleEntry = useMutation({
    mutationFn: (entry: TrainingLibraryEntry) => api.updateTrainingLibraryEntry(entry.id, {
      kind: entry.kind,
      question: entry.question || undefined,
      answer: entry.answer,
      priority: entry.priority,
      accountId: entry.accountId,
      enabled: !entry.enabled
    }),
    onSuccess: invalidate
  });
  const removeEntry = useMutation({
    mutationFn: api.deleteTrainingLibraryEntry,
    onSuccess: () => {
      setDeleteCandidate(null);
      invalidate();
    }
  });
  const importFromProfile = useMutation({
    mutationFn: () => api.importTrainingLibrary(importProfileId),
    onSuccess: (result) => {
      setNotice(
        result.created > 0
          ? `导入完成：${result.created} 条进了候选池（确认后才进提示词），${result.skipped} 条已存在或清洗时被剔除`
          : `没有新增：${result.skipped} 条已存在或清洗时被剔除（共 ${result.total} 条样本）`
      );
      invalidate();
    }
  });
  /** 候选确认 / 丢弃：一次一份名单，走同一个接口（见 server/app.ts 的 /training/library/confirm）。 */
  const reviewCandidates = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: "confirm" | "drop" }) =>
      api.reviewTrainingLibraryCandidates(ids, action),
    onSuccess: (result, variables) => {
      setSelectedCandidateIds([]);
      setNotice(
        variables.action === "confirm"
          ? `已确认 ${result.changed} 条，自动回复从下一条消息起会用到它们`
          : `已丢弃 ${result.changed} 条（留档，不会再被导入加回来）`
      );
      invalidate();
    }
  });
  const matchMutation = useMutation({ mutationFn: () => api.matchTrainingLibrary({ body: matchBody.trim(), accountId: scopeAccountId || undefined }) });
  const exportMutation = useMutation({
    mutationFn: api.exportTrainingLibraryMarkdown,
    onSuccess: (content) => download("training-library.md", content)
  });

  // 死条目置顶：先把「90 天没被用过」的挑到组内最前面，其余按更新时间倒序 ——
  // 否则它们会永远沉在几百条下面，谁都看不见。
  const grouped = libraryKinds.map((item) => ({
    meta: item,
    items: entries
      .filter((entry) => entry.kind === item.value)
      .sort((left, right) => {
        const staleDiff = Number(isStaleEntry(right)) - Number(isStaleEntry(left));
        return staleDiff !== 0 ? staleDiff : Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      })
  }));
  const accountName = (id: string | null) => (id ? accounts.find((account) => account.id === id)?.name ?? "已删除账号" : "全部账号");
  const match = matchMutation.data;

  return (
    <section className="settings-section training-library">
      <header>
        <Library size={18} />
        <div>
          <h2>自动回复训练库</h2>
          <p>专门喂给自动回复的语料库：标准问答对 / 口径片段 / 政策 / 禁用场景。自动回复<strong>先用这里的口径，档案只做语感兜底</strong>。</p>
        </div>
        <span className="run-health">
          {entries.length} 条生效中{candidates.length > 0 ? ` · ${candidates.length} 条待确认` : ""}
        </span>
      </header>

      <div className="library-form">
        <div className="library-kind-options">
          {libraryKinds.map((item) => (
            <button key={item.value} type="button" data-kind={item.value} className={`library-kind ${kind === item.value ? "is-active" : ""}`} onClick={() => setKind(item.value)}>
              <strong>{item.label}<em>{entries.filter((entry) => entry.kind === item.value).length}</em></strong>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>
        <div className="settings-fields library-fields">
          <label className="library-wide"><span>{kindMeta.questionLabel}</span>
            <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder={kindMeta.questionPlaceholder} />
          </label>
          <label className="library-wide"><span>{kindMeta.answerLabel}</span>
            <textarea rows={3} value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={kindMeta.answerPlaceholder} />
          </label>
          <label><span>适用账号</span>
            <select value={scopeAccountId} onChange={(event) => setScopeAccountId(event.target.value)}>
              <option value="">全部账号（通用）</option>
              {accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
            <small>选某账号时，这条只在那个账号收到消息时生效。</small>
          </label>
          <label><span>优先级（越大越靠前）</span>
            <input type="number" min={0} max={1000} value={priority} onChange={(event) => setPriority(Number(event.target.value))} />
            <small>相似度相同时，优先级高的先被选中。</small>
          </label>
        </div>
        <div className="training-actions">
          <button className="button primary" type="button" disabled={!canSave || createEntry.isPending} onClick={() => createEntry.mutate()}>
            {createEntry.isPending ? <Spinner /> : <Plus size={16} />} 入库
          </button>
          <span className="training-hint">同一条问答（问法与答法都一样）不会重复入库；重复提交只会提示已存在。</span>
        </div>
        {createEntry.error && <div className="notice error-notice"><AlertTriangle size={16} /><span>{createEntry.error.message}</span></div>}
        {notice && <div className="notice success-notice"><CheckCircle2 size={16} /><span>{notice}</span></div>}
      </div>

      <div className="library-tools">
        <div className="library-tool">
          <div className="library-tool-head"><Upload size={15} /><strong>从训练档案导入</strong></div>
          <p>把某份档案的问答样板与护栏一次性搬进训练库（重复的自动跳过）。档案是一次性快照，入库后才好维护。</p>
          <div className="library-tool-row">
            <select value={importProfileId} onChange={(event) => setImportProfileId(event.target.value)}>
              <option value="">请选择训练档案</option>
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.examples.length} 组样板</option>)}
            </select>
            <button className="button compact" type="button" disabled={!importProfileId || importFromProfile.isPending} onClick={() => importFromProfile.mutate()}>
              {importFromProfile.isPending ? <Spinner /> : <Upload size={14} />} 导入
            </button>
          </div>
          {profiles.length === 0 && <small>还没有可用档案，先在第 2 步训练一份。</small>}
          {importFromProfile.error && <div className="notice error-notice"><AlertTriangle size={16} /><span>{importFromProfile.error.message}</span></div>}
        </div>
        <div className="library-tool">
          <div className="library-tool-head"><Download size={15} /><strong>导出知识包</strong></div>
          <p>导出一份 Markdown：政策 → 禁用语 → 问答对 → 口径片段。可以直接交付给别人，也能当技能素材。</p>
          <div className="library-tool-row">
            <button className="button compact" type="button" disabled={!entries.length || exportMutation.isPending} onClick={() => exportMutation.mutate()}>
              {exportMutation.isPending ? <Spinner /> : <Download size={14} />} 导出 .md
            </button>
          </div>
          {exportMutation.error && <div className="notice error-notice"><AlertTriangle size={16} /><span>{exportMutation.error.message}</span></div>}
        </div>
      </div>

      {candidates.length > 0 && (
        <div className="library-candidates">
          <div className="library-tool-head">
            <ListChecks size={15} />
            <strong>候选确认</strong>
            <span className="library-candidates-count">{candidates.length} 条待确认</span>
          </div>
          <p>
            这些是机器从训练档案里抽出来的样本，<strong>还没进提示词</strong>。机器只做能判定对错的机械减法
            （剔行首时间戳、附件名与体积、站内系统短语、纯占位、被截断的半句话），判断留给人：
            确认后自动回复才会用它们，丢弃则留档、不会被下次导入又加回来。
          </p>
          <div className="library-tool-row">
            <input
              value={candidateFilter}
              onChange={(event) => setCandidateFilter(event.target.value)}
              placeholder="按问法 / 答法 / 标签筛选"
            />
            <button className="button compact" type="button" disabled={!visibleCandidates.length} onClick={toggleAllVisible}>
              {allVisibleSelected ? "取消全选" : `全选前 ${Math.min(visibleCandidates.length, MAX_CANDIDATE_BATCH)} 条`}
            </button>
          </div>
          <div className="library-candidate-list">
            {visibleCandidates.map((entry) => (
              <article className={`library-candidate ${selectedCandidateIds.includes(entry.id) ? "is-selected" : ""}`} key={entry.id}>
                <label className="library-candidate-pick">
                  <input type="checkbox" checked={selectedCandidateIds.includes(entry.id)} onChange={() => toggleCandidate(entry.id)} />
                  <span className="library-candidate-kind">{kindLabel(entry.kind)}</span>
                </label>
                <div className="library-candidate-body">
                  {entry.question && <p className="is-customer">{entry.question}</p>}
                  <p className="is-agent">{entry.answer}</p>
                  <div className="library-candidate-meta">
                    {entry.tags.map((tag) => <span className="library-entry-scope" key={tag}>{tag}</span>)}
                  </div>
                </div>
                <div className="library-candidate-actions">
                  <button className="button compact" type="button" disabled={reviewCandidates.isPending} onClick={() => reviewCandidates.mutate({ ids: [entry.id], action: "confirm" })}>确认</button>
                  <button className="button compact" type="button" disabled={reviewCandidates.isPending} onClick={() => reviewCandidates.mutate({ ids: [entry.id], action: "drop" })}>丢弃</button>
                </div>
              </article>
            ))}
            {visibleCandidates.length === 0 && <small>没有匹配的候选，换个关键词试试。</small>}
          </div>
          <div className="library-candidate-batch">
            <button className="button primary" type="button" disabled={!selectedCandidateIds.length || reviewCandidates.isPending} onClick={() => reviewCandidates.mutate({ ids: selectedCandidateIds, action: "confirm" })}>
              {reviewCandidates.isPending ? <Spinner /> : <Check size={15} />} 确认选中 {selectedCandidateIds.length} 条
            </button>
            <button className="button compact" type="button" disabled={!selectedCandidateIds.length || reviewCandidates.isPending} onClick={() => reviewCandidates.mutate({ ids: selectedCandidateIds, action: "drop" })}>
              丢弃选中
            </button>
            <small>一次最多 {MAX_CANDIDATE_BATCH} 条；候选在确认前不参与检索。</small>
          </div>
          {reviewCandidates.error && <div className="notice error-notice"><AlertTriangle size={16} /><span>{reviewCandidates.error.message}</span></div>}
        </div>
      )}

      <div className="library-match">
        <div className="library-tool-head"><Search size={15} /><strong>命中体检</strong></div>
        <p>粘贴一句客户会说的话，看看自动回复实际会用到库里哪几条——不用真的发消息，调库最快的方式。</p>
        <div className="library-tool-row">
          <input value={matchBody} onChange={(event) => setMatchBody(event.target.value)} placeholder="例如：What is your minimum order quantity?" />
          <button className="button compact" type="button" disabled={!matchBody.trim() || matchMutation.isPending} onClick={() => matchMutation.mutate()}>
            {matchMutation.isPending ? <Spinner /> : <Search size={14} />} 试一下
          </button>
        </div>
        {matchMutation.error && <div className="notice error-notice"><AlertTriangle size={16} /><span>{matchMutation.error.message}</span></div>}
        {match && (
          <div className="library-match-result">
            <span className="library-match-verdict">{match.verdict}</span>
            {match.forbidden.length > 0 && (
              <div className="notice error-notice"><AlertTriangle size={16} /><span>命中禁用场景「{match.forbidden[0].entry.question}」：这条不会生成回复，直接转人工。</span></div>
            )}
            {match.hits.map((hit) => (
              <div className="library-match-row" key={hit.entry.id}>
                <span className="library-match-score">{hit.similarity.toFixed(2)}</span>
                <div><p className="is-customer">{hit.entry.question}</p><p className="is-agent">{hit.entry.answer}</p></div>
              </div>
            ))}
            {match.hits.length === 0 && <small>没有相近问法：这条要靠人工回复，把它补进库下次就能自动回。</small>}
            {match.snippets.length > 0 && <small>另有 {match.snippets.length} 条口径片段、{match.policies.length} 条政策会随提示词一起给模型。</small>}
          </div>
        )}
      </div>

      {libraryQuery.isLoading && <div className="center-loading"><Spinner /> 加载训练库</div>}
      {!libraryQuery.isLoading && entries.length === 0 && candidates.length === 0 && (
        <EmptyState icon={<Library size={22} />} title="训练库还是空的" description="自动回复在没有相近问法时只能留草稿；先把最常见的几个问法补进来。" />
      )}
      {!libraryQuery.isLoading && entries.length === 0 && candidates.length > 0 && (
        <div className="notice"><ListChecks size={16} /><span>还没有生效的条目：{candidates.length} 条候选在上面的「候选确认」区里，确认后才会进提示词。</span></div>
      )}
      {grouped.filter((group) => group.items.length > 0).map((group) => (
        <div className="library-group" data-kind={group.meta.value} key={group.meta.value}>
          <div className="library-group-head"><BookOpen size={14} /><strong>{group.meta.label}</strong><span>{group.items.length}</span></div>
          <div className="library-entry-list">
            {group.items.map((entry) => (
              <article className={`library-entry ${entry.enabled ? "" : "is-disabled"}`} data-kind={entry.kind} key={entry.id}>
                <header>
                  <div className="library-entry-title">
                    {entry.question && <strong>{entry.question}</strong>}
                    <span className={`library-entry-source is-${entry.source}`}>{entry.source === "profile" ? "导入自档案" : entry.source === "conversation" ? "来自会话" : "手工录入"}</span>
                    <span className="library-entry-scope">{accountName(entry.accountId)}</span>
                    {entry.priority !== 100 && <span className="library-entry-scope">优先级 {entry.priority}</span>}
                    {!entry.enabled && <span className="library-entry-source is-off">已停用</span>}
                    {isStaleEntry(entry) && <span className="library-entry-source is-stale">建了 90 天没被用过，建议清理</span>}
                  </div>
                  <div className="library-entry-actions">
                    <button className="button compact" type="button" disabled={toggleEntry.isPending} onClick={() => toggleEntry.mutate(entry)}>{entry.enabled ? "停用" : "启用"}</button>
                    <button className="icon-button danger" type="button" title="删除条目" aria-label={`删除 ${entry.question || entry.answer.slice(0, 12)}`} disabled={removeEntry.isPending} onClick={() => setDeleteCandidate(entry)}><Trash2 size={16} /></button>
                  </div>
                </header>
                <p className="library-entry-answer">{entry.answer}</p>
                <footer>
                  <span>命中 {formatNumber(entry.hitCount)} 次</span>
                  <span>更新于 {formatTime(entry.updatedAt)}</span>
                </footer>
              </article>
            ))}
          </div>
        </div>
      ))}

      {deleteCandidate && (
        <ConfirmModal
          title="删除训练库条目"
          message={`确认删除「${deleteCandidate.question || deleteCandidate.answer.slice(0, 24)}」？`}
          consequences={["删除后自动回复不再使用这条口径", "该条命中历史一并移除"]}
          pending={removeEntry.isPending}
          onClose={() => setDeleteCandidate(null)}
          onConfirm={() => removeEntry.mutate(deleteCandidate.id)}
        />
      )}
    </section>
  );
}

function DraftRow({ draft, busy, onSend, onDismiss }: {
  draft: AutoChatDraft;
  busy: boolean;
  onSend(body: string): void;
  onDismiss(): void;
}) {
  const [body, setBody] = useState(draft.body);
  const editable = draft.status === "pending" || draft.status === "failed";
  return (
    <article className={`auto-chat-draft is-${draft.status}`}>
      <header>
        <div className="auto-chat-draft-who">
          <strong>{draft.contactName || draft.contactPhone || "未知联系人"}</strong>
          <span className={`auto-chat-draft-status is-${draft.status}`}>{draftStatusLabels[draft.status]}</span>
          {draft.engine === "ai" && <span className="auto-chat-draft-engine">AI{draft.model ? ` · ${draft.model}` : ""}</span>}
          {draft.engine === "cli" && <span className="auto-chat-draft-engine is-cli"><Terminal size={11} /> CLI{draft.model ? ` · ${draft.model}` : ""}</span>}
          {draft.engine === "rules" && <span className="auto-chat-draft-engine is-rules">话术库</span>}
          {draft.edited && <span className="auto-chat-draft-edited">已人工编辑</span>}
        </div>
        <time>{formatTime(draft.sentAt ?? draft.createdAt)}</time>
      </header>
      <p className="auto-chat-draft-inbound"><span>客户</span>{draft.inboundBody}</p>
      {editable
        ? <textarea value={body} rows={3} onChange={(event) => setBody(event.target.value)} placeholder="起草内容（可留空表示不回复）" />
        : <p className="auto-chat-draft-body"><span>回复</span>{draft.body || "（无内容）"}</p>}
      <footer>
        <span className="auto-chat-draft-reason" title={draft.reason}>{draft.reason}</span>
        {editable && (
          <div className="auto-chat-draft-actions">
            <button className="button compact" type="button" disabled={busy} onClick={onDismiss}><X size={14} /> 忽略</button>
            <button className="button compact primary" type="button" disabled={busy || !body.trim()} onClick={() => onSend(body)}><Send size={14} /> 发送</button>
          </div>
        )}
      </footer>
    </article>
  );
}

export default TrainingPage;
