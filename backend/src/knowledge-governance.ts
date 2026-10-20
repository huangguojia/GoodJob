import { randomUUID } from "node:crypto";
import type { Pool } from "mysql2/promise";

// ---------------------------------------------------------------------------
// 资料治理：受控词表（类目 / 标签）+ 「已校订」标记。
//
// 为什么独立于 persistAll 体系：knowledge_assets 在内存 store 里、由 persistAll
// 全表重写；词表如果也塞进去，每次保存资料都会重写一遍词表，且「合并词条」
// 这类跨表动作会失去单一真相。这里走 resource-hub 同款模式 —— 独立表 +
// 独立仓库（MySQL / 内存双实现），mysql-store 只负责挂载。
//
// 治的问题（G1）：同类资料散成「产品知识 / 产品资料 / 产品文档」多个类目时，
// 检索的 idf 分母被稀释、报表按类目聚不起来。词表 + 合并工具就是治这个的。
// ---------------------------------------------------------------------------

export type KnowledgeVocabularyType = "category" | "tag";

export interface KnowledgeVocabularyEntry {
  id: string;
  teamId: string;
  type: KnowledgeVocabularyType;
  value: string;
  normalized: string;
  enabled: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 词表归一化：大小写 / 首尾空白 / 连续空格不影响「是同一个词」。 */
export function normalizeVocabularyValue(value: string): string {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
}

export interface KnowledgeGovernanceRepository {
  list(teamId: string, type?: KnowledgeVocabularyType): Promise<KnowledgeVocabularyEntry[]>;
  /**
   * 已存在（同 team + type + normalized）则返回既有条，不报错 ——
   * 「建议新类目」落到既有词条上时应该是静默复用，而不是让用户撞一个错误。
   */
  ensure(teamId: string, type: KnowledgeVocabularyType, value: string): Promise<KnowledgeVocabularyEntry>;
  update(
    teamId: string,
    id: string,
    patch: { value?: string; enabled?: boolean }
  ): Promise<KnowledgeVocabularyEntry | null>;
  /** 资料入库 / 编辑时调用：命中的词条用量 +1，供面板按真实使用量排序。 */
  bumpUsage(teamId: string, type: KnowledgeVocabularyType, values: string[]): Promise<void>;
}

function toEntry(row: Record<string, unknown>): KnowledgeVocabularyEntry {
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    type: String(row.type) as KnowledgeVocabularyType,
    value: String(row.value),
    normalized: String(row.normalized),
    enabled: Number(row.enabled || 0) === 1,
    usageCount: Number(row.usage_count || 0),
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString()
  };
}

export class MysqlKnowledgeGovernanceRepository implements KnowledgeGovernanceRepository {
  constructor(private readonly pool: Pool) {}

  async list(teamId: string, type?: KnowledgeVocabularyType): Promise<KnowledgeVocabularyEntry[]> {
    const [rows] = type
      ? await this.pool.execute(
        "SELECT * FROM knowledge_vocabulary WHERE team_id = ? AND type = ? ORDER BY usage_count DESC, normalized",
        [teamId, type]
      )
      : await this.pool.execute(
        "SELECT * FROM knowledge_vocabulary WHERE team_id = ? ORDER BY type, usage_count DESC, normalized",
        [teamId]
      );
    return (rows as Array<Record<string, unknown>>).map(toEntry);
  }

  async ensure(teamId: string, type: KnowledgeVocabularyType, value: string): Promise<KnowledgeVocabularyEntry> {
    const normalized = normalizeVocabularyValue(value);
    const [found] = await this.pool.execute(
      "SELECT * FROM knowledge_vocabulary WHERE team_id = ? AND type = ? AND normalized = ? LIMIT 1",
      [teamId, type, normalized]
    );
    const existing = (found as Array<Record<string, unknown>>)[0];
    if (existing) return toEntry(existing);
    const now = new Date();
    const entry: KnowledgeVocabularyEntry = {
      id: `kv_${randomUUID()}`,
      teamId,
      type,
      value: value.trim(),
      normalized,
      enabled: true,
      usageCount: 0,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
    await this.pool.execute(
      `INSERT INTO knowledge_vocabulary
        (id, team_id, type, value, normalized, enabled, usage_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      [entry.id, teamId, type, entry.value, normalized, now, now]
    );
    return entry;
  }

  async update(
    teamId: string,
    id: string,
    patch: { value?: string; enabled?: boolean }
  ): Promise<KnowledgeVocabularyEntry | null> {
    const sets: string[] = [];
    const values: Array<string | number | Date> = [];
    if (patch.value !== undefined) {
      sets.push("value = ?", "normalized = ?");
      values.push(patch.value.trim(), normalizeVocabularyValue(patch.value));
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      values.push(patch.enabled ? 1 : 0);
    }
    if (!sets.length) return this.find(teamId, id);
    sets.push("updated_at = ?");
    values.push(new Date(), id, teamId);
    await this.pool.execute(
      `UPDATE knowledge_vocabulary SET ${sets.join(", ")} WHERE id = ? AND team_id = ?`,
      values
    );
    return this.find(teamId, id);
  }

  async bumpUsage(teamId: string, type: KnowledgeVocabularyType, values: string[]): Promise<void> {
    const normalized = [...new Set(values.map(normalizeVocabularyValue).filter(Boolean))];
    if (!normalized.length) return;
    const placeholders = normalized.map(() => "?").join(", ");
    await this.pool.execute(
      `UPDATE knowledge_vocabulary
         SET usage_count = usage_count + 1, updated_at = ?
       WHERE team_id = ? AND type = ? AND normalized IN (${placeholders})`,
      [new Date(), teamId, type, ...normalized]
    );
  }

  private async find(teamId: string, id: string): Promise<KnowledgeVocabularyEntry | null> {    const [rows] = await this.pool.execute(
      "SELECT * FROM knowledge_vocabulary WHERE id = ? AND team_id = ? LIMIT 1",
      [id, teamId]
    );
    const row = (rows as Array<Record<string, unknown>>)[0];
    return row ? toEntry(row) : null;
  }
}

/** 内存实现：语义与 MySQL 版逐条对齐（否则「内存档位行为一致」是空的）。 */
export class MemoryKnowledgeGovernanceRepository implements KnowledgeGovernanceRepository {
  private readonly entries: KnowledgeVocabularyEntry[] = [];

  /** 单测隔离用：清空内存词表，避免用例之间互相污染。 */
  clear() {
    this.entries.length = 0;
  }

  async list(teamId: string, type?: KnowledgeVocabularyType): Promise<KnowledgeVocabularyEntry[]> {
    return this.entries
      .filter((entry) => entry.teamId === teamId && (!type || entry.type === type))
      .sort((left, right) => right.usageCount - left.usageCount || left.normalized.localeCompare(right.normalized));
  }

  async ensure(teamId: string, type: KnowledgeVocabularyType, value: string): Promise<KnowledgeVocabularyEntry> {
    const normalized = normalizeVocabularyValue(value);
    const existing = this.entries.find(
      (entry) => entry.teamId === teamId && entry.type === type && entry.normalized === normalized
    );
    if (existing) return existing;
    const now = new Date().toISOString();
    const entry: KnowledgeVocabularyEntry = {
      id: `kv_${randomUUID()}`,
      teamId,
      type,
      value: value.trim(),
      normalized,
      enabled: true,
      usageCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.entries.push(entry);
    return entry;
  }

  async update(
    teamId: string,
    id: string,
    patch: { value?: string; enabled?: boolean }
  ): Promise<KnowledgeVocabularyEntry | null> {
    const entry = this.entries.find((item) => item.id === id && item.teamId === teamId);
    if (!entry) return null;
    if (patch.value !== undefined) {
      entry.value = patch.value.trim();
      entry.normalized = normalizeVocabularyValue(patch.value);
    }
    if (patch.enabled !== undefined) entry.enabled = patch.enabled;
    entry.updatedAt = new Date().toISOString();
    return entry;
  }

  async bumpUsage(teamId: string, type: KnowledgeVocabularyType, values: string[]): Promise<void> {
    const normalized = new Set(values.map(normalizeVocabularyValue).filter(Boolean));
    if (!normalized.size) return;
    for (const entry of this.entries) {
      if (entry.teamId !== teamId || entry.type !== type) continue;
      if (!normalized.has(entry.normalized)) continue;
      entry.usageCount += 1;
      entry.updatedAt = new Date().toISOString();
    }
  }
}

const memoryKnowledgeGovernanceRepository = new MemoryKnowledgeGovernanceRepository();

export function setKnowledgeGovernanceRepository(repository: KnowledgeGovernanceRepository | null) {
  knowledgeGovernanceRepository = repository;
}

/** 单测隔离：摘掉 MySQL 仓库并清空内存词表。 */
export function resetKnowledgeGovernanceForTest() {
  knowledgeGovernanceRepository = null;
  memoryKnowledgeGovernanceRepository.clear();
}

/** MySQL 仓库未挂载时（内存档位 / 单测）回落内存实现，词表闭环在任何档位都成立。 */
export function getKnowledgeGovernanceRepository(): KnowledgeGovernanceRepository {
  return knowledgeGovernanceRepository || memoryKnowledgeGovernanceRepository;
}

let knowledgeGovernanceRepository: KnowledgeGovernanceRepository | null = null;

export function createMysqlKnowledgeGovernanceRepository(pool: Pool) {
  return new MysqlKnowledgeGovernanceRepository(pool);
}

/**
 * 建表 + 给 knowledge_assets 补 `verified` 列 + 词表种子化。
 *
 * 种子化只在词表为空时跑一次（幂等，启动路径也只多一次 COUNT）：把现有
 * distinct 类目 / 标签按团队灌进去，否则老资料第一天就被新校验拦死。
 * `team_id='all'` 的历史行归并到 owner 团队（与 repairKnowledgeAssetTeamOwnership 同口径）。
 *
 * ⚠️ id 与 `normalized` 都在 **JS 侧**算，不在 SQL 里算：
 * ① 本机 MySQL（9.7.1）**没有 `MD5()`** —— 写成 `SUBSTRING(MD5(...),1,24)` 会让整个迁移
 *    直接报 `FUNCTION goodjob_crm_dev.MD5 does not exist` 并中止（踩过）；
 * ② 归一化只该有一处真相 —— 在 SQL 里再写一遍 `LOWER(REGEXP_REPLACE(TRIM(..)))` 迟早与
 *    `normalizeVocabularyValue()` 漂移，而"是不是同一个词"正是唯一索引的判定依据。
 */
export async function ensureKnowledgeGovernanceSchema(pool: Pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS knowledge_vocabulary (
    id VARCHAR(64) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    type VARCHAR(20) NOT NULL,
    value VARCHAR(100) NOT NULL,
    normalized VARCHAR(100) NOT NULL,
    enabled TINYINT NOT NULL DEFAULT 1,
    usage_count INT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    UNIQUE KEY uk_knowledge_vocabulary_team (team_id, type, normalized)
  )`);
  await ensureColumn(pool, "knowledge_assets", "verified", "TINYINT NOT NULL DEFAULT 0");
  await ensureColumn(pool, "knowledge_assets", "archived_reason", "VARCHAR(200) DEFAULT ''");

  const [existing] = await pool.query("SELECT COUNT(*) AS count FROM knowledge_vocabulary");
  if (Number((existing as Array<{ count: number }>)[0]?.count || 0) > 0) return;

  // 类目 + 标签一次查出来（标签用 JSON_TABLE 展平 tags_json，空数组 / NULL 自然零行）。
  const [rows] = await pool.query(`
    SELECT DISTINCT
      COALESCE(NULLIF(a.team_id, 'all'), u.team_id, 'all') AS team_id,
      'category' AS type,
      a.category AS value
    FROM knowledge_assets a
    LEFT JOIN users u ON u.id = a.owner_id
    WHERE a.category IS NOT NULL AND a.category <> ''
    UNION ALL
    SELECT DISTINCT
      COALESCE(NULLIF(a.team_id, 'all'), u.team_id, 'all') AS team_id,
      'tag' AS type,
      jt.tag AS value
    FROM knowledge_assets a
    LEFT JOIN users u ON u.id = a.owner_id
    JOIN JSON_TABLE(a.tags_json, '$[*]' COLUMNS (tag VARCHAR(100) PATH '$')) jt
    WHERE a.tags_json IS NOT NULL
  `);

  const now = new Date();
  // 一条 (团队, 类型, 归一化值) 只留一份：DISTINCT 已去重，再挡一次归一化后相同的情况。
  const seen = new Set<string>();
  const seeds: Array<{ id: string; teamId: string; type: string; value: string; normalized: string }> = [];
  for (const row of rows as Array<{ team_id: unknown; type: unknown; value: unknown }>) {
    const teamId = String(row.team_id ?? "").trim();
    const type = String(row.type ?? "") === "tag" ? "tag" : "category";
    const value = String(row.value ?? "").trim();
    const normalized = normalizeVocabularyValue(value).slice(0, 100);
    if (!teamId || !value || !normalized) continue;
    const key = `${teamId}\u0000${type}\u0000${normalized}`;
    if (seen.has(key)) continue;
    seen.add(key);
    seeds.push({ id: `kv_${randomUUID()}`, teamId, type, value: value.slice(0, 100), normalized });
  }
  if (!seeds.length) return;

  for (let offset = 0; offset < seeds.length; offset += 200) {
    const chunk = seeds.slice(offset, offset + 200);
    const placeholders = chunk.map(() => "(?,?,?,?,?,1,1,?,?)").join(",");
    await pool.query(
      `INSERT INTO knowledge_vocabulary
         (id, team_id, type, value, normalized, enabled, usage_count, created_at, updated_at)
       VALUES ${placeholders}
       ON DUPLICATE KEY UPDATE updated_at = ?`,
      [
        ...chunk.flatMap((seed) => [seed.id, seed.teamId, seed.type, seed.value, seed.normalized, now, now]),
        // 不用 `VALUES(updated_at)`：那是 MySQL 8.0.20 起就废弃的写法，本机 MySQL 版本
        // 已经在 MD5 上给过一次意外，迁移路径上不留废弃语法。
        now
      ]
    );
  }
}

// ensureColumn 与 mysql-store.ts 的同名 helper 行为一致（补列幂等 + 吞并发加列错）。
// 这里自带一份轻量实现，避免治理模块反向依赖 mysql-store 造成环。
async function ensureColumn(pool: Pool, table: string, column: string, definition: string) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (Number((rows as Array<{ count: number }>)[0]?.count || 0) > 0) return;
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (error: any) {
    // 并发迁移下另一个连接可能刚加过同一列 —— 1060 / ER_DUP_FIELDNAME 视为成功
    if (error?.errno !== 1060 && error?.code !== "ER_DUP_FIELDNAME") throw error;
  }
}
