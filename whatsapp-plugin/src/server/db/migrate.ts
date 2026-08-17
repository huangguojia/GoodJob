import type { Database, DatabaseTransaction } from "./database.js";
import { migrateMysql } from "./mysql-migrate.js";

const initialSchema = `
CREATE TABLE IF NOT EXISTS channel_accounts (
  id text PRIMARY KEY,
  name text NOT NULL,
  provider text NOT NULL,
  phone text,
  avatar_url text,
  status text NOT NULL,
  purpose_label text NOT NULL DEFAULT '',
  lead_types_json text NOT NULL DEFAULT '[]',
  region text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 100,
  risk_accepted integer NOT NULL DEFAULT 0,
  last_connected_at timestamptz,
  last_event_at timestamptz,
  last_error text,
  qr_data_url text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_session_keys (
  account_id text NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  key_type text NOT NULL,
  key_id text NOT NULL,
  cipher_text text NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, key_type, key_id)
);

CREATE TABLE IF NOT EXISTS integration_preferences (
  id text PRIMARY KEY,
  strategy text NOT NULL,
  default_provider text NOT NULL,
  updated_at timestamptz NOT NULL
);
INSERT INTO integration_preferences(id,strategy,default_provider,updated_at)
VALUES('default','free_first','baileys',CURRENT_TIMESTAMP)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS meta_app_configs (
  id text PRIMARY KEY,
  name text NOT NULL,
  app_id text NOT NULL UNIQUE,
  app_secret_cipher text NOT NULL,
  app_secret_mask text NOT NULL,
  verify_token_digest text NOT NULL,
  verify_token_mask text NOT NULL,
  webhook_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS meta_account_credentials (
  account_id text PRIMARY KEY REFERENCES channel_accounts(id) ON DELETE CASCADE,
  app_config_id text NOT NULL REFERENCES meta_app_configs(id),
  waba_id text NOT NULL,
  phone_number_id text NOT NULL UNIQUE,
  access_token_cipher text NOT NULL,
  access_token_mask text NOT NULL,
  graph_api_version text NOT NULL,
  display_phone_number text,
  verified_name text,
  quality_rating text,
  sending_enabled integer NOT NULL DEFAULT 0,
  last_verified_at timestamptz,
  last_webhook_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS meta_account_credentials_app_idx ON meta_account_credentials(app_config_id);

CREATE TABLE IF NOT EXISTS contacts (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  provider_contact_id text NOT NULL,
  display_name text NOT NULL,
  phone text NOT NULL,
  avatar_url text,
  source text NOT NULL,
  origin text NOT NULL DEFAULT 'whatsapp_sync',
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (account_id, provider_contact_id)
);
CREATE INDEX IF NOT EXISTS contacts_account_phone_idx ON contacts(account_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS contacts_account_phone_unique ON contacts(account_id, phone);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'whatsapp_sync';

CREATE TABLE IF NOT EXISTS conversations (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  contact_id text NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  provider_conversation_id text NOT NULL,
  unread_count integer NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (account_id, provider_conversation_id)
);
CREATE INDEX IF NOT EXISTS conversations_account_last_idx ON conversations(account_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider_message_id text,
  client_message_id text,
  direction text NOT NULL,
  message_type text NOT NULL,
  body text NOT NULL,
  status text NOT NULL,
  source_language text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_unique ON messages(account_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_unique ON messages(account_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_conversation_time_idx ON messages(conversation_id, occurred_at);

CREATE TABLE IF NOT EXISTS ai_provider_profiles (
  id text PRIMARY KEY,
  name text NOT NULL,
  kind text NOT NULL,
  base_url text,
  api_key_cipher text,
  api_key_mask text,
  model text NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  last_test_status text NOT NULL DEFAULT 'untested',
  last_test_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS translation_preferences (
  id text PRIMARY KEY,
  auto_translate integer NOT NULL DEFAULT 0,
  target_language text NOT NULL DEFAULT 'zh-CN',
  provider_id text REFERENCES ai_provider_profiles(id),
  crm_auto_create integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS translations (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_language text,
  target_language text NOT NULL,
  profile_id text NOT NULL REFERENCES ai_provider_profiles(id),
  model text NOT NULL,
  trigger_type text NOT NULL,
  status text NOT NULL,
  translated_text text,
  error text,
  prompt_version text NOT NULL,
  token_usage integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (message_id, target_language, profile_id, prompt_version)
);

CREATE TABLE IF NOT EXISTS routing_rules (
  id text PRIMARY KEY,
  name text NOT NULL,
  lead_type text NOT NULL DEFAULT '',
  region text NOT NULL DEFAULT '',
  preferred_account_id text NOT NULL REFERENCES channel_accounts(id),
  fallback_account_id text REFERENCES channel_accounts(id),
  priority integer NOT NULL DEFAULT 100,
  enabled integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS crm_contacts (
  id text PRIMARY KEY,
  phone text NOT NULL UNIQUE,
  name text NOT NULL,
  source text NOT NULL,
  source_contact_id text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id text PRIMARY KEY,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  result text NOT NULL,
  details_json text NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL
);

DELETE FROM contacts
WHERE provider_contact_id = '0@s.whatsapp.net' AND phone = '+0';
`;

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: initialSchema
  },
  {
    version: 2,
    name: "optional_translation_provider",
    sql: `
      ALTER TABLE translation_preferences ALTER COLUMN provider_id DROP NOT NULL;
      ALTER TABLE translation_preferences ALTER COLUMN auto_translate SET DEFAULT 0;
      INSERT INTO translation_preferences(id,auto_translate,target_language,provider_id,crm_auto_create,updated_at)
      VALUES('default',0,'zh-CN',NULL,0,CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO NOTHING;
    `
  },
  {
    version: 3,
    name: "message_media_and_retention",
    sql: `
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_file_name text;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_mime_type text;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_size_bytes bigint;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_storage_key text;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_expires_at timestamptz;
      ALTER TABLE messages ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
      CREATE INDEX IF NOT EXISTS messages_media_expiry_idx
        ON messages(media_expires_at) WHERE media_storage_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS media_retention_settings (
        id text PRIMARY KEY,
        mode text NOT NULL,
        retention_days integer NOT NULL,
        updated_at timestamptz NOT NULL
      );
      INSERT INTO media_retention_settings(id,mode,retention_days,updated_at)
      VALUES('default','immediate',0,CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO NOTHING;
    `
  },
  {
    version: 4,
    name: "personal_account_ownership",
    sql: `
      ALTER TABLE channel_accounts ADD COLUMN IF NOT EXISTS owner_user_id text;
      CREATE INDEX IF NOT EXISTS channel_accounts_owner_idx ON channel_accounts(owner_user_id);
    `
  },
  {
    version: 5,
    name: "personal_whatsapp_configuration_ownership",
    sql: `
      ALTER TABLE ai_provider_profiles ADD COLUMN IF NOT EXISTS owner_user_id text;
      ALTER TABLE meta_app_configs ADD COLUMN IF NOT EXISTS owner_user_id text;
      ALTER TABLE routing_rules ADD COLUMN IF NOT EXISTS owner_user_id text;
      CREATE INDEX IF NOT EXISTS ai_provider_profiles_owner_idx ON ai_provider_profiles(owner_user_id);
      CREATE INDEX IF NOT EXISTS meta_app_configs_owner_idx ON meta_app_configs(owner_user_id);
      CREATE INDEX IF NOT EXISTS routing_rules_owner_idx ON routing_rules(owner_user_id);
    `
  },
  {
    version: 6,
    name: "durable_meta_webhook_inbox",
    sql: `
      CREATE TABLE IF NOT EXISTS meta_webhook_events (
        id text PRIMARY KEY,
        app_config_id text NOT NULL REFERENCES meta_app_configs(id) ON DELETE CASCADE,
        event_hash text NOT NULL,
        payload_cipher text NOT NULL,
        status text NOT NULL CHECK (status IN ('pending','processing','processed','failed')),
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        received_at timestamptz NOT NULL,
        processing_started_at timestamptz,
        processed_at timestamptz,
        updated_at timestamptz NOT NULL,
        UNIQUE (app_config_id, event_hash)
      );
      CREATE INDEX IF NOT EXISTS meta_webhook_events_recovery_idx
        ON meta_webhook_events(status, received_at);
    `
  },
  {
    version: 7,
    name: "conversation_intelligence_and_followups",
    sql: `
      CREATE TABLE IF NOT EXISTS conversation_analyses (
        id text PRIMARY KEY,
        conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        account_id text NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
        status text NOT NULL CHECK (status IN ('ready','failed')),
        summary text NOT NULL,
        key_points_json text NOT NULL DEFAULT '[]',
        traits_json text NOT NULL DEFAULT '[]',
        buying_intent text NOT NULL,
        risk_level text NOT NULL,
        next_action text NOT NULL,
        source_message_count integer NOT NULL DEFAULT 0,
        error text,
        generated_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (conversation_id)
      );
      CREATE INDEX IF NOT EXISTS conversation_analyses_account_idx
        ON conversation_analyses(account_id, updated_at);

      CREATE TABLE IF NOT EXISTS conversation_followups (
        id text PRIMARY KEY,
        conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        analysis_id text NOT NULL REFERENCES conversation_analyses(id) ON DELETE CASCADE,
        source_key text NOT NULL,
        title text NOT NULL,
        reason text NOT NULL,
        priority text NOT NULL,
        due_at timestamptz NOT NULL,
        status text NOT NULL CHECK (status IN ('pending','completed','dismissed')),
        evidence_message_ids_json text NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE (conversation_id, source_key)
      );
      CREATE INDEX IF NOT EXISTS conversation_followups_status_idx
        ON conversation_followups(status, due_at);
    `
  },
  {
    version: 8,
    name: "automation_rhythm_center",
    sql: `
      CREATE TABLE IF NOT EXISTS automation_settings (
        id text PRIMARY KEY,
        analysis_interval_hours integer NOT NULL DEFAULT 6,
        daily_todo_hour integer NOT NULL DEFAULT 9,
        daily_todo_minute integer NOT NULL DEFAULT 0,
        timezone text NOT NULL DEFAULT 'Asia/Shanghai',
        enabled integer NOT NULL DEFAULT 1,
        last_analysis_at timestamptz,
        next_analysis_at timestamptz,
        last_daily_todo_at timestamptz,
        next_daily_todo_at timestamptz,
        last_run_status text NOT NULL DEFAULT 'idle',
        last_run_summary text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL,
        owner_user_id text UNIQUE
      );
      CREATE TABLE IF NOT EXISTS automation_deliveries (
        id text PRIMARY KEY,
        owner_user_id text NOT NULL,
        followup_id text NOT NULL,
        run_date date NOT NULL,
        delivery_type text NOT NULL,
        created_at timestamptz NOT NULL,
        UNIQUE(owner_user_id, followup_id, run_date, delivery_type)
      );
    `
  },
  {
    version: 9,
    name: "automation_run_history",
    sql: `
      CREATE TABLE IF NOT EXISTS automation_runs (
        id text PRIMARY KEY,
        owner_user_id text,
        trigger text NOT NULL CHECK (trigger IN ('scheduled','manual')),
        status text NOT NULL CHECK (status IN ('running','success','failed')),
        total_conversations integer NOT NULL DEFAULT 0,
        processed_conversations integer NOT NULL DEFAULT 0,
        analysis_updated integer NOT NULL DEFAULT 0,
        todos_created integer NOT NULL DEFAULT 0,
        notifications_sent integer NOT NULL DEFAULT 0,
        skipped integer NOT NULL DEFAULT 0,
        current_conversation text,
        error text,
        started_at timestamptz NOT NULL,
        finished_at timestamptz,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS automation_runs_owner_started_idx ON automation_runs(owner_user_id, started_at DESC);
    `
  },
  {
    version: 10,
    name: "conversation_trait_feedback",
    sql: `
      CREATE TABLE IF NOT EXISTS conversation_trait_feedback (
        id text PRIMARY KEY,
        conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        trait_key text NOT NULL,
        trait_label text NOT NULL,
        verdict text NOT NULL CHECK (verdict IN ('confirmed','rejected')),
        correction_text text,
        actor_user_id text NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        UNIQUE(conversation_id, trait_key)
      );
      CREATE INDEX IF NOT EXISTS conversation_trait_feedback_conversation_idx ON conversation_trait_feedback(conversation_id, updated_at DESC);
    `
  },
  {
    version: 11,
    name: "commercial_intelligence",
    sql: `
      ALTER TABLE automation_settings ADD COLUMN IF NOT EXISTS intelligence_mode text NOT NULL DEFAULT 'rules';
      ALTER TABLE automation_settings ADD COLUMN IF NOT EXISTS intelligence_provider_id text;
      ALTER TABLE conversation_analyses ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'rules';
      ALTER TABLE conversation_analyses ADD COLUMN IF NOT EXISTS model text;
      ALTER TABLE conversation_analyses ADD COLUMN IF NOT EXISTS prompt_version text NOT NULL DEFAULT 'rules-v1';
    `
  },
  {
    version: 12,
    name: "automation_delivery_tracking",
    sql: `
      ALTER TABLE automation_deliveries ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'success';
      ALTER TABLE automation_deliveries ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1;
      ALTER TABLE automation_deliveries ADD COLUMN IF NOT EXISTS external_id text;
      ALTER TABLE automation_deliveries ADD COLUMN IF NOT EXISTS last_error text;
      ALTER TABLE automation_deliveries ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;
      ALTER TABLE automation_deliveries ADD COLUMN IF NOT EXISTS updated_at timestamptz;
      UPDATE automation_deliveries SET updated_at=created_at WHERE updated_at IS NULL;
      CREATE INDEX IF NOT EXISTS automation_deliveries_status_idx ON automation_deliveries(owner_user_id,status,next_retry_at);
    `
  }
];

async function applyMigration(transaction: DatabaseTransaction, migration: Migration): Promise<void> {
  await transaction.exec(migration.sql);
  await transaction.query(
    "INSERT INTO schema_migrations(version,name,applied_at) VALUES($1,$2,$3)",
    [migration.version, migration.name, new Date().toISOString()]
  );
}

export async function migrate(database: Database): Promise<void> {
  if (database.kind === "mysql") {
    await migrateMysql(database);
    return;
  }
  await database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL
    );
  `);

  const applied = await database.query<{ version: number | string }>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  const appliedVersions = new Set(applied.rows.map((row) => Number(row.version)));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    await database.transaction((transaction) => applyMigration(transaction, migration));
  }
}
