export interface CommunicationTable {
  name: string;
  primaryKey: string[];
  columns: string[];
  temporalColumns: string[];
}

export const communicationTables: CommunicationTable[] = [
  {
    name: "automation_settings",
    primaryKey: ["id"],
    columns: ["id", "analysis_interval_hours", "intelligence_mode", "intelligence_provider_id", "daily_todo_hour", "daily_todo_minute", "timezone", "enabled", "last_analysis_at", "next_analysis_at", "last_daily_todo_at", "next_daily_todo_at", "followup_sync_enabled", "followup_sync_hour", "followup_sync_minute", "last_followup_sync_at", "next_followup_sync_at", "last_run_status", "last_run_summary", "updated_at", "owner_user_id"],
    temporalColumns: ["last_analysis_at", "next_analysis_at", "last_daily_todo_at", "next_daily_todo_at", "last_followup_sync_at", "next_followup_sync_at", "updated_at"]
  },
  {
    name: "followup_sync_runs",
    primaryKey: ["id"],
    columns: ["id", "owner_user_id", "run_date", "trigger", "status", "timezone", "conversations_scanned", "message_count", "customers_matched", "activities_written", "leads_created", "leads_existing", "skipped", "ambiguous", "engine", "model", "notification_sent", "error", "summary", "started_at", "finished_at", "updated_at"],
    temporalColumns: ["started_at", "finished_at", "updated_at"]
  },
  {
    name: "followup_sync_items",
    primaryKey: ["id"],
    columns: ["id", "run_id", "owner_user_id", "conversation_key", "contact_name", "contact_phone", "kind", "status", "customer_id", "lead_id", "activity_id", "message_count", "summary", "error", "created_at"],
    temporalColumns: ["created_at"]
  },
  {
    name: "automation_deliveries",
    primaryKey: ["id"],
    columns: ["id", "owner_user_id", "followup_id", "run_date", "delivery_type", "created_at"],
    temporalColumns: ["created_at"]
  },
  {
    name: "automation_runs",
    primaryKey: ["id"],
    columns: ["id", "owner_user_id", "trigger", "status", "total_conversations", "processed_conversations", "analysis_updated", "todos_created", "notifications_sent", "skipped", "current_conversation", "error", "started_at", "finished_at", "updated_at"],
    temporalColumns: ["started_at", "finished_at", "updated_at"]
  },
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
    name: "meta_webhook_events",
    primaryKey: ["id"],
    columns: ["id", "app_config_id", "event_hash", "payload_cipher", "status", "attempts", "last_error", "received_at", "processing_started_at", "processed_at", "updated_at"],
    temporalColumns: ["received_at", "processing_started_at", "processed_at", "updated_at"]
  },
  {
    name: "conversation_analyses",
    primaryKey: ["id"],
    columns: ["id", "conversation_id", "account_id", "status", "summary", "key_points_json", "traits_json", "buying_intent", "risk_level", "next_action", "source_message_count", "engine", "model", "prompt_version", "error", "generated_at", "updated_at"],
    temporalColumns: ["generated_at", "updated_at"]
  },
  {
    name: "conversation_followups",
    primaryKey: ["id"],
    columns: ["id", "conversation_id", "analysis_id", "source_key", "title", "reason", "priority", "due_at", "status", "evidence_message_ids_json", "created_at", "updated_at"],
    temporalColumns: ["due_at", "created_at", "updated_at"]
  },
  {
    name: "conversation_trait_feedback",
    primaryKey: ["id"],
    columns: ["id", "conversation_id", "trait_key", "trait_label", "verdict", "correction_text", "actor_user_id", "created_at", "updated_at"],
    temporalColumns: ["created_at", "updated_at"]
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
  },
  {
    name: "training_profiles",
    primaryKey: ["id"],
    columns: ["id", "owner_user_id", "account_id", "name", "status", "engine", "model", "sample_count", "exchange_count", "conversation_count", "message_count", "languages_json", "tone", "summary", "guidelines_json", "signature_phrases_json", "guardrails_json", "examples_json", "source_from", "source_to", "error", "trained_at", "created_at", "updated_at"],
    temporalColumns: ["source_from", "source_to", "trained_at", "created_at", "updated_at"]
  },
  {
    name: "training_library_entries",
    primaryKey: ["id"],
    columns: ["id", "owner_user_id", "account_id", "kind", "question", "answer", "tags_json", "languages_json", "priority", "enabled", "status", "source", "fingerprint", "hit_count", "created_at", "updated_at", "kb_id", "source_title", "source_anchor", "source_note"],
    temporalColumns: ["created_at", "updated_at"]
  },
  {
    // CRM 推送过来的「默认知识库」启用清单。插件只执行，不判定可见性（见 mysql-migrate v20 注释）。
    name: "training_kb_subscriptions",
    primaryKey: ["owner_user_id", "kb_id"],
    columns: ["owner_user_id", "kb_id", "synced_at"],
    temporalColumns: ["synced_at"]
  },
  {
    name: "auto_chat_settings",
    primaryKey: ["id"],
    columns: ["id", "owner_user_id", "account_id", "enabled", "mode", "engine", "profile_id", "provider_id", "cli_model", "cli_effort", "language", "tone", "daily_limit", "min_interval_minutes", "active_hours_start", "active_hours_end", "timezone", "escalate_keywords_json", "guardrails_json", "confidence_threshold", "last_run_at", "updated_at"],
    temporalColumns: ["last_run_at", "updated_at"]
  },
  {
    name: "auto_chat_drafts",
    primaryKey: ["id"],
    columns: ["id", "owner_user_id", "account_id", "conversation_id", "inbound_message_id", "inbound_body", "body", "edited", "status", "mode", "confidence", "reason", "engine", "model", "profile_id", "message_id", "error", "run_date", "created_at", "sent_at", "updated_at"],
    temporalColumns: ["created_at", "sent_at", "updated_at"]
  }
];
