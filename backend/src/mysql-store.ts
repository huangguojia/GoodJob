import mysql from "mysql2/promise";
import { hashPassword } from "./auth.js";
import { aiModelConfigs, caseStudies, commissionCalculations, commissionExports, commissionItems, commissionProducts, commissionRules, competitors, customerActivities, customers, dealEvents, deals, examAttempts, examQuestionLinks, examQuestions, exams, importExportJobs, knowledgeAssets, leadActivities, leadSourceConfigs, leadSourceEvents, leads, memos, monthlySalesRecords, ocrJobs, planTasks, planTemplates, problems, reminders, salesRecordAudits, todos, tradeDocuments, users, wecomMessages, websiteOpportunities, whatsappBindings, whatsappMessages } from "./data.js";
import type { CrmStore } from "./store.js";
import type { WhatsAppBinding, WhatsAppMessage } from "./types.js";
import type { AiModelConfig, CaseStudy, CommissionCalculation, CommissionExport, CommissionItem, CommissionProduct, CommissionRule, Competitor, Customer, CustomerActivity, Deal, DealEvent, Exam, ExamAttempt, ExamQuestion, ExamQuestionLink, ImportExportJob, KnowledgeAsset, Lead, LeadActivity, LeadSourceConfig, LeadSourceEvent, Memo, MonthlySalesRecord, OcrJob, PlanTask, PlanTemplate, ProblemItem, Reminder, SalesRecordAudit, Todo, TradeDocument, User, WecomMessage, WebsiteOpportunity } from "./types.js";

const defaultUrl = "mysql://goodjob:change_me@127.0.0.1:3306/goodjob_crm";

export async function createMysqlStore(): Promise<CrmStore> {
  const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || defaultUrl;
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 4, namedPlaceholders: true });
  await ensureSchema(pool);

  const store: CrmStore = {
    mode: "mysql",
    users: await loadUsers(pool),
    customers: await loadCustomers(pool),
    customerActivities: await loadCustomerActivities(pool),
    leads: await loadLeads(pool),
    leadActivities: await loadLeadActivities(pool),
    leadSourceEvents: await loadLeadSourceEvents(pool),
    todos: await loadTodos(pool),
    deals: await loadDeals(pool),
    dealEvents: await loadDealEvents(pool),
    reminders: await loadReminders(pool),
    knowledgeAssets: await loadKnowledgeAssets(pool),
    exams: await loadExams(pool),
    examQuestions: await loadExamQuestions(pool),
    examQuestionLinks: await loadExamQuestionLinks(pool),
    examAttempts: await loadExamAttempts(pool),
	    importExportJobs: await loadImportExportJobs(pool),
      tradeDocuments: await loadTradeDocuments(pool),
	    wecomMessages: await loadWecomMessages(pool),
		    ocrJobs: await loadOcrJobs(pool),
		    websiteOpportunities: await loadWebsiteOpportunities(pool),
		    aiModelConfigs: await loadAiModelConfigs(pool),
		    leadSourceConfigs: await loadLeadSourceConfigs(pool),
		    planTasks: await loadPlanTasks(pool),
		    planTemplates: await loadPlanTemplates(pool),
		    problems: await loadProblems(pool),
			    memos: await loadMemos(pool),
		    competitors: await loadCompetitors(pool),
		    caseStudies: await loadCaseStudies(pool),
		    commissionProducts: await loadCommissionProducts(pool),
		    commissionRules: await loadCommissionRules(pool),
		    monthlySalesRecords: await loadMonthlySalesRecords(pool),
		    salesRecordAudits: await loadSalesRecordAudits(pool),
		    commissionCalculations: await loadCommissionCalculations(pool),
		    commissionItems: await loadCommissionItems(pool),
		    commissionExports: await loadCommissionExports(pool),
		    whatsappBindings: await loadWhatsAppBindings(pool),
		    whatsappMessages: await loadWhatsAppMessages(pool),
			    async persist() {
      await persistAll(pool, store);
    }
  };

  if (!store.users.length) {
    if (process.env.NODE_ENV === "production") {
      const email = process.env.INITIAL_ADMIN_EMAIL?.trim().toLowerCase();
      const password = process.env.INITIAL_ADMIN_PASSWORD || "";
      if (!email || password.length < 12) {
        throw new Error("首次生产部署必须配置 INITIAL_ADMIN_EMAIL 和至少 12 位的 INITIAL_ADMIN_PASSWORD");
      }
      store.users.push({
        id: "u_initial_super_admin",
        name: process.env.INITIAL_ADMIN_NAME?.trim() || "Super Admin",
        email,
        password: await hashPassword(password),
        role: "super_admin",
        teamId: "all",
        avatar: "SA",
        status: "active",
        authVersion: 1
      });
    } else {
      store.users.push(...users);
    }
    store.customers.push(...customers);
    store.customerActivities.push(...customerActivities);
    store.leads.push(...leads);
    store.leadActivities.push(...leadActivities);
    store.leadSourceEvents.push(...leadSourceEvents);
    store.todos.push(...todos);
    store.deals.push(...deals);
    store.dealEvents.push(...dealEvents);
    store.reminders.push(...reminders);
    store.knowledgeAssets.push(...knowledgeAssets);
    store.exams.push(...exams);
    store.examQuestions.push(...examQuestions);
    store.examQuestionLinks.push(...examQuestionLinks);
    store.examAttempts.push(...examAttempts);
	    store.importExportJobs.push(...importExportJobs);
      store.tradeDocuments.push(...tradeDocuments);
	    store.wecomMessages.push(...wecomMessages);
	    store.ocrJobs.push(...ocrJobs);
	    store.websiteOpportunities.push(...websiteOpportunities);
	    store.aiModelConfigs.push(...aiModelConfigs);
	    store.leadSourceConfigs.push(...leadSourceConfigs);
	    store.planTasks.push(...planTasks);
	    store.planTemplates.push(...planTemplates);
		    store.problems.push(...problems);
    store.memos.push(...memos);
	    store.competitors.push(...competitors);
	    store.caseStudies.push(...caseStudies);
	    store.commissionProducts.push(...commissionProducts);
	    store.commissionRules.push(...commissionRules);
	    store.monthlySalesRecords.push(...monthlySalesRecords);
	    store.salesRecordAudits.push(...salesRecordAudits);
	    store.commissionCalculations.push(...commissionCalculations);
	    store.commissionItems.push(...commissionItems);
	    store.commissionExports.push(...commissionExports);
	    store.whatsappBindings.push(...whatsappBindings);
	    store.whatsappMessages.push(...whatsappMessages);
	    await store.persist();
  }
  if (!store.problems.length) {
    store.problems.push(...problems);
    await store.persist();
  }
  if (!store.memos.length) {
    store.memos.push(...memos);
    await store.persist();
  }
  if (!store.competitors.length) {
    store.competitors.push(...competitors);
    await store.persist();
  }
	  if (!store.caseStudies.length) {
	    store.caseStudies.push(...caseStudies);
	    await store.persist();
	  }
	  if (!store.commissionProducts.length) {
	    store.commissionProducts.push(...commissionProducts);
	    store.commissionRules.push(...commissionRules);
	    await store.persist();
	  }
  if (!store.planTasks.length) {
    store.planTasks.push(...planTasks);
    await store.persist();
  }
  if (!store.planTemplates.length && planTemplates.length) {
    store.planTemplates.push(...planTemplates);
    await store.persist();
  }
  if (!store.tradeDocuments.length) {
    store.tradeDocuments.push(...tradeDocuments);
    await store.persist();
  }
  if (!store.examQuestions.length) {
    store.examQuestions.push(...examQuestions);
    await store.persist();
  }
  if (!store.examQuestionLinks.length) {
    store.examQuestionLinks.push(...examQuestionLinks);
    await store.persist();
  }
  if (!store.examAttempts.length) {
    store.examAttempts.push(...examAttempts);
    await store.persist();
  }
  const missingSeedUsers = process.env.NODE_ENV === "production"
    ? []
    : users.filter((seedUser) => !store.users.some((user) => user.id === seedUser.id || user.email === seedUser.email));
  if (missingSeedUsers.length) {
    store.users.push(...missingSeedUsers);
    await store.persist();
  }

  return store;
}

async function ensureSchema(pool: mysql.Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
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
    last_development_email_at DATETIME NULL,
    last_development_email_to VARCHAR(180) DEFAULT '',
    last_development_email_subject VARCHAR(255) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query("ALTER TABLE users MODIFY role VARCHAR(20) NOT NULL");
  await pool.query("ALTER TABLE users MODIFY status VARCHAR(20) NOT NULL DEFAULT 'active'");
  await ensureColumn(pool, "users", "outbound_email", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "users", "email_sender_name", "VARCHAR(120) DEFAULT ''");
  await ensureColumn(pool, "users", "email_signature", "TEXT");
  await ensureColumn(pool, "users", "smtp_host", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "users", "smtp_port", "INT DEFAULT 465");
  await ensureColumn(pool, "users", "smtp_secure", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "users", "smtp_user", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "users", "smtp_password", "TEXT");
  await ensureColumn(pool, "users", "last_development_email_at", "DATETIME NULL");
  await ensureColumn(pool, "users", "last_development_email_to", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "users", "last_development_email_subject", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "users", "auth_version", "INT NOT NULL DEFAULT 1");
  await pool.query(`CREATE TABLE IF NOT EXISTS customers (
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn(pool, "customers", "billing_name", "VARCHAR(200) DEFAULT ''");
  await ensureColumn(pool, "customers", "billing_address", "TEXT");
  await ensureColumn(pool, "customers", "document_contact", "VARCHAR(200) DEFAULT ''");
  await ensureColumn(pool, "customers", "default_port_discharge", "VARCHAR(120) DEFAULT ''");
  await ensureColumn(pool, "customers", "default_incoterm", "VARCHAR(80) DEFAULT ''");
  await ensureColumn(pool, "customers", "default_payment_term", "VARCHAR(255) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS customer_activities (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL,
    type VARCHAR(30) DEFAULT 'note',
    content TEXT,
    operator_id VARCHAR(64) DEFAULT '',
    next_reminder VARCHAR(100) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_customer_activities_customer(customer_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS leads (
    id VARCHAR(64) PRIMARY KEY,
    company VARCHAR(200) NOT NULL,
    contact VARCHAR(100) DEFAULT '',
    country VARCHAR(80) DEFAULT '',
    email VARCHAR(180) DEFAULT '',
    phone VARCHAR(80) DEFAULT '',
    wechat VARCHAR(80) DEFAULT '',
    source VARCHAR(80) DEFAULT '',
    intent VARCHAR(20) DEFAULT '中',
    stage VARCHAR(40) DEFAULT '新线索',
    status VARCHAR(20) DEFAULT 'new',
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    estimated_amount DECIMAL(14,2) DEFAULT 0,
    next_follow_at VARCHAR(100) DEFAULT '',
    last_activity_at VARCHAR(100) DEFAULT '',
    remark TEXT,
    converted_customer_id VARCHAR(64) DEFAULT '',
    converted_deal_id VARCHAR(64) DEFAULT '',
    source_type VARCHAR(30) DEFAULT 'outbound',
    source_channel VARCHAR(80) DEFAULT 'manual',
    source_campaign VARCHAR(120) DEFAULT '',
    external_id VARCHAR(180) DEFAULT '',
    source_url VARCHAR(500) DEFAULT '',
    deleted_at DATETIME NULL,
    deleted_reason VARCHAR(255) DEFAULT '',
    deleted_by VARCHAR(64) DEFAULT '',
    purge_at DATETIME NULL,
    status_before_delete VARCHAR(20) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_leads_owner(owner_id),
    INDEX idx_leads_team(team_id),
    INDEX idx_leads_stage(stage)
  )`);
  await ensureColumn(pool, "leads", "converted_deal_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "leads", "source_type", "VARCHAR(30) DEFAULT 'outbound'");
  await ensureColumn(pool, "leads", "source_channel", "VARCHAR(80) DEFAULT 'manual'");
  await ensureColumn(pool, "leads", "source_campaign", "VARCHAR(120) DEFAULT ''");
  await ensureColumn(pool, "leads", "external_id", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "leads", "source_url", "VARCHAR(500) DEFAULT ''");
  await ensureColumn(pool, "leads", "deleted_at", "DATETIME NULL");
  await ensureColumn(pool, "leads", "deleted_reason", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "leads", "deleted_by", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "leads", "purge_at", "DATETIME NULL");
  await ensureColumn(pool, "leads", "status_before_delete", "VARCHAR(20) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_activities (
    id VARCHAR(64) PRIMARY KEY,
    lead_id VARCHAR(64) NOT NULL,
    type VARCHAR(30) DEFAULT 'note',
    content TEXT,
    operator_id VARCHAR(64) DEFAULT '',
    next_follow_at VARCHAR(100) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_lead_activities_lead(lead_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_source_events (
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
  )`);
  await ensureUniqueIndex(pool, "lead_source_events", "uniq_lead_source_external", ["owner_id", "channel", "external_id"]);
  await pool.query(`CREATE TABLE IF NOT EXISTS deals (
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
  )`);
  await ensureColumn(pool, "deals", "product", "VARCHAR(200) DEFAULT ''");
  await ensureColumn(pool, "deals", "quantity", "INT DEFAULT 0");
  await ensureColumn(pool, "deals", "unit_price", "DECIMAL(14,2) DEFAULT 0");
  await ensureColumn(pool, "deals", "currency", "VARCHAR(12) DEFAULT 'USD'");
  await ensureColumn(pool, "deals", "amount_type", "VARCHAR(20) DEFAULT 'estimate'");
  await ensureColumn(pool, "deals", "next_action_at", "VARCHAR(40) DEFAULT ''");
  await ensureColumn(pool, "deals", "expected_close_at", "VARCHAR(40) DEFAULT ''");
  await ensureColumn(pool, "deals", "stage_changed_at", "DATETIME NULL");
  await ensureColumn(pool, "deals", "closed_at", "DATETIME NULL");
  await ensureColumn(pool, "deals", "won_reason", "TEXT");
  await ensureColumn(pool, "deals", "lost_reason", "TEXT");
  await ensureColumn(pool, "deals", "lost_reason_category", "VARCHAR(80) DEFAULT ''");
  await ensureColumn(pool, "deals", "revisit_at", "VARCHAR(40) DEFAULT ''");
  await ensureColumn(pool, "deals", "archived_at", "TIMESTAMP NULL");
  await pool.query(`CREATE TABLE IF NOT EXISTS deal_events (
    id VARCHAR(64) PRIMARY KEY,
    deal_id VARCHAR(64) NOT NULL,
    event_type VARCHAR(40) NOT NULL,
    content TEXT,
    operator_id VARCHAR(64) NOT NULL,
    from_stage VARCHAR(40) DEFAULT '',
    to_stage VARCHAR(40) DEFAULT '',
    next_action VARCHAR(200) DEFAULT '',
    next_action_at VARCHAR(40) DEFAULT '',
    related_document_id VARCHAR(64) DEFAULT '',
    created_at DATETIME NOT NULL,
    INDEX idx_deal_events_deal(deal_id),
    INDEX idx_deal_events_operator(operator_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS todos (
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
	    customer_id VARCHAR(64) DEFAULT '',
	    deal_id VARCHAR(64) DEFAULT '',
	    reminder_rule_id VARCHAR(64) DEFAULT '',
	    trigger_key VARCHAR(255) DEFAULT '',
	    snoozed_from VARCHAR(100) DEFAULT '',
	    snooze_reason VARCHAR(255) DEFAULT '',
	    snooze_count INT DEFAULT 0,
	    snoozed_by VARCHAR(64) DEFAULT '',
	    completed_at TIMESTAMP NULL,
	    completed_by VARCHAR(64) DEFAULT '',
	    completion_result VARCHAR(255) DEFAULT '',
	    INDEX idx_todos_owner_history(owner_id, history_at)
	  )`);
  await ensureColumn(pool, "todos", "status", "VARCHAR(24) DEFAULT 'pending'");
  await ensureColumn(pool, "todos", "pin_state", "VARCHAR(20) DEFAULT ''");
  await ensureColumn(pool, "todos", "sort_order", "INT DEFAULT 0");
  await ensureColumn(pool, "todos", "created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  await ensureColumn(pool, "todos", "history_at", "TIMESTAMP NULL");
  await ensureColumn(pool, "todos", "customer_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "deal_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "reminder_rule_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "trigger_key", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "todos", "snoozed_from", "VARCHAR(100) DEFAULT ''");
  await ensureColumn(pool, "todos", "snooze_reason", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "todos", "snooze_count", "INT DEFAULT 0");
  await ensureColumn(pool, "todos", "snoozed_by", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "completed_at", "TIMESTAMP NULL");
  await ensureColumn(pool, "todos", "completed_by", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "todos", "completion_result", "VARCHAR(255) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS plan_tasks (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    phase VARCHAR(80),
    category VARCHAR(80),
    priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    status VARCHAR(30) NOT NULL DEFAULT 'planned',
    due_at VARCHAR(100),
    target VARCHAR(255),
    description TEXT,
    customer_id VARCHAR(64) DEFAULT '',
    lead_id VARCHAR(64) DEFAULT '',
    deal_id VARCHAR(64) DEFAULT '',
    completion_result TEXT,
    completed_at DATETIME NULL,
    cancellation_reason TEXT,
    cancelled_at DATETIME NULL,
    rescheduled_from VARCHAR(100) DEFAULT '',
    rescheduled_at DATETIME NULL,
    reschedule_reason VARCHAR(255) DEFAULT '',
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_plan_tasks_owner(owner_id),
    INDEX idx_plan_tasks_team(team_id)
  )`);
  await ensureColumn(pool, "plan_tasks", "customer_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "plan_tasks", "lead_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "plan_tasks", "deal_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "plan_tasks", "completion_result", "TEXT");
  await ensureColumn(pool, "plan_tasks", "completed_at", "DATETIME NULL");
  await ensureColumn(pool, "plan_tasks", "cancellation_reason", "TEXT");
  await ensureColumn(pool, "plan_tasks", "cancelled_at", "DATETIME NULL");
  await ensureColumn(pool, "plan_tasks", "rescheduled_from", "VARCHAR(100) DEFAULT ''");
  await ensureColumn(pool, "plan_tasks", "rescheduled_at", "DATETIME NULL");
  await ensureColumn(pool, "plan_tasks", "reschedule_reason", "VARCHAR(255) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS plan_templates (
    id VARCHAR(64) PRIMARY KEY,
    section_name VARCHAR(40) NOT NULL,
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    output_text VARCHAR(255),
    badge VARCHAR(80),
    badge_tone VARCHAR(40),
    phase VARCHAR(80),
    category VARCHAR(80),
    priority VARCHAR(20) NOT NULL DEFAULT 'normal',
    target VARCHAR(255),
    description TEXT,
    sort_order INT DEFAULT 0,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_plan_templates_owner(owner_id),
    INDEX idx_plan_templates_section(section_name)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS reminders (
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
  )`);
  await ensureColumn(pool, "reminders", "rule_type", "VARCHAR(40)");
  await ensureColumn(pool, "reminders", "target_stage", "VARCHAR(40)");
  await ensureColumn(pool, "reminders", "days_count", "INT DEFAULT 3");
  await ensureColumn(pool, "reminders", "priority", "VARCHAR(20) DEFAULT 'normal'");
  await ensureColumn(pool, "reminders", "enabled", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "reminders", "generated_count", "INT DEFAULT 0");
  await ensureColumn(pool, "reminders", "target_owner_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "reminders", "last_run_by", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "reminders", "last_run_at", "TIMESTAMP NULL");
  await ensureColumn(pool, "reminders", "last_matched_count", "INT DEFAULT 0");
  await ensureColumn(pool, "reminders", "last_created_count", "INT DEFAULT 0");
  await ensureColumn(pool, "reminders", "last_skipped_count", "INT DEFAULT 0");
  await ensureColumn(pool, "reminders", "last_failed_count", "INT DEFAULT 0");
  await ensureColumn(pool, "reminders", "last_error", "VARCHAR(255) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS knowledge_assets (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    category VARCHAR(100),
    status VARCHAR(40),
    owner_id VARCHAR(64),
    team_id VARCHAR(64) DEFAULT 'all',
    version VARCHAR(40),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn(pool, "knowledge_assets", "team_id", "VARCHAR(64) DEFAULT 'all'");
  await pool.query(`CREATE TABLE IF NOT EXISTS exams (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    category VARCHAR(100),
    status VARCHAR(40),
    pass_rate DECIMAL(5,2),
    question_count INT DEFAULT 0,
    duration_minutes INT DEFAULT 20,
    pass_score INT DEFAULT 80,
    target_role VARCHAR(40) DEFAULT 'sales',
    owner_id VARCHAR(64) DEFAULT '',
    team_id VARCHAR(64) DEFAULT 'all',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn(pool, "exams", "duration_minutes", "INT DEFAULT 20");
  await ensureColumn(pool, "exams", "pass_score", "INT DEFAULT 80");
  await ensureColumn(pool, "exams", "target_role", "VARCHAR(40) DEFAULT 'sales'");
  await ensureColumn(pool, "exams", "owner_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "exams", "team_id", "VARCHAR(64) DEFAULT 'all'");
  await ensureColumn(pool, "exams", "updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  await pool.query(`CREATE TABLE IF NOT EXISTS exam_questions (
    id VARCHAR(64) PRIMARY KEY,
    exam_id VARCHAR(64) DEFAULT 'bank',
    category VARCHAR(100),
    stem TEXT NOT NULL,
    options_json JSON NOT NULL,
    answer_index INT NOT NULL,
    answer_indexes_json JSON,
    question_type VARCHAR(20) DEFAULT 'single',
    tags_json JSON,
    explanation TEXT,
    difficulty VARCHAR(20),
    owner_id VARCHAR(64) DEFAULT '',
    team_id VARCHAR(64) DEFAULT 'all',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_exam_questions_exam(exam_id)
  )`);
  await ensureColumn(pool, "exam_questions", "answer_indexes_json", "JSON");
  await ensureColumn(pool, "exam_questions", "question_type", "VARCHAR(20) DEFAULT 'single'");
  await ensureColumn(pool, "exam_questions", "tags_json", "JSON");
  await ensureColumn(pool, "exam_questions", "owner_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "exam_questions", "team_id", "VARCHAR(64) DEFAULT 'all'");
  await pool.query(`CREATE TABLE IF NOT EXISTS exam_question_links (
    exam_id VARCHAR(64) NOT NULL,
    question_id VARCHAR(64) NOT NULL,
    sort_order INT DEFAULT 0,
    PRIMARY KEY (exam_id, question_id),
    INDEX idx_exam_question_links_exam(exam_id),
    INDEX idx_exam_question_links_question(question_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS exam_attempts (
    id VARCHAR(64) PRIMARY KEY,
    exam_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    score DECIMAL(5,2),
    passed BOOLEAN,
    answers_json JSON,
    correct_count INT DEFAULT 0,
    total_questions INT DEFAULT 0,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_exam_attempts_user(user_id),
    INDEX idx_exam_attempts_exam(exam_id)
  )`);
  await ensureColumn(pool, "exam_attempts", "answers_json", "JSON");
  await ensureColumn(pool, "exam_attempts", "correct_count", "INT DEFAULT 0");
  await ensureColumn(pool, "exam_attempts", "total_questions", "INT DEFAULT 0");
  await pool.query(`CREATE TABLE IF NOT EXISTS ocr_jobs (
    id VARCHAR(64) PRIMARY KEY,
    status VARCHAR(40),
    confidence DECIMAL(5,2),
    fields_json JSON,
    created_by VARCHAR(64),
    owner_id VARCHAR(64) NOT NULL DEFAULT 'u_sales_shirley',
    team_id VARCHAR(64) NOT NULL DEFAULT 'europe',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn(pool, "ocr_jobs", "owner_id", "VARCHAR(64) NOT NULL DEFAULT 'u_sales_shirley'");
  await ensureColumn(pool, "ocr_jobs", "team_id", "VARCHAR(64) NOT NULL DEFAULT 'europe'");
  await pool.query(`CREATE TABLE IF NOT EXISTS website_opportunities (
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
    last_development_email_at DATETIME NULL,
    last_development_email_subject VARCHAR(255) DEFAULT '',
    last_development_email_to VARCHAR(180) DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_website_opps_owner(owner_id),
    INDEX idx_website_opps_team(team_id)
  )`);
  await ensureColumn(pool, "website_opportunities", "parse_mode", "VARCHAR(20) DEFAULT 'rule'");
  await ensureColumn(pool, "website_opportunities", "lead_id", "VARCHAR(64) DEFAULT NULL");
  await ensureColumn(pool, "website_opportunities", "source", "VARCHAR(40) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "source_label", "VARCHAR(80) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "confidence", "INT NULL");
  await ensureColumn(pool, "website_opportunities", "last_development_email_at", "DATETIME NULL");
  await ensureColumn(pool, "website_opportunities", "last_development_email_subject", "VARCHAR(255) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "last_development_email_to", "VARCHAR(180) DEFAULT ''");
  await ensureColumn(pool, "website_opportunities", "verified_at", "DATETIME NULL");
  await ensureColumn(pool, "website_opportunities", "status_changed_at", "DATETIME NULL");
  await ensureColumn(pool, "website_opportunities", "excluded_reason", "VARCHAR(255) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_model_configs (
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
  )`);
  await ensureColumn(pool, "ai_model_configs", "protocol", "VARCHAR(40) NOT NULL DEFAULT 'openai-compatible'");
  await ensureColumn(pool, "ai_model_configs", "temperature", "DECIMAL(4,2) DEFAULT 0.10");
  await ensureColumn(pool, "ai_model_configs", "use_lead_finder", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "ai_model_configs", "use_website_parse", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "ai_model_configs", "use_scoring", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "ai_model_configs", "use_email_draft", "BOOLEAN DEFAULT TRUE");
  await ensureColumn(pool, "ai_model_configs", "use_exam", "BOOLEAN DEFAULT FALSE");
  await ensureColumn(pool, "ai_model_configs", "last_test_at", "DATETIME NULL");
  await ensureColumn(pool, "ai_model_configs", "last_test_status", "VARCHAR(20) DEFAULT 'untested'");
  await ensureColumn(pool, "ai_model_configs", "last_test_message", "VARCHAR(255) DEFAULT ''");
  await pool.query(`CREATE TABLE IF NOT EXISTS lead_source_configs (
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
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS import_export_jobs (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    type VARCHAR(20) NOT NULL,
    rows_count INT DEFAULT 0,
    status VARCHAR(40),
    operator_id VARCHAR(64),
    created_at VARCHAR(100)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS trade_documents (
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
    approval_note TEXT,
    approved_at VARCHAR(100),
    approved_by VARCHAR(64),
    audits_json JSON,
    send_records_json JSON,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    items_json JSON,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_trade_documents_owner(owner_id),
    INDEX idx_trade_documents_team(team_id)
  )`);
  await ensureColumn(pool, "trade_documents", "customer_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "trade_documents", "deal_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "trade_documents", "revision", "INT DEFAULT 1");
  await ensureColumn(pool, "trade_documents", "approval_note", "TEXT");
  await ensureColumn(pool, "trade_documents", "approved_at", "VARCHAR(100)");
  await ensureColumn(pool, "trade_documents", "approved_by", "VARCHAR(64)");
  await ensureColumn(pool, "trade_documents", "audits_json", "JSON");
  await ensureColumn(pool, "trade_documents", "send_records_json", "JSON");
	  await pool.query(`CREATE TABLE IF NOT EXISTS wecom_messages (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64),
    summary TEXT,
    owner_id VARCHAR(64),
    team_id VARCHAR(64),
    status VARCHAR(40),
	    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
	  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS problems (
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
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS memos (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    content TEXT,
    category VARCHAR(80),
    tags VARCHAR(255),
    customer_id VARCHAR(64) DEFAULT '',
    deal_id VARCHAR(64) DEFAULT '',
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    pinned BOOLEAN DEFAULT FALSE,
    archived BOOLEAN DEFAULT FALSE,
    deleted_at DATETIME NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_memos_owner(owner_id),
    INDEX idx_memos_team(team_id)
  )`);
  await ensureColumn(pool, "memos", "customer_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "memos", "deal_id", "VARCHAR(64) DEFAULT ''");
  await ensureColumn(pool, "memos", "deleted_at", "DATETIME NULL");
  await pool.query(`CREATE TABLE IF NOT EXISTS competitors (
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
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS case_studies (
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
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS commission_products (
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
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS commission_rules (
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
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS monthly_sales_records (
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
    exchange_rate_date VARCHAR(20) DEFAULT '',
    exchange_rate_source VARCHAR(20) DEFAULT 'pending',
    settlement_currency VARCHAR(12) DEFAULT 'CNY',
    settlement_amount DECIMAL(14,2) DEFAULT 0,
    basis_type VARCHAR(30) DEFAULT 'deal_amount',
    basis_date VARCHAR(20) DEFAULT '',
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
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sales_record_audits (
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
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS commission_calculations (
    id VARCHAR(64) PRIMARY KEY,
    month_value VARCHAR(20) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    sales_amount DECIMAL(14,2) DEFAULT 0,
    auto_commission DECIMAL(14,2) DEFAULT 0,
    manual_adjustment DECIMAL(14,2) DEFAULT 0,
    final_commission DECIMAL(14,2) DEFAULT 0,
    status VARCHAR(30) DEFAULT 'pending',
    version_no INT DEFAULT 1,
    is_current BOOLEAN DEFAULT TRUE,
    calculated_at DATETIME NULL,
    reviewed_by VARCHAR(64) DEFAULT '',
    reviewed_at DATETIME NULL,
    locked_by VARCHAR(64) DEFAULT '',
    locked_at DATETIME NULL,
    unlock_reason TEXT,
    INDEX idx_commission_calculations_scope(month_value, owner_id),
    INDEX idx_commission_calculations_team(month_value, team_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS commission_items (
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
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS commission_exports (
    id VARCHAR(64) PRIMARY KEY,
    month_value VARCHAR(20) NOT NULL,
    scope_type VARCHAR(20) DEFAULT 'self',
    scope_owner_id VARCHAR(64) DEFAULT '',
    file_type VARCHAR(20) DEFAULT 'xlsx',
    rows_count INT DEFAULT 0,
    exported_by VARCHAR(64) NOT NULL,
    created_at DATETIME NULL,
    INDEX idx_commission_exports_month(month_value)
  )`);
  await ensureColumn(pool, "monthly_sales_records", "exchange_rate_date", "VARCHAR(20) DEFAULT ''");
  await ensureColumn(pool, "monthly_sales_records", "exchange_rate_source", "VARCHAR(20) DEFAULT 'pending'");
  await ensureColumn(pool, "monthly_sales_records", "settlement_currency", "VARCHAR(12) DEFAULT 'CNY'");
  await ensureColumn(pool, "monthly_sales_records", "basis_type", "VARCHAR(30) DEFAULT 'deal_amount'");
  await ensureColumn(pool, "monthly_sales_records", "basis_date", "VARCHAR(20) DEFAULT ''");
  await ensureColumn(pool, "commission_calculations", "version_no", "INT DEFAULT 1");
  await ensureColumn(pool, "commission_calculations", "is_current", "BOOLEAN DEFAULT TRUE");

  await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_bindings (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL UNIQUE,
    phone_number VARCHAR(20) NOT NULL,
    wa_profile_name VARCHAR(100) DEFAULT '',
    last_message_at DATETIME NULL,
    unread_count INT DEFAULT 0,
    created_at DATETIME NULL,
    binding_mode VARCHAR(20) DEFAULT 'manual',
    user_id VARCHAR(64) DEFAULT '',
    session_data TEXT,
    twilio_phone_number VARCHAR(20) DEFAULT '',
    connection_status VARCHAR(20) DEFAULT 'disconnected',
    last_connected_at DATETIME NULL,
    INDEX idx_whatsapp_bindings_customer(customer_id),
    INDEX idx_whatsapp_bindings_user(user_id)
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS whatsapp_messages (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL,
    direction VARCHAR(20) NOT NULL,
    content TEXT,
    content_translated TEXT,
    media_url VARCHAR(500) DEFAULT '',
    status VARCHAR(20) DEFAULT '',
    wa_message_id VARCHAR(128) DEFAULT '',
    created_at DATETIME NULL,
    INDEX idx_whatsapp_messages_customer(customer_id),
    INDEX idx_whatsapp_messages_created(created_at)
  )`);
}

async function rows<T>(pool: mysql.Pool, sql: string): Promise<T[]> {
  const [result] = await pool.query(sql);
  return result as T[];
}

async function ensureColumn(pool: mysql.Pool, table: string, column: string, definition: string) {
  const [result] = await pool.query(
    "SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
    [table, column]
  );
  const exists = Number((result as Array<{ count: number }>)[0]?.count || 0) > 0;
  if (!exists) await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function ensureUniqueIndex(pool: mysql.Pool, table: string, index: string, columns: string[]) {
  const [result] = await pool.query(
    "SELECT column_name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? ORDER BY seq_in_index",
    [table, index]
  );
  const current = (result as Array<{ column_name: string }>).map((row) => row.column_name);
  if (current.length === columns.length && current.every((column, position) => column === columns[position])) return;
  if (current.length) await pool.query(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
  await pool.query(`ALTER TABLE \`${table}\` ADD UNIQUE KEY \`${index}\` (${columns.map((column) => `\`${column}\``).join(", ")})`);
}

async function loadUsers(pool: mysql.Pool): Promise<User[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM users")).map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    password: row.password_hash,
    role: row.role,
    teamId: row.team_id,
    avatar: row.avatar,
    status: row.status,
    authVersion: Number(row.auth_version || 1),
    outboundEmail: row.outbound_email || "",
    emailSenderName: row.email_sender_name ?? "",
    emailSignature: row.email_signature || "",
    smtpHost: row.smtp_host || "",
    smtpPort: Number(row.smtp_port || 465),
    smtpSecure: row.smtp_secure === undefined || row.smtp_secure === null ? true : Boolean(row.smtp_secure),
    smtpUser: row.smtp_user || "",
    smtpPassword: row.smtp_password || "",
    hasSmtpPassword: Boolean(row.smtp_password),
    lastDevelopmentEmailAt: row.last_development_email_at instanceof Date ? row.last_development_email_at.toISOString() : row.last_development_email_at || "",
    lastDevelopmentEmailTo: row.last_development_email_to || "",
    lastDevelopmentEmailSubject: row.last_development_email_subject || ""
  }));
}

async function loadLeads(pool: mysql.Pool): Promise<Lead[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM leads ORDER BY created_at DESC")).map((row) => ({
    id: row.id, company: row.company, contact: row.contact || "", country: row.country || "", email: row.email || "", phone: row.phone || "", wechat: row.wechat || "", source: row.source || "", sourceType: row.source_type || "outbound", sourceChannel: row.source_channel || "manual", sourceCampaign: row.source_campaign || "", externalId: row.external_id || "", sourceUrl: row.source_url || "", intent: row.intent || "中", stage: row.stage || "新线索", status: (row.status || "new") as Lead["status"], ownerId: row.owner_id, teamId: row.team_id, estimatedAmount: Number(row.estimated_amount || 0), nextFollowAt: row.next_follow_at || "", lastActivityAt: row.last_activity_at || "", remark: row.remark || "", convertedCustomerId: row.converted_customer_id || "", convertedDealId: row.converted_deal_id || "", createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString(), deletedAt: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : row.deleted_at || "", deletedReason: row.deleted_reason || "", deletedBy: row.deleted_by || "", purgeAt: row.purge_at instanceof Date ? row.purge_at.toISOString() : row.purge_at || "", statusBeforeDelete: row.status_before_delete || undefined
  }));
}

async function loadLeadActivities(pool: mysql.Pool): Promise<LeadActivity[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM lead_activities ORDER BY created_at DESC")).map((row) => ({
    id: row.id, leadId: row.lead_id, type: row.type || "note", content: row.content || "", operatorId: row.operator_id || "", nextFollowAt: row.next_follow_at || "", createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadLeadSourceEvents(pool: mysql.Pool): Promise<LeadSourceEvent[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM lead_source_events ORDER BY received_at DESC")).map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    sourceType: row.source_type || "outbound",
    channel: row.channel || "manual",
    campaign: row.campaign || "",
    externalId: row.external_id || "",
    sourceUrl: row.source_url || "",
    occurredAt: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    receivedAt: row.received_at instanceof Date ? row.received_at.toISOString() : row.received_at,
    rawPayload: typeof row.raw_payload === "string" ? row.raw_payload : JSON.stringify(row.raw_payload || {}),
    ownerId: row.owner_id,
    teamId: row.team_id
  }));
}

async function loadCustomers(pool: mysql.Pool): Promise<Customer[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM customers ORDER BY created_at DESC")).map((row) => ({
    id: row.id, company: row.company, country: row.country, contact: row.contact, ownerId: row.owner_id, teamId: row.team_id, stage: row.stage, amount: Number(row.amount), health: Number(row.health), nextReminder: row.next_reminder, wecomBound: Boolean(row.wecom_bound), billingName: row.billing_name || "", billingAddress: row.billing_address || "", documentContact: row.document_contact || "", defaultPortDischarge: row.default_port_discharge || "", defaultIncoterm: row.default_incoterm || "", defaultPaymentTerm: row.default_payment_term || ""
  }));
}

async function loadCustomerActivities(pool: mysql.Pool): Promise<CustomerActivity[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM customer_activities ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    type: row.type || "note",
    content: row.content || "",
    operatorId: row.operator_id || "",
    nextReminder: row.next_reminder || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadTodos(pool: mysql.Pool): Promise<Todo[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM todos ORDER BY done ASC, created_at DESC")).map((row) => ({
    id: row.id, title: row.title, type: row.type, priority: row.priority, status: row.status || "pending", pinState: row.pin_state || "", sortOrder: Number(row.sort_order || 0), dueAt: row.due_at, ownerId: row.owner_id, teamId: row.team_id, related: row.related, done: Boolean(row.done), impactAmount: row.impact_amount == null ? undefined : Number(row.impact_amount), createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at, historyAt: row.history_at instanceof Date ? row.history_at.toISOString() : row.history_at || undefined,
    customerId: row.customer_id || undefined, dealId: row.deal_id || undefined, reminderRuleId: row.reminder_rule_id || undefined, triggerKey: row.trigger_key || undefined, snoozedFrom: row.snoozed_from || undefined, snoozeReason: row.snooze_reason || undefined, snoozeCount: Number(row.snooze_count || 0), snoozedBy: row.snoozed_by || undefined, completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at || undefined, completedBy: row.completed_by || undefined, completionResult: row.completion_result || undefined
  }));
}

async function loadPlanTasks(pool: mysql.Pool): Promise<PlanTask[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM plan_tasks ORDER BY status = 'done' ASC, updated_at DESC, created_at DESC")).map((row) => ({
    id: row.id,
    title: row.title,
    phase: row.phase || "计划任务",
    category: row.category || "客户开发",
    priority: row.priority || "normal",
    status: row.status || "planned",
    dueAt: row.due_at || "",
    target: row.target || "",
    description: row.description || "",
    customerId: row.customer_id || "",
    leadId: row.lead_id || "",
    dealId: row.deal_id || "",
    completionResult: row.completion_result || "",
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at || "",
    cancellationReason: row.cancellation_reason || "",
    cancelledAt: row.cancelled_at instanceof Date ? row.cancelled_at.toISOString() : row.cancelled_at || "",
    rescheduledFrom: row.rescheduled_from || "",
    rescheduledAt: row.rescheduled_at instanceof Date ? row.rescheduled_at.toISOString() : row.rescheduled_at || "",
    rescheduleReason: row.reschedule_reason || "",
    ownerId: row.owner_id,
    teamId: row.team_id,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadPlanTemplates(pool: mysql.Pool): Promise<PlanTemplate[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM plan_templates ORDER BY sort_order ASC, updated_at DESC")).map((row) => ({
    id: row.id,
    section: row.section_name || "knowledge",
    title: row.title,
    summary: row.summary || "",
    output: row.output_text || "",
    badge: row.badge || "",
    badgeTone: row.badge_tone || "",
    phase: row.phase || "计划任务",
    category: row.category || "客户开发",
    priority: row.priority || "normal",
    target: row.target || "",
    description: row.description || "",
    sortOrder: Number(row.sort_order || 0),
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadDeals(pool: mysql.Pool): Promise<Deal[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM deals")).map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    title: row.title,
    stage: row.stage,
    product: row.product || "",
    quantity: Number(row.quantity || 0),
    unitPrice: Number(row.unit_price || 0),
    amount: Number(row.amount),
    currency: row.currency || "USD",
    amountType: row.amount_type || (row.stage === "成交" ? "won" : row.stage === "已报价" || row.stage === "样品" || row.stage === "谈判" ? "quoted" : "estimate"),
    ownerId: row.owner_id,
    teamId: row.team_id,
    nextAction: row.next_action || "安排下一步跟进",
    nextActionAt: row.next_action_at || "",
    expectedCloseAt: row.expected_close_at || "",
    stageChangedAt: row.stage_changed_at instanceof Date ? row.stage_changed_at.toISOString() : row.stage_changed_at || new Date().toISOString(),
    closedAt: row.closed_at instanceof Date ? row.closed_at.toISOString() : row.closed_at || undefined,
    wonReason: row.won_reason || undefined,
    lostReason: row.lost_reason || undefined,
    lostReasonCategory: row.lost_reason_category || undefined,
    revisitAt: row.revisit_at || undefined,
    archivedAt: row.archived_at instanceof Date ? row.archived_at.toISOString() : row.archived_at || undefined
  }));
}

async function loadDealEvents(pool: mysql.Pool): Promise<DealEvent[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM deal_events ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    dealId: row.deal_id,
    type: row.event_type,
    content: row.content || "",
    operatorId: row.operator_id,
    fromStage: row.from_stage || undefined,
    toStage: row.to_stage || undefined,
    nextAction: row.next_action || undefined,
    nextActionAt: row.next_action_at || undefined,
    relatedDocumentId: row.related_document_id || undefined,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  }));
}

async function loadReminders(pool: mysql.Pool): Promise<Reminder[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM reminders")).map((row) => ({
    id: row.id, title: row.title, rule: row.rule_text, dueAt: row.due_at, ownerId: row.owner_id, teamId: row.team_id, channel: "站内", status: row.enabled == null || Boolean(row.enabled) ? "enabled" : "disabled", ruleType: row.rule_type || undefined, targetStage: row.target_stage || undefined, days: row.days_count == null ? undefined : Number(row.days_count), priority: row.priority || "normal", enabled: row.enabled == null ? true : Boolean(row.enabled), generatedCount: Number(row.generated_count || 0), targetOwnerId: row.target_owner_id || row.owner_id, lastRunBy: row.last_run_by || undefined, lastRunAt: row.last_run_at instanceof Date ? row.last_run_at.toISOString() : row.last_run_at || undefined, lastMatchedCount: Number(row.last_matched_count || 0), lastCreatedCount: Number(row.last_created_count || 0), lastSkippedCount: Number(row.last_skipped_count || 0), lastFailedCount: Number(row.last_failed_count || 0), lastError: row.last_error || undefined
  }));
}

async function loadKnowledgeAssets(pool: mysql.Pool): Promise<KnowledgeAsset[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM knowledge_assets ORDER BY created_at DESC")).map((row) => ({
    id: row.id, title: row.title, category: row.category, status: row.status, ownerId: row.owner_id, teamId: row.team_id || "all", version: row.version
  }));
}

async function loadExams(pool: mysql.Pool): Promise<Exam[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM exams ORDER BY updated_at DESC, id DESC")).map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    status: row.status,
    passRate: Number(row.pass_rate),
    questionCount: Number(row.question_count),
    durationMinutes: Number(row.duration_minutes || 20),
    passScore: Number(row.pass_score || 80),
    targetRole: row.target_role || "sales",
    ownerId: row.owner_id || "",
    teamId: row.team_id || "all",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadExamQuestions(pool: mysql.Pool): Promise<ExamQuestion[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM exam_questions ORDER BY updated_at DESC, id DESC")).map((row) => ({
    id: row.id,
    examId: row.exam_id,
    category: row.category,
    stem: row.stem,
    options: typeof row.options_json === "string" ? JSON.parse(row.options_json) : row.options_json,
    answerIndex: Number(row.answer_index),
    answerIndexes: row.answer_indexes_json ? (typeof row.answer_indexes_json === "string" ? JSON.parse(row.answer_indexes_json) : row.answer_indexes_json) : [Number(row.answer_index)],
    questionType: row.question_type || "single",
    tags: row.tags_json ? (typeof row.tags_json === "string" ? JSON.parse(row.tags_json) : row.tags_json) : [],
    explanation: row.explanation || "",
    difficulty: row.difficulty || "medium",
    ownerId: row.owner_id || "",
    teamId: row.team_id || "all",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadExamQuestionLinks(pool: mysql.Pool): Promise<ExamQuestionLink[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM exam_question_links ORDER BY exam_id ASC, sort_order ASC")).map((row) => ({
    examId: row.exam_id,
    questionId: row.question_id,
    sortOrder: Number(row.sort_order || 0)
  }));
}

async function loadExamAttempts(pool: mysql.Pool): Promise<ExamAttempt[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM exam_attempts ORDER BY submitted_at DESC")).map((row) => ({
    id: row.id,
    examId: row.exam_id,
    userId: row.user_id,
    score: Number(row.score),
    passed: Boolean(row.passed),
    answers: row.answers_json ? (typeof row.answers_json === "string" ? JSON.parse(row.answers_json) : row.answers_json) : {},
    correctCount: Number(row.correct_count || 0),
    totalQuestions: Number(row.total_questions || 0),
    submittedAt: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : row.submitted_at
  }));
}

async function loadImportExportJobs(pool: mysql.Pool): Promise<ImportExportJob[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM import_export_jobs")).map((row) => ({
    id: row.id, name: row.name, type: row.type, rows: Number(row.rows_count), status: row.status, operatorId: row.operator_id, createdAt: row.created_at
  }));
}

async function loadTradeDocuments(pool: mysql.Pool): Promise<TradeDocument[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM trade_documents ORDER BY updated_at DESC")).map((row) => ({
    id: row.id,
    customerId: row.customer_id || "",
    dealId: row.deal_id || "",
    revision: Number(row.revision || 1),
    type: row.doc_type,
    title: row.title,
    number: row.doc_number,
    issueDate: row.issue_date,
    buyer: row.buyer,
    buyerAddress: row.buyer_address,
    buyerContact: row.buyer_contact,
    seller: row.seller,
    sellerAddress: row.seller_address,
    currency: row.currency,
    incoterm: row.incoterm,
    paymentTerm: row.payment_term,
    shippingMethod: row.shipping_method,
    portLoading: row.port_loading,
    portDischarge: row.port_discharge,
    validityDate: row.validity_date,
    bankInfo: row.bank_info,
    notes: row.notes,
    templateStyle: row.template_style || "executive",
    status: row.status || "draft",
    approvalNote: row.approval_note || "",
    approvedAt: row.approved_at instanceof Date ? row.approved_at.toISOString() : row.approved_at || undefined,
    approvedBy: row.approved_by || undefined,
    audits: row.audits_json ? (typeof row.audits_json === "string" ? JSON.parse(row.audits_json) : row.audits_json) : [],
    sendRecords: row.send_records_json ? (typeof row.send_records_json === "string" ? JSON.parse(row.send_records_json) : row.send_records_json) : [],
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    items: row.items_json ? (typeof row.items_json === "string" ? JSON.parse(row.items_json) : row.items_json) : []
  }));
}

async function loadWecomMessages(pool: mysql.Pool): Promise<WecomMessage[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM wecom_messages")).map((row) => ({
    id: row.id, customerId: row.customer_id, summary: row.summary, ownerId: row.owner_id, teamId: row.team_id, status: row.status
  }));
}

async function loadOcrJobs(pool: mysql.Pool): Promise<OcrJob[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM ocr_jobs")).map((row) => ({
    id: row.id, status: row.status, confidence: Number(row.confidence), fields: typeof row.fields_json === "string" ? JSON.parse(row.fields_json) : row.fields_json, ownerId: row.owner_id || row.created_by || "u_sales_shirley", teamId: row.team_id || "europe"
  }));
}

async function loadWebsiteOpportunities(pool: mysql.Pool): Promise<WebsiteOpportunity[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM website_opportunities ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    company: row.company,
    business: row.business,
    country: row.country,
    website: row.website,
    contact: row.contact,
    contactInfo: row.contact_info,
    description: row.description,
    ownerId: row.owner_id,
    teamId: row.team_id,
    status: row.status,
    customerId: row.customer_id || undefined,
    dealId: row.deal_id || undefined,
    leadId: row.lead_id || undefined,
    parseMode: row.parse_mode || "rule",
    source: row.source || undefined,
    sourceLabel: row.source_label || undefined,
    confidence: row.confidence === undefined || row.confidence === null ? undefined : Number(row.confidence),
    lastDevelopmentEmailAt: row.last_development_email_at instanceof Date ? row.last_development_email_at.toISOString() : row.last_development_email_at || "",
    lastDevelopmentEmailSubject: row.last_development_email_subject || "",
    lastDevelopmentEmailTo: row.last_development_email_to || "",
    verifiedAt: row.verified_at instanceof Date ? row.verified_at.toISOString() : row.verified_at || "",
    statusChangedAt: row.status_changed_at instanceof Date ? row.status_changed_at.toISOString() : row.status_changed_at || "",
    excludedReason: row.excluded_reason || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  }));
}

async function loadAiModelConfigs(pool: mysql.Pool): Promise<AiModelConfig[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM ai_model_configs ORDER BY updated_at DESC")).map((row) => ({
    id: row.id,
    provider: row.provider || "openai",
    protocol: row.protocol || (row.provider === "anthropic" ? "anthropic" : row.provider === "gemini" ? "gemini" : "openai-compatible"),
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    apiKey: row.api_key || "",
    enabled: Boolean(row.enabled),
    temperature: Number(row.temperature ?? 0.1),
    useLeadFinder: row.use_lead_finder === undefined || row.use_lead_finder === null ? true : Boolean(row.use_lead_finder),
    useWebsiteParse: row.use_website_parse === undefined || row.use_website_parse === null ? true : Boolean(row.use_website_parse),
    useScoring: row.use_scoring === undefined || row.use_scoring === null ? true : Boolean(row.use_scoring),
    useEmailDraft: row.use_email_draft === undefined || row.use_email_draft === null ? true : Boolean(row.use_email_draft),
    useExam: Boolean(row.use_exam),
    lastTestAt: row.last_test_at instanceof Date ? row.last_test_at.toISOString() : row.last_test_at || undefined,
    lastTestStatus: row.last_test_status || "untested",
    lastTestMessage: row.last_test_message || "",
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadLeadSourceConfigs(pool: mysql.Pool): Promise<LeadSourceConfig[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM lead_source_configs ORDER BY updated_at DESC")).map((row) => ({
    id: row.id,
    provider: row.provider,
    scope: row.scope === "team" ? "team" : "personal",
    apiKey: row.api_key || "",
    baseUrl: row.base_url || "",
    enabled: Boolean(row.enabled),
    lastTestAt: row.last_test_at instanceof Date ? row.last_test_at.toISOString() : row.last_test_at || undefined,
    lastTestStatus: row.last_test_status || "untested",
    lastTestMessage: row.last_test_message || "",
    usageJson: row.usage_json || undefined,
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadProblems(pool: mysql.Pool): Promise<ProblemItem[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM problems ORDER BY status = 'resolved' ASC, created_at DESC")).map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    severity: row.severity,
    status: row.status,
    ownerId: row.owner_id,
    teamId: row.team_id,
    relatedCustomer: row.related_customer,
    rootCause: row.root_cause,
    solution: row.solution,
    nextAction: row.next_action,
    dueAt: row.due_at,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  }));
}

async function loadMemos(pool: mysql.Pool): Promise<Memo[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM memos ORDER BY pinned DESC, archived ASC, updated_at DESC")).map((row) => ({
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    tags: row.tags,
    customerId: row.customer_id || "",
    dealId: row.deal_id || "",
    ownerId: row.owner_id,
    teamId: row.team_id,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
    deletedAt: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : row.deleted_at || "",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadCompetitors(pool: mysql.Pool): Promise<Competitor[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM competitors ORDER BY threat_level = 'high' DESC, updated_at DESC")).map((row) => ({
    id: row.id,
    company: row.company,
    country: row.country,
    segment: row.segment,
    threatLevel: row.threat_level,
    website: row.website,
    strengths: row.strengths,
    weaknesses: row.weaknesses,
    competingProducts: row.competing_products,
    ourStrategy: row.our_strategy,
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadCaseStudies(pool: mysql.Pool): Promise<CaseStudy[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM case_studies ORDER BY status = 'published' DESC, updated_at DESC")).map((row) => ({
    id: row.id,
    title: row.title,
    customer: row.customer,
    country: row.country,
    product: row.product,
    industry: row.industry,
    result: row.result_text,
    story: row.story,
    reusablePoints: row.reusable_points,
    status: row.status,
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  }));
}

async function loadCommissionProducts(pool: mysql.Pool): Promise<CommissionProduct[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM commission_products ORDER BY status = 'active' DESC, updated_at DESC")).map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category || "",
    model: row.model || "",
    currency: row.currency || "USD",
    defaultPrice: Number(row.default_price || 0),
    costPrice: Number(row.cost_price || 0),
    status: row.status || "active",
    remark: row.remark || "",
    ownerId: row.owner_id,
    teamId: row.team_id,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at || new Date().toISOString()
  }));
}

async function loadCommissionRules(pool: mysql.Pool): Promise<CommissionRule[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM commission_rules ORDER BY enabled DESC, created_at DESC")).map((row) => ({
    id: row.id,
    productId: row.product_id,
    ruleType: row.rule_type || "none",
    rate: Number(row.rate || 0),
    fixedAmount: Number(row.fixed_amount || 0),
    tierJson: row.tier_json || "",
    grossProfitRate: Number(row.gross_profit_rate || 0),
    effectiveFrom: row.effective_from || "",
    effectiveTo: row.effective_to || "",
    enabled: row.enabled === undefined || row.enabled === null ? true : Boolean(row.enabled),
    remark: row.remark || "",
    createdBy: row.created_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadMonthlySalesRecords(pool: mysql.Pool): Promise<MonthlySalesRecord[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM monthly_sales_records ORDER BY month_value DESC, updated_at DESC")).map((row) => ({
    id: row.id,
    month: row.month_value,
    ownerId: row.owner_id,
    teamId: row.team_id,
    customerId: row.customer_id || "",
    customerName: row.customer_name || "",
    dealId: row.deal_id || "",
    productId: row.product_id || "",
    productName: row.product_name || "",
    quantity: Number(row.quantity || 0),
    unitPrice: Number(row.unit_price || 0),
    salesAmount: Number(row.sales_amount || 0),
    currency: row.currency || "USD",
    exchangeRate: Number(row.exchange_rate || 1),
    exchangeRateDate: row.exchange_rate_date || "",
    exchangeRateSource: row.exchange_rate_source || "pending",
    settlementCurrency: row.settlement_currency || "CNY",
    settlementAmount: Number(row.settlement_amount || 0),
    basisType: row.basis_type || "deal_amount",
    basisDate: row.basis_date || "",
    dealArchivedAt: row.deal_archived_at || "",
    sourceType: row.source_type || "manual",
    status: row.status || "draft",
    edited: Boolean(row.edited),
    editNote: row.edit_note || "",
    lastEditedBy: row.last_edited_by || "",
    lastEditedAt: row.last_edited_at instanceof Date ? row.last_edited_at.toISOString() : row.last_edited_at || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at || new Date().toISOString()
  }));
}

async function loadSalesRecordAudits(pool: mysql.Pool): Promise<SalesRecordAudit[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM sales_record_audits ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    recordId: row.record_id,
    fieldName: row.field_name,
    oldValue: row.old_value || "",
    newValue: row.new_value || "",
    reason: row.reason || "",
    operatorId: row.operator_id,
    operatorName: row.operator_name || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadCommissionCalculations(pool: mysql.Pool): Promise<CommissionCalculation[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM commission_calculations ORDER BY month_value DESC, calculated_at DESC")).map((row) => ({
    id: row.id,
    month: row.month_value,
    ownerId: row.owner_id,
    teamId: row.team_id,
    salesAmount: Number(row.sales_amount || 0),
    autoCommission: Number(row.auto_commission || 0),
    manualAdjustment: Number(row.manual_adjustment || 0),
    finalCommission: Number(row.final_commission || 0),
    status: row.status || "pending",
    version: Number(row.version_no || 1),
    isCurrent: row.is_current === undefined || row.is_current === null ? true : Boolean(row.is_current),
    calculatedAt: row.calculated_at instanceof Date ? row.calculated_at.toISOString() : row.calculated_at || "",
    reviewedBy: row.reviewed_by || "",
    reviewedAt: row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : row.reviewed_at || "",
    lockedBy: row.locked_by || "",
    lockedAt: row.locked_at instanceof Date ? row.locked_at.toISOString() : row.locked_at || "",
    unlockReason: row.unlock_reason || ""
  }));
}

async function loadCommissionItems(pool: mysql.Pool): Promise<CommissionItem[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM commission_items ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    calculationId: row.calculation_id,
    recordId: row.record_id || "",
    productId: row.product_id || "",
    itemType: row.item_type || "auto",
    sourceType: row.source_type || "auto",
    ruleSnapshotJson: row.rule_snapshot_json || "",
    salesAmount: Number(row.sales_amount || 0),
    autoAmount: Number(row.auto_amount || 0),
    manualAmount: Number(row.manual_amount || 0),
    finalAmount: Number(row.final_amount || 0),
    remark: row.remark || "",
    createdBy: row.created_by || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadCommissionExports(pool: mysql.Pool): Promise<CommissionExport[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM commission_exports ORDER BY created_at DESC")).map((row) => ({
    id: row.id,
    month: row.month_value,
    scopeType: row.scope_type || "self",
    scopeOwnerId: row.scope_owner_id || "",
    fileType: row.file_type || "xlsx",
    rows: Number(row.rows_count || 0),
    exportedBy: row.exported_by,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function loadWhatsAppBindings(pool: mysql.Pool): Promise<WhatsAppBinding[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM whatsapp_bindings ORDER BY last_message_at DESC")).map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    phoneNumber: row.phone_number,
    waProfileName: row.wa_profile_name || "",
    lastMessageAt: row.last_message_at instanceof Date ? row.last_message_at.toISOString() : row.last_message_at || "",
    unreadCount: Number(row.unread_count || 0),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString(),
    bindingMode: row.binding_mode || "manual",
    userId: row.user_id || "",
    sessionData: row.session_data || "",
    twilioPhoneNumber: row.twilio_phone_number || "",
    connectionStatus: row.connection_status || "disconnected",
    lastConnectedAt: row.last_connected_at instanceof Date ? row.last_connected_at.toISOString() : row.last_connected_at || ""
  }));
}

async function loadWhatsAppMessages(pool: mysql.Pool): Promise<WhatsAppMessage[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM whatsapp_messages ORDER BY created_at ASC")).map((row) => ({
    id: row.id,
    customerId: row.customer_id,
    direction: row.direction as "inbound" | "outbound",
    content: row.content || "",
    contentTranslated: row.content_translated || "",
    mediaUrl: row.media_url || "",
    status: row.status || "",
    waMessageId: row.wa_message_id || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at || new Date().toISOString()
  }));
}

async function persistAll(pool: mysql.Pool, store: CrmStore) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await replaceRows(connection, "users", store.users, (item) => [item.id, item.name, item.email, item.password, item.role, item.teamId, item.avatar, item.status, item.authVersion || 1, item.outboundEmail || "", item.emailSenderName ?? "", item.emailSignature || "", item.smtpHost || "", item.smtpPort || 465, item.smtpSecure ?? true, item.smtpUser || "", item.smtpPassword || "", item.lastDevelopmentEmailAt ? mysqlDate(item.lastDevelopmentEmailAt) : null, item.lastDevelopmentEmailTo || "", item.lastDevelopmentEmailSubject || ""], "(id,name,email,password_hash,role,team_id,avatar,status,auth_version,outbound_email,email_sender_name,email_signature,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_password,last_development_email_at,last_development_email_to,last_development_email_subject)");
    await replaceRows(connection, "customers", store.customers, (item) => [item.id, item.company, item.country, item.contact, item.ownerId, item.teamId, item.stage, item.amount, item.health, item.nextReminder, item.wecomBound, item.billingName || "", item.billingAddress || "", item.documentContact || "", item.defaultPortDischarge || "", item.defaultIncoterm || "", item.defaultPaymentTerm || ""], "(id,company,country,contact,owner_id,team_id,stage,amount,health,next_reminder,wecom_bound,billing_name,billing_address,document_contact,default_port_discharge,default_incoterm,default_payment_term)");
    await replaceRows(connection, "customer_activities", store.customerActivities, (item) => [item.id, item.customerId, item.type || "note", item.content || "", item.operatorId || "", item.nextReminder || "", mysqlDate(item.createdAt)], "(id,customer_id,type,content,operator_id,next_reminder,created_at)");
    await replaceRows(connection, "leads", store.leads, (item) => [item.id, item.company, item.contact || "", item.country || "", item.email || "", item.phone || "", item.wechat || "", item.source || "", item.sourceType || "outbound", item.sourceChannel || "manual", item.sourceCampaign || "", item.externalId || "", item.sourceUrl || "", item.intent || "中", item.stage || "新线索", item.status || "new", item.ownerId, item.teamId, item.estimatedAmount || 0, item.nextFollowAt || "", item.lastActivityAt || "", item.remark || "", item.convertedCustomerId || "", item.convertedDealId || "", item.deletedAt ? mysqlDate(item.deletedAt) : null, item.deletedReason || "", item.deletedBy || "", item.purgeAt ? mysqlDate(item.purgeAt) : null, item.statusBeforeDelete || "", mysqlDate(item.createdAt)], "(id,company,contact,country,email,phone,wechat,source,source_type,source_channel,source_campaign,external_id,source_url,intent,stage,status,owner_id,team_id,estimated_amount,next_follow_at,last_activity_at,remark,converted_customer_id,converted_deal_id,deleted_at,deleted_reason,deleted_by,purge_at,status_before_delete,created_at)");
    await replaceRows(connection, "lead_activities", store.leadActivities, (item) => [item.id, item.leadId, item.type || "note", item.content || "", item.operatorId || "", item.nextFollowAt || "", mysqlDate(item.createdAt)], "(id,lead_id,type,content,operator_id,next_follow_at,created_at)");
    await replaceRows(connection, "lead_source_events", store.leadSourceEvents, (item) => [item.id, item.leadId, item.sourceType, item.channel, item.campaign || "", item.externalId || "", item.sourceUrl || "", mysqlDate(item.occurredAt), mysqlDate(item.receivedAt), item.rawPayload || "{}", item.ownerId, item.teamId], "(id,lead_id,source_type,channel,campaign,external_id,source_url,occurred_at,received_at,raw_payload,owner_id,team_id)");
    await replaceRows(connection, "deals", store.deals, (item) => [item.id, item.customerId, item.title, item.stage, item.product || "", item.quantity || 0, item.unitPrice || 0, item.amount, item.currency || "USD", item.amountType || "estimate", item.ownerId, item.teamId, item.nextAction, item.nextActionAt || "", item.expectedCloseAt || "", mysqlDate(item.stageChangedAt), item.closedAt ? mysqlDate(item.closedAt) : null, item.wonReason || "", item.lostReason || "", item.lostReasonCategory || "", item.revisitAt || "", item.archivedAt ? mysqlDate(item.archivedAt) : null], "(id,customer_id,title,stage,product,quantity,unit_price,amount,currency,amount_type,owner_id,team_id,next_action,next_action_at,expected_close_at,stage_changed_at,closed_at,won_reason,lost_reason,lost_reason_category,revisit_at,archived_at)");
    await replaceRows(connection, "deal_events", store.dealEvents, (item) => [item.id, item.dealId, item.type, item.content || "", item.operatorId, item.fromStage || "", item.toStage || "", item.nextAction || "", item.nextActionAt || "", item.relatedDocumentId || "", mysqlDate(item.createdAt)], "(id,deal_id,event_type,content,operator_id,from_stage,to_stage,next_action,next_action_at,related_document_id,created_at)");
    await replaceRows(connection, "todos", (store.todos as Todo[]), (item) => [item.id, item.title, item.type, item.priority, item.dueAt, item.ownerId, item.teamId, item.related, item.done, item.status || "pending", item.pinState || "", item.sortOrder || 0, item.impactAmount ?? null, mysqlDate(item.createdAt), item.historyAt ? mysqlDate(item.historyAt) : null, item.customerId || "", item.dealId || "", item.reminderRuleId || "", item.triggerKey || "", item.snoozedFrom || "", item.snoozeReason || "", item.snoozeCount || 0, item.snoozedBy || "", item.completedAt ? mysqlDate(item.completedAt) : null, item.completedBy || "", item.completionResult || ""], "(id,title,type,priority,due_at,owner_id,team_id,related,done,status,pin_state,sort_order,impact_amount,created_at,history_at,customer_id,deal_id,reminder_rule_id,trigger_key,snoozed_from,snooze_reason,snooze_count,snoozed_by,completed_at,completed_by,completion_result)");
    await replaceRows(connection, "plan_tasks", store.planTasks, (item) => [item.id, item.title, item.phase, item.category, item.priority, item.status, item.dueAt, item.target, item.description, item.customerId || "", item.leadId || "", item.dealId || "", item.completionResult || "", item.completedAt ? mysqlDate(item.completedAt) : null, item.cancellationReason || "", item.cancelledAt ? mysqlDate(item.cancelledAt) : null, item.rescheduledFrom || "", item.rescheduledAt ? mysqlDate(item.rescheduledAt) : null, item.rescheduleReason || "", item.ownerId, item.teamId, mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,title,phase,category,priority,status,due_at,target,description,customer_id,lead_id,deal_id,completion_result,completed_at,cancellation_reason,cancelled_at,rescheduled_from,rescheduled_at,reschedule_reason,owner_id,team_id,created_at,updated_at)");
    await replaceRows(connection, "plan_templates", store.planTemplates, (item) => [item.id, item.section, item.title, item.summary, item.output, item.badge, item.badgeTone, item.phase, item.category, item.priority, item.target, item.description, item.sortOrder, item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,section_name,title,summary,output_text,badge,badge_tone,phase,category,priority,target,description,sort_order,owner_id,team_id,updated_at)");
    await replaceRows(connection, "reminders", store.reminders, (item) => [item.id, item.title, item.rule, item.dueAt, item.ownerId, item.teamId, "站内", item.enabled === false ? "disabled" : "enabled", item.ruleType || null, item.targetStage || null, item.days ?? 3, item.priority || "normal", item.enabled ?? true, item.generatedCount || 0, item.targetOwnerId || item.ownerId, item.lastRunBy || "", item.lastRunAt ? mysqlDate(item.lastRunAt) : null, item.lastMatchedCount || 0, item.lastCreatedCount || 0, item.lastSkippedCount || 0, item.lastFailedCount || 0, item.lastError || ""], "(id,title,rule_text,due_at,owner_id,team_id,channel,status,rule_type,target_stage,days_count,priority,enabled,generated_count,target_owner_id,last_run_by,last_run_at,last_matched_count,last_created_count,last_skipped_count,last_failed_count,last_error)");
    await replaceRows(connection, "knowledge_assets", store.knowledgeAssets, (item) => [item.id, item.title, item.category, item.status, item.ownerId, item.teamId || "all", item.version], "(id,title,category,status,owner_id,team_id,version)");
    await replaceRows(connection, "exams", store.exams, (item) => [item.id, item.title, item.category, item.status, item.passRate, item.questionCount, item.durationMinutes || 20, item.passScore || 80, item.targetRole || "sales", item.ownerId || "", item.teamId || "all", mysqlDate(item.updatedAt)], "(id,title,category,status,pass_rate,question_count,duration_minutes,pass_score,target_role,owner_id,team_id,updated_at)");
    await replaceRows(connection, "exam_questions", store.examQuestions, (item) => [item.id, item.examId || "bank", item.category, item.stem, JSON.stringify(item.options), item.answerIndex, JSON.stringify(item.answerIndexes?.length ? item.answerIndexes : [item.answerIndex]), item.questionType || ((item.answerIndexes?.length || 0) > 1 ? "multiple" : "single"), JSON.stringify(item.tags || []), item.explanation, item.difficulty, item.ownerId || "", item.teamId || "all", mysqlDate(item.updatedAt)], "(id,exam_id,category,stem,options_json,answer_index,answer_indexes_json,question_type,tags_json,explanation,difficulty,owner_id,team_id,updated_at)");
    await replaceRows(connection, "exam_question_links", store.examQuestionLinks, (item) => [item.examId, item.questionId, item.sortOrder], "(exam_id,question_id,sort_order)");
    await replaceRows(connection, "exam_attempts", store.examAttempts, (item) => [item.id, item.examId, item.userId, item.score, item.passed, JSON.stringify(item.answers), item.correctCount, item.totalQuestions, mysqlDate(item.submittedAt)], "(id,exam_id,user_id,score,passed,answers_json,correct_count,total_questions,submitted_at)");
    await replaceRows(connection, "import_export_jobs", store.importExportJobs, (item) => [item.id, item.name, item.type, item.rows, item.status, item.operatorId, item.createdAt], "(id,name,type,rows_count,status,operator_id,created_at)");
    await replaceRows(connection, "trade_documents", store.tradeDocuments, (item) => [item.id, item.customerId || "", item.dealId || "", item.revision || 1, item.type, item.title, item.number, item.issueDate, item.buyer, item.buyerAddress, item.buyerContact, item.seller, item.sellerAddress, item.currency, item.incoterm, item.paymentTerm, item.shippingMethod, item.portLoading, item.portDischarge, item.validityDate, item.bankInfo, item.notes, item.templateStyle, item.status, item.approvalNote || "", item.approvedAt || null, item.approvedBy || "", JSON.stringify(item.audits || []), JSON.stringify(item.sendRecords || []), item.ownerId, item.teamId, JSON.stringify(item.items), mysqlDate(item.updatedAt)], "(id,customer_id,deal_id,revision,doc_type,title,doc_number,issue_date,buyer,buyer_address,buyer_contact,seller,seller_address,currency,incoterm,payment_term,shipping_method,port_loading,port_discharge,validity_date,bank_info,notes,template_style,status,approval_note,approved_at,approved_by,audits_json,send_records_json,owner_id,team_id,items_json,updated_at)");
	    await replaceRows(connection, "wecom_messages", store.wecomMessages, (item) => [item.id, item.customerId, item.summary, item.ownerId, item.teamId, item.status], "(id,customer_id,summary,owner_id,team_id,status)");
	    await replaceRows(connection, "ocr_jobs", store.ocrJobs, (item) => [item.id, item.status, item.confidence, JSON.stringify(item.fields), item.ownerId, item.ownerId, item.teamId], "(id,status,confidence,fields_json,created_by,owner_id,team_id)");
	    await replaceRows(connection, "website_opportunities", store.websiteOpportunities, (item) => [item.id, item.company, item.business, item.country, item.website, item.contact, item.contactInfo, item.description, item.ownerId, item.teamId, item.status, item.customerId || null, item.dealId || null, item.leadId || null, item.parseMode || "rule", item.source || "", item.sourceLabel || "", item.confidence ?? null, item.lastDevelopmentEmailAt ? mysqlDate(item.lastDevelopmentEmailAt) : null, item.lastDevelopmentEmailSubject || "", item.lastDevelopmentEmailTo || "", item.verifiedAt ? mysqlDate(item.verifiedAt) : null, item.statusChangedAt ? mysqlDate(item.statusChangedAt) : null, item.excludedReason || "", mysqlDate(item.createdAt)], "(id,company,business,country,website,contact,contact_info,description,owner_id,team_id,status,customer_id,deal_id,lead_id,parse_mode,source,source_label,confidence,last_development_email_at,last_development_email_subject,last_development_email_to,verified_at,status_changed_at,excluded_reason,created_at)");
	    await replaceRows(connection, "ai_model_configs", store.aiModelConfigs, (item) => [item.id, item.provider, item.protocol || "openai-compatible", item.name, item.baseUrl, item.model, item.apiKey, item.enabled, item.temperature ?? 0.1, item.useLeadFinder ?? true, item.useWebsiteParse ?? true, item.useScoring ?? true, item.useEmailDraft ?? true, item.useExam ?? false, item.lastTestAt ? mysqlDate(item.lastTestAt) : null, item.lastTestStatus || "untested", item.lastTestMessage || "", item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,provider,protocol,name,base_url,model,api_key,enabled,temperature,use_lead_finder,use_website_parse,use_scoring,use_email_draft,use_exam,last_test_at,last_test_status,last_test_message,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "lead_source_configs", store.leadSourceConfigs, (item) => [item.id, item.provider, item.scope || "personal", item.apiKey, item.baseUrl || "", item.enabled, item.lastTestAt ? mysqlDate(item.lastTestAt) : null, item.lastTestStatus || "untested", item.lastTestMessage || "", item.usageJson || "", item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,provider,scope,api_key,base_url,enabled,last_test_at,last_test_status,last_test_message,usage_json,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "problems", store.problems, (item) => [item.id, item.title, item.category, item.severity, item.status, item.ownerId, item.teamId, item.relatedCustomer, item.rootCause, item.solution, item.nextAction, item.dueAt, mysqlDate(item.createdAt)], "(id,title,category,severity,status,owner_id,team_id,related_customer,root_cause,solution,next_action,due_at,created_at)");
	    await replaceRows(connection, "memos", store.memos, (item) => [item.id, item.title, item.content, item.category, item.tags, item.customerId || "", item.dealId || "", item.ownerId, item.teamId, item.pinned, item.archived, item.deletedAt ? mysqlDate(item.deletedAt) : null, mysqlDate(item.updatedAt)], "(id,title,content,category,tags,customer_id,deal_id,owner_id,team_id,pinned,archived,deleted_at,updated_at)");
	    await replaceRows(connection, "competitors", store.competitors, (item) => [item.id, item.company, item.country, item.segment, item.threatLevel, item.website, item.strengths, item.weaknesses, item.competingProducts, item.ourStrategy, item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,company,country,segment,threat_level,website,strengths,weaknesses,competing_products,our_strategy,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "case_studies", store.caseStudies, (item) => [item.id, item.title, item.customer, item.country, item.product, item.industry, item.result, item.story, item.reusablePoints, item.status, item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,title,customer,country,product,industry,result_text,story,reusable_points,status,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "commission_products", store.commissionProducts, (item) => [item.id, item.name, item.category, item.model, item.currency, item.defaultPrice, item.costPrice, item.status, item.remark, item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,name,category,model,currency,default_price,cost_price,status,remark,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "commission_rules", store.commissionRules, (item) => [item.id, item.productId, item.ruleType, item.rate, item.fixedAmount, item.tierJson, item.grossProfitRate, item.effectiveFrom, item.effectiveTo, item.enabled, item.remark, item.createdBy, mysqlDate(item.createdAt)], "(id,product_id,rule_type,rate,fixed_amount,tier_json,gross_profit_rate,effective_from,effective_to,enabled,remark,created_by,created_at)");
	    await replaceRows(connection, "monthly_sales_records", store.monthlySalesRecords, (item) => [item.id, item.month, item.ownerId, item.teamId, item.customerId, item.customerName, item.dealId, item.productId, item.productName, item.quantity, item.unitPrice, item.salesAmount, item.currency, item.exchangeRate, item.exchangeRateDate, item.exchangeRateSource, item.settlementCurrency, item.settlementAmount, item.basisType, item.basisDate, item.dealArchivedAt, item.sourceType, item.status, item.edited, item.editNote, item.lastEditedBy, item.lastEditedAt ? mysqlDate(item.lastEditedAt) : null, mysqlDate(item.createdAt), mysqlDate(item.updatedAt)], "(id,month_value,owner_id,team_id,customer_id,customer_name,deal_id,product_id,product_name,quantity,unit_price,sales_amount,currency,exchange_rate,exchange_rate_date,exchange_rate_source,settlement_currency,settlement_amount,basis_type,basis_date,deal_archived_at,source_type,status,edited,edit_note,last_edited_by,last_edited_at,created_at,updated_at)");
	    await replaceRows(connection, "sales_record_audits", store.salesRecordAudits, (item) => [item.id, item.recordId, item.fieldName, item.oldValue, item.newValue, item.reason, item.operatorId, item.operatorName, mysqlDate(item.createdAt)], "(id,record_id,field_name,old_value,new_value,reason,operator_id,operator_name,created_at)");
	    await replaceRows(connection, "commission_calculations", store.commissionCalculations, (item) => [item.id, item.month, item.ownerId, item.teamId, item.salesAmount, item.autoCommission, item.manualAdjustment, item.finalCommission, item.status, item.version, item.isCurrent, item.calculatedAt ? mysqlDate(item.calculatedAt) : null, item.reviewedBy, item.reviewedAt ? mysqlDate(item.reviewedAt) : null, item.lockedBy, item.lockedAt ? mysqlDate(item.lockedAt) : null, item.unlockReason], "(id,month_value,owner_id,team_id,sales_amount,auto_commission,manual_adjustment,final_commission,status,version_no,is_current,calculated_at,reviewed_by,reviewed_at,locked_by,locked_at,unlock_reason)");
	    await replaceRows(connection, "commission_items", store.commissionItems, (item) => [item.id, item.calculationId, item.recordId, item.productId, item.itemType, item.sourceType, item.ruleSnapshotJson, item.salesAmount, item.autoAmount, item.manualAmount, item.finalAmount, item.remark, item.createdBy, mysqlDate(item.createdAt)], "(id,calculation_id,record_id,product_id,item_type,source_type,rule_snapshot_json,sales_amount,auto_amount,manual_amount,final_amount,remark,created_by,created_at)");
	    await replaceRows(connection, "commission_exports", store.commissionExports, (item) => [item.id, item.month, item.scopeType, item.scopeOwnerId, item.fileType, item.rows, item.exportedBy, mysqlDate(item.createdAt)], "(id,month_value,scope_type,scope_owner_id,file_type,rows_count,exported_by,created_at)");
	    await replaceRows(connection, "whatsapp_bindings", store.whatsappBindings, (item) => [item.id, item.customerId, item.phoneNumber, item.waProfileName || "", item.lastMessageAt ? mysqlDate(item.lastMessageAt) : null, item.unreadCount || 0, mysqlDate(item.createdAt), item.bindingMode || "manual", item.userId || "", item.sessionData || "", item.twilioPhoneNumber || "", item.connectionStatus || "disconnected", item.lastConnectedAt ? mysqlDate(item.lastConnectedAt) : null], "(id,customer_id,phone_number,wa_profile_name,last_message_at,unread_count,created_at,binding_mode,user_id,session_data,twilio_phone_number,connection_status,last_connected_at)");
	    await replaceRows(connection, "whatsapp_messages", store.whatsappMessages, (item) => [item.id, item.customerId, item.direction, item.content || "", item.contentTranslated || "", item.mediaUrl || "", item.status || "", item.waMessageId || "", mysqlDate(item.createdAt)], "(id,customer_id,direction,content,content_translated,media_url,status,wa_message_id,created_at)");
	    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function replaceRows<T>(connection: mysql.PoolConnection, table: string, items: T[], values: (item: T) => unknown[], columns: string) {
  await connection.query(`DELETE FROM ${table}`);
  if (!items.length) return;
  const mapped = items.map(values);
  const placeholders = mapped.map((row) => `(${row.map(() => "?").join(",")})`).join(",");
  await connection.query(`INSERT INTO ${table} ${columns} VALUES ${placeholders}`, mapped.flat());
}

function mysqlDate(value?: string) {
  const date = value ? new Date(value) : new Date();
  return Number.isFinite(date.getTime()) ? date : new Date();
}
