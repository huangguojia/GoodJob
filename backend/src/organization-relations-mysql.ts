import mysql from "mysql2/promise";
import {
  buildOrganizationAliasFact,
  buildOrganizationRelationFact,
  organizationAliasFactHash,
  OrganizationRelationError,
  organizationRelationFactHash,
  type RecordOrganizationAliasInput,
  type RecordOrganizationAliasResult,
  type RecordOrganizationRelationInput,
  type RecordOrganizationRelationResult
} from "./organization-relations.js";
import type { CrmStore } from "./store.js";
import type {
  OrganizationAliasFact,
  OrganizationRelationFact
} from "./types.js";

type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;

export interface OrganizationRelationState {
  organizationAliasFacts: OrganizationAliasFact[];
  organizationRelationFacts: OrganizationRelationFact[];
}

function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("企业别名或关系事实包含无效时间");
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

function verifyAlias(fact: OrganizationAliasFact) {
  const { factHash, ...base } = fact;
  if (factHash !== organizationAliasFactHash(base)) {
    throw new Error("企业别名事实完整性校验失败");
  }
  return fact;
}

function verifyRelation(fact: OrganizationRelationFact) {
  const { factHash, ...base } = fact;
  if (factHash !== organizationRelationFactHash(base)) {
    throw new Error("企业关系事实完整性校验失败");
  }
  return fact;
}

export async function ensureOrganizationRelationSchema(pool: mysql.Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organization_alias_facts (
      id VARCHAR(90) PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      organization_id VARCHAR(90) NOT NULL,
      alias_type VARCHAR(30) NOT NULL,
      alias_name VARCHAR(300) NOT NULL,
      normalized_alias VARCHAR(300) NOT NULL,
      locale VARCHAR(40) NOT NULL DEFAULT '',
      jurisdiction VARCHAR(100) NOT NULL DEFAULT '',
      source_label VARCHAR(120) NOT NULL,
      source_reference VARCHAR(500) NOT NULL DEFAULT '',
      evidence_summary VARCHAR(1000) NOT NULL,
      verification_status VARCHAR(20) NOT NULL,
      observed_at DATETIME(3) NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      fact_key_hash CHAR(64) NOT NULL,
      fact_hash CHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_organization_alias_fact_key (team_id, fact_key_hash),
      KEY idx_organization_alias_profile (
        team_id, organization_id, observed_at
      ),
      KEY idx_organization_alias_lookup (
        team_id, normalized_alias
      ),
      CONSTRAINT fk_organization_alias_organization
        FOREIGN KEY (organization_id)
        REFERENCES organizations(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT chk_organization_alias_type CHECK (
        alias_type IN (
          'legal_name', 'trading_name', 'brand',
          'previous_name', 'localized_name'
        )
      ),
      CONSTRAINT chk_organization_alias_verification CHECK (
        verification_status IN ('reported', 'verified')
      )
    ) ENGINE=InnoDB
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organization_relation_facts (
      id VARCHAR(90) PRIMARY KEY,
      team_id VARCHAR(64) NOT NULL,
      source_organization_id VARCHAR(90) NOT NULL,
      target_organization_id VARCHAR(90) NOT NULL,
      relation_type VARCHAR(30) NOT NULL,
      source_label VARCHAR(120) NOT NULL,
      source_reference VARCHAR(500) NOT NULL DEFAULT '',
      evidence_summary VARCHAR(1000) NOT NULL,
      verification_status VARCHAR(20) NOT NULL,
      observed_at DATETIME(3) NOT NULL,
      created_by VARCHAR(64) NOT NULL,
      fact_key_hash CHAR(64) NOT NULL,
      fact_hash CHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_organization_relation_fact_key (team_id, fact_key_hash),
      KEY idx_organization_relation_source (
        team_id, source_organization_id, relation_type
      ),
      KEY idx_organization_relation_target (
        team_id, target_organization_id, relation_type
      ),
      CONSTRAINT fk_organization_relation_source
        FOREIGN KEY (source_organization_id)
        REFERENCES organizations(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT fk_organization_relation_target
        FOREIGN KEY (target_organization_id)
        REFERENCES organizations(id)
        ON UPDATE RESTRICT ON DELETE RESTRICT,
      CONSTRAINT chk_organization_relation_distinct
        CHECK (source_organization_id <> target_organization_id),
      CONSTRAINT chk_organization_relation_type CHECK (
        relation_type IN (
          'direct_parent', 'ultimate_parent', 'branch_of',
          'brand_of', 'affiliate'
        )
      ),
      CONSTRAINT chk_organization_relation_verification CHECK (
        verification_status IN ('reported', 'verified')
      )
    ) ENGINE=InnoDB
  `);
}

export async function loadOrganizationRelationState(
  source: QuerySource,
  teamId?: string
): Promise<OrganizationRelationState> {
  const where = teamId ? " WHERE team_id = ?" : "";
  const values = teamId ? [teamId] : [];
  const [aliasRows, relationRows] = await Promise.all([
    rows<Record<string, unknown>>(
      source,
      `SELECT * FROM organization_alias_facts${where}
       ORDER BY team_id, observed_at, id`,
      values
    ),
    rows<Record<string, unknown>>(
      source,
      `SELECT * FROM organization_relation_facts${where}
       ORDER BY team_id, observed_at, id`,
      values
    )
  ]);
  return {
    organizationAliasFacts: aliasRows.map((row) => verifyAlias({
      id: String(row.id),
      teamId: String(row.team_id),
      organizationId: String(row.organization_id),
      aliasType: String(row.alias_type) as OrganizationAliasFact["aliasType"],
      aliasName: String(row.alias_name),
      normalizedAlias: String(row.normalized_alias),
      locale: String(row.locale),
      jurisdiction: String(row.jurisdiction),
      sourceLabel: String(row.source_label),
      sourceReference: String(row.source_reference),
      evidenceSummary: String(row.evidence_summary),
      verificationStatus: String(
        row.verification_status
      ) as OrganizationAliasFact["verificationStatus"],
      observedAt: iso(row.observed_at),
      createdBy: String(row.created_by),
      factKeyHash: String(row.fact_key_hash),
      factHash: String(row.fact_hash),
      createdAt: iso(row.created_at)
    })),
    organizationRelationFacts: relationRows.map((row) => verifyRelation({
      id: String(row.id),
      teamId: String(row.team_id),
      sourceOrganizationId: String(row.source_organization_id),
      targetOrganizationId: String(row.target_organization_id),
      relationType: String(
        row.relation_type
      ) as OrganizationRelationFact["relationType"],
      sourceLabel: String(row.source_label),
      sourceReference: String(row.source_reference),
      evidenceSummary: String(row.evidence_summary),
      verificationStatus: String(
        row.verification_status
      ) as OrganizationRelationFact["verificationStatus"],
      observedAt: iso(row.observed_at),
      createdBy: String(row.created_by),
      factKeyHash: String(row.fact_key_hash),
      factHash: String(row.fact_hash),
      createdAt: iso(row.created_at)
    }))
  };
}

function replaceTeamState(
  store: CrmStore,
  teamId: string,
  state: OrganizationRelationState
) {
  store.organizationAliasFacts.splice(
    0,
    store.organizationAliasFacts.length,
    ...store.organizationAliasFacts.filter((item) => item.teamId !== teamId),
    ...structuredClone(state.organizationAliasFacts)
  );
  store.organizationRelationFacts.splice(
    0,
    store.organizationRelationFacts.length,
    ...store.organizationRelationFacts.filter(
      (item) => item.teamId !== teamId
    ),
    ...structuredClone(state.organizationRelationFacts)
  );
}

export async function ensureOrganizationRelationTeamCache(
  pool: mysql.Pool,
  store: CrmStore,
  teamId: string
) {
  replaceTeamState(
    store,
    teamId,
    await loadOrganizationRelationState(pool, teamId)
  );
}

async function requirePersistedOrganization(
  connection: mysql.PoolConnection,
  teamId: string,
  organizationId: string
) {
  const found = await rows<{ id: string }>(
    connection,
    `SELECT id FROM organizations
     WHERE id = ? AND team_id = ?
     FOR UPDATE`,
    [organizationId, teamId]
  );
  if (!found.length) {
    throw new OrganizationRelationError(
      "ORGANIZATION_NOT_FOUND",
      "企业不存在或无权访问",
      404
    );
  }
}

export async function recordOrganizationAliasMysql(
  pool: mysql.Pool,
  store: CrmStore,
  input: RecordOrganizationAliasInput
): Promise<RecordOrganizationAliasResult> {
  const connection = await pool.getConnection();
  let built: RecordOrganizationAliasResult | null = null;
  try {
    await connection.beginTransaction();
    const persisted = await loadOrganizationRelationState(
      connection,
      input.user.teamId
    );
    const transactionStore: CrmStore = {
      ...store,
      organizationAliasFacts: persisted.organizationAliasFacts,
      organizationRelationFacts: persisted.organizationRelationFacts
    };
    built = buildOrganizationAliasFact(transactionStore, input);
    await requirePersistedOrganization(
      connection,
      input.user.teamId,
      built.alias.organizationId
    );
    if (!built.replayed) {
      const alias = built.alias;
      await connection.query(
        `INSERT INTO organization_alias_facts (
          id, team_id, organization_id, alias_type, alias_name,
          normalized_alias, locale, jurisdiction, source_label,
          source_reference, evidence_summary, verification_status,
          observed_at, created_by, fact_key_hash, fact_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          alias.id,
          alias.teamId,
          alias.organizationId,
          alias.aliasType,
          alias.aliasName,
          alias.normalizedAlias,
          alias.locale,
          alias.jurisdiction,
          alias.sourceLabel,
          alias.sourceReference,
          alias.evidenceSummary,
          alias.verificationStatus,
          new Date(alias.observedAt),
          alias.createdBy,
          alias.factKeyHash,
          alias.factHash,
          new Date(alias.createdAt)
        ]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  if (!built) throw new Error("企业别名事务未生成结果");
  const state = await loadOrganizationRelationState(pool, input.user.teamId);
  replaceTeamState(store, input.user.teamId, state);
  const alias = state.organizationAliasFacts.find(
    (item) => item.factKeyHash === built!.alias.factKeyHash
  );
  if (!alias) throw new Error("企业别名提交后无法读取");
  return { alias, replayed: built.replayed };
}

export async function recordOrganizationRelationMysql(
  pool: mysql.Pool,
  store: CrmStore,
  input: RecordOrganizationRelationInput
): Promise<RecordOrganizationRelationResult> {
  const connection = await pool.getConnection();
  let built: RecordOrganizationRelationResult | null = null;
  try {
    await connection.beginTransaction();
    const persisted = await loadOrganizationRelationState(
      connection,
      input.user.teamId
    );
    const transactionStore: CrmStore = {
      ...store,
      organizationAliasFacts: persisted.organizationAliasFacts,
      organizationRelationFacts: persisted.organizationRelationFacts
    };
    built = buildOrganizationRelationFact(transactionStore, input);
    await requirePersistedOrganization(
      connection,
      input.user.teamId,
      built.relation.sourceOrganizationId
    );
    await requirePersistedOrganization(
      connection,
      input.user.teamId,
      built.relation.targetOrganizationId
    );
    if (!built.replayed) {
      const relation = built.relation;
      await connection.query(
        `INSERT INTO organization_relation_facts (
          id, team_id, source_organization_id, target_organization_id,
          relation_type, source_label, source_reference, evidence_summary,
          verification_status, observed_at, created_by, fact_key_hash,
          fact_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          relation.id,
          relation.teamId,
          relation.sourceOrganizationId,
          relation.targetOrganizationId,
          relation.relationType,
          relation.sourceLabel,
          relation.sourceReference,
          relation.evidenceSummary,
          relation.verificationStatus,
          new Date(relation.observedAt),
          relation.createdBy,
          relation.factKeyHash,
          relation.factHash,
          new Date(relation.createdAt)
        ]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  if (!built) throw new Error("企业关系事务未生成结果");
  const state = await loadOrganizationRelationState(pool, input.user.teamId);
  replaceTeamState(store, input.user.teamId, state);
  const relation = state.organizationRelationFacts.find(
    (item) => item.factKeyHash === built!.relation.factKeyHash
  );
  if (!relation) throw new Error("企业关系提交后无法读取");
  return { relation, replayed: built.replayed };
}
