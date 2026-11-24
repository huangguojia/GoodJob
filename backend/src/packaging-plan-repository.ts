import { randomUUID } from "node:crypto";
import type { Pool } from "mysql2/promise";

// ---------------------------------------------------------------------------
// 包装方案（packaging plans）
//
// 业务来源：外贸报价 / 形式发票 / 装箱单 / 唛头都要按「这一票货怎么装」来算件数、
// 净重毛重、外尺寸与体积。参考系统把这套东西叫作产品的「默认包装方案」，
// 每行一个包装件（包装类型 + 归属设备 + 箱内物品 + 长宽高 + 净重毛重）。
//
// 两种方案形态：
//   - general：通用方案（不绑定物料），例如「木箱 + 托盘标准出口包装」
//   - product：方案绑定某个产品/物料，引用产品的名称与型号
//
// 为什么不进 store / persistAll：persistAll 是整表 DELETE + 全量 INSERT 的 92 张表
// 重写体系（单次约 400ms 且随数据量线性增长），新模块背上去只会拖慢每一次写请求。
// 这里沿用 supplier / sender-mailbox / integration 的既有做法：自己建表、自己写 SQL，
// 只把 ensure + repository 挂进 mysql-store 的启动流程。
//
// 包装件为什么存 JSON 列而不是单独建表：它总是跟方案一起被整体读写（不存在单独查询
// 某个包装件的场景），拆表只会多一次联查和一次事务协调。与 trade_documents 的
// template_data_json 同一个口径。
// ---------------------------------------------------------------------------

export type PackagingPlanScope = "general" | "product";

export const PACKAGING_PLAN_SCOPES: PackagingPlanScope[] = ["general", "product"];

/** 单个包装件：字段口径与参考系统的 packRow 一致 */
export interface PackagingPlanItem {
  id: string;
  /** 包装类型：加固出口木箱 / 纸箱 / 托盘 */
  label: string;
  /** 箱内物品：主机框架 / Main frame（可只写中文或中英双语） */
  contents: string;
  /** 归属设备 / 货号：JW-T7 PRO #1 */
  model: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  netWeightKg: number;
  grossWeightKg: number;
}

export interface PackagingPlan {
  id: string;
  ownerId: string;
  teamId: string;
  /** 方案编码：PKG-0001 形式，团队内唯一；也允许人工改成自己的体系 */
  code: string;
  name: string;
  scope: PackagingPlanScope;
  /** 关联物料（scope=product 时才有值） */
  productId: string;
  productName: string;
  productModel: string;
  /** 一句话说明：给单据/商机下拉做副标题 */
  summary: string;
  remark: string;
  items: PackagingPlanItem[];
  createdAt: string;
  updatedAt: string;
}

export interface PackagingPlanItemInput {
  id?: string;
  label?: string;
  contents?: string;
  model?: string;
  lengthCm?: number;
  widthCm?: number;
  heightCm?: number;
  netWeightKg?: number;
  grossWeightKg?: number;
}

export interface PackagingPlanInput {
  code?: string;
  name?: string;
  scope?: PackagingPlanScope;
  productId?: string;
  productName?: string;
  productModel?: string;
  summary?: string;
  remark?: string;
  items?: PackagingPlanItemInput[];
}

function text(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function amount(value: unknown, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  // 保留 3 位：尺寸/重量手工录入常带小数，四舍五入到 3 位足够且不会在体积计算里放大误差
  return Math.round(Math.min(parsed, max) * 1000) / 1000;
}

export function normalizePackagingPlanScope(value: unknown): PackagingPlanScope {
  const scope = String(value ?? "").trim().toLowerCase();
  return (PACKAGING_PLAN_SCOPES as string[]).includes(scope) ? scope as PackagingPlanScope : "general";
}

/** 单箱体积（m³）= 长×宽×高 / 1,000,000，保留 3 位。前后端必须同口径 */
export function packagingItemVolumeCbm(item: { lengthCm?: number; widthCm?: number; heightCm?: number }) {
  const length = Number(item.lengthCm) || 0;
  const width = Number(item.widthCm) || 0;
  const height = Number(item.heightCm) || 0;
  if (length <= 0 || width <= 0 || height <= 0) return 0;
  // cm³ → m³ 是除以 1,000,000（参考件 420×220×260 = 24,024,000 cm³ = 24.024 m³）
  return Math.round((length * width * height) / 1000) / 1000;
}

/**
 * 包装件清洗 + 过滤：
 * - 全空行（没有任何文字且尺寸/重量全 0）直接丢掉 —— 编辑器永远留一行空壳
 * - 单行尺寸/重量上限：尺寸 1000cm、重量 100000kg（挡住手滑多打几位）
 * - 最多 60 行：再多就不是「包装方案」而是整柜明细了
 */
export function normalizePackagingPlanItems(value: unknown): PackagingPlanItem[] {
  const rows = Array.isArray(value) ? value as PackagingPlanItemInput[] : [];
  return rows.slice(0, 60)
    .map((row, index) => ({
      id: text(row?.id, 80) || `pkg_item_${Date.now()}_${index + 1}`,
      label: text(row?.label, 120),
      contents: text(row?.contents, 300),
      model: text(row?.model, 120),
      lengthCm: amount(row?.lengthCm, 1000),
      widthCm: amount(row?.widthCm, 1000),
      heightCm: amount(row?.heightCm, 1000),
      netWeightKg: amount(row?.netWeightKg, 100000),
      grossWeightKg: amount(row?.grossWeightKg, 100000)
    }))
    .filter((row) => Boolean(row.label || row.contents || row.model)
      || row.lengthCm > 0 || row.widthCm > 0 || row.heightCm > 0
      || row.netWeightKg > 0 || row.grossWeightKg > 0);
}

/** 方案统计：单据/商机悬浮层和列表页共用这一份口径 */
export function packagingPlanStats(plan: Pick<PackagingPlan, "items">) {
  const items = plan.items || [];
  const volume = items.reduce((sum, item) => sum + packagingItemVolumeCbm(item), 0);
  return {
    packages: items.length,
    netWeightKg: Math.round(items.reduce((sum, item) => sum + (Number(item.netWeightKg) || 0), 0) * 1000) / 1000,
    grossWeightKg: Math.round(items.reduce((sum, item) => sum + (Number(item.grossWeightKg) || 0), 0) * 1000) / 1000,
    volumeCbm: Math.round(volume * 1000) / 1000
  };
}

// ---------------------------------------------------------------------------
// 方案编码：PKG-0001，团队内顺延
// ---------------------------------------------------------------------------

export function normalizePackagingPlanCode(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/gu, "")
    .slice(0, 40);
}

function packagingPlanCodeSequence(code: string) {
  const matched = /^PKG-(\d{1,9})$/u.exec(String(code || "").trim().toUpperCase());
  return matched ? Number(matched[1]) : 0;
}

export function nextPackagingPlanCode(used: string[]) {
  const max = used.reduce((current, code) => Math.max(current, packagingPlanCodeSequence(code)), 0);
  return `PKG-${String(max + 1).padStart(4, "0")}`;
}

// ---------------------------------------------------------------------------
// 表
// ---------------------------------------------------------------------------

export async function ensurePackagingPlanSchema(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS packaging_plans (
    id VARCHAR(80) PRIMARY KEY,
    owner_id VARCHAR(64) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    plan_code VARCHAR(40) NOT NULL DEFAULT '',
    name VARCHAR(200) NOT NULL,
    scope VARCHAR(20) NOT NULL DEFAULT 'general',
    product_id VARCHAR(80) NOT NULL DEFAULT '',
    product_name VARCHAR(200) NOT NULL DEFAULT '',
    product_model VARCHAR(120) NOT NULL DEFAULT '',
    summary VARCHAR(300) NOT NULL DEFAULT '',
    remark TEXT,
    items_json JSON,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_packaging_plans_code(team_id, plan_code),
    INDEX idx_packaging_plans_team(team_id, updated_at),
    INDEX idx_packaging_plans_product(team_id, product_id),
    INDEX idx_packaging_plans_name(team_id, name)
  )`);
}

// ---------------------------------------------------------------------------
// 仓库
// ---------------------------------------------------------------------------

export interface PackagingPlanRepository {
  list(teamId: string): Promise<PackagingPlan[]>;
  get(teamId: string, id: string): Promise<PackagingPlan | null>;
  create(ownerId: string, teamId: string, input: PackagingPlanInput): Promise<PackagingPlan>;
  update(teamId: string, id: string, input: PackagingPlanInput): Promise<PackagingPlan | null>;
  removeMany(teamId: string, ids: string[]): Promise<string[]>;
}

function sqlDate(value: Date) {
  // mysql2 的 DATETIME(3) 接受 Date，但内存态/接口层统一用 ISO 串；
  // 这里显式给 UTC 值，避免依赖进程时区（本项目既有坑：mysqlDate(undefined)=now）
  return value;
}

function isoDate(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  return String(value ?? "");
}

function mapRow(row: Record<string, unknown>): PackagingPlan {
  let items: PackagingPlanItem[] = [];
  const raw = row.items_json;
  if (typeof raw === "string" && raw.trim()) {
    try {
      items = normalizePackagingPlanItems(JSON.parse(raw));
    } catch {
      items = [];
    }
  } else if (raw && typeof raw === "object") {
    items = normalizePackagingPlanItems(raw);
  }
  return {
    id: String(row.id),
    ownerId: String(row.owner_id || ""),
    teamId: String(row.team_id || ""),
    code: String(row.plan_code || ""),
    name: String(row.name || ""),
    scope: normalizePackagingPlanScope(row.scope),
    productId: String(row.product_id || ""),
    productName: String(row.product_name || ""),
    productModel: String(row.product_model || ""),
    summary: String(row.summary || ""),
    remark: String(row.remark || ""),
    items,
    createdAt: isoDate(row.created_at),
    updatedAt: isoDate(row.updated_at)
  };
}

export class MysqlPackagingPlanRepository implements PackagingPlanRepository {
  constructor(private readonly pool: Pool) {}

  async list(teamId: string) {
    const [rows] = await this.pool.query(
      `SELECT * FROM packaging_plans WHERE team_id = ? ORDER BY updated_at DESC, created_at DESC`,
      [teamId]
    );
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  async get(teamId: string, id: string) {
    const [rows] = await this.pool.query(
      `SELECT * FROM packaging_plans WHERE team_id = ? AND id = ? LIMIT 1`,
      [teamId, id]
    );
    const row = (rows as Record<string, unknown>[])[0];
    return row ? mapRow(row) : null;
  }

  /** 编码自动顺延：把团队已用编码全取出来算下一个，避免并发时 MAX(plan_code) 的字符串比较陷阱 */
  private async resolveCode(teamId: string, requested: string) {
    const [rows] = await this.pool.query(
      `SELECT plan_code FROM packaging_plans WHERE team_id = ? AND plan_code <> ''`,
      [teamId]
    );
    const used = (rows as Array<{ plan_code: string }>).map((row) => row.plan_code);
    const wanted = normalizePackagingPlanCode(requested);
    if (wanted && !used.includes(wanted)) return wanted;
    if (wanted && used.includes(wanted)) {
      const error = new Error(`方案编码 ${wanted} 已被占用，请换一个`);
      (error as Error & { errorCode?: string }).errorCode = "PACKAGING_PLAN_CODE_CONFLICT";
      throw error;
    }
    return nextPackagingPlanCode(used);
  }

  async create(ownerId: string, teamId: string, input: PackagingPlanInput) {
    const now = new Date();
    const id = `pk_${now.getTime()}_${randomUUID().slice(0, 8)}`;
    const code = await this.resolveCode(teamId, input.code || "");
    const scope = normalizePackagingPlanScope(input.scope);
    const items = normalizePackagingPlanItems(input.items);
    await this.pool.query(
      `INSERT INTO packaging_plans
        (id, owner_id, team_id, plan_code, name, scope, product_id, product_name, product_model, summary, remark, items_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)`,
      [
        id, ownerId, teamId, code,
        text(input.name, 200) || "未命名包装方案",
        scope,
        scope === "product" ? text(input.productId, 80) : "",
        scope === "product" ? text(input.productName, 200) : "",
        scope === "product" ? text(input.productModel, 120) : "",
        text(input.summary, 300),
        text(input.remark, 2000),
        JSON.stringify(items),
        sqlDate(now), sqlDate(now)
      ]
    );
    return {
      id, ownerId, teamId, code, name: text(input.name, 200) || "未命名包装方案", scope,
      productId: scope === "product" ? text(input.productId, 80) : "",
      productName: scope === "product" ? text(input.productName, 200) : "",
      productModel: scope === "product" ? text(input.productModel, 120) : "",
      summary: text(input.summary, 300), remark: text(input.remark, 2000),
      items, createdAt: now.toISOString(), updatedAt: now.toISOString()
    } satisfies PackagingPlan;
  }

  async update(teamId: string, id: string, input: PackagingPlanInput) {
    const current = await this.get(teamId, id);
    if (!current) return null;
    const scope = input.scope === undefined ? current.scope : normalizePackagingPlanScope(input.scope);
    const items = input.items === undefined ? current.items : normalizePackagingPlanItems(input.items);
    const code = input.code === undefined || normalizePackagingPlanCode(input.code) === current.code
      ? current.code
      : await this.resolveCode(teamId, input.code);
    const next: PackagingPlan = {
      ...current,
      code,
      name: input.name === undefined ? current.name : (text(input.name, 200) || current.name),
      scope,
      productId: scope === "product" ? (input.productId === undefined ? current.productId : text(input.productId, 80)) : "",
      productName: scope === "product" ? (input.productName === undefined ? current.productName : text(input.productName, 200)) : "",
      productModel: scope === "product" ? (input.productModel === undefined ? current.productModel : text(input.productModel, 120)) : "",
      summary: input.summary === undefined ? current.summary : text(input.summary, 300),
      remark: input.remark === undefined ? current.remark : text(input.remark, 2000),
      items,
      updatedAt: new Date().toISOString()
    };
    await this.pool.query(
      `UPDATE packaging_plans SET
        plan_code = ?, name = ?, scope = ?, product_id = ?, product_name = ?, product_model = ?,
        summary = ?, remark = ?, items_json = CAST(? AS JSON), updated_at = ?
       WHERE team_id = ? AND id = ?`,
      [
        next.code, next.name, next.scope, next.productId, next.productName, next.productModel,
        next.summary, next.remark, JSON.stringify(next.items), new Date(next.updatedAt),
        teamId, id
      ]
    );
    return next;
  }

  async removeMany(teamId: string, ids: string[]) {
    if (!ids.length) return [];
    const [rows] = await this.pool.query(
      `SELECT id FROM packaging_plans WHERE team_id = ? AND id IN (?)`,
      [teamId, ids]
    );
    const found = (rows as Array<{ id: string }>).map((row) => row.id);
    if (!found.length) return [];
    await this.pool.query(
      `DELETE FROM packaging_plans WHERE team_id = ? AND id IN (?)`,
      [teamId, found]
    );
    return found;
  }
}

let repository: PackagingPlanRepository | null = null;

export function setPackagingPlanRepository(next: PackagingPlanRepository | null) {
  repository = next;
}

export function getPackagingPlanRepository() {
  return repository;
}

export function createMysqlPackagingPlanRepository(pool: Pool) {
  return new MysqlPackagingPlanRepository(pool);
}
