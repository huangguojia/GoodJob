import { createHash, randomUUID } from "node:crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

// ---------------------------------------------------------------------------
// 知识库训练模块：训练批次（run）+ 候选池（candidate / 已发布镜像）+ 黄金问法（golden）
//                  + 知识库（knowledge base）+ 账号级启用清单（user ⇄ kb）
//
// 五张表独立于 `mysql-store.ts` 的全表重写体系（persistAll），走「新模块独立 Repository」
// 套路（与 exchange/exchange-repository.ts 同源）。理由：训练批次是事件流，全表重写既
// 没必要也会拖慢主库；而且它天然有 team_id 维度，适合直接 SQL 分页。
//
// 血缘是这张表的核心：`source_ref_json` 是**硬门槛**——没有出处的候选不允许发布。
// 发布成功后把插件侧条目 id 写回 `published_entry_id`，撤回时据此定位。
//
// 「知识库」是训练成果的**资产**形态（相对地，run 只是执行日志）：
//   - `visibility='owner'` 私用（只有创建者能用）、`'team'` 公开（同团队都能用）；
//   - `kb_user_knowledge_bases` 是每个账号自己的「默认知识库」多选清单，**行存在即启用**；
//   - 插件侧只认「启用清单」（`training_kb_subscriptions`，由 CRM 推送），
//     因为自动回复在插件里跑、没有 CRM 请求上下文，无法临场问 CRM。
// ---------------------------------------------------------------------------

export type KbTrainingRunStatus = "running" | "succeeded" | "partial" | "failed" | "cancelled";
export type KbTrainingEngine = "cli" | "ai" | "none";
export type KbCandidateKind = "qa" | "snippet" | "policy" | "forbidden";
export type KbCandidateSourceType = "file" | "conversation" | "manual";
export type KbCandidateStatus = "pending" | "approved" | "rejected" | "published";
/** 知识库可见性。沿用项目既有口径（见 authorization.ts / prospect-qualification-mysql.ts 的 `visibility_scope`）。 */
export type KbKnowledgeBaseVisibility = "owner" | "team";

/** `stats_json`：一次训练的可读账本。字段名与设计方案 §6 一致，前端直接展示。 */
export interface KbTrainingStats {
  /** 切出来的语料段数 */
  segments: number;
  /** 实际入池的候选数 */
  candidates: number;
  /** 与既有候选撞指纹被合并的条数 */
  duplicates: number;
  /** 被输出校验丢弃的条数（越界 / 未知 kind / 缺字段 / JSON 坏） */
  skipped: number;
  /** 实际发生的 CLI 调用次数（每 20 段 1 次） */
  cliCalls: number;
  /** CLI 引用了不在候选集里的出处（编造引用）的条数 */
  invented: number;
}

/** `source_ref_json`：候选的出处。**无出处不入池、不可发布**。 */
export interface KbTrainingSourceRef {
  type: "file" | "conversation";
  /** files 源：文件中心资料 id（可空——纯粘贴正文时没有关联资料） */
  assetId?: string;
  /** 出处的可读标题（资料标题 / 会话联系人） */
  title?: string;
  /** 资料版本（来自 knowledge_assets.version） */
  version?: string;
  /** 段落锚点，如「§2.1」或分段序号 —— 让人能翻回原文那一段 */
  anchor?: string;
  /** 来源描述（选填，用户在训练页自填）：这份资料从哪来 / 谁给的口径。只进训练端展示。 */
  note?: string;
  /** conversations 源：会话键（P2） */
  conversationKey?: string;
  /** conversations 源：命中的消息 id（P2） */
  messageIds?: string[];
}

export interface KbTrainingRun {
  id: string;
  teamId: string;
  ownerId: string;
  /** 本批训练成果归属的知识库 id。空串 = 老批次（本次改动之前创建），只能当执行日志看。 */
  kbId: string;
  /** 发起时的入参快照（可扩展 union：files / text / conversations） */
  sourcesJson: string;
  status: KbTrainingRunStatus;
  /** **实际生效**的那一档（降级如实记录，不假装成功） */
  engine: KbTrainingEngine;
  model: string;
  stats: KbTrainingStats;
  /**
   * 运行中的实时进度。运行结束仍保留（前端据此画「这批处理了多少段」）。
   * 没有它时 200 段的长资料会连续十几分钟只有「运行中」三个字 —— 用户无法判断是
   * 在跑还是卡死，也就没法决定要不要取消。老批次为 null。
   */
  progress: KbTrainingProgress | null;
  /** 该批次还有多少条候选没确认（列表卡片上的「待确认 N」）。 */
  pendingCount: number;
  errorMessage: string;
  createdAt: string;
  finishedAt: string;
}

/** 一段可显示的进度：只放事实，不放预估（预估会漂移，看起来像在骗人）。 */
export interface KbTrainingProgress {
  /** 切出来的总段数 */
  totalSegments: number;
  /** 已交给模型处理的段数 */
  processedSegments: number;
  /** 已完成的批次数 / 总批次数 */
  batchesDone: number;
  batches: number;
  /** collecting=读资料、extracting=提炼中、done=收尾 */
  stage: "collecting" | "extracting" | "done";
  startedAt: string;
  updatedAt: string;
}

export interface KbTrainingCandidate {
  id: string;
  runId: string;
  teamId: string;
  ownerId: string;
  kind: KbCandidateKind;
  question: string;
  answer: string;
  tags: string[];
  languages: string[];
  confidence: number;
  sourceType: KbCandidateSourceType;
  sourceRef: KbTrainingSourceRef | null;
  /** 「为什么值得进库」——确认屏直接显示，也是人工判断的主要依据 */
  rationale: string;
  /** 知识缺口：机器认为该有问题但资料里找不到答案（P2 会话源用） */
  gapFlag: boolean;
  fingerprint: string;
  status: KbCandidateStatus;
  /** 插件侧条目 id（血缘） */
  publishedEntryId: string;
  reviewedBy: string;
  reviewedAt: string;
  createdAt: string;
}

export interface KbGoldenQuery {
  id: string;
  teamId: string;
  ownerId: string;
  question: string;
  expectKinds: string;
  expectSourceRef: KbTrainingSourceRef | null;
  enabled: boolean;
  createdAt: string;
}

/**
 * 知识库：训练成果的**资产**形态，可以被公开给同团队、也可以被别人勾选启用。
 *
 * 为什么不把可见性直接挂在 `kb_training_runs` 上：run 是执行日志（可失败、可重跑、会堆），
 * 知识库是长期资产（有名字、有归属、有可见性、要能被别人勾选）。两者混在一张表里，
 * 界面上「知识库列表」就会混进一堆 failed 批次。
 */
export interface KbKnowledgeBase {
  id: string;
  teamId: string;
  /** 创建者。**只有创建者能改名与切换公开/私用**。 */
  ownerId: string;
  name: string;
  visibility: KbKnowledgeBaseVisibility;
  /** 由哪一批训练产生（空串 = 手工创建）。目前一批一库，留字段以便将来多批喂养同一库。 */
  runId: string;
  createdAt: string;
  updatedAt: string;
}

/** 列表出参：知识库 + 观众视角的可见/可改/是否已启用 + 条目统计。 */
export interface KbKnowledgeBaseView extends KbKnowledgeBase {
  ownerName: string;
  /** 观众是不是创建者（决定「公开/私用」「改名」按钮是否可点） */
  isOwner: boolean;
  /** 当前账号是否已启用（= 在 `kb_user_knowledge_bases` 里有行） */
  enabled: boolean;
  /** 已发布到插件、正在参与出稿的条目数 */
  entryCount: number;
  /** 该库下还没确认的候选数（让人知道这个库还在长） */
  pendingCount: number;
}

export interface KbKnowledgeBaseInput {
  teamId: string;
  ownerId: string;
  name: string;
  visibility: KbKnowledgeBaseVisibility;
  runId: string;
}

export interface KbTrainingRunInput {
  teamId: string;
  ownerId: string;
  /** 归属知识库。发起训练时会先建库（或复用已指定的库），所以这里是必填。 */
  kbId: string;
  sourcesJson: string;
}

export interface KbTrainingCandidateInput {
  runId: string;
  teamId: string;
  ownerId: string;
  kind: KbCandidateKind;
  question: string;
  answer: string;
  tags: string[];
  languages: string[];
  confidence: number;
  sourceType: KbCandidateSourceType;
  sourceRef: KbTrainingSourceRef | null;
  rationale: string;
  gapFlag: boolean;
  fingerprint: string;
  status: KbCandidateStatus;
}

/**
 * 与插件侧同口径的内容指纹：`sha256(kind + question + answer)[:32]`。
 *
 * ⚠️ 归一化必须**逐字对齐**插件 `fingerprintOf()`（training-library-service.ts:90）：
 * 空白折叠成单空格 + 转小写。少这一步，「CRM 发过去一条、插件里已有一条」就会
 * 被判成两条，库立刻出现肉眼分不清的重复。
 */
export function candidateFingerprint(kind: string, question: string, answer: string): string {
  const normalize = (value: string): string => String(value ?? "").replace(/\s+/gu, " ").trim().toLowerCase();
  const normalized = [kind, normalize(question), normalize(answer)].join("\u0000");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

const EMPTY_STATS: KbTrainingStats = {
  segments: 0, candidates: 0, duplicates: 0, skipped: 0, cliCalls: 0, invented: 0
};

interface RunRow extends RowDataPacket {
  id: string; team_id: string; owner_id: string; kb_id: string | null; sources_json: unknown; status: string;
  engine: string; model: string | null; stats_json: unknown; error_message: string | null;
  progress_json?: unknown; cancel_requested?: number | null; pending_count?: number | string | null;
  created_at: Date; finished_at: Date | null;
}

interface KnowledgeBaseRow extends RowDataPacket {
  id: string; team_id: string; owner_id: string; name: string; visibility: string;
  run_id: string | null; created_at: Date; updated_at: Date;
}

/** 列表查询行：知识库 + 观众视角的派生列（JOIN users 取名、子查询数条目）。 */
interface KnowledgeBaseViewRow extends KnowledgeBaseRow {
  owner_name: string | null;
  entry_count: number | string | null;
  pending_count: number | string | null;
}

interface CandidateRow extends RowDataPacket {
  id: string; run_id: string; team_id: string; owner_id: string; kind: string;
  question: string | null; answer: string | null; tags_json: unknown; languages_json: unknown;
  confidence: string | number | null; source_type: string; source_ref_json: unknown;
  rationale: string | null; gap_flag: number; fingerprint: string; status: string;
  published_entry_id: string | null; reviewed_by: string | null; reviewed_at: Date | null;
  created_at: Date;
}

interface GoldenRow extends RowDataPacket {
  id: string; team_id: string; owner_id: string; question: string; expect_kinds: string | null;
  expect_source_ref_json: unknown; enabled: number; created_at: Date;
}

function iso(value: Date | string | null): string {
  if (!value) return "";
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * JSON 列读回来可能是对象（mysql2 对 JSON 类型会解一次）也可能是字符串（历史行 / 别的驱动）。
 * 两种都吃，坏值一律给兜底，绝不让一列脏数据把整个列表接口带崩。
 */
function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value as T;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value) as T;
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function mapRun(row: RunRow): KbTrainingRun {
  return {
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    kbId: row.kb_id || "",
    sourcesJson: typeof row.sources_json === "string" ? row.sources_json : JSON.stringify(row.sources_json ?? {}),
    status: (row.status || "running") as KbTrainingRunStatus,
    engine: (row.engine || "none") as KbTrainingEngine,
    model: row.model || "",
    stats: { ...EMPTY_STATS, ...parseJson<Partial<KbTrainingStats>>(row.stats_json, {}) },
    progress: parseJson<KbTrainingProgress | null>(row.progress_json, null),
    pendingCount: Number(row.pending_count ?? 0),
    errorMessage: row.error_message || "",
    createdAt: iso(row.created_at),
    finishedAt: iso(row.finished_at)
  };
}

/** 未知的 visibility 一律当 `owner` 处理：宁可「没分享出去」，绝不「意外公开」。 */
export function normalizeKbVisibility(value: unknown): KbKnowledgeBaseVisibility {
  return value === "team" ? "team" : "owner";
}

function mapKnowledgeBase(row: KnowledgeBaseRow): KbKnowledgeBase {
  return {
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    name: row.name || "未命名知识库",
    visibility: normalizeKbVisibility(row.visibility),
    runId: row.run_id || "",
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

function mapCandidate(row: CandidateRow): KbTrainingCandidate {
  return {
    id: row.id,
    runId: row.run_id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    kind: (row.kind || "qa") as KbCandidateKind,
    question: row.question || "",
    answer: row.answer || "",
    tags: parseJson<string[]>(row.tags_json, []),
    languages: parseJson<string[]>(row.languages_json, []),
    confidence: Number(row.confidence ?? 0),
    sourceType: (row.source_type || "file") as KbCandidateSourceType,
    sourceRef: parseJson<KbTrainingSourceRef | null>(row.source_ref_json, null),
    rationale: row.rationale || "",
    gapFlag: row.gap_flag === 1,
    fingerprint: row.fingerprint || "",
    status: (row.status || "pending") as KbCandidateStatus,
    publishedEntryId: row.published_entry_id || "",
    reviewedBy: row.reviewed_by || "",
    reviewedAt: iso(row.reviewed_at),
    createdAt: iso(row.created_at)
  };
}

function mapGolden(row: GoldenRow): KbGoldenQuery {
  return {
    id: row.id,
    teamId: row.team_id,
    ownerId: row.owner_id,
    question: row.question || "",
    expectKinds: row.expect_kinds || "",
    expectSourceRef: parseJson<KbTrainingSourceRef | null>(row.expect_source_ref_json, null),
    enabled: row.enabled === 1,
    createdAt: iso(row.created_at)
  };
}

/**
 * 幂等加列。MySQL 8.0 的 `ALTER TABLE ... ADD COLUMN` **没有** `IF NOT EXISTS`，
 * 所以要自己查 information_schema；直接 ALTER 会在第二次启动时抛 1060，
 * 那会让整个后端起不来（建表钩子在启动路径上）。
 */
async function ensureKbColumn(pool: Pool, table: string, column: string, definition: string): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  if (Number(rows[0]?.count ?? 0) === 0) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

async function ensureKbIndex(pool: Pool, table: string, index: string, columns: string): Promise<void> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS count FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [table, index]
  );
  if (Number(rows[0]?.count ?? 0) === 0) {
    await pool.query(`CREATE INDEX \`${index}\` ON \`${table}\` (${columns})`);
  }
}

/**
 * 五张表都是 `CREATE TABLE IF NOT EXISTS`，加列走 `ensureKbColumn` 幂等；
 * 回滚 = 关开关 + DROP 这五张表（不改任何既有列，无既有数据风险）。
 */
export async function ensureKbTrainingSchema(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_training_runs (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      owner_id VARCHAR(64) NOT NULL,
      sources_json JSON NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'running',
      engine VARCHAR(16) NOT NULL DEFAULT 'none',
      model VARCHAR(64) NOT NULL DEFAULT '',
      stats_json JSON NULL,
      error_message VARCHAR(1000) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL,
      finished_at DATETIME(3) NULL,
      KEY idx_kb_run_team_time (team_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // 唯一键是 (team_id, fingerprint) 而不是 fingerprint：指纹只含 kind+question+answer，
  // 两个团队出现同一句问答完全正常，全局唯一会让后一个团队**发不出去**（实测过的多租户坑）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_training_candidates (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      run_id VARCHAR(64) NOT NULL DEFAULT '',
      team_id VARCHAR(64) NOT NULL,
      owner_id VARCHAR(64) NOT NULL,
      kind VARCHAR(16) NOT NULL,
      question TEXT NULL,
      answer TEXT NULL,
      tags_json JSON NULL,
      languages_json JSON NULL,
      confidence DECIMAL(4,3) NOT NULL DEFAULT 0,
      source_type VARCHAR(16) NOT NULL DEFAULT 'file',
      source_ref_json JSON NULL,
      rationale VARCHAR(1000) NOT NULL DEFAULT '',
      gap_flag TINYINT(1) NOT NULL DEFAULT 0,
      fingerprint CHAR(32) NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      published_entry_id VARCHAR(64) NOT NULL DEFAULT '',
      reviewed_by VARCHAR(64) NOT NULL DEFAULT '',
      reviewed_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_kb_cand_team_fingerprint (team_id, fingerprint),
      KEY idx_kb_cand_team_status (team_id, status, created_at),
      KEY idx_kb_cand_run (run_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_golden_queries (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      owner_id VARCHAR(64) NOT NULL,
      question VARCHAR(500) NOT NULL,
      expect_kinds VARCHAR(64) NOT NULL DEFAULT '',
      expect_source_ref_json JSON NULL,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL,
      KEY idx_kb_golden_team (team_id, enabled, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  // 批次归属的知识库。老批次回填空串 = 「未归属」，界面按「无知识库」展示，不假装它有。
  await ensureKbColumn(pool, "kb_training_runs", "kb_id", "VARCHAR(64) NOT NULL DEFAULT ''");
  await ensureKbIndex(pool, "kb_training_runs", "idx_kb_run_kb", "kb_id");
  // 运行中进度 + 取消标记。长资料（200 段 ≈ 10 次 CLI 调用）不能只显示「运行中」：
  // 没有进度，用户分不清「在跑」和「卡死」，也就无法决定是否取消。
  await ensureKbColumn(pool, "kb_training_runs", "progress_json", "JSON NULL");
  await ensureKbColumn(pool, "kb_training_runs", "cancel_requested", "TINYINT(1) NOT NULL DEFAULT 0");
  // 知识库（训练成果的资产形态）。
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_knowledge_bases (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      owner_id VARCHAR(64) NOT NULL,
      name VARCHAR(200) NOT NULL DEFAULT '',
      visibility VARCHAR(16) NOT NULL DEFAULT 'owner',
      run_id VARCHAR(64) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_kb_kb_team_vis (team_id, visibility, updated_at),
      KEY idx_kb_kb_owner (owner_id, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  /**
   * 账号级「默认知识库」多选清单。**行存在即启用**——取消勾选就是删行。
   *
   * 不设 `enabled` 列的理由：一张「用户 ⇄ 库」的勾选表里再放一个布尔，就会有两种
   * 「不启用」的写法（无行 / 有行且 enabled=0），界面与插件各理解一种，必然对不上。
   */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kb_user_knowledge_bases (
      user_id VARCHAR(64) NOT NULL,
      team_id VARCHAR(64) NOT NULL,
      kb_id VARCHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      PRIMARY KEY (user_id, kb_id),
      KEY idx_kb_ukb_kb (kb_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export class MysqlKbTrainingRepository {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // 知识库（训练成果的资产形态）+ 账号级启用清单
  // -------------------------------------------------------------------------

  /**
   * 建库。同时**把创建者自己勾上**——自己训出来的成果默认就该生效；
   * 不自动勾的话，用户训完发现「出稿没变化」，会以为是功能坏了。
   * 别人分享的库不自动勾（要人主动选），见 `setEnabledKnowledgeBases`。
   */
  async createKnowledgeBase(input: KbKnowledgeBaseInput): Promise<KbKnowledgeBase> {
    const now = new Date();
    const id = input.runId ? `kb_${input.runId.replace(/^kbr_/u, "")}` : `kb_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await this.pool.query(
      `INSERT INTO kb_knowledge_bases (id, team_id, owner_id, name, visibility, run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.teamId, input.ownerId, input.name, input.visibility, input.runId, now, now]
    );
    await this.pool.query(
      `INSERT IGNORE INTO kb_user_knowledge_bases (user_id, team_id, kb_id, created_at) VALUES (?, ?, ?, ?)`,
      [input.ownerId, input.teamId, id, now]
    );
    return {
      id,
      teamId: input.teamId,
      ownerId: input.ownerId,
      name: input.name,
      visibility: input.visibility,
      runId: input.runId,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString()
    };
  }

  async getKnowledgeBase(id: string, teamId: string): Promise<KbKnowledgeBase | null> {
    const [rows] = await this.pool.query<KnowledgeBaseRow[]>(
      "SELECT * FROM kb_knowledge_bases WHERE id = ? AND team_id = ? LIMIT 1",
      [id, teamId]
    );
    return rows[0] ? mapKnowledgeBase(rows[0]) : null;
  }

  /**
   * 可见的知识库 = **我的** ∪ **同团队公开的**。
   *
   * 这是权限判据的唯一实现处：路由、保存启用清单都调它，避免两处各写一遍条件
   * 然后慢慢漂移。`visibility` 只有 `team` 会跨人可见，`owner` 永远只有创建者看得到。
   */
  async listKnowledgeBases(teamId: string, viewerId: string): Promise<KbKnowledgeBaseView[]> {
    const [rows] = await this.pool.query<KnowledgeBaseViewRow[]>(
      `SELECT kb.*,
              u.name AS owner_name,
              (SELECT COUNT(*) FROM kb_training_candidates c
                 JOIN kb_training_runs r ON r.id = c.run_id
                WHERE r.kb_id = kb.id AND c.status = 'published') AS entry_count,
              (SELECT COUNT(*) FROM kb_training_candidates c
                 JOIN kb_training_runs r ON r.id = c.run_id
                WHERE r.kb_id = kb.id AND c.status = 'pending') AS pending_count,
              (SELECT COUNT(*) FROM kb_user_knowledge_bases e
                WHERE e.kb_id = kb.id AND e.user_id = ?) AS enabled_count
         FROM kb_knowledge_bases kb
         LEFT JOIN users u ON u.id = kb.owner_id
        WHERE kb.team_id = ? AND (kb.owner_id = ? OR kb.visibility = 'team')
        ORDER BY kb.updated_at DESC
        LIMIT 200`,
      [viewerId, teamId, viewerId]
    );
    return rows.map((row) => ({
      ...mapKnowledgeBase(row),
      ownerName: row.owner_name || row.owner_id,
      isOwner: row.owner_id === viewerId,
      enabled: Number(row.enabled_count ?? 0) > 0,
      entryCount: Number(row.entry_count ?? 0),
      pendingCount: Number(row.pending_count ?? 0)
    }));
  }

  /**
   * 改名 / 切公开私用。**只有创建者能改**：`owner_id` 直接进 WHERE，
   * 影响行数为 0 就说明「不是你的库」，由调用方决定报 403 还是 404。
   */
  async updateKnowledgeBase(
    id: string,
    teamId: string,
    ownerId: string,
    patch: { name?: string; visibility?: KbKnowledgeBaseVisibility }
  ): Promise<boolean> {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      values.push(patch.name);
    }
    if (patch.visibility !== undefined) {
      sets.push("visibility = ?");
      values.push(patch.visibility);
    }
    if (!sets.length) return false;
    sets.push("updated_at = ?");
    values.push(new Date(), id, teamId, ownerId);
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE kb_knowledge_bases SET ${sets.join(", ")} WHERE id = ? AND team_id = ? AND owner_id = ?`,
      values
    );
    return Number(result.affectedRows ?? 0) > 0;
  }

  /**
   * 回填「本库由哪一批训练产生」。仅创建者可写（与改名同判据），
   * 避免别人拿一个批次 id 把你的库认领走。
   */
  async attachKnowledgeBaseRun(id: string, runId: string, teamId: string, ownerId: string): Promise<boolean> {
    const [result] = await this.pool.query<ResultSetHeader>(
      "UPDATE kb_knowledge_bases SET run_id = ?, updated_at = ? WHERE id = ? AND team_id = ? AND owner_id = ?",
      [runId, new Date(), id, teamId, ownerId]
    );
    return Number(result.affectedRows ?? 0) > 0;
  }

  /**
   * 库里**全部**已发布条目的插件侧 id（不分页）。
   *
   * 删除知识库必须先让插件把这些条目归档：插件按 `kb_id` 读语料，CRM 单方面删库
   * 只会让列表里少一张卡，出稿时那些语料仍然被读到 —— 也就是"幽灵语料"。
   * 这里单独取 id（而不是复用列表接口）是因为列表有 500 条上限，漏掉的会永远留在插件里。
   */
  async listPublishedEntryIdsByKnowledgeBase(teamId: string, kbId: string): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT c.published_entry_id FROM kb_training_candidates c
         JOIN kb_training_runs r ON r.id = c.run_id AND r.team_id = c.team_id
        WHERE c.team_id = ? AND r.kb_id = ? AND c.status = 'published' AND c.published_entry_id <> ''`,
      [teamId, kbId]
    );
    return rows.map((row) => String(row.published_entry_id || "")).filter(Boolean);
  }

  /** 删除库后把该库候选退回 `approved`：与单条撤回同语义（插件侧已归档、CRM 保留留痕）。 */
  async markCandidatesRevokedByKnowledgeBase(teamId: string, kbId: string, reviewedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE kb_training_candidates c
         JOIN kb_training_runs r ON r.id = c.run_id AND r.team_id = c.team_id
          SET c.status = 'approved', c.reviewed_by = ?, c.reviewed_at = ?
        WHERE c.team_id = ? AND r.kb_id = ? AND c.status = 'published'`,
      [reviewedBy, new Date(), teamId, kbId]
    );
  }

  /**
   * 物理删除知识库：库行 + **所有人**的启用行 + 批次的归库标记，同一事务。
   *
   * 批次与候选**不删**：`kb_training_runs.kb_id` 置空后它们回到「历史批次未归库」，
   * 原文与训练留痕都还在，用户以后可以把候选重新发布到别的库。
   * 也正因如此，删除前必须先把插件侧条目归档（见 service 的 `deleteKnowledgeBase`）。
   */
  async deleteKnowledgeBase(
    id: string,
    teamId: string,
    ownerId: string
  ): Promise<{ deleted: boolean; runsDetached: number }> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(
        "SELECT owner_id FROM kb_knowledge_bases WHERE id = ? AND team_id = ? FOR UPDATE",
        [id, teamId]
      );
      // 只有创建者能删：别人的公开库可以勾选启用，但不能被你删掉。
      if (!rows[0] || String(rows[0].owner_id) !== ownerId) {
        await connection.rollback();
        return { deleted: false, runsDetached: 0 };
      }
      await connection.query("DELETE FROM kb_user_knowledge_bases WHERE kb_id = ?", [id]);
      const [detached] = await connection.query<ResultSetHeader>(
        "UPDATE kb_training_runs SET kb_id = '' WHERE team_id = ? AND kb_id = ?",
        [teamId, id]
      );
      await connection.query("DELETE FROM kb_knowledge_bases WHERE id = ? AND team_id = ?", [id, teamId]);
      await connection.commit();
      return { deleted: true, runsDetached: Number(detached.affectedRows ?? 0) };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /** 当前账号的启用清单（顺序稳定，便于前端 diff）。 */
  async listEnabledKnowledgeBaseIds(userId: string): Promise<string[]> {    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT kb_id FROM kb_user_knowledge_bases WHERE user_id = ? ORDER BY created_at, kb_id",
      [userId]
    );
    return rows.map((row) => String(row.kb_id));
  }

  /**
   * 覆盖式保存启用清单（删旧插新，同一事务）。
   *
   * ⚠️ 传进来的 id 必须已经过 `listKnowledgeBases` 可见性校验 —— 这里**不做**权限判断，
   * 只负责落库，避免"一处校验两处逻辑"。路由层负责把不可见的 id 挑出来拒绝。
   *
   * 空清单是合法状态（= 不用任何知识库出稿），此时**仍会清空**，由 CRM 决定要不要提示。
   */
  async setEnabledKnowledgeBases(userId: string, teamId: string, kbIds: string[]): Promise<string[]> {
    const unique = [...new Set(kbIds.filter(Boolean))];
    const now = new Date();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.query("DELETE FROM kb_user_knowledge_bases WHERE user_id = ?", [userId]);
      for (const kbId of unique) {
        await connection.query(
          "INSERT IGNORE INTO kb_user_knowledge_bases (user_id, team_id, kb_id, created_at) VALUES (?, ?, ?, ?)",
          [userId, teamId, kbId, now]
        );
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return unique;
  }

  // -------------------------------------------------------------------------
  // 批次
  // -------------------------------------------------------------------------

  async createRun(input: KbTrainingRunInput): Promise<KbTrainingRun> {
    const now = new Date();
    const run: KbTrainingRun = {
      id: `kbr_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      teamId: input.teamId,
      ownerId: input.ownerId,
      kbId: input.kbId,
      sourcesJson: input.sourcesJson,
      status: "running",
      engine: "none",
      model: "",
      stats: { ...EMPTY_STATS },
      progress: null,
      pendingCount: 0,
      errorMessage: "",
      createdAt: now.toISOString(),
      finishedAt: ""
    };
    await this.pool.query(
      `INSERT INTO kb_training_runs
        (id, team_id, owner_id, kb_id, sources_json, status, engine, model, stats_json, error_message, created_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [run.id, run.teamId, run.ownerId, run.kbId, run.sourcesJson, run.status, run.engine, run.model,
        JSON.stringify(run.stats), run.errorMessage, now]
    );
    return run;
  }

  /** 收尾：把**实际生效**的引擎/模型与账本落库。降级不隐藏，engine='none' 也要如实写。 */
  async finishRun(
    id: string,
    patch: { status: KbTrainingRunStatus; engine: KbTrainingEngine; model: string; stats: KbTrainingStats; errorMessage?: string }
  ): Promise<void> {
    await this.pool.query(
      `UPDATE kb_training_runs SET status = ?, engine = ?, model = ?, stats_json = ?, error_message = ?, finished_at = ?
       WHERE id = ?`,
      [patch.status, patch.engine, patch.model, JSON.stringify(patch.stats), patch.errorMessage || "", new Date(), id]
    );
  }

  async listRuns(teamId: string, limit = 30): Promise<KbTrainingRun[]> {
    const capped = Math.min(Math.max(limit, 1), 200);
    // pending_count 用子查询一次带出：界面要用它回答「哪一批还有待确认」，
    // 逐批再打一次 count 会让 30 条列表变成 30 次往返。
    const [rows] = await this.pool.query<RunRow[]>(
      `SELECT r.*, (SELECT COUNT(*) FROM kb_training_candidates c
                    WHERE c.run_id = r.id AND c.team_id = r.team_id AND c.status = 'pending') AS pending_count
       FROM kb_training_runs r WHERE r.team_id = ? ORDER BY r.created_at DESC LIMIT ${capped}`,
      [teamId]
    );
    return rows.map(mapRun);
  }

  async getRun(id: string, teamId: string): Promise<KbTrainingRun | null> {
    const [rows] = await this.pool.query<RunRow[]>(
      `SELECT r.*, (SELECT COUNT(*) FROM kb_training_candidates c
                    WHERE c.run_id = r.id AND c.team_id = r.team_id AND c.status = 'pending') AS pending_count
       FROM kb_training_runs r WHERE r.id = ? AND r.team_id = ? LIMIT 1`,
      [id, teamId]
    );
    return rows[0] ? mapRun(rows[0]) : null;
  }

  /**
   * 写进度。整对象覆盖（不做增量 SQL）：进度本来就是「当前快照」，
   * 增量在并发下会拼出「已处理 40 / 共 20」这类自相矛盾的数字。
   */
  async saveRunProgress(id: string, progress: KbTrainingProgress): Promise<void> {
    await this.pool.query("UPDATE kb_training_runs SET progress_json = ? WHERE id = ?", [
      JSON.stringify(progress), id
    ]);
  }

  /** 请求取消：只打标记，真正停在哪一步由执行器决定（正在飞的那次模型调用不强行中断）。 */
  async requestRunCancel(id: string, teamId: string): Promise<boolean> {
    const [result] = await this.pool.query<ResultSetHeader>(
      "UPDATE kb_training_runs SET cancel_requested = 1 WHERE id = ? AND team_id = ? AND status = 'running'",
      [id, teamId]
    );
    return result.affectedRows > 0;
  }

  async isRunCancelRequested(id: string): Promise<boolean> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT cancel_requested FROM kb_training_runs WHERE id = ? LIMIT 1",
      [id]
    );
    return Number(rows[0]?.cancel_requested ?? 0) === 1;
  }

  /** 某个知识库里**已发布**的条目（知识库详情弹窗用）：逐条可撤回，不再只能看一个总数。 */
  async listPublishedCandidatesByKnowledgeBase(teamId: string, kbId: string, limit = 200): Promise<KbTrainingCandidate[]> {
    const capped = Math.min(Math.max(limit, 1), 500);
    const [rows] = await this.pool.query<CandidateRow[]>(
      `SELECT c.* FROM kb_training_candidates c
       JOIN kb_training_runs r ON r.id = c.run_id AND r.team_id = c.team_id
       WHERE c.team_id = ? AND r.kb_id = ? AND c.status = 'published'
       ORDER BY c.created_at DESC LIMIT ${capped}`,
      [teamId, kbId]
    );
    return rows.map(mapCandidate);
  }

  /**
   * 批次 → 知识库。发布时必须逐条带上 kbId，插件才知道这条语料属于哪个库，
   * 「按启用清单出稿」才有落点。一次查完，避免 N 条候选打 N 次库。
   */
  async mapRunKnowledgeBaseIds(teamId: string, runIds: string[]): Promise<Map<string, string>> {
    const ids = [...new Set(runIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => "?").join(", ");
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, kb_id FROM kb_training_runs WHERE team_id = ? AND id IN (${placeholders})`,
      [teamId, ...ids]
    );
    return new Map(rows.map((row) => [String(row.id), String(row.kb_id || "")]));
  }

  // -------------------------------------------------------------------------
  // 候选池
  // -------------------------------------------------------------------------

  /**
   * 入池。撞 `(team_id, fingerprint)` 时返回既有那条 —— 反复训练同一份资料
   * 不该让库膨胀（与插件侧 save() 的幂等姿态一致）。
   */
  async insertCandidate(input: KbTrainingCandidateInput): Promise<{ candidate: KbTrainingCandidate; duplicate: boolean }> {
    const existing = await this.findCandidateByFingerprint(input.teamId, input.fingerprint);
    if (existing) return { candidate: existing, duplicate: true };
    const now = new Date();
    const id = `kbc_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await this.pool.query(
      `INSERT INTO kb_training_candidates
        (id, run_id, team_id, owner_id, kind, question, answer, tags_json, languages_json, confidence,
         source_type, source_ref_json, rationale, gap_flag, fingerprint, status, published_entry_id,
         reviewed_by, reviewed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', NULL, ?)`,
      [id, input.runId, input.teamId, input.ownerId, input.kind, input.question, input.answer,
        JSON.stringify(input.tags), JSON.stringify(input.languages), input.confidence,
        input.sourceType, input.sourceRef ? JSON.stringify(input.sourceRef) : null, input.rationale,
        input.gapFlag ? 1 : 0, input.fingerprint, input.status, now]
    );
    const created = await this.getCandidate(id, input.teamId);
    // 理论上不会为空；真为空说明写库与回读之间发生了竞态，此处如实抛错而不是返回假对象。
    if (!created) throw new Error("候选写入后回读失败");
    return { candidate: created, duplicate: false };
  }

  async findCandidateByFingerprint(teamId: string, fingerprint: string): Promise<KbTrainingCandidate | null> {
    const [rows] = await this.pool.query<CandidateRow[]>(
      "SELECT * FROM kb_training_candidates WHERE team_id = ? AND fingerprint = ? LIMIT 1",
      [teamId, fingerprint]
    );
    return rows[0] ? mapCandidate(rows[0]) : null;
  }

  async getCandidate(id: string, teamId: string): Promise<KbTrainingCandidate | null> {
    const [rows] = await this.pool.query<CandidateRow[]>(
      "SELECT * FROM kb_training_candidates WHERE id = ? AND team_id = ? LIMIT 1",
      [id, teamId]
    );
    return rows[0] ? mapCandidate(rows[0]) : null;
  }

  async listCandidates(
    teamId: string,
    filter: { status?: string; runId?: string; kind?: string; gapOnly?: boolean; limit?: number; offset?: number } = {}
  ): Promise<KbTrainingCandidate[]> {
    const conditions = ["team_id = ?"];
    const params: unknown[] = [teamId];
    if (filter.status && filter.status !== "all") { conditions.push("status = ?"); params.push(filter.status); }
    if (filter.runId) { conditions.push("run_id = ?"); params.push(filter.runId); }
    if (filter.kind && filter.kind !== "all") { conditions.push("kind = ?"); params.push(filter.kind); }
    if (filter.gapOnly) conditions.push("gap_flag = 1");
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100);
    const offset = Math.max(filter.offset ?? 0, 0);
    const [rows] = await this.pool.query<CandidateRow[]>(
      `SELECT * FROM kb_training_candidates WHERE ${conditions.join(" AND ")}
       ORDER BY (confidence IS NULL), confidence DESC, created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    return rows.map(mapCandidate);
  }

  /** 按 id 批量取（review / publish 用；沿用 team_id 隔离，杜绝越权改别人的候选）。 */
  async listCandidatesByIds(teamId: string, ids: string[]): Promise<KbTrainingCandidate[]> {
    const unique = [...new Set(ids.filter(Boolean))].slice(0, 100);
    if (!unique.length) return [];
    const placeholders = unique.map(() => "?").join(", ");
    const [rows] = await this.pool.query<CandidateRow[]>(
      `SELECT * FROM kb_training_candidates WHERE team_id = ? AND id IN (${placeholders})`,
      [teamId, ...unique]
    );
    return rows.map(mapCandidate);
  }

  async countCandidatesByRun(
    teamId: string,
    runId: string
  ): Promise<{ total: number; pending: number; approved: number; rejected: number; published: number }> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total,
              SUM(status = 'pending') AS pending,
              SUM(status = 'approved') AS approved,
              SUM(status = 'rejected') AS rejected,
              SUM(status = 'published') AS published
       FROM kb_training_candidates WHERE team_id = ? AND run_id = ?`,
      [teamId, runId]
    );
    const row = rows[0] as {
      total?: number;
      pending?: number | null;
      approved?: number | null;
      rejected?: number | null;
      published?: number | null;
    } | undefined;
    // 四态全给：界面那行「待确认 / 已确认 / 已发布 / 已丢弃」按状态数对齐，
    // 少给一个就会让界面上的数字恒为 0（曾经只给了 pending/published）。
    return {
      total: Number(row?.total ?? 0),
      pending: Number(row?.pending ?? 0),
      approved: Number(row?.approved ?? 0),
      rejected: Number(row?.rejected ?? 0),
      published: Number(row?.published ?? 0)
    };
  }

  /** 人工校订 + 状态流转。edits 只允许改内容字段（出处与指纹不允许被界面改写）。 */
  async reviewCandidates(
    teamId: string,
    ids: string[],
    action: "confirm" | "drop",
    edits: Array<{ id: string; question?: string; answer?: string; tags?: string[] }>,
    reviewedBy: string
  ): Promise<KbTrainingCandidate[]> {
    const targets = await this.listCandidatesByIds(teamId, ids);
    const editMap = new Map(edits.map((edit) => [edit.id, edit]));
    const updated: KbTrainingCandidate[] = [];
    for (const target of targets) {
      // 已发布的条目不在「确认/丢弃」里改状态：那要走 revoke，否则血缘断掉。
      if (target.status === "published") {
        updated.push(target);
        continue;
      }
      const edit = editMap.get(target.id);
      const question = edit?.question !== undefined ? edit.question : target.question;
      const answer = edit?.answer !== undefined ? edit.answer : target.answer;
      const tags = edit?.tags !== undefined ? edit.tags : target.tags;
      const status: KbCandidateStatus = action === "confirm" ? "approved" : "rejected";
      // 内容被改过就重算指纹 —— 否则「改完再训同一份资料」会被旧指纹误判成重复。
      const fingerprint = candidateFingerprint(target.kind, question, answer);
      await this.pool.query(
        `UPDATE kb_training_candidates SET question = ?, answer = ?, tags_json = ?, fingerprint = ?,
           status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND team_id = ?`,
        [question, answer, JSON.stringify(tags), fingerprint, status, reviewedBy, new Date(), target.id, teamId]
      );
      const fresh = await this.getCandidate(target.id, teamId);
      if (fresh) updated.push(fresh);
    }
    return updated;
  }

  async markCandidatePublished(id: string, teamId: string, publishedEntryId: string, reviewedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE kb_training_candidates SET status = 'published', published_entry_id = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND team_id = ?`,
      [publishedEntryId, reviewedBy, new Date(), id, teamId]
    );
  }

  /** 撤回：插件侧已置 archived（留痕），CRM 侧退回 approved 并保留 published_entry_id 供追溯。 */
  async markCandidateRevoked(id: string, teamId: string, reviewedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE kb_training_candidates SET status = 'approved', reviewed_by = ?, reviewed_at = ?
       WHERE id = ? AND team_id = ?`,
      [reviewedBy, new Date(), id, teamId]
    );
  }

  // -------------------------------------------------------------------------
  // 黄金问法（P4 的成绩单基线；表先建好，P1 不用）
  // -------------------------------------------------------------------------

  async listGolden(teamId: string, enabledOnly = true): Promise<KbGoldenQuery[]> {
    const [rows] = await this.pool.query<GoldenRow[]>(
      `SELECT * FROM kb_golden_queries WHERE team_id = ?${enabledOnly ? " AND enabled = 1" : ""} ORDER BY created_at ASC`,
      [teamId]
    );
    return rows.map(mapGolden);
  }

  async insertGolden(input: { teamId: string; ownerId: string; question: string; expectKinds: string; expectSourceRef?: KbTrainingSourceRef | null }): Promise<KbGoldenQuery> {
    const now = new Date();
    const id = `kbg_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    await this.pool.query(
      `INSERT INTO kb_golden_queries (id, team_id, owner_id, question, expect_kinds, expect_source_ref_json, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      [id, input.teamId, input.ownerId, input.question, input.expectKinds || "",
        input.expectSourceRef ? JSON.stringify(input.expectSourceRef) : null, now]
    );
    return {
      id,
      teamId: input.teamId,
      ownerId: input.ownerId,
      question: input.question,
      expectKinds: input.expectKinds || "",
      expectSourceRef: input.expectSourceRef ?? null,
      enabled: true,
      createdAt: now.toISOString()
    };
  }
}

let activeKbTrainingRepository: MysqlKbTrainingRepository | null = null;

export function setKbTrainingRepository(repository: MysqlKbTrainingRepository | null): void {
  activeKbTrainingRepository = repository;
}

export function getKbTrainingRepository(): MysqlKbTrainingRepository | null {
  return activeKbTrainingRepository;
}
