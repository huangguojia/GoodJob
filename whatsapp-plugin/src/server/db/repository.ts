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
             SELECT $1,strategy,default_provider,updated_at FROM integration_preferences WHERE id='default'`
          : `INSERT INTO integration_preferences(id,strategy,default_provider,updated_at)
             SELECT $1,strategy,default_provider,updated_at FROM integration_preferences WHERE id='default'
             ON CONFLICT(id) DO NOTHING`,
        [ownerUserId]
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
             SELECT $1,mode,retention_days,updated_at FROM media_retention_settings WHERE id='default'`
          : `INSERT INTO media_retention_settings(id,mode,retention_days,updated_at)
             SELECT $1,mode,retention_days,updated_at FROM media_retention_settings WHERE id='default'
             ON CONFLICT(id) DO NOTHING`,
        [ownerUserId]
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

  async audit(action: string, targetType: string, targetId: string, result: string, details: object = {}): Promise<void> {
    await this.database.query(
      "INSERT INTO audit_logs(id,action,target_type,target_id,result,details_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), action, targetType, targetId, result, JSON.stringify(details), dbTime(now())]
    );
  }
}
