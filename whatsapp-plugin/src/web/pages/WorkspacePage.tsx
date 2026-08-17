import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Bot,
  CalendarClock,
  Check,
  CheckCheck,
  CheckCircle2,
  CircleAlert,
  ClipboardPlus,
  ContactRound,
  Download,
  EyeOff,
  File as FileIcon,
  FileText,
  History,
  Image as ImageIcon,
  Languages,
  MessageCirclePlus,
  MessageSquareText,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Plus,
  RotateCcw,
  Search,
  Send,
  Settings,
  Sparkles,
  PhoneCall,
  Undo2,
  UserPlus,
  Video,
  X
} from "lucide-react";
import type { ChannelAccount, ChatMessage, Conversation, ConversationAnalysis, ConversationFollowUp } from "@shared/types";
import { api, type ConversationIntelligenceSnapshot, type CrmCustomerSnapshot, type CrmTodoSnapshot } from "../api";
import { queryKeys, useAccounts, useCapabilities } from "../data";
import { EmptyState, Modal, Spinner, StatusBadge } from "../components/ui";

interface Props {
  selectedAccountId?: string;
  requestedConversationId?: string;
  onRequestedConversationHandled?(): void;
  onSelectAccount(id: string): void;
  onManageAccounts(): void;
}

function formatDueAt(value: string): string {
  if (!value) return "未安排时间";
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return value;
  const delta = due.getTime() - Date.now();
  const hours = Math.ceil(Math.abs(delta) / 3_600_000);
  const relative = delta < 0 ? `已逾期 ${hours} 小时` : hours < 24 ? `${hours} 小时内` : `${Math.ceil(hours / 24)} 天内`;
  return `${relative} · ${due.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

export function WorkspacePage({ selectedAccountId, requestedConversationId, onRequestedConversationHandled, onSelectAccount, onManageAccounts }: Props) {
  const queryClient = useQueryClient();
  const accountsQuery = useAccounts();
  const capabilitiesQuery = useCapabilities();
  const [selectedConversationId, setSelectedConversationId] = useState<string>();
  const [search, setSearch] = useState("");
  const [showSimulator, setShowSimulator] = useState(false);
  const [mobileListOpen, setMobileListOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const requestedConversationIdRef = useRef(requestedConversationId);
  requestedConversationIdRef.current = requestedConversationId;

  const conversationsQuery = useQuery({
    queryKey: queryKeys.conversations(selectedAccountId),
    queryFn: () => api.conversations(selectedAccountId),
    enabled: Boolean(selectedAccountId)
  });
  const preferenceQuery = useQuery({ queryKey: queryKeys.preference, queryFn: api.translationPreference });
  const messagesQuery = useQuery({
    queryKey: queryKeys.messages(selectedConversationId),
    queryFn: () => api.messages(selectedConversationId!),
    enabled: Boolean(selectedConversationId),
    refetchInterval: 15_000
  });
  const intelligenceQuery = useQuery({
    queryKey: queryKeys.intelligence(selectedConversationId),
    queryFn: () => api.conversationIntelligence(selectedConversationId!),
    enabled: Boolean(selectedConversationId)
  });
  const contactsQuery = useQuery({ queryKey: queryKeys.contacts(selectedAccountId), queryFn: () => api.contacts(selectedAccountId), enabled: Boolean(selectedAccountId) });
  const crmCustomersQuery = useQuery({ queryKey: queryKeys.crmCustomers, queryFn: api.crmCustomers, enabled: Boolean(selectedConversationId), staleTime: 30_000 });
  const crmTodosQuery = useQuery({ queryKey: queryKeys.crmTodos, queryFn: api.crmTodos, enabled: Boolean(selectedConversationId), staleTime: 15_000 });

  useEffect(() => {
    const conversations = conversationsQuery.data ?? [];
    const requestedConversation = requestedConversationId
      ? conversations.find((item) => item.id === requestedConversationId)
      : undefined;
    if (requestedConversation) {
      setSelectedConversationId(requestedConversation.id);
      setMobileListOpen(false);
      onRequestedConversationHandled?.();
      return;
    }
    if (!selectedConversationId || !conversations.some((item) => item.id === selectedConversationId)) {
      setSelectedConversationId(conversations[0]?.id);
    }
  }, [conversationsQuery.data, onRequestedConversationHandled, requestedConversationId, selectedConversationId]);

  useEffect(() => {
    if (!requestedConversationIdRef.current) setMobileListOpen(true);
  }, [selectedAccountId]);

  useEffect(() => setInspectorOpen(false), [selectedAccountId, selectedConversationId]);

  const accounts = accountsQuery.data ?? [];
  const hasDemoAccount = Boolean(capabilitiesQuery.data?.demoProviderEnabled) && accounts.some((account) => account.provider === "demo");
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const selectedConversation = conversationsQuery.data?.find((item) => item.id === selectedConversationId);
  const selectedContact = contactsQuery.data?.find((item) => item.id === selectedConversation?.contactId);
  const crmCustomer = crmCustomersQuery.data?.find((item) => item.id === selectedContact?.crmContactId || item.whatsapp === selectedConversation?.contactPhone);
  const customerTodos = crmTodosQuery.data?.filter((item) => !item.done && (item.customerId === crmCustomer?.id || (!item.customerId && crmCustomer && item.related?.includes(crmCustomer.company)))).sort((left, right) => left.dueAt.localeCompare(right.dueAt)).slice(0, 4) ?? [];
  const filteredConversations = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (conversationsQuery.data ?? []).filter(
      (item) => !needle || item.contactName.toLowerCase().includes(needle) || item.contactPhone.includes(needle) || item.lastMessage?.toLowerCase().includes(needle)
    );
  }, [conversationsQuery.data, search]);

  const createCrm = useMutation({
    mutationFn: api.createCrmContact,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["contacts"] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.crmContacts });
    }
  });
  const analyzeConversation = useMutation({
    mutationFn: () => api.analyzeConversation(selectedConversationId!),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.intelligence(selectedConversationId) })
  });
  const updateFollowup = useMutation({
    mutationFn: async ({ id, status, crmTodoId }: { id: string; status: ConversationFollowUp["status"]; crmTodoId?: string }) => {
      if (status === "completed" && crmTodoId) await api.completeCrmTodo(crmTodoId);
      return api.updateFollowup(id, status);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.intelligence(selectedConversationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.crmTodos });
    }
  });
  const createGoodJobTodo = useMutation({
    mutationFn: (followup: ConversationFollowUp) => api.createGoodJobTodo({
      title: followup.title,
      priority: followup.priority,
      dueAt: followup.dueAt,
      related: `WhatsApp ${selectedConversation?.contactPhone ?? ""}：${followup.reason}`,
      customerId: crmCustomer?.id,
      triggerKey: crmCustomer ? `whatsapp-insight:${crmCustomer.id}:${followup.id}` : undefined
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.crmTodos });
    }
  });

  return (
    <div className={`workspace ${selectedConversation ? "has-conversation" : ""} ${mobileListOpen ? "mobile-list-open" : ""}`}>
      <AccountRail accounts={accounts} selectedAccountId={selectedAccountId} onSelect={onSelectAccount} onManage={onManageAccounts} />
      <div className="mobile-account-select">
        <select value={selectedAccountId ?? ""} onChange={(event) => onSelectAccount(event.target.value)}>
          {accounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.status === "connected" ? "在线" : "离线"}</option>)}
        </select>
        <button className="icon-button" title="管理账号" onClick={onManageAccounts}><Settings size={17} /></button>
      </div>

      <aside className="conversation-pane">
        <div className="pane-header">
          <div><h2>会话</h2><span>{filteredConversations.length} 个客户</span></div>
          {capabilitiesQuery.data?.demoProviderEnabled && selectedAccount?.provider === "demo" && <button className="icon-button" title="模拟客户发来消息" onClick={() => setShowSimulator(true)}><MessageCirclePlus size={18} /></button>}
        </div>
        <div className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索姓名、号码或消息" /></div>
        <div className="conversation-list">
          {conversationsQuery.isLoading ? <div className="center-loading"><Spinner /> 加载会话</div> : filteredConversations.length === 0 ? (
            <EmptyState
              icon={<MessageSquareText size={22} />}
              title="暂无会话"
              description={hasDemoAccount ? "同步联系人或使用 Demo 入站消息开始测试。" : "同步联系人或从联系人页发起消息后，会话将显示在这里。"}
            />
          ) : filteredConversations.map((conversation) => (
            <ConversationRow key={conversation.id} conversation={conversation} selected={conversation.id === selectedConversationId} onClick={() => { setSelectedConversationId(conversation.id); setMobileListOpen(false); setInspectorOpen(true); }} />
          ))}
        </div>
      </aside>

      <section className="chat-pane">
        {!selectedConversation || !selectedAccount ? (
          <EmptyState icon={<MessageSquareText size={26} />} title="选择一条会话" description="账号和会话永久绑定，发送时不会使用其他账号替代。" />
        ) : (
          <>
            <header className="chat-header">
              <button className="icon-button mobile-back" title="返回会话列表" onClick={() => setMobileListOpen(true)}><ArrowLeft size={18} /></button>
              <span className="avatar">{selectedConversation.contactName.slice(0, 2)}</span>
              <div className="chat-title"><strong>{selectedConversation.contactName}</strong><span>{selectedConversation.contactPhone}</span></div>
              <div className="sending-identity"><span className={`status-dot status-${selectedAccount.status}`} /><div><small>发送账号</small><strong>{selectedAccount.name}</strong></div></div>
              <button
                type="button"
                className="icon-button inspector-toggle"
                title="查看客户详情"
                aria-label="查看客户详情"
                aria-controls="conversation-inspector"
                aria-expanded={inspectorOpen}
                onClick={() => setInspectorOpen(true)}
              >
                <PanelRight size={18} />
              </button>
            </header>
            <MessageList
              account={selectedAccount}
              messages={messagesQuery.data ?? []}
              loading={messagesQuery.isLoading}
              autoTranslate={preferenceQuery.data?.autoTranslate ?? false}
              targetLanguage={preferenceQuery.data?.targetLanguage ?? "zh-CN"}
              providerId={preferenceQuery.data?.providerId ?? undefined}
              onTranslated={() => void queryClient.invalidateQueries({ queryKey: queryKeys.messages(selectedConversation.id) })}
              onRevoked={() => {
                void queryClient.invalidateQueries({ queryKey: queryKeys.messages(selectedConversation.id) });
                void queryClient.invalidateQueries({ queryKey: queryKeys.conversations(selectedAccount.id) });
              }}
            />
            <Composer account={selectedAccount} conversation={selectedConversation} providerEnabled={selectedAccount.provider !== "demo" || Boolean(capabilitiesQuery.data?.demoProviderEnabled)} onSent={() => {
              void queryClient.invalidateQueries({ queryKey: queryKeys.messages(selectedConversation.id) });
              void queryClient.invalidateQueries({ queryKey: queryKeys.conversations(selectedAccount.id) });
            }} />
          </>
        )}
      </section>

      {inspectorOpen && <button type="button" className="inspector-backdrop" aria-label="关闭客户详情" onClick={() => setInspectorOpen(false)} />}
      <aside id="conversation-inspector" className={`inspector-pane ${inspectorOpen ? "is-open" : ""}`}>
        <InspectorContent
          conversation={selectedConversation}
          account={selectedAccount}
          crmContactId={selectedContact?.crmContactId}
          canCreateCrm={Boolean(selectedContact)}
          creatingCrm={createCrm.isPending}
          autoTranslate={preferenceQuery.data?.autoTranslate ?? false}
          targetLanguage={preferenceQuery.data?.targetLanguage ?? "zh-CN"}
          intelligence={intelligenceQuery.data}
          messages={messagesQuery.data ?? []}
          analyzing={analyzeConversation.isPending}
          onAnalyze={() => analyzeConversation.mutate()}
          onUpdateFollowup={(id, status, crmTodoId) => updateFollowup.mutate({ id, status, crmTodoId })}
          followupUpdateError={updateFollowup.error?.message}
          creatingGoodJobTodo={createGoodJobTodo.isPending}
          onCreateGoodJobTodo={(followup) => createGoodJobTodo.mutate(followup)}
          onCreateCrm={() => selectedContact && createCrm.mutate(selectedContact.id)}
          crmCustomer={crmCustomer}
          customerTodos={customerTodos}
          onRefreshCrm={() => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.crmCustomers });
            void queryClient.invalidateQueries({ queryKey: queryKeys.crmTodos });
          }}
          onClose={() => setInspectorOpen(false)}
        />
      </aside>

      {showSimulator && selectedAccount && <SimulatorModal account={selectedAccount} onClose={() => setShowSimulator(false)} onCreated={() => { setShowSimulator(false); void queryClient.invalidateQueries({ queryKey: ["conversations"] }); void queryClient.invalidateQueries({ queryKey: ["messages"] }); }} />}
    </div>
  );
}

function InspectorContent({
  conversation,
  account,
  crmContactId,
  canCreateCrm,
  creatingCrm,
  autoTranslate,
  targetLanguage,
  intelligence,
  messages,
  analyzing,
  onAnalyze,
  onUpdateFollowup,
  followupUpdateError,
  creatingGoodJobTodo,
  onCreateGoodJobTodo,
  onCreateCrm,
  crmCustomer,
  customerTodos,
  onRefreshCrm,
  onClose
}: {
  conversation?: Conversation;
  account?: ChannelAccount;
  crmContactId?: string | null;
  canCreateCrm: boolean;
  creatingCrm: boolean;
  autoTranslate: boolean;
  targetLanguage: string;
  intelligence?: ConversationIntelligenceSnapshot;
  messages: ChatMessage[];
  analyzing: boolean;
  onAnalyze(): void;
  onUpdateFollowup(id: string, status: ConversationFollowUp["status"], crmTodoId?: string): void;
  followupUpdateError?: string;
  creatingGoodJobTodo: boolean;
  onCreateGoodJobTodo(followup: ConversationFollowUp): void;
  onCreateCrm(): void;
  crmCustomer?: CrmCustomerSnapshot;
  customerTodos: CrmTodoSnapshot[];
  onRefreshCrm(): void;
  onClose(): void;
}) {
  const queryClient = useQueryClient();
  const [showActivityForm, setShowActivityForm] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [evidenceTrait, setEvidenceTrait] = useState<ConversationAnalysis["traits"][number] | null>(null);
  useEffect(() => {
    setEvidenceTrait(null);
    setFeedback(null);
  }, [conversation?.id]);
  const addActivity = useMutation({
    mutationFn: (input: { type: "call" | "email" | "whatsapp" | "wechat" | "meeting" | "note"; content: string; nextReminder?: string }) => api.createCustomerActivity(crmCustomer!.id, input),
    onSuccess: () => {
      setShowActivityForm(false);
      setFeedback("客户互动和下一次跟进已写入 CRM。");
      onRefreshCrm();
    }
  });
  const saveTraitFeedback = useMutation({
    mutationFn: ({ trait, verdict }: { trait: ConversationAnalysis["traits"][number]; verdict: "confirmed" | "rejected" }) =>
      api.saveTraitFeedback(conversation!.id, { traitKey: trait.key, traitLabel: trait.label, verdict }),
    onSuccess: (result, variables) => {
      queryClient.setQueryData(queryKeys.intelligence(conversation?.id), result);
      setEvidenceTrait(null);
      setFeedback(variables.verdict === "confirmed" ? `“${variables.trait.label}”已确认，后续分析会保留这项判断。` : `“${variables.trait.label}”已忽略，关联的待跟进建议已同步撤下。`);
    }
  });
  const restoreTraitFeedback = useMutation({
    mutationFn: (traitKey: string) => api.deleteTraitFeedback(conversation!.id, traitKey),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.intelligence(conversation?.id), result);
      setFeedback("已恢复该特点，系统已根据原始聊天证据重新生成分析。");
    }
  });
  const submitActivity = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    addActivity.mutate({
      type: String(form.get("type")) as "call" | "email" | "whatsapp" | "wechat" | "meeting" | "note",
      content: String(form.get("content")),
      nextReminder: String(form.get("nextReminder"))
    });
  };
  const intelligenceFollowups = Array.isArray(intelligence?.followups) ? intelligence.followups : [];
  const intelligenceFeedback = Array.isArray(intelligence?.feedback) ? intelligence.feedback : [];
  const pendingFollowups = intelligenceFollowups.filter((item) => item.status === "pending");
  const recentActivities = crmCustomer?.activities?.slice(0, 4) ?? [];
  const confirmedTraitKeys = new Set(intelligenceFeedback.filter((item) => item.verdict === "confirmed").map((item) => item.traitKey));
  const rejectedTraits = intelligenceFeedback.filter((item) => item.verdict === "rejected");
  const evidenceFeedback = evidenceTrait ? intelligenceFeedback.find((item) => item.traitKey === evidenceTrait.key) : undefined;
  const todoForFollowup = (followup: ConversationFollowUp) => customerTodos.find((todo) => todo.triggerKey === `whatsapp-insight:${crmCustomer?.id}:${followup.id}` || (todo.title === followup.title && (todo.related || "").includes("WhatsApp")));
  return (
    <>
      <div className="inspector-drawer-header">
        <h2>客户详情</h2>
        <button type="button" className="icon-button" title="关闭客户详情" aria-label="关闭客户详情" onClick={onClose}><X size={18} /></button>
      </div>
      {conversation && account ? (
        <>
          <div className="inspector-profile"><span className="avatar large">{conversation.contactName.slice(0, 2)}</span><h3>{conversation.contactName}</h3><span>{conversation.contactPhone}</span>{crmCustomer && <div className="profile-chips"><span>{crmCustomer.grade || "C"} 级客户</span><span>{crmCustomer.pipelineStage || crmCustomer.stage || "待识别阶段"}</span></div>}</div>
          <div className="customer-command-card">
            <div><span>现在最重要</span><strong>{intelligence?.analysis?.nextAction || customerTodos[0]?.title || "先生成客户分析，确认下一步行动"}</strong></div>
            <span className={`urgency-pill ${intelligence?.analysis?.riskLevel === "high" ? "is-high" : ""}`}>{intelligence?.analysis?.riskLevel === "high" ? "高风险" : pendingFollowups.length ? `${pendingFollowups.length} 项待跟进` : "节奏正常"}</span>
          </div>
          {feedback && <div className="inspector-feedback" role="status"><Check size={14} />{feedback}</div>}
          <div className="inspector-section crm-overview-section">
            <div className="section-action-title"><h4>CRM 客户概览</h4>{crmCustomer && <button className="button compact" onClick={() => setShowActivityForm((value) => !value)}><Plus size={14} /> 记录互动</button>}</div>
            {crmCustomer ? <>
              <div className="crm-metric-grid"><div><span>健康度</span><strong>{crmCustomer.health ?? "--"}<small>/100</small></strong></div><div><span>活跃商机</span><strong>{crmCustomer.activeDealCount ?? 0}<small> 个</small></strong></div><div><span>管道金额</span><strong>${Math.round((crmCustomer.pipelineAmount ?? 0) / 1000)}k</strong></div></div>
              <dl className="detail-list compact-details"><div><dt>公司</dt><dd>{crmCustomer.company}</dd></div><div><dt>负责人</dt><dd>{crmCustomer.ownerName || "未分配"}</dd></div><div><dt>下一提醒</dt><dd>{crmCustomer.nextReminder || "尚未安排"}</dd></div></dl>
              {showActivityForm && <form className="activity-quick-form" onSubmit={submitActivity}><div className="form-grid two"><label><span>互动类型</span><select name="type" defaultValue="meeting"><option value="meeting">会议</option><option value="call">电话</option><option value="whatsapp">WhatsApp</option><option value="email">邮件</option><option value="note">备注</option></select></label><label><span>下次跟进</span><input name="nextReminder" type="datetime-local" /></label></div><label><span>结果与约定</span><textarea name="content" required rows={3} placeholder="例如：客户确认周四 15:00 评审报价，需提前发送规格对照表。" /></label><div className="activity-form-actions"><button type="button" className="button compact secondary" onClick={() => setShowActivityForm(false)}>取消</button><button className="button compact primary" disabled={addActivity.isPending}>{addActivity.isPending ? <Spinner /> : <Check size={14} />} 保存到 CRM</button></div>{addActivity.error && <span className="error-text">{addActivity.error.message}</span>}</form>}
            </> : crmContactId ? <div className="analysis-empty"><span>联系人已关联，但当前账号无权读取该 CRM 客户详情。</span></div> : <button className="button secondary full" disabled={!canCreateCrm || creatingCrm} onClick={onCreateCrm}>{creatingCrm ? <Spinner /> : <UserPlus size={16} />} 创建并关联 CRM 客户</button>}
          </div>
          <div className="inspector-section intelligence-section">
            <div className="section-action-title"><h4>客户特点与决策信号</h4><button className="icon-button" title="重新分析客户" onClick={onAnalyze} disabled={analyzing}>{analyzing ? <Spinner /> : <Sparkles size={15} />}</button></div>
            {intelligence?.analysis ? <>
              <p className="analysis-summary">{intelligence.analysis.summary}</p>
              <div className={`analysis-engine ${intelligence.analysis.engine}`}><Sparkles size={12} /><span>{intelligence.analysis.engine === "ai" ? `AI 深度分析 · ${intelligence.analysis.model ?? "已配置模型"}` : "规则识别"}</span><small>{intelligence.analysis.promptVersion}</small></div>
              {intelligence.analysis.error && <div className="analysis-warning"><CircleAlert size={13} />{intelligence.analysis.error}</div>}
              <div className="analysis-metrics"><span>意向 <strong>{intelligence.analysis.buyingIntent === "high" ? "高" : intelligence.analysis.buyingIntent === "medium" ? "中" : "低"}</strong></span><span>风险 <strong>{intelligence.analysis.riskLevel === "high" ? "高" : intelligence.analysis.riskLevel === "medium" ? "中" : "低"}</strong></span></div>
              {intelligence.analysis.traits.length > 0 && <div className="trait-list rich-traits">{intelligence.analysis.traits.map((trait) => <button className={`trait-evidence${confirmedTraitKeys.has(trait.key) ? " is-confirmed" : ""}`} type="button" key={trait.key} title={`查看 ${trait.evidenceMessageIds.length} 条证据`} onClick={() => { saveTraitFeedback.reset(); setEvidenceTrait(trait); }}><div className="trait-title"><strong>{trait.label}</strong>{confirmedTraitKeys.has(trait.key) && <em><CheckCircle2 size={11} />已确认</em>}</div><small>{trait.value} · {Math.round(trait.confidence * 100)}% 可信 · 查看证据</small></button>)}</div>}
              {rejectedTraits.length > 0 && <div className="ignored-traits"><div className="ignored-traits-title"><span><EyeOff size={13} />已忽略特点</span><small>不会参与分析和待办生成</small></div>{rejectedTraits.map((item) => <div className="ignored-trait" key={item.traitKey}><span><strong>{item.traitLabel}</strong><small>{new Date(item.updatedAt).toLocaleDateString("zh-CN")} 校准</small></span><button className="button compact secondary" type="button" disabled={restoreTraitFeedback.isPending} onClick={() => restoreTraitFeedback.mutate(item.traitKey)}>{restoreTraitFeedback.isPending && restoreTraitFeedback.variables === item.traitKey ? <Spinner /> : <RotateCcw size={13} />}恢复</button></div>)}{restoreTraitFeedback.error && <span className="error-text">{restoreTraitFeedback.error.message}</span>}</div>}
              {intelligence.analysis.keyPoints.length > 0 && <div className="key-point-list">{intelligence.analysis.keyPoints.slice(0, 4).map((point) => <span key={point}><Check size={12} />{point}</span>)}</div>}
            </> : <div className="analysis-empty"><span>尚未生成分析，系统会基于会话证据提取客户特征和跟进项。</span><button className="button secondary full" onClick={onAnalyze} disabled={analyzing}>{analyzing ? <Spinner /> : <Sparkles size={15} />} 生成客户分析</button></div>}
          </div>
          <div className="inspector-section"><div className="section-action-title"><h4>跟进与待办</h4><span className="section-count">{pendingFollowups.length + customerTodos.filter((todo) => !pendingFollowups.some((item) => todoForFollowup(item)?.id === todo.id)).length}</span></div>{followupUpdateError && <div className="form-error">{followupUpdateError}</div>}<div className="followup-list advanced-list">{pendingFollowups.map((item) => { const linkedTodo = todoForFollowup(item); return <div className={`followup-item${linkedTodo ? " crm-todo" : ""}`} key={item.id}><span className={`priority-line priority-${item.priority}`} /><span><strong>{item.title}</strong><small>{formatDueAt(item.dueAt)} · {linkedTodo ? "已进入 GoodJob 待办" : item.reason}</small></span><button className="button compact" title="创建 GoodJob 待办" onClick={() => onCreateGoodJobTodo(item)} disabled={creatingGoodJobTodo || Boolean(linkedTodo)}><ClipboardPlus size={14} /> {linkedTodo ? "已加入待办" : "转待办"}</button><button className="icon-button" title="标记完成" onClick={() => onUpdateFollowup(item.id, "completed", linkedTodo?.id)}><Check size={14} /></button></div>; })}{customerTodos.filter((todo) => !pendingFollowups.some((item) => todoForFollowup(item)?.id === todo.id)).map((todo) => <div className="followup-item crm-todo" key={todo.id}><CalendarClock size={15} /><span><strong>{todo.title}</strong><small>{formatDueAt(todo.dueAt)} · 已进入 GoodJob 待办</small></span></div>)}{pendingFollowups.length + customerTodos.filter((todo) => !pendingFollowups.some((item) => todoForFollowup(item)?.id === todo.id)).length === 0 && <div className="analysis-empty"><span>目前没有未完成事项。新消息分析后，建议会在这里出现。</span></div>}</div></div>
          <div className="inspector-section"><div className="section-action-title"><h4>最近互动与会议</h4><History size={15} /></div><div className="activity-timeline">{recentActivities.map((activity) => <div key={activity.id} className="timeline-item"><span>{activity.type === "meeting" ? <CalendarClock size={14} /> : <PhoneCall size={14} />}</span><div><strong>{activity.type === "meeting" ? "会议" : activity.type === "call" ? "电话" : activity.type === "whatsapp" ? "WhatsApp" : activity.type === "email" ? "邮件" : "客户记录"}</strong><small>{new Date(activity.createdAt).toLocaleString("zh-CN")}{activity.operatorName ? ` · ${activity.operatorName}` : ""}</small><p>{activity.content}</p>{activity.nextReminder && <em>下次：{activity.nextReminder}</em>}</div></div>)}{recentActivities.length === 0 && <div className="analysis-empty"><span>尚无互动记录。会议、电话和约定会按时间沉淀在这里。</span></div>}</div></div>
          <div className="inspector-section"><h4>渠道身份</h4><dl className="detail-list"><div><dt>账号</dt><dd>{account.name}</dd></div><div><dt>Provider</dt><dd>{account.provider}</dd></div><div><dt>用途</dt><dd>{account.purposeLabel || "未设置"}</dd></div><div><dt>状态</dt><dd><StatusBadge status={account.status} /></dd></div></dl></div>
          <div className="inspector-section"><h4>翻译策略</h4><div className="linked-state neutral"><Bot size={16} /><span><strong>{autoTranslate ? "自动翻译已开启" : "按需手动翻译"}</strong><small>目标语言 {targetLanguage}</small></span></div></div>
        </>
      ) : <EmptyState icon={<ContactRound size={22} />} title="客户详情" description="选择会话后显示渠道身份与 CRM 关联。" />}
      {evidenceTrait && <Modal title={`${evidenceTrait.label}的证据`} width="560px" onClose={() => setEvidenceTrait(null)}><div className={`evidence-modal-intro${evidenceFeedback?.verdict === "confirmed" ? " is-confirmed" : ""}`}><strong>{evidenceTrait.value}</strong><span>可信度 {Math.round(evidenceTrait.confidence * 100)}%，来自 {evidenceTrait.evidenceMessageIds.length} 条客户消息。</span>{evidenceFeedback?.verdict === "confirmed" && <em><CheckCircle2 size={13} />团队已确认这项判断</em>}</div><div className="evidence-message-list">{messages.filter((message) => evidenceTrait.evidenceMessageIds.includes(message.id)).map((message) => <article key={message.id} className="evidence-message"><div><span>{message.direction === "inbound" ? "客户" : "团队"}</span><time>{new Date(message.occurredAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time></div><p>{message.body}</p></article>)}{messages.filter((message) => evidenceTrait.evidenceMessageIds.includes(message.id)).length === 0 && <div className="analysis-empty"><span>原始消息暂未加载，请稍后重试。</span></div>}</div>{saveTraitFeedback.error && <div className="form-error">{saveTraitFeedback.error.message}</div>}<div className="evidence-feedback-note">人工校准会影响后续定时分析、跟进建议和每日待办。</div><div className="modal-actions evidence-actions"><button type="button" className="button secondary" disabled={saveTraitFeedback.isPending} onClick={() => setEvidenceTrait(null)}>关闭</button><button type="button" className="button danger" disabled={saveTraitFeedback.isPending} onClick={() => saveTraitFeedback.mutate({ trait: evidenceTrait, verdict: "rejected" })}>{saveTraitFeedback.isPending && saveTraitFeedback.variables?.verdict === "rejected" ? <Spinner /> : <EyeOff size={15} />}忽略此特点</button><button type="button" className="button primary" disabled={saveTraitFeedback.isPending || evidenceFeedback?.verdict === "confirmed"} onClick={() => saveTraitFeedback.mutate({ trait: evidenceTrait, verdict: "confirmed" })}>{saveTraitFeedback.isPending && saveTraitFeedback.variables?.verdict === "confirmed" ? <Spinner /> : <CheckCircle2 size={15} />}{evidenceFeedback?.verdict === "confirmed" ? "已确认" : "结论正确"}</button></div></Modal>}
    </>
  );
}

function AccountRail({ accounts, selectedAccountId, onSelect, onManage }: { accounts: ChannelAccount[]; selectedAccountId?: string; onSelect(id: string): void; onManage(): void }) {
  return (
    <aside className="account-rail" aria-label="WhatsApp 账号切换">
      <div className="rail-accounts">
        {accounts.map((account) => <button key={account.id} className={account.id === selectedAccountId ? "is-selected" : ""} onClick={() => onSelect(account.id)} title={`${account.name} · ${account.status}`}><span>{account.name.slice(0, 2)}</span><i className={`status-dot status-${account.status}`} />{account.id === selectedAccountId && <b />}</button>)}
      </div>
      <button className="rail-add" onClick={onManage} title="管理或添加账号"><Plus size={18} /></button>
    </aside>
  );
}

function ConversationRow({ conversation, selected, onClick }: { conversation: Conversation; selected: boolean; onClick(): void }) {
  return (
    <button className={`conversation-row ${selected ? "is-selected" : ""}`} onClick={onClick}>
      <span className="avatar">{conversation.contactName.slice(0, 2)}</span>
      <span className="conversation-copy"><span><strong>{conversation.contactName}</strong><time>{conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : ""}</time></span><small>{conversation.lastMessage ?? "暂无消息"}</small></span>
      {conversation.unreadCount > 0 && <span className="unread-count">{conversation.unreadCount}</span>}
    </button>
  );
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / 1024 / 1024).toFixed(1)} MB`;
}

function MessageMediaContent({ message }: { message: ChatMessage }) {
  const media = message.media;
  if (!media) return null;
  const mediaUrl = api.mediaUrl(message.id);
  if (message.messageType === "image" && media.available) {
    return <a className="message-media-preview" href={mediaUrl} target="_blank" rel="noreferrer"><img src={mediaUrl} alt={media.fileName} loading="lazy" /></a>;
  }
  if (message.messageType === "video" && media.available) {
    return <div className="message-media-preview"><video src={mediaUrl} controls preload="metadata" /></div>;
  }
  const Icon = message.messageType === "image" ? ImageIcon : message.messageType === "video" ? Video : FileIcon;
  return (
    <div className={`message-file-card ${media.available ? "" : "is-cleared"}`}>
      <span className="message-file-icon"><Icon size={19} /></span>
      <span className="message-file-copy"><strong>{media.fileName}</strong><small>{formatFileSize(media.sizeBytes)} · {media.available ? (media.expiresAt ? `保留至 ${new Date(media.expiresAt).toLocaleDateString("zh-CN")}` : "可下载") : "本地副本已清理"}</small></span>
      {media.available && <a href={mediaUrl} target="_blank" rel="noreferrer" title="打开附件"><Download size={17} /></a>}
    </div>
  );
}

function MessageList({
  account,
  messages,
  loading,
  autoTranslate,
  targetLanguage,
  providerId,
  onTranslated,
  onRevoked
}: {
  account: ChannelAccount;
  messages: ChatMessage[];
  loading: boolean;
  autoTranslate: boolean;
  targetLanguage: string;
  providerId?: string;
  onTranslated(): void;
  onRevoked(): void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [translationGuardError, setTranslationGuardError] = useState<{ messageId: string; message: string } | null>(null);
  const [revokeCandidateId, setRevokeCandidateId] = useState<string | null>(null);
  const translate = useMutation({
    mutationFn: api.translateMessage,
    onSuccess: () => {
      setTranslationGuardError(null);
      onTranslated();
    }
  });
  const revoke = useMutation({
    mutationFn: (messageId: string) => api.revokeMessage(messageId, account.id),
    onSuccess: () => {
      setRevokeCandidateId(null);
      onRevoked();
    }
  });
  const revokeCandidate = revokeCandidateId ? messages.find((message) => message.id === revokeCandidateId) : undefined;
  const requestTranslation = (messageId: string) => {
    if (!providerId) {
      setTranslationGuardError({ messageId, message: "请先在 AI 翻译页配置默认 Provider" });
      return;
    }
    setTranslationGuardError(null);
    translate.mutate(messageId);
  };
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);
  useEffect(() => setTranslationGuardError(null), [providerId]);
  if (loading) return <div className="message-list"><div className="center-loading"><Spinner /> 加载聊天记录</div></div>;
  if (messages.length === 0) {
    return <div className="message-list message-list-empty"><EmptyState icon={<MessageSquareText size={22} />} title="暂无消息" description="发送第一条消息后，聊天记录会显示在这里。" /></div>;
  }
  return (
    <>
      <div className="message-list">
        <div className="message-date"><span>今天</span></div>
        {messages.map((message) => {
        const revoked = Boolean(message.revokedAt);
        const canTranslate = !revoked && message.messageType === "text" && !/[\p{Script=Han}]/u.test(message.body);
        const translation = [...(message.translations || [])].reverse().find(
          (item) => item.targetLanguage === targetLanguage && (!providerId || item.profileId === providerId)
        );
        const translationRequestError = translationGuardError?.messageId === message.id
          ? translationGuardError.message
          : translate.isError && translate.variables === message.id
            ? translate.error.message
            : null;
        return (
          <div key={message.id} className={`message-row ${message.direction}`}>
            <div className={`message-bubble ${revoked ? "is-revoked" : ""}`}>
              {revoked ? <p className="revoked-copy"><Undo2 size={14} />你撤回了一条消息</p> : <>
                <MessageMediaContent message={message} />
                {(!message.media || message.body !== message.media.fileName) && <p>{message.body}</p>}
              </>}
              {!revoked && translation && <div className={`translation-block translation-${translation.status}`}>
                {translation.status === "pending" && <><Spinner /><span>正在翻译</span></>}
                {translation.status === "translated" && <><div className="translation-label"><Languages size={13} /> {translation.targetLanguage} · {translation.trigger === "automatic" ? "自动" : "手动"}</div><p>{translation.translatedText}</p></>}
                {translation.status === "failed" && <><CircleAlert size={14} /><span>{translation.error ?? "翻译失败"}</span><button disabled={translate.isPending} onClick={() => requestTranslation(message.id)}>重试</button></>}
              </div>}
              {canTranslate && !translation && <button className="translate-action" disabled={translate.isPending} onClick={() => requestTranslation(message.id)}><Languages size={14} /> 翻译</button>}
              {translationRequestError && <div className="translation-failed" role="alert"><CircleAlert size={14} /><span>{translationRequestError}</span></div>}
              {revoke.isError && revoke.variables === message.id && <div className="translation-failed" role="alert"><CircleAlert size={14} /><span>{revoke.error.message}</span></div>}
              <div className="message-meta">
                {!revoked && account.provider === "baileys" && message.direction === "outbound" && message.providerMessageId && message.status !== "failed" && <button className="message-revoke" title="消息操作" aria-label="打开消息操作" disabled={revoke.isPending} onClick={() => setRevokeCandidateId(message.id)}><MoreHorizontal size={15} /></button>}
                <time>{new Date(message.occurredAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
                {message.direction === "outbound" && !revoked && (message.status === "read" ? <CheckCheck size={14} /> : <Check size={14} />)}
              </div>
            </div>
          </div>
        );
        })}
        <div ref={bottomRef} />
      </div>
      {revokeCandidate && <Modal title="撤回消息" width="420px" onClose={() => !revoke.isPending && setRevokeCandidateId(null)}>
        <div className="revoke-confirm">
          <div className="revoke-confirm-icon"><Undo2 size={20} /></div>
          <div><strong>确认撤回这条消息？</strong><p>撤回后，双方聊天中都会显示撤回提示。</p></div>
        </div>
        {revoke.isError && <div className="form-error">{revoke.error.message}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" disabled={revoke.isPending} onClick={() => setRevokeCandidateId(null)}>取消</button><button type="button" className="button danger" disabled={revoke.isPending} onClick={() => revoke.mutate(revokeCandidate.id)}>{revoke.isPending ? <Spinner /> : <Undo2 size={16} />} 确认撤回</button></div>
      </Modal>}
    </>
  );
}

function Composer({ account, conversation, providerEnabled, onSent }: { account: ChannelAccount; conversation: Conversation; providerEnabled: boolean; onSent(): void }) {
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showTemplate, setShowTemplate] = useState(false);
  const mediaRetentionQuery = useQuery({ queryKey: queryKeys.mediaRetention, queryFn: api.mediaRetention });
  const filePreviewUrl = useMemo(() => file && (file.type.startsWith("image/") || file.type.startsWith("video/")) ? URL.createObjectURL(file) : null, [file]);
  useEffect(() => () => { if (filePreviewUrl) URL.revokeObjectURL(filePreviewUrl); }, [filePreviewUrl]);
  const send = useMutation({
    mutationFn: () => file
      ? api.sendMedia(conversation.id, {
          accountId: account.id,
          clientMessageId: crypto.randomUUID(),
          kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "file",
          file,
          caption: body.trim()
        })
      : api.sendMessage(conversation.id, { accountId: account.id, clientMessageId: crypto.randomUUID(), body: body.trim() }),
    onSuccess: () => { setBody(""); setFile(null); setFileError(null); if (fileInputRef.current) fileInputRef.current.value = ""; onSent(); }
  });
  const canSend = providerEnabled && account.status === "connected";
  const canAttach = canSend && account.provider === "baileys";
  const selectFile = (selected?: File) => {
    setFileError(null);
    if (!selected) { setFile(null); return; }
    if (selected.size > 25 * 1024 * 1024) { setFileError("附件不能超过 25MB"); return; }
    if (/\.(?:exe|dll|dmg|pkg|sh|bat|cmd|app|html?|svg|js|mjs|cjs)$/iu.test(selected.name)) { setFileError("该文件类型不允许发送"); return; }
    setFile(selected);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if ((body.trim() || file) && !send.isPending && canSend && (!file || canAttach)) send.mutate();
  };
  return (
    <>
      <form className={`composer ${account.provider === "meta" ? "has-template" : ""} ${file ? "has-attachment" : ""}`} onSubmit={submit}>
        {(send.error || fileError) && <div className="composer-error">{fileError || send.error?.message}</div>}
        {file && <div className="composer-attachment">{filePreviewUrl ? (file.type.startsWith("image/") ? <img className="composer-attachment-preview" src={filePreviewUrl} alt="" /> : <video className="composer-attachment-preview" src={filePreviewUrl} muted preload="metadata" />) : <span className="message-file-icon"><FileIcon size={18} /></span>}<span><strong title={file.name}>{file.name}</strong><small>{formatFileSize(file.size)} · {mediaRetentionQuery.data?.mode === "days" ? `本地保留 ${mediaRetentionQuery.data.days} 天` : "发送后清理本地副本"}</small></span><button type="button" title="移除附件" onClick={() => selectFile()}><X size={16} /></button></div>}
        <div className="composer-account"><span className={`status-dot status-${account.status}`} /><span>{account.name}</span></div>
        <input ref={fileInputRef} className="composer-file-input" type="file" accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip" onChange={(event) => selectFile(event.target.files?.[0])} />
        <button type="button" className="attach-button" title={account.provider === "baileys" ? "添加图片、视频或文件" : "附件仅支持 Baileys 免费通道"} disabled={!canAttach} onClick={() => fileInputRef.current?.click()}><Paperclip size={18} /></button>
        <textarea value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={!providerEnabled ? "当前环境已停用此 Provider" : account.status === "connected" ? "输入消息" : "账号离线，连接后才能发送"} disabled={!canSend} rows={1} />
        {account.provider === "meta" && <button type="button" className="template-button" title="发送已审核模板" disabled={!canSend} onClick={() => setShowTemplate(true)}><FileText size={17} /></button>}
        <button className="send-button" title="发送消息" disabled={(!body.trim() && !file) || send.isPending || !canSend || Boolean(file && !canAttach)}>{send.isPending ? <Spinner /> : <Send size={18} />}</button>
      </form>
      {showTemplate && <TemplateMessageModal account={account} conversation={conversation} onClose={() => setShowTemplate(false)} onSent={() => { setShowTemplate(false); onSent(); }} />}
    </>
  );
}

function TemplateMessageModal({
  account,
  conversation,
  onClose,
  onSent
}: {
  account: ChannelAccount;
  conversation: Conversation;
  onClose(): void;
  onSent(): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: ({ conversationId, input }: {
      conversationId: string;
      input: { accountId: string; clientMessageId: string; templateName: string; languageCode: string; bodyParameters: string[] };
    }) => api.sendTemplateMessage(conversationId, input),
    onSuccess: onSent,
    onError: (reason) => setError(reason.message)
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const bodyParameters = String(form.get("bodyParameters") ?? "")
      .split(/\r?\n/u)
      .map((item) => item.trim())
      .filter(Boolean);
    send.mutate({
      conversationId: conversation.id,
      input: {
        accountId: account.id,
        clientMessageId: crypto.randomUUID(),
        templateName: String(form.get("templateName") ?? "").trim(),
        languageCode: String(form.get("languageCode") ?? "").trim(),
        bodyParameters
      }
    });
  };
  return (
    <Modal title="发送 Meta 已审核模板" onClose={onClose}>
      <form className="form-stack" onSubmit={submit}>
        <div className="notice info-notice"><FileText size={16} /><span>仅发送已在 Meta 审核通过的模板；当前入口支持 Body 文本变量，每行对应一个变量。</span></div>
        <div className="form-grid two">
          <label><span>模板名称</span><input name="templateName" required pattern="[a-z0-9_]+" placeholder="例如：catalog_follow_up" /></label>
          <label><span>语言代码</span><input name="languageCode" required defaultValue="en_US" placeholder="例如：en_US" /></label>
        </div>
        <label><span>Body 参数</span><textarea name="bodyParameters" rows={5} placeholder={"Maria\n2026-07-20"} /><small>按模板变量顺序逐行填写；无变量时留空。</small></label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={send.isPending}>{send.isPending ? <Spinner /> : <FileText size={16} />} 发送模板</button></div>
      </form>
    </Modal>
  );
}

function SimulatorModal({ account, onClose, onCreated }: { account: ChannelAccount; onClose(): void; onCreated(): void }) {
  const [error, setError] = useState<string | null>(null);
  const simulate = useMutation({ mutationFn: api.simulateInbound, onSuccess: onCreated, onError: (reason) => setError(reason.message) });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    simulate.mutate({ accountId: account.id, displayName: String(form.get("displayName")), phone: String(form.get("phone")), body: String(form.get("body")) });
  };
  return <Modal title="模拟客户发来消息" onClose={onClose}><form className="form-stack" onSubmit={submit}><div className="notice info-notice"><Sparkles size={16} /><span>消息将进入真实入库、WebSocket、CRM 建档和翻译流程。</span></div><div className="form-grid two"><label><span>客户名称</span><input name="displayName" defaultValue="Elena Rossi" required /></label><label><span>WhatsApp 号码</span><input name="phone" defaultValue="+393331245678" required /></label></div><label><span>消息内容</span><textarea name="body" defaultValue="Can you send the latest catalog?" rows={4} required /></label>{error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={simulate.isPending}>{simulate.isPending ? <Spinner /> : <MessageCirclePlus size={16} />} 发送入站消息</button></div></form></Modal>;
}
