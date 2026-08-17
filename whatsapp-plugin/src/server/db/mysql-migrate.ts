import { databaseTimestamp, type Database, type DatabaseTransaction } from "./database.js";
import { communicationTables } from "./communication-tables.js";

interface MysqlMigration {
  version: number;
  name: string;
  apply(transaction: DatabaseTransaction): Promise<void>;
}

const tableOptions = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";
const communicationTableNames = communicationTables.map((table) => table.name);

const initialStatements = [
  `CREATE TABLE IF NOT EXISTS channel_accounts (
    id VARCHAR(191) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    provider VARCHAR(32) NOT NULL,
    phone VARCHAR(64),
    avatar_url TEXT,
    status VARCHAR(32) NOT NULL,
    purpose_label VARCHAR(255) NOT NULL DEFAULT '',
    lead_types_json TEXT NOT NULL,
    region VARCHAR(191) NOT NULL DEFAULT '',
    priority INT NOT NULL DEFAULT 100,
    risk_accepted TINYINT NOT NULL DEFAULT 0,
    last_connected_at DATETIME(3),
    last_event_at DATETIME(3),
    last_error TEXT,
    qr_data_url LONGTEXT,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS provider_session_keys (
    account_id VARCHAR(191) NOT NULL,
    key_type VARCHAR(191) NOT NULL,
    key_id VARCHAR(191) NOT NULL,
    cipher_text LONGTEXT NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (account_id, key_type, key_id),
    CONSTRAINT communication_fk_session_account FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE CASCADE
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS integration_preferences (
    id VARCHAR(191) PRIMARY KEY,
    strategy VARCHAR(32) NOT NULL,
    default_provider VARCHAR(32) NOT NULL,
    updated_at DATETIME(3) NOT NULL
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS meta_app_configs (
    id VARCHAR(191) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    app_id VARCHAR(191) NOT NULL,
    app_secret_cipher LONGTEXT NOT NULL,
    app_secret_mask VARCHAR(255) NOT NULL,
    verify_token_digest VARCHAR(255) NOT NULL,
    verify_token_mask VARCHAR(255) NOT NULL,
    webhook_key VARCHAR(191) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY meta_app_configs_app_unique (app_id),
    UNIQUE KEY meta_app_configs_webhook_unique (webhook_key)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS meta_account_credentials (
    account_id VARCHAR(191) PRIMARY KEY,
    app_config_id VARCHAR(191) NOT NULL,
    waba_id VARCHAR(191) NOT NULL,
    phone_number_id VARCHAR(191) NOT NULL,
    access_token_cipher LONGTEXT NOT NULL,
    access_token_mask VARCHAR(255) NOT NULL,
    graph_api_version VARCHAR(32) NOT NULL,
    display_phone_number VARCHAR(64),
    verified_name VARCHAR(255),
    quality_rating VARCHAR(64),
    sending_enabled TINYINT NOT NULL DEFAULT 0,
    last_verified_at DATETIME(3),
    last_webhook_at DATETIME(3),
    last_error TEXT,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY meta_account_phone_number_unique (phone_number_id),
    KEY meta_account_credentials_app_idx (app_config_id),
    CONSTRAINT communication_fk_meta_account FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE CASCADE,
    CONSTRAINT communication_fk_meta_app FOREIGN KEY (app_config_id) REFERENCES meta_app_configs(id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS contacts (
    id VARCHAR(191) PRIMARY KEY,
    account_id VARCHAR(191) NOT NULL,
    provider_contact_id VARCHAR(512) NOT NULL,
    display_name VARCHAR(255) NOT NULL,
    phone VARCHAR(64) NOT NULL,
    avatar_url TEXT,
    source VARCHAR(32) NOT NULL,
    origin VARCHAR(32) NOT NULL DEFAULT 'whatsapp_sync',
    last_seen_at DATETIME(3),
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY contacts_account_provider_unique (account_id, provider_contact_id),
    UNIQUE KEY contacts_account_phone_unique (account_id, phone),
    KEY contacts_account_phone_idx (account_id, phone),
    CONSTRAINT communication_fk_contact_account FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE CASCADE
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id VARCHAR(191) PRIMARY KEY,
    account_id VARCHAR(191) NOT NULL,
    contact_id VARCHAR(191) NOT NULL,
    provider_conversation_id VARCHAR(512) NOT NULL,
    unread_count INT NOT NULL DEFAULT 0,
    last_message_at DATETIME(3),
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY conversations_account_provider_unique (account_id, provider_conversation_id),
    KEY conversations_account_last_idx (account_id, last_message_at DESC),
    CONSTRAINT communication_fk_conversation_account FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE CASCADE,
    CONSTRAINT communication_fk_conversation_contact FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(191) PRIMARY KEY,
    account_id VARCHAR(191) NOT NULL,
    conversation_id VARCHAR(191) NOT NULL,
    provider_message_id VARCHAR(512),
    client_message_id VARCHAR(191),
    direction VARCHAR(16) NOT NULL,
    message_type VARCHAR(32) NOT NULL,
    body LONGTEXT NOT NULL,
    status VARCHAR(32) NOT NULL,
    source_language VARCHAR(32),
    occurred_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY messages_provider_unique (account_id, provider_message_id),
    UNIQUE KEY messages_client_unique (account_id, client_message_id),
    KEY messages_conversation_time_idx (conversation_id, occurred_at),
    CONSTRAINT communication_fk_message_account FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE CASCADE,
    CONSTRAINT communication_fk_message_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS ai_provider_profiles (
    id VARCHAR(191) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    base_url TEXT,
    api_key_cipher LONGTEXT,
    api_key_mask VARCHAR(255),
    model VARCHAR(255) NOT NULL,
    enabled TINYINT NOT NULL DEFAULT 1,
    last_test_status VARCHAR(32) NOT NULL DEFAULT 'untested',
    last_test_error TEXT,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS translation_preferences (
    id VARCHAR(191) PRIMARY KEY,
    auto_translate TINYINT NOT NULL DEFAULT 0,
    target_language VARCHAR(32) NOT NULL DEFAULT 'zh-CN',
    provider_id VARCHAR(191),
    crm_auto_create TINYINT NOT NULL DEFAULT 0,
    updated_at DATETIME(3) NOT NULL,
    CONSTRAINT communication_fk_translation_pref_provider FOREIGN KEY (provider_id) REFERENCES ai_provider_profiles(id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS translations (
    id VARCHAR(191) PRIMARY KEY,
    message_id VARCHAR(191) NOT NULL,
    source_language VARCHAR(32),
    target_language VARCHAR(32) NOT NULL,
    profile_id VARCHAR(191) NOT NULL,
    model VARCHAR(255) NOT NULL,
    trigger_type VARCHAR(32) NOT NULL,
    status VARCHAR(32) NOT NULL,
    translated_text LONGTEXT,
    error TEXT,
    prompt_version VARCHAR(64) NOT NULL,
    token_usage INT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY translations_identity_unique (message_id, target_language, profile_id, prompt_version),
    CONSTRAINT communication_fk_translation_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
    CONSTRAINT communication_fk_translation_profile FOREIGN KEY (profile_id) REFERENCES ai_provider_profiles(id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS routing_rules (
    id VARCHAR(191) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    lead_type VARCHAR(191) NOT NULL DEFAULT '',
    region VARCHAR(191) NOT NULL DEFAULT '',
    preferred_account_id VARCHAR(191) NOT NULL,
    fallback_account_id VARCHAR(191),
    priority INT NOT NULL DEFAULT 100,
    enabled TINYINT NOT NULL DEFAULT 1,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    CONSTRAINT communication_fk_routing_preferred FOREIGN KEY (preferred_account_id) REFERENCES channel_accounts(id),
    CONSTRAINT communication_fk_routing_fallback FOREIGN KEY (fallback_account_id) REFERENCES channel_accounts(id)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS crm_contacts (
    id VARCHAR(191) PRIMARY KEY,
    phone VARCHAR(64) NOT NULL,
    name VARCHAR(255) NOT NULL,
    source VARCHAR(32) NOT NULL,
    source_contact_id VARCHAR(191) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    UNIQUE KEY crm_contacts_phone_unique (phone)
  ) ${tableOptions}`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(191) PRIMARY KEY,
    action VARCHAR(191) NOT NULL,
    target_type VARCHAR(64) NOT NULL,
    target_id VARCHAR(191) NOT NULL,
    result VARCHAR(32) NOT NULL,
    details_json LONGTEXT NOT NULL,
    created_at DATETIME(3) NOT NULL,
    KEY audit_logs_created_idx (created_at)
  ) ${tableOptions}`
];

async function ensureColumn(
  transaction: DatabaseTransaction,
  table: string,
  column: string,
  definition: string
): Promise<void> {
  const result = await transaction.query<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM information_schema.columns
     WHERE table_schema=DATABASE() AND table_name=$1 AND column_name=$2`,
    [table, column]
  );
  if (Number(result.rows[0]?.count ?? 0) === 0) {
    await transaction.exec(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

async function ensureIndex(
  transaction: DatabaseTransaction,
  table: string,
  index: string,
  columns: string
): Promise<void> {
  const result = await transaction.query<{ count: number | string }>(
    `SELECT COUNT(*) AS count FROM information_schema.statistics
     WHERE table_schema=DATABASE() AND table_name=$1 AND index_name=$2`,
    [table, index]
  );
  if (Number(result.rows[0]?.count ?? 0) === 0) {
    await transaction.exec(`CREATE INDEX \`${index}\` ON \`${table}\` (${columns})`);
  }
}

const migrations: MysqlMigration[] = [
  {
    version: 1,
    name: "initial_schema",
    apply: async (transaction) => {
      for (const statement of initialStatements) await transaction.exec(statement);
      await transaction.query(
        `INSERT IGNORE INTO integration_preferences(id,strategy,default_provider,updated_at)
         VALUES('default','free_first','baileys',CURRENT_TIMESTAMP(3))`
      );
      await transaction.query(
        "DELETE FROM contacts WHERE provider_contact_id='0@s.whatsapp.net' AND phone='+0'"
      );
    }
  },
  {
    version: 2,
    name: "optional_translation_provider",
    apply: async (transaction) => {
      await transaction.query(
        `INSERT IGNORE INTO translation_preferences(id,auto_translate,target_language,provider_id,crm_auto_create,updated_at)
         VALUES('default',0,'zh-CN',NULL,0,CURRENT_TIMESTAMP(3))`
      );
    }
  },
  {
    version: 3,
    name: "message_media_and_retention",
    apply: async (transaction) => {
      await ensureColumn(transaction, "messages", "media_file_name", "VARCHAR(512) NULL");
      await ensureColumn(transaction, "messages", "media_mime_type", "VARCHAR(191) NULL");
      await ensureColumn(transaction, "messages", "media_size_bytes", "BIGINT NULL");
      await ensureColumn(transaction, "messages", "media_storage_key", "VARCHAR(512) NULL");
      await ensureColumn(transaction, "messages", "media_expires_at", "DATETIME(3) NULL");
      await ensureColumn(transaction, "messages", "revoked_at", "DATETIME(3) NULL");
      await ensureIndex(transaction, "messages", "messages_media_expiry_idx", "media_expires_at");
      await transaction.exec(`CREATE TABLE IF NOT EXISTS media_retention_settings (
        id VARCHAR(191) PRIMARY KEY,
        mode VARCHAR(32) NOT NULL,
        retention_days INT NOT NULL,
        updated_at DATETIME(3) NOT NULL
      ) ${tableOptions}`);
      await transaction.query(
        `INSERT IGNORE INTO media_retention_settings(id,mode,retention_days,updated_at)
         VALUES('default','immediate',0,CURRENT_TIMESTAMP(3))`
      );
    }
  },
  {
    version: 4,
    name: "personal_account_ownership",
    apply: async (transaction) => {
      await ensureColumn(transaction, "channel_accounts", "owner_user_id", "VARCHAR(191) NULL");
      await ensureIndex(transaction, "channel_accounts", "channel_accounts_owner_idx", "owner_user_id");
    }
  },
  {
    version: 5,
    name: "personal_whatsapp_configuration_ownership",
    apply: async (transaction) => {
      await ensureColumn(transaction, "ai_provider_profiles", "owner_user_id", "VARCHAR(191) NULL");
      await ensureColumn(transaction, "meta_app_configs", "owner_user_id", "VARCHAR(191) NULL");
      await ensureColumn(transaction, "routing_rules", "owner_user_id", "VARCHAR(191) NULL");
      await ensureIndex(transaction, "ai_provider_profiles", "ai_provider_profiles_owner_idx", "owner_user_id");
      await ensureIndex(transaction, "meta_app_configs", "meta_app_configs_owner_idx", "owner_user_id");
      await ensureIndex(transaction, "routing_rules", "routing_rules_owner_idx", "owner_user_id");
    }
  },
  {
    version: 6,
    name: "durable_meta_webhook_inbox",
    apply: async (transaction) => {
      await transaction.exec(`CREATE TABLE IF NOT EXISTS meta_webhook_events (
        id VARCHAR(191) PRIMARY KEY,
        app_config_id VARCHAR(191) NOT NULL,
        event_hash CHAR(64) NOT NULL,
        payload_cipher LONGTEXT NOT NULL,
        status VARCHAR(32) NOT NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        received_at DATETIME(3) NOT NULL,
        processing_started_at DATETIME(3),
        processed_at DATETIME(3),
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY meta_webhook_events_identity_unique (app_config_id, event_hash),
        KEY meta_webhook_events_recovery_idx (status, received_at),
        CONSTRAINT communication_fk_meta_webhook_app
          FOREIGN KEY (app_config_id) REFERENCES meta_app_configs(id) ON DELETE CASCADE
      ) ${tableOptions}`);
    }
  },
  {
    version: 7,
    name: "conversation_intelligence_and_followups",
    apply: async (transaction) => {
      await transaction.exec(`CREATE TABLE IF NOT EXISTS conversation_analyses (
        id VARCHAR(191) PRIMARY KEY,
        conversation_id VARCHAR(191) NOT NULL,
        account_id VARCHAR(191) NOT NULL,
        status VARCHAR(32) NOT NULL,
        summary TEXT NOT NULL,
        key_points_json LONGTEXT NOT NULL,
        traits_json LONGTEXT NOT NULL,
        buying_intent VARCHAR(16) NOT NULL,
        risk_level VARCHAR(16) NOT NULL,
        next_action VARCHAR(512) NOT NULL,
        source_message_count INT NOT NULL DEFAULT 0,
        error TEXT,
        generated_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY conversation_analyses_conversation_unique (conversation_id),
        KEY conversation_analyses_account_idx (account_id, updated_at),
        CONSTRAINT communication_fk_analysis_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        CONSTRAINT communication_fk_analysis_account FOREIGN KEY (account_id) REFERENCES channel_accounts(id) ON DELETE CASCADE
      ) ${tableOptions}`);
      await transaction.exec(`CREATE TABLE IF NOT EXISTS conversation_followups (
        id VARCHAR(191) PRIMARY KEY,
        conversation_id VARCHAR(191) NOT NULL,
        analysis_id VARCHAR(191) NOT NULL,
        source_key VARCHAR(191) NOT NULL,
        title VARCHAR(255) NOT NULL,
        reason TEXT NOT NULL,
        priority VARCHAR(16) NOT NULL,
        due_at DATETIME(3) NOT NULL,
        status VARCHAR(32) NOT NULL,
        evidence_message_ids_json LONGTEXT NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY conversation_followups_identity_unique (conversation_id, source_key),
        KEY conversation_followups_status_idx (status, due_at),
        CONSTRAINT communication_fk_followup_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        CONSTRAINT communication_fk_followup_analysis FOREIGN KEY (analysis_id) REFERENCES conversation_analyses(id) ON DELETE CASCADE
      ) ${tableOptions}`);
    }
  },
  {
    version: 8,
    name: "automation_rhythm_center",
    apply: async (transaction) => {
      await transaction.exec(`CREATE TABLE IF NOT EXISTS automation_settings (
        id VARCHAR(191) PRIMARY KEY,
        analysis_interval_hours INT NOT NULL DEFAULT 6,
        daily_todo_hour INT NOT NULL DEFAULT 9,
        daily_todo_minute INT NOT NULL DEFAULT 0,
        timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
        enabled TINYINT NOT NULL DEFAULT 1,
        last_analysis_at DATETIME(3),
        next_analysis_at DATETIME(3),
        last_daily_todo_at DATETIME(3),
        next_daily_todo_at DATETIME(3),
        last_run_status VARCHAR(16) NOT NULL DEFAULT 'idle',
        last_run_summary TEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        owner_user_id VARCHAR(191) NULL,
        UNIQUE KEY automation_settings_owner_unique (owner_user_id)
      ) ${tableOptions}`);
      await transaction.exec(`CREATE TABLE IF NOT EXISTS automation_deliveries (
        id VARCHAR(191) PRIMARY KEY,
        owner_user_id VARCHAR(191) NOT NULL,
        followup_id VARCHAR(191) NOT NULL,
        run_date DATE NOT NULL,
        delivery_type VARCHAR(32) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        UNIQUE KEY automation_delivery_unique (owner_user_id, followup_id, run_date, delivery_type),
        KEY automation_delivery_date_idx (owner_user_id, run_date)
      ) ${tableOptions}`);
      await transaction.query(
        `INSERT IGNORE INTO automation_settings(id,analysis_interval_hours,daily_todo_hour,daily_todo_minute,timezone,enabled,last_run_status,last_run_summary,updated_at,owner_user_id)
         VALUES($1,6,9,0,'Asia/Shanghai',1,'idle','尚未运行',CURRENT_TIMESTAMP(3),$2)`,
        ["default", null]
      );
    }
  },
  {
    version: 9,
    name: "automation_run_history",
    apply: async (transaction) => {
      await transaction.exec(`CREATE TABLE IF NOT EXISTS automation_runs (
        id VARCHAR(191) PRIMARY KEY,
        owner_user_id VARCHAR(191) NULL,
        trigger_type VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL,
        total_conversations INT NOT NULL DEFAULT 0,
        processed_conversations INT NOT NULL DEFAULT 0,
        analysis_updated INT NOT NULL DEFAULT 0,
        todos_created INT NOT NULL DEFAULT 0,
        notifications_sent INT NOT NULL DEFAULT 0,
        skipped INT NOT NULL DEFAULT 0,
        current_conversation VARCHAR(255) NULL,
        error TEXT NULL,
        started_at DATETIME(3) NOT NULL,
        finished_at DATETIME(3) NULL,
        updated_at DATETIME(3) NOT NULL,
        KEY automation_runs_owner_started_idx (owner_user_id, started_at)
      ) ${tableOptions}`);
    }
  },
  {
    version: 10,
    name: "conversation_trait_feedback",
    apply: async (transaction) => {
      await transaction.exec(`CREATE TABLE IF NOT EXISTS conversation_trait_feedback (
        id VARCHAR(191) PRIMARY KEY,
        conversation_id VARCHAR(191) NOT NULL,
        trait_key VARCHAR(191) NOT NULL,
        trait_label VARCHAR(255) NOT NULL,
        verdict VARCHAR(16) NOT NULL,
        correction_text TEXT NULL,
        actor_user_id VARCHAR(191) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        UNIQUE KEY conversation_trait_feedback_unique (conversation_id, trait_key),
        KEY conversation_trait_feedback_conversation_idx (conversation_id, updated_at),
        CONSTRAINT communication_fk_trait_feedback_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      ) ${tableOptions}`);
    }
  },
  {
    version: 11,
    name: "commercial_intelligence",
    apply: async (transaction) => {
      await ensureColumn(transaction, "automation_settings", "intelligence_mode", "VARCHAR(16) NOT NULL DEFAULT 'rules'");
      await ensureColumn(transaction, "automation_settings", "intelligence_provider_id", "VARCHAR(191) NULL");
      await ensureColumn(transaction, "conversation_analyses", "engine", "VARCHAR(16) NOT NULL DEFAULT 'rules'");
      await ensureColumn(transaction, "conversation_analyses", "model", "VARCHAR(191) NULL");
      await ensureColumn(transaction, "conversation_analyses", "prompt_version", "VARCHAR(64) NOT NULL DEFAULT 'rules-v1'");
    }
  },
  {
    version: 12,
    name: "automation_delivery_tracking",
    apply: async (transaction) => {
      await ensureColumn(transaction, "automation_deliveries", "status", "VARCHAR(16) NOT NULL DEFAULT 'success'");
      await ensureColumn(transaction, "automation_deliveries", "attempts", "INT NOT NULL DEFAULT 1");
      await ensureColumn(transaction, "automation_deliveries", "external_id", "VARCHAR(191) NULL");
      await ensureColumn(transaction, "automation_deliveries", "last_error", "TEXT NULL");
      await ensureColumn(transaction, "automation_deliveries", "next_retry_at", "DATETIME(3) NULL");
      await ensureColumn(transaction, "automation_deliveries", "updated_at", "DATETIME(3) NULL");
      await transaction.exec("UPDATE automation_deliveries SET updated_at=created_at WHERE updated_at IS NULL");
    }
  }
];

export async function migrateMysql(database: Database): Promise<void> {
  const existing = await database.query<{ table_name: string }>(
    "SELECT table_name AS table_name FROM information_schema.tables WHERE table_schema=DATABASE()"
  );
  const existingNames = new Set(existing.rows.map((row) => row.table_name));
  if (!existingNames.has("communication_schema_migrations")) {
    const collisions = communicationTableNames.filter((table) => existingNames.has(table));
    if (collisions.length > 0) {
      throw new Error(
        `Refusing to adopt unowned tables in shared MySQL database: ${collisions.join(", ")}`
      );
    }
  }
  await database.exec(`CREATE TABLE IF NOT EXISTS communication_schema_migrations (
    version INT PRIMARY KEY,
    name VARCHAR(191) NOT NULL,
    applied_at DATETIME(3) NOT NULL
  ) ${tableOptions}`);
  const applied = await database.query<{ version: number | string }>(
    "SELECT version FROM communication_schema_migrations ORDER BY version"
  );
  const appliedVersions = new Set(applied.rows.map((row) => Number(row.version)));

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    await database.transaction(async (transaction) => {
      await migration.apply(transaction);
      await transaction.query(
        "INSERT INTO communication_schema_migrations(version,name,applied_at) VALUES($1,$2,$3)",
        [migration.version, migration.name, databaseTimestamp(new Date())]
      );
    });
  }
}
