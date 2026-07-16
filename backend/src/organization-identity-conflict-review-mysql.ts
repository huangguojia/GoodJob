import mysql from "mysql2/promise";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  buildOrganizationIdentityConflictReview,
  OrganizationIdentityConflictReviewError,
  organizationCanonicalMappingHash,
  organizationIdentityConflictEtag,
  organizationIdentityConflictReviewHash,
  type ReviewOrganizationIdentityConflictInput,
  type ReviewOrganizationIdentityConflictResult
} from "./organization-identity-conflict-review.js";
import type { CrmStore } from "./store.js";
import type {
  OrganizationCanonicalMapping,
  OrganizationIdentityConflictReview
} from "./types.js";

type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;

export interface OrganizationIdentityConflictReviewState {
  organizationIdentityConflictReviews: OrganizationIdentityConflictReview[];
  organizationCanonicalMappings: OrganizationCanonicalMapping[];
}

function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("企业身份复核记录包含无效时间");
  }
  return date.toISOString();
}

async function rows<T>(
  source: QuerySource,
  sql: string,
  values: unknown[] = []
) {
  const [result] = await source.query(sql, values);
  return result as T[];
}

function verifyReview(review: OrganizationIdentityConflictReview) {
  const { reviewHash, ...base } = review;
  if (reviewHash !== organizationIdentityConflictReviewHash(base)) {
    throw new Error("企业身份冲突复核记录完整性校验失败");
  }
  return review;
}

function verifyMapping(mapping: OrganizationCanonicalMapping) {
  const { mappingHash, ...base } = mapping;
  if (mappingHash !== organizationCanonicalMappingHash(base)) {
    throw new Error("规范企业映射完整性校验失败");
  }
  return mapping;
}

export async function ensureOrganizationIdentityConflictReviewSchema(
  pool: mysql.Pool
) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organization_identity_conflict_reviews (
      id VARCHAR(90) PRIMARY KEY,
      conflict_id VARCHAR(90) NOT NULL,
      team_id VARCHAR(64) NOT NULL,
      action VARCHAR(30) NOT NULL,
      canonical_organization_id VARCHAR(90) NOT NULL DEFAULT '',
      note VARCHAR(1000) NOT NULL,
      reviewed_by VARCHAR(64) NOT NULL,
      review_hash CHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_oi_conflict_review_conflict (conflict_id),
      KEY idx_oi_conflict_review_team_created (team_id, created_at),
      CONSTRAINT fk_oi_conflict_review_conflict
        FOREIGN KEY (conflict_id)
        REFERENCES organization_identity_conflicts(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT chk_oi_conflict_review_action
        CHECK (action IN ('keep_separate', 'merge')),
      CONSTRAINT chk_oi_conflict_review_canonical CHECK (
        (action = 'keep_separate' AND canonical_organization_id = '')
        OR (action = 'merge' AND canonical_organization_id <> '')
      )
    ) ENGINE=InnoDB
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organization_canonical_mappings (
      id VARCHAR(90) PRIMARY KEY,
      conflict_id VARCHAR(90) NOT NULL,
      team_id VARCHAR(64) NOT NULL,
      source_organization_id VARCHAR(90) NOT NULL,
      canonical_organization_id VARCHAR(90) NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      mapping_hash CHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_organization_canonical_source (
        team_id, source_organization_id
      ),
      KEY idx_organization_canonical_target (
        team_id, canonical_organization_id
      ),
      KEY idx_organization_canonical_conflict (conflict_id),
      CONSTRAINT fk_organization_canonical_conflict
        FOREIGN KEY (conflict_id)
        REFERENCES organization_identity_conflicts(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT fk_organization_canonical_source
        FOREIGN KEY (source_organization_id)
        REFERENCES organizations(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT fk_organization_canonical_target
        FOREIGN KEY (canonical_organization_id)
        REFERENCES organizations(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT chk_organization_canonical_distinct
        CHECK (source_organization_id <> canonical_organization_id)
    ) ENGINE=InnoDB
  `);
}

export async function loadOrganizationIdentityConflictReviewState(
  source: QuerySource,
  teamId?: string
): Promise<OrganizationIdentityConflictReviewState> {
  const where = teamId ? " WHERE team_id = ?" : "";
  const values = teamId ? [teamId] : [];
  const [reviewRows, mappingRows] = await Promise.all([
    rows<Record<string, unknown>>(
      source,
      `SELECT * FROM organization_identity_conflict_reviews${where}
       ORDER BY team_id, created_at, id`,
      values
    ),
    rows<Record<string, unknown>>(
      source,
      `SELECT * FROM organization_canonical_mappings${where}
       ORDER BY team_id, created_at, id`,
      values
    )
  ]);
  const reviews = reviewRows.map((row) => verifyReview({
    id: String(row.id),
    conflictId: String(row.conflict_id),
    teamId: String(row.team_id),
    action: String(row.action) as OrganizationIdentityConflictReview["action"],
    canonicalOrganizationId: String(row.canonical_organization_id),
    note: String(row.note),
    reviewedBy: String(row.reviewed_by),
    reviewHash: String(row.review_hash),
    createdAt: iso(row.created_at)
  }));
  const mappings = mappingRows.map((row) => verifyMapping({
    id: String(row.id),
    conflictId: String(row.conflict_id),
    teamId: String(row.team_id),
    sourceOrganizationId: String(row.source_organization_id),
    canonicalOrganizationId: String(row.canonical_organization_id),
    createdBy: String(row.created_by),
    mappingHash: String(row.mapping_hash),
    createdAt: iso(row.created_at)
  }));
  return {
    organizationIdentityConflictReviews: reviews,
    organizationCanonicalMappings: mappings
  };
}

function replaceTeamState(
  store: CrmStore,
  teamId: string,
  state: OrganizationIdentityConflictReviewState
) {
  store.organizationIdentityConflictReviews.splice(
    0,
    store.organizationIdentityConflictReviews.length,
    ...store.organizationIdentityConflictReviews.filter(
      (item) => item.teamId !== teamId
    ),
    ...structuredClone(state.organizationIdentityConflictReviews)
  );
  store.organizationCanonicalMappings.splice(
    0,
    store.organizationCanonicalMappings.length,
    ...store.organizationCanonicalMappings.filter(
      (item) => item.teamId !== teamId
    ),
    ...structuredClone(state.organizationCanonicalMappings)
  );
}

export async function ensureOrganizationIdentityConflictReviewTeamCache(
  pool: mysql.Pool,
  store: CrmStore,
  teamId: string
) {
  replaceTeamState(
    store,
    teamId,
    await loadOrganizationIdentityConflictReviewState(pool, teamId)
  );
}

export async function reviewOrganizationIdentityConflictMysql(
  pool: mysql.Pool,
  store: CrmStore,
  input: ReviewOrganizationIdentityConflictInput
): Promise<ReviewOrganizationIdentityConflictResult> {
  const connection = await pool.getConnection();
  let built: ReturnType<typeof buildOrganizationIdentityConflictReview> | null =
    null;
  try {
    await connection.beginTransaction();
    const conflictRows = await rows<{
      id: string;
      team_id: string;
    }>(
      connection,
      `SELECT id, team_id
       FROM organization_identity_conflicts
       WHERE id = ? AND team_id = ?
       FOR UPDATE`,
      [input.conflictId, input.user.teamId]
    );
    if (!conflictRows.length) {
      throw new OrganizationIdentityConflictReviewError(
        "IDENTITY_CONFLICT_NOT_FOUND",
        "企业身份冲突不存在或无权访问",
        404
      );
    }
    const organizationRows = await rows<{ organization_id: string }>(
      connection,
      `SELECT organization_id
       FROM organization_identity_conflict_organizations
       WHERE conflict_id = ? AND team_id = ?
       ORDER BY ordinal
       FOR UPDATE`,
      [input.conflictId, input.user.teamId]
    );
    const persistedState = await loadOrganizationIdentityConflictReviewState(
      connection,
      input.user.teamId
    );
    const conflict = store.organizationIdentityConflicts.find(
      (item) =>
        item.id === input.conflictId
        && item.teamId === input.user.teamId
    );
    if (!conflict) {
      throw new OrganizationIdentityConflictReviewError(
        "IDENTITY_CONFLICT_NOT_FOUND",
        "企业身份冲突缓存尚未就绪，请刷新后重试",
        409
      );
    }
    const transactionStore: CrmStore = {
      ...store,
      organizationIdentityConflicts: [{
        ...conflict,
        organizationIds: organizationRows.map((item) =>
          String(item.organization_id)
        )
      }],
      organizationIdentityConflictReviews:
        persistedState.organizationIdentityConflictReviews,
      organizationCanonicalMappings:
        persistedState.organizationCanonicalMappings
    };
    built = buildOrganizationIdentityConflictReview(transactionStore, input);
    for (const mapping of built.mappings) {
      await connection.query(
        `INSERT INTO organization_canonical_mappings (
          id, conflict_id, team_id, source_organization_id,
          canonical_organization_id, created_by, mapping_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mapping.id,
          mapping.conflictId,
          mapping.teamId,
          mapping.sourceOrganizationId,
          mapping.canonicalOrganizationId,
          mapping.createdBy,
          mapping.mappingHash,
          new Date(mapping.createdAt)
        ]
      );
    }
    await connection.query(
      `INSERT INTO organization_identity_conflict_reviews (
        id, conflict_id, team_id, action, canonical_organization_id,
        note, reviewed_by, review_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        built.review.id,
        built.review.conflictId,
        built.review.teamId,
        built.review.action,
        built.review.canonicalOrganizationId,
        built.review.note,
        built.review.reviewedBy,
        built.review.reviewHash,
        new Date(built.review.createdAt)
      ]
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    if (
      error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: string }).code === "ER_DUP_ENTRY"
    ) {
      throw new OrganizationIdentityConflictReviewError(
        "IDENTITY_CONFLICT_ALREADY_REVIEWED",
        "该企业身份冲突已被其他管理员处理，请刷新后查看",
        409
      );
    }
    throw error;
  } finally {
    connection.release();
  }
  if (!built) {
    throw new Error("企业身份冲突复核事务未生成提交结果");
  }

  const state = await loadOrganizationIdentityConflictReviewState(
    pool,
    input.user.teamId
  );
  replaceTeamState(store, input.user.teamId, state);
  const review = state.organizationIdentityConflictReviews.find(
    (item) => item.id === built.review.id
  );
  if (!review) {
    throw new Error(
      `企业身份冲突复核提交后无法读取：${canonicalJsonStringify({
        conflictId: input.conflictId,
        reviewId: built.review.id
      })}`
    );
  }
  return {
    review,
    mappings: state.organizationCanonicalMappings.filter(
      (item) => item.conflictId === input.conflictId
    ),
    revision: 2,
    etag: organizationIdentityConflictEtag(input.conflictId, 2)
  };
}
