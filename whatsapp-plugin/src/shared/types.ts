export type ProviderKind = "demo" | "baileys" | "meta";

export type IntegrationStrategy = "free_first" | "official_first" | "hybrid";

export interface IntegrationPreference {
  strategy: IntegrationStrategy;
  defaultProvider: "baileys" | "meta";
  updatedAt: string;
}

export interface MetaAppConfig {
  id: string;
  name: string;
  appId: string;
  appSecretMask: string;
  verifyTokenMask: string;
  webhookKey: string;
  webhookPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface MetaAccountConfiguration {
  accountId: string;
  appConfigId: string;
  appName: string;
  wabaId: string;
  phoneNumberId: string;
  accessTokenMask: string;
  graphApiVersion: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  lastVerifiedAt: string | null;
  lastWebhookAt: string | null;
  updatedAt: string;
}

export interface ContactSyncResult {
  count: number;
  note?: string;
}

export type ContactOrigin = "whatsapp_sync" | "inbound_message" | "manual" | "crm_import";

export const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/u;

export function isE164PhoneNumber(value: string): boolean {
  return E164_PHONE_PATTERN.test(value);
}

export type AccountStatus =
  | "unconfigured"
  | "waiting_qr"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "logged_out"
  | "credential_invalid"
  | "degraded";

export interface ChannelAccount {
  id: string;
  ownerUserId: string | null;
  name: string;
  provider: ProviderKind;
  phone: string | null;
  avatarUrl: string | null;
  status: AccountStatus;
  purposeLabel: string;
  leadTypes: string[];
  region: string;
  priority: number;
  riskAccepted: boolean;
  lastConnectedAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  qrDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Contact {
  id: string;
  accountId: string;
  providerContactId: string;
  displayName: string;
  phone: string;
  avatarUrl: string | null;
  source: ProviderKind;
  origin: ContactOrigin;
  lastSeenAt: string | null;
  crmContactId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Conversation {
  id: string;
  accountId: string;
  contactId: string;
  providerConversationId: string;
  contactName: string;
  contactPhone: string;
  contactAvatarUrl: string | null;
  unreadCount: number;
  lastMessage: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MessageStatus =
  | "queued"
  | "sending"
  | "accepted"
  | "delivered"
  | "read"
  | "failed"
  | "unknown";

export interface Translation {
  id: string;
  messageId: string;
  sourceLanguage: string | null;
  targetLanguage: string;
  profileId: string;
  model: string;
  trigger: "automatic" | "manual";
  status: "pending" | "translated" | "failed";
  translatedText: string | null;
  error: string | null;
  tokenUsage: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  accountId: string;
  conversationId: string;
  providerMessageId: string | null;
  clientMessageId: string | null;
  direction: "inbound" | "outbound";
  messageType: "text" | "image" | "video" | "file" | "audio" | "system";
  body: string;
  status: MessageStatus;
  sourceLanguage: string | null;
  occurredAt: string;
  createdAt: string;
  revokedAt?: string | null;
  media?: MessageMedia | null;
  translations: Translation[];
}

export interface MessageMedia {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  available: boolean;
  expiresAt: string | null;
}

export interface MediaRetentionPolicy {
  mode: "immediate" | "days";
  days: number;
  updatedAt: string;
}

export interface TranslationPreference {
  autoTranslate: boolean;
  targetLanguage: string;
  providerId: string | null;
  crmAutoCreate: boolean;
}

export interface AiProviderProfile {
  id: string;
  name: string;
  kind: "mock" | "openai";
  baseUrl: string | null;
  apiKeyMask: string | null;
  model: string;
  enabled: boolean;
  lastTestStatus: "untested" | "success" | "failed";
  lastTestError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingRule {
  id: string;
  name: string;
  leadType: string;
  region: string;
  preferredAccountId: string;
  fallbackAccountId: string | null;
  priority: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoutingResolution {
  rule: RoutingRule | null;
  preferred: ChannelAccount | null;
  fallback: ChannelAccount | null;
  account: ChannelAccount | null;
  selectionReason: "preferred_online" | "fallback_online" | "no_online_account" | null;
}

export interface CrmSandboxContact {
  id: string;
  phone: string;
  name: string;
  source: string;
  sourceContactId: string;
  createdAt: string;
}

export interface HealthStatus {
  status: "ok" | "degraded";
  database: "pglite" | "postgres";
  activeConnections: number;
  timestamp: string;
}

export interface RealtimeEvent<T = unknown> {
  eventId: string;
  eventType: string;
  accountId: string | null;
  occurredAt: string;
  data: T;
}
