import { randomUUID } from "node:crypto";
import type { Pool } from "mysql2/promise";

// ---------------------------------------------------------------------------
// 供应商管理（仿「客户管理」）：独立的 suppliers 表 + 独立仓库。
//
// 为什么不进 store / persistAll：
//   persistAll 是「整表 DELETE + 全量 INSERT」的 92 张表重写体系（单次约 400ms 且随数据量线性增长），
//   新模块背上去只会拖慢每一次写请求。这里沿用 sender-mailbox / integration 的既有做法：
//   自己建表、自己写 SQL，只把 ensure + repository 挂进 mysql-store 的启动流程。
//
// 与客户的口径差异（有意为之，不是漏做）：
//   客户是「谁名下谁负责」的个人资产（ownerId + self/organization 两种可见范围）；
//   供应商是公司共享的供应链资产 —— 权限 scopeModes 刻意不含 self，
//   业务员的 supplier.read 落在 org_unit（本部门/本团队），全公司共用一份供应商库，
//   否则同一个工厂会被每个业务员各录一遍。
// ---------------------------------------------------------------------------

export type SupplierStatus = "active" | "evaluating" | "paused";
export type SupplierGrade = "A" | "B" | "C" | "D";

export const SUPPLIER_STATUSES: SupplierStatus[] = ["active", "evaluating", "paused"];
export const SUPPLIER_GRADES: SupplierGrade[] = ["A", "B", "C", "D"];

export interface Supplier {
  id: string;
  ownerId: string;
  teamId: string;
  /**
   * 供应商编码：对外可引用的稳定编号（SUP-0001 形式，团队内唯一）。
   * 新建留空自动顺延生成；也允许人工改成自己的编码体系（仍要求团队内唯一）。
   */
  code: string;
  /** 工作台/列表用的短名称 */
  company: string;
  /** 单据上的法定全名（报价、合同、报关资料优先用这个） */
  companyFullName: string;
  country: string;
  /** 供应品类：例如「称重传感器 / 仪表」 */
  category: string;
  contact: string;
  phone: string;
  email: string;
  /** 微信 / WhatsApp 统一一个字段，和「同行管理」口径一致 */
  wechat: string;
  website: string;
  address: string;
  paymentTerm: string;
  /** 交货周期（天）；0 = 未登记 */
  leadTimeDays: number;
  grade: SupplierGrade;
  status: SupplierStatus;
  source: string;
  remark: string;
  createdAt: string;
  updatedAt: string;
}

export interface SupplierInput {
  code?: string;
  company?: string;
  companyFullName?: string;
  country?: string;
  category?: string;
  contact?: string;
  phone?: string;
  email?: string;
  wechat?: string;
  website?: string;
  address?: string;
  paymentTerm?: string;
  leadTimeDays?: number;
  grade?: SupplierGrade;
  status?: SupplierStatus;
  source?: string;
  remark?: string;
}

function text(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

export function normalizeSupplierGrade(value: unknown): SupplierGrade {
  const grade = String(value ?? "").trim().toUpperCase();
  return (SUPPLIER_GRADES as string[]).includes(grade) ? grade as SupplierGrade : "C";
}

export function normalizeSupplierStatus(value: unknown): SupplierStatus {
  const status = String(value ?? "").trim().toLowerCase();
  return (SUPPLIER_STATUSES as string[]).includes(status) ? status as SupplierStatus : "active";
}

/** 交货周期：负数/NaN 一律归 0（0 = 未登记），上限 3650 天挡住手滑多打几位 */
export function normalizeLeadTimeDays(value: unknown) {
  const days = Math.floor(Number(value));
  if (!Number.isFinite(days) || days <= 0) return 0;
  return Math.min(days, 3650);
}

// ---------------------------------------------------------------------------
// 供应商编码
//
// 口径：
//  - 自动码是 `SUP-0001`，团队内顺延（不是全局顺延，否则每个团队都会从别人的号接着数）；
//  - 人工码只允许 ASCII 字母、数字、点、下划线、连字符，统一转大写；
//  - 空串 = 「没填」，新建时自动生成、编辑时保留原值 —— 绝不允许把编码改成空。
// ---------------------------------------------------------------------------

/** 编码清洗：去空格 / 转大写 / 丢掉非法字符 / 截 40 位。返回空串表示「没填」 */
export function normalizeSupplierCode(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/gu, "")
    .slice(0, 40);
}

/** 自动码序号：只认 SUP-数字，人工码（ACME-01）不参与顺延 */
export function supplierCodeSequence(code: string) {
  const matched = /^SUP-(\d{1,9})$/u.exec(String(code || "").trim().toUpperCase());
  return matched ? Number(matched[1]) : 0;
}

export function supplierCodeFromSequence(sequence: number) {
  const safe = Math.max(1, Math.floor(Number(sequence) || 1));
  return `SUP-${String(safe).padStart(4, "0")}`;
}

/** 在已有编码集合里取下一个（纯函数：单测直接喂数组） */
export function nextSupplierCode(codes: string[]) {
  const max = codes.reduce((acc, code) => Math.max(acc, supplierCodeSequence(code)), 0);
  return supplierCodeFromSequence(max + 1);
}

/** 编码冲突：路由层据此回 409 SUPPLIER_CODE_DUPLICATE */
export class SupplierCodeConflictError extends Error {
  readonly errorCode = "SUPPLIER_CODE_DUPLICATE";
  constructor(readonly supplierCode: string) {
    super(`供应商编码「${supplierCode}」已被占用，请换一个`);
    this.name = "SupplierCodeConflictError";
  }
}

/** 只认编码唯一索引的重复键，别把其它唯一约束的报错当成撞号 */
function isSupplierCodeDuplicate(error: unknown) {
  const code = (error as { code?: string }).code;
  const message = String((error as { message?: string }).message || "");
  return code === "ER_DUP_ENTRY" && message.includes("uk_suppliers_code");
}

/**
 * 合并输入（新建与编辑共用）：编辑时未提交的字段保留原值。
 * 抽成纯函数是为了能在 `npm test`（无数据库）里直接断言，
 * 仓库类只负责把结果写进 SQL。
 */
export function normalizeSupplierInput(input: SupplierInput, existing?: Supplier): Required<SupplierInput> {
  const base: Required<SupplierInput> = {
    code: existing?.code || "",
    company: existing?.company || "",
    companyFullName: existing?.companyFullName || "",
    country: existing?.country || "",
    category: existing?.category || "",
    contact: existing?.contact || "",
    phone: existing?.phone || "",
    email: existing?.email || "",
    wechat: existing?.wechat || "",
    website: existing?.website || "",
    address: existing?.address || "",
    paymentTerm: existing?.paymentTerm || "",
    leadTimeDays: existing?.leadTimeDays ?? 0,
    grade: existing?.grade || "C",
    status: existing?.status || "active",
    source: existing?.source || "",
    remark: existing?.remark || ""
  };
  const company = input.company !== undefined ? text(input.company, 200) : base.company;
  const companyFullName = input.companyFullName !== undefined
    ? text(input.companyFullName, 200)
    : base.companyFullName;
  return {
    // 空串不覆盖原编码：新建时留给仓库去自动生成，编辑时保持原值
    code: input.code !== undefined ? (normalizeSupplierCode(input.code) || base.code) : base.code,
    company,
    // 全名留空时回落简称：单据抬头不能是空白（与客户 companyFullName / billingName 的兜底一致）
    companyFullName: companyFullName || company,
    country: input.country !== undefined ? text(input.country, 80) : base.country,
    category: input.category !== undefined ? text(input.category, 300) : base.category,
    contact: input.contact !== undefined ? text(input.contact, 120) : base.contact,
    phone: input.phone !== undefined ? text(input.phone, 80) : base.phone,
    email: input.email !== undefined ? text(input.email, 160) : base.email,
    wechat: input.wechat !== undefined ? text(input.wechat, 80) : base.wechat,
    website: input.website !== undefined ? text(input.website, 255) : base.website,
    address: input.address !== undefined ? text(input.address, 500) : base.address,
    paymentTerm: input.paymentTerm !== undefined ? text(input.paymentTerm, 200) : base.paymentTerm,
    leadTimeDays: input.leadTimeDays !== undefined ? normalizeLeadTimeDays(input.leadTimeDays) : base.leadTimeDays,
    grade: input.grade !== undefined ? normalizeSupplierGrade(input.grade) : base.grade,
    status: input.status !== undefined ? normalizeSupplierStatus(input.status) : base.status,
    source: input.source !== undefined ? text(input.source, 120) : base.source,
    remark: input.remark !== undefined ? text(input.remark, 2000) : base.remark
  };
}

function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

/** 行 → 领域对象（纯函数，单测直接喂假行） */
export function supplierFromRow(row: Record<string, unknown>): Supplier {
  return {
    id: String(row.id ?? ""),
    ownerId: String(row.owner_id ?? ""),
    teamId: String(row.team_id ?? ""),
    code: String(row.supplier_code ?? ""),
    company: String(row.company ?? ""),
    companyFullName: String(row.company_full_name ?? ""),
    country: String(row.country ?? ""),
    category: String(row.category ?? ""),
    contact: String(row.contact ?? ""),
    phone: String(row.phone ?? ""),
    email: String(row.email ?? ""),
    wechat: String(row.wechat ?? ""),
    website: String(row.website ?? ""),
    address: String(row.address ?? ""),
    paymentTerm: String(row.payment_term ?? ""),
    leadTimeDays: Number(row.lead_time_days ?? 0) || 0,
    grade: normalizeSupplierGrade(row.grade),
    status: normalizeSupplierStatus(row.status),
    source: String(row.source ?? ""),
    remark: String(row.remark ?? ""),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

/** 公司名归一：全半角/大小写/多余空格不同视为同一家（重复拦截用） */
export function supplierDuplicateKey(company: string, country: string) {
  return `${String(company || "").trim().toLowerCase().replace(/\s+/gu, "")}|${String(country || "").trim().toLowerCase()}`;
}

export async function ensureSupplierSchema(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS suppliers (
    id VARCHAR(80) PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    supplier_code VARCHAR(40) NOT NULL DEFAULT '',
    company VARCHAR(200) NOT NULL,
    company_full_name VARCHAR(200) NOT NULL DEFAULT '',
    country VARCHAR(80) NOT NULL DEFAULT '',
    category VARCHAR(300) NOT NULL DEFAULT '',
    contact VARCHAR(120) NOT NULL DEFAULT '',
    phone VARCHAR(80) NOT NULL DEFAULT '',
    email VARCHAR(160) NOT NULL DEFAULT '',
    wechat VARCHAR(80) NOT NULL DEFAULT '',
    website VARCHAR(255) NOT NULL DEFAULT '',
    address VARCHAR(500) NOT NULL DEFAULT '',
    payment_term VARCHAR(200) NOT NULL DEFAULT '',
    lead_time_days INT NOT NULL DEFAULT 0,
    grade VARCHAR(2) NOT NULL DEFAULT 'C',
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    source VARCHAR(120) NOT NULL DEFAULT '',
    remark TEXT,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_suppliers_code(team_id, supplier_code),
    INDEX idx_suppliers_team(team_id, updated_at),
    INDEX idx_suppliers_owner(owner_id),
    INDEX idx_suppliers_company(team_id, company)
  )`);
  // 老表补列 / 回填 / 补唯一索引：CREATE TABLE IF NOT EXISTS 对已存在的表是空操作，
  // 所以升级路径必须自己走一遍，否则老库永远没有 supplier_code。
  if (!(await schemaHasColumn(pool, "suppliers", "supplier_code"))) {
    await pool.query(`ALTER TABLE suppliers ADD COLUMN supplier_code VARCHAR(40) NOT NULL DEFAULT '' AFTER team_id`);
  }
  await backfillSupplierCodes(pool);
  if (!(await schemaHasIndex(pool, "suppliers", "uk_suppliers_code"))) {
    try {
      await pool.query(`ALTER TABLE suppliers ADD UNIQUE KEY uk_suppliers_code (team_id, supplier_code)`);
    } catch (error) {
      // 历史人工码撞号时索引建不起来；不阻断启动（写入侧照样拦截重复），等人工清理后再补
      console.warn("[suppliers] 供应商编码唯一索引创建失败：", (error as Error).message);
    }
  }
}

async function schemaHasColumn(pool: Pool, table: string, column: string) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return Boolean((rows as unknown[]).length);
}

async function schemaHasIndex(pool: Pool, table: string, index: string) {
  const [rows] = await pool.query(
    `SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [table, index]
  );
  return Boolean((rows as unknown[]).length);
}

/** 给历史空编码补号：按团队各自从 0001 起顺延，整段放在一个事务里锁住待补行 */
async function backfillSupplierCodes(pool: Pool) {
  const [pending] = await pool.query(`SELECT id FROM suppliers WHERE supplier_code = '' LIMIT 1`);
  if (!(pending as unknown[]).length) return;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [locked] = await connection.query(
      `SELECT id, team_id FROM suppliers WHERE supplier_code = '' ORDER BY team_id, created_at, id FOR UPDATE`
    );
    const rows = locked as Array<{ id: string; team_id: string }>;
    if (!rows.length) {
      await connection.commit();
      return;
    }
    const teams = [...new Set(rows.map((row) => row.team_id))];
    const [existing] = await connection.query(
      `SELECT team_id, supplier_code FROM suppliers WHERE team_id IN (?) AND supplier_code <> ''`,
      [teams]
    );
    const used = new Map<string, string[]>();
    for (const row of existing as Array<{ team_id: string; supplier_code: string }>) {
      const list = used.get(row.team_id) || [];
      list.push(row.supplier_code);
      used.set(row.team_id, list);
    }
    for (const row of rows) {
      const list = used.get(row.team_id) || [];
      const code = nextSupplierCode(list);
      list.push(code);
      used.set(row.team_id, list);
      await connection.execute(`UPDATE suppliers SET supplier_code = ? WHERE id = ?`, [code, row.id]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

const COLUMNS = `id, owner_id, team_id, supplier_code, company, company_full_name, country, category, contact, phone, email,
  wechat, website, address, payment_term, lead_time_days, grade, status, source, remark, created_at, updated_at`;

class MysqlSupplierRepository {
  constructor(private readonly pool: Pool) {}

  async list(teamId: string, ownerIds?: string[]): Promise<Supplier[]> {
    // ownerIds 为 undefined 表示不限（团队全量）；空数组时返回空，调用方据此短路
    if (ownerIds && !ownerIds.length) return [];
    const [rows] = ownerIds
      ? await this.pool.query(
        `SELECT ${COLUMNS} FROM suppliers WHERE team_id = ? AND owner_id IN (?) ORDER BY updated_at DESC`,
        [teamId, ownerIds]
      )
      : await this.pool.query(
        `SELECT ${COLUMNS} FROM suppliers WHERE team_id = ? ORDER BY updated_at DESC`,
        [teamId]
      );
    return (rows as Array<Record<string, unknown>>).map(supplierFromRow);
  }

  async find(teamId: string, id: string): Promise<Supplier | null> {
    const [rows] = await this.pool.query(
      `SELECT ${COLUMNS} FROM suppliers WHERE team_id = ? AND id = ? LIMIT 1`,
      [teamId, id]
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? supplierFromRow(row) : null;
  }

  /**
   * 只按 id 查（不限定团队）：文件引用的归属解析拿不到团队上下文，
   * 但必须能认出「这份文件挂在哪个供应商名下」。仅供服务端内部使用。
   */
  async findAnyById(id: string): Promise<Supplier | null> {
    const [rows] = await this.pool.query(
      `SELECT ${COLUMNS} FROM suppliers WHERE id = ? LIMIT 1`,
      [id]
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? supplierFromRow(row) : null;
  }

  /** 团队内下一个自动编码（读全量只为了取 SUP- 最大序号，供应商量级撑得住） */
  private async nextCode(teamId: string) {
    const [rows] = await this.pool.query(
      `SELECT supplier_code FROM suppliers WHERE team_id = ?`,
      [teamId]
    );
    return nextSupplierCode((rows as Array<{ supplier_code: string }>).map((row) => row.supplier_code));
  }

  private async codeTaken(teamId: string, code: string, excludeId = "") {
    const [rows] = await this.pool.query(
      `SELECT id FROM suppliers WHERE team_id = ? AND supplier_code = ? AND id <> ? LIMIT 1`,
      [teamId, code, excludeId]
    );
    return (rows as unknown[]).length > 0;
  }

  private insertRow(record: Supplier, now: Date) {
    return this.pool.execute(
      `INSERT INTO suppliers (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id, record.ownerId, record.teamId, record.code, record.company, record.companyFullName,
        record.country, record.category, record.contact, record.phone, record.email, record.wechat,
        record.website, record.address, record.paymentTerm, record.leadTimeDays, record.grade,
        record.status, record.source, record.remark, now, now
      ]
    );
  }

  async create(ownerId: string, teamId: string, input: SupplierInput): Promise<Supplier> {
    const now = new Date();
    const normalized = normalizeSupplierInput(input);
    const build = (code: string): Supplier => ({
      id: `sup_${randomUUID()}`,
      ownerId,
      teamId,
      ...normalized,
      code,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    });
    const manualCode = normalized.code;
    let record = build(manualCode || await this.nextCode(teamId));
    try {
      await this.insertRow(record, now);
    } catch (error) {
      if (!isSupplierCodeDuplicate(error)) throw error;
      if (manualCode) throw new SupplierCodeConflictError(manualCode);
      // 自动码并发撞号：顺延一个再试一次（仅此一次，避免无上限自旋）
      record = build(await this.nextCode(teamId));
      await this.insertRow(record, now);
    }
    return record;
  }

  async update(teamId: string, id: string, input: SupplierInput): Promise<Supplier | null> {
    const existing = await this.find(teamId, id);
    if (!existing) return null;
    const next = { ...existing, ...normalizeSupplierInput(input, existing), updatedAt: new Date().toISOString() };
    if (next.code !== existing.code && await this.codeTaken(teamId, next.code, id)) {
      throw new SupplierCodeConflictError(next.code);
    }
    await this.pool.execute(
      `UPDATE suppliers SET supplier_code = ?, company = ?, company_full_name = ?, country = ?, category = ?, contact = ?, phone = ?,
        email = ?, wechat = ?, website = ?, address = ?, payment_term = ?, lead_time_days = ?, grade = ?,
        status = ?, source = ?, remark = ?, updated_at = ?
       WHERE team_id = ? AND id = ?`,
      [
        next.code, next.company, next.companyFullName, next.country, next.category, next.contact, next.phone,
        next.email, next.wechat, next.website, next.address, next.paymentTerm, next.leadTimeDays,
        next.grade, next.status, next.source, next.remark, new Date(), teamId, id
      ]
    );
    return next;
  }

  /** 批量删除只删团队内、且属于当前账号可见范围的 id */
  async removeMany(teamId: string, ids: string[], ownerIds?: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const unique = [...new Set(ids)];
    if (ownerIds && !ownerIds.length) return [];
    const [rows] = ownerIds
      ? await this.pool.query(
        `SELECT id FROM suppliers WHERE team_id = ? AND id IN (?) AND owner_id IN (?)`,
        [teamId, unique, ownerIds]
      )
      : await this.pool.query(`SELECT id FROM suppliers WHERE team_id = ? AND id IN (?)`, [teamId, unique]);
    const deletable = (rows as Array<{ id: string }>).map((row) => row.id);
    if (!deletable.length) return [];
    await this.pool.query(`DELETE FROM suppliers WHERE team_id = ? AND id IN (?)`, [teamId, deletable]);
    return deletable;
  }
}

let supplierRepository: MysqlSupplierRepository | null = null;

export function setSupplierRepository(repository: MysqlSupplierRepository | null) {
  supplierRepository = repository;
}

export function getSupplierRepository() {
  return supplierRepository;
}

export function createMysqlSupplierRepository(pool: Pool) {
  return new MysqlSupplierRepository(pool);
}
