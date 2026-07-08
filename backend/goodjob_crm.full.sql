-- GoodJob CRM MySQL initialization script.
-- Open-source safe: schema only, no private customer/todo/memo/business rows.

DROP DATABASE IF EXISTS goodjob_crm;
CREATE DATABASE goodjob_crm CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE goodjob_crm;

CREATE TABLE users (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  avatar VARCHAR(8),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  outbound_email VARCHAR(180) DEFAULT '',
  email_sender_name VARCHAR(120) DEFAULT '',
  email_signature TEXT,
  smtp_host VARCHAR(180) DEFAULT '',
  smtp_port INT DEFAULT 465,
  smtp_secure BOOLEAN DEFAULT TRUE,
  smtp_user VARCHAR(180) DEFAULT '',
  smtp_password TEXT,
  last_development_email_at DATETIME NULL,
  last_development_email_to VARCHAR(180) DEFAULT '',
  last_development_email_subject VARCHAR(255) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE customers (
  id VARCHAR(64) PRIMARY KEY,
  company VARCHAR(200) NOT NULL,
  country VARCHAR(80),
  contact VARCHAR(100),
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  stage VARCHAR(40),
  amount DECIMAL(14,2) DEFAULT 0,
  health INT DEFAULT 0,
  next_reminder VARCHAR(100),
  wecom_bound BOOLEAN DEFAULT FALSE,
  billing_name VARCHAR(200) DEFAULT '',
  billing_address TEXT,
  document_contact VARCHAR(200) DEFAULT '',
  default_port_discharge VARCHAR(120) DEFAULT '',
  default_incoterm VARCHAR(80) DEFAULT '',
  default_payment_term VARCHAR(255) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_customers_owner(owner_id),
  INDEX idx_customers_team(team_id)
);

CREATE TABLE deals (
  id VARCHAR(64) PRIMARY KEY,
  customer_id VARCHAR(64) NOT NULL,
  title VARCHAR(200) NOT NULL,
  stage VARCHAR(40) NOT NULL,
  product VARCHAR(200) DEFAULT '',
  quantity INT DEFAULT 0,
  unit_price DECIMAL(14,2) DEFAULT 0,
  amount DECIMAL(14,2) DEFAULT 0,
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
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
  version VARCHAR(40),
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
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_exam_attempts_exam_id (exam_id),
  INDEX idx_exam_attempts_user_id (user_id)
);

CREATE TABLE ocr_jobs (
  id VARCHAR(64) PRIMARY KEY,
  status VARCHAR(40),
  confidence DECIMAL(5,2),
  fields_json JSON,
  created_by VARCHAR(64),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  parse_mode VARCHAR(20) DEFAULT 'rule',
  last_development_email_at DATETIME NULL,
  last_development_email_subject VARCHAR(255) DEFAULT '',
  last_development_email_to VARCHAR(180) DEFAULT '',
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
  doc_type VARCHAR(10) NOT NULL,
  title VARCHAR(255) NOT NULL,
  doc_number VARCHAR(80) NOT NULL,
  issue_date VARCHAR(40),
  buyer VARCHAR(200),
  buyer_address TEXT,
  buyer_contact VARCHAR(200),
  seller VARCHAR(200),
  seller_address TEXT,
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
  status VARCHAR(40),
  owner_id VARCHAR(64) NOT NULL,
  team_id VARCHAR(64) NOT NULL,
  items_json JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_trade_documents_owner(owner_id),
  INDEX idx_trade_documents_team(team_id)
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
