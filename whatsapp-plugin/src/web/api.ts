import type {
  AiProviderProfile,
  ChannelAccount,
  ChatMessage,
  Contact,
  Conversation,
  CrmSandboxContact,
  HealthStatus,
  MediaRetentionPolicy,
  RoutingResolution,
  RoutingRule,
  Translation,
  TranslationPreference
} from "@shared/types";

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

  crmContacts = () => this.request<CrmSandboxContact[]>("/v1/crm/contacts");
  importCrmContact = ({ crmContactId, accountId }: { crmContactId: string; accountId: string }) =>
    this.request<{ contact: Contact; conversation: Conversation; crmContact: CrmSandboxContact }>(`/v1/crm/contacts/${crmContactId}/import`, {
      method: "POST",
      body: JSON.stringify({ accountId })
    });
  createCrmContact = (contactId: string) =>
    this.request<CrmSandboxContact>(`/v1/contacts/${contactId}/crm-create`, { method: "POST" });
  simulateInbound = (input: { accountId: string; displayName: string; phone: string; body: string }) =>
    this.request<ChatMessage>("/v1/demo/inbound", { method: "POST", body: JSON.stringify(input) });
}

export const api = new ApiClient();
