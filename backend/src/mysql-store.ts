import mysql from "mysql2/promise";
import { aiModelConfigs, caseStudies, competitors, customers, deals, examAttempts, examQuestions, exams, importExportJobs, knowledgeAssets, memos, ocrJobs, problems, reminders, todos, users, wecomMessages, websiteOpportunities } from "./data.js";
import type { CrmStore } from "./store.js";
import type { AiModelConfig, CaseStudy, Competitor, Customer, Deal, Exam, ExamAttempt, ExamQuestion, ImportExportJob, KnowledgeAsset, Memo, OcrJob, ProblemItem, Reminder, Todo, User, WecomMessage, WebsiteOpportunity } from "./types.js";

const defaultUrl = "mysql://root:password@127.0.0.1:3306/goodjob_crm";

export async function createMysqlStore(): Promise<CrmStore> {
  const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || defaultUrl;
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 4, namedPlaceholders: true });
  await ensureSchema(pool);

  const store: CrmStore = {
    mode: "mysql",
    users: await loadUsers(pool),
    customers: await loadCustomers(pool),
    todos: await loadTodos(pool),
    deals: await loadDeals(pool),
    reminders: await loadReminders(pool),
    knowledgeAssets: await loadKnowledgeAssets(pool),
    exams: await loadExams(pool),
    examQuestions: await loadExamQuestions(pool),
    examAttempts: await loadExamAttempts(pool),
	    importExportJobs: await loadImportExportJobs(pool),
	    wecomMessages: await loadWecomMessages(pool),
		    ocrJobs: await loadOcrJobs(pool),
		    websiteOpportunities: await loadWebsiteOpportunities(pool),
		    aiModelConfigs: await loadAiModelConfigs(pool),
		    problems: await loadProblems(pool),
		    memos: await loadMemos(pool),
	    competitors: await loadCompetitors(pool),
	    caseStudies: await loadCaseStudies(pool),
		    async persist() {
      await persistAll(pool, store);
    }
  };

  if (!store.users.length) {
    store.users.push(...users);
    store.customers.push(...customers);
    store.todos.push(...todos);
    store.deals.push(...deals);
    store.reminders.push(...reminders);
    store.knowledgeAssets.push(...knowledgeAssets);
    store.exams.push(...exams);
    store.examQuestions.push(...examQuestions);
    store.examAttempts.push(...examAttempts);
	    store.importExportJobs.push(...importExportJobs);
	    store.wecomMessages.push(...wecomMessages);
	    store.ocrJobs.push(...ocrJobs);
	    store.websiteOpportunities.push(...websiteOpportunities);
	    store.aiModelConfigs.push(...aiModelConfigs);
		    store.problems.push(...problems);
    store.memos.push(...memos);
    store.competitors.push(...competitors);
    store.caseStudies.push(...caseStudies);
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
  if (!store.examQuestions.length) {
    store.examQuestions.push(...examQuestions);
    await store.persist();
  }
  if (!store.examAttempts.length) {
    store.examAttempts.push(...examAttempts);
    await store.persist();
  }
  const missingSeedUsers = users.filter((seedUser) => !store.users.some((user) => user.id === seedUser.id || user.email === seedUser.email));
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query("ALTER TABLE users MODIFY role VARCHAR(20) NOT NULL");
  await pool.query("ALTER TABLE users MODIFY status VARCHAR(20) NOT NULL DEFAULT 'active'");
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS deals (
    id VARCHAR(64) PRIMARY KEY,
    customer_id VARCHAR(64) NOT NULL,
    title VARCHAR(200) NOT NULL,
    stage VARCHAR(40) NOT NULL,
    amount DECIMAL(14,2) DEFAULT 0,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    next_action VARCHAR(200),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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
	    INDEX idx_todos_owner_history(owner_id, history_at)
	  )`);
  await ensureColumn(pool, "todos", "status", "VARCHAR(24) DEFAULT 'pending'");
  await ensureColumn(pool, "todos", "pin_state", "VARCHAR(20) DEFAULT ''");
  await ensureColumn(pool, "todos", "sort_order", "INT DEFAULT 0");
  await ensureColumn(pool, "todos", "created_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  await ensureColumn(pool, "todos", "history_at", "TIMESTAMP NULL");
  await pool.query(`CREATE TABLE IF NOT EXISTS reminders (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    rule_text VARCHAR(255),
    due_at VARCHAR(100),
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    channel VARCHAR(40),
    status VARCHAR(40)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS knowledge_assets (
    id VARCHAR(64) PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    category VARCHAR(100),
    status VARCHAR(40),
    owner_id VARCHAR(64),
    version VARCHAR(40),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
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
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await ensureColumn(pool, "exams", "duration_minutes", "INT DEFAULT 20");
  await ensureColumn(pool, "exams", "pass_score", "INT DEFAULT 80");
  await ensureColumn(pool, "exams", "target_role", "VARCHAR(40) DEFAULT 'sales'");
  await ensureColumn(pool, "exams", "updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
  await pool.query(`CREATE TABLE IF NOT EXISTS exam_questions (
    id VARCHAR(64) PRIMARY KEY,
    exam_id VARCHAR(64) NOT NULL,
    category VARCHAR(100),
    stem TEXT NOT NULL,
    options_json JSON NOT NULL,
    answer_index INT NOT NULL,
    answer_indexes_json JSON,
    question_type VARCHAR(20) DEFAULT 'single',
    explanation TEXT,
    difficulty VARCHAR(20),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_exam_questions_exam(exam_id)
  )`);
  await ensureColumn(pool, "exam_questions", "answer_indexes_json", "JSON");
  await ensureColumn(pool, "exam_questions", "question_type", "VARCHAR(20) DEFAULT 'single'");
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
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
    parse_mode VARCHAR(20) DEFAULT 'rule',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_website_opps_owner(owner_id),
    INDEX idx_website_opps_team(team_id)
  )`);
  await ensureColumn(pool, "website_opportunities", "parse_mode", "VARCHAR(20) DEFAULT 'rule'");
  await pool.query(`CREATE TABLE IF NOT EXISTS ai_model_configs (
    id VARCHAR(64) PRIMARY KEY,
    provider VARCHAR(40) NOT NULL DEFAULT 'openai-compatible',
    name VARCHAR(120) NOT NULL,
    base_url VARCHAR(255) NOT NULL,
    model VARCHAR(120) NOT NULL,
    api_key TEXT,
    enabled BOOLEAN DEFAULT FALSE,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_ai_model_owner(owner_id)
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
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    pinned BOOLEAN DEFAULT FALSE,
    archived BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_memos_owner(owner_id),
    INDEX idx_memos_team(team_id)
  )`);
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

async function loadUsers(pool: mysql.Pool): Promise<User[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM users")).map((row) => ({
    id: row.id, name: row.name, email: row.email, password: row.password_hash, role: row.role, teamId: row.team_id, avatar: row.avatar, status: row.status
  }));
}

async function loadCustomers(pool: mysql.Pool): Promise<Customer[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM customers ORDER BY created_at DESC")).map((row) => ({
    id: row.id, company: row.company, country: row.country, contact: row.contact, ownerId: row.owner_id, teamId: row.team_id, stage: row.stage, amount: Number(row.amount), health: Number(row.health), nextReminder: row.next_reminder, wecomBound: Boolean(row.wecom_bound)
  }));
}

async function loadTodos(pool: mysql.Pool): Promise<Todo[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM todos ORDER BY done ASC, created_at DESC")).map((row) => ({
    id: row.id, title: row.title, type: row.type, priority: row.priority, status: row.status || "pending", pinState: row.pin_state || "", sortOrder: Number(row.sort_order || 0), dueAt: row.due_at, ownerId: row.owner_id, teamId: row.team_id, related: row.related, done: Boolean(row.done), impactAmount: row.impact_amount == null ? undefined : Number(row.impact_amount), createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at, historyAt: row.history_at instanceof Date ? row.history_at.toISOString() : row.history_at || undefined
  }));
}

async function loadDeals(pool: mysql.Pool): Promise<Deal[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM deals")).map((row) => ({
    id: row.id, customerId: row.customer_id, title: row.title, stage: row.stage, amount: Number(row.amount), ownerId: row.owner_id, teamId: row.team_id, nextAction: row.next_action
  }));
}

async function loadReminders(pool: mysql.Pool): Promise<Reminder[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM reminders")).map((row) => ({
    id: row.id, title: row.title, rule: row.rule_text, dueAt: row.due_at, ownerId: row.owner_id, teamId: row.team_id, channel: row.channel, status: row.status
  }));
}

async function loadKnowledgeAssets(pool: mysql.Pool): Promise<KnowledgeAsset[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM knowledge_assets ORDER BY created_at DESC")).map((row) => ({
    id: row.id, title: row.title, category: row.category, status: row.status, ownerId: row.owner_id, version: row.version
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
    explanation: row.explanation || "",
    difficulty: row.difficulty || "medium",
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
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

async function loadWecomMessages(pool: mysql.Pool): Promise<WecomMessage[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM wecom_messages")).map((row) => ({
    id: row.id, customerId: row.customer_id, summary: row.summary, ownerId: row.owner_id, teamId: row.team_id, status: row.status
  }));
}

async function loadOcrJobs(pool: mysql.Pool): Promise<OcrJob[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM ocr_jobs")).map((row) => ({
    id: row.id, status: row.status, confidence: Number(row.confidence), fields: typeof row.fields_json === "string" ? JSON.parse(row.fields_json) : row.fields_json
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
    parseMode: row.parse_mode || "rule",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  }));
}

async function loadAiModelConfigs(pool: mysql.Pool): Promise<AiModelConfig[]> {
  return (await rows<Record<string, any>>(pool, "SELECT * FROM ai_model_configs ORDER BY updated_at DESC")).map((row) => ({
    id: row.id,
    provider: row.provider || "openai-compatible",
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    apiKey: row.api_key || "",
    enabled: Boolean(row.enabled),
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
    ownerId: row.owner_id,
    teamId: row.team_id,
    pinned: Boolean(row.pinned),
    archived: Boolean(row.archived),
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

async function persistAll(pool: mysql.Pool, store: CrmStore) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await replaceRows(connection, "users", store.users, (item) => [item.id, item.name, item.email, item.password, item.role, item.teamId, item.avatar, item.status], "(id,name,email,password_hash,role,team_id,avatar,status)");
    await replaceRows(connection, "customers", store.customers, (item) => [item.id, item.company, item.country, item.contact, item.ownerId, item.teamId, item.stage, item.amount, item.health, item.nextReminder, item.wecomBound], "(id,company,country,contact,owner_id,team_id,stage,amount,health,next_reminder,wecom_bound)");
    await replaceRows(connection, "deals", store.deals, (item) => [item.id, item.customerId, item.title, item.stage, item.amount, item.ownerId, item.teamId, item.nextAction], "(id,customer_id,title,stage,amount,owner_id,team_id,next_action)");
    await replaceRows(connection, "todos", (store.todos as Todo[]), (item) => [item.id, item.title, item.type, item.priority, item.dueAt, item.ownerId, item.teamId, item.related, item.done, item.status || "pending", item.pinState || "", item.sortOrder || 0, item.impactAmount ?? null, mysqlDate(item.createdAt), item.historyAt ? mysqlDate(item.historyAt) : null], "(id,title,type,priority,due_at,owner_id,team_id,related,done,status,pin_state,sort_order,impact_amount,created_at,history_at)");
    await replaceRows(connection, "reminders", store.reminders, (item) => [item.id, item.title, item.rule, item.dueAt, item.ownerId, item.teamId, item.channel, item.status], "(id,title,rule_text,due_at,owner_id,team_id,channel,status)");
    await replaceRows(connection, "knowledge_assets", store.knowledgeAssets, (item) => [item.id, item.title, item.category, item.status, item.ownerId, item.version], "(id,title,category,status,owner_id,version)");
    await replaceRows(connection, "exams", store.exams, (item) => [item.id, item.title, item.category, item.status, item.passRate, item.questionCount, item.durationMinutes || 20, item.passScore || 80, item.targetRole || "sales", mysqlDate(item.updatedAt)], "(id,title,category,status,pass_rate,question_count,duration_minutes,pass_score,target_role,updated_at)");
    await replaceRows(connection, "exam_questions", store.examQuestions, (item) => [item.id, item.examId, item.category, item.stem, JSON.stringify(item.options), item.answerIndex, JSON.stringify(item.answerIndexes?.length ? item.answerIndexes : [item.answerIndex]), item.questionType || ((item.answerIndexes?.length || 0) > 1 ? "multiple" : "single"), item.explanation, item.difficulty, mysqlDate(item.updatedAt)], "(id,exam_id,category,stem,options_json,answer_index,answer_indexes_json,question_type,explanation,difficulty,updated_at)");
    await replaceRows(connection, "exam_attempts", store.examAttempts, (item) => [item.id, item.examId, item.userId, item.score, item.passed, JSON.stringify(item.answers), item.correctCount, item.totalQuestions, mysqlDate(item.submittedAt)], "(id,exam_id,user_id,score,passed,answers_json,correct_count,total_questions,submitted_at)");
    await replaceRows(connection, "import_export_jobs", store.importExportJobs, (item) => [item.id, item.name, item.type, item.rows, item.status, item.operatorId, item.createdAt], "(id,name,type,rows_count,status,operator_id,created_at)");
	    await replaceRows(connection, "wecom_messages", store.wecomMessages, (item) => [item.id, item.customerId, item.summary, item.ownerId, item.teamId, item.status], "(id,customer_id,summary,owner_id,team_id,status)");
	    await replaceRows(connection, "ocr_jobs", store.ocrJobs, (item) => [item.id, item.status, item.confidence, JSON.stringify(item.fields), null], "(id,status,confidence,fields_json,created_by)");
	    await replaceRows(connection, "website_opportunities", store.websiteOpportunities, (item) => [item.id, item.company, item.business, item.country, item.website, item.contact, item.contactInfo, item.description, item.ownerId, item.teamId, item.status, item.customerId || null, item.dealId || null, item.parseMode || "rule", mysqlDate(item.createdAt)], "(id,company,business,country,website,contact,contact_info,description,owner_id,team_id,status,customer_id,deal_id,parse_mode,created_at)");
	    await replaceRows(connection, "ai_model_configs", store.aiModelConfigs, (item) => [item.id, item.provider, item.name, item.baseUrl, item.model, item.apiKey, item.enabled, item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,provider,name,base_url,model,api_key,enabled,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "problems", store.problems, (item) => [item.id, item.title, item.category, item.severity, item.status, item.ownerId, item.teamId, item.relatedCustomer, item.rootCause, item.solution, item.nextAction, item.dueAt, mysqlDate(item.createdAt)], "(id,title,category,severity,status,owner_id,team_id,related_customer,root_cause,solution,next_action,due_at,created_at)");
	    await replaceRows(connection, "memos", store.memos, (item) => [item.id, item.title, item.content, item.category, item.tags, item.ownerId, item.teamId, item.pinned, item.archived, mysqlDate(item.updatedAt)], "(id,title,content,category,tags,owner_id,team_id,pinned,archived,updated_at)");
	    await replaceRows(connection, "competitors", store.competitors, (item) => [item.id, item.company, item.country, item.segment, item.threatLevel, item.website, item.strengths, item.weaknesses, item.competingProducts, item.ourStrategy, item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,company,country,segment,threat_level,website,strengths,weaknesses,competing_products,our_strategy,owner_id,team_id,updated_at)");
	    await replaceRows(connection, "case_studies", store.caseStudies, (item) => [item.id, item.title, item.customer, item.country, item.product, item.industry, item.result, item.story, item.reusablePoints, item.status, item.ownerId, item.teamId, mysqlDate(item.updatedAt)], "(id,title,customer,country,product,industry,result_text,story,reusable_points,status,owner_id,team_id,updated_at)");
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
