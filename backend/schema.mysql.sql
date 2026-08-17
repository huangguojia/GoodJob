CREATE TABLE users (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  avatar VARCHAR(8),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  auth_version INT NOT NULL DEFAULT 1,
  outbound_email VARCHAR(180) DEFAULT '',
  email_sender_name VARCHAR(120) DEFAULT '',
  email_signature TEXT,
  smtp_host VARCHAR(180) DEFAULT '',
  smtp_port INT DEFAULT 465,
  smtp_secure BOOLEAN DEFAULT TRUE,
  smtp_user VARCHAR(180) DEFAULT '',
  smtp_password TEXT,
  imap_host VARCHAR(180) DEFAULT '',
  imap_port INT DEFAULT 993,
  imap_secure BOOLEAN DEFAULT TRUE,
  imap_user VARCHAR(180) DEFAULT '',
  imap_password TEXT,
  inbound_sync_enabled BOOLEAN DEFAULT FALSE,
  last_inbound_sync_at DATETIME(3) NULL,
  last_inbound_sync_status VARCHAR(20) DEFAULT '',
  last_inbound_sync_error VARCHAR(1000) DEFAULT '',
  last_inbound_uid BIGINT UNSIGNED DEFAULT 0,
  inbound_uid_validity VARCHAR(40) DEFAULT '',
  last_development_email_at DATETIME NULL,
  last_development_email_to VARCHAR(180) DEFAULT '',
  last_development_email_subject VARCHAR(255) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE company_profiles (
  team_id VARCHAR(64) PRIMARY KEY,
  company_name VARCHAR(200) DEFAULT '',
  website VARCHAR(300) DEFAULT '',
  product_summary TEXT,
  address TEXT,
  phone VARCHAR(100) DEFAULT '',
  email VARCHAR(180) DEFAULT '',
  updated_by VARCHAR(64) DEFAULT '',
  updated_at DATETIME(3) NOT NULL
);

CREATE TABLE document_letterheads (
  id VARCHAR(64) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  asset_name VARCHAR(160) NOT NULL,
  company_name VARCHAR(240) NOT NULL,
  address TEXT,
  phone VARCHAR(120) DEFAULT '',
  email VARCHAR(180) DEFAULT '',
  website VARCHAR(500) DEFAULT '',
  bank_info TEXT,
  logo_url VARCHAR(512) DEFAULT '',
  logo_placement_json JSON,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by VARCHAR(64) DEFAULT '',
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_document_letterheads_team(team_id, enabled, updated_at)
);

CREATE TABLE document_stamps (
  id VARCHAR(64) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  asset_name VARCHAR(160) NOT NULL,
  image_url VARCHAR(512) NOT NULL,
  placement_json JSON,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by VARCHAR(64) DEFAULT '',
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_document_stamps_team(team_id, enabled, updated_at)
);

CREATE TABLE document_signatures (
  id VARCHAR(64) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  asset_name VARCHAR(160) NOT NULL,
  signer_name VARCHAR(160) DEFAULT '',
  signer_title VARCHAR(160) DEFAULT '',
  image_url VARCHAR(512) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by VARCHAR(64) DEFAULT '',
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_document_signatures_team(team_id, enabled, updated_at)
);

CREATE TABLE document_default_profiles (
  team_id VARCHAR(64) PRIMARY KEY,
  seller VARCHAR(240) DEFAULT '',
  seller_address TEXT,
  seller_contact VARCHAR(200) DEFAULT '',
  seller_phone VARCHAR(120) DEFAULT '',
  seller_email VARCHAR(180) DEFAULT '',
  seller_website VARCHAR(500) DEFAULT '',
  seller_tax_no VARCHAR(160) DEFAULT '',
  bank_info TEXT,
  currency VARCHAR(12) DEFAULT 'USD',
  incoterm VARCHAR(80) DEFAULT 'FOB',
  payment_term VARCHAR(255) DEFAULT '',
  shipping_method VARCHAR(120) DEFAULT 'Sea freight',
  port_loading VARCHAR(120) DEFAULT '',
  validity_days INT NOT NULL DEFAULT 0,
  notes TEXT,
  language VARCHAR(8) DEFAULT 'EN',
  template_style VARCHAR(40) DEFAULT 'indigo',
  letterhead_id VARCHAR(64) DEFAULT '',
  stamp_id VARCHAR(64) DEFAULT '',
  signature_id VARCHAR(64) DEFAULT '',
  include_product_images BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by VARCHAR(64) DEFAULT '',
  updated_at DATETIME(3) NOT NULL
);

CREATE TABLE team_system_settings (
  team_id VARCHAR(64) PRIMARY KEY,
  require_document_excel_approval BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by VARCHAR(64) DEFAULT '',
  updated_at DATETIME(3) NOT NULL
);

CREATE TABLE customers (
  id VARCHAR(64) PRIMARY KEY,
  company VARCHAR(200) NOT NULL,
  country VARCHAR(80),
  contact VARCHAR(100),
  whatsapp VARCHAR(32) DEFAULT '',
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) GENERATED ALWAYS AS (team_id) STORED,
  stage VARCHAR(40),
  amount DECIMAL(14,2) DEFAULT 0,
  health INT DEFAULT 0,
  customer_source VARCHAR(120) DEFAULT '',
  customer_grade VARCHAR(1) NOT NULL DEFAULT 'C',
  lifecycle_status VARCHAR(20) NOT NULL DEFAULT 'open',
  won_at DATETIME(3) NULL,
  won_by_deal_id VARCHAR(64) DEFAULT '',
  next_reminder VARCHAR(100),
  wecom_bound BOOLEAN DEFAULT FALSE,
  billing_name VARCHAR(200) DEFAULT '',
  company_full_name VARCHAR(200) DEFAULT '',
  billing_address TEXT,
  document_contact VARCHAR(200) DEFAULT '',
  contact_remark VARCHAR(500) DEFAULT '',
  default_port_discharge VARCHAR(120) DEFAULT '',
  default_incoterm VARCHAR(80) DEFAULT '',
  default_payment_term VARCHAR(255) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_customers_owner(owner_id),
  INDEX idx_customers_team(team_id)
);

CREATE TABLE customer_activities (
  id VARCHAR(64) PRIMARY KEY,
  customer_id VARCHAR(64) NOT NULL,
  type VARCHAR(30) DEFAULT 'note',
  content TEXT,
  operator_id VARCHAR(64) DEFAULT '',
  next_reminder VARCHAR(100) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_customer_activities_customer(customer_id)
);

CREATE TABLE customer_intelligence_suggestions (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  customer_id VARCHAR(64) NOT NULL,
  prospect_candidate_id VARCHAR(64) NOT NULL,
  tenant_prospect_id VARCHAR(90) DEFAULT '',
  organization_id VARCHAR(90) DEFAULT '',
  lead_id VARCHAR(64) DEFAULT '',
  source_event_id VARCHAR(90) DEFAULT '',
  source_label VARCHAR(120) DEFAULT '',
  source_url VARCHAR(500) DEFAULT '',
  suggested_fields_json JSON,
  website VARCHAR(500) DEFAULT '',
  business VARCHAR(500) DEFAULT '',
  contact_info VARCHAR(500) DEFAULT '',
  evidence_summary TEXT,
  evidence_refs_json JSON,
  payload_hash CHAR(64) NOT NULL,
  suggestion_status VARCHAR(30) NOT NULL,
  accepted_fields_json JSON,
  reviewed_by VARCHAR(64) DEFAULT '',
  reviewed_at DATETIME NULL,
  review_note VARCHAR(500) DEFAULT '',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uniq_customer_intelligence_payload (
    team_id, owner_id, customer_id, payload_hash
  ),
  INDEX idx_customer_intelligence_customer (
    team_id, owner_id, customer_id, suggestion_status
  ),
  INDEX idx_customer_intelligence_candidate (prospect_candidate_id),
  INDEX idx_customer_intelligence_organization (organization_id)
);

CREATE TABLE acquisition_outcome_feedback (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  deal_id VARCHAR(64) NOT NULL,
  customer_id VARCHAR(64) NOT NULL,
  lead_id VARCHAR(64) DEFAULT '',
  prospect_candidate_id VARCHAR(64) DEFAULT '',
  tenant_prospect_id VARCHAR(90) DEFAULT '',
  organization_id VARCHAR(90) DEFAULT '',
  campaign_id VARCHAR(90) DEFAULT '',
  campaign_version INT DEFAULT 0,
  strategy_id VARCHAR(90) DEFAULT '',
  run_id VARCHAR(90) DEFAULT '',
  provider_codes_json JSON,
  icp_assessment_id VARCHAR(90) DEFAULT '',
  icp_policy_id VARCHAR(90) DEFAULT '',
  outcome VARCHAR(12) NOT NULL,
  amount DECIMAL(14,2) DEFAULT 0,
  currency VARCHAR(12) DEFAULT 'USD',
  reason_category VARCHAR(80) DEFAULT '',
  reason_text TEXT,
  closed_at DATETIME NOT NULL,
  attribution_confidence INT NOT NULL,
  attribution_reason_codes_json JSON,
  payload_hash CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uniq_acquisition_outcome_deal (team_id, owner_id, deal_id),
  INDEX idx_acquisition_outcome_scope (
    team_id, owner_id, campaign_id, strategy_id, closed_at
  ),
  INDEX idx_acquisition_outcome_provider (team_id, owner_id, outcome)
);

CREATE TABLE prospect_strategy_suggestions (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  campaign_id VARCHAR(90) NOT NULL,
  campaign_version INT DEFAULT 0,
  strategy_id VARCHAR(90) NOT NULL,
  suggestion_type VARCHAR(60) NOT NULL,
  sample_metrics_json JSON,
  proposed_adjustments_json JSON,
  rationale TEXT,
  reason_codes_json JSON,
  sample_from DATETIME NULL,
  sample_to DATETIME NULL,
  payload_hash CHAR(64) NOT NULL,
  suggestion_status VARCHAR(20) NOT NULL,
  reviewed_by VARCHAR(64) DEFAULT '',
  reviewed_at DATETIME NULL,
  review_note VARCHAR(500) DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uniq_prospect_strategy_suggestion_payload (
    team_id, owner_id, payload_hash
  ),
  INDEX idx_prospect_strategy_suggestion_scope (
    team_id, owner_id, suggestion_status, created_at
  ),
  INDEX idx_prospect_strategy_suggestion_strategy (
    team_id, owner_id, campaign_id, strategy_id
  )
);

CREATE TABLE customer_acquisition_source_events (
  id VARCHAR(64) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  customer_id VARCHAR(64) NOT NULL,
  lead_id VARCHAR(64) NOT NULL,
  lead_source_event_id VARCHAR(64) NOT NULL,
  prospect_id VARCHAR(90) NOT NULL,
  organization_id VARCHAR(90) NOT NULL,
  source_channel VARCHAR(80) NOT NULL,
  source_campaign VARCHAR(120) DEFAULT '',
  source_url VARCHAR(500) DEFAULT '',
  conversion_mode VARCHAR(20) NOT NULL,
  processing_key_hash CHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_case_processing(team_id,owner_id,processing_key_hash),
  UNIQUE KEY uk_case_prospect(team_id,prospect_id),
  UNIQUE KEY uk_case_organization(team_id,organization_id),
  UNIQUE KEY uk_case_lead(team_id,owner_id,lead_id),
  INDEX idx_case_customer(customer_id),
  CONSTRAINT chk_case_mode CHECK (
    conversion_mode IN ('create_new','link_existing')
  )
);

CREATE TABLE leads (
  id VARCHAR(64) PRIMARY KEY,
  company VARCHAR(200) NOT NULL,
  contact VARCHAR(100) DEFAULT '',
  country VARCHAR(80) DEFAULT '',
  email VARCHAR(180) DEFAULT '',
  phone VARCHAR(80) DEFAULT '',
  wechat VARCHAR(80) DEFAULT '',
  source VARCHAR(80) DEFAULT '',
  source_type VARCHAR(30) DEFAULT 'outbound',
  source_channel VARCHAR(80) DEFAULT 'manual',
  source_campaign VARCHAR(120) DEFAULT '',
  external_id VARCHAR(180) DEFAULT '',
  source_url VARCHAR(500) DEFAULT '',
  intent VARCHAR(20) DEFAULT '中',
  stage VARCHAR(40) DEFAULT '新线索',
  status VARCHAR(20) DEFAULT 'new',
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) GENERATED ALWAYS AS (team_id) STORED,
  estimated_amount DECIMAL(14,2) DEFAULT 0,
  next_follow_at VARCHAR(100) DEFAULT '',
  last_activity_at VARCHAR(100) DEFAULT '',
  remark TEXT,
  converted_customer_id VARCHAR(64) DEFAULT '',
  converted_deal_id VARCHAR(64) DEFAULT '',
  deleted_at DATETIME NULL,
  deleted_reason VARCHAR(255) DEFAULT '',
  deleted_by VARCHAR(64) DEFAULT '',
  purge_at DATETIME NULL,
  status_before_delete VARCHAR(20) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_leads_owner(owner_id),
  INDEX idx_leads_team(team_id),
  INDEX idx_leads_stage(stage)
);

CREATE TABLE lead_activities (
  id VARCHAR(64) PRIMARY KEY,
  lead_id VARCHAR(64) NOT NULL,
  type VARCHAR(30) DEFAULT 'note',
  content TEXT,
  operator_id VARCHAR(64) DEFAULT '',
  next_follow_at VARCHAR(100) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lead_activities_lead(lead_id)
);

CREATE TABLE lead_source_events (
  id VARCHAR(64) PRIMARY KEY,
  lead_id VARCHAR(64) NOT NULL,
  source_type VARCHAR(30) NOT NULL,
  channel VARCHAR(80) NOT NULL,
  campaign VARCHAR(120) DEFAULT '',
  external_id VARCHAR(180) DEFAULT '',
  source_url VARCHAR(500) DEFAULT '',
  occurred_at DATETIME NOT NULL,
  received_at DATETIME NOT NULL,
  raw_payload JSON,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  UNIQUE KEY uniq_lead_source_external (owner_id, channel, external_id),
  INDEX idx_lead_source_events_lead(lead_id)
);

CREATE TABLE deals (
  id VARCHAR(64) PRIMARY KEY,
  customer_id VARCHAR(64) NOT NULL,
  title VARCHAR(200) NOT NULL,
  stage VARCHAR(40) NOT NULL,
  product VARCHAR(200) DEFAULT '',
  quantity INT DEFAULT 0,
  unit_price DECIMAL(14,2) DEFAULT 0,
  items_json JSON,
  amount DECIMAL(14,2) DEFAULT 0,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  tenant_id VARCHAR(64) GENERATED ALWAYS AS (team_id) STORED,
  next_action VARCHAR(200),
  archived_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE todos (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  type VARCHAR(40) NOT NULL,
  priority VARCHAR(20) NOT NULL,
  due_at VARCHAR(100),
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  related VARCHAR(200),
  done BOOLEAN DEFAULT FALSE,
  status VARCHAR(24) DEFAULT 'pending',
  pin_state VARCHAR(20) DEFAULT '',
  sort_order INT DEFAULT 0,
  impact_amount DECIMAL(14,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  history_at TIMESTAMP NULL,
  INDEX idx_todos_owner_history(owner_id, history_at)
);

CREATE TABLE reminders (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  rule_text VARCHAR(255),
  due_at VARCHAR(100),
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  channel VARCHAR(40),
  status VARCHAR(40),
  rule_type VARCHAR(40),
  target_stage VARCHAR(40),
  days_count INT DEFAULT 3,
  priority VARCHAR(20) DEFAULT 'normal',
  enabled BOOLEAN DEFAULT TRUE,
  generated_count INT DEFAULT 0
);

CREATE TABLE knowledge_assets (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  category VARCHAR(100),
  status VARCHAR(40),
  owner_id VARCHAR(64),
  team_id VARCHAR(64) DEFAULT 'all',
  version VARCHAR(40),
  source_type VARCHAR(30) DEFAULT 'legacy',
  source_url VARCHAR(2048) DEFAULT '',
  share_code VARCHAR(64) DEFAULT '',
  file_type VARCHAR(30) DEFAULT 'other',
  description TEXT,
  tags_json JSON,
  access_count INT DEFAULT 0,
  last_accessed_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE exams (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  category VARCHAR(100),
  status VARCHAR(40),
  pass_rate DECIMAL(5,2),
  question_count INT DEFAULT 0,
  duration_minutes INT DEFAULT 20,
  pass_score INT DEFAULT 80,
  target_role VARCHAR(40) DEFAULT 'sales',
  instructions TEXT,
  start_at TIMESTAMP NULL,
  end_at TIMESTAMP NULL,
  max_attempts INT DEFAULT 1,
  allow_review BOOLEAN DEFAULT FALSE,
  published_at TIMESTAMP NULL,
  closed_at TIMESTAMP NULL,
  owner_id VARCHAR(64) DEFAULT '',
  team_id VARCHAR(64) DEFAULT 'all',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE exam_questions (
  id VARCHAR(64) PRIMARY KEY,
  exam_id VARCHAR(64) DEFAULT 'bank',
  stem TEXT NOT NULL,
  options_json JSON NOT NULL,
  answer_index INT NOT NULL,
  answer_indexes_json JSON,
  question_type VARCHAR(20) DEFAULT 'single',
  tags_json JSON,
  explanation TEXT,
  category VARCHAR(100),
  difficulty VARCHAR(20),
  owner_id VARCHAR(64) DEFAULT '',
  team_id VARCHAR(64) DEFAULT 'all',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_exam_questions_exam_id (exam_id)
);

CREATE TABLE exam_question_links (
  exam_id VARCHAR(64) NOT NULL,
  question_id VARCHAR(64) NOT NULL,
  sort_order INT DEFAULT 0,
  PRIMARY KEY (exam_id, question_id),
  INDEX idx_exam_question_links_exam(exam_id),
  INDEX idx_exam_question_links_question(question_id)
);

CREATE TABLE exam_attempts (
  id VARCHAR(64) PRIMARY KEY,
  exam_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  user_name VARCHAR(120),
  category VARCHAR(100),
  score DECIMAL(5,2),
  passed BOOLEAN,
  answers_json JSON,
  correct_count INT DEFAULT 0,
  total_questions INT DEFAULT 0,
  attempt_status VARCHAR(30) DEFAULT 'submitted',
  started_at TIMESTAMP NULL,
  expires_at TIMESTAMP NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_exam_attempts_exam_id (exam_id),
  INDEX idx_exam_attempts_user_id (user_id)
);

CREATE TABLE exam_assignments (
  id VARCHAR(96) PRIMARY KEY,
  exam_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  assigned_by_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  assignment_status VARCHAR(30) DEFAULT 'pending',
  attempt_count INT DEFAULT 0,
  best_score DECIMAL(5,2) DEFAULT 0,
  latest_attempt_id VARCHAR(64) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_exam_assignment (exam_id, user_id),
  INDEX idx_exam_assignments_user (user_id),
  INDEX idx_exam_assignments_team (team_id)
);

CREATE TABLE exam_snapshots (
  exam_id VARCHAR(64) PRIMARY KEY,
  questions_json JSON NOT NULL,
  rules_json JSON NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ocr_jobs (
  id VARCHAR(64) PRIMARY KEY,
  status VARCHAR(40),
  confidence DECIMAL(5,2),
  fields_json JSON,
  created_by VARCHAR(64),
  owner_id VARCHAR(64) NOT NULL DEFAULT 'u_sales_shirley',
  team_id VARCHAR(64) NOT NULL DEFAULT 'europe',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ocr_jobs_owner(owner_id),
  INDEX idx_ocr_jobs_team(team_id)
);

CREATE TABLE website_opportunities (
  id VARCHAR(64) PRIMARY KEY,
  company VARCHAR(200) NOT NULL,
  business VARCHAR(255),
  country VARCHAR(80),
  website VARCHAR(255),
  contact VARCHAR(120),
  contact_info VARCHAR(255),
  description TEXT,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  status VARCHAR(30),
  customer_id VARCHAR(64),
  deal_id VARCHAR(64),
  lead_id VARCHAR(64),
  parse_mode VARCHAR(20) DEFAULT 'rule',
  source VARCHAR(40) DEFAULT '',
  source_label VARCHAR(80) DEFAULT '',
  source_evidence_json JSON,
  extracted_contacts_json JSON,
  contact_enrichment_attempts_json JSON,
  website_discovery_attempts_json JSON,
  confidence INT NULL,
  last_development_email_at DATETIME NULL,
  last_development_email_subject VARCHAR(255) DEFAULT '',
  last_development_email_to VARCHAR(180) DEFAULT '',
  verified_at DATETIME NULL,
  status_changed_at DATETIME NULL,
  excluded_reason VARCHAR(255) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_website_opps_owner(owner_id),
  INDEX idx_website_opps_team(team_id)
);

CREATE TABLE ai_model_configs (
  id VARCHAR(64) PRIMARY KEY,
  provider VARCHAR(40) NOT NULL DEFAULT 'openai',
  protocol VARCHAR(40) NOT NULL DEFAULT 'openai-compatible',
  name VARCHAR(120) NOT NULL,
  base_url VARCHAR(255) NOT NULL,
  model VARCHAR(120) NOT NULL,
  api_key TEXT,
  enabled BOOLEAN DEFAULT FALSE,
  temperature DECIMAL(4,2) DEFAULT 0.10,
  use_lead_finder BOOLEAN DEFAULT TRUE,
  use_website_parse BOOLEAN DEFAULT TRUE,
  use_scoring BOOLEAN DEFAULT TRUE,
  use_email_draft BOOLEAN DEFAULT TRUE,
  use_exam BOOLEAN DEFAULT FALSE,
  last_test_at DATETIME NULL,
  last_test_status VARCHAR(20) DEFAULT 'untested',
  last_test_message VARCHAR(255) DEFAULT '',
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ai_model_owner(owner_id)
);

CREATE TABLE lead_source_configs (
  id VARCHAR(64) PRIMARY KEY,
  provider VARCHAR(40) NOT NULL,
  scope VARCHAR(20) NOT NULL DEFAULT 'personal',
  api_key TEXT,
  base_url VARCHAR(255) DEFAULT '',
  enabled BOOLEAN DEFAULT FALSE,
  last_test_at DATETIME NULL,
  last_test_status VARCHAR(20) DEFAULT 'untested',
  last_test_message VARCHAR(255) DEFAULT '',
  usage_json TEXT,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lead_source_owner(owner_id)
);

CREATE TABLE provider_catalog (
  id VARCHAR(64) PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  category VARCHAR(40) NOT NULL,
  source_level VARCHAR(40) NOT NULL,
  access_mode VARCHAR(40) NOT NULL,
  base_url VARCHAR(255) DEFAULT '',
  official_docs_url VARCHAR(255) DEFAULT '',
  capability_json JSON NOT NULL,
  allowed_fields_json JSON NOT NULL,
  license_policy_json JSON NOT NULL,
  default_rate_policy_json JSON NOT NULL,
  retention_policy_json JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  version VARCHAR(40) NOT NULL DEFAULT '1.0',
  reviewed_at DATETIME NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  INDEX idx_provider_catalog_status(status)
);

CREATE TABLE provider_connections (
  id VARCHAR(64) PRIMARY KEY,
  provider_id VARCHAR(64) NOT NULL,
  scope VARCHAR(20) NOT NULL DEFAULT 'personal',
  credential_ref VARCHAR(80) NOT NULL UNIQUE,
  configuration_encrypted TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'disabled',
  quota_policy_json JSON NOT NULL,
  budget_policy_json JSON NOT NULL,
  last_health_at DATETIME NULL,
  last_health_status VARCHAR(20) NOT NULL DEFAULT 'untested',
  last_error_code VARCHAR(80) DEFAULT '',
  last_health_message VARCHAR(255) DEFAULT '',
  usage_text TEXT,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uk_provider_connection_owner(provider_id, owner_id),
  INDEX idx_provider_connection_team(team_id),
  INDEX idx_provider_connection_status(status)
);

CREATE TABLE provider_request_logs (
  id VARCHAR(80) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  connection_id VARCHAR(64) DEFAULT '',
  run_id VARCHAR(80) NOT NULL,
  run_shard_id VARCHAR(120) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  endpoint_code VARCHAR(80) NOT NULL,
  http_status INT NOT NULL DEFAULT 0,
  attempt INT NOT NULL DEFAULT 1,
  quota_units DECIMAL(12,4) NOT NULL DEFAULT 0,
  cost_amount DECIMAL(16,6) NOT NULL DEFAULT 0,
  currency VARCHAR(12) DEFAULT '',
  duration_ms INT NOT NULL DEFAULT 0,
  response_size BIGINT NOT NULL DEFAULT 0,
  error_code VARCHAR(80) DEFAULT '',
  requested_at DATETIME NOT NULL,
  INDEX idx_provider_request_team_time(team_id, requested_at),
  INDEX idx_provider_request_owner_time(owner_id, requested_at),
  INDEX idx_provider_request_run(run_id),
  INDEX idx_provider_request_provider(provider_id, requested_at)
);

CREATE TABLE market_trade_observations (
  id VARCHAR(80) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  campaign_id VARCHAR(80) NOT NULL,
  provider_id VARCHAR(64) NOT NULL,
  reporter_country VARCHAR(100) NOT NULL,
  partner_country VARCHAR(100) NOT NULL,
  reporter_code VARCHAR(16) DEFAULT '',
  partner_code VARCHAR(16) DEFAULT '',
  trade_flow VARCHAR(16) NOT NULL,
  classification VARCHAR(40) NOT NULL,
  commodity_code VARCHAR(32) NOT NULL,
  commodity_description VARCHAR(500) DEFAULT '',
  period_value VARCHAR(16) NOT NULL,
  trade_value_usd DECIMAL(24,4) NULL,
  net_weight_kg DECIMAL(24,6) NULL,
  quantity_value DECIMAL(24,6) NULL,
  quantity_unit VARCHAR(40) DEFAULT '',
  is_aggregate BOOLEAN NOT NULL DEFAULT FALSE,
  suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  status_flags_json JSON NOT NULL,
  raw_record_id VARCHAR(255) NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  adapter_version VARCHAR(40) NOT NULL,
  source_revision VARCHAR(120) DEFAULT '',
  observed_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uk_market_trade_observation(
    team_id,
    owner_id,
    campaign_id,
    provider_id,
    reporter_country,
    partner_country,
    trade_flow,
    classification,
    commodity_code,
    period_value
  ),
  INDEX idx_market_trade_team_campaign(team_id, campaign_id, observed_at),
  INDEX idx_market_trade_owner_campaign(owner_id, campaign_id, observed_at)
);

CREATE TABLE agent_jobs (
  id VARCHAR(80) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  job_type VARCHAR(80) NOT NULL,
  aggregate_type VARCHAR(80) DEFAULT '',
  aggregate_id VARCHAR(100) DEFAULT '',
  parent_job_id VARCHAR(80) DEFAULT '',
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  priority INT NOT NULL DEFAULT 50,
  idempotency_key CHAR(64) NOT NULL,
  policy_version VARCHAR(40) NOT NULL DEFAULT 'v1',
  input_json_encrypted MEDIUMTEXT NOT NULL,
  output_json_encrypted MEDIUMTEXT,
  attempt_count INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  next_attempt_at DATETIME(3) NULL,
  error_code VARCHAR(80) DEFAULT '',
  error_message VARCHAR(255) DEFAULT '',
  trace_id VARCHAR(100) NOT NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_agent_job_idempotency(team_id, job_type, idempotency_key),
  UNIQUE KEY uk_agent_job_queue_bridge_ref(
    team_id,
    owner_id,
    id,
    job_type,
    parent_job_id
  ),
  UNIQUE KEY uk_agent_job_execution_ref(team_id, owner_id, id),
  INDEX idx_agent_job_owner_time(owner_id, created_at),
  INDEX idx_agent_job_team_status(team_id, status, next_attempt_at),
  INDEX idx_agent_job_parent(parent_job_id)
);

CREATE TABLE agent_job_idempotency_aliases (
  id VARCHAR(80) PRIMARY KEY,
  job_id VARCHAR(80) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  job_type VARCHAR(80) NOT NULL,
  idempotency_key CHAR(64) NOT NULL,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uk_agent_job_alias_idempotency(team_id, job_type, idempotency_key),
  INDEX idx_agent_job_alias_job(job_id)
);

CREATE TABLE import_export_jobs (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(20) NOT NULL,
  rows_count INT DEFAULT 0,
  status VARCHAR(40),
  operator_id VARCHAR(64),
  created_at VARCHAR(100)
);

CREATE TABLE trade_documents (
  id VARCHAR(64) PRIMARY KEY,
  customer_id VARCHAR(64) DEFAULT '',
  deal_id VARCHAR(64) DEFAULT '',
  revision INT DEFAULT 1,
  doc_type VARCHAR(10) NOT NULL,
  title VARCHAR(255) NOT NULL,
  doc_number VARCHAR(80) NOT NULL,
  issue_date VARCHAR(40),
  buyer VARCHAR(200),
  buyer_address TEXT,
  buyer_contact VARCHAR(200),
  seller VARCHAR(200),
  seller_address TEXT,
  seller_contact VARCHAR(200) DEFAULT '',
  seller_phone VARCHAR(120) DEFAULT '',
  seller_email VARCHAR(180) DEFAULT '',
  seller_website VARCHAR(500) DEFAULT '',
  seller_tax_no VARCHAR(160) DEFAULT '',
  currency VARCHAR(12),
  incoterm VARCHAR(80),
  payment_term VARCHAR(255),
  shipping_method VARCHAR(120),
  port_loading VARCHAR(120),
  port_discharge VARCHAR(120),
  validity_date VARCHAR(40),
  bank_info TEXT,
  notes TEXT,
  template_style VARCHAR(40),
  language VARCHAR(8) DEFAULT 'EN',
  status VARCHAR(40),
  approval_note TEXT,
  approved_at VARCHAR(100),
  approved_by VARCHAR(64),
  audits_json JSON,
  send_records_json JSON,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  items_json JSON,
  letterhead_id VARCHAR(64) DEFAULT '',
  stamp_id VARCHAR(64) DEFAULT '',
  signature_id VARCHAR(64) DEFAULT '',
  include_product_images BOOLEAN NOT NULL DEFAULT FALSE,
  letterhead_snapshot_json JSON,
  stamp_snapshot_json JSON,
  signature_snapshot_json JSON,
  derived_from_document_id VARCHAR(64) DEFAULT '',
  derived_from_type VARCHAR(20) DEFAULT '',
  import_analysis_id VARCHAR(64) DEFAULT '',
  import_source_file_name VARCHAR(255) DEFAULT '',
  import_source_sha256 CHAR(64) DEFAULT '',
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trade_documents_owner(owner_id),
  INDEX idx_trade_documents_team(team_id)
);

CREATE TABLE trade_document_import_analyses (
  id VARCHAR(64) PRIMARY KEY,
  source_file_name VARCHAR(255) NOT NULL,
  source_mime VARCHAR(120) NOT NULL,
  source_storage_key VARCHAR(255) NOT NULL,
  source_sha256 CHAR(64) NOT NULL,
  source_size BIGINT UNSIGNED NOT NULL,
  analysis_status VARCHAR(30) NOT NULL,
  detected_type VARCHAR(20) NOT NULL,
  confidence DECIMAL(6,5) NOT NULL DEFAULT 0,
  extracted_document_json JSON NOT NULL,
  field_evidence_json JSON,
  warnings_json JSON,
  source_preview_json JSON,
  calculated_total DECIMAL(18,4) NOT NULL DEFAULT 0,
  declared_total DECIMAL(18,4) NULL,
  total_difference DECIMAL(18,4) NULL,
  created_document_id VARCHAR(64) DEFAULT '',
  confirmed_by VARCHAR(64) DEFAULT '',
  confirmed_at DATETIME(3) NULL,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_trade_document_import_team_hash(team_id, source_sha256),
  INDEX idx_trade_document_import_owner(owner_id, created_at),
  INDEX idx_trade_document_import_team(team_id, created_at)
);

CREATE TABLE wecom_messages (
  id VARCHAR(64) PRIMARY KEY,
  customer_id VARCHAR(64),
  summary TEXT,
  owner_id VARCHAR(64),
  team_id VARCHAR(64),
  status VARCHAR(40),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE problems (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(80),
  severity VARCHAR(20),
  status VARCHAR(30),
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  related_customer VARCHAR(200),
  root_cause TEXT,
  solution TEXT,
  next_action VARCHAR(255),
  due_at VARCHAR(100),
  resolved_at DATETIME NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_problems_owner(owner_id),
  INDEX idx_problems_team(team_id)
);

CREATE TABLE memos (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(200) NOT NULL,
  content TEXT,
  category VARCHAR(80),
  tags VARCHAR(255),
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  pinned BOOLEAN DEFAULT FALSE,
  archived BOOLEAN DEFAULT FALSE,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_memos_owner(owner_id),
  INDEX idx_memos_team(team_id)
);

CREATE TABLE competitors (
  id VARCHAR(64) PRIMARY KEY,
  company VARCHAR(200) NOT NULL,
  country VARCHAR(80),
  segment VARCHAR(100),
  threat_level VARCHAR(20),
  website VARCHAR(255),
  strengths TEXT,
  weaknesses TEXT,
  competing_products TEXT,
  our_strategy TEXT,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_competitors_owner(owner_id),
  INDEX idx_competitors_team(team_id)
);

CREATE TABLE case_studies (
  id VARCHAR(64) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  customer VARCHAR(200),
  country VARCHAR(80),
  product VARCHAR(160),
  industry VARCHAR(120),
  result_text VARCHAR(255),
  story TEXT,
  reusable_points TEXT,
  status VARCHAR(30),
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_case_studies_owner(owner_id),
  INDEX idx_case_studies_team(team_id)
);

CREATE TABLE commission_products (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  category VARCHAR(100) DEFAULT '',
  model VARCHAR(120) DEFAULT '',
  currency VARCHAR(12) DEFAULT 'USD',
  default_price DECIMAL(14,2) DEFAULT 0,
  cost_price DECIMAL(14,2) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  remark TEXT,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  updated_at DATETIME NULL,
  INDEX idx_commission_products_status(status)
);

CREATE TABLE commission_rules (
  id VARCHAR(64) PRIMARY KEY,
  product_id VARCHAR(64) NOT NULL,
  rule_type VARCHAR(30) NOT NULL,
  rate DECIMAL(8,4) DEFAULT 0,
  fixed_amount DECIMAL(14,2) DEFAULT 0,
  tier_json TEXT,
  gross_profit_rate DECIMAL(8,4) DEFAULT 0,
  effective_from VARCHAR(20) DEFAULT '',
  effective_to VARCHAR(20) DEFAULT '',
  enabled BOOLEAN DEFAULT TRUE,
  remark TEXT,
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME NULL,
  INDEX idx_commission_rules_product(product_id)
);

CREATE TABLE monthly_sales_records (
  id VARCHAR(64) PRIMARY KEY,
  month_value VARCHAR(20) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  customer_id VARCHAR(64) DEFAULT '',
  customer_name VARCHAR(200) DEFAULT '',
  deal_id VARCHAR(64) DEFAULT '',
  product_id VARCHAR(64) DEFAULT '',
  product_name VARCHAR(200) DEFAULT '',
  quantity DECIMAL(14,2) DEFAULT 0,
  unit_price DECIMAL(14,2) DEFAULT 0,
  sales_amount DECIMAL(14,2) DEFAULT 0,
  currency VARCHAR(12) DEFAULT 'USD',
  exchange_rate DECIMAL(14,4) DEFAULT 1,
  settlement_amount DECIMAL(14,2) DEFAULT 0,
  deal_archived_at VARCHAR(80) DEFAULT '',
  source_type VARCHAR(20) DEFAULT 'manual',
  status VARCHAR(30) DEFAULT 'draft',
  edited BOOLEAN DEFAULT FALSE,
  edit_note TEXT,
  last_edited_by VARCHAR(64) DEFAULT '',
  last_edited_at DATETIME NULL,
  created_at DATETIME NULL,
  updated_at DATETIME NULL,
  INDEX idx_monthly_sales_scope(month_value, owner_id),
  INDEX idx_monthly_sales_team(month_value, team_id),
  INDEX idx_monthly_sales_deal(deal_id)
);

CREATE TABLE sales_record_audits (
  id VARCHAR(64) PRIMARY KEY,
  record_id VARCHAR(64) NOT NULL,
  field_name VARCHAR(80) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  operator_id VARCHAR(64) NOT NULL,
  operator_name VARCHAR(120) DEFAULT '',
  created_at DATETIME NULL,
  INDEX idx_sales_record_audits_record(record_id)
);

CREATE TABLE commission_calculations (
  id VARCHAR(64) PRIMARY KEY,
  month_value VARCHAR(20) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  sales_amount DECIMAL(14,2) DEFAULT 0,
  auto_commission DECIMAL(14,2) DEFAULT 0,
  manual_adjustment DECIMAL(14,2) DEFAULT 0,
  final_commission DECIMAL(14,2) DEFAULT 0,
  status VARCHAR(30) DEFAULT 'pending',
  calculated_at DATETIME NULL,
  reviewed_by VARCHAR(64) DEFAULT '',
  reviewed_at DATETIME NULL,
  locked_by VARCHAR(64) DEFAULT '',
  locked_at DATETIME NULL,
  unlock_reason TEXT,
  INDEX idx_commission_calculations_scope(month_value, owner_id),
  INDEX idx_commission_calculations_team(month_value, team_id)
);

CREATE TABLE commission_items (
  id VARCHAR(64) PRIMARY KEY,
  calculation_id VARCHAR(64) NOT NULL,
  record_id VARCHAR(64) DEFAULT '',
  product_id VARCHAR(64) DEFAULT '',
  item_type VARCHAR(30) DEFAULT 'auto',
  source_type VARCHAR(20) DEFAULT 'auto',
  rule_snapshot_json TEXT,
  sales_amount DECIMAL(14,2) DEFAULT 0,
  auto_amount DECIMAL(14,2) DEFAULT 0,
  manual_amount DECIMAL(14,2) DEFAULT 0,
  final_amount DECIMAL(14,2) DEFAULT 0,
  remark TEXT,
  created_by VARCHAR(64) DEFAULT '',
  created_at DATETIME NULL,
  INDEX idx_commission_items_calc(calculation_id)
);

CREATE TABLE commission_exports (
  id VARCHAR(64) PRIMARY KEY,
  month_value VARCHAR(20) NOT NULL,
  scope_type VARCHAR(20) DEFAULT 'self',
  scope_owner_id VARCHAR(64) DEFAULT '',
  file_type VARCHAR(20) DEFAULT 'xlsx',
  rows_count INT DEFAULT 0,
  exported_by VARCHAR(64) NOT NULL,
  created_at DATETIME NULL,
  INDEX idx_commission_exports_month(month_value)
);

CREATE TABLE prospect_campaigns (
  id VARCHAR(80) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(20) NOT NULL,
  current_version INT NOT NULL,
  revision_no INT NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  archived_at DATETIME(3) NULL,
  UNIQUE KEY uk_prospect_campaign_team_id(team_id, id),
  INDEX idx_prospect_campaign_owner_status(team_id, owner_id, status),
  INDEX idx_prospect_campaign_updated(team_id, updated_at),
  CONSTRAINT chk_prospect_campaign_status
    CHECK (status IN ('draft','active','paused','completed','archived')),
  CONSTRAINT chk_prospect_campaign_versions
    CHECK (current_version >= 1 AND revision_no >= 1)
);

CREATE TABLE prospect_campaign_versions (
  id VARCHAR(80) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  campaign_id VARCHAR(80) NOT NULL,
  version_no INT NOT NULL,
  snapshot_json JSON NOT NULL,
  content_hash CHAR(64) NOT NULL,
  change_summary VARCHAR(500) DEFAULT '',
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_prospect_campaign_version(team_id, campaign_id, version_no),
  INDEX idx_prospect_campaign_version_time(team_id, campaign_id, created_at),
  CONSTRAINT fk_prospect_campaign_version_campaign
    FOREIGN KEY (team_id, campaign_id)
    REFERENCES prospect_campaigns(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_campaign_version_no CHECK (version_no >= 1)
);

CREATE TABLE prospect_campaign_events (
  id VARCHAR(80) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  campaign_id VARCHAR(80) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  actor_id VARCHAR(64) NOT NULL,
  request_id VARCHAR(100) NOT NULL,
  from_status VARCHAR(20) DEFAULT '',
  to_status VARCHAR(20) DEFAULT '',
  from_owner_id VARCHAR(64) DEFAULT '',
  to_owner_id VARCHAR(64) DEFAULT '',
  from_version INT NOT NULL DEFAULT 0,
  to_version INT NOT NULL DEFAULT 0,
  revision_no INT NOT NULL,
  reason VARCHAR(500) DEFAULT '',
  created_at DATETIME(3) NOT NULL,
  INDEX idx_prospect_campaign_event_time(team_id, campaign_id, created_at),
  CONSTRAINT fk_prospect_campaign_event_campaign
    FOREIGN KEY (team_id, campaign_id)
    REFERENCES prospect_campaigns(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_campaign_event_revision CHECK (revision_no >= 1)
);

CREATE TABLE prospect_strategies (
  id VARCHAR(80) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  campaign_id VARCHAR(80) NOT NULL,
  campaign_version INT NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  name VARCHAR(160) NOT NULL,
  status VARCHAR(20) NOT NULL,
  revision_no INT NOT NULL,
  execution_epoch INT NOT NULL DEFAULT 1,
  query_json JSON NOT NULL,
  provider_plan_json JSON NOT NULL,
  query_fingerprint CHAR(64) NOT NULL,
  fingerprint_version VARCHAR(20) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  approved_by VARCHAR(64) DEFAULT '',
  approved_at DATETIME(3) NULL,
  disabled_by VARCHAR(64) DEFAULT '',
  disabled_at DATETIME(3) NULL,
  disable_reason VARCHAR(500) DEFAULT '',
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_prospect_strategy_team_id(team_id, id),
  UNIQUE KEY uk_prospect_strategy_run_ref(
    team_id,
    campaign_id,
    campaign_version,
    id
  ),
  INDEX idx_prospect_strategy_campaign_status(
    team_id,
    campaign_id,
    campaign_version,
    status
  ),
  INDEX idx_prospect_strategy_owner_status(team_id, owner_id, status),
  INDEX idx_prospect_strategy_fingerprint(
    team_id,
    campaign_id,
    campaign_version,
    query_fingerprint
  ),
  CONSTRAINT fk_prospect_strategy_campaign_version
    FOREIGN KEY (team_id, campaign_id, campaign_version)
    REFERENCES prospect_campaign_versions(team_id, campaign_id, version_no)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_strategy_status
    CHECK (status IN ('draft','approved','disabled')),
  CONSTRAINT chk_prospect_strategy_revision CHECK (revision_no >= 1)
);

CREATE TABLE prospect_strategy_events (
  id VARCHAR(80) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  campaign_id VARCHAR(80) NOT NULL,
  strategy_id VARCHAR(80) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  actor_id VARCHAR(64) NOT NULL,
  request_id VARCHAR(100) NOT NULL,
  from_status VARCHAR(20) DEFAULT '',
  to_status VARCHAR(20) NOT NULL,
  from_revision INT NOT NULL,
  to_revision INT NOT NULL,
  reason VARCHAR(500) DEFAULT '',
  created_at DATETIME(3) NOT NULL,
  INDEX idx_prospect_strategy_event_time(team_id, strategy_id, created_at),
  CONSTRAINT fk_prospect_strategy_event_strategy
    FOREIGN KEY (team_id, strategy_id)
    REFERENCES prospect_strategies(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_strategy_event_revision
    CHECK (from_revision >= 0 AND to_revision >= 1)
);

CREATE TABLE prospect_super_search_missions (
  id VARCHAR(80) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  campaign_id VARCHAR(80) NOT NULL,
  strategy_id VARCHAR(80) NOT NULL,
  mission_status VARCHAR(30) NOT NULL,
  revision_no INT NOT NULL,
  mission_json JSON NOT NULL,
  rounds_json JSON NOT NULL,
  events_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_super_search_owner(team_id, owner_id, mission_status),
  INDEX idx_super_search_strategy(team_id, strategy_id, mission_status),
  CONSTRAINT chk_super_search_status CHECK (
    mission_status IN ('queued','running','paused','cancelled','succeeded','partial_success','failed')
  ),
  CONSTRAINT chk_super_search_revision CHECK (revision_no >= 1)
);

CREATE TABLE prospect_search_runs (
  id VARCHAR(80) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  campaign_id VARCHAR(80) NOT NULL,
  campaign_version INT NOT NULL,
  strategy_id VARCHAR(80) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  revision_no INT NOT NULL,
  execution_epoch INT NOT NULL DEFAULT 1,
  operation_code VARCHAR(40) NOT NULL,
  idempotency_key_hash CHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  query_fingerprint CHAR(64) NOT NULL,
  execution_snapshot_json JSON NOT NULL,
  execution_snapshot_hash CHAR(64) NOT NULL,
  queue_bridge_version VARCHAR(10) NULL,
  parent_run_id VARCHAR(80) DEFAULT '',
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  paused_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  active_team_id VARCHAR(64)
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN (
          'queued','running','pause_requested','paused','cancel_requested'
        ) THEN team_id
        ELSE NULL
      END
    ) STORED,
  active_owner_id VARCHAR(64)
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN (
          'queued','running','pause_requested','paused','cancel_requested'
        ) THEN owner_id
        ELSE NULL
      END
    ) STORED,
  active_query_fingerprint CHAR(64)
    GENERATED ALWAYS AS (
      CASE
        WHEN status IN (
          'queued','running','pause_requested','paused','cancel_requested'
        ) THEN query_fingerprint
        ELSE NULL
      END
    ) STORED,
  UNIQUE KEY uk_prospect_run_team_id(team_id, id),
  UNIQUE KEY uk_prospect_run_idempotency(
    team_id,
    created_by,
    operation_code,
    idempotency_key_hash
  ),
  UNIQUE KEY uk_prospect_run_active_fingerprint(
    active_team_id,
    active_owner_id,
    active_query_fingerprint
  ),
  INDEX idx_prospect_run_campaign(
    team_id,
    campaign_id,
    campaign_version,
    created_at
  ),
  INDEX idx_prospect_run_strategy(team_id, strategy_id, created_at),
  INDEX idx_prospect_run_owner_status(
    team_id,
    owner_id,
    status,
    created_at
  ),
  CONSTRAINT fk_prospect_run_campaign_version
    FOREIGN KEY (team_id, campaign_id, campaign_version)
    REFERENCES prospect_campaign_versions(team_id, campaign_id, version_no)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_run_strategy
    FOREIGN KEY (
      team_id,
      campaign_id,
      campaign_version,
      strategy_id
    )
    REFERENCES prospect_strategies(
      team_id,
      campaign_id,
      campaign_version,
      id
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_run_status
    CHECK (status IN (
      'queued','running','pause_requested','paused','cancel_requested',
      'cancelled','succeeded','succeeded_empty','partial_success','failed'
    )),
  CONSTRAINT chk_prospect_run_revision CHECK (revision_no >= 1),
  CONSTRAINT chk_prospect_run_operation
    CHECK (operation_code = 'create_search_run_v1'),
  CONSTRAINT chk_prospect_run_queue_bridge_version
    CHECK (
      queue_bridge_version IS NULL
      OR queue_bridge_version = 'v1'
    )
);

CREATE TABLE prospect_run_shards (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  provider_code VARCHAR(80) NOT NULL,
  position_no INT NOT NULL,
  status VARCHAR(20) NOT NULL,
  page_limit INT NOT NULL,
  result_limit INT NOT NULL,
  budget_limit VARCHAR(64) NULL,
  currency VARCHAR(3) DEFAULT '',
  adapter_version VARCHAR(80) NOT NULL,
  contract_version VARCHAR(80) NOT NULL,
  catalog_version VARCHAR(80) NOT NULL,
  capabilities_json JSON NOT NULL,
  access_mode VARCHAR(30) NOT NULL,
  has_cursor BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_prospect_run_shard_provider(
    team_id,
    run_id,
    provider_code
  ),
  UNIQUE KEY uk_prospect_run_shard_team_run_id(team_id, run_id, id),
  INDEX idx_prospect_run_shard_position(team_id, run_id, position_no),
  CONSTRAINT fk_prospect_run_shard_run
    FOREIGN KEY (team_id, run_id)
    REFERENCES prospect_search_runs(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_run_shard_status
    CHECK (status IN (
      'queued','running','retry_scheduled','pause_requested','paused',
      'cancel_requested','cancelled','succeeded','succeeded_empty',
      'partial_success','failed'
    )),
  CONSTRAINT chk_prospect_run_shard_limits
    CHECK (
      position_no >= 1
      AND page_limit >= 1
      AND result_limit >= 1
    ),
  CONSTRAINT chk_prospect_run_shard_cursor
    CHECK (has_cursor = FALSE)
);

CREATE TABLE prospect_run_events (
  id VARCHAR(80) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  sequence_no INT NOT NULL,
  event_type VARCHAR(20) NOT NULL,
  actor_id VARCHAR(64) NOT NULL,
  request_id VARCHAR(100) NOT NULL,
  from_status VARCHAR(20) DEFAULT '',
  to_status VARCHAR(20) NOT NULL,
  from_revision INT NOT NULL,
  to_revision INT NOT NULL,
  reason VARCHAR(500) DEFAULT '',
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_prospect_run_event_sequence(team_id, run_id, sequence_no),
  INDEX idx_prospect_run_event_time(team_id, run_id, created_at, id),
  CONSTRAINT fk_prospect_run_event_run
    FOREIGN KEY (team_id, run_id)
    REFERENCES prospect_search_runs(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_run_event_type
    CHECK (event_type IN (
      'created','started','pause_requested','paused','resumed',
      'cancel_requested','cancelled','completed','failed'
    )),
  CONSTRAINT chk_prospect_run_event_revision
    CHECK (
      sequence_no >= 1
      AND from_revision >= 0
      AND to_revision = from_revision + 1
  )
);

CREATE TABLE prospect_run_queue_parent_bindings (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  job_id VARCHAR(80) NOT NULL,
  job_type VARCHAR(80) NOT NULL,
  parent_job_id VARCHAR(80) NOT NULL DEFAULT '',
  bridge_version VARCHAR(10) NOT NULL,
  execution_snapshot_hash CHAR(64) NOT NULL,
  binding_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_prospect_run_queue_parent_run(team_id, run_id),
  UNIQUE KEY uk_prospect_run_queue_parent_job(team_id, job_id),
  UNIQUE KEY uk_prospect_run_queue_parent_child_ref(
    team_id,
    run_id,
    owner_id,
    job_id
  ),
  CONSTRAINT fk_prospect_run_queue_parent_run
    FOREIGN KEY (team_id, run_id)
    REFERENCES prospect_search_runs(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_run_queue_parent_job
    FOREIGN KEY (team_id, owner_id, job_id, job_type, parent_job_id)
    REFERENCES agent_jobs(team_id, owner_id, id, job_type, parent_job_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_run_queue_parent_contract
    CHECK (
      job_type = 'prospect.orchestrate'
      AND parent_job_id = ''
      AND bridge_version = 'v1'
    )
);

CREATE TABLE prospect_run_queue_child_bindings (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  shard_id VARCHAR(90) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  job_id VARCHAR(80) NOT NULL,
  job_type VARCHAR(80) NOT NULL,
  parent_job_id VARCHAR(80) NOT NULL,
  bridge_version VARCHAR(10) NOT NULL,
  execution_snapshot_hash CHAR(64) NOT NULL,
  binding_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_prospect_run_queue_child_shard(team_id, run_id, shard_id),
  UNIQUE KEY uk_prospect_run_queue_child_job(team_id, job_id),
  CONSTRAINT fk_prospect_run_queue_child_run
    FOREIGN KEY (team_id, run_id)
    REFERENCES prospect_search_runs(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_run_queue_child_shard
    FOREIGN KEY (team_id, run_id, shard_id)
    REFERENCES prospect_run_shards(team_id, run_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_run_queue_child_parent
    FOREIGN KEY (team_id, run_id, owner_id, parent_job_id)
    REFERENCES prospect_run_queue_parent_bindings(
      team_id,
      run_id,
      owner_id,
      job_id
    )
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_run_queue_child_job
    FOREIGN KEY (team_id, owner_id, job_id, job_type, parent_job_id)
    REFERENCES agent_jobs(team_id, owner_id, id, job_type, parent_job_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_run_queue_child_contract
    CHECK (
      job_type = 'prospect.provider.fetch'
      AND parent_job_id <> ''
      AND bridge_version = 'v1'
  )
);

CREATE TABLE search_execution_kernel_state (
  id VARCHAR(80) PRIMARY KEY,
  kernel_epoch BIGINT NOT NULL,
  instance_id VARCHAR(100) NOT NULL,
  started_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT chk_search_execution_kernel_epoch
    CHECK (kernel_epoch >= 1)
);

CREATE TABLE prospect_execution_checkpoints (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  shard_id VARCHAR(90) NOT NULL,
  job_id VARCHAR(80) NOT NULL,
  provider_code VARCHAR(80) NOT NULL,
  run_epoch BIGINT NOT NULL,
  checkpoint_no INT NOT NULL,
  encrypted_cursor MEDIUMTEXT,
  cursor_hash CHAR(64) DEFAULT '',
  page_sequence INT NOT NULL DEFAULT 0,
  total_call_count INT NOT NULL DEFAULT 0,
  checkpoint_call_count INT NOT NULL DEFAULT 0,
  accepted_count INT NOT NULL DEFAULT 0,
  raw_count INT NOT NULL DEFAULT 0,
  invalid_count INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0,
  retry_after_at DATETIME(3) NULL,
  last_error_code VARCHAR(80) DEFAULT '',
  last_error_message VARCHAR(500) DEFAULT '',
  partial BOOLEAN NOT NULL DEFAULT FALSE,
  completion_reason VARCHAR(80) DEFAULT '',
  version_no BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_prospect_execution_checkpoint_shard(
    team_id, run_id, shard_id
  ),
  UNIQUE KEY uk_prospect_execution_checkpoint_id(team_id, id),
  CONSTRAINT fk_prospect_execution_checkpoint_shard
    FOREIGN KEY (team_id, run_id, shard_id)
    REFERENCES prospect_run_shards(team_id, run_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_execution_checkpoint_job
    FOREIGN KEY (team_id, owner_id, job_id)
    REFERENCES agent_jobs(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_execution_checkpoint_counts
    CHECK (
      run_epoch >= 1
      AND checkpoint_no >= 1
      AND page_sequence >= 0
      AND total_call_count >= 0
      AND checkpoint_call_count BETWEEN 0 AND 3
      AND accepted_count >= 0
      AND raw_count >= 0
      AND invalid_count >= 0
      AND duplicate_count >= 0
      AND version_no >= 1
    )
);

CREATE TABLE prospect_execution_leases (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  shard_id VARCHAR(90) NOT NULL,
  job_id VARCHAR(80) NOT NULL,
  kernel_epoch BIGINT NOT NULL,
  run_epoch BIGINT NOT NULL,
  fence_token BIGINT NOT NULL,
  claim_token_hmac CHAR(64) NOT NULL,
  worker_id VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL,
  claimed_at DATETIME(3) NOT NULL,
  heartbeat_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  deadline_at DATETIME(3) NOT NULL,
  request_started_at DATETIME(3) NULL,
  released_at DATETIME(3) NULL,
  release_reason VARCHAR(80) DEFAULT '',
  version_no BIGINT NOT NULL,
  active_job_id VARCHAR(80)
    GENERATED ALWAYS AS (
      CASE WHEN status = 'active' THEN job_id ELSE NULL END
    ) STORED,
  active_run_id VARCHAR(80)
    GENERATED ALWAYS AS (
      CASE WHEN status = 'active' THEN run_id ELSE NULL END
    ) STORED,
  UNIQUE KEY uk_prospect_execution_lease_id(team_id, id),
  UNIQUE KEY uk_prospect_execution_active_job(team_id, active_job_id),
  UNIQUE KEY uk_prospect_execution_active_run(team_id, active_run_id),
  UNIQUE KEY uk_prospect_execution_fence(team_id, job_id, fence_token),
  CONSTRAINT fk_prospect_execution_lease_shard
    FOREIGN KEY (team_id, run_id, shard_id)
    REFERENCES prospect_run_shards(team_id, run_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_execution_lease_job
    FOREIGN KEY (team_id, owner_id, job_id)
    REFERENCES agent_jobs(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_execution_lease_status
    CHECK (status IN ('active','released','expired')),
  CONSTRAINT chk_prospect_execution_lease_fence
    CHECK (
      kernel_epoch >= 1
      AND run_epoch >= 1
      AND fence_token >= 1
      AND version_no >= 1
    )
);

CREATE TABLE prospect_execution_attempts (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  shard_id VARCHAR(90) NOT NULL,
  job_id VARCHAR(80) NOT NULL,
  lease_id VARCHAR(90) NOT NULL,
  provider_code VARCHAR(80) NOT NULL,
  checkpoint_no INT NOT NULL,
  checkpoint_call_no INT NOT NULL,
  provider_attempt_no INT NOT NULL,
  status VARCHAR(30) NOT NULL,
  request_hash CHAR(64) DEFAULT '',
  response_hash CHAR(64) DEFAULT '',
  error_code VARCHAR(80) DEFAULT '',
  error_message VARCHAR(500) DEFAULT '',
  retryable BOOLEAN NOT NULL DEFAULT FALSE,
  retry_after_at DATETIME(3) NULL,
  usage_json JSON NULL,
  cost_kind VARCHAR(20) NOT NULL,
  cost_amount DECIMAL(18,6) NULL,
  currency VARCHAR(3) DEFAULT '',
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  version_no BIGINT NOT NULL,
  UNIQUE KEY uk_prospect_execution_attempt_lease(team_id, lease_id),
  UNIQUE KEY uk_prospect_execution_attempt_id(team_id, id),
  CONSTRAINT fk_prospect_execution_attempt_lease
    FOREIGN KEY (team_id, lease_id)
    REFERENCES prospect_execution_leases(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_execution_attempt_shard
    FOREIGN KEY (team_id, run_id, shard_id)
    REFERENCES prospect_run_shards(team_id, run_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_execution_attempt_job
    FOREIGN KEY (team_id, owner_id, job_id)
    REFERENCES agent_jobs(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_execution_attempt_status
    CHECK (status IN (
      'claimed','request_started','succeeded','failed',
      'request_outcome_unknown','cancelled_late'
    )),
  CONSTRAINT chk_prospect_execution_attempt_counts
    CHECK (
      checkpoint_no >= 1
      AND checkpoint_call_no BETWEEN 0 AND 3
      AND provider_attempt_no >= 0
      AND version_no >= 1
    ),
  CONSTRAINT chk_prospect_execution_attempt_cost
    CHECK (
      cost_kind IN ('actual','estimated','unknown')
      AND (cost_amount IS NULL OR cost_amount >= 0)
  )
);

CREATE TABLE prospect_provider_request_ledgers (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  shard_id VARCHAR(90) NOT NULL,
  job_id VARCHAR(80) NOT NULL,
  origin_attempt_id VARCHAR(90) NOT NULL,
  checkpoint_no INT NOT NULL,
  logical_request_no INT NOT NULL,
  provider_code VARCHAR(80) NOT NULL,
  connection_id VARCHAR(100) NOT NULL,
  connection_revision VARCHAR(100) NOT NULL,
  connection_config_hash CHAR(64) NOT NULL,
  endpoint_code VARCHAR(100) NOT NULL,
  adapter_version VARCHAR(100) NOT NULL,
  contract_version VARCHAR(100) NOT NULL,
  request_schema_version VARCHAR(100) NOT NULL,
  idempotency_key CHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  encrypted_request_envelope MEDIUMTEXT,
  request_evidence_ref VARCHAR(500) DEFAULT '',
  status VARCHAR(30) NOT NULL,
  external_request_id VARCHAR(200) NULL,
  dispatch_confirmation_ref VARCHAR(500) DEFAULT '',
  encrypted_response_envelope MEDIUMTEXT,
  response_evidence_ref VARCHAR(500) DEFAULT '',
  response_hash CHAR(64) DEFAULT '',
  raw_response_hash CHAR(64) DEFAULT '',
  normalized_result_hash CHAR(64) DEFAULT '',
  response_accounting_evidence_hash CHAR(64) DEFAULT '',
  http_status INT NULL,
  provider_outcome_code VARCHAR(100) DEFAULT '',
  settlement_kind VARCHAR(40) DEFAULT '',
  settlement_hash CHAR(64) DEFAULT '',
  unknown_reason VARCHAR(500) DEFAULT '',
  error_code VARCHAR(100) DEFAULT '',
  kernel_epoch_at_prepare BIGINT NOT NULL,
  run_epoch_at_prepare BIGINT NOT NULL,
  fence_token_at_prepare BIGINT NOT NULL,
  lease_id_at_prepare VARCHAR(90) NOT NULL,
  prepared_at DATETIME(3) NOT NULL,
  dispatch_started_at DATETIME(3) NULL,
  dispatch_confirmed_at DATETIME(3) NULL,
  response_received_at DATETIME(3) NULL,
  unknown_at DATETIME(3) NULL,
  settled_at DATETIME(3) NULL,
  cancelled_late_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL,
  version_no BIGINT NOT NULL,
  UNIQUE KEY uk_provider_request_ledger_id(team_id, id),
  UNIQUE KEY uk_provider_request_ledger_key(
    team_id, owner_id, connection_id, endpoint_code, idempotency_key
  ),
  UNIQUE KEY uk_provider_request_ledger_logical(
    team_id, run_id, shard_id, checkpoint_no, logical_request_no
  ),
  UNIQUE KEY uk_provider_request_ledger_external(
    team_id, provider_code, connection_id, endpoint_code, external_request_id
  ),
  CONSTRAINT fk_provider_request_ledger_shard
    FOREIGN KEY (team_id, run_id, shard_id)
    REFERENCES prospect_run_shards(team_id, run_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_provider_request_ledger_job
    FOREIGN KEY (team_id, owner_id, job_id)
    REFERENCES agent_jobs(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_provider_request_ledger_origin_attempt
    FOREIGN KEY (team_id, origin_attempt_id)
    REFERENCES prospect_execution_attempts(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_provider_request_ledger_prepare_lease
    FOREIGN KEY (team_id, lease_id_at_prepare)
    REFERENCES prospect_execution_leases(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_provider_request_ledger_status
    CHECK (status IN (
      'prepared','dispatch_started','dispatch_confirmed',
      'response_received','outcome_unknown','settled','cancelled_late'
    )),
  CONSTRAINT chk_provider_request_ledger_numbers
    CHECK (
      checkpoint_no >= 1
      AND logical_request_no >= 1
      AND kernel_epoch_at_prepare >= 1
      AND run_epoch_at_prepare >= 1
      AND fence_token_at_prepare >= 1
      AND version_no >= 1
      AND (http_status IS NULL OR http_status BETWEEN 100 AND 599)
    )
);

CREATE TABLE prospect_provider_request_dispatches (
  id VARCHAR(90) PRIMARY KEY,
  ledger_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  shard_id VARCHAR(90) NOT NULL,
  attempt_id VARCHAR(90) NOT NULL,
  dispatch_no INT NOT NULL,
  operation VARCHAR(50) NOT NULL,
  status VARCHAR(30) NOT NULL,
  idempotency_key CHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  replayed BOOLEAN NOT NULL DEFAULT FALSE,
  provider_executed BOOLEAN NOT NULL DEFAULT FALSE,
  external_request_id VARCHAR(200) DEFAULT '',
  response_hash CHAR(64) DEFAULT '',
  error_code VARCHAR(100) DEFAULT '',
  started_at DATETIME(3) NOT NULL,
  confirmed_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  version_no BIGINT NOT NULL,
  UNIQUE KEY uk_provider_request_dispatch_id(team_id, id),
  UNIQUE KEY uk_provider_request_dispatch_no(
    team_id, ledger_id, dispatch_no
  ),
  CONSTRAINT fk_provider_request_dispatch_ledger
    FOREIGN KEY (team_id, ledger_id)
    REFERENCES prospect_provider_request_ledgers(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_provider_request_dispatch_attempt
    FOREIGN KEY (team_id, attempt_id)
    REFERENCES prospect_execution_attempts(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_provider_request_dispatch_operation
    CHECK (operation IN (
      'dispatch','query_by_idempotency_key','query_by_external_request_id'
    )),
  CONSTRAINT chk_provider_request_dispatch_status
    CHECK (status IN (
      'started','confirmed','response_received','outcome_unknown','rejected'
    )),
  CONSTRAINT chk_provider_request_dispatch_numbers
    CHECK (dispatch_no >= 1 AND version_no >= 1)
);

CREATE TABLE prospect_provider_request_attempt_bindings (
  id VARCHAR(90) PRIMARY KEY,
  ledger_id VARCHAR(90) NOT NULL,
  attempt_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  binding_no INT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_provider_request_binding_ledger_attempt(
    team_id, ledger_id, attempt_id
  ),
  UNIQUE KEY uk_provider_request_binding_no(
    team_id, ledger_id, binding_no
  ),
  CONSTRAINT fk_provider_request_binding_ledger
    FOREIGN KEY (team_id, ledger_id)
    REFERENCES prospect_provider_request_ledgers(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_provider_request_binding_attempt
    FOREIGN KEY (team_id, attempt_id)
    REFERENCES prospect_execution_attempts(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_provider_request_binding_no
    CHECK (binding_no >= 1)
);

CREATE TABLE prospect_provider_request_events (
  id VARCHAR(90) PRIMARY KEY,
  ledger_id VARCHAR(90) NOT NULL,
  dispatch_id VARCHAR(90) NULL,
  attempt_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  sequence_no INT NOT NULL,
  event_type VARCHAR(30) NOT NULL,
  from_status VARCHAR(30) DEFAULT '',
  to_status VARCHAR(30) NOT NULL,
  detail_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_provider_request_event_sequence(
    team_id, ledger_id, sequence_no
  ),
  CONSTRAINT fk_provider_request_event_ledger
    FOREIGN KEY (team_id, ledger_id)
    REFERENCES prospect_provider_request_ledgers(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_provider_request_event_dispatch
    FOREIGN KEY (team_id, dispatch_id)
    REFERENCES prospect_provider_request_dispatches(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_provider_request_event_attempt
    FOREIGN KEY (team_id, attempt_id)
    REFERENCES prospect_execution_attempts(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_provider_request_event_status
    CHECK (
      event_type IN (
        'prepared','dispatch_started','dispatch_confirmed',
        'response_received','outcome_unknown','settled','cancelled_late'
      )
      AND to_status = event_type
      AND sequence_no >= 1
    )
);

CREATE TABLE prospect_provider_request_accounting_evidence (
  id VARCHAR(90) PRIMARY KEY,
  ledger_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  sequence_no INT NOT NULL,
  provenance VARCHAR(30) NOT NULL,
  usage_json JSON NULL,
  cost_amount DECIMAL(18,6) NULL,
  currency VARCHAR(3) DEFAULT '',
  evidence_ref VARCHAR(500) DEFAULT '',
  evidence_hash CHAR(64) NOT NULL,
  estimation_method_version VARCHAR(100) DEFAULT '',
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_provider_request_accounting_sequence(
    team_id, ledger_id, sequence_no
  ),
  CONSTRAINT fk_provider_request_accounting_ledger
    FOREIGN KEY (team_id, ledger_id)
    REFERENCES prospect_provider_request_ledgers(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_provider_request_accounting_provenance
    CHECK (provenance IN (
      'unknown','estimated','provider_reported',
      'portal_export','invoice_confirmed'
    )),
  CONSTRAINT chk_provider_request_accounting_values
    CHECK (
      sequence_no >= 1
      AND (cost_amount IS NULL OR cost_amount >= 0)
    )
);

CREATE TABLE prospect_execution_pages (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  shard_id VARCHAR(90) NOT NULL,
  job_id VARCHAR(80) NOT NULL,
  attempt_id VARCHAR(90) NOT NULL,
  provider_code VARCHAR(80) NOT NULL,
  checkpoint_no INT NOT NULL,
  page_sequence INT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  accepted_count INT NOT NULL,
  raw_count INT NOT NULL,
  invalid_count INT NOT NULL,
  duplicate_count INT NOT NULL,
  partial BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_prospect_execution_page_sequence(
    team_id, run_id, shard_id, page_sequence
  ),
  UNIQUE KEY uk_prospect_execution_page_id(team_id, id),
  CONSTRAINT fk_prospect_execution_page_attempt
    FOREIGN KEY (team_id, attempt_id)
    REFERENCES prospect_execution_attempts(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_execution_page_shard
    FOREIGN KEY (team_id, run_id, shard_id)
    REFERENCES prospect_run_shards(team_id, run_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_execution_page_counts
    CHECK (
      checkpoint_no >= 1
      AND page_sequence >= 1
      AND accepted_count >= 0
      AND raw_count >= 0
      AND invalid_count >= 0
      AND duplicate_count >= 0
  )
);

CREATE TABLE prospect_strategy_source_positions (
  id VARCHAR(90) PRIMARY KEY,
  identity_hash CHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  campaign_id VARCHAR(80) NOT NULL,
  campaign_version INT NOT NULL,
  strategy_id VARCHAR(80) NOT NULL,
  provider_code VARCHAR(80) NOT NULL,
  query_fingerprint CHAR(64) NOT NULL,
  connection_id VARCHAR(100) NOT NULL,
  endpoint_code VARCHAR(100) NOT NULL,
  adapter_version VARCHAR(100) NOT NULL,
  contract_version VARCHAR(100) NOT NULL,
  catalog_version VARCHAR(100) NOT NULL,
  time_window_mode VARCHAR(10) NOT NULL,
  time_window_from VARCHAR(10) NOT NULL DEFAULT '',
  time_window_to VARCHAR(10) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL,
  encrypted_cursor MEDIUMTEXT NOT NULL,
  cursor_hash CHAR(64) NOT NULL DEFAULT '',
  source_run_id VARCHAR(80) NOT NULL,
  source_shard_id VARCHAR(90) NOT NULL,
  source_page_id VARCHAR(90) NOT NULL,
  source_checkpoint_no INT NOT NULL,
  source_page_sequence INT NOT NULL,
  version_no BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_prospect_strategy_source_position_scope(
    team_id, owner_id, identity_hash
  ),
  UNIQUE KEY uk_prospect_strategy_source_position_id(team_id, id),
  INDEX idx_prospect_strategy_source_position_strategy(
    team_id, owner_id, campaign_id, strategy_id, provider_code
  ),
  CONSTRAINT fk_prospect_strategy_source_position_run
    FOREIGN KEY (team_id, source_run_id)
    REFERENCES prospect_search_runs(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_strategy_source_position_shard
    FOREIGN KEY (team_id, source_run_id, source_shard_id)
    REFERENCES prospect_run_shards(team_id, run_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_prospect_strategy_source_position_page
    FOREIGN KEY (team_id, source_page_id)
    REFERENCES prospect_execution_pages(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_strategy_source_position_status
    CHECK (status IN ('continuable','exhausted')),
  CONSTRAINT chk_prospect_strategy_source_position_cursor
    CHECK (
      (status = 'continuable'
        AND encrypted_cursor <> ''
        AND cursor_hash <> '')
      OR
      (status = 'exhausted'
        AND encrypted_cursor = ''
        AND cursor_hash = '')
    ),
  CONSTRAINT chk_prospect_strategy_source_position_values
    CHECK (
      campaign_version >= 1
      AND source_checkpoint_no >= 1
      AND source_page_sequence >= 1
      AND version_no >= 1
      AND time_window_mode IN ('all','fixed')
    )
);

CREATE TABLE prospect_source_raw_records (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  provider_code VARCHAR(80) NOT NULL,
  connection_id VARCHAR(100) NOT NULL,
  endpoint_code VARCHAR(100) NOT NULL,
  source_identity_hash CHAR(64) NOT NULL,
  artifact_hash CHAR(64) NOT NULL,
  envelope_version VARCHAR(40) NOT NULL,
  encrypted_envelope MEDIUMTEXT NOT NULL,
  envelope_hash CHAR(64) NOT NULL,
  first_observed_at DATETIME(3) NOT NULL,
  record_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_ps_raw_record_team_id(team_id, id),
  UNIQUE KEY uk_ps_raw_record_team_owner_id(team_id, owner_id, id),
  UNIQUE KEY uk_ps_raw_record_version(
    team_id, owner_id, provider_code, connection_id, endpoint_code,
    source_identity_hash, artifact_hash
  ),
  CONSTRAINT chk_ps_raw_record_envelope_version
    CHECK (envelope_version = 'provider-raw-v1')
) ENGINE=InnoDB;

CREATE TABLE prospect_source_raw_batches (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  shard_id VARCHAR(90) NOT NULL,
  job_id VARCHAR(80) NOT NULL,
  attempt_id VARCHAR(90) NOT NULL,
  ledger_id VARCHAR(90) NOT NULL,
  page_id VARCHAR(90) NOT NULL,
  provider_code VARCHAR(80) NOT NULL,
  connection_id VARCHAR(100) NOT NULL,
  endpoint_code VARCHAR(100) NOT NULL,
  adapter_version VARCHAR(100) NOT NULL,
  response_schema_version VARCHAR(100) NOT NULL,
  response_hash CHAR(64) NOT NULL,
  settlement_hash CHAR(64) NOT NULL,
  raw_artifact_hash CHAR(64) NOT NULL,
  record_count INT NOT NULL,
  license_policy VARCHAR(200) NOT NULL,
  retention_policy VARCHAR(200) NOT NULL,
  retention_days INT NOT NULL,
  retention_until DATETIME(3) NOT NULL,
  batch_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_ps_raw_batch_team_id(team_id, id),
  UNIQUE KEY uk_ps_raw_batch_team_owner_id(team_id, owner_id, id),
  UNIQUE KEY uk_ps_raw_batch_ledger(team_id, ledger_id),
  UNIQUE KEY uk_ps_raw_batch_page(team_id, page_id),
  CONSTRAINT fk_ps_raw_batch_run
    FOREIGN KEY (team_id, run_id)
    REFERENCES prospect_search_runs(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ps_raw_batch_shard
    FOREIGN KEY (team_id, run_id, shard_id)
    REFERENCES prospect_run_shards(team_id, run_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ps_raw_batch_job
    FOREIGN KEY (team_id, owner_id, job_id)
    REFERENCES agent_jobs(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ps_raw_batch_attempt
    FOREIGN KEY (team_id, attempt_id)
    REFERENCES prospect_execution_attempts(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ps_raw_batch_ledger
    FOREIGN KEY (team_id, ledger_id)
    REFERENCES prospect_provider_request_ledgers(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ps_raw_batch_page
    FOREIGN KEY (team_id, page_id)
    REFERENCES prospect_execution_pages(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_ps_raw_batch_schema
    CHECK (
      response_schema_version = 'fake-provider-source-records-v1'
    ),
  CONSTRAINT chk_ps_raw_batch_retention
    CHECK (
      record_count >= 0
      AND retention_days BETWEEN 1 AND 3650
      AND retention_until >= created_at
    )
);

CREATE TABLE prospect_source_raw_hits (
  id VARCHAR(90) PRIMARY KEY,
  batch_id VARCHAR(90) NOT NULL,
  record_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  shard_id VARCHAR(90) NOT NULL,
  job_id VARCHAR(80) NOT NULL,
  attempt_id VARCHAR(90) NOT NULL,
  ledger_id VARCHAR(90) NOT NULL,
  page_id VARCHAR(90) NOT NULL,
  ordinal INT NOT NULL,
  fetched_at DATETIME(3) NOT NULL,
  hit_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_ps_raw_hit_team_id(team_id, id),
  UNIQUE KEY uk_ps_raw_hit_team_owner_id(team_id, owner_id, id),
  UNIQUE KEY uk_ps_raw_hit_ordinal(team_id, batch_id, ordinal),
  INDEX idx_ps_raw_hit_record(team_id, owner_id, record_id),
  CONSTRAINT fk_ps_raw_hit_batch
    FOREIGN KEY (team_id, owner_id, batch_id)
    REFERENCES prospect_source_raw_batches(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_ps_raw_hit_record
    FOREIGN KEY (team_id, owner_id, record_id)
    REFERENCES prospect_source_raw_records(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_ps_raw_hit_ordinal CHECK (ordinal >= 1)
);

CREATE TABLE prospect_execution_events (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  run_id VARCHAR(80) NOT NULL,
  shard_id VARCHAR(90) DEFAULT '',
  job_id VARCHAR(80) DEFAULT '',
  event_type VARCHAR(40) NOT NULL,
  kernel_epoch BIGINT NOT NULL,
  run_epoch BIGINT NOT NULL,
  fence_token BIGINT NOT NULL,
  detail_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_prospect_execution_event_run(
    team_id, run_id, created_at, id
  ),
  CONSTRAINT fk_prospect_execution_event_run
    FOREIGN KEY (team_id, run_id)
    REFERENCES prospect_search_runs(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_prospect_execution_event_numbers
    CHECK (
      kernel_epoch >= 1
      AND run_epoch >= 1
      AND fence_token >= 0
    )
);

CREATE TABLE prospect_execution_throttles (
  id CHAR(64) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  provider_code VARCHAR(80) NOT NULL,
  connection_id VARCHAR(100) NOT NULL,
  available_at DATETIME(3) NOT NULL,
  version_no BIGINT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_prospect_execution_throttle_scope(
    team_id, provider_code, connection_id
  ),
  CONSTRAINT chk_prospect_execution_throttle_version
    CHECK (version_no >= 1)
);

CREATE TABLE organization_identity_contract_metadata (
  id TINYINT PRIMARY KEY,
  resolver_contract_version VARCHAR(80) NOT NULL,
  persistence_schema_version VARCHAR(80) NOT NULL,
  canonical_version VARCHAR(40) NOT NULL,
  hash_algorithm VARCHAR(40) NOT NULL,
  encryption_algorithm VARCHAR(80) NOT NULL,
  envelope_version VARCHAR(80) NOT NULL,
  hkdf_version VARCHAR(80) NOT NULL,
  deterministic_id_version VARCHAR(80) NOT NULL,
  key_fingerprints_json TEXT NOT NULL,
  raw_key_fingerprint CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  metadata_mac CHAR(64) NOT NULL,
  CONSTRAINT chk_oi_metadata_singleton CHECK (id = 1),
  CONSTRAINT chk_oi_metadata_status CHECK (status = 'active')
) ENGINE=InnoDB;

CREATE TABLE organization_identity_team_guards (
  team_id VARCHAR(64) PRIMARY KEY,
  guard_version BIGINT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT chk_oi_team_guard_version CHECK (guard_version >= 1)
) ENGINE=InnoDB;

CREATE TABLE organization_identity_authority_profiles (
  profile_code VARCHAR(120) NOT NULL,
  profile_version VARCHAR(80) NOT NULL,
  canonical_json MEDIUMTEXT NOT NULL,
  profile_hash CHAR(64) NOT NULL,
  profile_mac CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  PRIMARY KEY (profile_code, profile_version)
) ENGINE=InnoDB;

CREATE TABLE organizations (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  scope_type VARCHAR(20) NOT NULL,
  scope_id VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  legal_name_encrypted MEDIUMTEXT NOT NULL,
  normalized_name_encrypted MEDIUMTEXT NOT NULL,
  organization_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  UNIQUE KEY uk_oi_organization_team_id(team_id, id),
  CONSTRAINT chk_oi_organization_scope
    CHECK (scope_type = 'team' AND scope_id = team_id),
  CONSTRAINT chk_oi_organization_status CHECK (status = 'active')
) ENGINE=InnoDB;

CREATE TABLE organization_identity_resolutions (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  raw_record_id VARCHAR(90) NOT NULL,
  raw_artifact_hash CHAR(64) NOT NULL,
  processing_key_hash CHAR(64) NOT NULL,
  claim_hash CHAR(64) NOT NULL,
  resolver_contract_version VARCHAR(80) NOT NULL,
  parser_version VARCHAR(200) NOT NULL,
  normalizer_version VARCHAR(200) NOT NULL,
  authority_profile_code VARCHAR(120) NOT NULL,
  authority_profile_version VARCHAR(80) NOT NULL,
  authority_profile_hash CHAR(64) NOT NULL,
  result VARCHAR(40) NOT NULL,
  decision_reason_code VARCHAR(120) NOT NULL,
  organization_id VARCHAR(90) NOT NULL,
  binding_id VARCHAR(90) NOT NULL,
  conflict_id VARCHAR(90) NOT NULL,
  relation_hash CHAR(64) NOT NULL,
  event_count INT NOT NULL,
  event_tail_hash CHAR(64) NOT NULL,
  resolution_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  UNIQUE KEY uk_oi_resolution_team_owner_id(team_id, owner_id, id),
  UNIQUE KEY uk_oi_resolution_processing(
    team_id, owner_id, processing_key_hash
  ),
  CONSTRAINT fk_oi_resolution_raw
    FOREIGN KEY (team_id, owner_id, raw_record_id)
    REFERENCES prospect_source_raw_records(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_oi_resolution_result CHECK (
    result IN ('new_entity','exact_match','insufficient_identity','conflict')
  ),
  CONSTRAINT chk_oi_resolution_events CHECK (event_count >= 1)
) ENGINE=InnoDB;

CREATE TABLE organization_identity_claims (
  id VARCHAR(90) PRIMARY KEY,
  resolution_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  raw_record_id VARCHAR(90) NOT NULL,
  ordinal INT NOT NULL,
  kind VARCHAR(40) NOT NULL,
  original_value_encrypted MEDIUMTEXT NOT NULL,
  normalized_value_encrypted MEDIUMTEXT NOT NULL,
  scheme VARCHAR(200) NOT NULL,
  jurisdiction VARCHAR(40) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,
  subject_ref_encrypted MEDIUMTEXT NOT NULL,
  classification VARCHAR(60) NOT NULL,
  normalizer_version VARCHAR(200) NOT NULL,
  validator_version VARCHAR(200) NOT NULL,
  authority_profile_code VARCHAR(120) NOT NULL,
  observed_at DATETIME(3) NOT NULL,
  claim_hash CHAR(64) NOT NULL,
  claim_fact_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  UNIQUE KEY uk_oi_claim_team_owner_id(team_id, owner_id, id),
  UNIQUE KEY uk_oi_claim_resolution_ordinal(
    team_id, owner_id, resolution_id, ordinal
  ),
  CONSTRAINT fk_oi_claim_resolution
    FOREIGN KEY (team_id, owner_id, resolution_id)
    REFERENCES organization_identity_resolutions(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_oi_claim_raw
    FOREIGN KEY (team_id, owner_id, raw_record_id)
    REFERENCES prospect_source_raw_records(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_oi_claim_ordinal CHECK (ordinal >= 1)
) ENGINE=InnoDB;

CREATE TABLE organization_accepted_identifiers (
  id VARCHAR(90) PRIMARY KEY,
  organization_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  kind VARCHAR(40) NOT NULL,
  scheme VARCHAR(200) NOT NULL,
  jurisdiction VARCHAR(40) NOT NULL,
  normalized_value_encrypted MEDIUMTEXT NOT NULL,
  normalized_value_hash CHAR(64) NOT NULL,
  source_claim_id VARCHAR(90) NOT NULL,
  source_raw_record_id VARCHAR(90) NOT NULL,
  source_owner_id VARCHAR(64) NOT NULL,
  authority_profile_code VARCHAR(120) NOT NULL,
  authority_profile_version VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL,
  identifier_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  UNIQUE KEY uk_oi_identifier_team_id(team_id, id),
  UNIQUE KEY uk_oi_identifier_lookup(
    team_id, kind, scheme, jurisdiction, normalized_value_hash
  ),
  CONSTRAINT fk_oi_identifier_organization
    FOREIGN KEY (team_id, organization_id)
    REFERENCES organizations(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_oi_identifier_claim
    FOREIGN KEY (team_id, source_owner_id, source_claim_id)
    REFERENCES organization_identity_claims(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_oi_identifier_raw
    FOREIGN KEY (team_id, source_owner_id, source_raw_record_id)
    REFERENCES prospect_source_raw_records(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_oi_identifier_status CHECK (status = 'active')
) ENGINE=InnoDB;

CREATE TABLE organization_source_bindings (
  id VARCHAR(90) PRIMARY KEY,
  organization_id VARCHAR(90) NOT NULL,
  resolution_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  raw_record_id VARCHAR(90) NOT NULL,
  status VARCHAR(20) NOT NULL,
  binding_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  UNIQUE KEY uk_oi_binding_team_owner_id(team_id, owner_id, id),
  UNIQUE KEY uk_oi_binding_active_raw(
    team_id, owner_id, raw_record_id, status
  ),
  CONSTRAINT fk_oi_binding_organization
    FOREIGN KEY (team_id, organization_id)
    REFERENCES organizations(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_oi_binding_resolution
    FOREIGN KEY (team_id, owner_id, resolution_id)
    REFERENCES organization_identity_resolutions(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_oi_binding_raw
    FOREIGN KEY (team_id, owner_id, raw_record_id)
    REFERENCES prospect_source_raw_records(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_oi_binding_status CHECK (status = 'active')
) ENGINE=InnoDB;

CREATE TABLE organization_identity_conflicts (
  id VARCHAR(90) PRIMARY KEY,
  resolution_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  raw_record_id VARCHAR(90) NOT NULL,
  conflict_type VARCHAR(60) NOT NULL,
  status VARCHAR(20) NOT NULL,
  relation_hash CHAR(64) NOT NULL,
  conflict_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  UNIQUE KEY uk_oi_conflict_team_owner_id(team_id, owner_id, id),
  UNIQUE KEY uk_oi_conflict_resolution(
    team_id, owner_id, resolution_id
  ),
  CONSTRAINT fk_oi_conflict_resolution
    FOREIGN KEY (team_id, owner_id, resolution_id)
    REFERENCES organization_identity_resolutions(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_oi_conflict_raw
    FOREIGN KEY (team_id, owner_id, raw_record_id)
    REFERENCES prospect_source_raw_records(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_oi_conflict_status CHECK (status = 'open')
) ENGINE=InnoDB;

CREATE TABLE organization_identity_events (
  id VARCHAR(90) PRIMARY KEY,
  resolution_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  sequence_no INT NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  organization_id VARCHAR(90) NOT NULL,
  detail_hash CHAR(64) NOT NULL,
  previous_event_hash CHAR(64) NOT NULL,
  event_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  UNIQUE KEY uk_oi_event_team_owner_id(team_id, owner_id, id),
  UNIQUE KEY uk_oi_event_resolution_sequence(
    team_id, owner_id, resolution_id, sequence_no
  ),
  CONSTRAINT fk_oi_event_resolution
    FOREIGN KEY (team_id, owner_id, resolution_id)
    REFERENCES organization_identity_resolutions(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_oi_event_sequence CHECK (sequence_no >= 1)
) ENGINE=InnoDB;

CREATE TABLE organization_identity_resolution_identifiers (
  resolution_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  ordinal INT NOT NULL,
  identifier_id VARCHAR(90) NOT NULL,
  relation_role VARCHAR(40) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  PRIMARY KEY (team_id, owner_id, resolution_id, ordinal),
  UNIQUE KEY uk_oi_resolution_identifier_role(
    team_id, owner_id, resolution_id, identifier_id, relation_role
  ),
  CONSTRAINT fk_oi_resolution_identifier_resolution
    FOREIGN KEY (team_id, owner_id, resolution_id)
    REFERENCES organization_identity_resolutions(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_oi_resolution_identifier_identifier
    FOREIGN KEY (team_id, identifier_id)
    REFERENCES organization_accepted_identifiers(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_oi_resolution_identifier_ordinal CHECK (ordinal >= 1),
  CONSTRAINT chk_oi_resolution_identifier_role CHECK (
    relation_role IN (
      'matched_existing','accepted_existing','accepted_new'
    )
  )
) ENGINE=InnoDB;

CREATE TABLE organization_identity_resolution_bindings (
  resolution_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  ordinal INT NOT NULL,
  binding_id VARCHAR(90) NOT NULL,
  relation_role VARCHAR(40) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  PRIMARY KEY (team_id, owner_id, resolution_id, ordinal),
  UNIQUE KEY uk_oi_resolution_binding_role(
    team_id, owner_id, resolution_id, binding_id, relation_role
  ),
  CONSTRAINT fk_oi_resolution_binding_resolution
    FOREIGN KEY (team_id, owner_id, resolution_id)
    REFERENCES organization_identity_resolutions(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_oi_resolution_binding_binding
    FOREIGN KEY (team_id, owner_id, binding_id)
    REFERENCES organization_source_bindings(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_oi_resolution_binding_ordinal CHECK (ordinal >= 1),
  CONSTRAINT chk_oi_resolution_binding_role CHECK (
    relation_role IN ('reused_existing','created_new')
  )
) ENGINE=InnoDB;

CREATE TABLE organization_identity_conflict_organizations (
  conflict_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  ordinal INT NOT NULL,
  organization_id VARCHAR(90) NOT NULL,
  relation_role VARCHAR(40) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  PRIMARY KEY (team_id, owner_id, conflict_id, ordinal),
  CONSTRAINT fk_oi_conflict_organization_conflict
    FOREIGN KEY (team_id, owner_id, conflict_id)
    REFERENCES organization_identity_conflicts(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_oi_conflict_organization_organization
    FOREIGN KEY (team_id, organization_id)
    REFERENCES organizations(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_oi_conflict_organization_ordinal CHECK (ordinal >= 1),
  CONSTRAINT chk_oi_conflict_organization_role CHECK (
    relation_role IN ('identifier_match','existing_binding')
  )
) ENGINE=InnoDB;

CREATE TABLE organization_identity_conflict_keys (
  conflict_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  ordinal INT NOT NULL,
  key_type VARCHAR(40) NOT NULL,
  identifier_key_encrypted MEDIUMTEXT NOT NULL,
  identifier_key_hash CHAR(64) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  PRIMARY KEY (team_id, owner_id, conflict_id, ordinal),
  CONSTRAINT fk_oi_conflict_key_conflict
    FOREIGN KEY (team_id, owner_id, conflict_id)
    REFERENCES organization_identity_conflicts(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_oi_conflict_key_ordinal CHECK (ordinal >= 1),
  CONSTRAINT chk_oi_conflict_key_type CHECK (
    key_type IN ('identifier_exact','identifier_slot','raw_binding')
  )
) ENGINE=InnoDB;

CREATE TABLE prospect_coverage_contract_metadata (
  id TINYINT PRIMARY KEY,
  contract_version VARCHAR(80) NOT NULL,
  persistence_schema_version VARCHAR(80) NOT NULL,
  canonical_version VARCHAR(40) NOT NULL,
  hash_algorithm VARCHAR(40) NOT NULL,
  hkdf_version VARCHAR(40) NOT NULL,
  key_fingerprint CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  metadata_mac CHAR(64) NOT NULL,
  CONSTRAINT chk_pc_metadata_singleton CHECK (id = 1),
  CONSTRAINT chk_pc_metadata_status CHECK (status = 'active')
) ENGINE=InnoDB;

CREATE TABLE prospect_coverage_team_guards (
  team_id VARCHAR(64) PRIMARY KEY,
  guard_version BIGINT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT chk_pc_guard_version CHECK (guard_version >= 1)
) ENGINE=InnoDB;

CREATE TABLE tenant_prospects (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  organization_id VARCHAR(90) NOT NULL,
  lifecycle_status VARCHAR(30) NOT NULL,
  last_classification VARCHAR(40) NOT NULL,
  queue_state VARCHAR(30) NOT NULL,
  queue_reason_code VARCHAR(200) NOT NULL,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  last_material_change_at DATETIME(3) NOT NULL,
  last_queued_at DATETIME(3) NULL,
  last_reviewed_at DATETIME(3) NULL,
  next_review_at DATETIME(3) NULL,
  hit_count BIGINT NOT NULL,
  source_count BIGINT NOT NULL,
  evidence_count BIGINT NOT NULL,
  source_key_hashes_json MEDIUMTEXT NOT NULL,
  material_evidence_key_hashes_json MEDIUMTEXT NOT NULL,
  exclusion_scope VARCHAR(30) NOT NULL,
  exclusion_mode VARCHAR(30) NOT NULL,
  exclusion_reason_code VARCHAR(200) NOT NULL,
  excluded_until DATETIME(3) NULL,
  lead_id VARCHAR(64) NOT NULL,
  customer_id VARCHAR(64) NOT NULL,
  deal_id VARCHAR(64) NOT NULL,
  version_no BIGINT NOT NULL,
  event_count BIGINT NOT NULL,
  event_tail_hash CHAR(64) NOT NULL,
  prospect_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  UNIQUE KEY uk_pc_prospect_team_id(team_id, id),
  UNIQUE KEY uk_pc_prospect_team_organization(team_id, organization_id),
  CONSTRAINT fk_pc_prospect_organization
    FOREIGN KEY (team_id, organization_id)
    REFERENCES organizations(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_pc_prospect_status CHECK (
    lifecycle_status IN ('active','excluded','do_not_contact','converted')
  ),
  CONSTRAINT chk_pc_prospect_classification CHECK (
    last_classification IN (
      'net_new','new_intelligence','due_review','duplicate','excluded'
    )
  ),
  CONSTRAINT chk_pc_prospect_queue CHECK (
    queue_state IN ('none','pending','suppressed','converted')
  ),
  CONSTRAINT chk_pc_prospect_exclusion_scope CHECK (
    exclusion_scope IN ('none','organization','team')
  ),
  CONSTRAINT chk_pc_prospect_exclusion_mode CHECK (
    exclusion_mode IN ('none','temporary','permanent')
  ),
  CONSTRAINT chk_pc_prospect_counts CHECK (
    hit_count >= 1 AND source_count >= 1 AND evidence_count >= 0
    AND version_no >= 1 AND event_count >= 1
  )
) ENGINE=InnoDB;

CREATE TABLE prospect_coverage_events (
  id VARCHAR(90) PRIMARY KEY,
  prospect_id VARCHAR(90) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  organization_id VARCHAR(90) NOT NULL,
  resolution_id VARCHAR(90) NULL,
  raw_record_id VARCHAR(90) NULL,
  source_hit_id VARCHAR(90) NULL,
  campaign_id VARCHAR(80) NULL,
  strategy_id VARCHAR(80) NULL,
  run_id VARCHAR(80) NULL,
  shard_id VARCHAR(90) NULL,
  sequence_no BIGINT NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  disposition_action VARCHAR(40) NOT NULL,
  classification VARCHAR(40) NOT NULL,
  queue_action VARCHAR(30) NOT NULL,
  reason_code VARCHAR(200) NOT NULL,
  processing_key_hash CHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  new_evidence_key_hashes_json MEDIUMTEXT NOT NULL,
  new_source_key_hashes_json MEDIUMTEXT NOT NULL,
  evidence_snapshot_hash CHAR(64) NOT NULL,
  source_snapshot_hash CHAR(64) NOT NULL,
  previous_event_hash CHAR(64) NOT NULL,
  event_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  UNIQUE KEY uk_pc_event_team_id(team_id, id),
  UNIQUE KEY uk_pc_event_processing(team_id, processing_key_hash),
  UNIQUE KEY uk_pc_event_prospect_sequence(
    team_id, prospect_id, sequence_no
  ),
  CONSTRAINT fk_pc_event_prospect
    FOREIGN KEY (team_id, prospect_id)
    REFERENCES tenant_prospects(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pc_event_organization
    FOREIGN KEY (team_id, organization_id)
    REFERENCES organizations(team_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pc_event_resolution
    FOREIGN KEY (team_id, owner_id, resolution_id)
    REFERENCES organization_identity_resolutions(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pc_event_raw
    FOREIGN KEY (team_id, owner_id, raw_record_id)
    REFERENCES prospect_source_raw_records(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT fk_pc_event_hit
    FOREIGN KEY (team_id, owner_id, source_hit_id)
    REFERENCES prospect_source_raw_hits(team_id, owner_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT chk_pc_event_sequence CHECK (sequence_no >= 1),
  CONSTRAINT chk_pc_event_type CHECK (
    event_type IN ('coverage_classified','disposition_changed')
  ),
  CONSTRAINT chk_pc_event_queue_action CHECK (
    queue_action IN ('enqueue','suppress','none')
  )
) ENGINE=InnoDB;

CREATE TABLE prospect_qualification_contract_metadata (
  id TINYINT PRIMARY KEY,
  contract_version VARCHAR(80) NOT NULL,
  persistence_schema_version VARCHAR(80) NOT NULL,
  key_fingerprint CHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  metadata_mac CHAR(64) NOT NULL,
  CONSTRAINT chk_pq_metadata_singleton CHECK (id = 1),
  CONSTRAINT chk_pq_metadata_status CHECK (status = 'active')
) ENGINE=InnoDB;

CREATE TABLE prospect_qualification_team_guards (
  team_id VARCHAR(64) PRIMARY KEY,
  guard_version BIGINT NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT chk_pq_guard_version CHECK (guard_version >= 1)
) ENGINE=InnoDB;

CREATE TABLE prospect_qualification_facts (
  id VARCHAR(90) PRIMARY KEY,
  team_id VARCHAR(64) NOT NULL,
  owner_id VARCHAR(64) NOT NULL,
  prospect_id VARCHAR(90) NOT NULL,
  organization_id VARCHAR(90) NOT NULL,
  record_type VARCHAR(60) NOT NULL,
  visibility_scope VARCHAR(20) NOT NULL,
  idempotency_key_hash CHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  record_hash CHAR(64) NOT NULL,
  encrypted_payload LONGTEXT NOT NULL,
  payload_hash CHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  row_mac CHAR(64) NOT NULL,
  UNIQUE KEY uk_pq_fact_team_id(team_id, id),
  UNIQUE KEY uk_pq_fact_idempotency(
    team_id, owner_id, record_type, idempotency_key_hash
  ),
  INDEX idx_pq_fact_owner_prospect(
    team_id, owner_id, prospect_id, record_type, created_at
  ),
  INDEX idx_pq_fact_organization(
    team_id, organization_id, record_type, created_at
  ),
  CONSTRAINT chk_pq_fact_visibility CHECK (
    visibility_scope IN ('team','owner')
  )
) ENGINE=InnoDB;

-- IAM foundation. Runtime migration also creates and seeds these tables from
-- legacy users.team_id/users.role without changing business table ownership.
CREATE TABLE IF NOT EXISTS tenants (
  id VARCHAR(64) PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  plan_code VARCHAR(40) NOT NULL DEFAULT 'beta',
  seat_limit INT NOT NULL DEFAULT 50,
  trial_expires_at DATETIME(3) NULL,
  data_region VARCHAR(40) NOT NULL DEFAULT '',
  timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Shanghai',
  locale VARCHAR(20) NOT NULL DEFAULT 'zh-CN',
  authz_revision BIGINT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT chk_tenants_status CHECK (status IN ('trial','active','suspended','closed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_memberships (
  id VARCHAR(90) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  employee_no VARCHAR(80) NOT NULL DEFAULT '',
  title VARCHAR(120) NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  primary_org_unit_id VARCHAR(90) NULL,
  membership_auth_version BIGINT NOT NULL DEFAULT 1,
  joined_at DATETIME(3) NULL,
  left_at DATETIME(3) NULL,
  invited_by VARCHAR(90) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_tenant_membership_user(tenant_id, user_id),
  UNIQUE KEY uk_tenant_membership_scope(tenant_id, id),
  INDEX idx_tenant_membership_status(tenant_id, status),
  CONSTRAINT fk_tenant_membership_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_tenant_membership_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT chk_tenant_membership_status CHECK (status IN ('invited','active','suspended','left'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organization_units (
  id VARCHAR(90) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  parent_id VARCHAR(90) NULL,
  name VARCHAR(160) NOT NULL,
  code VARCHAR(80) NOT NULL,
  unit_type VARCHAR(20) NOT NULL,
  path VARCHAR(900) NOT NULL,
  depth INT NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  version_no BIGINT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_organization_unit_code(tenant_id, code),
  UNIQUE KEY uk_organization_unit_scope(tenant_id, id),
  INDEX idx_organization_unit_path(tenant_id, path(255)),
  CONSTRAINT fk_organization_unit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT chk_organization_unit_depth CHECK (depth BETWEEN 0 AND 8),
  CONSTRAINT chk_organization_unit_status CHECK (status IN ('active','disabled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS organization_memberships (
  id VARCHAR(90) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  membership_id VARCHAR(90) NOT NULL,
  org_unit_id VARCHAR(90) NOT NULL,
  relation_type VARCHAR(20) NOT NULL,
  is_leader BOOLEAN NOT NULL DEFAULT FALSE,
  valid_from DATETIME(3) NULL,
  valid_until DATETIME(3) NULL,
  created_by VARCHAR(90) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_org_membership_relation(tenant_id, membership_id, org_unit_id, relation_type),
  INDEX idx_org_membership_unit(tenant_id, org_unit_id),
  CONSTRAINT fk_org_membership_member FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id),
  CONSTRAINT fk_org_membership_unit FOREIGN KEY (tenant_id, org_unit_id) REFERENCES organization_units(tenant_id, id),
  CONSTRAINT chk_org_membership_relation CHECK (relation_type IN ('primary','secondary'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  code VARCHAR(120) PRIMARY KEY,
  domain_name VARCHAR(20) NOT NULL DEFAULT 'tenant',
  module_name VARCHAR(80) NOT NULL,
  resource_name VARCHAR(80) NOT NULL,
  action_name VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  risk_level VARCHAR(20) NOT NULL,
  scope_modes_json JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  introduced_version VARCHAR(40) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT chk_permissions_risk CHECK (risk_level IN ('normal','sensitive','high','critical'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS roles (
  id VARCHAR(90) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  code VARCHAR(80) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  source VARCHAR(20) NOT NULL DEFAULT 'custom',
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  is_protected BOOLEAN NOT NULL DEFAULT FALSE,
  version_no BIGINT NOT NULL DEFAULT 1,
  created_by VARCHAR(90) NULL,
  updated_by VARCHAR(90) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_roles_code(tenant_id, code),
  UNIQUE KEY uk_roles_scope(tenant_id, id),
  CONSTRAINT fk_roles_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT chk_roles_status CHECK (status IN ('draft','active','disabled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permission_bindings (
  id VARCHAR(90) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  role_id VARCHAR(90) NOT NULL,
  permission_code VARCHAR(120) NOT NULL,
  scope_mode VARCHAR(20) NOT NULL,
  scope_config_json JSON NULL,
  field_policy_id VARCHAR(90) NULL,
  condition_policy_id VARCHAR(90) NULL,
  created_by VARCHAR(90) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_role_permission_binding(tenant_id, role_id, permission_code, scope_mode),
  INDEX idx_role_permission_permission(permission_code),
  CONSTRAINT fk_role_permission_role FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id),
  CONSTRAINT fk_role_permission_code FOREIGN KEY (permission_code) REFERENCES permissions(code),
  CONSTRAINT chk_role_permission_scope CHECK (scope_mode IN ('self','org_unit','org_subtree','tenant','public_pool','assigned_set'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS member_role_assignments (
  id VARCHAR(90) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  membership_id VARCHAR(90) NOT NULL,
  role_id VARCHAR(90) NOT NULL,
  scope_anchor_org_unit_id VARCHAR(90) NULL,
  valid_from DATETIME(3) NULL,
  valid_until DATETIME(3) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  reason VARCHAR(500) NOT NULL DEFAULT '',
  granted_by VARCHAR(90) NULL,
  revoked_by VARCHAR(90) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_member_role_active(tenant_id, membership_id, role_id),
  INDEX idx_member_role_status(tenant_id, membership_id, status),
  CONSTRAINT fk_member_role_member FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id),
  CONSTRAINT fk_member_role_role FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id),
  CONSTRAINT chk_member_role_status CHECK (status IN ('active','revoked','expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS member_permission_grants (
  id VARCHAR(90) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  membership_id VARCHAR(90) NOT NULL,
  permission_code VARCHAR(120) NOT NULL,
  scope_mode VARCHAR(20) NOT NULL,
  scope_config_json JSON NULL,
  valid_until DATETIME(3) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  ticket_no VARCHAR(120) NOT NULL DEFAULT '',
  granted_by VARCHAR(90) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  revoked_by VARCHAR(90) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_member_permission_active(tenant_id, membership_id, status, valid_until),
  CONSTRAINT fk_member_permission_member FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id),
  CONSTRAINT fk_member_permission_code FOREIGN KEY (permission_code) REFERENCES permissions(code),
  CONSTRAINT chk_member_permission_status CHECK (status IN ('active','revoked','expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS authorization_revisions (
  tenant_id VARCHAR(64) NOT NULL,
  membership_id VARCHAR(90) NOT NULL DEFAULT '',
  revision BIGINT NOT NULL DEFAULT 1,
  changed_at DATETIME(3) NOT NULL,
  PRIMARY KEY (tenant_id, membership_id),
  CONSTRAINT fk_authorization_revision_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS authorization_audit_events (
  id VARCHAR(90) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  actor_identity_id VARCHAR(64) NOT NULL,
  actor_membership_id VARCHAR(90) NULL,
  target_type VARCHAR(40) NOT NULL,
  target_id VARCHAR(120) NOT NULL,
  action_code VARCHAR(120) NOT NULL,
  before_summary_json JSON NULL,
  after_summary_json JSON NULL,
  impact_summary VARCHAR(500) NOT NULL DEFAULT '',
  reason VARCHAR(500) NOT NULL DEFAULT '',
  ticket_no VARCHAR(120) NOT NULL DEFAULT '',
  request_id VARCHAR(90) NOT NULL DEFAULT '',
  session_id_hash CHAR(64) NOT NULL DEFAULT '',
  ip_hash CHAR(64) NOT NULL DEFAULT '',
  result_status VARCHAR(20) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_authorization_audit_tenant(tenant_id, created_at, id),
  INDEX idx_authorization_audit_target(tenant_id, target_type, target_id),
  CONSTRAINT fk_authorization_audit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT chk_authorization_audit_status CHECK (result_status IN ('success','rejected','failed','rolled_back'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_operators (
  id VARCHAR(90) PRIMARY KEY,
  user_id VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  mfa_required BOOLEAN NOT NULL DEFAULT TRUE,
  auth_version BIGINT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_platform_operator_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT chk_platform_operator_status CHECK (status IN ('active','suspended','disabled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_operator_mfa (
  operator_id VARCHAR(90) PRIMARY KEY,
  secret_encrypted TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_step BIGINT NULL,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_platform_mfa_operator FOREIGN KEY (operator_id) REFERENCES platform_operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_mfa_challenges (
  id VARCHAR(120) PRIMARY KEY,
  operator_id VARCHAR(90) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used BOOLEAN NOT NULL DEFAULT FALSE,
  failed_attempts INT NOT NULL DEFAULT 0,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_platform_mfa_challenge_operator(operator_id, expires_at),
  CONSTRAINT fk_platform_mfa_challenge_operator FOREIGN KEY (operator_id) REFERENCES platform_operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_mfa_recovery_codes (
  id VARCHAR(120) PRIMARY KEY,
  operator_id VARCHAR(90) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_platform_mfa_recovery_code(operator_id, code_hash),
  CONSTRAINT fk_platform_mfa_recovery_operator FOREIGN KEY (operator_id) REFERENCES platform_operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_roles (
  id VARCHAR(90) PRIMARY KEY,
  code VARCHAR(80) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  is_protected BOOLEAN NOT NULL DEFAULT TRUE,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_role_permissions (
  role_id VARCHAR(90) NOT NULL,
  permission_code VARCHAR(120) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (role_id, permission_code),
  CONSTRAINT fk_platform_role_permission_role FOREIGN KEY (role_id) REFERENCES platform_roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_operator_role_assignments (
  operator_id VARCHAR(90) NOT NULL,
  role_id VARCHAR(90) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  granted_at DATETIME(3) NOT NULL,
  PRIMARY KEY (operator_id, role_id),
  CONSTRAINT fk_platform_operator_role_operator FOREIGN KEY (operator_id) REFERENCES platform_operators(id),
  CONSTRAINT fk_platform_operator_role_role FOREIGN KEY (role_id) REFERENCES platform_roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_audit_events (
  id VARCHAR(90) PRIMARY KEY,
  actor_operator_id VARCHAR(90) NOT NULL,
  action_code VARCHAR(120) NOT NULL,
  target_type VARCHAR(60) NOT NULL,
  target_id VARCHAR(120) NOT NULL,
  tenant_id VARCHAR(64) NULL,
  result_status VARCHAR(20) NOT NULL,
  reason VARCHAR(500) NOT NULL DEFAULT '',
  request_id VARCHAR(90) NOT NULL DEFAULT '',
  ip_hash CHAR(64) NOT NULL DEFAULT '',
  summary_json JSON NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_platform_audit_created(created_at, id),
  INDEX idx_platform_audit_tenant(tenant_id, created_at),
  CONSTRAINT fk_platform_audit_operator FOREIGN KEY (actor_operator_id) REFERENCES platform_operators(id),
  CONSTRAINT fk_platform_audit_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT chk_platform_audit_status CHECK (result_status IN ('success','rejected','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_lifecycle_events (
  id VARCHAR(90) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  previous_status VARCHAR(20) NOT NULL DEFAULT '',
  next_status VARCHAR(20) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  actor_operator_id VARCHAR(90) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_tenant_lifecycle(tenant_id, created_at),
  CONSTRAINT fk_tenant_lifecycle_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_tenant_lifecycle_operator FOREIGN KEY (actor_operator_id) REFERENCES platform_operators(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_access_requests (
  id VARCHAR(90) PRIMARY KEY,
  tenant_id VARCHAR(64) NOT NULL,
  ticket_no VARCHAR(120) NOT NULL,
  reason VARCHAR(500) NOT NULL,
  permission_codes_json JSON NOT NULL,
  requested_minutes INT NOT NULL DEFAULT 15,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  requested_by VARCHAR(90) NOT NULL,
  reviewed_by VARCHAR(90) NULL,
  review_note VARCHAR(500) NOT NULL DEFAULT '',
  reviewed_at DATETIME(3) NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_support_request_status(status, created_at),
  INDEX idx_support_request_tenant(tenant_id, created_at),
  CONSTRAINT fk_support_request_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_support_request_requester FOREIGN KEY (requested_by) REFERENCES platform_operators(id),
  CONSTRAINT fk_support_request_reviewer FOREIGN KEY (reviewed_by) REFERENCES platform_operators(id),
  CONSTRAINT chk_support_request_status CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  CONSTRAINT chk_support_request_minutes CHECK (requested_minutes BETWEEN 1 AND 60)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_sessions (
  id VARCHAR(90) PRIMARY KEY,
  request_id VARCHAR(90) NOT NULL UNIQUE,
  tenant_id VARCHAR(64) NOT NULL,
  operator_id VARCHAR(90) NOT NULL,
  permission_codes_json JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  started_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  terminated_at DATETIME(3) NULL,
  terminated_by VARCHAR(90) NULL,
  termination_reason VARCHAR(500) NOT NULL DEFAULT '',
  last_accessed_at DATETIME(3) NULL,
  access_count BIGINT NOT NULL DEFAULT 0,
  INDEX idx_support_session_active(operator_id, status, expires_at),
  INDEX idx_support_session_tenant(tenant_id, started_at),
  CONSTRAINT fk_support_session_request FOREIGN KEY (request_id) REFERENCES support_access_requests(id),
  CONSTRAINT fk_support_session_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_support_session_operator FOREIGN KEY (operator_id) REFERENCES platform_operators(id),
  CONSTRAINT fk_support_session_terminator FOREIGN KEY (terminated_by) REFERENCES platform_operators(id),
  CONSTRAINT chk_support_session_status CHECK (status IN ('active','expired','terminated'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_workflow_definitions (
  id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, code VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL, business_type VARCHAR(60) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'draft',
  current_version_id VARCHAR(90) NULL, draft_version_id VARCHAR(90) NULL, allow_parallel BOOLEAN NOT NULL DEFAULT FALSE,
  priority INT NOT NULL DEFAULT 100, is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_by VARCHAR(90) NOT NULL, updated_by VARCHAR(90) NOT NULL, created_at DATETIME(3) NOT NULL, updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_approval_workflow_code(tenant_id, code), INDEX idx_approval_workflow_status(tenant_id, status),
  CONSTRAINT fk_approval_workflow_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_workflow_versions (
  id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, definition_id VARCHAR(90) NOT NULL,
  version_no INT NOT NULL, trigger_config_json JSON NOT NULL, form_schema_json JSON NOT NULL,
  snapshot_json JSON NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'draft', published_by VARCHAR(90) NULL,
  published_at DATETIME(3) NULL, created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_approval_workflow_version(tenant_id, definition_id, version_no),
  CONSTRAINT fk_approval_version_definition FOREIGN KEY (definition_id) REFERENCES approval_workflow_definitions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_nodes (
  id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, workflow_version_id VARCHAR(90) NOT NULL,
  node_type VARCHAR(20) NOT NULL DEFAULT 'approval', name VARCHAR(120) NOT NULL,
  approver_strategy VARCHAR(40) NOT NULL, approver_config_json JSON NOT NULL,
  approval_mode VARCHAR(20) NOT NULL DEFAULT 'single', timeout_config_json JSON NOT NULL, sort_order INT NOT NULL,
  INDEX idx_approval_nodes_version(tenant_id, workflow_version_id, sort_order),
  CONSTRAINT fk_approval_node_version FOREIGN KEY (workflow_version_id) REFERENCES approval_workflow_versions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_instances (
  id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, workflow_definition_id VARCHAR(90) NOT NULL,
  workflow_version_id VARCHAR(90) NOT NULL, business_type VARCHAR(60) NOT NULL, business_id VARCHAR(120) NOT NULL DEFAULT '',
  applicant_membership_id VARCHAR(90) NOT NULL, applicant_org_unit_id VARCHAR(90) NULL,
  title VARCHAR(220) NOT NULL, summary VARCHAR(500) NOT NULL DEFAULT '', form_data_json JSON NOT NULL,
  business_snapshot_json JSON NOT NULL, status VARCHAR(20) NOT NULL, current_node_ids_json JSON NOT NULL,
  idempotency_key VARCHAR(160) NOT NULL, version_no BIGINT NOT NULL DEFAULT 1,
  submitted_at DATETIME(3) NOT NULL, completed_at DATETIME(3) NULL, updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_approval_instance_idempotency(tenant_id, applicant_membership_id, idempotency_key),
  INDEX idx_approval_instance_status(tenant_id, status, updated_at),
  CONSTRAINT fk_approval_instance_workflow FOREIGN KEY (workflow_definition_id) REFERENCES approval_workflow_definitions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_tasks (
  id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, instance_id VARCHAR(90) NOT NULL, node_id VARCHAR(90) NOT NULL,
  assignee_membership_id VARCHAR(90) NOT NULL, delegated_from VARCHAR(90) NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending',
  due_at DATETIME(3) NULL, acted_at DATETIME(3) NULL, version_no BIGINT NOT NULL DEFAULT 1, created_at DATETIME(3) NOT NULL,
  INDEX idx_approval_task_assignee(tenant_id, assignee_membership_id, status, created_at),
  CONSTRAINT fk_approval_task_instance FOREIGN KEY (instance_id) REFERENCES approval_instances(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_actions (
  id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, instance_id VARCHAR(90) NOT NULL, task_id VARCHAR(90) NULL,
  action_type VARCHAR(30) NOT NULL, actor_membership_id VARCHAR(90) NOT NULL, target_membership_id VARCHAR(90) NULL,
  comment_text VARCHAR(1000) NOT NULL DEFAULT '', idempotency_key VARCHAR(160) NOT NULL, metadata_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_approval_action_idempotency(tenant_id, instance_id, action_type, idempotency_key),
  INDEX idx_approval_action_instance(tenant_id, instance_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_delegations (
  id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, delegator_membership_id VARCHAR(90) NOT NULL,
  delegate_membership_id VARCHAR(90) NOT NULL, business_type VARCHAR(60) NOT NULL DEFAULT '*',
  starts_at DATETIME(3) NOT NULL, ends_at DATETIME(3) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'active', created_at DATETIME(3) NOT NULL,
  INDEX idx_approval_delegation_active(tenant_id, delegator_membership_id, status, starts_at, ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_outbox_events (
  id VARCHAR(90) PRIMARY KEY, tenant_id VARCHAR(64) NOT NULL, instance_id VARCHAR(90) NOT NULL,
  event_type VARCHAR(80) NOT NULL, aggregate_type VARCHAR(60) NOT NULL, aggregate_id VARCHAR(120) NOT NULL,
  payload_json JSON NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', attempt_count INT NOT NULL DEFAULT 0,
  available_at DATETIME(3) NOT NULL, processed_at DATETIME(3) NULL, last_error VARCHAR(500) NOT NULL DEFAULT '', created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uk_approval_outbox_event(instance_id, event_type), INDEX idx_approval_outbox_pending(status, available_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS skill_resources (
  id VARCHAR(90) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  category VARCHAR(100) NOT NULL,
  version VARCHAR(40) NOT NULL DEFAULT '1.0.0',
  summary VARCHAR(1200) NOT NULL DEFAULT '',
  usage_guide TEXT,
  training_guide TEXT,
  optimization_advice TEXT,
  acquisition_instructions TEXT,
  download_url VARCHAR(2048) NOT NULL,
  extraction_code VARCHAR(64) NOT NULL DEFAULT '',
  tags_json JSON,
  author VARCHAR(120) NOT NULL DEFAULT '',
  license_text VARCHAR(120) NOT NULL DEFAULT '',
  resource_status VARCHAR(20) NOT NULL DEFAULT 'draft',
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  access_count INT NOT NULL DEFAULT 0,
  last_accessed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_skill_resources_team_status(team_id, resource_status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
