import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes
} from "node:crypto";
import mysql from "mysql2/promise";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  ORGANIZATION_STRONG_IDENTITY_CONTRACT,
  OrganizationStrongIdentityError,
  normalizeOrganizationIdentityAuthorityProfile,
  organizationIdentityAuthorityProfileHash,
  organizationIdentityConflictRelationHash,
  organizationIdentityConflictRelations,
  organizationIdentityResolutionRelationHash,
  organizationIdentityResolutionRelations,
  resolveOrganizationStrongIdentity,
  validateOrganizationIdentityFacts
} from "./organization-strong-identity.js";
import type {
  OrganizationIdentityAuthorityProfile,
  ResolveOrganizationStrongIdentityPersistedInput,
  ResolveOrganizationStrongIdentityResult
} from "./organization-strong-identity.js";
import { PROSPECT_SOURCE_RAW_ENVELOPE_VERSION } from "./prospect-source-raw.js";
import type { CrmStore } from "./store.js";
import type {
  Organization,
  OrganizationAcceptedIdentifier,
  OrganizationIdentityClaim,
  OrganizationIdentityConflict,
  OrganizationIdentityEvent,
  OrganizationIdentityResolution,
  OrganizationSourceBinding,
  ProspectSourceRawRecord
} from "./types.js";

const PERSISTENCE_SCHEMA_VERSION = "organization-identity-mysql-v1";
const CANONICAL_VERSION = "canonical-json-v1";
const ENVELOPE_VERSION = "organization-identity-field-v1";
const HKDF_VERSION = "hkdf-sha256-v1";
const KEY_VERSION = "v1";
const SCHEMA_LOCK = "goodjob_organization_identity_schema_v1";
const FROZEN_TABLE_ENGINE = "InnoDB";
const HKDF_SALT = Buffer.from("goodjob-organization-identity-v1", "utf8");
const IDENTITY_TABLES = [
  "organizations",
  "organization_identity_claims",
  "organization_accepted_identifiers",
  "organization_identity_resolutions",
  "organization_source_bindings",
  "organization_identity_conflicts",
  "organization_identity_events",
  "organization_identity_contract_metadata",
  "organization_identity_team_guards",
  "organization_identity_authority_profiles",
  "organization_identity_resolution_identifiers",
  "organization_identity_resolution_bindings",
  "organization_identity_conflict_organizations",
  "organization_identity_conflict_keys"
] as const;
const IDENTITY_STATE_TABLES = IDENTITY_TABLES.filter(
  (table) => table !== "organization_identity_contract_metadata"
);

type QuerySource = Pick<mysql.Pool | mysql.PoolConnection, "query">;

type IdentitySecrets = {
  rawEnvelopeSecret: string;
  processingSecret: string;
  deterministicIdSecret: string;
  identifierLookupSecret: string;
  fieldEncryptionKey: Buffer;
  factIntegrityKey: Buffer;
  factIntegritySecret: string;
};

type NamedDuplicateRecoveryAction =
  | "processing_key"
  | "identifier_lookup"
  | "active_binding";

type NamedDuplicateRecoveryRule = {
  table: string;
  constraint: string;
  action: NamedDuplicateRecoveryAction;
};

const NAMED_DUPLICATE_RECOVERY_RULES: readonly NamedDuplicateRecoveryRule[] = [
  {
    table: "organization_identity_resolutions",
    constraint: "uk_oi_resolution_processing",
    action: "processing_key"
  },
  {
    table: "organization_accepted_identifiers",
    constraint: "uk_oi_identifier_lookup",
    action: "identifier_lookup"
  },
  {
    table: "organization_source_bindings",
    constraint: "uk_oi_binding_active_raw",
    action: "active_binding"
  }
];
const duplicateWriteTables = new WeakMap<object, string>();
const identityCacheVersions = new WeakMap<CrmStore, Map<string, number>>();
export type OrganizationIdentityTeamCacheStatus =
  | "fresh"
  | "stale"
  | "unavailable";
const identityCacheStatuses = new WeakMap<
  CrmStore,
  Map<string, OrganizationIdentityTeamCacheStatus>
>();

export type OrganizationIdentityState = {
  organizations: Organization[];
  organizationIdentityClaims: OrganizationIdentityClaim[];
  organizationAcceptedIdentifiers: OrganizationAcceptedIdentifier[];
  organizationIdentityResolutions: OrganizationIdentityResolution[];
  organizationSourceBindings: OrganizationSourceBinding[];
  organizationIdentityConflicts: OrganizationIdentityConflict[];
  organizationIdentityEvents: OrganizationIdentityEvent[];
};

type StoredRelationRows = {
  resolutionIdentifiers: Array<{
    resolutionId: string;
    teamId: string;
    ownerId: string;
    identifierId: string;
    role: "matched_existing" | "accepted_existing" | "accepted_new";
    ordinal: number;
  }>;
  resolutionBindings: Array<{
    resolutionId: string;
    teamId: string;
    ownerId: string;
    bindingId: string;
    role: "reused_existing" | "created_new";
    ordinal: number;
  }>;
  conflictOrganizations: Array<{
    conflictId: string;
    teamId: string;
    ownerId: string;
    organizationId: string;
    role: "identifier_match" | "existing_binding";
    ordinal: number;
  }>;
  conflictKeys: Array<{
    conflictId: string;
    teamId: string;
    ownerId: string;
    identifierKey: string;
    keyType: "identifier_exact" | "identifier_slot" | "raw_binding";
    ordinal: number;
  }>;
};

const EMPTY_STATE: OrganizationIdentityState = {
  organizations: [],
  organizationIdentityClaims: [],
  organizationAcceptedIdentifiers: [],
  organizationIdentityResolutions: [],
  organizationSourceBindings: [],
  organizationIdentityConflicts: [],
  organizationIdentityEvents: []
};

type IdentityStateSelection = {
  organizationIds: readonly string[];
  claimIds: readonly string[];
  identifierIds: readonly string[];
  resolutionIds: readonly string[];
  bindingIds: readonly string[];
  conflictIds: readonly string[];
};

type RawRecordScope = {
  ownerId: string;
  recordId: string;
};

type IdentityDecisionClosure = {
  rawRecords: ProspectSourceRawRecord[];
  state: OrganizationIdentityState;
};

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function frozenPersistedInput(
  input: ResolveOrganizationStrongIdentityPersistedInput
) {
  const snapshot = structuredClone(input);
  const resolvedAt = new Date(snapshot.resolvedAt);
  if (Number.isFinite(resolvedAt.getTime())) {
    snapshot.resolvedAt = resolvedAt.toISOString();
  }
  return deepFreeze(snapshot);
}

function frozenAuthorityProfile(
  profile: OrganizationIdentityAuthorityProfile
) {
  return deepFreeze(structuredClone(profile));
}

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS organization_identity_contract_metadata (
    id TINYINT PRIMARY KEY,
    resolver_contract_version VARCHAR(80) NOT NULL,
    persistence_schema_version VARCHAR(80) NOT NULL,
    canonical_version VARCHAR(40) NOT NULL,
    hash_algorithm VARCHAR(40) NOT NULL,
    encryption_algorithm VARCHAR(80) NOT NULL,
    envelope_version VARCHAR(80) NOT NULL,
    hkdf_version VARCHAR(80) NOT NULL,
    deterministic_id_version VARCHAR(80) NOT NULL,
    key_fingerprints_json TEXT NOT NULL,
    raw_key_fingerprint CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    metadata_mac CHAR(64) NOT NULL,
    CONSTRAINT chk_oi_metadata_singleton CHECK (id = 1),
    CONSTRAINT chk_oi_metadata_status CHECK (status = 'active')
  )`,
  `CREATE TABLE IF NOT EXISTS organization_identity_team_guards (
    team_id VARCHAR(64) PRIMARY KEY,
    guard_version BIGINT NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    CONSTRAINT chk_oi_team_guard_version CHECK (guard_version >= 1)
  )`,
  `CREATE TABLE IF NOT EXISTS organization_identity_authority_profiles (
    profile_code VARCHAR(120) NOT NULL,
    profile_version VARCHAR(80) NOT NULL,
    canonical_json MEDIUMTEXT NOT NULL,
    profile_hash CHAR(64) NOT NULL,
    profile_mac CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    PRIMARY KEY (profile_code, profile_version)
  )`,
  `CREATE TABLE IF NOT EXISTS organizations (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    scope_type VARCHAR(20) NOT NULL,
    scope_id VARCHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,
    legal_name_encrypted MEDIUMTEXT NOT NULL,
    normalized_name_encrypted MEDIUMTEXT NOT NULL,
    organization_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    UNIQUE KEY uk_oi_organization_team_id(team_id, id),
    CONSTRAINT chk_oi_organization_scope
      CHECK (scope_type = 'team' AND scope_id = team_id),
    CONSTRAINT chk_oi_organization_status CHECK (status = 'active')
  )`,
  `CREATE TABLE IF NOT EXISTS organization_identity_resolutions (
    id VARCHAR(90) PRIMARY KEY,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    raw_record_id VARCHAR(90) NOT NULL,
    raw_artifact_hash CHAR(64) NOT NULL,
    processing_key_hash CHAR(64) NOT NULL,
    claim_hash CHAR(64) NOT NULL,
    resolver_contract_version VARCHAR(80) NOT NULL,
    parser_version VARCHAR(200) NOT NULL,
    normalizer_version VARCHAR(200) NOT NULL,
    authority_profile_code VARCHAR(120) NOT NULL,
    authority_profile_version VARCHAR(80) NOT NULL,
    authority_profile_hash CHAR(64) NOT NULL,
    result VARCHAR(40) NOT NULL,
    decision_reason_code VARCHAR(120) NOT NULL,
    organization_id VARCHAR(90) NOT NULL,
    binding_id VARCHAR(90) NOT NULL,
    conflict_id VARCHAR(90) NOT NULL,
    relation_hash CHAR(64) NOT NULL,
    event_count INT NOT NULL,
    event_tail_hash CHAR(64) NOT NULL,
    resolution_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    UNIQUE KEY uk_oi_resolution_team_owner_id(team_id, owner_id, id),
    UNIQUE KEY uk_oi_resolution_processing(
      team_id, owner_id, processing_key_hash
    ),
    CONSTRAINT fk_oi_resolution_raw
      FOREIGN KEY (team_id, owner_id, raw_record_id)
      REFERENCES prospect_source_raw_records(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_oi_resolution_result CHECK (
      result IN ('new_entity','exact_match','insufficient_identity','conflict')
    ),
    CONSTRAINT chk_oi_resolution_events CHECK (event_count >= 1)
  )`,
  `CREATE TABLE IF NOT EXISTS organization_identity_claims (
    id VARCHAR(90) PRIMARY KEY,
    resolution_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    raw_record_id VARCHAR(90) NOT NULL,
    ordinal INT NOT NULL,
    kind VARCHAR(40) NOT NULL,
    original_value_encrypted MEDIUMTEXT NOT NULL,
    normalized_value_encrypted MEDIUMTEXT NOT NULL,
    scheme VARCHAR(200) NOT NULL,
    jurisdiction VARCHAR(40) NOT NULL,
    entity_type VARCHAR(40) NOT NULL,
    subject_ref_encrypted MEDIUMTEXT NOT NULL,
    classification VARCHAR(60) NOT NULL,
    normalizer_version VARCHAR(200) NOT NULL,
    validator_version VARCHAR(200) NOT NULL,
    authority_profile_code VARCHAR(120) NOT NULL,
    observed_at DATETIME(3) NOT NULL,
    claim_hash CHAR(64) NOT NULL,
    claim_fact_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    UNIQUE KEY uk_oi_claim_team_owner_id(team_id, owner_id, id),
    UNIQUE KEY uk_oi_claim_resolution_ordinal(
      team_id, owner_id, resolution_id, ordinal
    ),
    CONSTRAINT fk_oi_claim_resolution
      FOREIGN KEY (team_id, owner_id, resolution_id)
      REFERENCES organization_identity_resolutions(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_oi_claim_raw
      FOREIGN KEY (team_id, owner_id, raw_record_id)
      REFERENCES prospect_source_raw_records(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_oi_claim_ordinal CHECK (ordinal >= 1)
  )`,
  `CREATE TABLE IF NOT EXISTS organization_accepted_identifiers (
    id VARCHAR(90) PRIMARY KEY,
    organization_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    kind VARCHAR(40) NOT NULL,
    scheme VARCHAR(200) NOT NULL,
    jurisdiction VARCHAR(40) NOT NULL,
    normalized_value_encrypted MEDIUMTEXT NOT NULL,
    normalized_value_hash CHAR(64) NOT NULL,
    source_claim_id VARCHAR(90) NOT NULL,
    source_raw_record_id VARCHAR(90) NOT NULL,
    source_owner_id VARCHAR(64) NOT NULL,
    authority_profile_code VARCHAR(120) NOT NULL,
    authority_profile_version VARCHAR(80) NOT NULL,
    status VARCHAR(20) NOT NULL,
    identifier_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    UNIQUE KEY uk_oi_identifier_team_id(team_id, id),
    UNIQUE KEY uk_oi_identifier_lookup(
      team_id, kind, scheme, jurisdiction, normalized_value_hash
    ),
    CONSTRAINT fk_oi_identifier_organization
      FOREIGN KEY (team_id, organization_id)
      REFERENCES organizations(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_oi_identifier_claim
      FOREIGN KEY (team_id, source_owner_id, source_claim_id)
      REFERENCES organization_identity_claims(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_oi_identifier_raw
      FOREIGN KEY (team_id, source_owner_id, source_raw_record_id)
      REFERENCES prospect_source_raw_records(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_oi_identifier_status CHECK (status = 'active')
  )`,
  `CREATE TABLE IF NOT EXISTS organization_source_bindings (
    id VARCHAR(90) PRIMARY KEY,
    organization_id VARCHAR(90) NOT NULL,
    resolution_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    raw_record_id VARCHAR(90) NOT NULL,
    status VARCHAR(20) NOT NULL,
    binding_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    UNIQUE KEY uk_oi_binding_team_owner_id(team_id, owner_id, id),
    UNIQUE KEY uk_oi_binding_active_raw(
      team_id, owner_id, raw_record_id, status
    ),
    CONSTRAINT fk_oi_binding_organization
      FOREIGN KEY (team_id, organization_id)
      REFERENCES organizations(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_oi_binding_resolution
      FOREIGN KEY (team_id, owner_id, resolution_id)
      REFERENCES organization_identity_resolutions(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_oi_binding_raw
      FOREIGN KEY (team_id, owner_id, raw_record_id)
      REFERENCES prospect_source_raw_records(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_oi_binding_status CHECK (status = 'active')
  )`,
  `CREATE TABLE IF NOT EXISTS organization_identity_conflicts (
    id VARCHAR(90) PRIMARY KEY,
    resolution_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    raw_record_id VARCHAR(90) NOT NULL,
    conflict_type VARCHAR(60) NOT NULL,
    status VARCHAR(20) NOT NULL,
    relation_hash CHAR(64) NOT NULL,
    conflict_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    UNIQUE KEY uk_oi_conflict_team_owner_id(team_id, owner_id, id),
    UNIQUE KEY uk_oi_conflict_resolution(
      team_id, owner_id, resolution_id
    ),
    CONSTRAINT fk_oi_conflict_resolution
      FOREIGN KEY (team_id, owner_id, resolution_id)
      REFERENCES organization_identity_resolutions(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_oi_conflict_raw
      FOREIGN KEY (team_id, owner_id, raw_record_id)
      REFERENCES prospect_source_raw_records(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_oi_conflict_status CHECK (status = 'open')
  )`,
  `CREATE TABLE IF NOT EXISTS organization_identity_events (
    id VARCHAR(90) PRIMARY KEY,
    resolution_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    sequence_no INT NOT NULL,
    event_type VARCHAR(60) NOT NULL,
    organization_id VARCHAR(90) NOT NULL,
    detail_hash CHAR(64) NOT NULL,
    previous_event_hash CHAR(64) NOT NULL,
    event_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    UNIQUE KEY uk_oi_event_team_owner_id(team_id, owner_id, id),
    UNIQUE KEY uk_oi_event_resolution_sequence(
      team_id, owner_id, resolution_id, sequence_no
    ),
    CONSTRAINT fk_oi_event_resolution
      FOREIGN KEY (team_id, owner_id, resolution_id)
      REFERENCES organization_identity_resolutions(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_oi_event_sequence CHECK (sequence_no >= 1)
  )`,
  `CREATE TABLE IF NOT EXISTS organization_identity_resolution_identifiers (
    resolution_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    ordinal INT NOT NULL,
    identifier_id VARCHAR(90) NOT NULL,
    relation_role VARCHAR(40) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    PRIMARY KEY (team_id, owner_id, resolution_id, ordinal),
    UNIQUE KEY uk_oi_resolution_identifier_role(
      team_id, owner_id, resolution_id, identifier_id, relation_role
    ),
    CONSTRAINT fk_oi_resolution_identifier_resolution
      FOREIGN KEY (team_id, owner_id, resolution_id)
      REFERENCES organization_identity_resolutions(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_oi_resolution_identifier_identifier
      FOREIGN KEY (team_id, identifier_id)
      REFERENCES organization_accepted_identifiers(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_oi_resolution_identifier_ordinal CHECK (ordinal >= 1),
    CONSTRAINT chk_oi_resolution_identifier_role CHECK (
      relation_role IN (
        'matched_existing','accepted_existing','accepted_new'
      )
    )
  )`,
  `CREATE TABLE IF NOT EXISTS organization_identity_resolution_bindings (
    resolution_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    ordinal INT NOT NULL,
    binding_id VARCHAR(90) NOT NULL,
    relation_role VARCHAR(40) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    PRIMARY KEY (team_id, owner_id, resolution_id, ordinal),
    UNIQUE KEY uk_oi_resolution_binding_role(
      team_id, owner_id, resolution_id, binding_id, relation_role
    ),
    CONSTRAINT fk_oi_resolution_binding_resolution
      FOREIGN KEY (team_id, owner_id, resolution_id)
      REFERENCES organization_identity_resolutions(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_oi_resolution_binding_binding
      FOREIGN KEY (team_id, owner_id, binding_id)
      REFERENCES organization_source_bindings(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_oi_resolution_binding_ordinal CHECK (ordinal >= 1),
    CONSTRAINT chk_oi_resolution_binding_role CHECK (
      relation_role IN ('reused_existing','created_new')
    )
  )`,
  `CREATE TABLE IF NOT EXISTS organization_identity_conflict_organizations (
    conflict_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    ordinal INT NOT NULL,
    organization_id VARCHAR(90) NOT NULL,
    relation_role VARCHAR(40) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    PRIMARY KEY (team_id, owner_id, conflict_id, ordinal),
    CONSTRAINT fk_oi_conflict_organization_conflict
      FOREIGN KEY (team_id, owner_id, conflict_id)
      REFERENCES organization_identity_conflicts(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT fk_oi_conflict_organization_organization
      FOREIGN KEY (team_id, organization_id)
      REFERENCES organizations(team_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_oi_conflict_organization_ordinal CHECK (ordinal >= 1),
    CONSTRAINT chk_oi_conflict_organization_role CHECK (
      relation_role IN ('identifier_match','existing_binding')
    )
  )`,
  `CREATE TABLE IF NOT EXISTS organization_identity_conflict_keys (
    conflict_id VARCHAR(90) NOT NULL,
    team_id VARCHAR(64) NOT NULL,
    owner_id VARCHAR(64) NOT NULL,
    ordinal INT NOT NULL,
    key_type VARCHAR(40) NOT NULL,
    identifier_key_encrypted MEDIUMTEXT NOT NULL,
    identifier_key_hash CHAR(64) NOT NULL,
    row_mac CHAR(64) NOT NULL,
    PRIMARY KEY (team_id, owner_id, conflict_id, ordinal),
    CONSTRAINT fk_oi_conflict_key_conflict
      FOREIGN KEY (team_id, owner_id, conflict_id)
      REFERENCES organization_identity_conflicts(team_id, owner_id, id)
      ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT chk_oi_conflict_key_ordinal CHECK (ordinal >= 1),
    CONSTRAINT chk_oi_conflict_key_type CHECK (
      key_type IN ('identifier_exact','identifier_slot','raw_binding')
    )
  )`
].map((sql) => `${sql} ENGINE=${FROZEN_TABLE_ENGINE}`);

type SchemaIndex = {
  name: string;
  unique: boolean;
  columns: readonly string[];
};

type SchemaForeignKey = {
  name: string;
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly string[];
};

type SchemaCheck = {
  name: string;
  clause: string;
};

type TableSchemaManifest = {
  columns: readonly (readonly [name: string, columnType: string])[];
  indexes: readonly SchemaIndex[];
  foreignKeys?: readonly SchemaForeignKey[];
  checks?: readonly SchemaCheck[];
};

function schemaIndex(
  name: string,
  unique: boolean,
  ...columns: string[]
): SchemaIndex {
  return { name, unique, columns };
}

function schemaForeignKey(
  name: string,
  columns: string[],
  referencedTable: string,
  referencedColumns: string[]
): SchemaForeignKey {
  return { name, columns, referencedTable, referencedColumns };
}

function schemaCheck(name: string, clause: string): SchemaCheck {
  return { name, clause };
}

const RAW_RECORD_SCHEMA: TableSchemaManifest = {
  columns: [
    ["id", "varchar(90)"],
    ["team_id", "varchar(64)"],
    ["owner_id", "varchar(64)"],
    ["provider_code", "varchar(80)"],
    ["connection_id", "varchar(100)"],
    ["endpoint_code", "varchar(100)"],
    ["source_identity_hash", "char(64)"],
    ["artifact_hash", "char(64)"],
    ["envelope_version", "varchar(40)"],
    ["encrypted_envelope", "mediumtext"],
    ["envelope_hash", "char(64)"],
    ["first_observed_at", "datetime(3)"],
    ["record_hash", "char(64)"],
    ["created_at", "datetime(3)"]
  ],
  indexes: [
    schemaIndex("PRIMARY", true, "id"),
    schemaIndex("uk_ps_raw_record_team_id", true, "team_id", "id"),
    schemaIndex(
      "uk_ps_raw_record_team_owner_id",
      true,
      "team_id",
      "owner_id",
      "id"
    ),
    schemaIndex(
      "uk_ps_raw_record_version",
      true,
      "team_id",
      "owner_id",
      "provider_code",
      "connection_id",
      "endpoint_code",
      "source_identity_hash",
      "artifact_hash"
    )
  ],
  checks: [
    schemaCheck(
      "chk_ps_raw_record_envelope_version",
      "(envelope_version = 'provider-raw-v1')"
    )
  ]
};

const IDENTITY_SCHEMA: Record<
  (typeof IDENTITY_TABLES)[number],
  TableSchemaManifest
> = {
  organization_identity_contract_metadata: {
    columns: [
      ["id", "tinyint"],
      ["resolver_contract_version", "varchar(80)"],
      ["persistence_schema_version", "varchar(80)"],
      ["canonical_version", "varchar(40)"],
      ["hash_algorithm", "varchar(40)"],
      ["encryption_algorithm", "varchar(80)"],
      ["envelope_version", "varchar(80)"],
      ["hkdf_version", "varchar(80)"],
      ["deterministic_id_version", "varchar(80)"],
      ["key_fingerprints_json", "text"],
      ["raw_key_fingerprint", "char(64)"],
      ["status", "varchar(20)"],
      ["created_at", "datetime(3)"],
      ["metadata_mac", "char(64)"]
    ],
    indexes: [schemaIndex("PRIMARY", true, "id")],
    checks: [
      schemaCheck("chk_oi_metadata_singleton", "(id = 1)"),
      schemaCheck("chk_oi_metadata_status", "(status = 'active')")
    ]
  },
  organization_identity_team_guards: {
    columns: [
      ["team_id", "varchar(64)"],
      ["guard_version", "bigint"],
      ["updated_at", "datetime(3)"]
    ],
    indexes: [schemaIndex("PRIMARY", true, "team_id")],
    checks: [
      schemaCheck("chk_oi_team_guard_version", "(guard_version >= 1)")
    ]
  },
  organization_identity_authority_profiles: {
    columns: [
      ["profile_code", "varchar(120)"],
      ["profile_version", "varchar(80)"],
      ["canonical_json", "mediumtext"],
      ["profile_hash", "char(64)"],
      ["profile_mac", "char(64)"],
      ["created_at", "datetime(3)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex("PRIMARY", true, "profile_code", "profile_version")
    ]
  },
  organizations: {
    columns: [
      ["id", "varchar(90)"],
      ["team_id", "varchar(64)"],
      ["scope_type", "varchar(20)"],
      ["scope_id", "varchar(64)"],
      ["status", "varchar(20)"],
      ["legal_name_encrypted", "mediumtext"],
      ["normalized_name_encrypted", "mediumtext"],
      ["organization_hash", "char(64)"],
      ["created_at", "datetime(3)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex("PRIMARY", true, "id"),
      schemaIndex("uk_oi_organization_team_id", true, "team_id", "id")
    ],
    checks: [
      schemaCheck(
        "chk_oi_organization_scope",
        "((scope_type = 'team') AND (scope_id = team_id))"
      ),
      schemaCheck("chk_oi_organization_status", "(status = 'active')")
    ]
  },
  organization_identity_resolutions: {
    columns: [
      ["id", "varchar(90)"],
      ["team_id", "varchar(64)"],
      ["owner_id", "varchar(64)"],
      ["raw_record_id", "varchar(90)"],
      ["raw_artifact_hash", "char(64)"],
      ["processing_key_hash", "char(64)"],
      ["claim_hash", "char(64)"],
      ["resolver_contract_version", "varchar(80)"],
      ["parser_version", "varchar(200)"],
      ["normalizer_version", "varchar(200)"],
      ["authority_profile_code", "varchar(120)"],
      ["authority_profile_version", "varchar(80)"],
      ["authority_profile_hash", "char(64)"],
      ["result", "varchar(40)"],
      ["decision_reason_code", "varchar(120)"],
      ["organization_id", "varchar(90)"],
      ["binding_id", "varchar(90)"],
      ["conflict_id", "varchar(90)"],
      ["relation_hash", "char(64)"],
      ["event_count", "int"],
      ["event_tail_hash", "char(64)"],
      ["resolution_hash", "char(64)"],
      ["created_at", "datetime(3)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex("PRIMARY", true, "id"),
      schemaIndex(
        "fk_oi_resolution_raw",
        false,
        "team_id",
        "owner_id",
        "raw_record_id"
      ),
      schemaIndex(
        "uk_oi_resolution_processing",
        true,
        "team_id",
        "owner_id",
        "processing_key_hash"
      ),
      schemaIndex(
        "uk_oi_resolution_team_owner_id",
        true,
        "team_id",
        "owner_id",
        "id"
      )
    ],
    foreignKeys: [
      schemaForeignKey(
        "fk_oi_resolution_raw",
        ["team_id", "owner_id", "raw_record_id"],
        "prospect_source_raw_records",
        ["team_id", "owner_id", "id"]
      )
    ],
    checks: [
      schemaCheck(
        "chk_oi_resolution_result",
        "(result IN ('new_entity','exact_match',"
          + "'insufficient_identity','conflict'))"
      ),
      schemaCheck("chk_oi_resolution_events", "(event_count >= 1)")
    ]
  },
  organization_identity_claims: {
    columns: [
      ["id", "varchar(90)"],
      ["resolution_id", "varchar(90)"],
      ["team_id", "varchar(64)"],
      ["owner_id", "varchar(64)"],
      ["raw_record_id", "varchar(90)"],
      ["ordinal", "int"],
      ["kind", "varchar(40)"],
      ["original_value_encrypted", "mediumtext"],
      ["normalized_value_encrypted", "mediumtext"],
      ["scheme", "varchar(200)"],
      ["jurisdiction", "varchar(40)"],
      ["entity_type", "varchar(40)"],
      ["subject_ref_encrypted", "mediumtext"],
      ["classification", "varchar(60)"],
      ["normalizer_version", "varchar(200)"],
      ["validator_version", "varchar(200)"],
      ["authority_profile_code", "varchar(120)"],
      ["observed_at", "datetime(3)"],
      ["claim_hash", "char(64)"],
      ["claim_fact_hash", "char(64)"],
      ["created_at", "datetime(3)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex("PRIMARY", true, "id"),
      schemaIndex(
        "fk_oi_claim_raw",
        false,
        "team_id",
        "owner_id",
        "raw_record_id"
      ),
      schemaIndex(
        "uk_oi_claim_resolution_ordinal",
        true,
        "team_id",
        "owner_id",
        "resolution_id",
        "ordinal"
      ),
      schemaIndex(
        "uk_oi_claim_team_owner_id",
        true,
        "team_id",
        "owner_id",
        "id"
      )
    ],
    foreignKeys: [
      schemaForeignKey(
        "fk_oi_claim_resolution",
        ["team_id", "owner_id", "resolution_id"],
        "organization_identity_resolutions",
        ["team_id", "owner_id", "id"]
      ),
      schemaForeignKey(
        "fk_oi_claim_raw",
        ["team_id", "owner_id", "raw_record_id"],
        "prospect_source_raw_records",
        ["team_id", "owner_id", "id"]
      )
    ],
    checks: [schemaCheck("chk_oi_claim_ordinal", "(ordinal >= 1)")]
  },
  organization_accepted_identifiers: {
    columns: [
      ["id", "varchar(90)"],
      ["organization_id", "varchar(90)"],
      ["team_id", "varchar(64)"],
      ["kind", "varchar(40)"],
      ["scheme", "varchar(200)"],
      ["jurisdiction", "varchar(40)"],
      ["normalized_value_encrypted", "mediumtext"],
      ["normalized_value_hash", "char(64)"],
      ["source_claim_id", "varchar(90)"],
      ["source_raw_record_id", "varchar(90)"],
      ["source_owner_id", "varchar(64)"],
      ["authority_profile_code", "varchar(120)"],
      ["authority_profile_version", "varchar(80)"],
      ["status", "varchar(20)"],
      ["identifier_hash", "char(64)"],
      ["created_at", "datetime(3)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex("PRIMARY", true, "id"),
      schemaIndex(
        "fk_oi_identifier_claim",
        false,
        "team_id",
        "source_owner_id",
        "source_claim_id"
      ),
      schemaIndex(
        "fk_oi_identifier_organization",
        false,
        "team_id",
        "organization_id"
      ),
      schemaIndex(
        "fk_oi_identifier_raw",
        false,
        "team_id",
        "source_owner_id",
        "source_raw_record_id"
      ),
      schemaIndex(
        "uk_oi_identifier_lookup",
        true,
        "team_id",
        "kind",
        "scheme",
        "jurisdiction",
        "normalized_value_hash"
      ),
      schemaIndex("uk_oi_identifier_team_id", true, "team_id", "id")
    ],
    foreignKeys: [
      schemaForeignKey(
        "fk_oi_identifier_organization",
        ["team_id", "organization_id"],
        "organizations",
        ["team_id", "id"]
      ),
      schemaForeignKey(
        "fk_oi_identifier_claim",
        ["team_id", "source_owner_id", "source_claim_id"],
        "organization_identity_claims",
        ["team_id", "owner_id", "id"]
      ),
      schemaForeignKey(
        "fk_oi_identifier_raw",
        ["team_id", "source_owner_id", "source_raw_record_id"],
        "prospect_source_raw_records",
        ["team_id", "owner_id", "id"]
      )
    ],
    checks: [
      schemaCheck("chk_oi_identifier_status", "(status = 'active')")
    ]
  },
  organization_source_bindings: {
    columns: [
      ["id", "varchar(90)"],
      ["organization_id", "varchar(90)"],
      ["resolution_id", "varchar(90)"],
      ["team_id", "varchar(64)"],
      ["owner_id", "varchar(64)"],
      ["raw_record_id", "varchar(90)"],
      ["status", "varchar(20)"],
      ["binding_hash", "char(64)"],
      ["created_at", "datetime(3)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex("PRIMARY", true, "id"),
      schemaIndex(
        "fk_oi_binding_organization",
        false,
        "team_id",
        "organization_id"
      ),
      schemaIndex(
        "fk_oi_binding_resolution",
        false,
        "team_id",
        "owner_id",
        "resolution_id"
      ),
      schemaIndex(
        "uk_oi_binding_active_raw",
        true,
        "team_id",
        "owner_id",
        "raw_record_id",
        "status"
      ),
      schemaIndex(
        "uk_oi_binding_team_owner_id",
        true,
        "team_id",
        "owner_id",
        "id"
      )
    ],
    foreignKeys: [
      schemaForeignKey(
        "fk_oi_binding_organization",
        ["team_id", "organization_id"],
        "organizations",
        ["team_id", "id"]
      ),
      schemaForeignKey(
        "fk_oi_binding_resolution",
        ["team_id", "owner_id", "resolution_id"],
        "organization_identity_resolutions",
        ["team_id", "owner_id", "id"]
      ),
      schemaForeignKey(
        "fk_oi_binding_raw",
        ["team_id", "owner_id", "raw_record_id"],
        "prospect_source_raw_records",
        ["team_id", "owner_id", "id"]
      )
    ],
    checks: [schemaCheck("chk_oi_binding_status", "(status = 'active')")]
  },
  organization_identity_conflicts: {
    columns: [
      ["id", "varchar(90)"],
      ["resolution_id", "varchar(90)"],
      ["team_id", "varchar(64)"],
      ["owner_id", "varchar(64)"],
      ["raw_record_id", "varchar(90)"],
      ["conflict_type", "varchar(60)"],
      ["status", "varchar(20)"],
      ["relation_hash", "char(64)"],
      ["conflict_hash", "char(64)"],
      ["created_at", "datetime(3)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex("PRIMARY", true, "id"),
      schemaIndex(
        "fk_oi_conflict_raw",
        false,
        "team_id",
        "owner_id",
        "raw_record_id"
      ),
      schemaIndex(
        "uk_oi_conflict_resolution",
        true,
        "team_id",
        "owner_id",
        "resolution_id"
      ),
      schemaIndex(
        "uk_oi_conflict_team_owner_id",
        true,
        "team_id",
        "owner_id",
        "id"
      )
    ],
    foreignKeys: [
      schemaForeignKey(
        "fk_oi_conflict_resolution",
        ["team_id", "owner_id", "resolution_id"],
        "organization_identity_resolutions",
        ["team_id", "owner_id", "id"]
      ),
      schemaForeignKey(
        "fk_oi_conflict_raw",
        ["team_id", "owner_id", "raw_record_id"],
        "prospect_source_raw_records",
        ["team_id", "owner_id", "id"]
      )
    ],
    checks: [schemaCheck("chk_oi_conflict_status", "(status = 'open')")]
  },
  organization_identity_events: {
    columns: [
      ["id", "varchar(90)"],
      ["resolution_id", "varchar(90)"],
      ["team_id", "varchar(64)"],
      ["owner_id", "varchar(64)"],
      ["sequence_no", "int"],
      ["event_type", "varchar(60)"],
      ["organization_id", "varchar(90)"],
      ["detail_hash", "char(64)"],
      ["previous_event_hash", "char(64)"],
      ["event_hash", "char(64)"],
      ["created_at", "datetime(3)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex("PRIMARY", true, "id"),
      schemaIndex(
        "uk_oi_event_resolution_sequence",
        true,
        "team_id",
        "owner_id",
        "resolution_id",
        "sequence_no"
      ),
      schemaIndex(
        "uk_oi_event_team_owner_id",
        true,
        "team_id",
        "owner_id",
        "id"
      )
    ],
    foreignKeys: [
      schemaForeignKey(
        "fk_oi_event_resolution",
        ["team_id", "owner_id", "resolution_id"],
        "organization_identity_resolutions",
        ["team_id", "owner_id", "id"]
      )
    ],
    checks: [schemaCheck("chk_oi_event_sequence", "(sequence_no >= 1)")]
  },
  organization_identity_resolution_identifiers: {
    columns: [
      ["resolution_id", "varchar(90)"],
      ["team_id", "varchar(64)"],
      ["owner_id", "varchar(64)"],
      ["ordinal", "int"],
      ["identifier_id", "varchar(90)"],
      ["relation_role", "varchar(40)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex(
        "PRIMARY",
        true,
        "team_id",
        "owner_id",
        "resolution_id",
        "ordinal"
      ),
      schemaIndex(
        "fk_oi_resolution_identifier_identifier",
        false,
        "team_id",
        "identifier_id"
      ),
      schemaIndex(
        "uk_oi_resolution_identifier_role",
        true,
        "team_id",
        "owner_id",
        "resolution_id",
        "identifier_id",
        "relation_role"
      )
    ],
    foreignKeys: [
      schemaForeignKey(
        "fk_oi_resolution_identifier_resolution",
        ["team_id", "owner_id", "resolution_id"],
        "organization_identity_resolutions",
        ["team_id", "owner_id", "id"]
      ),
      schemaForeignKey(
        "fk_oi_resolution_identifier_identifier",
        ["team_id", "identifier_id"],
        "organization_accepted_identifiers",
        ["team_id", "id"]
      )
    ],
    checks: [
      schemaCheck(
        "chk_oi_resolution_identifier_ordinal",
        "(ordinal >= 1)"
      ),
      schemaCheck(
        "chk_oi_resolution_identifier_role",
        "(relation_role IN "
          + "('matched_existing','accepted_existing','accepted_new'))"
      )
    ]
  },
  organization_identity_resolution_bindings: {
    columns: [
      ["resolution_id", "varchar(90)"],
      ["team_id", "varchar(64)"],
      ["owner_id", "varchar(64)"],
      ["ordinal", "int"],
      ["binding_id", "varchar(90)"],
      ["relation_role", "varchar(40)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex(
        "PRIMARY",
        true,
        "team_id",
        "owner_id",
        "resolution_id",
        "ordinal"
      ),
      schemaIndex(
        "fk_oi_resolution_binding_binding",
        false,
        "team_id",
        "owner_id",
        "binding_id"
      ),
      schemaIndex(
        "uk_oi_resolution_binding_role",
        true,
        "team_id",
        "owner_id",
        "resolution_id",
        "binding_id",
        "relation_role"
      )
    ],
    foreignKeys: [
      schemaForeignKey(
        "fk_oi_resolution_binding_resolution",
        ["team_id", "owner_id", "resolution_id"],
        "organization_identity_resolutions",
        ["team_id", "owner_id", "id"]
      ),
      schemaForeignKey(
        "fk_oi_resolution_binding_binding",
        ["team_id", "owner_id", "binding_id"],
        "organization_source_bindings",
        ["team_id", "owner_id", "id"]
      )
    ],
    checks: [
      schemaCheck(
        "chk_oi_resolution_binding_ordinal",
        "(ordinal >= 1)"
      ),
      schemaCheck(
        "chk_oi_resolution_binding_role",
        "(relation_role IN ('reused_existing','created_new'))"
      )
    ]
  },
  organization_identity_conflict_organizations: {
    columns: [
      ["conflict_id", "varchar(90)"],
      ["team_id", "varchar(64)"],
      ["owner_id", "varchar(64)"],
      ["ordinal", "int"],
      ["organization_id", "varchar(90)"],
      ["relation_role", "varchar(40)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex(
        "PRIMARY",
        true,
        "team_id",
        "owner_id",
        "conflict_id",
        "ordinal"
      ),
      schemaIndex(
        "fk_oi_conflict_organization_organization",
        false,
        "team_id",
        "organization_id"
      )
    ],
    foreignKeys: [
      schemaForeignKey(
        "fk_oi_conflict_organization_conflict",
        ["team_id", "owner_id", "conflict_id"],
        "organization_identity_conflicts",
        ["team_id", "owner_id", "id"]
      ),
      schemaForeignKey(
        "fk_oi_conflict_organization_organization",
        ["team_id", "organization_id"],
        "organizations",
        ["team_id", "id"]
      )
    ],
    checks: [
      schemaCheck(
        "chk_oi_conflict_organization_ordinal",
        "(ordinal >= 1)"
      ),
      schemaCheck(
        "chk_oi_conflict_organization_role",
        "(relation_role IN ('identifier_match','existing_binding'))"
      )
    ]
  },
  organization_identity_conflict_keys: {
    columns: [
      ["conflict_id", "varchar(90)"],
      ["team_id", "varchar(64)"],
      ["owner_id", "varchar(64)"],
      ["ordinal", "int"],
      ["key_type", "varchar(40)"],
      ["identifier_key_encrypted", "mediumtext"],
      ["identifier_key_hash", "char(64)"],
      ["row_mac", "char(64)"]
    ],
    indexes: [
      schemaIndex(
        "PRIMARY",
        true,
        "team_id",
        "owner_id",
        "conflict_id",
        "ordinal"
      )
    ],
    foreignKeys: [
      schemaForeignKey(
        "fk_oi_conflict_key_conflict",
        ["team_id", "owner_id", "conflict_id"],
        "organization_identity_conflicts",
        ["team_id", "owner_id", "id"]
      )
    ],
    checks: [
      schemaCheck("chk_oi_conflict_key_ordinal", "(ordinal >= 1)"),
      schemaCheck(
        "chk_oi_conflict_key_type",
        "(key_type IN "
          + "('identifier_exact','identifier_slot','raw_binding'))"
      )
    ]
  }
};

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  if (typeof result !== "string") {
    throw new OrganizationStrongIdentityError(
      "IDENTITY_DATA_INTEGRITY_VIOLATION",
      "企业身份持久化对象无法 Canonical 化"
    );
  }
  return result;
}

function hmac(key: Buffer | string, value: unknown) {
  return createHmac("sha256", key).update(canonical(value)).digest("hex");
}

function sha256(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function configurationError(message: string): never {
  throw new OrganizationStrongIdentityError(
    "IDENTITY_CONFIGURATION_INVALID",
    message
  );
}

function integrityError(message: string): never {
  throw new OrganizationStrongIdentityError(
    "IDENTITY_DATA_INTEGRITY_VIOLATION",
    message
  );
}

function requireSecret(name: string, value: string | undefined) {
  if (!value || Buffer.byteLength(value, "utf8") < 32) {
    configurationError(`${name} 必须至少包含 32 字节`);
  }
  return value;
}

function deriveKey(master: string, info: string) {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(master, "utf8"),
    HKDF_SALT,
    Buffer.from(info, "utf8"),
    32
  ));
}

function configuredSecrets(required: boolean): IdentitySecrets | null {
  const master = process.env.ORGANIZATION_IDENTITY_MASTER_SECRET;
  const raw = process.env.PROSPECT_SOURCE_RAW_ENVELOPE_SECRET;
  if (!master && !raw && !required) return null;
  const checkedMaster = requireSecret(
    "ORGANIZATION_IDENTITY_MASTER_SECRET",
    master
  );
  const checkedRaw = requireSecret(
    "PROSPECT_SOURCE_RAW_ENVELOPE_SECRET",
    raw
  );
  const processing = deriveKey(checkedMaster, "processing-key-hmac-v1");
  const deterministic = deriveKey(
    checkedMaster,
    "deterministic-id-hmac-v1"
  );
  const lookup = deriveKey(
    checkedMaster,
    "identifier-lookup-hmac-v1"
  );
  const encryption = deriveKey(
    checkedMaster,
    "field-encryption-aes256gcm-v1"
  );
  const integrity = deriveKey(
    checkedMaster,
    "fact-integrity-hmac-v1"
  );
  return {
    rawEnvelopeSecret: checkedRaw,
    processingSecret: processing.toString("base64url"),
    deterministicIdSecret: deterministic.toString("base64url"),
    identifierLookupSecret: lookup.toString("base64url"),
    fieldEncryptionKey: encryption,
    factIntegrityKey: integrity,
    factIntegritySecret: integrity.toString("base64url")
  };
}

function keyFingerprint(keyPurpose: string, key: Buffer | string) {
  const keyBase64url = Buffer.isBuffer(key)
    ? key.toString("base64url")
    : Buffer.from(key, "utf8").toString("base64url");
  return sha256({
    contract: "organization-identity-key-fingerprint-v1",
    keyPurpose,
    keyVersion: KEY_VERSION,
    keyBase64url
  });
}

function metadataBase(secrets: IdentitySecrets, createdAt: string) {
  return {
    id: 1,
    resolver_contract_version: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
    persistence_schema_version: PERSISTENCE_SCHEMA_VERSION,
    canonical_version: CANONICAL_VERSION,
    hash_algorithm: "sha256+hmac-sha256",
    encryption_algorithm: "aes-256-gcm",
    envelope_version: ENVELOPE_VERSION,
    hkdf_version: HKDF_VERSION,
    deterministic_id_version: "organization-id-v1",
    key_fingerprints_json: canonical({
      processing: keyFingerprint(
        "processing-key-hmac-v1",
        secrets.processingSecret
      ),
      deterministic: keyFingerprint(
        "deterministic-id-hmac-v1",
        secrets.deterministicIdSecret
      ),
      lookup: keyFingerprint(
        "identifier-lookup-hmac-v1",
        secrets.identifierLookupSecret
      ),
      encryption: keyFingerprint(
        "field-encryption-aes256gcm-v1",
        secrets.fieldEncryptionKey
      ),
      integrity: keyFingerprint(
        "fact-integrity-hmac-v1",
        secrets.factIntegrityKey
      )
    }),
    raw_key_fingerprint: keyFingerprint(
      "prospect-source-raw-envelope-v1",
      secrets.rawEnvelopeSecret
    ),
    status: "active",
    created_at: createdAt
  };
}

function metadataMac(
  row: ReturnType<typeof metadataBase>,
  secrets: IdentitySecrets
) {
  return hmac(secrets.factIntegrityKey, {
    contract: PERSISTENCE_SCHEMA_VERSION,
    row: "contract_metadata",
    ...row
  });
}

function fieldAad(input: {
  table: string;
  teamId: string;
  ownerId?: string;
  rowId: string;
  parentId?: string;
  field: string;
  role?: string;
  ordinal?: number;
}) {
  return {
    contract: PERSISTENCE_SCHEMA_VERSION,
    envelopeVersion: ENVELOPE_VERSION,
    keyVersion: KEY_VERSION,
    table: input.table,
    teamId: input.teamId,
    ownerId: input.ownerId || "",
    rowId: input.rowId,
    parentId: input.parentId || "",
    field: input.field,
    role: input.role || "",
    ordinal: input.ordinal || 0
  };
}

function encryptField(
  value: string,
  key: Buffer,
  aad: ReturnType<typeof fieldAad>
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(canonical(aad), "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final()
  ]);
  const envelope = canonical({
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    keyVersion: KEY_VERSION,
    tag: cipher.getAuthTag().toString("base64url"),
    version: ENVELOPE_VERSION
  });
  return `${ENVELOPE_VERSION}.${Buffer.from(envelope, "utf8")
    .toString("base64url")}`;
}

function decryptField(
  envelope: string,
  key: Buffer,
  aad: ReturnType<typeof fieldAad>
) {
  try {
    const prefix = `${ENVELOPE_VERSION}.`;
    if (!envelope.startsWith(prefix)) throw new Error("version");
    const decoded = Buffer.from(envelope.slice(prefix.length), "base64url")
      .toString("utf8");
    const parsed = JSON.parse(decoded) as {
      ciphertext: string;
      iv: string;
      keyVersion: string;
      tag: string;
      version: string;
    };
    if (canonical(parsed) !== decoded
      || parsed.version !== ENVELOPE_VERSION
      || parsed.keyVersion !== KEY_VERSION) {
      throw new Error("canonical");
    }
    const iv = Buffer.from(parsed.iv, "base64url");
    const tag = Buffer.from(parsed.tag, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("length");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(canonical(aad), "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    integrityError("企业身份字段密文或 AAD 完整性校验失败");
  }
}

function rowMac(table: string, row: Record<string, unknown>, key: Buffer) {
  return hmac(key, {
    contract: PERSISTENCE_SCHEMA_VERSION,
    table,
    row
  });
}

function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) integrityError("数据库时间字段无效");
  return date.toISOString();
}

async function queryRows<T>(
  source: QuerySource,
  sql: string,
  values: unknown[] = []
) {
  const [rows] = await source.query(sql, values);
  return rows as T[];
}

function mysqlErrorNumber(error: unknown) {
  if (!error || typeof error !== "object") return 0;
  return Number(
    (error as { errno?: number; code?: string }).errno
      || ((error as { code?: string }).code === "ER_LOCK_DEADLOCK"
        ? 1213
        : (error as { code?: string }).code === "ER_LOCK_WAIT_TIMEOUT"
          ? 1205
          : 0)
  );
}

function isRetryable(error: unknown) {
  return [1205, 1213].includes(mysqlErrorNumber(error));
}

function isDuplicateEntry(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const details = error as {
    code?: string;
    errno?: number;
  };
  return details.code === "ER_DUP_ENTRY" || details.errno === 1062;
}

function namedDuplicateRecoveryRule(
  error: unknown
): NamedDuplicateRecoveryRule | null {
  if (!(error instanceof Error)) return null;
  const details = error as {
    code?: string;
    errno?: number;
    sqlState?: string;
    sqlMessage?: string;
  };
  if (details.code !== "ER_DUP_ENTRY"
    || typeof details.errno !== "number"
    || details.errno !== 1062
    || details.sqlState !== "23000"
    || typeof details.sqlMessage !== "string"
    || details.sqlMessage.length > 2_048
    || /[\r\n\u0000-\u001f\u007f]/u.test(details.sqlMessage)) {
    return null;
  }
  const match = details.sqlMessage.match(
    /^Duplicate entry '.+' for key '([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+){0,2})'$/u
  );
  if (!match) return null;
  const parts = match[1]!.split(".");
  if (parts.some((part) => !part || part.length > 64)) return null;
  const constraint = parts[parts.length - 1]!;
  const reportedTable = parts.length >= 2
    ? parts[parts.length - 2]!
    : "";
  const writeTable = duplicateWriteTables.get(error);
  if (!writeTable || (reportedTable && reportedTable !== writeTable)) {
    return null;
  }
  return NAMED_DUPLICATE_RECOVERY_RULES.find((rule) =>
    rule.table === writeTable && rule.constraint === constraint
  ) || null;
}

function trustedProfiles() {
  const profiles: OrganizationIdentityAuthorityProfile[] = [{
    profileCode: "gleif-company-identity",
    profileVersion: "v1",
    providerCode: "gleif",
    endpointCode: "company-search",
    allowMultiIdentifierSubjectBinding: true,
    rules: [{
      kind: "lei",
      scheme: "iso-17442",
      jurisdictions: ["GLOBAL"],
      entityTypes: ["legal_entity"],
      normalizerVersions: ["gleif-lei-normalizer-v1"],
      validatorVersions: ["iso-17442-mod97-v1"]
    }]
  }];
  if (process.env.NODE_ENV === "test") {
    profiles.push({
      profileCode: "identity-authority-test",
      profileVersion: "v1",
      providerCode: "identity.test-provider",
      endpointCode: "company-identity",
      allowMultiIdentifierSubjectBinding: true,
      rules: [
        {
          kind: "lei",
          scheme: "iso-17442",
          jurisdictions: ["GLOBAL"],
          entityTypes: ["legal_entity"],
          normalizerVersions: ["claim-norm-v1"],
          validatorVersions: ["claim-validator-v1"]
        },
        {
          kind: "registration_number",
          scheme: "registry-a",
          jurisdictions: ["DE", "FR"],
          entityTypes: ["legal_entity"],
          normalizerVersions: ["claim-norm-v1"],
          validatorVersions: ["claim-validator-v1"]
        },
        {
          kind: "registration_number",
          scheme: "registry-b",
          jurisdictions: ["DE"],
          entityTypes: ["legal_entity"],
          normalizerVersions: ["claim-norm-v1"],
          validatorVersions: ["claim-validator-v1"]
        },
        {
          kind: "vat",
          scheme: "eu-vat",
          jurisdictions: ["DE"],
          entityTypes: ["legal_entity"],
          normalizerVersions: ["claim-norm-v1"],
          validatorVersions: ["claim-validator-v1"]
        }
      ]
    });
  }
  return profiles.map(normalizeOrganizationIdentityAuthorityProfile);
}

function trustedProfile(code: string, version: string) {
  const profile = trustedProfiles().find((item) =>
    item.profileCode === code && item.profileVersion === version
  );
  if (!profile) {
    configurationError("请求的企业身份 AuthorityProfile 不在服务端注册表");
  }
  return profile;
}

type SchemaManifestEntry = readonly [
  tableName: string,
  manifest: TableSchemaManifest
];

function normalizeCheckClause(clause: string) {
  const source = clause
    .replaceAll("\\'", "'")
    .replace(/_utf8mb4(?=')/gi, "");
  let normalized = "";
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === "'") {
      normalized += character;
      if (inString && source[index + 1] === "'") {
        normalized += source[index + 1];
        index += 1;
      } else {
        inString = !inString;
      }
      continue;
    }
    if (inString) {
      normalized += character;
      continue;
    }
    if (character === "`" || /\s/.test(character)) continue;
    normalized += character.toLowerCase();
  }
  return normalized;
}

async function validateSchemaTables(
  connection: mysql.PoolConnection,
  entries: readonly SchemaManifestEntry[],
  optionalIndexes: ReadonlySet<string> = new Set()
) {
  if (!entries.length) return;
  const tableNames = entries.map(([tableName]) => tableName);
  const placeholders = tableNames.map(() => "?").join(",");
  const tables = await queryRows<{
    tableName: string;
    engineName: string | null;
  }>(
    connection,
    `SELECT table_name AS tableName, engine AS engineName
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name IN (${placeholders})`,
    tableNames
  );
  const actualTables = new Map(
    tables.map((row) => [row.tableName, row.engineName])
  );
  if (actualTables.size !== tableNames.length
    || tableNames.some((tableName) => !actualTables.has(tableName))) {
    integrityError("Organization Identity Schema 表集合不完整");
  }
  for (const tableName of tableNames) {
    if (String(actualTables.get(tableName) || "").toLowerCase()
      !== FROZEN_TABLE_ENGINE.toLowerCase()) {
      integrityError(`Schema ${tableName} 存储引擎不匹配`);
    }
  }

  const columns = await queryRows<{
    tableName: string;
    columnName: string;
    ordinalPosition: number;
    columnType: string;
    isNullable: string;
    columnDefault: unknown;
    columnExtra: string;
  }>(
    connection,
    `SELECT table_name AS tableName, column_name AS columnName,
       ordinal_position AS ordinalPosition, column_type AS columnType,
       is_nullable AS isNullable, column_default AS columnDefault,
       extra AS columnExtra
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name IN (${placeholders})
     ORDER BY table_name, ordinal_position`,
    tableNames
  );
  for (const [tableName, manifest] of entries) {
    const actual = columns.filter((row) => row.tableName === tableName);
    if (actual.length !== manifest.columns.length) {
      integrityError(`Schema ${tableName} 列集合不匹配`);
    }
    manifest.columns.forEach(([columnName, columnType], index) => {
      const row = actual[index];
      if (!row
        || Number(row.ordinalPosition) !== index + 1
        || row.columnName !== columnName
        || row.columnType.toLowerCase() !== columnType
        || row.isNullable !== "NO"
        || row.columnDefault !== null
        || row.columnExtra !== "") {
        integrityError(
          `Schema ${tableName}.${columnName} 列定义不匹配`
        );
      }
    });
  }

  const indexRows = await queryRows<{
    tableName: string;
    indexName: string;
    nonUnique: number;
    seqInIndex: number;
    columnName: string;
    subPart: number | null;
    indexType: string;
  }>(
    connection,
    `SELECT table_name AS tableName, index_name AS indexName,
       non_unique AS nonUnique, seq_in_index AS seqInIndex,
       column_name AS columnName, sub_part AS subPart,
       index_type AS indexType
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name IN (${placeholders})
     ORDER BY table_name, index_name, seq_in_index`,
    tableNames
  );
  for (const [tableName, manifest] of entries) {
    const actualNames = new Set(
      indexRows
        .filter((row) => row.tableName === tableName)
        .map((row) => row.indexName)
    );
    const expectedNames = new Set(
      manifest.indexes.map((index) => index.name)
    );
    if ([...actualNames].some((name) => !expectedNames.has(name))) {
      integrityError(`Schema ${tableName} 含未冻结索引`);
    }
    for (const expected of manifest.indexes) {
      const key = `${tableName}:${expected.name}`;
      const actual = indexRows.filter((row) =>
        row.tableName === tableName && row.indexName === expected.name
      );
      if (!actual.length && optionalIndexes.has(key)) continue;
      if (actual.length !== expected.columns.length
        || actual.some((row, index) =>
          Number(row.nonUnique) !== (expected.unique ? 0 : 1)
          || Number(row.seqInIndex) !== index + 1
          || row.columnName !== expected.columns[index]
          || row.subPart !== null
          || row.indexType !== "BTREE"
        )) {
        integrityError(`Schema ${tableName}.${expected.name} 索引不匹配`);
      }
    }
  }

  const foreignKeyRows = await queryRows<{
    tableName: string;
    constraintName: string;
    ordinalPosition: number;
    columnName: string;
    referencedTableName: string;
    referencedColumnName: string;
    updateRule: string;
    deleteRule: string;
  }>(
    connection,
    `SELECT k.table_name AS tableName,
       k.constraint_name AS constraintName,
       k.ordinal_position AS ordinalPosition,
       k.column_name AS columnName,
       k.referenced_table_name AS referencedTableName,
       k.referenced_column_name AS referencedColumnName,
       rc.update_rule AS updateRule, rc.delete_rule AS deleteRule
     FROM information_schema.key_column_usage k
     JOIN information_schema.referential_constraints rc
       ON rc.constraint_schema = k.constraint_schema
      AND rc.table_name = k.table_name
      AND rc.constraint_name = k.constraint_name
     WHERE k.constraint_schema = DATABASE()
       AND k.table_name IN (${placeholders})
       AND k.referenced_table_name IS NOT NULL
     ORDER BY k.table_name, k.constraint_name, k.ordinal_position`,
    tableNames
  );
  for (const [tableName, manifest] of entries) {
    const expectedForeignKeys = manifest.foreignKeys || [];
    const actualNames = new Set(
      foreignKeyRows
        .filter((row) => row.tableName === tableName)
        .map((row) => row.constraintName)
    );
    if (actualNames.size !== expectedForeignKeys.length
      || expectedForeignKeys.some((key) => !actualNames.has(key.name))) {
      integrityError(`Schema ${tableName} 外键集合不匹配`);
    }
    for (const expected of expectedForeignKeys) {
      const actual = foreignKeyRows.filter((row) =>
        row.tableName === tableName
        && row.constraintName === expected.name
      );
      if (actual.length !== expected.columns.length
        || actual.some((row, index) =>
          Number(row.ordinalPosition) !== index + 1
          || row.columnName !== expected.columns[index]
          || row.referencedTableName !== expected.referencedTable
          || row.referencedColumnName !== expected.referencedColumns[index]
          || row.updateRule !== "RESTRICT"
          || row.deleteRule !== "RESTRICT"
        )) {
        integrityError(`Schema ${tableName}.${expected.name} 外键不匹配`);
      }
    }
  }

  const checkRows = await queryRows<{
    tableName: string;
    constraintName: string;
    checkClause: string;
    enforced: string;
  }>(
    connection,
    `SELECT tc.table_name AS tableName,
       tc.constraint_name AS constraintName,
       cc.check_clause AS checkClause, tc.enforced AS enforced
     FROM information_schema.table_constraints tc
     JOIN information_schema.check_constraints cc
       ON cc.constraint_schema = tc.constraint_schema
      AND cc.constraint_name = tc.constraint_name
     WHERE tc.constraint_schema = DATABASE()
       AND tc.table_name IN (${placeholders})
       AND tc.constraint_type = 'CHECK'
     ORDER BY tc.table_name, tc.constraint_name`,
    tableNames
  );
  for (const [tableName, manifest] of entries) {
    const expectedChecks = manifest.checks || [];
    const actual = checkRows.filter((row) => row.tableName === tableName);
    const actualNames = new Set(actual.map((row) => row.constraintName));
    if (actualNames.size !== expectedChecks.length
      || expectedChecks.some((check) => !actualNames.has(check.name))) {
      integrityError(`Schema ${tableName} CHECK 集合不匹配`);
    }
    for (const expected of expectedChecks) {
      const row = actual.find(
        (item) => item.constraintName === expected.name
      );
      if (!row
        || row.enforced !== "YES"
        || normalizeCheckClause(row.checkClause)
          !== normalizeCheckClause(expected.clause)) {
        integrityError(`Schema ${tableName}.${expected.name} CHECK 不匹配`);
      }
    }
  }
}

async function validateRawRecordSchema(
  connection: mysql.PoolConnection,
  allowMissingOwnerIndex: boolean
) {
  const optional = allowMissingOwnerIndex
    ? new Set([
      "prospect_source_raw_records:uk_ps_raw_record_team_owner_id"
    ])
    : new Set<string>();
  await validateSchemaTables(
    connection,
    [["prospect_source_raw_records", RAW_RECORD_SCHEMA]],
    optional
  );
}

async function ensureRawOwnerIndex(connection: mysql.PoolConnection) {
  const duplicates = await queryRows<{ count: number }>(
    connection,
    `SELECT COUNT(*) AS count FROM (
       SELECT team_id, owner_id, id
       FROM prospect_source_raw_records
       GROUP BY team_id, owner_id, id
       HAVING COUNT(*) > 1
     ) duplicate_rows`
  );
  if (Number(duplicates[0]?.count || 0) > 0) {
    integrityError("Provider Raw Record 存在团队业务员复合键重复");
  }
  const indexRows = await queryRows<{ count: number }>(
    connection,
    `SELECT COUNT(DISTINCT index_name) AS count
     FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'prospect_source_raw_records'
       AND index_name = 'uk_ps_raw_record_team_owner_id'`
  );
  if (Number(indexRows[0]?.count || 0) === 0) {
    await connection.query(
      `ALTER TABLE prospect_source_raw_records
       ADD UNIQUE KEY uk_ps_raw_record_team_owner_id(team_id, owner_id, id)`
    );
  }
}

function identitySchemaEntries(
  tableNames: readonly (typeof IDENTITY_TABLES)[number][]
): SchemaManifestEntry[] {
  return tableNames.map((tableName) => [
    tableName,
    IDENTITY_SCHEMA[tableName]
  ]);
}

async function validateIdentitySchema(
  connection: mysql.PoolConnection,
  tableNames: readonly (typeof IDENTITY_TABLES)[number][] = IDENTITY_TABLES
) {
  await validateSchemaTables(
    connection,
    identitySchemaEntries(tableNames)
  );
}

export async function ensureOrganizationIdentitySchema(pool: mysql.Pool) {
  const connection = await pool.getConnection();
  let acquired = false;
  let acquisitionOutcomeKnown = false;
  let destroyed = false;
  try {
    const lock = await queryRows<{ acquired: number }>(
      connection,
      "SELECT GET_LOCK(?, 30) AS acquired",
      [SCHEMA_LOCK]
    );
    acquisitionOutcomeKnown = true;
    acquired = Number(lock[0]?.acquired || 0) === 1;
    if (!acquired) {
      configurationError("无法获取 Organization Identity Schema 锁");
    }
    await validateRawRecordSchema(connection, true);
    await ensureRawOwnerIndex(connection);
    await validateRawRecordSchema(connection, false);
    const existing = await queryRows<{ tableName: string }>(
      connection,
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = DATABASE()
         AND table_name IN (${IDENTITY_TABLES.map(() => "?").join(",")})`,
      [...IDENTITY_TABLES]
    );
    const existingNames = existing.map(
      (row) => row.tableName
    ) as (typeof IDENTITY_TABLES)[number][];
    if (existing.length > 0 && existing.length < IDENTITY_TABLES.length) {
      for (const row of existing) {
        const count = await queryRows<{ count: number }>(
          connection,
          `SELECT COUNT(*) AS count FROM \`${row.tableName}\``
        );
        if (Number(count[0]?.count || 0) > 0) {
          integrityError("部分 Organization Identity Schema 已含事实");
        }
      }
    }
    if (existingNames.length) {
      await validateIdentitySchema(connection, existingNames);
    }
    for (const sql of SCHEMA_SQL) await connection.query(sql);
    await validateIdentitySchema(connection);
  } finally {
    if (!acquisitionOutcomeKnown) {
      connection.destroy();
      destroyed = true;
    } else if (acquired) {
      let releaseFailed = false;
      try {
        const released = await queryRows<{ released: number | null }>(
          connection,
          "SELECT RELEASE_LOCK(?) AS released",
          [SCHEMA_LOCK]
        );
        releaseFailed = Number(released[0]?.released) !== 1;
      } catch {
        releaseFailed = true;
      }
      if (releaseFailed) {
        connection.destroy();
        destroyed = true;
        throw new OrganizationStrongIdentityError(
          "IDENTITY_DATA_INTEGRITY_VIOLATION",
          "Organization Identity Schema 锁释放结果无法确认"
        );
      }
    }
    if (!destroyed) connection.release();
  }
}

async function factRowCount(source: QuerySource) {
  let total = 0;
  for (const table of IDENTITY_STATE_TABLES) {
    const rows = await queryRows<{ count: number }>(
      source,
      `SELECT COUNT(*) AS count FROM \`${table}\``
    );
    total += Number(rows[0]?.count || 0);
  }
  return total;
}

async function validateMetadata(
  source: QuerySource,
  secrets: IdentitySecrets | null,
  lockForUpdate = false
) {
  const rows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM organization_identity_contract_metadata
     WHERE id = 1${lockForUpdate ? " FOR UPDATE" : ""}`
  );
  if (!rows.length) {
    if (await factRowCount(source)) {
      integrityError("身份事实存在但缺少不可变 Contract Metadata");
    }
    return false;
  }
  if (rows.length !== 1) integrityError("身份 Contract Metadata 不唯一");
  if (!secrets) {
    configurationError("已有身份 Metadata，但服务端身份密钥未配置");
  }
  const row = rows[0]!;
  const createdAt = iso(row.created_at);
  const expected = metadataBase(secrets, createdAt);
  for (const [key, value] of Object.entries(expected)) {
    const actual = key === "created_at" ? createdAt : row[key];
    if (String(actual ?? "") !== String(value)) {
      configurationError("身份 Metadata 与当前合同或密钥指纹不一致");
    }
  }
  if (String(row.metadata_mac || "") !== metadataMac(expected, secrets)) {
    integrityError("身份 Contract Metadata MAC 校验失败");
  }
  return true;
}

async function initializeMetadata(
  connection: mysql.PoolConnection,
  secrets: IdentitySecrets,
  createdAt: string
) {
  if (await validateMetadata(connection, secrets, true)) return;
  const row = metadataBase(secrets, createdAt);
  await connection.query(
    `INSERT INTO organization_identity_contract_metadata (
       id,resolver_contract_version,persistence_schema_version,
       canonical_version,hash_algorithm,encryption_algorithm,
       envelope_version,hkdf_version,deterministic_id_version,
       key_fingerprints_json,raw_key_fingerprint,status,created_at,
       metadata_mac
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE id = VALUES(id)`,
    [
      row.id,
      row.resolver_contract_version,
      row.persistence_schema_version,
      row.canonical_version,
      row.hash_algorithm,
      row.encryption_algorithm,
      row.envelope_version,
      row.hkdf_version,
      row.deterministic_id_version,
      row.key_fingerprints_json,
      row.raw_key_fingerprint,
      row.status,
      new Date(row.created_at),
      metadataMac(row, secrets)
    ]
  );
  if (!await validateMetadata(connection, secrets, true)) {
    integrityError("身份 Contract Metadata 初始化失败");
  }
}

function profileStorage(
  profile: OrganizationIdentityAuthorityProfile,
  createdAt: string,
  secrets: IdentitySecrets
) {
  const normalized = normalizeOrganizationIdentityAuthorityProfile(profile);
  const base = {
    profile_code: normalized.profileCode,
    profile_version: normalized.profileVersion,
    canonical_json: canonical(normalized),
    profile_hash: organizationIdentityAuthorityProfileHash(normalized),
    created_at: createdAt
  };
  const profileMac = hmac(secrets.factIntegrityKey, {
    contract: PERSISTENCE_SCHEMA_VERSION,
    row: "authority_profile_content",
    ...base
  });
  const withProfileMac = { ...base, profile_mac: profileMac };
  return {
    ...withProfileMac,
    row_mac: rowMac(
      "organization_identity_authority_profiles",
      withProfileMac,
      secrets.factIntegrityKey
    )
  };
}

async function registerProfile(
  connection: mysql.PoolConnection,
  profile: OrganizationIdentityAuthorityProfile,
  createdAt: string,
  secrets: IdentitySecrets
) {
  const expected = profileStorage(profile, createdAt, secrets);
  await connection.query(
    `INSERT INTO organization_identity_authority_profiles (
       profile_code,profile_version,canonical_json,profile_hash,
       profile_mac,created_at,row_mac
     ) VALUES (?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       profile_code = VALUES(profile_code)`,
    [
      expected.profile_code,
      expected.profile_version,
      expected.canonical_json,
      expected.profile_hash,
      expected.profile_mac,
      new Date(expected.created_at),
      expected.row_mac
    ]
  );
  const rows = await queryRows<Record<string, unknown>>(
    connection,
    `SELECT * FROM organization_identity_authority_profiles
     WHERE profile_code = ? AND profile_version = ? FOR UPDATE`,
    [expected.profile_code, expected.profile_version]
  );
  if (rows.length !== 1) integrityError("AuthorityProfile 注册结果不唯一");
  const persisted = rows[0]!;
  const persistedCreatedAt = iso(persisted.created_at);
  const actual = {
    profile_code: String(persisted.profile_code),
    profile_version: String(persisted.profile_version),
    canonical_json: String(persisted.canonical_json),
    profile_hash: String(persisted.profile_hash),
    created_at: persistedCreatedAt,
    profile_mac: String(persisted.profile_mac)
  };
  const trusted = profileStorage(profile, persistedCreatedAt, secrets);
  if (canonical(actual) !== canonical({
    profile_code: trusted.profile_code,
    profile_version: trusted.profile_version,
    canonical_json: trusted.canonical_json,
    profile_hash: trusted.profile_hash,
    created_at: trusted.created_at,
    profile_mac: trusted.profile_mac
  })
    || String(persisted.row_mac) !== trusted.row_mac) {
    configurationError("AuthorityProfile 内容漂移或 MAC 不匹配");
  }
}

function verifyStoredRow(
  table: string,
  row: Record<string, unknown>,
  secrets: IdentitySecrets
) {
  const { row_mac: persistedMac, ...base } = row;
  const normalizedBase = Object.fromEntries(
    Object.entries(base).map(([key, value]) => [
      key,
      key.endsWith("_at") ? iso(value) : value
    ])
  );
  if (String(persistedMac || "") !== rowMac(
    table,
    normalizedBase,
    secrets.factIntegrityKey
  )) {
    integrityError(`${table} Row MAC 校验失败`);
  }
  return normalizedBase;
}

function rawRecord(row: Record<string, unknown>): ProspectSourceRawRecord {
  const envelopeVersion = String(row.envelope_version);
  if (envelopeVersion !== PROSPECT_SOURCE_RAW_ENVELOPE_VERSION) {
    integrityError("Provider 原始记录信封版本无效");
  }
  return {
    id: String(row.id),
    teamId: String(row.team_id),
    ownerId: String(row.owner_id),
    providerCode: String(row.provider_code),
    connectionId: String(row.connection_id),
    endpointCode: String(row.endpoint_code),
    sourceIdentityHash: String(row.source_identity_hash),
    artifactHash: String(row.artifact_hash),
    envelopeVersion: PROSPECT_SOURCE_RAW_ENVELOPE_VERSION,
    encryptedEnvelope: String(row.encrypted_envelope),
    envelopeHash: String(row.envelope_hash),
    firstObservedAt: iso(row.first_observed_at),
    recordHash: String(row.record_hash),
    createdAt: iso(row.created_at)
  };
}

async function loadRawRecords(
  source: QuerySource,
  teamId?: string
) {
  return (await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM prospect_source_raw_records${
      teamId ? " WHERE team_id = ?" : ""
    } ORDER BY team_id, owner_id, id`,
    teamId ? [teamId] : []
  )).map(rawRecord);
}

function scopedSelectionWhere(
  teamId: string | undefined,
  alternatives?: ReadonlyArray<{
    column: string;
    values: readonly string[];
  }>
) {
  if (!teamId) return { sql: "", values: [] as unknown[] };
  if (!alternatives) {
    return { sql: " WHERE team_id = ?", values: [teamId] as unknown[] };
  }
  const populated = alternatives.filter((item) => item.values.length);
  if (!populated.length) {
    return {
      sql: " WHERE team_id = ? AND 1 = 0",
      values: [teamId] as unknown[]
    };
  }
  const predicates = populated.map((item) =>
    `${item.column} IN (${item.values.map(() => "?").join(",")})`
  );
  return {
    sql: ` WHERE team_id = ? AND (${predicates.join(" OR ")})`,
    values: [
      teamId,
      ...populated.flatMap((item) => [...item.values])
    ] as unknown[]
  };
}

async function loadRawRecordsByScopes(
  source: QuerySource,
  teamId: string,
  scopes: readonly RawRecordScope[]
) {
  if (!scopes.length) return [];
  const predicates = scopes.map(() => "(owner_id = ? AND id = ?)");
  const values = scopes.flatMap((scope) => [
    scope.ownerId,
    scope.recordId
  ]);
  return (await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM prospect_source_raw_records
     WHERE team_id = ? AND (${predicates.join(" OR ")})
     ORDER BY team_id, owner_id, id`,
    [teamId, ...values]
  )).map(rawRecord);
}

async function loadRelations(
  source: QuerySource,
  secrets: IdentitySecrets,
  teamId?: string,
  selection?: IdentityStateSelection
): Promise<StoredRelationRows> {
  const resolutionWhere = scopedSelectionWhere(
    teamId,
    selection
      ? [{
          column: "resolution_id",
          values: selection.resolutionIds
        }]
      : undefined
  );
  const conflictWhere = scopedSelectionWhere(
    teamId,
    selection
      ? [{
          column: "conflict_id",
          values: selection.conflictIds
        }]
      : undefined
  );
  const identifierRows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM organization_identity_resolution_identifiers${
      resolutionWhere.sql
    }
     ORDER BY team_id, owner_id, resolution_id, ordinal`,
    resolutionWhere.values
  );
  const bindingRows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM organization_identity_resolution_bindings${
      resolutionWhere.sql
    }
     ORDER BY team_id, owner_id, resolution_id, ordinal`,
    resolutionWhere.values
  );
  const organizationRows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM organization_identity_conflict_organizations${
      conflictWhere.sql
    }
     ORDER BY team_id, owner_id, conflict_id, ordinal`,
    conflictWhere.values
  );
  const keyRows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT * FROM organization_identity_conflict_keys${conflictWhere.sql}
     ORDER BY team_id, owner_id, conflict_id, ordinal`,
    conflictWhere.values
  );
  return {
    resolutionIdentifiers: identifierRows.map((row) => {
      const base = verifyStoredRow(
        "organization_identity_resolution_identifiers",
        row,
        secrets
      );
      return {
        resolutionId: String(base.resolution_id),
        teamId: String(base.team_id),
        ownerId: String(base.owner_id),
        identifierId: String(base.identifier_id),
        role: String(base.relation_role) as
          StoredRelationRows["resolutionIdentifiers"][number]["role"],
        ordinal: Number(base.ordinal)
      };
    }),
    resolutionBindings: bindingRows.map((row) => {
      const base = verifyStoredRow(
        "organization_identity_resolution_bindings",
        row,
        secrets
      );
      return {
        resolutionId: String(base.resolution_id),
        teamId: String(base.team_id),
        ownerId: String(base.owner_id),
        bindingId: String(base.binding_id),
        role: String(base.relation_role) as
          StoredRelationRows["resolutionBindings"][number]["role"],
        ordinal: Number(base.ordinal)
      };
    }),
    conflictOrganizations: organizationRows.map((row) => {
      const base = verifyStoredRow(
        "organization_identity_conflict_organizations",
        row,
        secrets
      );
      return {
        conflictId: String(base.conflict_id),
        teamId: String(base.team_id),
        ownerId: String(base.owner_id),
        organizationId: String(base.organization_id),
        role: String(base.relation_role) as
          StoredRelationRows["conflictOrganizations"][number]["role"],
        ordinal: Number(base.ordinal)
      };
    }),
    conflictKeys: keyRows.map((row) => {
      const base = verifyStoredRow(
        "organization_identity_conflict_keys",
        row,
        secrets
      );
      const team = String(base.team_id);
      const owner = String(base.owner_id);
      const conflictId = String(base.conflict_id);
      const ordinal = Number(base.ordinal);
      const keyType = String(base.key_type) as
        StoredRelationRows["conflictKeys"][number]["keyType"];
      const identifierKey = decryptField(
        String(base.identifier_key_encrypted),
        secrets.fieldEncryptionKey,
        fieldAad({
          table: "organization_identity_conflict_keys",
          teamId: team,
          ownerId: owner,
          rowId: conflictId,
          parentId: conflictId,
          field: "identifier_key",
          role: keyType,
          ordinal
        })
      );
      if (String(base.identifier_key_hash) !== sha256({
        contract: "organization-identity-conflict-key-v1",
        teamId: team,
        ownerId: owner,
        conflictId,
        keyType,
        identifierKey
      })) {
        integrityError("Conflict Key 明文摘要不匹配");
      }
      return {
        conflictId,
        teamId: team,
        ownerId: owner,
        identifierKey,
        keyType,
        ordinal
      };
    })
  };
}

export async function loadOrganizationIdentityState(
  source: QuerySource,
  rawRecords?: ProspectSourceRawRecord[],
  teamId?: string,
  selection?: IdentityStateSelection
): Promise<OrganizationIdentityState> {
  const secrets = configuredSecrets(false);
  const initialized = await validateMetadata(source, secrets);
  if (!initialized) return structuredClone(EMPTY_STATE);
  if (!secrets) configurationError("身份持久化密钥未初始化");
  if (selection && !teamId) {
    integrityError("企业身份决策闭包必须限定团队作用域");
  }
  const organizationWhere = scopedSelectionWhere(
    teamId,
    selection
      ? [{ column: "id", values: selection.organizationIds }]
      : undefined
  );
  const claimWhere = scopedSelectionWhere(
    teamId,
    selection
      ? [
          { column: "id", values: selection.claimIds },
          { column: "resolution_id", values: selection.resolutionIds }
        ]
      : undefined
  );
  const identifierWhere = scopedSelectionWhere(
    teamId,
    selection
      ? [{ column: "id", values: selection.identifierIds }]
      : undefined
  );
  const resolutionWhere = scopedSelectionWhere(
    teamId,
    selection
      ? [{ column: "id", values: selection.resolutionIds }]
      : undefined
  );
  const bindingWhere = scopedSelectionWhere(
    teamId,
    selection
      ? [{ column: "id", values: selection.bindingIds }]
      : undefined
  );
  const conflictWhere = scopedSelectionWhere(
    teamId,
    selection
      ? [{ column: "id", values: selection.conflictIds }]
      : undefined
  );
  const eventWhere = scopedSelectionWhere(
    teamId,
    selection
      ? [{ column: "resolution_id", values: selection.resolutionIds }]
      : undefined
  );
  const [
    organizationRows,
    claimRows,
    identifierRows,
    resolutionRows,
    bindingRows,
    conflictRows,
    eventRows,
    relations,
    profileRows
  ] = await Promise.all([
    queryRows<Record<string, unknown>>(
      source,
      `SELECT * FROM organizations${organizationWhere.sql}
       ORDER BY team_id, created_at, id`,
      organizationWhere.values
    ),
    queryRows<Record<string, unknown>>(
      source,
      `SELECT * FROM organization_identity_claims${claimWhere.sql}
       ORDER BY team_id, owner_id, resolution_id, ordinal`,
      claimWhere.values
    ),
    queryRows<Record<string, unknown>>(
      source,
      `SELECT * FROM organization_accepted_identifiers${identifierWhere.sql}
       ORDER BY team_id, created_at, id`,
      identifierWhere.values
    ),
    queryRows<Record<string, unknown>>(
      source,
      `SELECT * FROM organization_identity_resolutions${resolutionWhere.sql}
       ORDER BY team_id, owner_id, created_at, id`,
      resolutionWhere.values
    ),
    queryRows<Record<string, unknown>>(
      source,
      `SELECT * FROM organization_source_bindings${bindingWhere.sql}
       ORDER BY team_id, owner_id, created_at, id`,
      bindingWhere.values
    ),
    queryRows<Record<string, unknown>>(
      source,
      `SELECT * FROM organization_identity_conflicts${conflictWhere.sql}
       ORDER BY team_id, owner_id, created_at, id`,
      conflictWhere.values
    ),
    queryRows<Record<string, unknown>>(
      source,
      `SELECT * FROM organization_identity_events${eventWhere.sql}
       ORDER BY team_id, owner_id, resolution_id, sequence_no`,
      eventWhere.values
    ),
    loadRelations(source, secrets, teamId, selection),
    queryRows<Record<string, unknown>>(
      source,
      "SELECT * FROM organization_identity_authority_profiles"
    )
  ]);

  const profiles = new Map<string, OrganizationIdentityAuthorityProfile>();
  for (const row of profileRows) {
    const createdAt = iso(row.created_at);
    const code = String(row.profile_code);
    const version = String(row.profile_version);
    const profile = trustedProfile(code, version);
    const expected = profileStorage(profile, createdAt, secrets);
    const actual = {
      profile_code: code,
      profile_version: version,
      canonical_json: String(row.canonical_json),
      profile_hash: String(row.profile_hash),
      profile_mac: String(row.profile_mac),
      created_at: createdAt,
      row_mac: String(row.row_mac)
    };
    if (canonical(actual) !== canonical(expected)) {
      configurationError("持久化 AuthorityProfile 与受控注册表不一致");
    }
    profiles.set(`${code}\u0000${version}`, profile);
  }

  const organizations = organizationRows.map((row): Organization => {
    const base = verifyStoredRow("organizations", row, secrets);
    const team = String(base.team_id);
    const id = String(base.id);
    return {
      id,
      teamId: team,
      scopeType: String(base.scope_type) as "team",
      scopeId: String(base.scope_id),
      status: String(base.status) as "active",
      legalName: decryptField(
        String(base.legal_name_encrypted),
        secrets.fieldEncryptionKey,
        fieldAad({
          table: "organizations",
          teamId: team,
          rowId: id,
          field: "legal_name"
        })
      ),
      normalizedName: decryptField(
        String(base.normalized_name_encrypted),
        secrets.fieldEncryptionKey,
        fieldAad({
          table: "organizations",
          teamId: team,
          rowId: id,
          field: "normalized_name"
        })
      ),
      organizationHash: String(base.organization_hash),
      createdAt: iso(base.created_at)
    };
  });

  const claims = claimRows.map((row): OrganizationIdentityClaim => {
    const base = verifyStoredRow(
      "organization_identity_claims",
      row,
      secrets
    );
    const team = String(base.team_id);
    const owner = String(base.owner_id);
    const id = String(base.id);
    const resolutionId = String(base.resolution_id);
    const ordinal = Number(base.ordinal);
    const aad = (field: string) => fieldAad({
      table: "organization_identity_claims",
      teamId: team,
      ownerId: owner,
      rowId: id,
      parentId: resolutionId,
      field,
      ordinal
    });
    return {
      id,
      resolutionId,
      teamId: team,
      ownerId: owner,
      rawRecordId: String(base.raw_record_id),
      ordinal,
      kind: String(base.kind) as OrganizationIdentityClaim["kind"],
      originalValue: decryptField(
        String(base.original_value_encrypted),
        secrets.fieldEncryptionKey,
        aad("original_value")
      ),
      normalizedValue: decryptField(
        String(base.normalized_value_encrypted),
        secrets.fieldEncryptionKey,
        aad("normalized_value")
      ),
      scheme: String(base.scheme),
      jurisdiction: String(base.jurisdiction),
      entityType: String(base.entity_type) as
        OrganizationIdentityClaim["entityType"],
      subjectRef: decryptField(
        String(base.subject_ref_encrypted),
        secrets.fieldEncryptionKey,
        aad("subject_ref")
      ),
      classification: String(base.classification) as
        OrganizationIdentityClaim["classification"],
      normalizerVersion: String(base.normalizer_version),
      validatorVersion: String(base.validator_version),
      authorityProfileCode: String(base.authority_profile_code),
      observedAt: iso(base.observed_at),
      claimHash: String(base.claim_hash),
      claimFactHash: String(base.claim_fact_hash),
      createdAt: iso(base.created_at)
    };
  });

  const identifiers = identifierRows.map((
    row
  ): OrganizationAcceptedIdentifier => {
    const base = verifyStoredRow(
      "organization_accepted_identifiers",
      row,
      secrets
    );
    const team = String(base.team_id);
    const id = String(base.id);
    const owner = String(base.source_owner_id);
    return {
      id,
      organizationId: String(base.organization_id),
      teamId: team,
      kind: String(base.kind) as OrganizationAcceptedIdentifier["kind"],
      scheme: String(base.scheme),
      jurisdiction: String(base.jurisdiction),
      normalizedValue: decryptField(
        String(base.normalized_value_encrypted),
        secrets.fieldEncryptionKey,
        fieldAad({
          table: "organization_accepted_identifiers",
          teamId: team,
          ownerId: owner,
          rowId: id,
          parentId: String(base.organization_id),
          field: "normalized_value",
          role: String(base.kind)
        })
      ),
      normalizedValueHash: String(base.normalized_value_hash),
      sourceClaimId: String(base.source_claim_id),
      sourceRawRecordId: String(base.source_raw_record_id),
      sourceOwnerId: owner,
      authorityProfileCode: String(base.authority_profile_code),
      authorityProfileVersion: String(base.authority_profile_version),
      status: String(base.status) as "active",
      identifierHash: String(base.identifier_hash),
      createdAt: iso(base.created_at)
    };
  });

  const bindings = bindingRows.map((row): OrganizationSourceBinding => {
    const base = verifyStoredRow(
      "organization_source_bindings",
      row,
      secrets
    );
    return {
      id: String(base.id),
      organizationId: String(base.organization_id),
      resolutionId: String(base.resolution_id),
      teamId: String(base.team_id),
      ownerId: String(base.owner_id),
      rawRecordId: String(base.raw_record_id),
      status: String(base.status) as "active",
      bindingHash: String(base.binding_hash),
      createdAt: iso(base.created_at)
    };
  });

  const conflicts = conflictRows.map((row): OrganizationIdentityConflict => {
    const base = verifyStoredRow(
      "organization_identity_conflicts",
      row,
      secrets
    );
    const team = String(base.team_id);
    const owner = String(base.owner_id);
    const id = String(base.id);
    const organizationRelations = relations.conflictOrganizations.filter(
      (item) =>
        item.conflictId === id
        && item.teamId === team
        && item.ownerId === owner
    );
    const keyRelations = relations.conflictKeys.filter((item) =>
      item.conflictId === id
      && item.teamId === team
      && item.ownerId === owner
    );
    return {
      id,
      resolutionId: String(base.resolution_id),
      teamId: team,
      ownerId: owner,
      rawRecordId: String(base.raw_record_id),
      conflictType: String(base.conflict_type) as
        OrganizationIdentityConflict["conflictType"],
      organizationIds: [...new Set(
        organizationRelations.map((item) => item.organizationId)
      )].sort(),
      identifierKeys: keyRelations.map((item) => item.identifierKey).sort(),
      status: String(base.status) as "open",
      relationHash: String(base.relation_hash),
      conflictHash: String(base.conflict_hash),
      createdAt: iso(base.created_at)
    };
  });

  const resolutions = resolutionRows.map((
    row
  ): OrganizationIdentityResolution => {
    const base = verifyStoredRow(
      "organization_identity_resolutions",
      row,
      secrets
    );
    const team = String(base.team_id);
    const owner = String(base.owner_id);
    const id = String(base.id);
    const identifierRelations = relations.resolutionIdentifiers.filter(
      (item) =>
        item.resolutionId === id
        && item.teamId === team
        && item.ownerId === owner
    );
    const bindingRelations = relations.resolutionBindings.filter((item) =>
      item.resolutionId === id
      && item.teamId === team
      && item.ownerId === owner
    );
    const conflict = conflicts.find((item) =>
      item.resolutionId === id
      && item.teamId === team
      && item.ownerId === owner
    );
    return {
      id,
      teamId: team,
      ownerId: owner,
      rawRecordId: String(base.raw_record_id),
      rawArtifactHash: String(base.raw_artifact_hash),
      processingKeyHash: String(base.processing_key_hash),
      claimHash: String(base.claim_hash),
      resolverContractVersion: String(base.resolver_contract_version) as
        typeof ORGANIZATION_STRONG_IDENTITY_CONTRACT,
      parserVersion: String(base.parser_version),
      normalizerVersion: String(base.normalizer_version),
      authorityProfileCode: String(base.authority_profile_code),
      authorityProfileVersion: String(base.authority_profile_version),
      authorityProfileHash: String(base.authority_profile_hash),
      result: String(base.result) as OrganizationIdentityResolution["result"],
      decisionReasonCode: String(base.decision_reason_code),
      organizationId: String(base.organization_id),
      bindingId: bindingRelations[0]?.bindingId || "",
      conflictId: conflict?.id || "",
      matchedIdentifierIds: identifierRelations
        .filter((item) =>
          item.role === "matched_existing"
          || item.role === "accepted_existing"
        )
        .map((item) => item.identifierId)
        .sort(),
      acceptedIdentifierIds: identifierRelations
        .filter((item) =>
          item.role === "accepted_existing" || item.role === "accepted_new"
        )
        .map((item) => item.identifierId)
        .sort(),
      bindingRelationRole: bindingRelations[0]?.role || "",
      relationHash: String(base.relation_hash),
      eventCount: Number(base.event_count),
      eventTailHash: String(base.event_tail_hash),
      resolutionHash: String(base.resolution_hash),
      createdAt: iso(base.created_at)
    };
  });

  const events = eventRows.map((row): OrganizationIdentityEvent => {
    const base = verifyStoredRow(
      "organization_identity_events",
      row,
      secrets
    );
    return {
      id: String(base.id),
      resolutionId: String(base.resolution_id),
      teamId: String(base.team_id),
      ownerId: String(base.owner_id),
      sequence: Number(base.sequence_no),
      eventType: String(base.event_type) as
        OrganizationIdentityEvent["eventType"],
      organizationId: String(base.organization_id),
      detailHash: String(base.detail_hash),
      previousEventHash: String(base.previous_event_hash),
      eventHash: String(base.event_hash),
      createdAt: iso(base.created_at)
    };
  });

  for (const resolution of resolutions) {
    const profile = profiles.get(
      `${resolution.authorityProfileCode}\u0000`
      + resolution.authorityProfileVersion
    );
    if (!profile
      || organizationIdentityAuthorityProfileHash(profile)
        !== resolution.authorityProfileHash) {
      integrityError("Resolution AuthorityProfile 引用或摘要无效");
    }
    const expectedRelations = organizationIdentityResolutionRelations(
      resolution
    );
    const actualIdentifiers = relations.resolutionIdentifiers
      .filter((item) =>
        item.resolutionId === resolution.id
        && item.teamId === resolution.teamId
        && item.ownerId === resolution.ownerId
      )
      .map((item) => ({
        identifierId: item.identifierId,
        role: item.role,
        ordinal: item.ordinal
      }));
    const actualBindings = relations.resolutionBindings
      .filter((item) =>
        item.resolutionId === resolution.id
        && item.teamId === resolution.teamId
        && item.ownerId === resolution.ownerId
      )
      .map((item) => ({
        bindingId: item.bindingId,
        role: item.role,
        ordinal: item.ordinal
      }));
    if (canonical(expectedRelations) !== canonical({
      identifiers: actualIdentifiers,
      bindings: actualBindings
    })
      || resolution.relationHash
        !== organizationIdentityResolutionRelationHash(
          resolution,
          secrets.factIntegritySecret
        )) {
      integrityError("Resolution 关系角色或摘要不一致");
    }
  }

  for (const conflict of conflicts) {
    const actual = {
      organizations: relations.conflictOrganizations
        .filter((item) =>
          item.conflictId === conflict.id
          && item.teamId === conflict.teamId
          && item.ownerId === conflict.ownerId
        )
        .map((item) => ({
          organizationId: item.organizationId,
          role: item.role,
          ordinal: item.ordinal
        })),
      keys: relations.conflictKeys
        .filter((item) =>
          item.conflictId === conflict.id
          && item.teamId === conflict.teamId
          && item.ownerId === conflict.ownerId
        )
        .map((item) => ({
          identifierKey: item.identifierKey,
          keyType: item.keyType,
          ordinal: item.ordinal
        }))
    };
    if (conflict.relationHash
      !== organizationIdentityConflictRelationHash(
        actual,
        secrets.factIntegritySecret
      )) {
      integrityError("Conflict 关系摘要不一致");
    }
  }

  const state = {
    organizations,
    organizationIdentityClaims: claims,
    organizationAcceptedIdentifiers: identifiers,
    organizationIdentityResolutions: resolutions,
    organizationSourceBindings: bindings,
    organizationIdentityConflicts: conflicts,
    organizationIdentityEvents: events
  };
  validateOrganizationIdentityFacts({
    ...(state as CrmStore),
    prospectSourceRawRecords: rawRecords
      || await loadRawRecords(source, teamId)
  }, secrets.factIntegritySecret);
  return state;
}

function memorySnapshot(
  store: CrmStore,
  rawRecords: ProspectSourceRawRecord[],
  state: OrganizationIdentityState
): CrmStore {
  return {
    ...store,
    mode: "memory",
    prospectSourceRawRecords: structuredClone(rawRecords),
    organizations: structuredClone(state.organizations),
    organizationIdentityClaims:
      structuredClone(state.organizationIdentityClaims),
    organizationAcceptedIdentifiers:
      structuredClone(state.organizationAcceptedIdentifiers),
    organizationIdentityResolutions:
      structuredClone(state.organizationIdentityResolutions),
    organizationSourceBindings:
      structuredClone(state.organizationSourceBindings),
    organizationIdentityConflicts:
      structuredClone(state.organizationIdentityConflicts),
    organizationIdentityEvents:
      structuredClone(state.organizationIdentityEvents),
    async persist() {
      // Transaction-local Resolver snapshots never persist generically.
    },
    async readBarrier() {
      // Transaction-local state is already consistent.
    }
  };
}

function persistedResolverInput(
  input: ResolveOrganizationStrongIdentityPersistedInput,
  profile: OrganizationIdentityAuthorityProfile,
  secrets: IdentitySecrets
) {
  return {
    ...input,
    envelopeSecret: secrets.rawEnvelopeSecret,
    identitySecret: secrets.deterministicIdSecret,
    processingSecret: secrets.processingSecret,
    deterministicIdSecret: secrets.deterministicIdSecret,
    identifierLookupSecret: secrets.identifierLookupSecret,
    factIntegritySecret: secrets.factIntegritySecret,
    authorityProfile: profile
  };
}

function prepareIdentityDecision(
  store: CrmStore,
  rawRecordValue: ProspectSourceRawRecord,
  input: ResolveOrganizationStrongIdentityPersistedInput,
  profile: OrganizationIdentityAuthorityProfile,
  secrets: IdentitySecrets
) {
  const local = memorySnapshot(store, [rawRecordValue], EMPTY_STATE);
  return resolveOrganizationStrongIdentity(
    local,
    persistedResolverInput(input, profile, secrets)
  );
}

function addText(target: Set<string>, value: unknown) {
  const text = String(value || "");
  if (text) target.add(text);
}

function addRawScope(
  target: Map<string, RawRecordScope>,
  ownerId: unknown,
  recordId: unknown
) {
  const owner = String(ownerId || "");
  const record = String(recordId || "");
  if (!owner || !record) return;
  target.set(`${owner}\u0000${record}`, {
    ownerId: owner,
    recordId: record
  });
}

async function rowsByIds(
  source: QuerySource,
  table: string,
  teamId: string,
  ids: ReadonlySet<string>,
  columns: string
) {
  if (!ids.size) return [] as Record<string, unknown>[];
  return queryRows<Record<string, unknown>>(
    source,
    `SELECT ${columns} FROM \`${table}\`
     WHERE team_id = ? AND id IN (${[...ids].map(() => "?").join(",")})`,
    [teamId, ...ids]
  );
}

async function relationRowsByParentIds(
  source: QuerySource,
  table: string,
  teamId: string,
  parentColumn: "resolution_id" | "conflict_id",
  parentIds: ReadonlySet<string>,
  columns: string
) {
  if (!parentIds.size) return [] as Record<string, unknown>[];
  return queryRows<Record<string, unknown>>(
    source,
    `SELECT ${columns} FROM \`${table}\`
     WHERE team_id = ? AND ${parentColumn} IN (${
       [...parentIds].map(() => "?").join(",")
     })`,
    [teamId, ...parentIds]
  );
}

async function discoverIdentityDecisionClosure(
  source: QuerySource,
  store: CrmStore,
  currentRaw: ProspectSourceRawRecord,
  input: ResolveOrganizationStrongIdentityPersistedInput,
  profile: OrganizationIdentityAuthorityProfile,
  secrets: IdentitySecrets
): Promise<IdentityDecisionClosure> {
  const prepared = prepareIdentityDecision(
    store,
    currentRaw,
    input,
    profile,
    secrets
  );
  const organizationIds = new Set<string>();
  const claimIds = new Set<string>();
  const identifierIds = new Set<string>();
  const resolutionIds = new Set<string>();
  const bindingIds = new Set<string>();
  const conflictIds = new Set<string>();
  const rawScopes = new Map<string, RawRecordScope>();
  const targetOrganizationIds = new Set<string>();

  addText(resolutionIds, prepared.resolution.id);
  addText(organizationIds, prepared.createdOrganization?.id);
  addText(targetOrganizationIds, prepared.createdOrganization?.id);
  for (const claim of prepared.claims) addText(claimIds, claim.id);
  for (const identifier of prepared.createdIdentifiers) {
    addText(identifierIds, identifier.id);
  }
  addText(bindingIds, prepared.binding?.id);
  addText(conflictIds, prepared.conflict?.id);
  addRawScope(rawScopes, currentRaw.ownerId, currentRaw.id);

  const processingRows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT id FROM organization_identity_resolutions
     WHERE team_id = ? AND owner_id = ?
       AND (processing_key_hash = ? OR id = ?)`,
    [
      input.teamId,
      input.ownerId,
      prepared.resolution.processingKeyHash,
      prepared.resolution.id
    ]
  );
  for (const row of processingRows) addText(resolutionIds, row.id);

  const predictedBindingId = prepared.binding?.id || "";
  const initialBindingRows = await queryRows<Record<string, unknown>>(
    source,
    `SELECT id,organization_id,resolution_id,owner_id,raw_record_id
     FROM organization_source_bindings
     WHERE team_id = ? AND (
       (owner_id = ? AND raw_record_id = ? AND status = 'active')
       ${predictedBindingId ? "OR id = ?" : ""}
     )`,
    [
      input.teamId,
      input.ownerId,
      input.rawRecordId,
      ...(predictedBindingId ? [predictedBindingId] : [])
    ]
  );
  for (const row of initialBindingRows) {
    addText(bindingIds, row.id);
    addText(resolutionIds, row.resolution_id);
    addText(organizationIds, row.organization_id);
    addText(targetOrganizationIds, row.organization_id);
    addRawScope(rawScopes, row.owner_id, row.raw_record_id);
  }

  const incomingIdentifiers = prepared.createdIdentifiers;
  const identifierPredicates: string[] = [];
  const identifierValues: unknown[] = [input.teamId];
  if (identifierIds.size) {
    identifierPredicates.push(
      `id IN (${[...identifierIds].map(() => "?").join(",")})`
    );
    identifierValues.push(...identifierIds);
  }
  if (incomingIdentifiers.length) {
    identifierPredicates.push(`(status = 'active' AND (${
      incomingIdentifiers.map(() =>
        "(kind = ? AND scheme = ? AND jurisdiction = ? "
        + "AND normalized_value_hash = ?)"
      ).join(" OR ")
    }))`);
    for (const identifier of incomingIdentifiers) {
      identifierValues.push(
        identifier.kind,
        identifier.scheme,
        identifier.jurisdiction,
        identifier.normalizedValueHash
      );
    }
  }
  if (identifierPredicates.length) {
    const initialIdentifierRows = await queryRows<Record<string, unknown>>(
      source,
      `SELECT id,organization_id,source_claim_id,source_owner_id,
              source_raw_record_id
       FROM organization_accepted_identifiers
       WHERE team_id = ? AND (${identifierPredicates.join(" OR ")})`,
      identifierValues
    );
    for (const row of initialIdentifierRows) {
      addText(identifierIds, row.id);
      addText(organizationIds, row.organization_id);
      addText(targetOrganizationIds, row.organization_id);
      addText(claimIds, row.source_claim_id);
      addRawScope(
        rawScopes,
        row.source_owner_id,
        row.source_raw_record_id
      );
    }
  }

  if (targetOrganizationIds.size && incomingIdentifiers.length) {
    const slotPredicates = incomingIdentifiers.map(() =>
      "(kind = ? AND scheme = ? AND jurisdiction = ?)"
    );
    const sameSlotRows = await queryRows<Record<string, unknown>>(
      source,
      `SELECT id FROM organization_accepted_identifiers
       WHERE team_id = ? AND status = 'active'
         AND organization_id IN (${
           [...targetOrganizationIds].map(() => "?").join(",")
         })
         AND (${slotPredicates.join(" OR ")})`,
      [
        input.teamId,
        ...targetOrganizationIds,
        ...incomingIdentifiers.flatMap((identifier) => [
          identifier.kind,
          identifier.scheme,
          identifier.jurisdiction
        ])
      ]
    );
    for (const row of sameSlotRows) addText(identifierIds, row.id);
  }

  let previousSize = -1;
  let converged = false;
  for (let pass = 0; pass < 128; pass += 1) {
    const totalSize = organizationIds.size
      + claimIds.size
      + identifierIds.size
      + resolutionIds.size
      + bindingIds.size
      + conflictIds.size
      + rawScopes.size;
    if (totalSize === previousSize) {
      converged = true;
      break;
    }
    previousSize = totalSize;

    const [
      resolutions,
      claims,
      identifiers,
      bindings,
      conflicts,
      resolutionIdentifierRelations,
      resolutionBindingRelations,
      conflictOrganizationRelations
    ] = await Promise.all([
      rowsByIds(
        source,
        "organization_identity_resolutions",
        input.teamId,
        resolutionIds,
        "id,owner_id,raw_record_id,organization_id,binding_id,conflict_id"
      ),
      queryRows<Record<string, unknown>>(
        source,
        `SELECT id,resolution_id,owner_id,raw_record_id
         FROM organization_identity_claims
         WHERE team_id = ? AND (${
           resolutionIds.size
             ? `resolution_id IN (${
                 [...resolutionIds].map(() => "?").join(",")
               })`
             : "1 = 0"
         }${claimIds.size
           ? ` OR id IN (${[...claimIds].map(() => "?").join(",")})`
           : ""})`,
        [input.teamId, ...resolutionIds, ...claimIds]
      ),
      rowsByIds(
        source,
        "organization_accepted_identifiers",
        input.teamId,
        identifierIds,
        "id,organization_id,source_claim_id,source_owner_id,"
        + "source_raw_record_id"
      ),
      rowsByIds(
        source,
        "organization_source_bindings",
        input.teamId,
        bindingIds,
        "id,organization_id,resolution_id,owner_id,raw_record_id"
      ),
      rowsByIds(
        source,
        "organization_identity_conflicts",
        input.teamId,
        conflictIds,
        "id,resolution_id,owner_id,raw_record_id"
      ),
      relationRowsByParentIds(
        source,
        "organization_identity_resolution_identifiers",
        input.teamId,
        "resolution_id",
        resolutionIds,
        "identifier_id"
      ),
      relationRowsByParentIds(
        source,
        "organization_identity_resolution_bindings",
        input.teamId,
        "resolution_id",
        resolutionIds,
        "binding_id"
      ),
      relationRowsByParentIds(
        source,
        "organization_identity_conflict_organizations",
        input.teamId,
        "conflict_id",
        conflictIds,
        "organization_id"
      )
    ]);

    for (const row of resolutions) {
      addText(resolutionIds, row.id);
      addText(organizationIds, row.organization_id);
      addText(bindingIds, row.binding_id);
      addText(conflictIds, row.conflict_id);
      addRawScope(rawScopes, row.owner_id, row.raw_record_id);
    }
    for (const row of claims) {
      addText(claimIds, row.id);
      addText(resolutionIds, row.resolution_id);
      addRawScope(rawScopes, row.owner_id, row.raw_record_id);
    }
    for (const row of identifiers) {
      addText(identifierIds, row.id);
      addText(organizationIds, row.organization_id);
      addText(claimIds, row.source_claim_id);
      addRawScope(
        rawScopes,
        row.source_owner_id,
        row.source_raw_record_id
      );
    }
    for (const row of bindings) {
      addText(bindingIds, row.id);
      addText(organizationIds, row.organization_id);
      addText(resolutionIds, row.resolution_id);
      addRawScope(rawScopes, row.owner_id, row.raw_record_id);
    }
    for (const row of conflicts) {
      addText(conflictIds, row.id);
      addText(resolutionIds, row.resolution_id);
      addRawScope(rawScopes, row.owner_id, row.raw_record_id);
    }
    for (const row of resolutionIdentifierRelations) {
      addText(identifierIds, row.identifier_id);
    }
    for (const row of resolutionBindingRelations) {
      addText(bindingIds, row.binding_id);
    }
    for (const row of conflictOrganizationRelations) {
      addText(organizationIds, row.organization_id);
    }
  }
  if (!converged) {
    integrityError("企业身份决策闭包未在安全上限内收敛");
  }

  const selection: IdentityStateSelection = {
    organizationIds: [...organizationIds],
    claimIds: [...claimIds],
    identifierIds: [...identifierIds],
    resolutionIds: [...resolutionIds],
    bindingIds: [...bindingIds],
    conflictIds: [...conflictIds]
  };
  const rawRecords = await loadRawRecordsByScopes(
    source,
    input.teamId,
    [...rawScopes.values()]
  );
  const state = await loadOrganizationIdentityState(
    source,
    rawRecords,
    input.teamId,
    selection
  );
  return { rawRecords, state };
}

function storageOrganization(
  item: Organization,
  secrets: IdentitySecrets
) {
  const base = {
    id: item.id,
    team_id: item.teamId,
    scope_type: item.scopeType,
    scope_id: item.scopeId,
    status: item.status,
    legal_name_encrypted: encryptField(
      item.legalName,
      secrets.fieldEncryptionKey,
      fieldAad({
        table: "organizations",
        teamId: item.teamId,
        rowId: item.id,
        field: "legal_name"
      })
    ),
    normalized_name_encrypted: encryptField(
      item.normalizedName,
      secrets.fieldEncryptionKey,
      fieldAad({
        table: "organizations",
        teamId: item.teamId,
        rowId: item.id,
        field: "normalized_name"
      })
    ),
    organization_hash: item.organizationHash,
    created_at: item.createdAt
  };
  return {
    ...base,
    row_mac: rowMac("organizations", base, secrets.factIntegrityKey)
  };
}

function storageClaim(
  item: OrganizationIdentityClaim,
  secrets: IdentitySecrets
) {
  const aad = (field: string) => fieldAad({
    table: "organization_identity_claims",
    teamId: item.teamId,
    ownerId: item.ownerId,
    rowId: item.id,
    parentId: item.resolutionId,
    field,
    ordinal: item.ordinal
  });
  const base = {
    id: item.id,
    resolution_id: item.resolutionId,
    team_id: item.teamId,
    owner_id: item.ownerId,
    raw_record_id: item.rawRecordId,
    ordinal: item.ordinal,
    kind: item.kind,
    original_value_encrypted: encryptField(
      item.originalValue,
      secrets.fieldEncryptionKey,
      aad("original_value")
    ),
    normalized_value_encrypted: encryptField(
      item.normalizedValue,
      secrets.fieldEncryptionKey,
      aad("normalized_value")
    ),
    scheme: item.scheme,
    jurisdiction: item.jurisdiction,
    entity_type: item.entityType,
    subject_ref_encrypted: encryptField(
      item.subjectRef,
      secrets.fieldEncryptionKey,
      aad("subject_ref")
    ),
    classification: item.classification,
    normalizer_version: item.normalizerVersion,
    validator_version: item.validatorVersion,
    authority_profile_code: item.authorityProfileCode,
    observed_at: item.observedAt,
    claim_hash: item.claimHash,
    claim_fact_hash: item.claimFactHash,
    created_at: item.createdAt
  };
  return {
    ...base,
    row_mac: rowMac(
      "organization_identity_claims",
      base,
      secrets.factIntegrityKey
    )
  };
}

function storageIdentifier(
  item: OrganizationAcceptedIdentifier,
  secrets: IdentitySecrets
) {
  const base = {
    id: item.id,
    organization_id: item.organizationId,
    team_id: item.teamId,
    kind: item.kind,
    scheme: item.scheme,
    jurisdiction: item.jurisdiction,
    normalized_value_encrypted: encryptField(
      item.normalizedValue,
      secrets.fieldEncryptionKey,
      fieldAad({
        table: "organization_accepted_identifiers",
        teamId: item.teamId,
        ownerId: item.sourceOwnerId,
        rowId: item.id,
        parentId: item.organizationId,
        field: "normalized_value",
        role: item.kind
      })
    ),
    normalized_value_hash: item.normalizedValueHash,
    source_claim_id: item.sourceClaimId,
    source_raw_record_id: item.sourceRawRecordId,
    source_owner_id: item.sourceOwnerId,
    authority_profile_code: item.authorityProfileCode,
    authority_profile_version: item.authorityProfileVersion,
    status: item.status,
    identifier_hash: item.identifierHash,
    created_at: item.createdAt
  };
  return {
    ...base,
    row_mac: rowMac(
      "organization_accepted_identifiers",
      base,
      secrets.factIntegrityKey
    )
  };
}

function storageResolution(
  item: OrganizationIdentityResolution,
  secrets: IdentitySecrets
) {
  const base = {
    id: item.id,
    team_id: item.teamId,
    owner_id: item.ownerId,
    raw_record_id: item.rawRecordId,
    raw_artifact_hash: item.rawArtifactHash,
    processing_key_hash: item.processingKeyHash,
    claim_hash: item.claimHash,
    resolver_contract_version: item.resolverContractVersion,
    parser_version: item.parserVersion,
    normalizer_version: item.normalizerVersion,
    authority_profile_code: item.authorityProfileCode,
    authority_profile_version: item.authorityProfileVersion,
    authority_profile_hash: item.authorityProfileHash,
    result: item.result,
    decision_reason_code: item.decisionReasonCode,
    organization_id: item.organizationId,
    binding_id: item.bindingId,
    conflict_id: item.conflictId,
    relation_hash: item.relationHash,
    event_count: item.eventCount,
    event_tail_hash: item.eventTailHash,
    resolution_hash: item.resolutionHash,
    created_at: item.createdAt
  };
  return {
    ...base,
    row_mac: rowMac(
      "organization_identity_resolutions",
      base,
      secrets.factIntegrityKey
    )
  };
}

function storageBinding(
  item: OrganizationSourceBinding,
  secrets: IdentitySecrets
) {
  const base = {
    id: item.id,
    organization_id: item.organizationId,
    resolution_id: item.resolutionId,
    team_id: item.teamId,
    owner_id: item.ownerId,
    raw_record_id: item.rawRecordId,
    status: item.status,
    binding_hash: item.bindingHash,
    created_at: item.createdAt
  };
  return {
    ...base,
    row_mac: rowMac(
      "organization_source_bindings",
      base,
      secrets.factIntegrityKey
    )
  };
}

function storageConflict(
  item: OrganizationIdentityConflict,
  secrets: IdentitySecrets
) {
  const base = {
    id: item.id,
    resolution_id: item.resolutionId,
    team_id: item.teamId,
    owner_id: item.ownerId,
    raw_record_id: item.rawRecordId,
    conflict_type: item.conflictType,
    status: item.status,
    relation_hash: item.relationHash,
    conflict_hash: item.conflictHash,
    created_at: item.createdAt
  };
  return {
    ...base,
    row_mac: rowMac(
      "organization_identity_conflicts",
      base,
      secrets.factIntegrityKey
    )
  };
}

function storageEvent(
  item: OrganizationIdentityEvent,
  secrets: IdentitySecrets
) {
  const base = {
    id: item.id,
    resolution_id: item.resolutionId,
    team_id: item.teamId,
    owner_id: item.ownerId,
    sequence_no: item.sequence,
    event_type: item.eventType,
    organization_id: item.organizationId,
    detail_hash: item.detailHash,
    previous_event_hash: item.previousEventHash,
    event_hash: item.eventHash,
    created_at: item.createdAt
  };
  return {
    ...base,
    row_mac: rowMac(
      "organization_identity_events",
      base,
      secrets.factIntegrityKey
    )
  };
}

async function insertRow(
  connection: mysql.PoolConnection,
  table: string,
  row: Record<string, unknown>
) {
  const columns = Object.keys(row);
  try {
    await connection.query(
      `INSERT INTO \`${table}\` (${
        columns.map((column) => `\`${column}\``).join(",")
      }) VALUES (${columns.map(() => "?").join(",")})`,
      columns.map((column) =>
        column.endsWith("_at") ? new Date(String(row[column])) : row[column]
      )
    );
  } catch (error) {
    if (isDuplicateEntry(error) && error && typeof error === "object") {
      duplicateWriteTables.set(error, table);
    }
    throw error;
  }
}

async function insertResolutionRelations(
  connection: mysql.PoolConnection,
  resolution: OrganizationIdentityResolution,
  secrets: IdentitySecrets
) {
  const relations = organizationIdentityResolutionRelations(resolution);
  if (resolution.relationHash
    !== organizationIdentityResolutionRelationHash(
      resolution,
      secrets.factIntegritySecret
    )) {
    integrityError("待提交 Resolution 关系摘要无效");
  }
  for (const item of relations.identifiers) {
    const base = {
      resolution_id: resolution.id,
      team_id: resolution.teamId,
      owner_id: resolution.ownerId,
      ordinal: item.ordinal,
      identifier_id: item.identifierId,
      relation_role: item.role
    };
    await insertRow(
      connection,
      "organization_identity_resolution_identifiers",
      {
        ...base,
        row_mac: rowMac(
          "organization_identity_resolution_identifiers",
          base,
          secrets.factIntegrityKey
        )
      }
    );
  }
  for (const item of relations.bindings) {
    const base = {
      resolution_id: resolution.id,
      team_id: resolution.teamId,
      owner_id: resolution.ownerId,
      ordinal: item.ordinal,
      binding_id: item.bindingId,
      relation_role: item.role
    };
    await insertRow(
      connection,
      "organization_identity_resolution_bindings",
      {
        ...base,
        row_mac: rowMac(
          "organization_identity_resolution_bindings",
          base,
          secrets.factIntegrityKey
        )
      }
    );
  }
}

async function insertConflictRelations(
  connection: mysql.PoolConnection,
  conflict: OrganizationIdentityConflict,
  matchedOrganizationIds: string[],
  existingBindingOrganizationId: string,
  secrets: IdentitySecrets
) {
  const relations = organizationIdentityConflictRelations(
    conflict,
    matchedOrganizationIds,
    existingBindingOrganizationId
  );
  if (conflict.relationHash
    !== organizationIdentityConflictRelationHash(
      relations,
      secrets.factIntegritySecret
    )) {
    integrityError("待提交 Conflict 关系摘要无效");
  }
  for (const item of relations.organizations) {
    const base = {
      conflict_id: conflict.id,
      team_id: conflict.teamId,
      owner_id: conflict.ownerId,
      ordinal: item.ordinal,
      organization_id: item.organizationId,
      relation_role: item.role
    };
    await insertRow(
      connection,
      "organization_identity_conflict_organizations",
      {
        ...base,
        row_mac: rowMac(
          "organization_identity_conflict_organizations",
          base,
          secrets.factIntegrityKey
        )
      }
    );
  }
  for (const item of relations.keys) {
    const encrypted = encryptField(
      item.identifierKey,
      secrets.fieldEncryptionKey,
      fieldAad({
        table: "organization_identity_conflict_keys",
        teamId: conflict.teamId,
        ownerId: conflict.ownerId,
        rowId: conflict.id,
        parentId: conflict.id,
        field: "identifier_key",
        role: item.keyType,
        ordinal: item.ordinal
      })
    );
    const base = {
      conflict_id: conflict.id,
      team_id: conflict.teamId,
      owner_id: conflict.ownerId,
      ordinal: item.ordinal,
      key_type: item.keyType,
      identifier_key_encrypted: encrypted,
      identifier_key_hash: sha256({
        contract: "organization-identity-conflict-key-v1",
        teamId: conflict.teamId,
        ownerId: conflict.ownerId,
        conflictId: conflict.id,
        keyType: item.keyType,
        identifierKey: item.identifierKey
      })
    };
    await insertRow(connection, "organization_identity_conflict_keys", {
      ...base,
      row_mac: rowMac(
        "organization_identity_conflict_keys",
        base,
        secrets.factIntegrityKey
      )
    });
  }
}

async function appendResult(
  connection: mysql.PoolConnection,
  result: ResolveOrganizationStrongIdentityResult,
  before: OrganizationIdentityState,
  secrets: IdentitySecrets
) {
  if (result.idempotent) return;
  if (result.createdOrganization) {
    await insertRow(
      connection,
      "organizations",
      storageOrganization(result.createdOrganization, secrets)
    );
  }
  await insertRow(
    connection,
    "organization_identity_resolutions",
    storageResolution(result.resolution, secrets)
  );
  for (const claim of result.claims) {
    await insertRow(
      connection,
      "organization_identity_claims",
      storageClaim(claim, secrets)
    );
  }
  for (const identifier of result.createdIdentifiers) {
    await insertRow(
      connection,
      "organization_accepted_identifiers",
      storageIdentifier(identifier, secrets)
    );
  }
  const bindingIsNew = result.binding
    && !before.organizationSourceBindings.some((item) =>
      item.id === result.binding!.id
    );
  if (bindingIsNew && result.binding) {
    await insertRow(
      connection,
      "organization_source_bindings",
      storageBinding(result.binding, secrets)
    );
  }
  if (result.conflict) {
    await insertRow(
      connection,
      "organization_identity_conflicts",
      storageConflict(result.conflict, secrets)
    );
  }
  await insertResolutionRelations(connection, result.resolution, secrets);
  if (result.conflict) {
    const identifiersById = new Map(
      before.organizationAcceptedIdentifiers.map((item) => [item.id, item])
    );
    const matchedOrganizationIds = result.resolution.matchedIdentifierIds
      .map((id) => identifiersById.get(id)?.organizationId || "")
      .filter(Boolean);
    const existingBinding = before.organizationSourceBindings.find((item) =>
      item.teamId === result.resolution.teamId
      && item.ownerId === result.resolution.ownerId
      && item.rawRecordId === result.resolution.rawRecordId
      && item.status === "active"
    );
    await insertConflictRelations(
      connection,
      result.conflict,
      matchedOrganizationIds,
      existingBinding?.organizationId || "",
      secrets
    );
  }
  for (const event of result.events) {
    await insertRow(
      connection,
      "organization_identity_events",
      storageEvent(event, secrets)
    );
  }
}

function replaceIdentityState(
  store: CrmStore,
  state: OrganizationIdentityState
) {
  const names = Object.keys(state) as Array<keyof OrganizationIdentityState>;
  for (const name of names) {
    const target = store[name] as unknown[];
    target.splice(0, target.length, ...structuredClone(state[name]));
  }
}

function replaceTeamIdentityState(
  store: CrmStore,
  teamId: string,
  state: OrganizationIdentityState,
  guardVersion?: number
) {
  const versions = identityCacheVersions.get(store) || new Map<string, number>();
  const currentVersion = versions.get(teamId) || 0;
  if (guardVersion !== undefined && guardVersion < currentVersion) return false;
  const names = Object.keys(state) as Array<keyof OrganizationIdentityState>;
  for (const name of names) {
    const target = store[name] as Array<{ teamId: string }>;
    target.splice(
      0,
      target.length,
      ...target.filter((item) => item.teamId !== teamId),
      ...structuredClone(
        state[name] as Array<{ teamId: string }>
      )
    );
  }
  if (guardVersion !== undefined) {
    versions.set(teamId, guardVersion);
    identityCacheVersions.set(store, versions);
  }
  const statuses = identityCacheStatuses.get(store)
    || new Map<string, OrganizationIdentityTeamCacheStatus>();
  statuses.set(teamId, "fresh");
  identityCacheStatuses.set(store, statuses);
  return true;
}

function currentTeamCacheVersion(store: CrmStore, teamId: string) {
  return identityCacheVersions.get(store)?.get(teamId) || 0;
}

function invalidateTeamCache(
  store: CrmStore,
  teamId: string,
  maximumVersion?: number
) {
  const versions = identityCacheVersions.get(store) || new Map<string, number>();
  const currentVersion = versions.get(teamId) || 0;
  if (maximumVersion !== undefined && currentVersion > maximumVersion) {
    return false;
  }
  const highWaterVersion = Math.max(
    currentVersion,
    maximumVersion || 0
  );
  if (highWaterVersion > 0) {
    versions.set(teamId, highWaterVersion);
    identityCacheVersions.set(store, versions);
  }
  const statuses = identityCacheStatuses.get(store)
    || new Map<string, OrganizationIdentityTeamCacheStatus>();
  statuses.set(teamId, "unavailable");
  identityCacheStatuses.set(store, statuses);
  return true;
}

async function recoverCommittedResult(
  pool: mysql.Pool,
  store: CrmStore,
  input: ResolveOrganizationStrongIdentityPersistedInput,
  profile: OrganizationIdentityAuthorityProfile,
  secrets: IdentitySecrets
): Promise<
  | {
      status: "committed";
      result: ResolveOrganizationStrongIdentityResult;
    }
  | { status: "absent" }
> {
  let connection: mysql.PoolConnection | null = null;
  let destroyed = false;
  let transactionStarted = false;
  let commitStarted = false;
  try {
    connection = await pool.getConnection();
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
    await connection.beginTransaction();
    transactionStarted = true;
    await connection.query(
      `INSERT INTO organization_identity_team_guards (
         team_id,guard_version,updated_at
       ) VALUES (?,1,?)
       ON DUPLICATE KEY UPDATE team_id = VALUES(team_id)`,
      [input.teamId, new Date(input.resolvedAt)]
    );
    const guardRows = await queryRows<{ team_id: string }>(
      connection,
      `SELECT team_id FROM organization_identity_team_guards
       WHERE team_id = ? FOR UPDATE`,
      [input.teamId]
    );
    if (guardRows.length !== 1) {
      integrityError("未知 COMMIT 恢复无法建立团队事务保护记录");
    }
    const rawRows = await queryRows<Record<string, unknown>>(
      connection,
      `SELECT * FROM prospect_source_raw_records
       WHERE team_id = ? AND owner_id = ? AND id = ?`,
      [input.teamId, input.ownerId, input.rawRecordId]
    );
    if (rawRows.length !== 1) {
      integrityError("未知 COMMIT 恢复无法确认 Provider 原始记录");
    }
    const closure = await discoverIdentityDecisionClosure(
      connection,
      store,
      rawRecord(rawRows[0]!),
      input,
      profile,
      secrets
    );
    const local = memorySnapshot(
      store,
      closure.rawRecords,
      closure.state
    );
    const replay = resolveOrganizationStrongIdentity(local, {
      ...persistedResolverInput(input, profile, secrets)
    });
    commitStarted = true;
    await connection.commit();
    transactionStarted = false;
    return replay.idempotent
      ? { status: "committed", result: replay }
      : { status: "absent" };
  } catch (error) {
    let rollbackSucceeded = true;
    if (connection && transactionStarted) {
      if (commitStarted) {
        destroyed = true;
        try {
          connection.destroy();
        } catch {
          // A connection with uncertain transaction state is never reused.
        }
      } else {
        try {
          await connection.rollback();
        } catch {
          rollbackSucceeded = false;
          destroyed = true;
          try {
            connection.destroy();
          } catch {
            // A connection with uncertain transaction state is never reused.
          }
        }
      }
    }
    if (!commitStarted
      && rollbackSucceeded
      && error instanceof OrganizationStrongIdentityError) {
      throw error;
    }
    throw new OrganizationStrongIdentityError(
      "IDENTITY_COMMIT_OUTCOME_UNKNOWN",
      "企业身份事务 COMMIT 结果仍无法确认"
    );
  } finally {
    if (connection && !destroyed) connection.release();
  }
}

async function refreshTeamCacheGuarded(
  pool: mysql.Pool,
  store: CrmStore,
  teamId: string
): Promise<OrganizationIdentityTeamCacheStatus> {
  let connection: mysql.PoolConnection | null = null;
  let transactionStarted = false;
  let commitStarted = false;
  let destroyed = false;
  const startingVersion = currentTeamCacheVersion(store, teamId);
  let observedVersion = startingVersion;
  try {
    connection = await pool.getConnection();
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
    await connection.beginTransaction();
    transactionStarted = true;
    const guards = await queryRows<{
      team_id: string;
      guard_version: number | string;
    }>(
      connection,
      `SELECT team_id,guard_version FROM organization_identity_team_guards
       WHERE team_id = ? FOR UPDATE`,
      [teamId]
    );
    if (guards.length !== 1) {
      integrityError("刷新企业身份缓存时缺少团队事务保护记录");
    }
    observedVersion = Number(guards[0]!.guard_version);
    if (!Number.isSafeInteger(observedVersion) || observedVersion < 1) {
      integrityError("刷新企业身份缓存时团队事务版本无效");
    }
    const rawRecords = await loadRawRecords(connection, teamId);
    const state = await loadOrganizationIdentityState(
      connection,
      rawRecords,
      teamId
    );
    commitStarted = true;
    await connection.commit();
    transactionStarted = false;
    return replaceTeamIdentityState(
      store,
      teamId,
      state,
      observedVersion
    )
      ? "fresh"
      : "stale";
  } catch {
    if (connection && transactionStarted) {
      if (commitStarted) {
        destroyed = true;
        try {
          connection.destroy();
        } catch {
          // A failed cache transaction connection remains quarantined.
        }
      } else {
        try {
          await connection.rollback();
        } catch {
          destroyed = true;
          try {
            connection.destroy();
          } catch {
            // A failed cache transaction connection remains quarantined.
          }
        }
      }
    }
    return invalidateTeamCache(store, teamId, observedVersion)
      ? "unavailable"
      : "stale";
  } finally {
    if (connection && !destroyed) connection.release();
  }
}

export async function ensureOrganizationIdentityTeamCache(
  pool: mysql.Pool,
  store: CrmStore,
  teamId: string
) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const status = await refreshTeamCacheGuarded(pool, store, teamId);
    if (status !== "unavailable") return status;
  }
  throw new OrganizationStrongIdentityError(
    "IDENTITY_CACHE_UNAVAILABLE",
    "企业身份已保存，但当前实例暂时无法刷新团队数据，请重试"
  );
}

function assertNamedDuplicateRecoveryResult(
  rule: NamedDuplicateRecoveryRule,
  result: ResolveOrganizationStrongIdentityResult
) {
  if (rule.action === "processing_key") {
    if (!result.idempotent) {
      integrityError("企业身份处理键重复无法由完整重放图解释");
    }
    return;
  }
  if (result.idempotent) {
    integrityError("企业身份命名重复键恢复结果与约束类型不一致");
  }
  if (rule.action === "identifier_lookup") {
    if (!["exact_match", "conflict"].includes(result.resolution.result)) {
      integrityError("企业强标识重复无法重分类为精确匹配或冲突");
    }
    return;
  }
  const reused = result.resolution.result === "exact_match"
    && result.resolution.bindingRelationRole === "reused_existing";
  const bindingConflict = result.resolution.result === "conflict"
    && result.conflict?.conflictType === "binding_conflict";
  if (!reused && !bindingConflict) {
    integrityError("活动来源绑定重复无法重分类为复用或绑定冲突");
  }
}

async function resolveNamedDuplicateInNewTransaction(
  pool: mysql.Pool,
  store: CrmStore,
  input: ResolveOrganizationStrongIdentityPersistedInput,
  profile: OrganizationIdentityAuthorityProfile,
  secrets: IdentitySecrets,
  rule: NamedDuplicateRecoveryRule,
  commitAttempt = 1
): Promise<ResolveOrganizationStrongIdentityResult> {
  const connection = await pool.getConnection();
  let destroyed = false;
  let commitStarted = false;
  let commitCompleted = false;
  try {
    await connection.query(
      "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
    );
    await connection.beginTransaction();
    await initializeMetadata(connection, secrets, input.resolvedAt);
    await registerProfile(connection, profile, input.resolvedAt, secrets);
    await connection.query(
      `INSERT INTO organization_identity_team_guards (
         team_id,guard_version,updated_at
       ) VALUES (?,1,?)
       ON DUPLICATE KEY UPDATE team_id = VALUES(team_id)`,
      [input.teamId, new Date(input.resolvedAt)]
    );
    await connection.query(
      `SELECT team_id FROM organization_identity_team_guards
       WHERE team_id = ? FOR UPDATE`,
      [input.teamId]
    );
    const lockedRaw = await queryRows<Record<string, unknown>>(
      connection,
      `SELECT * FROM prospect_source_raw_records
       WHERE team_id = ? AND owner_id = ? AND id = ? FOR UPDATE`,
      [input.teamId, input.ownerId, input.rawRecordId]
    );
    if (lockedRaw.length !== 1) {
      throw new OrganizationStrongIdentityError(
        "IDENTITY_INVALID",
        "Provider 原始记录不存在或不属于当前业务员"
      );
    }
    const closure = await discoverIdentityDecisionClosure(
      connection,
      store,
      rawRecord(lockedRaw[0]!),
      input,
      profile,
      secrets
    );
    const local = memorySnapshot(
      store,
      closure.rawRecords,
      closure.state
    );
    const result = resolveOrganizationStrongIdentity(
      local,
      persistedResolverInput(input, profile, secrets)
    );
    assertNamedDuplicateRecoveryResult(rule, result);
    await appendResult(connection, result, closure.state, secrets);
    await connection.query(
      `UPDATE organization_identity_team_guards
       SET guard_version = guard_version + 1, updated_at = ?
       WHERE team_id = ?`,
      [new Date(input.resolvedAt), input.teamId]
    );
    commitStarted = true;
    await connection.commit();
    commitCompleted = true;
    await ensureOrganizationIdentityTeamCache(pool, store, input.teamId);
    return result;
  } catch (error) {
    if (commitCompleted) throw error;
    if (commitStarted) {
      destroyed = true;
      try {
        connection.destroy();
      } catch {
        // A write connection with an unknown COMMIT result is quarantined.
      }
      const recovered = await recoverCommittedResult(
        pool,
        store,
        input,
        profile,
        secrets
      );
      if (recovered.status === "committed") {
        await ensureOrganizationIdentityTeamCache(pool, store, input.teamId);
        return recovered.result;
      }
      if (commitAttempt < 3) {
        return resolveNamedDuplicateInNewTransaction(
          pool,
          store,
          input,
          profile,
          secrets,
          rule,
          commitAttempt + 1
        );
      }
      throw new OrganizationStrongIdentityError(
        "IDENTITY_CONCURRENCY_RETRY_EXHAUSTED",
        "企业身份命名重复键恢复事务已确认未提交，重跑次数已耗尽"
      );
    }
    let rollbackSucceeded = false;
    try {
      await connection.rollback();
      rollbackSucceeded = true;
    } catch {
      destroyed = true;
      try {
        connection.destroy();
      } catch {
        // The connection remains quarantined even if destroy fails.
      }
    }
    if (!rollbackSucceeded) {
      integrityError("企业身份命名重复键恢复事务回滚结果无法确认");
    }
    if (isDuplicateEntry(error)) {
      integrityError("企业身份命名重复键恢复未在一次新事务内收敛");
    }
    if (error instanceof OrganizationStrongIdentityError) {
      throw error;
    }
    return integrityError("企业身份命名重复键恢复失败");
  } finally {
    if (!destroyed) connection.release();
  }
}

export async function resolveOrganizationStrongIdentityMysql(
  pool: mysql.Pool,
  store: CrmStore,
  input: ResolveOrganizationStrongIdentityPersistedInput
): Promise<ResolveOrganizationStrongIdentityResult> {
  const secrets = configuredSecrets(true)!;
  const frozenInput = frozenPersistedInput(input);
  const profile = frozenAuthorityProfile(trustedProfile(
    frozenInput.authorityProfileCode,
    frozenInput.authorityProfileVersion
  ));
  let lastRetryable: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const connection = await pool.getConnection();
    let commitStarted = false;
    let commitCompleted = false;
    let connectionClosed = false;
    try {
      await connection.query(
        "SET TRANSACTION ISOLATION LEVEL READ COMMITTED"
      );
      await connection.beginTransaction();
      await initializeMetadata(connection, secrets, frozenInput.resolvedAt);
      await registerProfile(
        connection,
        profile,
        frozenInput.resolvedAt,
        secrets
      );
      await connection.query(
        `INSERT INTO organization_identity_team_guards (
           team_id,guard_version,updated_at
         ) VALUES (?,1,?)
         ON DUPLICATE KEY UPDATE team_id = VALUES(team_id)`,
        [frozenInput.teamId, new Date(frozenInput.resolvedAt)]
      );
      await connection.query(
        `SELECT team_id FROM organization_identity_team_guards
         WHERE team_id = ? FOR UPDATE`,
        [frozenInput.teamId]
      );
      const lockedRaw = await queryRows<Record<string, unknown>>(
        connection,
        `SELECT * FROM prospect_source_raw_records
         WHERE team_id = ? AND owner_id = ? AND id = ? FOR UPDATE`,
        [
          frozenInput.teamId,
          frozenInput.ownerId,
          frozenInput.rawRecordId
        ]
      );
      if (lockedRaw.length !== 1) {
        throw new OrganizationStrongIdentityError(
          "IDENTITY_INVALID",
          "Provider 原始记录不存在或不属于当前业务员"
        );
      }
      const closure = await discoverIdentityDecisionClosure(
        connection,
        store,
        rawRecord(lockedRaw[0]!),
        frozenInput,
        profile,
        secrets
      );
      const local = memorySnapshot(
        store,
        closure.rawRecords,
        closure.state
      );
      const result = resolveOrganizationStrongIdentity(
        local,
        persistedResolverInput(frozenInput, profile, secrets)
      );
      await appendResult(connection, result, closure.state, secrets);
      await connection.query(
        `UPDATE organization_identity_team_guards
         SET guard_version = guard_version + 1, updated_at = ?
         WHERE team_id = ?`,
        [new Date(frozenInput.resolvedAt), frozenInput.teamId]
      );
      commitStarted = true;
      await connection.commit();
      commitCompleted = true;
      await ensureOrganizationIdentityTeamCache(
        pool,
        store,
        frozenInput.teamId
      );
      return result;
    } catch (error) {
      if (commitCompleted) throw error;
      if (commitStarted) {
        connectionClosed = true;
        try {
          connection.destroy();
        } catch {
          // A write connection with an unknown COMMIT result is quarantined.
        }
        const recovered = await recoverCommittedResult(
          pool,
          store,
          frozenInput,
          profile,
          secrets
        );
        if (recovered.status === "committed") {
          await ensureOrganizationIdentityTeamCache(
            pool,
            store,
            frozenInput.teamId
          );
          return recovered.result;
        }
        if (attempt < 3) {
          continue;
        }
        throw new OrganizationStrongIdentityError(
          "IDENTITY_COMMIT_OUTCOME_UNKNOWN",
          "企业身份事务 COMMIT 结果无法在重跑后确认"
        );
      }
      let rollbackSucceeded = false;
      try {
        await connection.rollback();
        rollbackSucceeded = true;
      } catch {
        connectionClosed = true;
        try {
          connection.destroy();
        } catch {
          // Never return a connection with an uncertain transaction state.
        }
      }
      if (!rollbackSucceeded) {
        integrityError("企业身份事务回滚结果无法确认");
      }
      if (isRetryable(error)) {
        lastRetryable = error;
        if (attempt < 3) continue;
        throw new OrganizationStrongIdentityError(
          "IDENTITY_CONCURRENCY_RETRY_EXHAUSTED",
          "企业身份事务并发重试次数已耗尽"
        );
      }
      if (isDuplicateEntry(error)) {
        const rule = namedDuplicateRecoveryRule(error);
        if (!rule) {
          integrityError("企业身份数据库唯一约束冲突");
        }
        connection.release();
        connectionClosed = true;
        return await resolveNamedDuplicateInNewTransaction(
          pool,
          store,
          frozenInput,
          profile,
          secrets,
          rule
        );
      }
      throw error;
    } finally {
      if (!connectionClosed) connection.release();
    }
  }
  throw lastRetryable;
}
