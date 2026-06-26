import mysql from "mysql2/promise";
import { customers, deals, exams, importExportJobs, knowledgeAssets, ocrJobs, reminders, todos, users, wecomMessages } from "./data.js";
import type { CrmStore } from "./store.js";
import type { Customer, Deal, Exam, ImportExportJob, KnowledgeAsset, OcrJob, Reminder, Todo, User, WecomMessage } from "./types.js";

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
    importExportJobs: await loadImportExportJobs(pool),
    wecomMessages: await loadWecomMessages(pool),
    ocrJobs: await loadOcrJobs(pool),
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
    store.importExportJobs.push(...importExportJobs);
    store.wecomMessages.push(...wecomMessages);
    store.ocrJobs.push(...ocrJobs);
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
    impact_amount DECIMAL(14,2)
  )`);
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
    question_count INT DEFAULT 0
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS exam_attempts (
    id VARCHAR(64) PRIMARY KEY,
    exam_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    score DECIMAL(5,2),
    passed BOOLEAN,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ocr_jobs (
    id VARCHAR(64) PRIMARY KEY,
    status VARCHAR(40),
    confidence DECIMAL(5,2),
    fields_json JSON,
    created_by VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
}

async function rows<T>(pool: mysql.Pool, sql: string): Promise<T[]> {
  const [result] = await pool.query(sql);
  return result as T[];
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
  return (await rows<Record<string, any>>(pool, "SELECT * FROM todos")).map((row) => ({
    id: row.id, title: row.title, type: row.type, priority: row.priority, dueAt: row.due_at, ownerId: row.owner_id, teamId: row.team_id, related: row.related, done: Boolean(row.done), impactAmount: row.impact_amount == null ? undefined : Number(row.impact_amount)
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
  return (await rows<Record<string, any>>(pool, "SELECT * FROM exams")).map((row) => ({
    id: row.id, title: row.title, category: row.category, status: row.status, passRate: Number(row.pass_rate), questionCount: Number(row.question_count)
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

async function persistAll(pool: mysql.Pool, store: CrmStore) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await replaceRows(connection, "users", store.users, (item) => [item.id, item.name, item.email, item.password, item.role, item.teamId, item.avatar, item.status], "(id,name,email,password_hash,role,team_id,avatar,status)");
    await replaceRows(connection, "customers", store.customers, (item) => [item.id, item.company, item.country, item.contact, item.ownerId, item.teamId, item.stage, item.amount, item.health, item.nextReminder, item.wecomBound], "(id,company,country,contact,owner_id,team_id,stage,amount,health,next_reminder,wecom_bound)");
    await replaceRows(connection, "deals", store.deals, (item) => [item.id, item.customerId, item.title, item.stage, item.amount, item.ownerId, item.teamId, item.nextAction], "(id,customer_id,title,stage,amount,owner_id,team_id,next_action)");
    await replaceRows(connection, "todos", store.todos, (item) => [item.id, item.title, item.type, item.priority, item.dueAt, item.ownerId, item.teamId, item.related, item.done, item.impactAmount ?? null], "(id,title,type,priority,due_at,owner_id,team_id,related,done,impact_amount)");
    await replaceRows(connection, "reminders", store.reminders, (item) => [item.id, item.title, item.rule, item.dueAt, item.ownerId, item.teamId, item.channel, item.status], "(id,title,rule_text,due_at,owner_id,team_id,channel,status)");
    await replaceRows(connection, "knowledge_assets", store.knowledgeAssets, (item) => [item.id, item.title, item.category, item.status, item.ownerId, item.version], "(id,title,category,status,owner_id,version)");
    await replaceRows(connection, "exams", store.exams, (item) => [item.id, item.title, item.category, item.status, item.passRate, item.questionCount], "(id,title,category,status,pass_rate,question_count)");
    await replaceRows(connection, "import_export_jobs", store.importExportJobs, (item) => [item.id, item.name, item.type, item.rows, item.status, item.operatorId, item.createdAt], "(id,name,type,rows_count,status,operator_id,created_at)");
    await replaceRows(connection, "wecom_messages", store.wecomMessages, (item) => [item.id, item.customerId, item.summary, item.ownerId, item.teamId, item.status], "(id,customer_id,summary,owner_id,team_id,status)");
    await replaceRows(connection, "ocr_jobs", store.ocrJobs, (item) => [item.id, item.status, item.confidence, JSON.stringify(item.fields), null], "(id,status,confidence,fields_json,created_by)");
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
