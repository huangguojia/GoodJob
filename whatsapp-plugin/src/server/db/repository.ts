import { randomUUID } from "node:crypto";
import { isE164PhoneNumber } from "../../shared/types.js";
import type {
  AccountStatus,
  AiProviderProfile,
  ChannelAccount,
  ChatMessage,
  Contact,
  ContactOrigin,
  Conversation,
  CrmSandboxContact,
  IntegrationPreference,
  IntegrationStrategy,
  MediaRetentionPolicy,
  MessageStatus,
  MetaAccountConfiguration,
  MetaAppConfig,
  ConversationAnalysis,
  ConversationFollowUp,
  ConversationTrait,
  ConversationTraitFeedback,
  AutomationRun,
  ProviderKind,
  RoutingResolution,
  RoutingRule,
  Translation,
  TranslationPreference
} from "../../shared/types.js";
import { databaseTimestamp, type Database } from "./database.js";

const now = (): string => new Date().toISOString();
const dbTime = (value: string): ReturnType<typeof databaseTimestamp> => databaseTimestamp(value);
const toBoolean = (value: number | string | boolean): boolean => value === true || value === 1 || value === "1";

interface AccountRow {
  id: string;
  owner_user_id: string | null;
  name: string;
  provider: ProviderKind;
  phone: string | null;
  avatar_url: string | null;
  status: AccountStatus;
  purpose_label: string;
  lead_types_json: string;
  region: string;
  priority: number;
  risk_accepted: number;
  last_connected_at: string | null;
  last_event_at: string | null;
  last_error: string | null;
  qr_data_url: string | null;
  created_at: string;
  updated_at: string;
}

interface ContactRow {
  id: string;
  account_id: string;
  provider_contact_id: string;
  display_name: string;
  phone: string;
  avatar_url: string | null;
  source: ProviderKind;
  origin: ContactOrigin;
  last_seen_at: string | null;
  crm_contact_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  id: string;
  account_id: string;
  contact_id: string;
  provider_conversation_id: string;
  contact_name: string;
  contact_phone: string;
  contact_avatar_url: string | null;
  unread_count: number;
  last_message: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageTranslationRow {
  id: string;
  account_id: string;
  conversation_id: string;
  provider_message_id: string | null;
  client_message_id: string | null;
  direction: "inbound" | "outbound";
  message_type: ChatMessage["messageType"];
  body: string;
  status: MessageStatus;
  source_language: string | null;
  occurred_at: string;
  created_at: string;
  media_file_name: string | null;
  media_mime_type: string | null;
  media_size_bytes: number | string | null;
  media_storage_key: string | null;
  media_expires_at: string | null;
  revoked_at: string | null;
  translation_id: string | null;
  target_language: string | null;
  translation_source_language: string | null;
  profile_id: string | null;
  translation_model: string | null;
  trigger_type: Translation["trigger"] | null;
  translation_status: Translation["status"] | null;
  translated_text: string | null;
  translation_error: string | null;
  token_usage: number | null;
  translation_created_at: string | null;
  translation_updated_at: string | null;
}

interface AiProfileRow {
  id: string;
  owner_user_id: string | null;
  name: string;
  kind: "mock" | "openai";
  base_url: string | null;
  api_key_cipher: string | null;
  api_key_mask: string | null;
  model: string;
  enabled: number;
  last_test_status: AiProviderProfile["lastTestStatus"];
  last_test_error: string | null;
  created_at: string;
  updated_at: string;
}

interface MetaAppRow {
  id: string;
  owner_user_id: string | null;
  name: string;
  app_id: string;
  app_secret_cipher: string;
  app_secret_mask: string;
  verify_token_digest: string;
  verify_token_mask: string;
  webhook_key: string;
  created_at: string;
  updated_at: string;
}

interface MetaConfigurationRow {
  account_id: string;
  app_config_id: string;
  app_name: string;
  app_id: string;
  app_secret_cipher: string;
  webhook_key: string;
  waba_id: string;
  phone_number_id: string;
  access_token_cipher: string;
  access_token_mask: string;
  graph_api_version: string;
  display_phone_number: string | null;
  verified_name: string | null;
  quality_rating: string | null;
  sending_enabled: number;
  last_verified_at: string | null;
  last_webhook_at: string | null;
  last_error: string | null;
  updated_at: string;
}

export type MetaWebhookEventStatus = "pending" | "processing" | "processed" | "failed";

interface MetaWebhookEventRow {
  id: string;
  app_config_id: string;
  event_hash: string;
  payload_cipher: string;
  status: MetaWebhookEventStatus;
  attempts: number | string;
  last_error: string | null;
  received_at: string;
  processing_started_at: string | null;
  processed_at: string | null;
  updated_at: string;
}

interface ConversationAnalysisRow {
  id: string;
  conversation_id: string;
  account_id: string;
  status: ConversationAnalysis["status"];
  summary: string;
  key_points_json: string;
  traits_json: string;
  buying_intent: ConversationAnalysis["buyingIntent"];
  risk_level: ConversationAnalysis["riskLevel"];
  next_action: string;
  source_message_count: number | string;
  engine: ConversationAnalysis["engine"];
  model: string | null;
  prompt_version: string;
  error: string | null;
  generated_at: string;
  updated_at: string;
}

interface ConversationFollowUpRow {
  id: string;
  conversation_id: string;
  analysis_id: string;
  source_key: string;
  title: string;
  reason: string;
  priority: ConversationFollowUp["priority"];
  due_at: string;
  status: ConversationFollowUp["status"];
  evidence_message_ids_json: string;
  created_at: string;
  updated_at: string;
}

export interface MetaWebhookEvent {
  id: string;
  appConfigId: string;
  eventHash: string;
  payloadCipher: string;
  status: MetaWebhookEventStatus;
  attempts: number;
  lastError: string | null;
  receivedAt: string;
  processingStartedAt: string | null;
  processedAt: string | null;
  updatedAt: string;
}

export interface MetaAppSecret extends MetaAppConfig {
  appSecretCipher: string;
  verifyTokenDigest: string;
}

export interface MetaAccountCredentialSecret extends MetaAccountConfiguration {
  appId: string;
  appSecretCipher: string;
  webhookKey: string;
  accessTokenCipher: string;
  sendingEnabled: boolean;
  lastError: string | null;
}

function mapAccount(row: AccountRow): ChannelAccount {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    provider: row.provider,
    phone: row.phone,
    avatarUrl: row.avatar_url,
    status: row.status,
    purposeLabel: row.purpose_label,
    leadTypes: JSON.parse(row.lead_types_json) as string[],
    region: row.region,
    priority: Number(row.priority),
    riskAccepted: toBoolean(row.risk_accepted),
    lastConnectedAt: row.last_connected_at,
    lastEventAt: row.last_event_at,
    lastError: row.last_error,
    qrDataUrl: row.qr_data_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapContact(row: ContactRow): Contact {
  return {
    id: row.id,
    accountId: row.account_id,
    providerContactId: row.provider_contact_id,
    displayName: row.display_name,
    phone: row.phone,
    avatarUrl: row.avatar_url,
    source: row.source,
    origin: row.origin,
    lastSeenAt: row.last_seen_at,
    crmContactId: row.crm_contact_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    accountId: row.account_id,
    contactId: row.contact_id,
    providerConversationId: row.provider_conversation_id,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactAvatarUrl: row.contact_avatar_url,
    unreadCount: Number(row.unread_count),
    lastMessage: row.last_message,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapAiProfile(row: AiProfileRow): AiProviderProfile {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    apiKeyMask: row.api_key_mask,
    model: row.model,
    enabled: toBoolean(row.enabled),
    lastTestStatus: row.last_test_status,
    lastTestError: row.last_test_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMetaApp(row: MetaAppRow): MetaAppConfig {
  return {
    id: row.id,
    name: row.name,
    appId: row.app_id,
    appSecretMask: row.app_secret_mask,
    verifyTokenMask: row.verify_token_mask,
    webhookKey: row.webhook_key,
    webhookPath: `/api/webhooks/meta/${row.webhook_key}`,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapMetaConfiguration(row: MetaConfigurationRow): MetaAccountConfiguration {
  return {
    accountId: row.account_id,
    appConfigId: row.app_config_id,
    appName: row.app_name,
    wabaId: row.waba_id,
    phoneNumberId: row.phone_number_id,
    accessTokenMask: row.access_token_mask,
    graphApiVersion: row.graph_api_version,
    displayPhoneNumber: row.display_phone_number,
    verifiedName: row.verified_name,
    qualityRating: row.quality_rating,
    lastVerifiedAt: row.last_verified_at,
    lastWebhookAt: row.last_webhook_at,
    updatedAt: row.updated_at
  };
}

function mapMetaWebhookEvent(row: MetaWebhookEventRow): MetaWebhookEvent {
  return {
    id: row.id,
    appConfigId: row.app_config_id,
    eventHash: row.event_hash,
    payloadCipher: row.payload_cipher,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    receivedAt: row.received_at,
    processingStartedAt: row.processing_started_at,
    processedAt: row.processed_at,
    updatedAt: row.updated_at
  };
}

function parseJsonArray<T>(value: string, fallback: T[] = []): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

function mapConversationAnalysis(row: ConversationAnalysisRow): ConversationAnalysis {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    summary: row.summary,
    keyPoints: parseJsonArray<string>(row.key_points_json),
    traits: parseJsonArray<ConversationTrait>(row.traits_json),
    buyingIntent: row.buying_intent,
    riskLevel: row.risk_level,
    nextAction: row.next_action,
    sourceMessageCount: Number(row.source_message_count),
    engine: row.engine ?? "rules",
    model: row.model ?? null,
    promptVersion: row.prompt_version ?? "rules-v1",
    generatedAt: row.generated_at,
    updatedAt: row.updated_at,
    error: row.error
  };
}

function mapConversationFollowUp(row: ConversationFollowUpRow): ConversationFollowUp {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    analysisId: row.analysis_id,
    sourceKey: row.source_key,
    title: row.title,
    reason: row.reason,
    priority: row.priority,
    dueAt: row.due_at,
    status: row.status,
    evidenceMessageIds: parseJsonArray<string>(row.evidence_message_ids_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class Repository {
  constructor(private readonly database: Database) {}

  async listAccounts(ownerUserId?: string): Promise<ChannelAccount[]> {
    const result = await this.database.query<AccountRow>(
      "SELECT * FROM channel_accounts WHERE ($1::text IS NULL OR owner_user_id=$1) ORDER BY priority, created_at",
      [ownerUserId ?? null]
    );
    return result.rows.map(mapAccount);
  }

  async getAccount(id: string, ownerUserId?: string): Promise<ChannelAccount | null> {
    const result = await this.database.query<AccountRow>("SELECT * FROM channel_accounts WHERE id = $1 AND ($2::text IS NULL OR owner_user_id=$2)", [id, ownerUserId ?? null]);
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  async findActiveAccountByPhone(phone: string, excludeAccountId: string): Promise<ChannelAccount | null> {
    const result = await this.database.query<AccountRow>(
      `SELECT * FROM channel_accounts
       WHERE id<>$2 AND provider<>'demo' AND phone=$1
         AND status IN ('connecting','waiting_qr','connected','reconnecting')
       ORDER BY updated_at DESC LIMIT 1`,
      [phone, excludeAccountId]
    );
    return result.rows[0] ? mapAccount(result.rows[0]) : null;
  }

  async createAccount(input: {
    name: string;
    provider: ProviderKind;
    phone?: string;
    purposeLabel?: string;
    leadTypes?: string[];
    region?: string;
    priority?: number;
    riskAccepted?: boolean;
    ownerUserId?: string;
  }): Promise<ChannelAccount> {
    const id = randomUUID();
    const timestamp = now();
    await this.database.query(
      `INSERT INTO channel_accounts (
        id, name, provider, phone, status, purpose_label, lead_types_json, region, priority,
        risk_accepted, owner_user_id, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        id,
        input.name,
        input.provider,
        input.phone ?? null,
        "unconfigured",
        input.purposeLabel ?? "",
        JSON.stringify(input.leadTypes ?? []),
        input.region ?? "",
        input.priority ?? 100,
        input.riskAccepted ? 1 : 0,
        input.ownerUserId ?? (process.env.NODE_ENV === "test" ? "test-user" : null),
        dbTime(timestamp),
        dbTime(timestamp)
      ]
    );
    return (await this.getAccount(id))!;
  }

  async updateAccountStatus(
    id: string,
    status: AccountStatus,
    details: { phone?: string | null; qrDataUrl?: string | null; error?: string | null } = {}
  ): Promise<ChannelAccount> {
    const timestamp = now();
    await this.database.query(
      `UPDATE channel_accounts SET status=$2,
        phone=COALESCE($3, phone), qr_data_url=$4, last_error=$5, last_event_at=$6,
        last_connected_at=CASE WHEN $2='connected' THEN $6 ELSE last_connected_at END,
        updated_at=$6 WHERE id=$1`,
      [id, status, details.phone ?? null, details.qrDataUrl ?? null, details.error ?? null, dbTime(timestamp)]
    );
    const account = await this.getAccount(id);
    if (!account) throw new Error("Account not found");
    return account;
  }

  async deleteAccount(id: string): Promise<void> {
    await this.database.query("DELETE FROM channel_accounts WHERE id=$1", [id]);
  }

  async countRoutingReferences(accountId: string): Promise<number> {
    const result = await this.database.query<{ reference_count: number | string }>(
      `SELECT COUNT(*) AS reference_count FROM routing_rules
       WHERE preferred_account_id=$1 OR fallback_account_id=$1`,
      [accountId]
    );
    return Number(result.rows[0]?.reference_count ?? 0);
  }

  async getIntegrationPreference(ownerUserId?: string): Promise<IntegrationPreference> {
    const result = await this.database.query<{
      strategy: IntegrationStrategy;
      default_provider: "baileys" | "meta";
      updated_at: string;
    }>("SELECT strategy,default_provider,updated_at FROM integration_preferences WHERE id=$1", [ownerUserId ?? "default"]);
    const row = result.rows[0];
    if (!row && ownerUserId) {
      await this.database.query(
        this.database.kind === "mysql"
          ? `INSERT IGNORE INTO integration_preferences(id,strategy,default_provider,updated_at)
             VALUES($1,'free_first','baileys',$2)`
          : `INSERT INTO integration_preferences(id,strategy,default_provider,updated_at)
             VALUES($1,'free_first','baileys',$2)
             ON CONFLICT(id) DO NOTHING`,
        [ownerUserId, dbTime(now())]
      );
      return this.getIntegrationPreference(ownerUserId);
    }
    if (!row) throw new Error("Integration preference is not initialized");
    return { strategy: row.strategy, defaultProvider: row.default_provider, updatedAt: row.updated_at };
  }

  async updateIntegrationPreference(input: {
    strategy: IntegrationStrategy;
    defaultProvider: "baileys" | "meta";
  }, ownerUserId?: string): Promise<IntegrationPreference> {
    await this.getIntegrationPreference(ownerUserId);
    await this.database.query(
      "UPDATE integration_preferences SET strategy=$1,default_provider=$2,updated_at=$3 WHERE id=$4",
      [input.strategy, input.defaultProvider, dbTime(now()), ownerUserId ?? "default"]
    );
    return this.getIntegrationPreference(ownerUserId);
  }

  async enforceOfficialIntegrationPreference(): Promise<void> {
    await this.database.query(
      "UPDATE integration_preferences SET strategy='official_first',default_provider='meta',updated_at=$1 WHERE strategy='free_first' OR default_provider='baileys'",
      [dbTime(now())]
    );
  }

  async listMetaApps(ownerUserId?: string): Promise<MetaAppConfig[]> {
    const result = await this.database.query<MetaAppRow>("SELECT * FROM meta_app_configs WHERE ($1::text IS NULL OR owner_user_id=$1) ORDER BY created_at", [ownerUserId ?? null]);
    return result.rows.map(mapMetaApp);
  }

  async getMetaApp(id: string, ownerUserId?: string): Promise<MetaAppConfig | null> {
    const result = await this.database.query<MetaAppRow>("SELECT * FROM meta_app_configs WHERE id=$1 AND ($2::text IS NULL OR owner_user_id=$2)", [id, ownerUserId ?? null]);
    return result.rows[0] ? mapMetaApp(result.rows[0]) : null;
  }

  async getMetaAppByAppId(appId: string, ownerUserId?: string): Promise<MetaAppConfig | null> {
    const result = await this.database.query<MetaAppRow>("SELECT * FROM meta_app_configs WHERE app_id=$1 AND ($2::text IS NULL OR owner_user_id=$2)", [appId, ownerUserId ?? null]);
    return result.rows[0] ? mapMetaApp(result.rows[0]) : null;
  }

  async getMetaAppSecretByWebhookKey(webhookKey: string): Promise<MetaAppSecret | null> {
    const result = await this.database.query<MetaAppRow>("SELECT * FROM meta_app_configs WHERE webhook_key=$1", [webhookKey]);
    const row = result.rows[0];
    return row
      ? { ...mapMetaApp(row), appSecretCipher: row.app_secret_cipher, verifyTokenDigest: row.verify_token_digest }
      : null;
  }

  async createMetaApp(input: {
    name: string;
    appId: string;
    appSecretCipher: string;
    appSecretMask: string;
    verifyTokenDigest: string;
    verifyTokenMask: string;
    webhookKey: string;
    ownerUserId?: string;
  }): Promise<MetaAppConfig> {
    const id = randomUUID();
    const timestamp = now();
    await this.database.query(
      `INSERT INTO meta_app_configs(
        id,name,app_id,app_secret_cipher,app_secret_mask,verify_token_digest,verify_token_mask,webhook_key,owner_user_id,created_at,updated_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [
        id,
        input.name,
        input.appId,
        input.appSecretCipher,
        input.appSecretMask,
        input.verifyTokenDigest,
        input.verifyTokenMask,
        input.webhookKey,
        input.ownerUserId ?? null,
        dbTime(timestamp)
      ]
    );
    return (await this.getMetaApp(id, input.ownerUserId))!;
  }

  private metaConfigurationSelect(): string {
    return `SELECT c.*,a.name AS app_name,a.app_id,a.app_secret_cipher,a.webhook_key
      FROM meta_account_credentials c JOIN meta_app_configs a ON a.id=c.app_config_id`;
  }

  async listMetaConfigurations(ownerUserId?: string): Promise<MetaAccountConfiguration[]> {
    const result = await this.database.query<MetaConfigurationRow>(
      `${this.metaConfigurationSelect()} JOIN channel_accounts owner_account ON owner_account.id=c.account_id WHERE ($1::text IS NULL OR owner_account.owner_user_id=$1) ORDER BY c.created_at`,
      [ownerUserId ?? null]
    );
    return result.rows.map(mapMetaConfiguration);
  }

  async getMetaConfiguration(accountId: string, ownerUserId?: string): Promise<MetaAccountConfiguration | null> {
    const result = await this.database.query<MetaConfigurationRow>(
      `${this.metaConfigurationSelect()} JOIN channel_accounts owner_account ON owner_account.id=c.account_id WHERE c.account_id=$1 AND ($2::text IS NULL OR owner_account.owner_user_id=$2)`,
      [accountId, ownerUserId ?? null]
    );
    return result.rows[0] ? mapMetaConfiguration(result.rows[0]) : null;
  }

  async getMetaCredentialSecret(accountId: string): Promise<MetaAccountCredentialSecret | null> {
    const result = await this.database.query<MetaConfigurationRow>(
      `${this.metaConfigurationSelect()} WHERE c.account_id=$1`,
      [accountId]
    );
    return result.rows[0] ? this.mapMetaCredentialSecret(result.rows[0]) : null;
  }

  async getMetaCredentialByPhoneNumberId(phoneNumberId: string): Promise<MetaAccountCredentialSecret | null> {
    const result = await this.database.query<MetaConfigurationRow>(
      `${this.metaConfigurationSelect()} WHERE c.phone_number_id=$1`,
      [phoneNumberId]
    );
    return result.rows[0] ? this.mapMetaCredentialSecret(result.rows[0]) : null;
  }

  private mapMetaCredentialSecret(row: MetaConfigurationRow): MetaAccountCredentialSecret {
    return {
      ...mapMetaConfiguration(row),
      appId: row.app_id,
      appSecretCipher: row.app_secret_cipher,
      webhookKey: row.webhook_key,
      accessTokenCipher: row.access_token_cipher,
      sendingEnabled: toBoolean(row.sending_enabled),
      lastError: row.last_error
    };
  }

  async upsertMetaConfiguration(input: {
    accountId: string;
    appConfigId: string;
    wabaId: string;
    phoneNumberId: string;
    accessTokenCipher: string;
    accessTokenMask: string;
    graphApiVersion: string;
  }): Promise<MetaAccountConfiguration> {
    const timestamp = now();
    await this.database.query(
      this.database.kind === "mysql"
        ? `INSERT INTO meta_account_credentials(
            account_id,app_config_id,waba_id,phone_number_id,access_token_cipher,access_token_mask,graph_api_version,
            sending_enabled,created_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,$8)
           ON DUPLICATE KEY UPDATE
            app_config_id=$2,waba_id=$3,phone_number_id=$4,access_token_cipher=$5,access_token_mask=$6,
            graph_api_version=$7,display_phone_number=NULL,verified_name=NULL,quality_rating=NULL,
            sending_enabled=0,last_verified_at=NULL,last_error=NULL,updated_at=$8`
        : `INSERT INTO meta_account_credentials(
            account_id,app_config_id,waba_id,phone_number_id,access_token_cipher,access_token_mask,graph_api_version,
            sending_enabled,created_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,0,$8,$8)
           ON CONFLICT(account_id) DO UPDATE SET
            app_config_id=EXCLUDED.app_config_id,waba_id=EXCLUDED.waba_id,phone_number_id=EXCLUDED.phone_number_id,
            access_token_cipher=EXCLUDED.access_token_cipher,access_token_mask=EXCLUDED.access_token_mask,
            graph_api_version=EXCLUDED.graph_api_version,display_phone_number=NULL,verified_name=NULL,quality_rating=NULL,
            sending_enabled=0,last_verified_at=NULL,last_error=NULL,updated_at=EXCLUDED.updated_at`,
      [
        input.accountId,
        input.appConfigId,
        input.wabaId,
        input.phoneNumberId,
        input.accessTokenCipher,
        input.accessTokenMask,
        input.graphApiVersion,
        dbTime(timestamp)
      ]
    );
    return (await this.getMetaConfiguration(input.accountId))!;
  }

  async updateMetaVerification(input: {
    accountId: string;
    enabled: boolean;
    displayPhoneNumber?: string | null;
    verifiedName?: string | null;
    qualityRating?: string | null;
    error?: string | null;
  }): Promise<MetaAccountConfiguration> {
    await this.database.query(
      `UPDATE meta_account_credentials SET sending_enabled=$2,
       display_phone_number=COALESCE($3,display_phone_number),verified_name=COALESCE($4,verified_name),
       quality_rating=COALESCE($5,quality_rating),last_verified_at=CASE WHEN $2=1 THEN $6 ELSE last_verified_at END,
       last_error=$7,updated_at=$6 WHERE account_id=$1`,
      [
        input.accountId,
        input.enabled ? 1 : 0,
        input.displayPhoneNumber ?? null,
        input.verifiedName ?? null,
        input.qualityRating ?? null,
        dbTime(now()),
        input.error ?? null
      ]
    );
    const configuration = await this.getMetaConfiguration(input.accountId);
    if (!configuration) throw new Error("Meta configuration not found");
    return configuration;
  }

  async setMetaSendingEnabled(accountId: string, enabled: boolean): Promise<void> {
    await this.database.query(
      "UPDATE meta_account_credentials SET sending_enabled=$2,updated_at=$3 WHERE account_id=$1",
      [accountId, enabled ? 1 : 0, dbTime(now())]
    );
  }

  async touchMetaWebhook(accountId: string): Promise<void> {
    await this.database.query(
      "UPDATE meta_account_credentials SET last_webhook_at=$2,updated_at=$2 WHERE account_id=$1",
      [accountId, dbTime(now())]
    );
  }

  async createMetaWebhookEvent(input: {
    appConfigId: string;
    eventHash: string;
    payloadCipher: string;
  }): Promise<MetaWebhookEvent> {
    const id = randomUUID();
    const timestamp = dbTime(now());
    await this.database.query(
      this.database.kind === "mysql"
        ? `INSERT INTO meta_webhook_events(
             id,app_config_id,event_hash,payload_cipher,status,attempts,received_at,updated_at
           ) VALUES($1,$2,$3,$4,'pending',0,$5,$5)
           ON DUPLICATE KEY UPDATE id=id`
        : `INSERT INTO meta_webhook_events(
             id,app_config_id,event_hash,payload_cipher,status,attempts,received_at,updated_at
           ) VALUES($1,$2,$3,$4,'pending',0,$5,$5)
           ON CONFLICT(app_config_id,event_hash) DO NOTHING`,
      [id, input.appConfigId, input.eventHash, input.payloadCipher, timestamp]
    );
    const event = await this.getMetaWebhookEventByHash(input.appConfigId, input.eventHash);
    if (!event) throw new Error("Meta webhook event was not persisted");
    return event;
  }

  async getMetaWebhookEvent(id: string): Promise<MetaWebhookEvent | null> {
    const result = await this.database.query<MetaWebhookEventRow>(
      "SELECT * FROM meta_webhook_events WHERE id=$1",
      [id]
    );
    return result.rows[0] ? mapMetaWebhookEvent(result.rows[0]) : null;
  }

  async getMetaWebhookEventByHash(appConfigId: string, eventHash: string): Promise<MetaWebhookEvent | null> {
    const result = await this.database.query<MetaWebhookEventRow>(
      "SELECT * FROM meta_webhook_events WHERE app_config_id=$1 AND event_hash=$2",
      [appConfigId, eventHash]
    );
    return result.rows[0] ? mapMetaWebhookEvent(result.rows[0]) : null;
  }

  async claimMetaWebhookEvent(
    id: string,
    options: { maxAttempts: number; staleBefore: string }
  ): Promise<MetaWebhookEvent | null> {
    return this.database.transaction(async (transaction) => {
      const eligible = await transaction.query<MetaWebhookEventRow>(
        `SELECT * FROM meta_webhook_events
         WHERE id=$1 AND attempts<$2 AND (
           status IN ('pending','failed') OR
           (status='processing' AND processing_started_at IS NOT NULL AND processing_started_at<=$3)
         ) FOR UPDATE`,
        [id, options.maxAttempts, dbTime(options.staleBefore)]
      );
      if (!eligible.rows[0]) return null;
      const timestamp = dbTime(now());
      await transaction.query(
        `UPDATE meta_webhook_events
         SET status='processing',attempts=attempts+1,last_error=NULL,
             processing_started_at=$2,processed_at=NULL,updated_at=$2
         WHERE id=$1`,
        [id, timestamp]
      );
      const claimed = await transaction.query<MetaWebhookEventRow>(
        "SELECT * FROM meta_webhook_events WHERE id=$1",
        [id]
      );
      return claimed.rows[0] ? mapMetaWebhookEvent(claimed.rows[0]) : null;
    });
  }

  async listRecoverableMetaWebhookEvents(options: {
    maxAttempts: number;
    staleBefore: string;
    limit: number;
  }): Promise<MetaWebhookEvent[]> {
    const result = await this.database.query<MetaWebhookEventRow>(
      `SELECT * FROM meta_webhook_events
       WHERE attempts<$1 AND (
         status IN ('pending','failed') OR
         (status='processing' AND processing_started_at IS NOT NULL AND processing_started_at<=$2)
       ) ORDER BY received_at LIMIT $3`,
      [options.maxAttempts, dbTime(options.staleBefore), options.limit]
    );
    return result.rows.map(mapMetaWebhookEvent);
  }

  async markMetaWebhookEventProcessed(id: string): Promise<void> {
    const timestamp = dbTime(now());
    await this.database.query(
      `UPDATE meta_webhook_events SET status='processed',last_error=NULL,processed_at=$2,updated_at=$2
       WHERE id=$1 AND status='processing'`,
      [id, timestamp]
    );
  }

  async markMetaWebhookEventFailed(id: string, error: string): Promise<void> {
    await this.database.query(
      `UPDATE meta_webhook_events SET status='failed',last_error=$2,updated_at=$3
       WHERE id=$1 AND status='processing'`,
      [id, error.slice(0, 2_000), dbTime(now())]
    );
  }

  async getSessionValue(accountId: string, keyType: string, keyId: string): Promise<string | null> {
    const result = await this.database.query<{ cipher_text: string }>(
      "SELECT cipher_text FROM provider_session_keys WHERE account_id=$1 AND key_type=$2 AND key_id=$3",
      [accountId, keyType, keyId]
    );
    return result.rows[0]?.cipher_text ?? null;
  }

  async setSessionValue(accountId: string, keyType: string, keyId: string, cipherText: string): Promise<void> {
    await this.database.query(
      this.database.kind === "mysql"
        ? `INSERT INTO provider_session_keys(account_id,key_type,key_id,cipher_text,updated_at)
           VALUES($1,$2,$3,$4,$5)
           ON DUPLICATE KEY UPDATE cipher_text=$4,updated_at=$5`
        : `INSERT INTO provider_session_keys(account_id,key_type,key_id,cipher_text,updated_at)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(account_id,key_type,key_id) DO UPDATE SET cipher_text=EXCLUDED.cipher_text,updated_at=EXCLUDED.updated_at`,
      [accountId, keyType, keyId, cipherText, dbTime(now())]
    );
  }

  async deleteSessionValue(accountId: string, keyType?: string, keyId?: string): Promise<void> {
    if (keyType && keyId) {
      await this.database.query(
        "DELETE FROM provider_session_keys WHERE account_id=$1 AND key_type=$2 AND key_id=$3",
        [accountId, keyType, keyId]
      );
      return;
    }
    await this.database.query("DELETE FROM provider_session_keys WHERE account_id=$1", [accountId]);
  }

  async listContacts(accountId?: string, ownerUserId?: string): Promise<Contact[]> {
    const result = await this.database.query<ContactRow>(
      `SELECT c.*, crm.id AS crm_contact_id FROM contacts c
       JOIN channel_accounts a ON a.id=c.account_id
       LEFT JOIN crm_contacts crm ON crm.phone=c.phone
       WHERE ($1::text IS NULL OR c.account_id=$1) AND ($2::text IS NULL OR a.owner_user_id=$2)
       ORDER BY c.display_name`,
      [accountId ?? null, ownerUserId ?? null]
    );
    return result.rows.map(mapContact);
  }

  async getContact(id: string, ownerUserId?: string): Promise<Contact | null> {
    const result = await this.database.query<ContactRow>(
      `SELECT c.*, crm.id AS crm_contact_id FROM contacts c
       JOIN channel_accounts a ON a.id=c.account_id
       LEFT JOIN crm_contacts crm ON crm.phone=c.phone WHERE c.id=$1 AND ($2::text IS NULL OR a.owner_user_id=$2)`,
      [id, ownerUserId ?? null]
    );
    return result.rows[0] ? mapContact(result.rows[0]) : null;
  }

  async getContactByAccountPhone(accountId: string, phone: string): Promise<Contact | null> {
    const result = await this.database.query<ContactRow>(
      `SELECT c.*, crm.id AS crm_contact_id FROM contacts c
       LEFT JOIN crm_contacts crm ON crm.phone=c.phone
       WHERE c.account_id=$1 AND c.phone=$2
       ORDER BY c.created_at LIMIT 1`,
      [accountId, phone]
    );
    return result.rows[0] ? mapContact(result.rows[0]) : null;
  }

  async upsertContact(input: {
    accountId: string;
    providerContactId: string;
    displayName?: string | null;
    phone: string;
    avatarUrl?: string | null;
    source: ProviderKind;
    origin?: ContactOrigin;
  }): Promise<Contact> {
    if (!isE164PhoneNumber(input.phone)) throw new Error("Invalid E.164 phone number");
    const timestamp = now();
    const id = randomUUID();
    const existingByPhone = await this.getContactByAccountPhone(input.accountId, input.phone);
    const providerContactId = existingByPhone?.providerContactId ?? input.providerContactId;
    const displayName = input.displayName?.trim() || input.phone;
    const hasDisplayName = Boolean(input.displayName?.trim());
    const hasAvatar = input.avatarUrl !== undefined;
    await this.database.query(
      this.database.kind === "mysql"
        ? `INSERT INTO contacts(id,account_id,provider_contact_id,display_name,phone,avatar_url,source,origin,last_seen_at,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9)
           ON DUPLICATE KEY UPDATE
             display_name=CASE WHEN $10=1 THEN $4 ELSE display_name END,
             phone=$5,
             avatar_url=CASE WHEN $11=1 THEN $6 ELSE avatar_url END,
             last_seen_at=$9,updated_at=$9`
        : `INSERT INTO contacts(id,account_id,provider_contact_id,display_name,phone,avatar_url,source,origin,last_seen_at,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$9)
           ON CONFLICT(account_id,phone) DO UPDATE SET
             display_name=CASE WHEN $10::integer=1 THEN EXCLUDED.display_name ELSE contacts.display_name END,
             phone=EXCLUDED.phone,
             avatar_url=CASE WHEN $11::integer=1 THEN EXCLUDED.avatar_url ELSE contacts.avatar_url END,
             last_seen_at=EXCLUDED.last_seen_at,updated_at=EXCLUDED.updated_at`,
      [
        id,
        input.accountId,
        providerContactId,
        displayName,
        input.phone,
        input.avatarUrl ?? null,
        input.source,
        input.origin ?? "whatsapp_sync",
        dbTime(timestamp),
        hasDisplayName ? 1 : 0,
        hasAvatar ? 1 : 0
      ]
    );
    return (await this.getContactByAccountPhone(input.accountId, input.phone))!;
  }

  async listConversations(accountId?: string, ownerUserId?: string): Promise<Conversation[]> {
    const result = await this.database.query<ConversationRow>(
      `SELECT v.id,v.account_id,v.contact_id,v.provider_conversation_id,v.unread_count,v.last_message_at,
        v.created_at,v.updated_at,c.display_name AS contact_name,c.phone AS contact_phone,c.avatar_url AS contact_avatar_url,
        (SELECT m.body FROM messages m WHERE m.conversation_id=v.id ORDER BY m.occurred_at DESC LIMIT 1) AS last_message
       FROM conversations v JOIN contacts c ON c.id=v.contact_id
       JOIN channel_accounts a ON a.id=v.account_id
       WHERE ($1::text IS NULL OR v.account_id=$1) AND ($2::text IS NULL OR a.owner_user_id=$2)
       ORDER BY (v.last_message_at IS NULL), v.last_message_at DESC, v.created_at DESC`,
      [accountId ?? null, ownerUserId ?? null]
    );
    return result.rows.map(mapConversation);
  }

  async listAutomationConversations(ownerUserId?: string): Promise<Conversation[]> {
    return this.listConversations(undefined, ownerUserId);
  }

  async createAutomationRun(input: Pick<AutomationRun, "ownerUserId" | "trigger"> & { totalConversations: number }): Promise<AutomationRun> {
    const id = `automation_run_${randomUUID()}`;
    const timestamp = dbTime(new Date().toISOString());
    const triggerColumn = this.database.kind === "mysql" ? "trigger_type" : "trigger";
    await this.database.query(
      `INSERT INTO automation_runs(id,owner_user_id,${triggerColumn},status,total_conversations,processed_conversations,analysis_updated,todos_created,notifications_sent,skipped,current_conversation,error,started_at,finished_at,updated_at)
       VALUES($1,$2,$3,'running',$4,0,0,0,0,0,NULL,NULL,$5,NULL,$5)`,
      [id, input.ownerUserId ?? null, input.trigger, input.totalConversations, timestamp]
    );
    return (await this.getAutomationRun(id, input.ownerUserId))!;
  }

  async getAutomationRun(id: string, ownerUserId?: string | null): Promise<AutomationRun | null> {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM automation_runs WHERE id=$1 AND ($2::text IS NULL OR owner_user_id=$2) LIMIT 1`,
      [id, ownerUserId ?? null]
    );
    return result.rows[0] ? this.mapAutomationRun(result.rows[0]) : null;
  }

  async listAutomationRuns(ownerUserId?: string, limit = 12): Promise<AutomationRun[]> {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM automation_runs WHERE ($1::text IS NULL OR owner_user_id=$1) ORDER BY started_at DESC LIMIT $2`,
      [ownerUserId ?? null, Math.max(1, Math.min(50, limit))]
    );
    return result.rows.map((row) => this.mapAutomationRun(row));
  }

  async updateAutomationRunProgress(id: string, values: Partial<Pick<AutomationRun, "status" | "processedConversations" | "analysisUpdated" | "todosCreated" | "notificationsSent" | "skipped" | "currentConversation" | "error" | "finishedAt">>): Promise<AutomationRun | null> {
    const current = await this.getAutomationRun(id);
    if (!current) return null;
    const next = { ...current, ...values, updatedAt: new Date().toISOString() };
    await this.database.query(
      `UPDATE automation_runs SET status=$2,processed_conversations=$3,analysis_updated=$4,todos_created=$5,notifications_sent=$6,skipped=$7,current_conversation=$8,error=$9,finished_at=$10,updated_at=$11 WHERE id=$1`,
      [id, next.status, next.processedConversations, next.analysisUpdated, next.todosCreated, next.notificationsSent, next.skipped, next.currentConversation, next.error, next.finishedAt ? dbTime(next.finishedAt) : null, dbTime(next.updatedAt)]
    );
    return this.getAutomationRun(id);
  }

  private mapAutomationRun(row: Record<string, unknown>): AutomationRun {
    const date = (key: string): string | null => {
      if (row[key] == null) return null;
      const parsed = row[key] instanceof Date ? row[key] as Date : new Date(String(row[key]));
      return Number.isNaN(parsed.getTime()) ? String(row[key]) : parsed.toISOString();
    };
    return {
      id: String(row.id), ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id),
      trigger: String(row.trigger_type ?? row.trigger) as AutomationRun["trigger"], status: String(row.status) as AutomationRun["status"],
      totalConversations: Number(row.total_conversations ?? 0), processedConversations: Number(row.processed_conversations ?? 0),
      analysisUpdated: Number(row.analysis_updated ?? 0), todosCreated: Number(row.todos_created ?? 0),
      notificationsSent: Number(row.notifications_sent ?? 0), skipped: Number(row.skipped ?? 0),
      currentConversation: row.current_conversation == null ? null : String(row.current_conversation), error: row.error == null ? null : String(row.error),
      startedAt: date("started_at") ?? new Date().toISOString(), finishedAt: date("finished_at"), updatedAt: date("updated_at") ?? new Date().toISOString()
    };
  }

  async getAutomationSettings(ownerUserId?: string): Promise<import("../../shared/types.js").AutomationSettings> {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM automation_settings WHERE owner_user_id=$1 OR (owner_user_id IS NULL AND $1 IS NULL) LIMIT 1`,
      [ownerUserId ?? null]
    );
    const row = result.rows[0];
    if (!row) {
      if (ownerUserId) {
        return this.saveAutomationSettings({ ownerUserId, analysisIntervalHours: 6, intelligenceMode: "rules", intelligenceProviderId: null, dailyTodoHour: 9, dailyTodoMinute: 0, timezone: "Asia/Shanghai", enabled: true, nextAnalysisAt: new Date(Date.now() + 6 * 3600000).toISOString(), nextDailyTodoAt: new Date(Date.now() + 24 * 3600000).toISOString() });
      }
      return {
        analysisIntervalHours: 6, intelligenceMode: "rules", intelligenceProviderId: null, dailyTodoHour: 9, dailyTodoMinute: 0, timezone: "Asia/Shanghai", enabled: true,
        lastAnalysisAt: null, nextAnalysisAt: new Date(Date.now() + 6 * 3600000).toISOString(), lastDailyTodoAt: null,
        nextDailyTodoAt: null, lastRunStatus: "idle", lastRunSummary: "尚未运行", updatedAt: new Date().toISOString()
      };
    }
    const value = (key: string): string | null => {
      if (row[key] == null) return null;
      const parsed = row[key] instanceof Date ? row[key] as Date : new Date(String(row[key]));
      return Number.isNaN(parsed.getTime()) ? String(row[key]) : parsed.toISOString();
    };
    return {
      analysisIntervalHours: Number(row.analysis_interval_hours ?? 6),
      intelligenceMode: String(row.intelligence_mode ?? "rules") as import("../../shared/types.js").AutomationSettings["intelligenceMode"],
      intelligenceProviderId: row.intelligence_provider_id == null ? null : String(row.intelligence_provider_id),
      dailyTodoHour: Number(row.daily_todo_hour ?? 9),
      dailyTodoMinute: Number(row.daily_todo_minute ?? 0), timezone: String(row.timezone ?? "Asia/Shanghai"),
      enabled: Boolean(Number(row.enabled ?? 1)), lastAnalysisAt: value("last_analysis_at"), nextAnalysisAt: value("next_analysis_at"),
      lastDailyTodoAt: value("last_daily_todo_at"), nextDailyTodoAt: value("next_daily_todo_at"),
      lastRunStatus: (String(row.last_run_status ?? "idle") as import("../../shared/types.js").AutomationSettings["lastRunStatus"]),
      lastRunSummary: String(row.last_run_summary ?? ""), updatedAt: value("updated_at") ?? new Date().toISOString()
    };
  }

  async saveAutomationSettings(input: { ownerUserId?: string; analysisIntervalHours: number; intelligenceMode: import("../../shared/types.js").AutomationSettings["intelligenceMode"]; intelligenceProviderId: string | null; dailyTodoHour: number; dailyTodoMinute: number; timezone: string; enabled: boolean; nextAnalysisAt: string; nextDailyTodoAt: string }): Promise<import("../../shared/types.js").AutomationSettings> {
    const id = input.ownerUserId ? `settings_${input.ownerUserId}` : "default";
    const timestamp = dbTime(new Date().toISOString());
    await this.database.query(this.database.kind === "mysql"
      ? `INSERT INTO automation_settings(id,analysis_interval_hours,intelligence_mode,intelligence_provider_id,daily_todo_hour,daily_todo_minute,timezone,enabled,next_analysis_at,next_daily_todo_at,last_run_status,last_run_summary,updated_at,owner_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'idle','已保存节奏设置',$11,$12) ON DUPLICATE KEY UPDATE analysis_interval_hours=$2,intelligence_mode=$3,intelligence_provider_id=$4,daily_todo_hour=$5,daily_todo_minute=$6,timezone=$7,enabled=$8,next_analysis_at=$9,next_daily_todo_at=$10,updated_at=$11`
      : `INSERT INTO automation_settings(id,analysis_interval_hours,intelligence_mode,intelligence_provider_id,daily_todo_hour,daily_todo_minute,timezone,enabled,next_analysis_at,next_daily_todo_at,last_run_status,last_run_summary,updated_at,owner_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'idle','已保存节奏设置',$11,$12) ON CONFLICT(id) DO UPDATE SET analysis_interval_hours=EXCLUDED.analysis_interval_hours,intelligence_mode=EXCLUDED.intelligence_mode,intelligence_provider_id=EXCLUDED.intelligence_provider_id,daily_todo_hour=EXCLUDED.daily_todo_hour,daily_todo_minute=EXCLUDED.daily_todo_minute,timezone=EXCLUDED.timezone,enabled=EXCLUDED.enabled,next_analysis_at=EXCLUDED.next_analysis_at,next_daily_todo_at=EXCLUDED.next_daily_todo_at,updated_at=EXCLUDED.updated_at`,
      [id, input.analysisIntervalHours, input.intelligenceMode, input.intelligenceProviderId, input.dailyTodoHour, input.dailyTodoMinute, input.timezone, input.enabled ? 1 : 0, dbTime(input.nextAnalysisAt), dbTime(input.nextDailyTodoAt), timestamp, input.ownerUserId ?? null]);
    return this.getAutomationSettings(input.ownerUserId);
  }

  async updateAutomationRun(ownerUserId: string | undefined, values: { status: string; summary: string; lastAnalysisAt?: string; nextAnalysisAt?: string; lastDailyTodoAt?: string; nextDailyTodoAt?: string }): Promise<void> {
    const current = await this.getAutomationSettings(ownerUserId);
    const id = ownerUserId ? `settings_${ownerUserId}` : "default";
    await this.database.query(this.database.kind === "mysql"
      ? `UPDATE automation_settings SET last_run_status=$2,last_run_summary=$3,last_analysis_at=$4,next_analysis_at=$5,last_daily_todo_at=$6,next_daily_todo_at=$7,updated_at=$8 WHERE id=$1`
      : `UPDATE automation_settings SET last_run_status=$2,last_run_summary=$3,last_analysis_at=$4,next_analysis_at=$5,last_daily_todo_at=$6,next_daily_todo_at=$7,updated_at=$8 WHERE id=$1`,
      [id, values.status, values.summary, values.lastAnalysisAt ? dbTime(values.lastAnalysisAt) : current.lastAnalysisAt ? dbTime(current.lastAnalysisAt) : null, values.nextAnalysisAt ? dbTime(values.nextAnalysisAt) : current.nextAnalysisAt ? dbTime(current.nextAnalysisAt) : null, values.lastDailyTodoAt ? dbTime(values.lastDailyTodoAt) : current.lastDailyTodoAt ? dbTime(current.lastDailyTodoAt) : null, values.nextDailyTodoAt ? dbTime(values.nextDailyTodoAt) : current.nextDailyTodoAt ? dbTime(current.nextDailyTodoAt) : null, dbTime(new Date().toISOString())]);
  }

  async claimAutomationDelivery(ownerUserId: string, followupId: string, runDate: string, deliveryType: string): Promise<boolean> {
    const id = randomUUID();
    const timestamp = dbTime(new Date().toISOString());
    if (this.database.kind === "mysql") {
      const inserted = await this.database.query(
        `INSERT IGNORE INTO automation_deliveries(id,owner_user_id,followup_id,run_date,delivery_type,status,attempts,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'pending',1,$6,$6)`,
        [id, ownerUserId, followupId, runDate, deliveryType, timestamp]
      );
      if ((inserted.affectedRows ?? 0) > 0) return true;
      const retried = await this.database.query(
        `UPDATE automation_deliveries SET status='pending',attempts=attempts+1,last_error=NULL,next_retry_at=NULL,updated_at=$5
         WHERE owner_user_id=$1 AND followup_id=$2 AND run_date=$3 AND delivery_type=$4 AND status='failed'`,
        [ownerUserId, followupId, runDate, deliveryType, timestamp]
      );
      return (retried.affectedRows ?? 0) > 0;
    }
    const inserted = await this.database.query<{ id: string }>(
      `INSERT INTO automation_deliveries(id,owner_user_id,followup_id,run_date,delivery_type,status,attempts,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,'pending',1,$6,$6) ON CONFLICT(owner_user_id,followup_id,run_date,delivery_type) DO NOTHING RETURNING id`,
      [id, ownerUserId, followupId, runDate, deliveryType, timestamp]
    );
    if (inserted.rows.length > 0) return true;
    const retried = await this.database.query<{ id: string }>(
      `UPDATE automation_deliveries SET status='pending',attempts=attempts+1,last_error=NULL,next_retry_at=NULL,updated_at=$5
       WHERE owner_user_id=$1 AND followup_id=$2 AND run_date=$3 AND delivery_type=$4 AND status='failed' RETURNING id`,
      [ownerUserId, followupId, runDate, deliveryType, timestamp]
    );
    return retried.rows.length > 0;
  }

  async completeAutomationDelivery(ownerUserId: string, followupId: string, runDate: string, deliveryType: string, externalId?: string | null): Promise<void> {
    await this.database.query(
      "UPDATE automation_deliveries SET status='success',external_id=$5,last_error=NULL,next_retry_at=NULL,updated_at=$6 WHERE owner_user_id=$1 AND followup_id=$2 AND run_date=$3 AND delivery_type=$4",
      [ownerUserId, followupId, runDate, deliveryType, externalId ?? null, dbTime(new Date().toISOString())]
    );
  }

  async failAutomationDelivery(ownerUserId: string, followupId: string, runDate: string, deliveryType: string, error: string): Promise<void> {
    await this.database.query(
      "UPDATE automation_deliveries SET status='failed',last_error=$5,next_retry_at=$6,updated_at=$6 WHERE owner_user_id=$1 AND followup_id=$2 AND run_date=$3 AND delivery_type=$4",
      [ownerUserId, followupId, runDate, deliveryType, error.slice(0, 2000), dbTime(new Date().toISOString())]
    );
  }

  async listAutomationDeliveries(ownerUserId: string, limit = 30): Promise<import("../../shared/types.js").AutomationDelivery[]> {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT * FROM automation_deliveries WHERE owner_user_id=$1 ORDER BY updated_at DESC,created_at DESC LIMIT $2`,
      [ownerUserId, Math.min(100, Math.max(1, limit))]
    );
    const iso = (value: unknown): string | null => {
      if (value == null) return null;
      const parsed = value instanceof Date ? value : new Date(String(value));
      return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
    };
    return result.rows.map((row) => ({
      id: String(row.id), followupId: String(row.followup_id), runDate: iso(row.run_date)?.slice(0, 10) ?? String(row.run_date),
      deliveryType: String(row.delivery_type) as "todo" | "notification", status: String(row.status ?? "success") as "pending" | "success" | "failed",
      attempts: Number(row.attempts ?? 1), externalId: row.external_id == null ? null : String(row.external_id),
      lastError: row.last_error == null ? null : String(row.last_error), nextRetryAt: iso(row.next_retry_at),
      updatedAt: iso(row.updated_at) ?? iso(row.created_at) ?? new Date().toISOString()
    }));
  }

  async getConversation(id: string, ownerUserId?: string): Promise<Conversation | null> {
    const result = await this.database.query<ConversationRow>(
      `SELECT v.id,v.account_id,v.contact_id,v.provider_conversation_id,v.unread_count,v.last_message_at,
        v.created_at,v.updated_at,c.display_name AS contact_name,c.phone AS contact_phone,c.avatar_url AS contact_avatar_url,
        (SELECT m.body FROM messages m WHERE m.conversation_id=v.id ORDER BY m.occurred_at DESC LIMIT 1) AS last_message
       FROM conversations v JOIN contacts c ON c.id=v.contact_id
       JOIN channel_accounts a ON a.id=v.account_id
       WHERE v.id=$1 AND ($2::text IS NULL OR a.owner_user_id=$2)`,
      [id, ownerUserId ?? null]
    );
    return result.rows[0] ? mapConversation(result.rows[0]) : null;
  }

  async upsertConversation(input: {
    accountId: string;
    contactId: string;
    providerConversationId: string;
  }): Promise<Conversation> {
    const timestamp = now();
    const id = randomUUID();
    await this.database.query(
      this.database.kind === "mysql"
        ? `INSERT INTO conversations(id,account_id,contact_id,provider_conversation_id,unread_count,created_at,updated_at)
           VALUES($1,$2,$3,$4,0,$5,$5)
           ON DUPLICATE KEY UPDATE contact_id=$3,updated_at=$5`
        : `INSERT INTO conversations(id,account_id,contact_id,provider_conversation_id,unread_count,created_at,updated_at)
           VALUES($1,$2,$3,$4,0,$5,$5)
           ON CONFLICT(account_id,provider_conversation_id) DO UPDATE SET contact_id=EXCLUDED.contact_id,updated_at=EXCLUDED.updated_at`,
      [id, input.accountId, input.contactId, input.providerConversationId, dbTime(timestamp)]
    );
    const result = await this.database.query<{ id: string }>(
      "SELECT id FROM conversations WHERE account_id=$1 AND provider_conversation_id=$2",
      [input.accountId, input.providerConversationId]
    );
    return (await this.getConversation(result.rows[0].id))!;
  }

  async ensureConversationForContact(contactId: string): Promise<Conversation> {
    const contact = await this.getContact(contactId);
    if (!contact) throw new Error("Contact not found");
    return this.upsertConversation({
      accountId: contact.accountId,
      contactId: contact.id,
      providerConversationId: contact.providerContactId
    });
  }

  async markConversationRead(id: string): Promise<void> {
    await this.database.query("UPDATE conversations SET unread_count=0,updated_at=$2 WHERE id=$1", [id, dbTime(now())]);
  }

  async getLastInboundAt(conversationId: string): Promise<string | null> {
    const result = await this.database.query<{ last_inbound_at: string | null }>(
      "SELECT MAX(occurred_at) AS last_inbound_at FROM messages WHERE conversation_id=$1 AND direction='inbound'",
      [conversationId]
    );
    return result.rows[0]?.last_inbound_at ?? null;
  }

  async findMessageByIdempotency(accountId: string, providerMessageId?: string, clientMessageId?: string): Promise<ChatMessage | null> {
    if (!providerMessageId && !clientMessageId) return null;
    const result = await this.database.query<{ id: string }>(
      `SELECT id FROM messages WHERE account_id=$1 AND
       (($2::text IS NOT NULL AND provider_message_id=$2) OR ($3::text IS NOT NULL AND client_message_id=$3)) LIMIT 1`,
      [accountId, providerMessageId ?? null, clientMessageId ?? null]
    );
    return result.rows[0] ? this.getMessage(result.rows[0].id) : null;
  }

  async createMessage(input: {
    accountId: string;
    conversationId: string;
    providerMessageId?: string | null;
    clientMessageId?: string | null;
    direction: "inbound" | "outbound";
    messageType?: ChatMessage["messageType"];
    body: string;
    status: MessageStatus;
    sourceLanguage?: string | null;
    occurredAt?: string;
    media?: { fileName: string; mimeType: string; sizeBytes: number } | null;
  }): Promise<ChatMessage> {
    const existing = await this.findMessageByIdempotency(
      input.accountId,
      input.providerMessageId ?? undefined,
      input.clientMessageId ?? undefined
    );
    if (existing) return existing;

    const id = randomUUID();
    const occurredAt = input.occurredAt ?? now();
    await this.database.query(
      this.database.kind === "mysql"
        ? `INSERT IGNORE INTO messages(id,account_id,conversation_id,provider_message_id,client_message_id,direction,message_type,body,status,source_language,occurred_at,created_at,media_file_name,media_mime_type,media_size_bytes)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`
        : `INSERT INTO messages(id,account_id,conversation_id,provider_message_id,client_message_id,direction,message_type,body,status,source_language,occurred_at,created_at,media_file_name,media_mime_type,media_size_bytes)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT DO NOTHING`,
      [
        id,
        input.accountId,
        input.conversationId,
        input.providerMessageId ?? null,
        input.clientMessageId ?? null,
        input.direction,
        input.messageType ?? "text",
        input.body,
        input.status,
        input.sourceLanguage ?? null,
        dbTime(occurredAt),
        dbTime(now()),
        input.media?.fileName ?? null,
        input.media?.mimeType ?? null,
        input.media?.sizeBytes ?? null
      ]
    );
    const inserted = await this.getMessage(id);
    if (!inserted) {
      const concurrent = await this.findMessageByIdempotency(
        input.accountId,
        input.providerMessageId ?? undefined,
        input.clientMessageId ?? undefined
      );
      if (concurrent) return concurrent;
      throw new Error("Message could not be claimed idempotently");
    }
    await this.database.query(
      `UPDATE conversations SET last_message_at=$2,updated_at=$2,
       unread_count=unread_count + CASE WHEN $3='inbound' THEN 1 ELSE 0 END WHERE id=$1`,
      [input.conversationId, dbTime(occurredAt), input.direction]
    );
    return inserted;
  }

  async updateMessageStatus(id: string, status: MessageStatus, providerMessageId?: string): Promise<ChatMessage> {
    await this.database.query(
      "UPDATE messages SET status=$2,provider_message_id=COALESCE($3,provider_message_id) WHERE id=$1",
      [id, status, providerMessageId ?? null]
    );
    return (await this.getMessage(id))!;
  }

  async updateMessageStatusMonotonic(id: string, status: MessageStatus): Promise<ChatMessage> {
    await this.database.query(
      `UPDATE messages SET status=$2
       WHERE id=$1
         AND status NOT IN ('read','failed')
         AND (
           ($2::text='failed' AND status IN ('queued','sending','unknown','accepted'))
           OR CASE $2::text
             WHEN 'queued' THEN 0
             WHEN 'sending' THEN 1
             WHEN 'unknown' THEN 1
             WHEN 'accepted' THEN 2
             WHEN 'delivered' THEN 3
             WHEN 'read' THEN 4
             ELSE -1
           END > CASE status
             WHEN 'queued' THEN 0
             WHEN 'sending' THEN 1
             WHEN 'unknown' THEN 1
             WHEN 'accepted' THEN 2
             WHEN 'delivered' THEN 3
             WHEN 'read' THEN 4
             ELSE -1
           END
         )`,
      [id, status]
    );
    const message = await this.getMessage(id);
    if (!message) throw new Error("Message not found");
    return message;
  }

  async updateMessageMediaStorage(id: string, storageKey: string, expiresAt: string): Promise<ChatMessage> {
    await this.database.query(
      "UPDATE messages SET media_storage_key=$2,media_expires_at=$3 WHERE id=$1 AND revoked_at IS NULL",
      [id, storageKey, dbTime(expiresAt)]
    );
    const message = await this.getMessage(id);
    if (!message) throw new Error("Message not found");
    return message;
  }

  async getMessageMediaStorage(id: string): Promise<{ storageKey: string; fileName: string; mimeType: string } | null> {
    const result = await this.database.query<{ media_storage_key: string | null; media_file_name: string | null; media_mime_type: string | null }>(
      "SELECT media_storage_key,media_file_name,media_mime_type FROM messages WHERE id=$1",
      [id]
    );
    const row = result.rows[0];
    if (!row?.media_storage_key || !row.media_file_name || !row.media_mime_type) return null;
    return { storageKey: row.media_storage_key, fileName: row.media_file_name, mimeType: row.media_mime_type };
  }

  async clearMessageMediaStorage(id: string): Promise<void> {
    await this.database.query(
      "UPDATE messages SET media_storage_key=NULL,media_expires_at=NULL WHERE id=$1",
      [id]
    );
  }

  async listExpiredMessageMedia(at = now()): Promise<Array<{ id: string; storageKey: string }>> {
    const result = await this.database.query<{ id: string; media_storage_key: string }>(
      "SELECT id,media_storage_key FROM messages WHERE media_storage_key IS NOT NULL AND media_expires_at IS NOT NULL AND media_expires_at <= $1",
      [dbTime(at)]
    );
    return result.rows.map((row) => ({ id: row.id, storageKey: row.media_storage_key }));
  }

  async markMessageRevoked(id: string): Promise<ChatMessage> {
    await this.database.query(
      `UPDATE messages SET revoked_at=$2,body='你撤回了一条消息',media_storage_key=NULL,media_expires_at=NULL,
       media_file_name=NULL,media_mime_type=NULL,media_size_bytes=NULL WHERE id=$1`,
      [id, dbTime(now())]
    );
    const message = await this.getMessage(id);
    if (!message) throw new Error("Message not found");
    return message;
  }

  async getMediaRetentionPolicy(ownerUserId?: string): Promise<MediaRetentionPolicy> {
    const result = await this.database.query<{ mode: MediaRetentionPolicy["mode"]; retention_days: number | string; updated_at: string }>(
      "SELECT mode,retention_days,updated_at FROM media_retention_settings WHERE id=$1",
      [ownerUserId ?? "default"]
    );
    const row = result.rows[0];
    if (!row && ownerUserId) {
      await this.database.query(
        this.database.kind === "mysql"
          ? `INSERT IGNORE INTO media_retention_settings(id,mode,retention_days,updated_at)
             VALUES($1,'immediate',0,$2)`
          : `INSERT INTO media_retention_settings(id,mode,retention_days,updated_at)
             VALUES($1,'immediate',0,$2)
             ON CONFLICT(id) DO NOTHING`,
        [ownerUserId, dbTime(now())]
      );
      return this.getMediaRetentionPolicy(ownerUserId);
    }
    return row
      ? { mode: row.mode, days: Number(row.retention_days), updatedAt: row.updated_at }
      : { mode: "immediate", days: 0, updatedAt: now() };
  }

  async updateMediaRetentionPolicy(mode: MediaRetentionPolicy["mode"], days: number, ownerUserId?: string): Promise<MediaRetentionPolicy> {
    const updatedAt = now();
    await this.database.query(
      this.database.kind === "mysql"
        ? `INSERT INTO media_retention_settings(id,mode,retention_days,updated_at) VALUES($4,$1,$2,$3)
           ON DUPLICATE KEY UPDATE mode=$1,retention_days=$2,updated_at=$3`
        : `INSERT INTO media_retention_settings(id,mode,retention_days,updated_at) VALUES($4,$1,$2,$3)
           ON CONFLICT(id) DO UPDATE SET mode=EXCLUDED.mode,retention_days=EXCLUDED.retention_days,updated_at=EXCLUDED.updated_at`,
      [mode, days, dbTime(updatedAt), ownerUserId ?? "default"]
    );
    return { mode, days, updatedAt };
  }

  async listMessages(conversationId: string, ownerUserId?: string): Promise<ChatMessage[]> {
    const result = await this.database.query<MessageTranslationRow>(
      `${this.messageSelect()} JOIN channel_accounts a ON a.id=m.account_id WHERE m.conversation_id=$1 AND ($2::text IS NULL OR a.owner_user_id=$2) ORDER BY m.occurred_at,t.created_at`,
      [conversationId, ownerUserId ?? null]
    );
    return this.assembleMessages(result.rows);
  }

  async getConversationAnalysis(conversationId: string, ownerUserId?: string): Promise<ConversationAnalysis | null> {
    const result = await this.database.query<ConversationAnalysisRow>(
      `SELECT x.* FROM conversation_analyses x
       JOIN channel_accounts a ON a.id=x.account_id
       WHERE x.conversation_id=$1 AND ($2::text IS NULL OR a.owner_user_id=$2)`,
      [conversationId, ownerUserId ?? null]
    );
    return result.rows[0] ? mapConversationAnalysis(result.rows[0]) : null;
  }

  async listConversationFollowups(conversationId: string, ownerUserId?: string): Promise<ConversationFollowUp[]> {
    const result = await this.database.query<ConversationFollowUpRow>(
      `SELECT f.* FROM conversation_followups f
       JOIN channel_accounts a ON a.id=(SELECT account_id FROM conversations WHERE id=f.conversation_id)
       WHERE f.conversation_id=$1 AND ($2::text IS NULL OR a.owner_user_id=$2)
       ORDER BY CASE f.status WHEN 'pending' THEN 0 ELSE 1 END,f.due_at,f.created_at`,
      [conversationId, ownerUserId ?? null]
    );
    return result.rows.map(mapConversationFollowUp);
  }

  async listConversationTraitFeedback(conversationId: string, ownerUserId?: string): Promise<ConversationTraitFeedback[]> {
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT f.* FROM conversation_trait_feedback f
       JOIN conversations c ON c.id=f.conversation_id JOIN channel_accounts a ON a.id=c.account_id
       WHERE f.conversation_id=$1 AND ($2::text IS NULL OR a.owner_user_id=$2)
       ORDER BY f.updated_at DESC`,
      [conversationId, ownerUserId ?? null]
    );
    return result.rows.map((row) => ({
      id: String(row.id), conversationId: String(row.conversation_id), traitKey: String(row.trait_key), traitLabel: String(row.trait_label),
      verdict: String(row.verdict) as ConversationTraitFeedback["verdict"], correctionText: row.correction_text == null ? null : String(row.correction_text),
      actorUserId: String(row.actor_user_id), createdAt: new Date(String(row.created_at)).toISOString(), updatedAt: new Date(String(row.updated_at)).toISOString()
    }));
  }

  async saveConversationTraitFeedback(input: { conversationId: string; traitKey: string; traitLabel: string; verdict: ConversationTraitFeedback["verdict"]; correctionText?: string | null; actorUserId: string }): Promise<ConversationTraitFeedback> {
    const id = randomUUID();
    const timestamp = dbTime(now());
    await this.database.query(
      this.database.kind === "mysql"
        ? `INSERT INTO conversation_trait_feedback(id,conversation_id,trait_key,trait_label,verdict,correction_text,actor_user_id,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
           ON DUPLICATE KEY UPDATE trait_label=$4,verdict=$5,correction_text=$6,actor_user_id=$7,updated_at=$8`
        : `INSERT INTO conversation_trait_feedback(id,conversation_id,trait_key,trait_label,verdict,correction_text,actor_user_id,created_at,updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8)
           ON CONFLICT(conversation_id,trait_key) DO UPDATE SET trait_label=EXCLUDED.trait_label,verdict=EXCLUDED.verdict,
             correction_text=EXCLUDED.correction_text,actor_user_id=EXCLUDED.actor_user_id,updated_at=EXCLUDED.updated_at`,
      [id, input.conversationId, input.traitKey, input.traitLabel, input.verdict, input.correctionText?.trim() || null, input.actorUserId, timestamp]
    );
    return (await this.listConversationTraitFeedback(input.conversationId)).find((item) => item.traitKey === input.traitKey)!;
  }

  async deleteConversationTraitFeedback(conversationId: string, traitKey: string, ownerUserId?: string): Promise<boolean> {
    const existing = (await this.listConversationTraitFeedback(conversationId, ownerUserId)).find((item) => item.traitKey === traitKey);
    if (!existing) return false;
    await this.database.query("DELETE FROM conversation_trait_feedback WHERE conversation_id=$1 AND trait_key=$2", [conversationId, traitKey]);
    return true;
  }

  async restoreConversationFollowupsByTraitKey(conversationId: string, traitKey: string): Promise<void> {
    await this.database.query(
      `UPDATE conversation_followups SET status='pending',updated_at=$3
       WHERE conversation_id=$1 AND status='dismissed' AND source_key LIKE $2`,
      [conversationId, `${traitKey}:%`, dbTime(now())]
    );
  }

  async saveConversationAnalysis(input: {
    id: string;
    conversationId: string;
    accountId: string;
    status: ConversationAnalysis["status"];
    summary: string;
    keyPoints: string[];
    traits: ConversationTrait[];
    buyingIntent: ConversationAnalysis["buyingIntent"];
    riskLevel: ConversationAnalysis["riskLevel"];
    nextAction: string;
    sourceMessageCount: number;
    engine: ConversationAnalysis["engine"];
    model: string | null;
    promptVersion: string;
    error?: string | null;
    followups: Array<{
      sourceKey: string;
      title: string;
      reason: string;
      priority: ConversationFollowUp["priority"];
      dueAt: string;
      evidenceMessageIds: string[];
    }>;
  }): Promise<{ analysis: ConversationAnalysis; followups: ConversationFollowUp[] }> {
    const timestamp = dbTime(now());
    await this.database.query(
      this.database.kind === "mysql"
        ? `INSERT INTO conversation_analyses(
             id,conversation_id,account_id,status,summary,key_points_json,traits_json,buying_intent,risk_level,next_action,
             source_message_count,engine,model,prompt_version,error,generated_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
           ON DUPLICATE KEY UPDATE status=$4,summary=$5,key_points_json=$6,traits_json=$7,buying_intent=$8,risk_level=$9,
             next_action=$10,source_message_count=$11,engine=$12,model=$13,prompt_version=$14,error=$15,generated_at=$16,updated_at=$16`
        : `INSERT INTO conversation_analyses(
             id,conversation_id,account_id,status,summary,key_points_json,traits_json,buying_intent,risk_level,next_action,
             source_message_count,engine,model,prompt_version,error,generated_at,updated_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
           ON CONFLICT(conversation_id) DO UPDATE SET status=EXCLUDED.status,summary=EXCLUDED.summary,
             key_points_json=EXCLUDED.key_points_json,traits_json=EXCLUDED.traits_json,buying_intent=EXCLUDED.buying_intent,
             risk_level=EXCLUDED.risk_level,next_action=EXCLUDED.next_action,source_message_count=EXCLUDED.source_message_count,
             engine=EXCLUDED.engine,model=EXCLUDED.model,prompt_version=EXCLUDED.prompt_version,
             error=EXCLUDED.error,generated_at=EXCLUDED.generated_at,updated_at=EXCLUDED.updated_at`,
      [
        input.id,
        input.conversationId,
        input.accountId,
        input.status,
        input.summary,
        JSON.stringify(input.keyPoints),
        JSON.stringify(input.traits),
        input.buyingIntent,
        input.riskLevel,
        input.nextAction,
        input.sourceMessageCount,
        input.engine,
        input.model,
        input.promptVersion,
        input.error ?? null,
        timestamp
      ]
    );
    const analysis = (await this.database.query<ConversationAnalysisRow>(
      "SELECT * FROM conversation_analyses WHERE conversation_id=$1",
      [input.conversationId]
    )).rows[0];
    if (!analysis) throw new Error("Conversation analysis was not persisted");
    const activeSourceKeys = input.followups.map((followup) => followup.sourceKey);
    await this.database.query(
      activeSourceKeys.length
        ? `UPDATE conversation_followups SET status='dismissed',updated_at=$2
           WHERE conversation_id=$1 AND status='pending' AND source_key NOT IN (${activeSourceKeys.map((_, index) => `$${index + 3}`).join(",")})`
        : `UPDATE conversation_followups SET status='dismissed',updated_at=$2
           WHERE conversation_id=$1 AND status='pending'`,
      [input.conversationId, timestamp, ...activeSourceKeys]
    );
    for (const followup of input.followups) {
      await this.database.query(
        this.database.kind === "mysql"
          ? `INSERT INTO conversation_followups(
               id,conversation_id,analysis_id,source_key,title,reason,priority,due_at,status,evidence_message_ids_json,created_at,updated_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$10)
             ON DUPLICATE KEY UPDATE analysis_id=$3,title=$5,reason=$6,priority=$7,due_at=$8,evidence_message_ids_json=$9,updated_at=$10`
          : `INSERT INTO conversation_followups(
               id,conversation_id,analysis_id,source_key,title,reason,priority,due_at,status,evidence_message_ids_json,created_at,updated_at
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$10)
             ON CONFLICT(conversation_id,source_key) DO UPDATE SET analysis_id=EXCLUDED.analysis_id,title=EXCLUDED.title,
               reason=EXCLUDED.reason,priority=EXCLUDED.priority,due_at=EXCLUDED.due_at,
               evidence_message_ids_json=EXCLUDED.evidence_message_ids_json,updated_at=EXCLUDED.updated_at
             WHERE conversation_followups.status='pending'`,
        [
          randomUUID(),
          input.conversationId,
          analysis.id,
          followup.sourceKey,
          followup.title,
          followup.reason,
          followup.priority,
          dbTime(followup.dueAt),
          JSON.stringify(followup.evidenceMessageIds),
          timestamp
        ]
      );
    }
    return {
      analysis: mapConversationAnalysis(analysis),
      followups: await this.listConversationFollowups(input.conversationId)
    };
  }

  async updateConversationFollowupStatus(
    id: string,
    status: ConversationFollowUp["status"],
    ownerUserId?: string
  ): Promise<ConversationFollowUp | null> {
    await this.database.query(
      `UPDATE conversation_followups f SET status=$2,updated_at=$3
       WHERE f.id=$1 AND EXISTS (
         SELECT 1 FROM conversations c JOIN channel_accounts a ON a.id=c.account_id
         WHERE c.id=f.conversation_id AND ($4::text IS NULL OR a.owner_user_id=$4)
       )`,
      [id, status, dbTime(now()), ownerUserId ?? null]
    );
    const result = await this.database.query<ConversationFollowUpRow>(
      `SELECT f.* FROM conversation_followups f
       JOIN conversations c ON c.id=f.conversation_id JOIN channel_accounts a ON a.id=c.account_id
       WHERE f.id=$1 AND ($2::text IS NULL OR a.owner_user_id=$2)`,
      [id, ownerUserId ?? null]
    );
    return result.rows[0] ? mapConversationFollowUp(result.rows[0]) : null;
  }

  async getMessage(id: string, ownerUserId?: string): Promise<ChatMessage | null> {
    const result = await this.database.query<MessageTranslationRow>(`${this.messageSelect()} JOIN channel_accounts a ON a.id=m.account_id WHERE m.id=$1 AND ($2::text IS NULL OR a.owner_user_id=$2) ORDER BY t.created_at`, [id, ownerUserId ?? null]);
    return this.assembleMessages(result.rows)[0] ?? null;
  }

  async getMessageOwnerUserId(messageId: string): Promise<string | null> {
    const result = await this.database.query<{ owner_user_id: string | null }>(
      "SELECT a.owner_user_id FROM messages m JOIN channel_accounts a ON a.id=m.account_id WHERE m.id=$1",
      [messageId]
    );
    return result.rows[0]?.owner_user_id ?? null;
  }

  private messageSelect(): string {
    return `SELECT m.*,
      t.id AS translation_id,t.target_language,t.source_language AS translation_source_language,t.profile_id,
      t.model AS translation_model,t.trigger_type,t.status AS translation_status,t.translated_text,
      t.error AS translation_error,t.token_usage,t.created_at AS translation_created_at,t.updated_at AS translation_updated_at
      FROM messages m LEFT JOIN translations t ON t.message_id=m.id`;
  }

  private assembleMessages(rows: MessageTranslationRow[]): ChatMessage[] {
    const messages = new Map<string, ChatMessage>();
    for (const row of rows) {
      let message = messages.get(row.id);
      if (!message) {
        message = {
          id: row.id,
          accountId: row.account_id,
          conversationId: row.conversation_id,
          providerMessageId: row.provider_message_id,
          clientMessageId: row.client_message_id,
          direction: row.direction,
          messageType: row.message_type,
          body: row.body,
          status: row.status,
          sourceLanguage: row.source_language,
          occurredAt: row.occurred_at,
          createdAt: row.created_at,
          revokedAt: row.revoked_at,
          media: row.media_file_name && row.media_mime_type && row.media_size_bytes !== null
            ? {
                fileName: row.media_file_name,
                mimeType: row.media_mime_type,
                sizeBytes: Number(row.media_size_bytes),
                available: Boolean(row.media_storage_key),
                expiresAt: row.media_expires_at
              }
            : null,
          translations: []
        };
        messages.set(row.id, message);
      }
      if (row.translation_id && row.profile_id && row.target_language && row.translation_model && row.trigger_type && row.translation_status) {
        message.translations.push({
          id: row.translation_id,
          messageId: row.id,
          sourceLanguage: row.translation_source_language,
          targetLanguage: row.target_language,
          profileId: row.profile_id,
          model: row.translation_model,
          trigger: row.trigger_type,
          status: row.translation_status,
          translatedText: row.translated_text,
          error: row.translation_error,
          tokenUsage: Number(row.token_usage ?? 0),
          createdAt: row.translation_created_at!,
          updatedAt: row.translation_updated_at!
        });
      }
    }
    return [...messages.values()];
  }

  async listAiProfiles(ownerUserId?: string): Promise<AiProviderProfile[]> {
    const result = await this.database.query<AiProfileRow>("SELECT * FROM ai_provider_profiles WHERE enabled=1 AND ($1::text IS NULL OR owner_user_id=$1) ORDER BY created_at", [ownerUserId ?? null]);
    return result.rows.map(mapAiProfile);
  }

  async getAiProfile(id: string, ownerUserId?: string): Promise<(AiProviderProfile & { apiKeyCipher: string | null }) | null> {
    const result = await this.database.query<AiProfileRow>("SELECT * FROM ai_provider_profiles WHERE id=$1 AND enabled=1 AND ($2::text IS NULL OR owner_user_id=$2)", [id, ownerUserId ?? null]);
    const row = result.rows[0];
    return row ? { ...mapAiProfile(row), apiKeyCipher: row.api_key_cipher } : null;
  }

  async createAiProfile(input: {
    name: string;
    kind: "mock" | "openai";
    baseUrl?: string | null;
    apiKeyCipher?: string | null;
    apiKeyMask?: string | null;
    model: string;
    ownerUserId?: string;
  }): Promise<AiProviderProfile> {
    const id = randomUUID();
    const timestamp = now();
    await this.database.query(
      `INSERT INTO ai_provider_profiles(id,name,kind,base_url,api_key_cipher,api_key_mask,model,enabled,last_test_status,owner_user_id,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,1,'untested',$8,$9,$9)`,
      [id, input.name, input.kind, input.baseUrl ?? null, input.apiKeyCipher ?? null, input.apiKeyMask ?? null, input.model, input.ownerUserId ?? null, dbTime(timestamp)]
    );
    return (await this.getAiProfile(id, input.ownerUserId))!;
  }

  async updateAiProfileTest(id: string, status: "success" | "failed", error: string | null): Promise<void> {
    await this.database.query(
      "UPDATE ai_provider_profiles SET last_test_status=$2,last_test_error=$3,updated_at=$4 WHERE id=$1",
      [id, status, error, dbTime(now())]
    );
  }

  async deleteAiProfile(id: string, ownerUserId?: string): Promise<boolean> {
    const existing = await this.getAiProfile(id, ownerUserId);
    if (!existing) return false;
    await this.database.query(
      `UPDATE ai_provider_profiles
       SET enabled=0,base_url=NULL,api_key_cipher=NULL,api_key_mask=NULL,last_test_error=NULL,updated_at=$2
       WHERE id=$1 AND enabled=1 AND ($3::text IS NULL OR owner_user_id=$3)`,
      [id, dbTime(now()), ownerUserId ?? null]
    );
    return true;
  }

  async getTranslationPreference(ownerUserId?: string): Promise<TranslationPreference> {
    const result = await this.database.query<{
      auto_translate: number;
      target_language: string;
      provider_id: string | null;
      crm_auto_create: number;
    }>("SELECT auto_translate,target_language,provider_id,crm_auto_create FROM translation_preferences WHERE id=$1", [ownerUserId ?? "default"]);
    const row = result.rows[0];
    if (!row && ownerUserId) {
      await this.database.query(
        this.database.kind === "mysql"
          ? `INSERT IGNORE INTO translation_preferences(id,auto_translate,target_language,provider_id,crm_auto_create,updated_at)
             SELECT $1,auto_translate,target_language,provider_id,crm_auto_create,updated_at FROM translation_preferences WHERE id='default'`
          : `INSERT INTO translation_preferences(id,auto_translate,target_language,provider_id,crm_auto_create,updated_at)
             SELECT $1,auto_translate,target_language,provider_id,crm_auto_create,updated_at FROM translation_preferences WHERE id='default'
             ON CONFLICT(id) DO NOTHING`,
        [ownerUserId]
      );
      return this.getTranslationPreference(ownerUserId);
    }
    if (!row) throw new Error("Translation preference is not initialized");
    return {
      autoTranslate: toBoolean(row.auto_translate),
      targetLanguage: row.target_language,
      providerId: row.provider_id,
      crmAutoCreate: toBoolean(row.crm_auto_create)
    };
  }

  async updateTranslationPreference(input: Partial<TranslationPreference>, ownerUserId?: string): Promise<TranslationPreference> {
    const current = await this.getTranslationPreference(ownerUserId);
    const next = { ...current, ...input };
    await this.database.query(
      `UPDATE translation_preferences SET auto_translate=$1,target_language=$2,provider_id=$3,crm_auto_create=$4,updated_at=$5
       WHERE id=$6`,
      [next.autoTranslate ? 1 : 0, next.targetLanguage, next.providerId, next.crmAutoCreate ? 1 : 0, dbTime(now()), ownerUserId ?? "default"]
    );
    return next;
  }

  async createPendingTranslation(input: {
    messageId: string;
    sourceLanguage: string | null;
    targetLanguage: string;
    profileId: string;
    model: string;
    trigger: "automatic" | "manual";
  }): Promise<Translation> {
    const existing = await this.database.query<{ id: string }>(
      `SELECT id FROM translations WHERE message_id=$1 AND target_language=$2 AND profile_id=$3 AND prompt_version='translate-v1'`,
      [input.messageId, input.targetLanguage, input.profileId]
    );
    if (existing.rows[0]) return (await this.getTranslation(existing.rows[0].id))!;

    const id = randomUUID();
    const timestamp = now();
    await this.database.query(
      `INSERT INTO translations(id,message_id,source_language,target_language,profile_id,model,trigger_type,status,prompt_version,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'pending','translate-v1',$8,$8)`,
      [id, input.messageId, input.sourceLanguage, input.targetLanguage, input.profileId, input.model, input.trigger, dbTime(timestamp)]
    );
    return (await this.getTranslation(id))!;
  }

  async getTranslation(id: string): Promise<Translation | null> {
    const result = await this.database.query<{
      id: string;
      message_id: string;
      source_language: string | null;
      target_language: string;
      profile_id: string;
      model: string;
      trigger_type: Translation["trigger"];
      status: Translation["status"];
      translated_text: string | null;
      error: string | null;
      token_usage: number;
      created_at: string;
      updated_at: string;
    }>("SELECT * FROM translations WHERE id=$1", [id]);
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          messageId: row.message_id,
          sourceLanguage: row.source_language,
          targetLanguage: row.target_language,
          profileId: row.profile_id,
          model: row.model,
          trigger: row.trigger_type,
          status: row.status,
          translatedText: row.translated_text,
          error: row.error,
          tokenUsage: Number(row.token_usage),
          createdAt: row.created_at,
          updatedAt: row.updated_at
        }
      : null;
  }

  async completeTranslation(id: string, translatedText: string, tokenUsage: number): Promise<Translation> {
    await this.database.query(
      "UPDATE translations SET status='translated',translated_text=$2,error=NULL,token_usage=$3,updated_at=$4 WHERE id=$1",
      [id, translatedText, tokenUsage, dbTime(now())]
    );
    return (await this.getTranslation(id))!;
  }

  async failTranslation(id: string, error: string): Promise<Translation> {
    await this.database.query(
      "UPDATE translations SET status='failed',error=$2,updated_at=$3 WHERE id=$1",
      [id, error, dbTime(now())]
    );
    return (await this.getTranslation(id))!;
  }

  async listRoutingRules(ownerUserId?: string): Promise<RoutingRule[]> {
    const result = await this.database.query<{
      id: string;
      name: string;
      lead_type: string;
      region: string;
      preferred_account_id: string;
      fallback_account_id: string | null;
      priority: number;
      enabled: number;
      created_at: string;
      updated_at: string;
    }>("SELECT * FROM routing_rules WHERE ($1::text IS NULL OR owner_user_id=$1) ORDER BY priority,created_at", [ownerUserId ?? null]);
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      leadType: row.lead_type,
      region: row.region,
      preferredAccountId: row.preferred_account_id,
      fallbackAccountId: row.fallback_account_id,
      priority: Number(row.priority),
      enabled: toBoolean(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async createRoutingRule(input: Omit<RoutingRule, "id" | "createdAt" | "updatedAt"> & { ownerUserId?: string }): Promise<RoutingRule> {
    const id = randomUUID();
    const timestamp = now();
    await this.database.query(
      `INSERT INTO routing_rules(id,name,lead_type,region,preferred_account_id,fallback_account_id,priority,enabled,owner_user_id,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
      [id, input.name, input.leadType, input.region, input.preferredAccountId, input.fallbackAccountId, input.priority, input.enabled ? 1 : 0, input.ownerUserId ?? null, dbTime(timestamp)]
    );
    return (await this.listRoutingRules(input.ownerUserId)).find((item) => item.id === id)!;
  }

  async getRoutingRule(id: string, ownerUserId?: string): Promise<RoutingRule | null> {
    return (await this.listRoutingRules(ownerUserId)).find((item) => item.id === id) ?? null;
  }

  async updateRoutingRule(
    id: string,
    input: Omit<RoutingRule, "id" | "createdAt" | "updatedAt">,
    ownerUserId?: string
  ): Promise<RoutingRule | null> {
    const existing = await this.getRoutingRule(id, ownerUserId);
    if (!existing) return null;
    await this.database.query(
      `UPDATE routing_rules SET name=$2,lead_type=$3,region=$4,preferred_account_id=$5,
       fallback_account_id=$6,priority=$7,enabled=$8,updated_at=$9 WHERE id=$1 AND ($10::text IS NULL OR owner_user_id=$10)`,
      [
        id,
        input.name,
        input.leadType,
        input.region,
        input.preferredAccountId,
        input.fallbackAccountId,
        input.priority,
        input.enabled ? 1 : 0,
        dbTime(now()),
        ownerUserId ?? null
      ]
    );
    return this.getRoutingRule(id, ownerUserId);
  }

  async deleteRoutingRule(id: string, ownerUserId?: string): Promise<boolean> {
    const existing = await this.getRoutingRule(id, ownerUserId);
    if (!existing) return false;
    await this.database.query(
      "DELETE FROM routing_rules WHERE id=$1 AND ($2::text IS NULL OR owner_user_id=$2)",
      [id, ownerUserId ?? null]
    );
    return true;
  }

  async resolveRouting(leadType: string, region: string, ownerUserId?: string): Promise<RoutingResolution> {
    const rules = await this.listRoutingRules(ownerUserId);
    const rule = rules.find((item) => item.enabled && (!item.leadType || item.leadType === leadType) && (!item.region || item.region === region)) ?? null;
    const preferred = rule ? await this.getAccount(rule.preferredAccountId, ownerUserId) : null;
    const fallback = rule?.fallbackAccountId ? await this.getAccount(rule.fallbackAccountId, ownerUserId) : null;
    const account = preferred?.status === "connected"
      ? preferred
      : fallback?.status === "connected"
        ? fallback
        : null;
    return {
      rule,
      preferred,
      fallback,
      account,
      selectionReason: !rule
        ? null
        : preferred?.status === "connected"
          ? "preferred_online"
          : fallback?.status === "connected"
            ? "fallback_online"
            : "no_online_account"
    };
  }

  async listCrmContacts(ownerUserId?: string): Promise<CrmSandboxContact[]> {
    const result = await this.database.query<{
      id: string;
      phone: string;
      name: string;
      source: string;
      source_contact_id: string;
      created_at: string;
    }>(`SELECT crm.* FROM crm_contacts crm
        LEFT JOIN contacts source_contact ON source_contact.id=crm.source_contact_id
        LEFT JOIN channel_accounts source_account ON source_account.id=source_contact.account_id
        WHERE ($1::text IS NULL OR source_account.owner_user_id=$1)
        ORDER BY crm.created_at DESC`, [ownerUserId ?? null]);
    return result.rows.map((row) => ({
      id: row.id,
      phone: row.phone,
      name: row.name,
      source: row.source,
      sourceContactId: row.source_contact_id,
      createdAt: row.created_at
    }));
  }

  async getCrmContact(id: string, ownerUserId?: string): Promise<CrmSandboxContact | null> {
    return (await this.listCrmContacts(ownerUserId)).find((item) => item.id === id) ?? null;
  }

  async createCrmContact(contactId: string): Promise<CrmSandboxContact> {
    const contact = await this.getContact(contactId);
    if (!contact) throw new Error("Contact not found");
    const id = randomUUID();
    await this.database.query(
      this.database.kind === "mysql"
        ? `INSERT INTO crm_contacts(id,phone,name,source,source_contact_id,created_at)
           VALUES($1,$2,$3,$4,$5,$6)
           ON DUPLICATE KEY UPDATE name=$3`
        : `INSERT INTO crm_contacts(id,phone,name,source,source_contact_id,created_at)
           VALUES($1,$2,$3,$4,$5,$6)
           ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name`,
      [id, contact.phone, contact.displayName, contact.source, contact.id, dbTime(now())]
    );
    return (await this.listCrmContacts()).find((item) => item.phone === contact.phone)!;
  }

  async upsertExternalCrmContact(contactId: string, input: { id: string; name: string; phone: string }): Promise<CrmSandboxContact> {
    const contact = await this.getContact(contactId);
    if (!contact) throw new Error("Contact not found");
    const id = randomUUID();
    await this.database.query(
      this.database.kind === "mysql"
        ? `INSERT INTO crm_contacts(id,phone,name,source,source_contact_id,created_at)
           VALUES($1,$2,$3,'goodjob_crm',$4,$5)
           ON DUPLICATE KEY UPDATE name=$3,source='goodjob_crm',source_contact_id=$4`
        : `INSERT INTO crm_contacts(id,phone,name,source,source_contact_id,created_at)
           VALUES($1,$2,$3,'goodjob_crm',$4,$5)
           ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name,source='goodjob_crm',source_contact_id=EXCLUDED.source_contact_id`,
      [id, input.phone, input.name, input.id, dbTime(now())]
    );
    return (await this.listCrmContacts()).find((item) => item.phone === input.phone)!;
  }

  async audit(action: string, targetType: string, targetId: string, result: string, details: object = {}): Promise<void> {
    await this.database.query(
      "INSERT INTO audit_logs(id,action,target_type,target_id,result,details_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), action, targetType, targetId, result, JSON.stringify(details), dbTime(now())]
    );
  }
}
