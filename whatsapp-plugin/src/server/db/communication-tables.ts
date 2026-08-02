export interface CommunicationTable {
  name: string;
  primaryKey: string[];
  columns: string[];
  temporalColumns: string[];
}

export const communicationTables: CommunicationTable[] = [
  {
    name: "channel_accounts",
    primaryKey: ["id"],
    columns: ["id", "name", "provider", "phone", "avatar_url", "status", "purpose_label", "lead_types_json", "region", "priority", "risk_accepted", "last_connected_at", "last_event_at", "last_error", "qr_data_url", "created_at", "updated_at", "owner_user_id"],
    temporalColumns: ["last_connected_at", "last_event_at", "created_at", "updated_at"]
  },
  {
    name: "integration_preferences",
    primaryKey: ["id"],
    columns: ["id", "strategy", "default_provider", "updated_at"],
    temporalColumns: ["updated_at"]
  },
  {
    name: "meta_app_configs",
    primaryKey: ["id"],
    columns: ["id", "name", "app_id", "app_secret_cipher", "app_secret_mask", "verify_token_digest", "verify_token_mask", "webhook_key", "created_at", "updated_at", "owner_user_id"],
    temporalColumns: ["created_at", "updated_at"]
  },
  {
    name: "ai_provider_profiles",
    primaryKey: ["id"],
    columns: ["id", "name", "kind", "base_url", "api_key_cipher", "api_key_mask", "model", "enabled", "last_test_status", "last_test_error", "created_at", "updated_at", "owner_user_id"],
    temporalColumns: ["created_at", "updated_at"]
  },
  {
    name: "contacts",
    primaryKey: ["id"],
    columns: ["id", "account_id", "provider_contact_id", "display_name", "phone", "avatar_url", "source", "origin", "last_seen_at", "created_at", "updated_at"],
    temporalColumns: ["last_seen_at", "created_at", "updated_at"]
  },
  {
    name: "meta_account_credentials",
    primaryKey: ["account_id"],
    columns: ["account_id", "app_config_id", "waba_id", "phone_number_id", "access_token_cipher", "access_token_mask", "graph_api_version", "display_phone_number", "verified_name", "quality_rating", "sending_enabled", "last_verified_at", "last_webhook_at", "last_error", "created_at", "updated_at"],
    temporalColumns: ["last_verified_at", "last_webhook_at", "created_at", "updated_at"]
  },
  {
    name: "provider_session_keys",
    primaryKey: ["account_id", "key_type", "key_id"],
    columns: ["account_id", "key_type", "key_id", "cipher_text", "updated_at"],
    temporalColumns: ["updated_at"]
  },
  {
    name: "conversations",
    primaryKey: ["id"],
    columns: ["id", "account_id", "contact_id", "provider_conversation_id", "unread_count", "last_message_at", "created_at", "updated_at"],
    temporalColumns: ["last_message_at", "created_at", "updated_at"]
  },
  {
    name: "messages",
    primaryKey: ["id"],
    columns: ["id", "account_id", "conversation_id", "provider_message_id", "client_message_id", "direction", "message_type", "body", "status", "source_language", "occurred_at", "created_at", "media_file_name", "media_mime_type", "media_size_bytes", "media_storage_key", "media_expires_at", "revoked_at"],
    temporalColumns: ["occurred_at", "created_at", "media_expires_at", "revoked_at"]
  },
  {
    name: "translation_preferences",
    primaryKey: ["id"],
    columns: ["id", "auto_translate", "target_language", "provider_id", "crm_auto_create", "updated_at"],
    temporalColumns: ["updated_at"]
  },
  {
    name: "translations",
    primaryKey: ["id"],
    columns: ["id", "message_id", "source_language", "target_language", "profile_id", "model", "trigger_type", "status", "translated_text", "error", "prompt_version", "token_usage", "created_at", "updated_at"],
    temporalColumns: ["created_at", "updated_at"]
  },
  {
    name: "routing_rules",
    primaryKey: ["id"],
    columns: ["id", "name", "lead_type", "region", "preferred_account_id", "fallback_account_id", "priority", "enabled", "created_at", "updated_at", "owner_user_id"],
    temporalColumns: ["created_at", "updated_at"]
  },
  {
    name: "crm_contacts",
    primaryKey: ["id"],
    columns: ["id", "phone", "name", "source", "source_contact_id", "created_at"],
    temporalColumns: ["created_at"]
  },
  {
    name: "media_retention_settings",
    primaryKey: ["id"],
    columns: ["id", "mode", "retention_days", "updated_at"],
    temporalColumns: ["updated_at"]
  },
  {
    name: "audit_logs",
    primaryKey: ["id"],
    columns: ["id", "action", "target_type", "target_id", "result", "details_json", "created_at"],
    temporalColumns: ["created_at"]
  }
];
