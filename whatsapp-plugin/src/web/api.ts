import type {
  AiProviderProfile,
  ChannelAccount,
  ChatMessage,
  CommercialReadiness,
  Contact,
  Conversation,
  ConversationAnalysis,
  ConversationFollowUp,
  ConversationTraitFeedback,
  CrmSandboxContact,
  HealthStatus,
  MediaRetentionPolicy,
  RoutingResolution,
  RoutingRule,
  Translation,
  TranslationPreference
} from "@shared/types";
import type { AutomationDelivery, AutomationRun, AutomationRunResult, AutomationSettings } from "@shared/types";

export type IntegrationStrategy = "free_first" | "official_first" | "hybrid";

export interface IntegrationPreference {
  strategy: IntegrationStrategy;
  defaultProvider: "baileys" | "meta";
  updatedAt: string;
}

export interface RuntimeCapabilities {
  demoProviderEnabled: boolean;
  providers: {
    demo: boolean;
    baileys: boolean;
    meta: boolean;
  };
}

export interface MetaAppConfig {
  id: string;
  name: string;
  appId: string;
  appSecretMask: string;
  verifyTokenMask: string;
  webhookKey?: string;
  webhookPath?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MetaAccountConfiguration {
  accountId: string;
  appConfigId: string;
  appName?: string;
  wabaId: string;
  phoneNumberId: string;
  accessTokenMask: string;
  graphApiVersion: string;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
  qualityRating?: string | null;
  lastVerifiedAt?: string | null;
  lastWebhookAt?: string | null;
  updatedAt?: string;
}

export interface CrmCustomerActivitySnapshot {
  id: string;
  type: string;
  content: string;
  operatorName?: string;
  nextReminder?: string;
  createdAt: string;
}

export interface ConversationIntelligenceSnapshot {
  analysis: ConversationAnalysis | null;
  followups: ConversationFollowUp[];
  feedback: ConversationTraitFeedback[];
}

export interface CrmCustomerSnapshot {
  id: string;
  company: string;
  contact: string;
  country?: string;
  whatsapp?: string;
  stage?: string;
  amount?: number;
  health?: number;
  grade?: string;
  ownerName?: string;
  pipelineStage?: string;
  pipelineAmount?: number;
  activeDealCount?: number;
  nextReminder?: string;
  lastActivityAt?: string;
  activities?: CrmCustomerActivitySnapshot[];
}

export interface CrmTodoSnapshot {
  id: string;
  title: string;
  priority: "high" | "medium" | "normal";
  dueAt: string;
  related?: string;
  customerId?: string;
  triggerKey?: string;
  done: boolean;
}

export interface WhatsAppHistoryPreview {
  messageCount: number;
  skippedLines: number;
  participants: string[];
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  sample: Array<{ occurredAt: string; sender: string; body: string }>;
}

export interface WhatsAppHistoryImportResult {
  contact: Contact;
  conversation: Conversation;
  imported: number;
  duplicates: number;
  parsed: number;
  analysis: ConversationAnalysis;
}

const pluginBasePath = import.meta.env.BASE_URL.replace(/\/$/u, "");

class ApiClient {
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${pluginBasePath}/api${path}`, {
      ...options,
      headers: {
        "content-type": "application/json",
        ...options?.headers
      }
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? `Request failed (${response.status})`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  health = () => this.request<HealthStatus>("/health");
  capabilities = () => this.request<RuntimeCapabilities>("/v1/capabilities");
  commercialReadiness = () => this.request<CommercialReadiness>("/v1/commercial-readiness");
  accounts = () => this.request<ChannelAccount[]>("/v1/accounts");
  createAccount = (input: object) =>
    this.request<ChannelAccount>("/v1/accounts", { method: "POST", body: JSON.stringify(input) });
  connectAccount = (id: string) => this.request<ChannelAccount>(`/v1/accounts/${id}/connect`, { method: "POST" });
  logoutAccount = (id: string) => this.request<ChannelAccount>(`/v1/accounts/${id}/logout`, { method: "POST" });
  deleteAccount = (id: string) => this.request<void>(`/v1/accounts/${id}`, { method: "DELETE" });
  syncContacts = (id: string) => this.request<{ count: number }>(`/v1/accounts/${id}/sync/contacts`, { method: "POST" });

  contacts = (accountId?: string) =>
    this.request<Contact[]>(`/v1/contacts${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`);
  createContact = (input: { accountId: string; displayName: string; phone: string; createCrmContact?: boolean }) =>
    this.request<{ contact: Contact; conversation: Conversation; crmContact: CrmSandboxContact | null }>("/v1/contacts", {
      method: "POST",
      body: JSON.stringify(input)
    });
  createContactConversation = (contactId: string) =>
    this.request<Conversation>(`/v1/contacts/${contactId}/conversation`, { method: "POST" });
  conversations = (accountId?: string) =>
    this.request<Conversation[]>(`/v1/conversations${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`);
  messages = (conversationId: string) => this.request<ChatMessage[]>(`/v1/conversations/${conversationId}/messages`);
  conversationIntelligence = async (conversationId: string): Promise<ConversationIntelligenceSnapshot> => {
    const snapshot = await this.request<Partial<ConversationIntelligenceSnapshot>>(`/v1/conversations/${conversationId}/intelligence`);
    return {
      analysis: snapshot.analysis ?? null,
      followups: Array.isArray(snapshot.followups) ? snapshot.followups : [],
      feedback: Array.isArray(snapshot.feedback) ? snapshot.feedback : []
    };
  };
  analyzeConversation = (conversationId: string) => this.request<{ analysis: ConversationAnalysis; followups: ConversationFollowUp[] }>(`/v1/conversations/${conversationId}/intelligence/analyze`, { method: "POST" });
  saveTraitFeedback = (conversationId: string, input: { traitKey: string; traitLabel: string; verdict: ConversationTraitFeedback["verdict"]; correctionText?: string }) =>
    this.request<ConversationIntelligenceSnapshot>(`/v1/conversations/${conversationId}/intelligence/feedback`, { method: "PUT", body: JSON.stringify(input) });
  deleteTraitFeedback = (conversationId: string, traitKey: string) =>
    this.request<ConversationIntelligenceSnapshot>(`/v1/conversations/${conversationId}/intelligence/feedback/${encodeURIComponent(traitKey)}`, { method: "DELETE" });
  updateFollowup = (id: string, status: ConversationFollowUp["status"]) => this.request<ConversationFollowUp>(`/v1/followups/${id}`, { method: "PATCH", body: JSON.stringify({ status }) });
  completeCrmTodo = async (id: string): Promise<CrmTodoSnapshot> => {
    const response = await fetch(`/api/todos/${encodeURIComponent(id)}/complete`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completionResult: "已从即刻沟通客户跟进面板完成" })
    });
    const payload = (await response.json().catch(() => ({}))) as { todo?: CrmTodoSnapshot; message?: string };
    if (!response.ok || !payload.todo) throw new Error(payload.message ?? `GoodJob 待办完成失败 (${response.status})`);
    return payload.todo;
  };
  createGoodJobTodo = async (input: { title: string; priority: ConversationFollowUp["priority"]; dueAt: string; related: string; customerId?: string; triggerKey?: string }): Promise<unknown> => {
    const response = await fetch("/api/todos", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, type: "customer" })
    });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { message?: string }).message ?? `GoodJob 待办创建失败 (${response.status})`);
    return response.json();
  };
  sendMessage = (conversationId: string, input: { accountId: string; clientMessageId: string; body: string }) =>
    this.request<ChatMessage>(`/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify(input)
    });
  sendMedia = async (conversationId: string, input: {
    accountId: string;
    clientMessageId: string;
    kind: "image" | "video" | "file";
    file: File;
    caption: string;
  }): Promise<ChatMessage> => {
    const query = new URLSearchParams({
      accountId: input.accountId,
      clientMessageId: input.clientMessageId,
      kind: input.kind,
      fileName: input.file.name,
      mimeType: input.file.type || "application/octet-stream",
      caption: input.caption
    });
    const response = await fetch(`${pluginBasePath}/api/v1/conversations/${conversationId}/media?${query.toString()}`, {
      method: "POST",
      headers: { "content-type": input.file.type || "application/octet-stream" },
      body: input.file
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(payload.error ?? `Request failed (${response.status})`);
    }
    return response.json() as Promise<ChatMessage>;
  };
  revokeMessage = (messageId: string, accountId: string) =>
    this.request<ChatMessage>(`/v1/messages/${messageId}/revoke`, {
      method: "POST",
      body: JSON.stringify({ accountId })
    });
  mediaUrl = (messageId: string) => `${pluginBasePath}/api/v1/messages/${messageId}/media`;
  mediaRetention = () => this.request<MediaRetentionPolicy>("/v1/media-retention");
  updateMediaRetention = (input: Pick<MediaRetentionPolicy, "mode" | "days">) =>
    this.request<MediaRetentionPolicy>("/v1/media-retention", { method: "PUT", body: JSON.stringify(input) });
  sendTemplateMessage = (
    conversationId: string,
    input: { accountId: string; clientMessageId: string; templateName: string; languageCode: string; bodyParameters: string[] }
  ) => this.request<ChatMessage>(`/v1/conversations/${conversationId}/template-messages`, {
    method: "POST",
    body: JSON.stringify(input)
  });
  translateMessage = (messageId: string) =>
    this.request<Translation>(`/v1/messages/${messageId}/translations`, { method: "POST" });

  translationPreference = () => this.request<TranslationPreference>("/v1/translation/preferences");
  updateTranslationPreference = (input: Partial<TranslationPreference>) =>
    this.request<TranslationPreference>("/v1/translation/preferences", { method: "PUT", body: JSON.stringify(input) });
  aiProviders = () => this.request<AiProviderProfile[]>("/v1/ai/providers");
  createAiProvider = (input: object) =>
    this.request<AiProviderProfile>("/v1/ai/providers", { method: "POST", body: JSON.stringify(input) });
  testAiProvider = (id: string) =>
    this.request<{ ok: boolean; text?: string; error?: string }>(`/v1/ai/providers/${id}/test`, { method: "POST" });
  deleteAiProvider = (id: string) =>
    this.request<void>(`/v1/ai/providers/${id}`, { method: "DELETE" });

  integrationPreference = () => this.request<IntegrationPreference>("/v1/integration/preference");
  automationSettings = () => this.request<AutomationSettings>("/v1/automation/settings");
  updateAutomationSettings = (input: Pick<AutomationSettings, "analysisIntervalHours" | "intelligenceMode" | "intelligenceProviderId" | "dailyTodoHour" | "dailyTodoMinute" | "timezone" | "enabled">) => this.request<AutomationSettings>("/v1/automation/settings", { method: "PUT", body: JSON.stringify(input) });
  runAutomation = () => this.request<AutomationRunResult>("/v1/automation/run", { method: "POST" });
  automationRuns = (limit = 12) => this.request<AutomationRun[]>(`/v1/automation/runs?limit=${limit}`);
  automationDeliveries = (limit = 30) => this.request<AutomationDelivery[]>(`/v1/automation/deliveries?limit=${limit}`);
  previewWhatsAppHistory = (input: { content: string; dateOrder: "dmy" | "mdy" }) => this.request<WhatsAppHistoryPreview>("/v1/imports/whatsapp-text/preview", { method: "POST", body: JSON.stringify(input) });
  importWhatsAppHistory = (input: { accountId: string; phone: string; displayName: string; customerSender: string; content: string; dateOrder: "dmy" | "mdy" }) => this.request<WhatsAppHistoryImportResult>("/v1/imports/whatsapp-text", { method: "POST", body: JSON.stringify(input) });
  updateIntegrationPreference = (input: Pick<IntegrationPreference, "strategy" | "defaultProvider">) =>
    this.request<IntegrationPreference>("/v1/integration/preference", { method: "PUT", body: JSON.stringify(input) });
  metaApps = () => this.request<MetaAppConfig[]>("/v1/meta/apps");
  createMetaApp = (input: { name: string; appId: string; appSecret: string; verifyToken: string }) =>
    this.request<MetaAppConfig>("/v1/meta/apps", { method: "POST", body: JSON.stringify(input) });
  metaConfigurations = () => this.request<MetaAccountConfiguration[]>("/v1/meta/configurations");
  metaAccountConfiguration = (accountId: string) =>
    this.request<MetaAccountConfiguration>(`/v1/accounts/${accountId}/meta`);
  updateMetaAccountConfiguration = (
    accountId: string,
    input: { appConfigId: string; wabaId: string; phoneNumberId: string; accessToken: string; graphApiVersion: string }
  ) => this.request<MetaAccountConfiguration>(`/v1/accounts/${accountId}/meta`, { method: "PUT", body: JSON.stringify(input) });

  routingRules = () => this.request<RoutingRule[]>("/v1/routing/rules");
  createRoutingRule = (input: object) =>
    this.request<RoutingRule>("/v1/routing/rules", { method: "POST", body: JSON.stringify(input) });
  updateRoutingRule = ({ id, input }: { id: string; input: object }) =>
    this.request<RoutingRule>(`/v1/routing/rules/${id}`, { method: "PUT", body: JSON.stringify(input) });
  deleteRoutingRule = (id: string) => this.request<void>(`/v1/routing/rules/${id}`, { method: "DELETE" });
  resolveRouting = (leadType: string, region: string) =>
    this.request<RoutingResolution>(
      "/v1/routing/resolve",
      { method: "POST", body: JSON.stringify({ leadType, region }) }
    );

  crmContacts = async (): Promise<CrmSandboxContact[]> => {
    try {
      const response = await fetch("/api/customers", { credentials: "include" });
      if (response.ok) {
        const payload = (await response.json()) as { customers?: Array<{ id: string; company: string; contact?: string; whatsapp?: string; createdAt?: string }> };
        return (payload.customers ?? [])
          .map((customer) => ({ id: customer.id, phone: customer.whatsapp ?? "", name: customer.contact || customer.company, source: "goodjob_crm", sourceContactId: customer.id, createdAt: customer.createdAt ?? new Date().toISOString() }))
          .filter((customer) => /^\+[1-9]\d{7,14}$/u.test(customer.phone));
      }
    } catch {
      // Standalone desktop mode may not have the parent CRM API.
    }
    return this.request<CrmSandboxContact[]>("/v1/crm/contacts");
  };
  crmCustomers = async (): Promise<CrmCustomerSnapshot[]> => {
    const response = await fetch("/api/customers", { credentials: "include" });
    if (!response.ok) throw new Error(`读取 CRM 客户失败 (${response.status})`);
    const payload = (await response.json()) as { customers?: CrmCustomerSnapshot[] };
    return payload.customers ?? [];
  };
  crmTodos = async (): Promise<CrmTodoSnapshot[]> => {
    const response = await fetch("/api/todos", { credentials: "include" });
    if (!response.ok) throw new Error(`读取 CRM 待办失败 (${response.status})`);
    const payload = (await response.json()) as { todos?: CrmTodoSnapshot[] };
    return payload.todos ?? [];
  };
  createCustomerActivity = (customerId: string, input: { type: "call" | "email" | "whatsapp" | "wechat" | "meeting" | "note"; content: string; nextReminder?: string }) =>
    fetch(`/api/customers/${encodeURIComponent(customerId)}/activities`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }).then(async (response) => {
      if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { message?: string }).message ?? `记录客户互动失败 (${response.status})`);
      return response.json() as Promise<{ activity: CrmCustomerActivitySnapshot }>;
    });
  importCrmContact = ({ crmContactId, accountId, externalContact }: { crmContactId: string; accountId: string; externalContact?: { id: string; name: string; phone: string } }) =>
    this.request<{ contact: Contact; conversation: Conversation; crmContact: CrmSandboxContact }>(`/v1/crm/contacts/${crmContactId}/import`, {
      method: "POST",
      body: JSON.stringify({ accountId, externalContact })
    });
  createCrmContact = (contactId: string) =>
    this.request<CrmSandboxContact>(`/v1/contacts/${contactId}/crm-create`, { method: "POST" });
  simulateInbound = (input: { accountId: string; displayName: string; phone: string; body: string }) =>
    this.request<ChatMessage>("/v1/demo/inbound", { method: "POST", body: JSON.stringify(input) });
}

export const api = new ApiClient();
