import assert from "node:assert/strict";
import {
  createCipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID
} from "node:crypto";
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import { canonicalJsonStringify } from "./canonical-json.js";
import {
  ORGANIZATION_STRONG_IDENTITY_CONTRACT,
  OrganizationStrongIdentityError,
  resolveOrganizationStrongIdentity
} from "./organization-strong-identity.js";
import type {
  OrganizationIdentityAuthorityProfile,
  OrganizationIdentityClaimInput,
  ResolveOrganizationStrongIdentityPersistedInput
} from "./organization-strong-identity.js";
import {
  ensureOrganizationIdentitySchema,
  loadOrganizationIdentityState,
  resolveOrganizationStrongIdentityMysql
} from "./organization-strong-identity-mysql.js";
import {
  ensureProspectCoverageSchema
} from "./prospect-coverage-memory-mysql.js";
import {
  PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
  appendProspectSourceRawBatch,
  prospectProviderRawArtifactHash
} from "./prospect-source-raw.js";
import type {
  ProspectProviderSourceRecordInput
} from "./prospect-source-raw.js";
import { createMysqlStore } from "./mysql-store.js";
import { getStore } from "./store.js";
import type { CrmStore } from "./store.js";
import type { ProspectSourceRawRecord } from "./types.js";

const masterSecret =
  "organization-identity-mysql-master-secret-v1-".repeat(2);
const rawEnvelopeSecret =
  "organization-identity-mysql-raw-envelope-v1-".repeat(2);
const rawIdentitySecret =
  "organization-identity-mysql-raw-id-v1-".repeat(2);
const persistenceSchemaVersion = "organization-identity-mysql-v1";
const fieldEnvelopeVersion = "organization-identity-field-v1";
const fieldKeyVersion = "v1";
const identityHkdfSalt = Buffer.from(
  "goodjob-organization-identity-v1",
  "utf8"
);
const identityTables = [
  "organization_identity_contract_metadata",
  "organization_identity_team_guards",
  "organization_identity_authority_profiles",
  "organizations",
  "organization_identity_resolutions",
  "organization_identity_claims",
  "organization_accepted_identifiers",
  "organization_source_bindings",
  "organization_identity_conflicts",
  "organization_identity_events",
  "organization_identity_resolution_identifiers",
  "organization_identity_resolution_bindings",
  "organization_identity_conflict_organizations",
  "organization_identity_conflict_keys"
] as const;
const identityFactTables = identityTables.filter((table) =>
  ![
    "organization_identity_contract_metadata",
    "organization_identity_team_guards",
    "organization_identity_authority_profiles"
  ].includes(table)
);
const protectedBusinessArrays = [
  "leads",
  "customers",
  "deals",
  "websiteOpportunities"
] as const;
const coverageTables = [
  "prospect_coverage_events",
  "tenant_prospects",
  "prospect_coverage_team_guards",
  "prospect_coverage_contract_metadata"
] as const;

type RawFixture = {
  teamId: string;
  ownerId: string;
  record: ProspectSourceRawRecord;
};

let rawSequence = 0;
let resolutionSequence = 0;

function connectionOptions(databaseUrl: URL) {
  return {
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password)
  };
}

function sqlString(value: string) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

function canonical(value: unknown) {
  const result = canonicalJsonStringify(value);
  assert.equal(typeof result, "string");
  return result;
}

function identityTestKey(info: string) {
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(masterSecret, "utf8"),
    identityHkdfSalt,
    Buffer.from(info, "utf8"),
    32
  ));
}

function testHmac(key: Buffer | string, value: unknown) {
  return createHmac("sha256", key)
    .update(canonical(value))
    .digest("hex");
}

function testFieldAad(input: {
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
    contract: persistenceSchemaVersion,
    envelopeVersion: fieldEnvelopeVersion,
    keyVersion: fieldKeyVersion,
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

function encryptTestField(
  value: string,
  key: Buffer,
  aad: ReturnType<typeof testFieldAad>
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
    keyVersion: fieldKeyVersion,
    tag: cipher.getAuthTag().toString("base64url"),
    version: fieldEnvelopeVersion
  });
  return `${fieldEnvelopeVersion}.${Buffer.from(envelope, "utf8")
    .toString("base64url")}`;
}

function mysqlDuplicateError(
  key: string,
  overrides: Partial<{
    code: string;
    errno: number;
    sqlState: string;
    sqlMessage: string;
  }> = {}
) {
  return Object.assign(new Error("synthetic mysql duplicate"), {
    code: "ER_DUP_ENTRY",
    errno: 1062,
    sqlState: "23000",
    sqlMessage: `Duplicate entry 'sensitive-value' for key '${key}'`,
    ...overrides
  });
}

function isInsertInto(sql: string, table: string) {
  return sql.startsWith(`INSERT INTO \`${table}\``);
}

function namedDuplicateRacePool(
  base: mysql.Pool,
  options: {
    table: string;
    key: string;
    duplicate?: ReturnType<typeof mysqlDuplicateError>;
    afterRollback(): Promise<void>;
  }
) {
  const state = {
    duplicateInjected: false,
    winnerCommitted: false
  };
  const pool = instrumentPool(base, {
    connection: {
      async query(sql, proceed) {
        if (!state.duplicateInjected && isInsertInto(sql, options.table)) {
          state.duplicateInjected = true;
          throw options.duplicate || mysqlDuplicateError(options.key);
        }
        return proceed();
      },
      async rollback(proceed) {
        await proceed();
        if (state.duplicateInjected && !state.winnerCommitted) {
          await options.afterRollback();
          state.winnerCommitted = true;
        }
      }
    }
  });
  return { pool, state };
}

async function rewriteIdentifierNormalizedValue(
  connection: mysql.Connection,
  identifierId: string,
  normalizedValue: string
) {
  const [rows] = await connection.query<Array<RowDataPacket>>(
    `SELECT * FROM organization_accepted_identifiers
     WHERE id = ?`,
    [identifierId]
  );
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  const integrityKey = identityTestKey("fact-integrity-hmac-v1");
  const encryptionKey = identityTestKey("field-encryption-aes256gcm-v1");
  const createdAt = new Date(String(row.created_at)).toISOString();
  const acceptedIdentifier = {
    id: String(row.id),
    organizationId: String(row.organization_id),
    teamId: String(row.team_id),
    kind: String(row.kind),
    scheme: String(row.scheme),
    jurisdiction: String(row.jurisdiction),
    normalizedValue,
    normalizedValueHash: String(row.normalized_value_hash),
    sourceClaimId: String(row.source_claim_id),
    sourceRawRecordId: String(row.source_raw_record_id),
    sourceOwnerId: String(row.source_owner_id),
    authorityProfileCode: String(row.authority_profile_code),
    authorityProfileVersion: String(row.authority_profile_version),
    status: "active",
    createdAt
  };
  const identifierHash = testHmac(integrityKey.toString("base64url"), {
    contract: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
    fact: "accepted_identifier",
    ...acceptedIdentifier
  });
  const base = {
    id: acceptedIdentifier.id,
    organization_id: acceptedIdentifier.organizationId,
    team_id: acceptedIdentifier.teamId,
    kind: acceptedIdentifier.kind,
    scheme: acceptedIdentifier.scheme,
    jurisdiction: acceptedIdentifier.jurisdiction,
    normalized_value_encrypted: encryptTestField(
      normalizedValue,
      encryptionKey,
      testFieldAad({
        table: "organization_accepted_identifiers",
        teamId: acceptedIdentifier.teamId,
        ownerId: acceptedIdentifier.sourceOwnerId,
        rowId: acceptedIdentifier.id,
        parentId: acceptedIdentifier.organizationId,
        field: "normalized_value",
        role: acceptedIdentifier.kind
      })
    ),
    normalized_value_hash: acceptedIdentifier.normalizedValueHash,
    source_claim_id: acceptedIdentifier.sourceClaimId,
    source_raw_record_id: acceptedIdentifier.sourceRawRecordId,
    source_owner_id: acceptedIdentifier.sourceOwnerId,
    authority_profile_code: acceptedIdentifier.authorityProfileCode,
    authority_profile_version: acceptedIdentifier.authorityProfileVersion,
    status: acceptedIdentifier.status,
    identifier_hash: identifierHash,
    created_at: createdAt
  };
  const rowMac = testHmac(integrityKey, {
    contract: persistenceSchemaVersion,
    table: "organization_accepted_identifiers",
    row: base
  });
  await connection.query(
    `UPDATE organization_accepted_identifiers
     SET normalized_value_encrypted = ?,identifier_hash = ?,row_mac = ?
     WHERE id = ?`,
    [
      base.normalized_value_encrypted,
      base.identifier_hash,
      rowMac,
      identifierId
    ]
  );
}

function authorityProfile(): OrganizationIdentityAuthorityProfile {
  return {
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
  };
}

function baseClaim(
  claim: Omit<
    OrganizationIdentityClaimInput,
    "normalizerVersion" | "validatorVersion" | "observedAt"
  >
): OrganizationIdentityClaimInput {
  return {
    ...claim,
    normalizerVersion: "claim-norm-v1",
    validatorVersion: "claim-validator-v1",
    observedAt: "2026-07-14T02:00:00.000Z"
  };
}

function lei(
  value: string,
  subjectRef = "company"
): OrganizationIdentityClaimInput {
  return baseClaim({
    kind: "lei",
    value,
    entityType: "legal_entity",
    subjectRef
  });
}

function registration(
  value: string,
  scheme = "registry-a",
  subjectRef = "company"
): OrganizationIdentityClaimInput {
  return baseClaim({
    kind: "registration_number",
    value,
    normalizedValue: value,
    scheme,
    jurisdiction: "DE",
    entityType: "legal_entity",
    subjectRef
  });
}

function legalName(value: string): OrganizationIdentityClaimInput {
  return baseClaim({
    kind: "legal_name",
    value,
    jurisdiction: "DE",
    entityType: "legal_entity",
    subjectRef: "company"
  });
}

function officialDomain(value: string): OrganizationIdentityClaimInput {
  return baseClaim({
    kind: "official_domain",
    value,
    entityType: "legal_entity",
    subjectRef: "company"
  });
}

function createRawFixture(
  teamId: string,
  ownerId: string,
  payload: unknown = {}
): RawFixture {
  rawSequence += 1;
  const suffix = String(rawSequence).padStart(4, "0");
  const fetchedAt = new Date(
    Date.UTC(2026, 6, 14, 2, 0, rawSequence)
  ).toISOString();
  const sourceRecords: ProspectProviderSourceRecordInput[] = [{
    providerRecordId: `identity-mysql-record-${suffix}`,
    sourceUrl: `https://identity.example.test/mysql/${suffix}`,
    fetchedAt,
    payload
  }];
  const baseStore = getStore();
  const generatorStore: CrmStore = {
    ...baseStore,
    mode: "memory",
    prospectSourceRawBatches: [],
    prospectSourceRawRecords: [],
    prospectSourceRawHits: [],
    async persist() {
      // Raw fixtures are inserted into MySQL explicitly below.
    },
    async readBarrier() {
      // Fixture generation is synchronous.
    }
  };
  const result = appendProspectSourceRawBatch(generatorStore, {
    teamId,
    ownerId,
    runId: `identity-mysql-run-${suffix}`,
    shardId: `identity-mysql-shard-${suffix}`,
    jobId: `identity-mysql-job-${suffix}`,
    attemptId: `identity-mysql-attempt-${suffix}`,
    ledgerId: `identity-mysql-ledger-${suffix}`,
    pageId: `identity-mysql-page-${suffix}`,
    providerCode: "identity.test-provider",
    connectionId: "identity.test-provider:default",
    endpointCode: "company-identity",
    adapterVersion: "identity-mysql-adapter-v1",
    responseSchemaVersion: PROSPECT_SOURCE_RAW_SCHEMA_VERSION,
    responseHash: rawSequence.toString(16).padStart(64, "0"),
    settlementHash: (rawSequence + 10_000)
      .toString(16)
      .padStart(64, "0"),
    rawArtifactHash: prospectProviderRawArtifactHash(sourceRecords),
    sourceRecords,
    policy: {
      licensePolicy: "identity-mysql-public-api",
      retentionPolicy: "identity-mysql-30-days",
      retentionDays: 30
    },
    envelopeSecret: rawEnvelopeSecret,
    identitySecret: rawIdentitySecret,
    createdAt: fetchedAt
  });
  return {
    teamId,
    ownerId,
    record: result.records[0]!
  };
}

async function insertRawRecord(
  connection: mysql.Connection,
  fixture: RawFixture
) {
  const record = fixture.record;
  await connection.query(
    `INSERT INTO prospect_source_raw_records (
       id,team_id,owner_id,provider_code,connection_id,endpoint_code,
       source_identity_hash,artifact_hash,envelope_version,
       encrypted_envelope,envelope_hash,first_observed_at,record_hash,
       created_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      record.id,
      record.teamId,
      record.ownerId,
      record.providerCode,
      record.connectionId,
      record.endpointCode,
      record.sourceIdentityHash,
      record.artifactHash,
      record.envelopeVersion,
      record.encryptedEnvelope,
      record.envelopeHash,
      new Date(record.firstObservedAt),
      record.recordHash,
      new Date(record.createdAt)
    ]
  );
}

function persistedInput(
  raw: RawFixture,
  claims: OrganizationIdentityClaimInput[],
  overrides: Partial<ResolveOrganizationStrongIdentityPersistedInput> = {}
): ResolveOrganizationStrongIdentityPersistedInput {
  resolutionSequence += 1;
  return {
    teamId: raw.teamId,
    ownerId: raw.ownerId,
    rawRecordId: raw.record.id,
    resolverVersion: ORGANIZATION_STRONG_IDENTITY_CONTRACT,
    parserVersion: "identity-parser-v1",
    normalizerVersion: "identity-normalizer-v1",
    resolvedAt: new Date(
      Date.UTC(2026, 6, 14, 3, 0, resolutionSequence)
    ).toISOString(),
    authorityProfileCode: "identity-authority-test",
    authorityProfileVersion: "v1",
    claims,
    ...overrides
  };
}

async function resolvePersisted(
  store: CrmStore,
  raw: RawFixture,
  claims: OrganizationIdentityClaimInput[],
  overrides: Partial<ResolveOrganizationStrongIdentityPersistedInput> = {}
) {
  assert.ok(store.resolveOrganizationStrongIdentity);
  return store.resolveOrganizationStrongIdentity(
    persistedInput(raw, claims, overrides)
  );
}

function isIdentityError(
  code: OrganizationStrongIdentityError["code"]
) {
  return (error: unknown) =>
    error instanceof OrganizationStrongIdentityError
    && error.code === code;
}

async function identityFactCount(connection: mysql.Connection) {
  let count = 0;
  for (const table of identityFactTables) {
    const [rows] = await connection.query<Array<RowDataPacket>>(
      `SELECT COUNT(*) AS count FROM \`${table}\``
    );
    count += Number(rows[0]?.count || 0);
  }
  return count;
}

function snapshotBusinessArrays(store: CrmStore) {
  return Object.fromEntries(protectedBusinessArrays.map((name) => [
    name,
    structuredClone(store[name])
  ]));
}

function snapshotTeamIdentity(store: CrmStore, teamId: string) {
  return {
    organizations: structuredClone(
      store.organizations.filter((item) => item.teamId === teamId)
    ),
    claims: structuredClone(
      store.organizationIdentityClaims.filter(
        (item) => item.teamId === teamId
      )
    ),
    identifiers: structuredClone(
      store.organizationAcceptedIdentifiers.filter(
        (item) => item.teamId === teamId
      )
    ),
    resolutions: structuredClone(
      store.organizationIdentityResolutions.filter(
        (item) => item.teamId === teamId
      )
    ),
    bindings: structuredClone(
      store.organizationSourceBindings.filter(
        (item) => item.teamId === teamId
      )
    ),
    conflicts: structuredClone(
      store.organizationIdentityConflicts.filter(
        (item) => item.teamId === teamId
      )
    ),
    events: structuredClone(
      store.organizationIdentityEvents.filter(
        (item) => item.teamId === teamId
      )
    )
  };
}

async function databaseIdentitySnapshot(connection: mysql.Connection) {
  return databaseTableSnapshot(connection, identityTables);
}

async function databaseIdentityFactSnapshot(connection: mysql.Connection) {
  return databaseTableSnapshot(connection, identityFactTables);
}

async function databaseTableSnapshot(
  connection: mysql.Connection,
  tables: readonly string[]
) {
  const snapshot: Record<string, string> = {};
  for (const table of tables) {
    const [rows] = await connection.query<Array<RowDataPacket>>(
      `SELECT * FROM \`${table}\``
    );
    snapshot[table] = JSON.stringify(
      rows.map((row) => JSON.stringify(row)).sort()
    );
  }
  return snapshot;
}

async function assertColdStartRejected(
  code: OrganizationStrongIdentityError["code"]
) {
  await assert.rejects(createMysqlStore(), isIdentityError(code));
}

async function assertSchemaMutationRejected(
  mutate: () => Promise<void>,
  restore: () => Promise<void>
) {
  await mutate();
  try {
    await assertColdStartRejected("IDENTITY_DATA_INTEGRITY_VIOLATION");
  } finally {
    await restore();
  }
}

async function dropIdentitySchema(connection: mysql.Connection) {
  await connection.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const table of coverageTables) {
      await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
    for (const table of [...identityTables].reverse()) {
      await connection.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
  } finally {
    await connection.query("SET FOREIGN_KEY_CHECKS = 1");
  }
}

type ConnectionHooks = {
  beforeQuery?(sql: string): void;
  query?(
    sql: string,
    proceed: () => Promise<unknown>
  ): Promise<unknown>;
  commit?(proceed: () => Promise<void>): Promise<void>;
  rollback?(proceed: () => Promise<void>): Promise<void>;
  destroy?(): void;
  release?(): void;
};

type PoolHooks = {
  connection?: ConnectionHooks;
  beforeQuery?(sql: string): void;
};

function instrumentPool(base: mysql.Pool, hooks: PoolHooks): mysql.Pool {
  return new Proxy(base, {
    get(target, property) {
      if (property === "getConnection") {
        return async () => {
          const connection = await target.getConnection();
          return new Proxy(connection, {
            get(connectionTarget, connectionProperty) {
              if (connectionProperty === "query") {
                return (...args: unknown[]) => {
                  const sql = String(args[0] || "");
                  hooks.connection?.beforeQuery?.(sql);
                  const operation = Reflect.get(
                    connectionTarget,
                    connectionProperty
                  ) as (...values: unknown[]) => unknown;
                  const proceed = () => Promise.resolve(
                    Reflect.apply(operation, connectionTarget, args)
                  );
                  return hooks.connection?.query
                    ? hooks.connection.query(sql, proceed)
                    : proceed();
                };
              }
              if (connectionProperty === "commit" && hooks.connection?.commit) {
                return () => hooks.connection!.commit!(async () => {
                  await connectionTarget.commit();
                });
              }
              if (connectionProperty === "rollback"
                && hooks.connection?.rollback) {
                return () => hooks.connection!.rollback!(async () => {
                  await connectionTarget.rollback();
                });
              }
              if (connectionProperty === "destroy"
                && hooks.connection?.destroy) {
                return () => {
                  try {
                    hooks.connection!.destroy!();
                  } finally {
                    connectionTarget.destroy();
                  }
                };
              }
              if (connectionProperty === "release"
                && hooks.connection?.release) {
                return () => {
                  hooks.connection!.release!();
                  connectionTarget.release();
                };
              }
              const value = Reflect.get(connectionTarget, connectionProperty);
              return typeof value === "function"
                ? value.bind(connectionTarget)
                : value;
            }
          });
        };
      }
      if (property === "query") {
        return (...args: unknown[]) => {
          hooks.beforeQuery?.(String(args[0] || ""));
          const operation = Reflect.get(target, property) as
            (...values: unknown[]) => unknown;
          return Reflect.apply(operation, target, args);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

async function main() {
  const applicationUrl = process.env.DATABASE_URL
    || process.env.MYSQL_URL
    || process.env.MYSQL_TEST_ADMIN_URL;
  const adminConnectionUrl = process.env.MYSQL_TEST_ADMIN_URL
    || applicationUrl;
  if (!applicationUrl || !adminConnectionUrl) {
    throw new Error(
      "Organization Identity MySQL test requires MYSQL_TEST_ADMIN_URL, "
      + "DATABASE_URL or MYSQL_URL"
    );
  }

  const adminUrl = new URL(adminConnectionUrl);
  const appUrl = new URL(applicationUrl);
  const databaseName =
    `goodjob_identity_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let databaseCreated = false;
  let grantedAccount = "";
  let exitCode = 1;
  let stage = "create database";

  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\`
       CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    databaseCreated = true;
    const appProbe = await mysql.createConnection(connectionOptions(appUrl));
    const [accountRows] = await appProbe.query<Array<RowDataPacket>>(
      "SELECT CURRENT_USER() AS account"
    );
    await appProbe.end();
    grantedAccount = String(accountRows[0]?.account || "");
    const separator = grantedAccount.lastIndexOf("@");
    if (separator <= 0) {
      throw new Error("Cannot resolve MySQL application account");
    }
    const accountUser = grantedAccount.slice(0, separator);
    const accountHost = grantedAccount.slice(separator + 1);
    await admin.query(
      `GRANT ALL PRIVILEGES ON \`${databaseName}\`.* TO ${
        sqlString(accountUser)
      }@${sqlString(accountHost)}`
    );
    const testUrl = new URL(applicationUrl);
    testUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = testUrl.toString();
    delete process.env.MYSQL_URL;
    delete process.env.ORGANIZATION_IDENTITY_MASTER_SECRET;
    delete process.env.PROSPECT_SOURCE_RAW_ENVELOPE_SECRET;

    stage = "import deployment schema";
    const schemaConnection = await mysql.createConnection({
      ...connectionOptions(testUrl),
      database: databaseName,
      multipleStatements: true
    });
    try {
      const schemaSql = await readFile(
        new URL("../schema.mysql.sql", import.meta.url),
        "utf8"
      );
      await schemaConnection.query(schemaSql);
    } finally {
      await schemaConnection.end();
    }
    const database = await mysql.createConnection({
      ...connectionOptions(testUrl),
      database: databaseName
    });
    const pool = mysql.createPool({
      uri: testUrl.toString(),
      connectionLimit: 4
    });

    stage = "validate deployment schema";
    await ensureOrganizationIdentitySchema(pool);
    const [tableRows] = await database.query<Array<RowDataPacket>>(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = ?
         AND table_name IN (${identityTables.map(() => "?").join(",")})
       ORDER BY table_name`,
      [databaseName, ...identityTables]
    );
    assert.deepEqual(
      tableRows.map((row) => String(row.tableName)),
      [...identityTables].sort()
    );
    const expectedUniqueIndexes = new Map<string, string>([
      ["organizations:uk_oi_organization_team_id", "team_id,id"],
      [
        "organization_identity_resolutions:uk_oi_resolution_processing",
        "team_id,owner_id,processing_key_hash"
      ],
      [
        "organization_identity_claims:uk_oi_claim_resolution_ordinal",
        "team_id,owner_id,resolution_id,ordinal"
      ],
      [
        "organization_accepted_identifiers:uk_oi_identifier_lookup",
        "team_id,kind,scheme,jurisdiction,normalized_value_hash"
      ],
      [
        "organization_source_bindings:uk_oi_binding_active_raw",
        "team_id,owner_id,raw_record_id,status"
      ],
      [
        "organization_identity_events:uk_oi_event_resolution_sequence",
        "team_id,owner_id,resolution_id,sequence_no"
      ]
    ]);
    const [indexRows] = await database.query<Array<RowDataPacket>>(
      `SELECT table_name AS tableName,index_name AS indexName,
         GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columnsList,
         MAX(non_unique) AS nonUnique
       FROM information_schema.statistics
       WHERE table_schema = ?
         AND table_name IN (${identityTables.map(() => "?").join(",")})
       GROUP BY table_name,index_name`,
      [databaseName, ...identityTables]
    );
    for (const [key, columns] of expectedUniqueIndexes) {
      const [table, index] = key.split(":");
      const row = indexRows.find((item) =>
        item.tableName === table && item.indexName === index
      );
      assert.ok(row, `Missing identity index ${index}`);
      assert.equal(Number(row.nonUnique), 0);
      assert.equal(String(row.columnsList), columns);
    }
    const expectedForeignKeys = [
      "fk_oi_resolution_raw",
      "fk_oi_claim_resolution",
      "fk_oi_claim_raw",
      "fk_oi_identifier_organization",
      "fk_oi_identifier_claim",
      "fk_oi_identifier_raw",
      "fk_oi_binding_organization",
      "fk_oi_binding_resolution",
      "fk_oi_binding_raw",
      "fk_oi_conflict_resolution",
      "fk_oi_conflict_raw",
      "fk_oi_event_resolution",
      "fk_oi_resolution_identifier_resolution",
      "fk_oi_resolution_identifier_identifier",
      "fk_oi_resolution_binding_resolution",
      "fk_oi_resolution_binding_binding",
      "fk_oi_conflict_organization_conflict",
      "fk_oi_conflict_organization_organization",
      "fk_oi_conflict_key_conflict"
    ];
    const [foreignKeyRows] = await database.query<Array<RowDataPacket>>(
      `SELECT constraint_name AS constraintName,
         update_rule AS updateRule,delete_rule AS deleteRule
       FROM information_schema.referential_constraints
       WHERE constraint_schema = ?
         AND constraint_name IN (${
           expectedForeignKeys.map(() => "?").join(",")
         })`,
      [databaseName, ...expectedForeignKeys]
    );
    assert.equal(foreignKeyRows.length, expectedForeignKeys.length);
    assert.ok(foreignKeyRows.every((row) =>
      row.updateRule === "RESTRICT" && row.deleteRule === "RESTRICT"
    ));
    const expectedChecks = [
      "chk_oi_metadata_singleton",
      "chk_oi_metadata_status",
      "chk_oi_team_guard_version",
      "chk_oi_organization_scope",
      "chk_oi_organization_status",
      "chk_oi_resolution_result",
      "chk_oi_resolution_events",
      "chk_oi_claim_ordinal",
      "chk_oi_identifier_status",
      "chk_oi_binding_status",
      "chk_oi_conflict_status",
      "chk_oi_event_sequence",
      "chk_oi_resolution_identifier_ordinal",
      "chk_oi_resolution_identifier_role",
      "chk_oi_resolution_binding_ordinal",
      "chk_oi_resolution_binding_role",
      "chk_oi_conflict_organization_ordinal",
      "chk_oi_conflict_organization_role",
      "chk_oi_conflict_key_ordinal",
      "chk_oi_conflict_key_type"
    ];
    const [checkRows] = await database.query<Array<RowDataPacket>>(
      `SELECT constraint_name AS constraintName
       FROM information_schema.table_constraints
       WHERE constraint_schema = ?
         AND constraint_type = 'CHECK'
         AND constraint_name IN (${
           expectedChecks.map(() => "?").join(",")
         })`,
      [databaseName, ...expectedChecks]
    );
    assert.deepEqual(
      checkRows.map((row) => String(row.constraintName)).sort(),
      expectedChecks.sort()
    );
    const [guardDefinitionRows] =
      await database.query<Array<RowDataPacket>>(
        "SHOW CREATE TABLE organization_identity_team_guards"
      );
    const guardDefinition = String(
      guardDefinitionRows[0]?.["Create Table"] || ""
    );
    assert.ok(guardDefinition);

    stage = "partial exact empty schema completes";
    await dropIdentitySchema(database);
    await database.query(guardDefinition);
    const [partialEmptyBeforeRows] =
      await database.query<Array<RowDataPacket>>(
        "SHOW CREATE TABLE organization_identity_team_guards"
      );
    const partialEmptyBefore = String(
      partialEmptyBeforeRows[0]?.["Create Table"] || ""
    );
    await ensureOrganizationIdentitySchema(pool);
    const [partialEmptyAfterRows] =
      await database.query<Array<RowDataPacket>>(
        "SHOW CREATE TABLE organization_identity_team_guards"
      );
    assert.equal(
      String(partialEmptyAfterRows[0]?.["Create Table"] || ""),
      partialEmptyBefore
    );
    const [completedPartialRows] =
      await database.query<Array<RowDataPacket>>(
        `SELECT table_name AS tableName
         FROM information_schema.tables
         WHERE table_schema = ?
           AND table_name IN (${
             identityTables.map(() => "?").join(",")
           })
         ORDER BY table_name`,
        [databaseName, ...identityTables]
      );
    assert.deepEqual(
      completedPartialRows.map((row) => String(row.tableName)),
      [...identityTables].sort()
    );
    const [completedGuardRows] =
      await database.query<Array<RowDataPacket>>(
        `SELECT COUNT(*) AS count
         FROM organization_identity_team_guards`
      );
    assert.equal(Number(completedGuardRows[0]?.count || 0), 0);

    stage = "partial exact schema with state rejects";
    await dropIdentitySchema(database);
    await database.query(guardDefinition);
    await database.query(
      `INSERT INTO organization_identity_team_guards (
         team_id,guard_version,updated_at
       ) VALUES ('identity-partial-state',1,UTC_TIMESTAMP(3))`
    );
    await assert.rejects(
      ensureOrganizationIdentitySchema(pool),
      isIdentityError("IDENTITY_DATA_INTEGRITY_VIOLATION")
    );
    const [rejectedPartialRows] =
      await database.query<Array<RowDataPacket>>(
        `SELECT table_name AS tableName
         FROM information_schema.tables
         WHERE table_schema = ?
           AND table_name IN (${
             identityTables.map(() => "?").join(",")
           })`,
        [databaseName, ...identityTables]
      );
    assert.deepEqual(
      rejectedPartialRows.map((row) => String(row.tableName)),
      ["organization_identity_team_guards"]
    );
    const [preservedGuardRows] =
      await database.query<Array<RowDataPacket>>(
        `SELECT team_id AS teamId,guard_version AS guardVersion
         FROM organization_identity_team_guards`
      );
    assert.deepEqual(
      preservedGuardRows.map((row) => ({
        teamId: String(row.teamId),
        guardVersion: Number(row.guardVersion)
      })),
      [{ teamId: "identity-partial-state", guardVersion: 1 }]
    );
    await database.query(
      `DELETE FROM organization_identity_team_guards
       WHERE team_id = 'identity-partial-state'`
    );
    await ensureOrganizationIdentitySchema(pool);

    stage = "partial schema rejects before creating missing tables";
    await dropIdentitySchema(database);
    await database.query(
      `ALTER TABLE prospect_source_raw_hits
       DROP FOREIGN KEY fk_ps_raw_hit_record`
    );
    await database.query(
      `ALTER TABLE prospect_source_raw_records
       DROP INDEX uk_ps_raw_record_team_owner_id`
    );
    await database.query(
      `CREATE TABLE organizations (
         id VARCHAR(91) PRIMARY KEY
       )`
    );
    await assertColdStartRejected("IDENTITY_DATA_INTEGRITY_VIOLATION");
    const [partialTableRows] = await database.query<Array<RowDataPacket>>(
      `SELECT table_name AS tableName
       FROM information_schema.tables
       WHERE table_schema = ?
         AND table_name IN (${identityTables.map(() => "?").join(",")})`,
      [databaseName, ...identityTables]
    );
    assert.deepEqual(
      partialTableRows.map((row) => String(row.tableName)),
      ["organizations"]
    );
    const [rawOwnerIndexRows] = await database.query<Array<RowDataPacket>>(
      `SELECT column_name AS columnName,non_unique AS nonUnique
       FROM information_schema.statistics
       WHERE table_schema = ?
         AND table_name = 'prospect_source_raw_records'
         AND index_name = 'uk_ps_raw_record_team_owner_id'
       ORDER BY seq_in_index`,
      [databaseName]
    );
    assert.deepEqual(
      rawOwnerIndexRows.map((row) => String(row.columnName)),
      ["team_id", "owner_id", "id"]
    );
    assert.ok(rawOwnerIndexRows.every(
      (row) => Number(row.nonUnique) === 0
    ));
    await database.query("DROP TABLE organizations");
    await ensureOrganizationIdentitySchema(pool);
    await ensureProspectCoverageSchema(pool);

    stage = "raw record column drift rejection";
    await assertSchemaMutationRejected(
      async () => {
        await database.query(
          `ALTER TABLE prospect_source_raw_records
           MODIFY provider_code VARCHAR(81) NOT NULL`
        );
      },
      async () => {
        await database.query(
          `ALTER TABLE prospect_source_raw_records
           MODIFY provider_code VARCHAR(80) NOT NULL`
        );
      }
    );

    stage = "identity storage engine drift rejection";
    await assertSchemaMutationRejected(
      async () => {
        await database.query(
          `ALTER TABLE organization_identity_team_guards ENGINE=MyISAM`
        );
      },
      async () => {
        await database.query(
          `ALTER TABLE organization_identity_team_guards ENGINE=InnoDB`
        );
      }
    );

    stage = "identity column drift rejection";
    await assertSchemaMutationRejected(
      async () => {
        await database.query(
          `ALTER TABLE organization_identity_team_guards
           MODIFY guard_version INT NOT NULL`
        );
      },
      async () => {
        await database.query(
          `ALTER TABLE organization_identity_team_guards
           MODIFY guard_version BIGINT NOT NULL`
        );
      }
    );

    stage = "identity check drift rejection";
    await assertSchemaMutationRejected(
      async () => {
        await database.query(
          `ALTER TABLE organization_identity_team_guards
           DROP CHECK chk_oi_team_guard_version`
        );
      },
      async () => {
        await database.query(
          `ALTER TABLE organization_identity_team_guards
           ADD CONSTRAINT chk_oi_team_guard_version
           CHECK (guard_version >= 1)`
        );
      }
    );

    stage = "identity foreign key scope drift rejection";
    await assertSchemaMutationRejected(
      async () => {
        await database.query(
          `ALTER TABLE organization_identity_claims
           DROP FOREIGN KEY fk_oi_claim_resolution`
        );
        await database.query(
          `ALTER TABLE organization_identity_claims
           ADD CONSTRAINT fk_oi_claim_resolution
           FOREIGN KEY (resolution_id)
           REFERENCES organization_identity_resolutions(id)
           ON UPDATE RESTRICT ON DELETE RESTRICT`
        );
      },
      async () => {
        await database.query(
          `ALTER TABLE organization_identity_claims
           DROP FOREIGN KEY fk_oi_claim_resolution`
        );
        await database.query(
          `ALTER TABLE organization_identity_claims
           DROP INDEX fk_oi_claim_resolution`
        );
        await database.query(
          `ALTER TABLE organization_identity_claims
           ADD CONSTRAINT fk_oi_claim_resolution
           FOREIGN KEY (team_id,owner_id,resolution_id)
           REFERENCES organization_identity_resolutions(team_id,owner_id,id)
           ON UPDATE RESTRICT ON DELETE RESTRICT`
        );
      }
    );

    stage = "identity index order drift rejection";
    await assertSchemaMutationRejected(
      async () => {
        await database.query(
          `ALTER TABLE organization_identity_events
           DROP INDEX uk_oi_event_team_owner_id,
           ADD UNIQUE KEY uk_oi_event_team_owner_id(owner_id,team_id,id)`
        );
      },
      async () => {
        await database.query(
          `ALTER TABLE organization_identity_events
           DROP INDEX uk_oi_event_team_owner_id,
           ADD UNIQUE KEY uk_oi_event_team_owner_id(team_id,owner_id,id)`
        );
      }
    );

    stage = "team guard without metadata rejection";
    await database.query(
      `INSERT INTO organization_identity_team_guards (
         team_id,guard_version,updated_at
       ) VALUES ('identity-orphan-guard',1,UTC_TIMESTAMP(3))`
    );
    try {
      await assertColdStartRejected("IDENTITY_DATA_INTEGRITY_VIOLATION");
    } finally {
      await database.query(
        `DELETE FROM organization_identity_team_guards
         WHERE team_id = 'identity-orphan-guard'`
      );
    }

    stage = "authority profile without metadata rejection";
    await database.query(
      `INSERT INTO organization_identity_authority_profiles (
         profile_code,profile_version,canonical_json,profile_hash,
         profile_mac,created_at,row_mac
       ) VALUES (?,?,?,REPEAT('a',64),REPEAT('b',64),
         UTC_TIMESTAMP(3),REPEAT('c',64))`,
      ["identity-orphan-profile", "v1", "{}"]
    );
    try {
      await assertColdStartRejected("IDENTITY_DATA_INTEGRITY_VIOLATION");
    } finally {
      await database.query(
        `DELETE FROM organization_identity_authority_profiles
         WHERE profile_code = 'identity-orphan-profile'
           AND profile_version = 'v1'`
      );
    }

    stage = "schema lock acquisition response loss destroys connection";
    let acquisitionConnectionDestroyed = false;
    let acquisitionConnectionReleased = false;
    const acquisitionFailurePool = instrumentPool(pool, {
      connection: {
        async query(sql, proceed) {
          const result = await proceed();
          if (sql.startsWith("SELECT GET_LOCK")) {
            throw new Error("forced schema lock acquisition response loss");
          }
          return result;
        },
        destroy() {
          acquisitionConnectionDestroyed = true;
        },
        release() {
          acquisitionConnectionReleased = true;
        }
      }
    });
    await assert.rejects(
      ensureOrganizationIdentitySchema(acquisitionFailurePool),
      /forced schema lock acquisition response loss/
    );
    assert.equal(acquisitionConnectionDestroyed, true);
    assert.equal(acquisitionConnectionReleased, false);
    await ensureOrganizationIdentitySchema(pool);

    stage = "schema lock release failure destroys connection";
    let schemaConnectionDestroyed = false;
    let schemaConnectionReleased = false;
    const releaseFailurePool = instrumentPool(pool, {
      connection: {
        beforeQuery(sql) {
          if (sql.startsWith("SELECT RELEASE_LOCK")) {
            throw new Error("forced schema lock release failure");
          }
        },
        destroy() {
          schemaConnectionDestroyed = true;
        },
        release() {
          schemaConnectionReleased = true;
        }
      }
    });
    await assert.rejects(
      ensureOrganizationIdentitySchema(releaseFailurePool),
      isIdentityError("IDENTITY_DATA_INTEGRITY_VIOLATION")
    );
    assert.equal(schemaConnectionDestroyed, true);
    assert.equal(schemaConnectionReleased, false);
    await ensureOrganizationIdentitySchema(pool);
    for (const released of [0, null] as const) {
      stage = `schema lock release result ${String(released)} destroys connection`;
      let uncertainConnectionDestroyed = false;
      let uncertainConnectionReleased = false;
      const uncertainReleasePool = instrumentPool(pool, {
        connection: {
          query(sql, proceed) {
            if (sql.startsWith("SELECT RELEASE_LOCK")) {
              return Promise.resolve([[{ released }], []]);
            }
            return proceed();
          },
          destroy() {
            uncertainConnectionDestroyed = true;
          },
          release() {
            uncertainConnectionReleased = true;
          }
        }
      });
      await assert.rejects(
        ensureOrganizationIdentitySchema(uncertainReleasePool),
        isIdentityError("IDENTITY_DATA_INTEGRITY_VIOLATION")
      );
      assert.equal(uncertainConnectionDestroyed, true);
      assert.equal(uncertainConnectionReleased, false);
      await ensureOrganizationIdentitySchema(pool);
    }

    stage = "empty startup without identity secrets";
    const primaryStore = await createMysqlStore();
    assert.equal(await identityFactCount(database), 0);
    for (const table of identityTables) {
      const [emptyRows] = await database.query<Array<RowDataPacket>>(
        `SELECT COUNT(*) AS count FROM \`${table}\``
      );
      assert.equal(
        Number(emptyRows[0]?.count || 0),
        0,
        `Expected empty identity table before first DML: ${table}`
      );
    }

    stage = "synchronous resolver rejection and zero writes";
    const syncRaw = createRawFixture("identity-sync-team", "owner-a");
    assert.throws(
      () => resolveOrganizationStrongIdentity(primaryStore, {
        ...persistedInput(syncRaw, [registration("SYNC-100")]),
        envelopeSecret: rawEnvelopeSecret,
        identitySecret: masterSecret,
        authorityProfile: authorityProfile()
      }),
      isIdentityError("IDENTITY_MYSQL_TRANSACTION_REQUIRED")
    );
    assert.equal(await identityFactCount(database), 0);

    process.env.ORGANIZATION_IDENTITY_MASTER_SECRET = masterSecret;
    process.env.PROSPECT_SOURCE_RAW_ENVELOPE_SECRET = rawEnvelopeSecret;
    const businessBefore = snapshotBusinessArrays(primaryStore);

    stage = "insufficient identity";
    const weakRaw = createRawFixture("identity-weak-team", "owner-a");
    await insertRawRecord(database, weakRaw);
    const weakResult = await resolvePersisted(primaryStore, weakRaw, [
      legalName("Association Facts GmbH"),
      officialDomain("association.example.test")
    ]);
    assert.equal(weakResult.resolution.result, "insufficient_identity");
    assert.equal(weakResult.createdOrganization, null);
    assert.equal(weakResult.binding, null);

    stage = "new entity and cold restart";
    const sharedRawA = createRawFixture("identity-shared-team", "owner-a");
    await insertRawRecord(database, sharedRawA);
    const sharedClaims = [
      legalName("Shared Lighting GmbH"),
      lei("5493001KJTIIGC8Y1R12")
    ];
    const first = await resolvePersisted(
      primaryStore,
      sharedRawA,
      sharedClaims
    );
    assert.equal(first.resolution.result, "new_entity");
    assert.ok(first.createdOrganization);
    assert.equal(first.createdIdentifiers.length, 1);
    const firstTeamSnapshot = snapshotTeamIdentity(
      primaryStore,
      sharedRawA.teamId
    );
    const coldStore = await createMysqlStore();
    assert.deepEqual(
      snapshotTeamIdentity(coldStore, sharedRawA.teamId),
      firstTeamSnapshot
    );

    stage = "runtime metadata deletion fails closed";
    const [metadataRows] = await database.query<Array<RowDataPacket>>(
      `SELECT * FROM organization_identity_contract_metadata
       WHERE id = 1`
    );
    assert.equal(metadataRows.length, 1);
    const metadataRow = metadataRows[0]!;
    await database.query(
      "DELETE FROM organization_identity_contract_metadata WHERE id = 1"
    );
    const missingMetadataRaw = createRawFixture(
      "identity-metadata-missing-team",
      "owner-a"
    );
    await insertRawRecord(database, missingMetadataRaw);
    const missingMetadataSnapshot =
      await databaseIdentitySnapshot(database);
    try {
      await assert.rejects(
        resolvePersisted(coldStore, missingMetadataRaw, [
          registration("METADATA-MISSING-100")
        ]),
        isIdentityError("IDENTITY_DATA_INTEGRITY_VIOLATION")
      );
      assert.deepEqual(
        await databaseIdentitySnapshot(database),
        missingMetadataSnapshot
      );
    } finally {
      await database.query(
        `INSERT INTO organization_identity_contract_metadata (
           id,resolver_contract_version,persistence_schema_version,
           canonical_version,hash_algorithm,encryption_algorithm,
           envelope_version,hkdf_version,deterministic_id_version,
           key_fingerprints_json,raw_key_fingerprint,status,created_at,
           metadata_mac
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          metadataRow.id,
          metadataRow.resolver_contract_version,
          metadataRow.persistence_schema_version,
          metadataRow.canonical_version,
          metadataRow.hash_algorithm,
          metadataRow.encryption_algorithm,
          metadataRow.envelope_version,
          metadataRow.hkdf_version,
          metadataRow.deterministic_id_version,
          metadataRow.key_fingerprints_json,
          metadataRow.raw_key_fingerprint,
          metadataRow.status,
          metadataRow.created_at,
          metadataRow.metadata_mac
        ]
      );
    }

    stage = "same owner replay and changed claim rejection";
    const replay = await resolvePersisted(coldStore, sharedRawA, [
      lei("5493001KJTIIGC8Y1R12"),
      legalName("Shared Lighting GmbH"),
      lei("5493001KJTIIGC8Y1R12")
    ]);
    assert.equal(replay.idempotent, true);
    const factsBeforeReplayConflict = await databaseIdentitySnapshot(database);
    await assert.rejects(
      resolvePersisted(coldStore, sharedRawA, [
        ...sharedClaims,
        legalName("Changed Parser Output GmbH")
      ]),
      isIdentityError("IDENTITY_CLAIM_REPLAY_CONFLICT")
    );
    assert.deepEqual(
      await databaseIdentitySnapshot(database),
      factsBeforeReplayConflict
    );

    stage = "same team cross owner shared organization";
    const sharedRawB = createRawFixture("identity-shared-team", "owner-b");
    await insertRawRecord(database, sharedRawB);
    const secondOwner = await resolvePersisted(coldStore, sharedRawB, [
      legalName("Shared Lighting GmbH"),
      lei("5493001KJTIIGC8Y1R12")
    ]);
    assert.equal(secondOwner.resolution.result, "exact_match");
    assert.equal(
      secondOwner.resolution.organizationId,
      first.resolution.organizationId
    );
    assert.ok(secondOwner.claims.every((claim) =>
      claim.ownerId === "owner-b"
    ));
    assert.equal(
      coldStore.organizations.filter(
        (item) => item.teamId === "identity-shared-team"
      ).length,
      1
    );
    await assert.rejects(
      resolvePersisted(
        coldStore,
        { ...sharedRawA, ownerId: "owner-b" },
        [lei("5493001KJTIIGC8Y1R12")]
      ),
      isIdentityError("IDENTITY_INVALID")
    );

    stage = "cross team isolation";
    const crossTeamRaw = createRawFixture("identity-cross-team", "owner-a");
    await insertRawRecord(database, crossTeamRaw);
    const crossTeam = await resolvePersisted(coldStore, crossTeamRaw, [
      lei("5493001KJTIIGC8Y1R12")
    ]);
    assert.equal(crossTeam.resolution.result, "new_entity");
    assert.notEqual(
      crossTeam.resolution.organizationId,
      first.resolution.organizationId
    );

    stage = "parser version binding reuse";
    const parserRaw = createRawFixture("identity-parser-team", "owner-a");
    await insertRawRecord(database, parserRaw);
    const parserFirst = await resolvePersisted(coldStore, parserRaw, [
      registration("PARSER-100")
    ]);
    const parserSecond = await resolvePersisted(coldStore, parserRaw, [
      registration("PARSER-100")
    ], {
      parserVersion: "identity-parser-v2"
    });
    assert.equal(parserSecond.resolution.result, "exact_match");
    assert.equal(parserSecond.binding?.id, parserFirst.binding?.id);
    assert.equal(
      coldStore.organizationSourceBindings.filter(
        (item) => item.rawRecordId === parserRaw.record.id
      ).length,
      1
    );

    stage = "binding conflict without partial structural writes";
    const bindingSourceRaw = createRawFixture(
      "identity-binding-team",
      "owner-source"
    );
    const bindingTargetRaw = createRawFixture(
      "identity-binding-team",
      "owner-target"
    );
    await insertRawRecord(database, bindingSourceRaw);
    await insertRawRecord(database, bindingTargetRaw);
    const bindingSource = await resolvePersisted(
      coldStore,
      bindingSourceRaw,
      [registration("BINDING-SOURCE-100")]
    );
    const bindingTarget = await resolvePersisted(
      coldStore,
      bindingTargetRaw,
      [registration("BINDING-TARGET-200")]
    );
    const bindingStructuralTables = [
      "organizations",
      "organization_accepted_identifiers",
      "organization_source_bindings"
    ] as const;
    const bindingStructuralDatabaseBefore = await databaseTableSnapshot(
      database,
      bindingStructuralTables
    );
    const bindingConflict = await resolvePersisted(
      coldStore,
      bindingSourceRaw,
      [registration("BINDING-TARGET-200")],
      { parserVersion: "identity-parser-v2" }
    );
    assert.equal(bindingConflict.resolution.result, "conflict");
    assert.equal(bindingConflict.conflict?.conflictType, "binding_conflict");
    assert.equal(bindingConflict.resolution.bindingId, "");
    assert.equal(bindingConflict.resolution.bindingRelationRole, "");
    assert.equal(bindingConflict.binding, null);
    assert.notEqual(
      bindingSource.resolution.organizationId,
      bindingTarget.resolution.organizationId
    );
    assert.deepEqual(
      await databaseTableSnapshot(database, bindingStructuralTables),
      bindingStructuralDatabaseBefore
    );
    const bindingConflictColdStore = await createMysqlStore();
    assert.ok(bindingConflictColdStore.organizationIdentityConflicts.some(
      (item) => item.id === bindingConflict.conflict?.id
    ));
    const bindingConflictReplay = await resolvePersisted(
      bindingConflictColdStore,
      bindingSourceRaw,
      [registration("BINDING-TARGET-200")],
      { parserVersion: "identity-parser-v2" }
    );
    assert.equal(bindingConflictReplay.idempotent, true);
    assert.equal(bindingConflictReplay.binding, null);
    assert.deepEqual(
      bindingConflictReplay.resolution,
      bindingConflict.resolution
    );
    assert.deepEqual(bindingConflictReplay.conflict, bindingConflict.conflict);

    stage = "identifier split conflict without partial structural writes";
    const splitRawA = createRawFixture("identity-split-team", "owner-a");
    const splitRawB = createRawFixture("identity-split-team", "owner-b");
    const splitRawC = createRawFixture("identity-split-team", "owner-c");
    await insertRawRecord(database, splitRawA);
    await insertRawRecord(database, splitRawB);
    await insertRawRecord(database, splitRawC);
    await resolvePersisted(coldStore, splitRawA, [
      lei("529900T8BM49AURSDO55")
    ]);
    await resolvePersisted(coldStore, splitRawB, [
      registration("SPLIT-200")
    ]);
    const splitStructuralBefore = await databaseTableSnapshot(
      database,
      bindingStructuralTables
    );
    const splitConflict = await resolvePersisted(coldStore, splitRawC, [
      lei("529900T8BM49AURSDO55"),
      registration("SPLIT-200")
    ]);
    assert.equal(splitConflict.resolution.result, "conflict");
    assert.equal(splitConflict.conflict?.conflictType, "identifier_split");
    assert.deepEqual(
      await databaseTableSnapshot(database, bindingStructuralTables),
      splitStructuralBefore
    );
    const splitConflictColdStore = await createMysqlStore();
    assert.ok(splitConflictColdStore.organizationIdentityConflicts.some(
      (item) => item.id === splitConflict.conflict?.id
    ));

    stage = "authority profile drift rejection";
    const [profileRows] = await database.query<Array<RowDataPacket>>(
      `SELECT canonical_json AS canonicalJson
       FROM organization_identity_authority_profiles
       WHERE profile_code = ? AND profile_version = ?`,
      ["identity-authority-test", "v1"]
    );
    const canonicalProfile = String(profileRows[0]?.canonicalJson || "");
    await database.query(
      `UPDATE organization_identity_authority_profiles
       SET canonical_json = CONCAT(canonical_json, ' ')
       WHERE profile_code = ? AND profile_version = ?`,
      ["identity-authority-test", "v1"]
    );
    await assertColdStartRejected("IDENTITY_CONFIGURATION_INVALID");
    await database.query(
      `UPDATE organization_identity_authority_profiles
       SET canonical_json = ?
       WHERE profile_code = ? AND profile_version = ?`,
      [canonicalProfile, "identity-authority-test", "v1"]
    );

    stage = "missing and wrong secrets";
    delete process.env.ORGANIZATION_IDENTITY_MASTER_SECRET;
    delete process.env.PROSPECT_SOURCE_RAW_ENVELOPE_SECRET;
    await assertColdStartRejected("IDENTITY_CONFIGURATION_INVALID");
    process.env.ORGANIZATION_IDENTITY_MASTER_SECRET =
      "wrong-organization-identity-master-secret-".repeat(2);
    process.env.PROSPECT_SOURCE_RAW_ENVELOPE_SECRET = rawEnvelopeSecret;
    await assertColdStartRejected("IDENTITY_CONFIGURATION_INVALID");
    process.env.ORGANIZATION_IDENTITY_MASTER_SECRET = masterSecret;
    process.env.PROSPECT_SOURCE_RAW_ENVELOPE_SECRET =
      "wrong-organization-identity-raw-secret-".repeat(2);
    await assertColdStartRejected("IDENTITY_CONFIGURATION_INVALID");
    process.env.PROSPECT_SOURCE_RAW_ENVELOPE_SECRET = rawEnvelopeSecret;

    stage = "ciphertext tamper rejection";
    const [organizationRows] = await database.query<Array<RowDataPacket>>(
      `SELECT id,legal_name_encrypted AS encrypted,row_mac AS rowMac
       FROM organizations ORDER BY created_at,id LIMIT 1`
    );
    const tamperOrganizationId = String(organizationRows[0]?.id || "");
    const encryptedName = String(organizationRows[0]?.encrypted || "");
    const organizationRowMac = String(organizationRows[0]?.rowMac || "");
    await database.query(
      "UPDATE organizations SET legal_name_encrypted = ? WHERE id = ?",
      [`${encryptedName}A`, tamperOrganizationId]
    );
    await assertColdStartRejected("IDENTITY_DATA_INTEGRITY_VIOLATION");
    await database.query(
      `UPDATE organizations
       SET legal_name_encrypted = ?,row_mac = ? WHERE id = ?`,
      [encryptedName, organizationRowMac, tamperOrganizationId]
    );

    stage = "row mac tamper rejection";
    await database.query(
      "UPDATE organizations SET row_mac = ? WHERE id = ?",
      ["f".repeat(64), tamperOrganizationId]
    );
    await assertColdStartRejected("IDENTITY_DATA_INTEGRITY_VIOLATION");
    await database.query(
      "UPDATE organizations SET row_mac = ? WHERE id = ?",
      [organizationRowMac, tamperOrganizationId]
    );

    stage = "relation tamper rejection";
    const [relationRows] = await database.query<Array<RowDataPacket>>(
      `SELECT team_id AS teamId,owner_id AS ownerId,
         resolution_id AS resolutionId,ordinal,relation_role AS role,
         row_mac AS rowMac
       FROM organization_identity_resolution_identifiers
       ORDER BY resolution_id,ordinal LIMIT 1`
    );
    const relation = relationRows[0]!;
    const changedRole = relation.role === "accepted_new"
      ? "accepted_existing"
      : "accepted_new";
    await database.query(
      `UPDATE organization_identity_resolution_identifiers
       SET relation_role = ?
       WHERE team_id = ? AND owner_id = ?
         AND resolution_id = ? AND ordinal = ?`,
      [
        changedRole,
        relation.teamId,
        relation.ownerId,
        relation.resolutionId,
        relation.ordinal
      ]
    );
    await assertColdStartRejected("IDENTITY_DATA_INTEGRITY_VIOLATION");
    await database.query(
      `UPDATE organization_identity_resolution_identifiers
       SET relation_role = ?,row_mac = ?
       WHERE team_id = ? AND owner_id = ?
         AND resolution_id = ? AND ordinal = ?`,
      [
        relation.role,
        relation.rowMac,
        relation.teamId,
        relation.ownerId,
        relation.resolutionId,
        relation.ordinal
      ]
    );

    stage = "event chain tamper rejection";
    const [eventRows] = await database.query<Array<RowDataPacket>>(
      `SELECT id,event_hash AS eventHash,row_mac AS rowMac
       FROM organization_identity_events
       ORDER BY created_at,id LIMIT 1`
    );
    const event = eventRows[0]!;
    await database.query(
      "UPDATE organization_identity_events SET event_hash = ? WHERE id = ?",
      ["e".repeat(64), event.id]
    );
    await assertColdStartRejected("IDENTITY_DATA_INTEGRITY_VIOLATION");
    await database.query(
      `UPDATE organization_identity_events
       SET event_hash = ?,row_mac = ? WHERE id = ?`,
      [event.eventHash, event.rowMac, event.id]
    );

    stage = "two stale stores serialize same team identity";
    const concurrentRawA = createRawFixture(
      "identity-concurrent-team",
      "owner-a"
    );
    const concurrentRawB = createRawFixture(
      "identity-concurrent-team",
      "owner-b"
    );
    await insertRawRecord(database, concurrentRawA);
    await insertRawRecord(database, concurrentRawB);
    const staleStoreA = await createMysqlStore();
    const staleStoreB = await createMysqlStore();
    const concurrentResults = await Promise.all([
      resolvePersisted(staleStoreA, concurrentRawA, [
        lei("213800D1EI4B9WTWWD28")
      ]),
      resolvePersisted(staleStoreB, concurrentRawB, [
        lei("213800D1EI4B9WTWWD28")
      ])
    ]);
    assert.deepEqual(
      concurrentResults.map((item) => item.resolution.result).sort(),
      ["exact_match", "new_entity"]
    );
    const concurrentColdStore = await createMysqlStore();
    assert.equal(
      concurrentColdStore.organizations.filter(
        (item) => item.teamId === "identity-concurrent-team"
      ).length,
      1
    );

    stage = "deadlock retry and retry ceiling";
    const retryRaw = createRawFixture("identity-retry-team", "owner-a");
    await insertRawRecord(database, retryRaw);
    let retryFailures = 0;
    let retryInputMutated = false;
    const retryInput = persistedInput(
      retryRaw,
      [registration("RETRY-100")]
    );
    const retryPool = instrumentPool(pool, {
      connection: {
        beforeQuery(sql) {
          if (sql.startsWith("SET TRANSACTION") && retryFailures < 2) {
            retryFailures += 1;
            if (!retryInputMutated) {
              retryInput.claims[0]!.value = "RETRY-MUTATED-100";
              retryInput.claims[0]!.normalizedValue =
                "RETRY-MUTATED-100";
              retryInputMutated = true;
            }
            throw Object.assign(new Error("forced deadlock"), {
              code: "ER_LOCK_DEADLOCK",
              errno: 1213
            });
          }
        }
      }
    });
    const retryResult = await resolveOrganizationStrongIdentityMysql(
      retryPool,
      concurrentColdStore,
      retryInput
    );
    assert.equal(retryFailures, 2);
    assert.equal(retryInputMutated, true);
    assert.equal(retryResult.resolution.result, "new_entity");
    const retryState = await loadOrganizationIdentityState(
      pool,
      undefined,
      retryRaw.teamId
    );
    assert.equal(
      retryState.organizationAcceptedIdentifiers[0]?.normalizedValue,
      "RETRY-100"
    );

    const retryCeilingRaw = createRawFixture(
      "identity-retry-ceiling-team",
      "owner-a"
    );
    await insertRawRecord(database, retryCeilingRaw);
    let ceilingFailures = 0;
    const ceilingPool = instrumentPool(pool, {
      connection: {
        beforeQuery(sql) {
          if (sql.startsWith("SET TRANSACTION")) {
            ceilingFailures += 1;
            throw Object.assign(new Error("forced lock timeout"), {
              code: "ER_LOCK_WAIT_TIMEOUT",
              errno: 1205
            });
          }
        }
      }
    });
    await assert.rejects(
      resolveOrganizationStrongIdentityMysql(
        ceilingPool,
        concurrentColdStore,
        persistedInput(retryCeilingRaw, [registration("RETRY-CEILING-100")])
      ),
      isIdentityError("IDENTITY_CONCURRENCY_RETRY_EXHAUSTED")
    );
    assert.equal(ceilingFailures, 3);

    stage = "decision closure stays team scoped and selection bound";
    const closureRaw = createRawFixture(
      "identity-decision-closure-team",
      "owner-a"
    );
    await insertRawRecord(database, closureRaw);
    const decisionFactSelects = new Map<string, string[]>();
    let decisionWriteCommitted = false;
    const closurePool = instrumentPool(pool, {
      connection: {
        query(sql, proceed) {
          const normalizedSql = sql.replace(/\s+/g, " ").trim();
          if (!decisionWriteCommitted) {
            const table = identityFactTables.find((candidate) =>
              normalizedSql.startsWith(`SELECT * FROM ${candidate} `)
            );
            if (table) {
              decisionFactSelects.set(table, [
                ...(decisionFactSelects.get(table) || []),
                normalizedSql
              ]);
            }
          }
          return proceed();
        },
        async commit(proceed) {
          await proceed();
          decisionWriteCommitted = true;
        }
      }
    });
    const closureResult = await resolveOrganizationStrongIdentityMysql(
      closurePool,
      concurrentColdStore,
      persistedInput(closureRaw, [registration("CLOSURE-100")])
    );
    assert.equal(closureResult.resolution.result, "new_entity");
    assert.deepEqual(
      [...decisionFactSelects.keys()].sort(),
      [...identityFactTables].sort()
    );
    for (const queries of decisionFactSelects.values()) {
      assert.equal(
        queries.every((sql) =>
          sql.includes(" WHERE team_id = ? AND ")
        ),
        true
      );
    }

    const namedDuplicateStore = await createMysqlStore();

    stage = "named duplicate processing key replay";
    const processingReplayRaw = createRawFixture(
      "identity-duplicate-processing-replay-team",
      "owner-a"
    );
    await insertRawRecord(database, processingReplayRaw);
    const processingReplayInput = persistedInput(
      processingReplayRaw,
      [registration("DUPLICATE-PROCESSING-REPLAY-100")]
    );
    let processingReplayWinnerSnapshot:
      Awaited<ReturnType<typeof databaseIdentityFactSnapshot>> | null = null;
    const processingReplayRace = namedDuplicateRacePool(pool, {
      table: "organization_identity_resolutions",
      key: "organization_identity_resolutions.uk_oi_resolution_processing",
      async afterRollback() {
        const winner = await resolveOrganizationStrongIdentityMysql(
          pool,
          namedDuplicateStore,
          processingReplayInput
        );
        assert.equal(winner.resolution.result, "new_entity");
        processingReplayWinnerSnapshot =
          await databaseIdentityFactSnapshot(database);
      }
    });
    const processingReplayResult =
      await resolveOrganizationStrongIdentityMysql(
        processingReplayRace.pool,
        namedDuplicateStore,
        processingReplayInput
      );
    assert.equal(processingReplayRace.state.duplicateInjected, true);
    assert.equal(processingReplayRace.state.winnerCommitted, true);
    assert.equal(processingReplayResult.idempotent, true);
    assert.ok(processingReplayWinnerSnapshot);
    assert.deepEqual(
      await databaseIdentityFactSnapshot(database),
      processingReplayWinnerSnapshot
    );

    stage = "named duplicate processing key changed claim conflict";
    const processingConflictRaw = createRawFixture(
      "identity-duplicate-processing-conflict-team",
      "owner-a"
    );
    await insertRawRecord(database, processingConflictRaw);
    const processingConflictWinnerInput = persistedInput(
      processingConflictRaw,
      [registration("DUPLICATE-PROCESSING-WINNER-100")]
    );
    const processingConflictLoserInput = {
      ...processingConflictWinnerInput,
      claims: [registration("DUPLICATE-PROCESSING-LOSER-200")]
    };
    let processingConflictWinnerSnapshot:
      Awaited<ReturnType<typeof databaseIdentityFactSnapshot>> | null = null;
    const processingConflictRace = namedDuplicateRacePool(pool, {
      table: "organization_identity_resolutions",
      key: "uk_oi_resolution_processing",
      async afterRollback() {
        await resolveOrganizationStrongIdentityMysql(
          pool,
          namedDuplicateStore,
          processingConflictWinnerInput
        );
        processingConflictWinnerSnapshot =
          await databaseIdentityFactSnapshot(database);
      }
    });
    await assert.rejects(
      resolveOrganizationStrongIdentityMysql(
        processingConflictRace.pool,
        namedDuplicateStore,
        processingConflictLoserInput
      ),
      isIdentityError("IDENTITY_CLAIM_REPLAY_CONFLICT")
    );
    assert.equal(processingConflictRace.state.duplicateInjected, true);
    assert.equal(processingConflictRace.state.winnerCommitted, true);
    assert.ok(processingConflictWinnerSnapshot);
    assert.deepEqual(
      await databaseIdentityFactSnapshot(database),
      processingConflictWinnerSnapshot
    );

    stage = "named duplicate identifier exact match and owner isolation";
    const identifierExactLoserRaw = createRawFixture(
      "identity-duplicate-identifier-exact-team",
      "owner-loser"
    );
    const identifierExactWinnerRaw = createRawFixture(
      "identity-duplicate-identifier-exact-team",
      "owner-winner"
    );
    await insertRawRecord(database, identifierExactLoserRaw);
    await insertRawRecord(database, identifierExactWinnerRaw);
    const identifierExactClaims = [
      registration("DUPLICATE-IDENTIFIER-EXACT-100")
    ];
    const identifierExactLoserInput = persistedInput(
      identifierExactLoserRaw,
      identifierExactClaims
    );
    const identifierExactWinnerInput = persistedInput(
      identifierExactWinnerRaw,
      identifierExactClaims
    );
    let identifierExactWinnerOrganizationId = "";
    const identifierExactRace = namedDuplicateRacePool(pool, {
      table: "organization_accepted_identifiers",
      key: "uk_oi_identifier_lookup",
      async afterRollback() {
        const winner = await resolveOrganizationStrongIdentityMysql(
          pool,
          namedDuplicateStore,
          identifierExactWinnerInput
        );
        identifierExactWinnerOrganizationId =
          winner.resolution.organizationId;
      }
    });
    const identifierExactResult =
      await resolveOrganizationStrongIdentityMysql(
        identifierExactRace.pool,
        namedDuplicateStore,
        identifierExactLoserInput
      );
    assert.equal(identifierExactRace.state.duplicateInjected, true);
    assert.equal(identifierExactRace.state.winnerCommitted, true);
    assert.equal(identifierExactResult.resolution.result, "exact_match");
    assert.equal(
      identifierExactResult.resolution.organizationId,
      identifierExactWinnerOrganizationId
    );
    assert.equal(identifierExactResult.createdOrganization, null);
    assert.equal(identifierExactResult.createdIdentifiers.length, 0);
    assert.ok(identifierExactResult.claims.every((item) =>
      item.ownerId === identifierExactLoserRaw.ownerId
    ));
    assert.ok(identifierExactResult.events.every((item) =>
      item.ownerId === identifierExactLoserRaw.ownerId
    ));
    assert.equal(
      identifierExactResult.binding?.ownerId,
      identifierExactLoserRaw.ownerId
    );
    assert.equal(
      namedDuplicateStore.organizations.filter((item) =>
        item.teamId === identifierExactLoserRaw.teamId
      ).length,
      1
    );
    assert.equal(
      namedDuplicateStore.organizationIdentityResolutions.filter(
        (item) => item.teamId === identifierExactLoserRaw.teamId
      ).length,
      2
    );

    stage = "named duplicate identifier binding conflict";
    const identifierBindingRaw = createRawFixture(
      "identity-duplicate-identifier-binding-team",
      "owner-binding"
    );
    const identifierBindingTargetRaw = createRawFixture(
      "identity-duplicate-identifier-binding-team",
      "owner-target"
    );
    const identifierBindingWinnerRaw = createRawFixture(
      "identity-duplicate-identifier-binding-team",
      "owner-winner"
    );
    await insertRawRecord(database, identifierBindingRaw);
    await insertRawRecord(database, identifierBindingTargetRaw);
    await insertRawRecord(database, identifierBindingWinnerRaw);
    const identifierBindingSeed = await resolvePersisted(
      namedDuplicateStore,
      identifierBindingRaw,
      [lei("529900T8BM49AURSDO55")]
    );
    const identifierBindingTarget = await resolvePersisted(
      namedDuplicateStore,
      identifierBindingTargetRaw,
      [lei("213800D1EI4B9WTWWD28")]
    );
    assert.notEqual(
      identifierBindingSeed.resolution.organizationId,
      identifierBindingTarget.resolution.organizationId
    );
    const identifierBindingLoserInput = persistedInput(
      identifierBindingRaw,
      [registration("DUPLICATE-IDENTIFIER-BINDING-B-200")],
      { parserVersion: "identity-parser-v2" }
    );
    const identifierBindingWinnerInput = persistedInput(
      identifierBindingWinnerRaw,
      [
        lei("213800D1EI4B9WTWWD28"),
        registration("DUPLICATE-IDENTIFIER-BINDING-B-200")
      ]
    );
    let identifierBindingStructuralAfterWinner:
      Awaited<ReturnType<typeof databaseTableSnapshot>> | null = null;
    const identifierBindingRace = namedDuplicateRacePool(pool, {
      table: "organization_accepted_identifiers",
      key: "organization_accepted_identifiers.uk_oi_identifier_lookup",
      async afterRollback() {
        const winner = await resolveOrganizationStrongIdentityMysql(
          pool,
          namedDuplicateStore,
          identifierBindingWinnerInput
        );
        assert.equal(winner.resolution.result, "exact_match");
        identifierBindingStructuralAfterWinner =
          await databaseTableSnapshot(database, bindingStructuralTables);
      }
    });
    const identifierBindingConflict =
      await resolveOrganizationStrongIdentityMysql(
        identifierBindingRace.pool,
        namedDuplicateStore,
        identifierBindingLoserInput
      );
    assert.equal(identifierBindingRace.state.duplicateInjected, true);
    assert.equal(identifierBindingRace.state.winnerCommitted, true);
    assert.equal(
      identifierBindingConflict.resolution.result,
      "conflict"
    );
    assert.equal(
      identifierBindingConflict.conflict?.conflictType,
      "binding_conflict"
    );
    assert.equal(identifierBindingConflict.binding, null);
    assert.equal(identifierBindingConflict.createdIdentifiers.length, 0);
    assert.ok(identifierBindingStructuralAfterWinner);
    assert.deepEqual(
      await databaseTableSnapshot(database, bindingStructuralTables),
      identifierBindingStructuralAfterWinner
    );

    stage = "named duplicate identifier hash collision";
    const identifierCollisionLoserRaw = createRawFixture(
      "identity-duplicate-identifier-collision-team",
      "owner-loser"
    );
    const identifierCollisionWinnerRaw = createRawFixture(
      "identity-duplicate-identifier-collision-team",
      "owner-winner"
    );
    await insertRawRecord(database, identifierCollisionLoserRaw);
    await insertRawRecord(database, identifierCollisionWinnerRaw);
    const identifierCollisionClaims = [
      registration("DUPLICATE-IDENTIFIER-COLLISION-100")
    ];
    const identifierCollisionLoserInput = persistedInput(
      identifierCollisionLoserRaw,
      identifierCollisionClaims
    );
    const identifierCollisionWinnerInput = persistedInput(
      identifierCollisionWinnerRaw,
      identifierCollisionClaims
    );
    let identifierCollisionWinnerSnapshot:
      Awaited<ReturnType<typeof databaseIdentityFactSnapshot>> | null = null;
    const identifierCollisionRace = namedDuplicateRacePool(pool, {
      table: "organization_accepted_identifiers",
      key: "uk_oi_identifier_lookup",
      async afterRollback() {
        const winner = await resolveOrganizationStrongIdentityMysql(
          pool,
          namedDuplicateStore,
          identifierCollisionWinnerInput
        );
        assert.equal(winner.createdIdentifiers.length, 1);
        await rewriteIdentifierNormalizedValue(
          database,
          winner.createdIdentifiers[0]!.id,
          "DIFFERENT-FULL-VALUE"
        );
        identifierCollisionWinnerSnapshot =
          await databaseIdentityFactSnapshot(database);
      }
    });
    await assert.rejects(
      resolveOrganizationStrongIdentityMysql(
        identifierCollisionRace.pool,
        namedDuplicateStore,
        identifierCollisionLoserInput
      ),
      isIdentityError("IDENTITY_IDENTIFIER_HASH_COLLISION")
    );
    assert.equal(identifierCollisionRace.state.duplicateInjected, true);
    assert.equal(identifierCollisionRace.state.winnerCommitted, true);
    assert.ok(identifierCollisionWinnerSnapshot);
    assert.deepEqual(
      await databaseIdentityFactSnapshot(database),
      identifierCollisionWinnerSnapshot
    );

    stage = "named duplicate active binding reuse";
    const bindingReuseSeedRaw = createRawFixture(
      "identity-duplicate-binding-reuse-team",
      "owner-seed"
    );
    const bindingReuseRaw = createRawFixture(
      "identity-duplicate-binding-reuse-team",
      "owner-binding"
    );
    await insertRawRecord(database, bindingReuseSeedRaw);
    await insertRawRecord(database, bindingReuseRaw);
    await resolvePersisted(
      namedDuplicateStore,
      bindingReuseSeedRaw,
      [registration("DUPLICATE-BINDING-REUSE-100")]
    );
    const bindingReuseLoserInput = persistedInput(
      bindingReuseRaw,
      [registration("DUPLICATE-BINDING-REUSE-100")]
    );
    const bindingReuseWinnerInput = persistedInput(
      bindingReuseRaw,
      [registration("DUPLICATE-BINDING-REUSE-100")],
      { parserVersion: "identity-parser-v2" }
    );
    let bindingReuseWinnerBindingId = "";
    let bindingReuseStructuralAfterWinner:
      Awaited<ReturnType<typeof databaseTableSnapshot>> | null = null;
    const bindingReuseRace = namedDuplicateRacePool(pool, {
      table: "organization_source_bindings",
      key: `${databaseName}.organization_source_bindings`
        + ".uk_oi_binding_active_raw",
      async afterRollback() {
        const winner = await resolveOrganizationStrongIdentityMysql(
          pool,
          namedDuplicateStore,
          bindingReuseWinnerInput
        );
        bindingReuseWinnerBindingId = winner.binding?.id || "";
        bindingReuseStructuralAfterWinner =
          await databaseTableSnapshot(database, bindingStructuralTables);
      }
    });
    const bindingReuseResult = await resolveOrganizationStrongIdentityMysql(
      bindingReuseRace.pool,
      namedDuplicateStore,
      bindingReuseLoserInput
    );
    assert.equal(bindingReuseRace.state.duplicateInjected, true);
    assert.equal(bindingReuseRace.state.winnerCommitted, true);
    assert.equal(bindingReuseResult.resolution.result, "exact_match");
    assert.equal(
      bindingReuseResult.resolution.bindingRelationRole,
      "reused_existing"
    );
    assert.equal(bindingReuseResult.binding?.id, bindingReuseWinnerBindingId);
    assert.ok(bindingReuseStructuralAfterWinner);
    assert.deepEqual(
      await databaseTableSnapshot(database, bindingStructuralTables),
      bindingReuseStructuralAfterWinner
    );

    stage = "named duplicate active binding conflict";
    const bindingConflictSeedARaw = createRawFixture(
      "identity-duplicate-binding-conflict-team",
      "owner-seed-a"
    );
    const bindingConflictSeedBRaw = createRawFixture(
      "identity-duplicate-binding-conflict-team",
      "owner-seed-b"
    );
    const bindingConflictRaceRaw = createRawFixture(
      "identity-duplicate-binding-conflict-team",
      "owner-binding"
    );
    await insertRawRecord(database, bindingConflictSeedARaw);
    await insertRawRecord(database, bindingConflictSeedBRaw);
    await insertRawRecord(database, bindingConflictRaceRaw);
    await resolvePersisted(
      namedDuplicateStore,
      bindingConflictSeedARaw,
      [registration("DUPLICATE-BINDING-CONFLICT-A-100")]
    );
    await resolvePersisted(
      namedDuplicateStore,
      bindingConflictSeedBRaw,
      [registration("DUPLICATE-BINDING-CONFLICT-B-200")]
    );
    const bindingConflictLoserInput = persistedInput(
      bindingConflictRaceRaw,
      [registration("DUPLICATE-BINDING-CONFLICT-A-100")]
    );
    const bindingConflictWinnerInput = persistedInput(
      bindingConflictRaceRaw,
      [registration("DUPLICATE-BINDING-CONFLICT-B-200")],
      { parserVersion: "identity-parser-v2" }
    );
    let bindingConflictStructuralAfterWinner:
      Awaited<ReturnType<typeof databaseTableSnapshot>> | null = null;
    const bindingConflictRace = namedDuplicateRacePool(pool, {
      table: "organization_source_bindings",
      key: "organization_source_bindings.uk_oi_binding_active_raw",
      async afterRollback() {
        await resolveOrganizationStrongIdentityMysql(
          pool,
          namedDuplicateStore,
          bindingConflictWinnerInput
        );
        bindingConflictStructuralAfterWinner =
          await databaseTableSnapshot(database, bindingStructuralTables);
      }
    });
    const namedBindingConflict =
      await resolveOrganizationStrongIdentityMysql(
        bindingConflictRace.pool,
        namedDuplicateStore,
        bindingConflictLoserInput
      );
    assert.equal(bindingConflictRace.state.duplicateInjected, true);
    assert.equal(bindingConflictRace.state.winnerCommitted, true);
    assert.equal(namedBindingConflict.resolution.result, "conflict");
    assert.equal(
      namedBindingConflict.conflict?.conflictType,
      "binding_conflict"
    );
    assert.equal(namedBindingConflict.binding, null);
    assert.ok(bindingConflictStructuralAfterWinner);
    assert.deepEqual(
      await databaseTableSnapshot(database, bindingStructuralTables),
      bindingConflictStructuralAfterWinner
    );

    stage = "named duplicate fail closed matrix";
    const failClosedCases = [
      {
        label: "claim ordinal",
        table: "organization_identity_claims",
        duplicate: mysqlDuplicateError(
          "organization_identity_claims.uk_oi_claim_resolution_ordinal"
        )
      },
      {
        label: "event ordinal",
        table: "organization_identity_events",
        duplicate: mysqlDuplicateError(
          "organization_identity_events.uk_oi_event_resolution_sequence"
        )
      },
      {
        label: "relation ordinal",
        table: "organization_identity_resolution_identifiers",
        duplicate: mysqlDuplicateError("PRIMARY")
      },
      {
        label: "primary",
        table: "organizations",
        duplicate: mysqlDuplicateError("PRIMARY")
      },
      {
        label: "unknown constraint",
        table: "organization_identity_resolutions",
        duplicate: mysqlDuplicateError("uk_oi_resolution_unknown")
      },
      {
        label: "malformed message",
        table: "organization_identity_resolutions",
        duplicate: mysqlDuplicateError("uk_oi_resolution_processing", {
          sqlMessage:
            "Duplicate entry 'sensitive-value' "
            + "for key 'uk_oi_resolution_processing"
        })
      },
      {
        label: "nonstandard message prefix",
        table: "organization_identity_resolutions",
        duplicate: mysqlDuplicateError("uk_oi_resolution_processing", {
          sqlMessage:
            "Synthetic duplicate 'sensitive-value' "
            + "for key 'uk_oi_resolution_processing'"
        })
      },
      {
        label: "plain object",
        table: "organization_identity_resolutions",
        duplicate: {
          code: "ER_DUP_ENTRY",
          errno: 1062,
          sqlState: "23000",
          sqlMessage:
            "Duplicate entry 'sensitive-value' "
            + "for key 'uk_oi_resolution_processing'"
        }
      },
      {
        label: "wrong case",
        table: "organization_identity_resolutions",
        duplicate: mysqlDuplicateError("UK_OI_RESOLUTION_PROCESSING")
      },
      {
        label: "table mismatch",
        table: "organization_identity_resolutions",
        duplicate: mysqlDuplicateError(
          "organization_accepted_identifiers.uk_oi_identifier_lookup"
        )
      },
      {
        label: "control character",
        table: "organization_identity_resolutions",
        duplicate: mysqlDuplicateError("uk_oi_resolution_processing", {
          sqlMessage:
            "Duplicate entry 'sensitive-value'\n"
            + "for key 'uk_oi_resolution_processing'"
        })
      },
      {
        label: "missing sql state",
        table: "organization_identity_resolutions",
        duplicate: mysqlDuplicateError("uk_oi_resolution_processing", {
          sqlState: ""
        })
      },
      {
        label: "wrong errno",
        table: "organization_identity_resolutions",
        duplicate: mysqlDuplicateError("uk_oi_resolution_processing", {
          errno: 9999
        })
      },
      {
        label: "string errno",
        table: "organization_identity_resolutions",
        duplicate: mysqlDuplicateError("uk_oi_resolution_processing", {
          errno: "1062" as unknown as number
        })
      },
      {
        label: "wrong code",
        table: "organization_identity_resolutions",
        duplicate: mysqlDuplicateError("uk_oi_resolution_processing", {
          code: "ER_OTHER"
        })
      }
    ] as const;
    for (const [index, item] of failClosedCases.entries()) {
      stage = `named duplicate fail closed ${item.label}`;
      const raw = createRawFixture(
        `identity-duplicate-fail-closed-${index}`,
        "owner-a"
      );
      await insertRawRecord(database, raw);
      const before = await databaseIdentityFactSnapshot(database);
      let injected = false;
      const failClosedPool = instrumentPool(pool, {
        connection: {
          query(sql, proceed) {
            if (!injected && isInsertInto(sql, item.table)) {
              injected = true;
              throw item.duplicate;
            }
            return proceed();
          }
        }
      });
      await assert.rejects(
        resolveOrganizationStrongIdentityMysql(
          failClosedPool,
          namedDuplicateStore,
          persistedInput(raw, [
            registration(`DUPLICATE-FAIL-CLOSED-${index}`)
          ])
        ),
        (error: unknown) => {
          if (!(error instanceof OrganizationStrongIdentityError)
            || error.code !== "IDENTITY_DATA_INTEGRITY_VIOLATION") {
            return false;
          }
          assert.equal(error.message.includes("sensitive-value"), false);
          assert.equal(error.message.includes(item.table), false);
          assert.equal(error.message.includes("uk_oi_"), false);
          return true;
        }
      );
      assert.equal(injected, true);
      assert.deepEqual(
        await databaseIdentityFactSnapshot(database),
        before
      );
    }

    stage = "named duplicate rollback failure destroys connection";
    const rollbackFailureRaw = createRawFixture(
      "identity-duplicate-rollback-failure-team",
      "owner-a"
    );
    await insertRawRecord(database, rollbackFailureRaw);
    const rollbackFailureBefore =
      await databaseIdentityFactSnapshot(database);
    let rollbackDuplicateInjected = false;
    let rollbackConnectionDestroyed = false;
    let rollbackConnectionReleased = false;
    const rollbackFailurePool = instrumentPool(pool, {
      connection: {
        query(sql, proceed) {
          if (!rollbackDuplicateInjected
            && isInsertInto(sql, "organization_identity_resolutions")) {
            rollbackDuplicateInjected = true;
            throw mysqlDuplicateError(
              "organization_identity_resolutions"
              + ".uk_oi_resolution_processing"
            );
          }
          return proceed();
        },
        async rollback() {
          throw new Error("forced rollback outcome uncertainty");
        },
        destroy() {
          rollbackConnectionDestroyed = true;
          throw new Error("forced destroy failure");
        },
        release() {
          rollbackConnectionReleased = true;
        }
      }
    });
    await assert.rejects(
      resolveOrganizationStrongIdentityMysql(
        rollbackFailurePool,
        namedDuplicateStore,
        persistedInput(rollbackFailureRaw, [
          registration("DUPLICATE-ROLLBACK-FAILURE-100")
        ])
      ),
      isIdentityError("IDENTITY_DATA_INTEGRITY_VIOLATION")
    );
    assert.equal(rollbackDuplicateInjected, true);
    assert.equal(rollbackConnectionDestroyed, true);
    assert.equal(rollbackConnectionReleased, false);
    assert.deepEqual(
      await databaseIdentityFactSnapshot(database),
      rollbackFailureBefore
    );

    stage = "named duplicate recovery second duplicate fails closed";
    const secondDuplicateLoserRaw = createRawFixture(
      "identity-duplicate-second-team",
      "owner-loser"
    );
    const secondDuplicateWinnerRaw = createRawFixture(
      "identity-duplicate-second-team",
      "owner-winner"
    );
    await insertRawRecord(database, secondDuplicateLoserRaw);
    await insertRawRecord(database, secondDuplicateWinnerRaw);
    const secondDuplicateClaims = [
      registration("DUPLICATE-SECOND-100")
    ];
    const secondDuplicateLoserInput = persistedInput(
      secondDuplicateLoserRaw,
      secondDuplicateClaims
    );
    const secondDuplicateWinnerInput = persistedInput(
      secondDuplicateWinnerRaw,
      secondDuplicateClaims
    );
    let firstDuplicateInjected = false;
    let secondDuplicateInjected = false;
    let secondDuplicateWinnerCommitted = false;
    let secondDuplicateWinnerSnapshot:
      Awaited<ReturnType<typeof databaseIdentityFactSnapshot>> | null = null;
    const secondDuplicatePool = instrumentPool(pool, {
      connection: {
        query(sql, proceed) {
          if (!firstDuplicateInjected
            && isInsertInto(
              sql,
              "organization_accepted_identifiers"
            )) {
            firstDuplicateInjected = true;
            throw mysqlDuplicateError(
              "organization_accepted_identifiers"
              + ".uk_oi_identifier_lookup"
            );
          }
          if (firstDuplicateInjected
            && secondDuplicateWinnerCommitted
            && !secondDuplicateInjected
            && isInsertInto(sql, "organization_identity_resolutions")) {
            secondDuplicateInjected = true;
            throw mysqlDuplicateError(
              "organization_identity_resolutions"
              + ".uk_oi_resolution_processing"
            );
          }
          return proceed();
        },
        async rollback(proceed) {
          await proceed();
          if (firstDuplicateInjected && !secondDuplicateWinnerCommitted) {
            await resolveOrganizationStrongIdentityMysql(
              pool,
              namedDuplicateStore,
              secondDuplicateWinnerInput
            );
            secondDuplicateWinnerSnapshot =
              await databaseIdentityFactSnapshot(database);
            secondDuplicateWinnerCommitted = true;
          }
        }
      }
    });
    await assert.rejects(
      resolveOrganizationStrongIdentityMysql(
        secondDuplicatePool,
        namedDuplicateStore,
        secondDuplicateLoserInput
      ),
      isIdentityError("IDENTITY_DATA_INTEGRITY_VIOLATION")
    );
    assert.equal(firstDuplicateInjected, true);
    assert.equal(secondDuplicateInjected, true);
    assert.equal(secondDuplicateWinnerCommitted, true);
    assert.ok(secondDuplicateWinnerSnapshot);
    assert.deepEqual(
      await databaseIdentityFactSnapshot(database),
      secondDuplicateWinnerSnapshot
    );

    stage = "named duplicate recovery rollback failure destroys connection";
    const recoveryRollbackLoserRaw = createRawFixture(
      "identity-duplicate-recovery-rollback-team",
      "owner-loser"
    );
    const recoveryRollbackWinnerRaw = createRawFixture(
      "identity-duplicate-recovery-rollback-team",
      "owner-winner"
    );
    await insertRawRecord(database, recoveryRollbackLoserRaw);
    await insertRawRecord(database, recoveryRollbackWinnerRaw);
    const recoveryRollbackClaims = [
      registration("DUPLICATE-RECOVERY-ROLLBACK-100")
    ];
    const recoveryRollbackLoserInput = persistedInput(
      recoveryRollbackLoserRaw,
      recoveryRollbackClaims
    );
    const recoveryRollbackWinnerInput = persistedInput(
      recoveryRollbackWinnerRaw,
      recoveryRollbackClaims
    );
    let recoveryRollbackFirstDuplicate = false;
    let recoveryRollbackSecondDuplicate = false;
    let recoveryRollbackWinnerCommitted = false;
    let recoveryRollbackCalls = 0;
    let recoveryRollbackDestroyCalls = 0;
    let recoveryRollbackReleaseCalls = 0;
    let recoveryRollbackWinnerSnapshot:
      Awaited<ReturnType<typeof databaseIdentityFactSnapshot>> | null = null;
    const recoveryRollbackPool = instrumentPool(pool, {
      connection: {
        query(sql, proceed) {
          if (!recoveryRollbackFirstDuplicate
            && isInsertInto(
              sql,
              "organization_accepted_identifiers"
            )) {
            recoveryRollbackFirstDuplicate = true;
            throw mysqlDuplicateError(
              "organization_accepted_identifiers"
              + ".uk_oi_identifier_lookup"
            );
          }
          if (recoveryRollbackWinnerCommitted
            && !recoveryRollbackSecondDuplicate
            && isInsertInto(sql, "organization_identity_resolutions")) {
            recoveryRollbackSecondDuplicate = true;
            throw mysqlDuplicateError(
              "organization_identity_resolutions"
              + ".uk_oi_resolution_processing"
            );
          }
          return proceed();
        },
        async rollback(proceed) {
          recoveryRollbackCalls += 1;
          if (recoveryRollbackCalls === 1) {
            await proceed();
            await resolveOrganizationStrongIdentityMysql(
              pool,
              namedDuplicateStore,
              recoveryRollbackWinnerInput
            );
            recoveryRollbackWinnerSnapshot =
              await databaseIdentityFactSnapshot(database);
            recoveryRollbackWinnerCommitted = true;
            return;
          }
          throw new Error("forced recovery rollback failure");
        },
        destroy() {
          recoveryRollbackDestroyCalls += 1;
          throw new Error("forced recovery destroy failure");
        },
        release() {
          recoveryRollbackReleaseCalls += 1;
        }
      }
    });
    await assert.rejects(
      resolveOrganizationStrongIdentityMysql(
        recoveryRollbackPool,
        namedDuplicateStore,
        recoveryRollbackLoserInput
      ),
      isIdentityError("IDENTITY_DATA_INTEGRITY_VIOLATION")
    );
    assert.equal(recoveryRollbackFirstDuplicate, true);
    assert.equal(recoveryRollbackSecondDuplicate, true);
    assert.equal(recoveryRollbackWinnerCommitted, true);
    assert.equal(recoveryRollbackCalls, 2);
    assert.equal(recoveryRollbackDestroyCalls, 1);
    assert.equal(recoveryRollbackReleaseCalls, 1);
    assert.ok(recoveryRollbackWinnerSnapshot);
    assert.deepEqual(
      await databaseIdentityFactSnapshot(database),
      recoveryRollbackWinnerSnapshot
    );

    stage = "named duplicate recovery database error is redacted";
    const recoveryRedactionLoserRaw = createRawFixture(
      "identity-duplicate-recovery-redaction-team",
      "owner-loser"
    );
    const recoveryRedactionWinnerRaw = createRawFixture(
      "identity-duplicate-recovery-redaction-team",
      "owner-winner"
    );
    await insertRawRecord(database, recoveryRedactionLoserRaw);
    await insertRawRecord(database, recoveryRedactionWinnerRaw);
    const recoveryRedactionClaims = [
      registration("DUPLICATE-RECOVERY-REDACTION-100")
    ];
    const recoveryRedactionLoserInput = persistedInput(
      recoveryRedactionLoserRaw,
      recoveryRedactionClaims
    );
    const recoveryRedactionWinnerInput = persistedInput(
      recoveryRedactionWinnerRaw,
      recoveryRedactionClaims
    );
    let recoveryRedactionDuplicateInjected = false;
    let recoveryRedactionWinnerCommitted = false;
    let recoveryRedactionDatabaseErrorInjected = false;
    let recoveryRedactionWinnerSnapshot:
      Awaited<ReturnType<typeof databaseIdentityFactSnapshot>> | null = null;
    const recoveryRedactionPool = instrumentPool(pool, {
      connection: {
        query(sql, proceed) {
          if (!recoveryRedactionDuplicateInjected
            && isInsertInto(
              sql,
              "organization_accepted_identifiers"
            )) {
            recoveryRedactionDuplicateInjected = true;
            throw mysqlDuplicateError(
              "organization_accepted_identifiers"
              + ".uk_oi_identifier_lookup"
            );
          }
          if (recoveryRedactionWinnerCommitted
            && !recoveryRedactionDatabaseErrorInjected
            && isInsertInto(sql, "organization_identity_resolutions")) {
            recoveryRedactionDatabaseErrorInjected = true;
            throw Object.assign(
              new Error("sensitive-value organization_identity_resolutions"),
              {
                code: "ER_BAD_FIELD_ERROR",
                errno: 1054,
                sql: "INSERT INTO secret_table VALUES ('sensitive-value')",
                sqlMessage:
                  "Unknown column 'private_column' in 'secret_table'"
              }
            );
          }
          return proceed();
        },
        async rollback(proceed) {
          await proceed();
          if (recoveryRedactionDuplicateInjected
            && !recoveryRedactionWinnerCommitted) {
            await resolveOrganizationStrongIdentityMysql(
              pool,
              namedDuplicateStore,
              recoveryRedactionWinnerInput
            );
            recoveryRedactionWinnerSnapshot =
              await databaseIdentityFactSnapshot(database);
            recoveryRedactionWinnerCommitted = true;
          }
        }
      }
    });
    await assert.rejects(
      resolveOrganizationStrongIdentityMysql(
        recoveryRedactionPool,
        namedDuplicateStore,
        recoveryRedactionLoserInput
      ),
      (error: unknown) => {
        if (!(error instanceof OrganizationStrongIdentityError)
          || error.code !== "IDENTITY_DATA_INTEGRITY_VIOLATION") {
          return false;
        }
        assert.equal(error.message.includes("sensitive-value"), false);
        assert.equal(
          error.message.includes("organization_identity_resolutions"),
          false
        );
        assert.equal(error.message.includes("secret_table"), false);
        assert.equal(error.message.includes("private_column"), false);
        return true;
      }
    );
    assert.equal(recoveryRedactionDuplicateInjected, true);
    assert.equal(recoveryRedactionWinnerCommitted, true);
    assert.equal(recoveryRedactionDatabaseErrorInjected, true);
    assert.ok(recoveryRedactionWinnerSnapshot);
    assert.deepEqual(
      await databaseIdentityFactSnapshot(database),
      recoveryRedactionWinnerSnapshot
    );

    stage = "named duplicate recovery commit response loss converges";
    const recoveryCommitLoserRaw = createRawFixture(
      "identity-duplicate-recovery-commit-team",
      "owner-loser"
    );
    const recoveryCommitWinnerRaw = createRawFixture(
      "identity-duplicate-recovery-commit-team",
      "owner-winner"
    );
    await insertRawRecord(database, recoveryCommitLoserRaw);
    await insertRawRecord(database, recoveryCommitWinnerRaw);
    const recoveryCommitClaims = [
      registration("DUPLICATE-RECOVERY-COMMIT-100")
    ];
    const recoveryCommitLoserInput = persistedInput(
      recoveryCommitLoserRaw,
      recoveryCommitClaims
    );
    const recoveryCommitWinnerInput = persistedInput(
      recoveryCommitWinnerRaw,
      recoveryCommitClaims
    );
    let recoveryCommitDuplicateInjected = false;
    let recoveryCommitWinnerCommitted = false;
    let recoveryCommitResponseLost = false;
    let recoveryCommitDestroyCalls = 0;
    const recoveryCommitPool = instrumentPool(pool, {
      connection: {
        query(sql, proceed) {
          if (!recoveryCommitDuplicateInjected
            && isInsertInto(
              sql,
              "organization_accepted_identifiers"
            )) {
            recoveryCommitDuplicateInjected = true;
            throw mysqlDuplicateError(
              "organization_accepted_identifiers"
              + ".uk_oi_identifier_lookup"
            );
          }
          return proceed();
        },
        async rollback(proceed) {
          await proceed();
          if (recoveryCommitDuplicateInjected
            && !recoveryCommitWinnerCommitted) {
            await resolveOrganizationStrongIdentityMysql(
              pool,
              namedDuplicateStore,
              recoveryCommitWinnerInput
            );
            recoveryCommitWinnerCommitted = true;
          }
        },
        async commit(proceed) {
          await proceed();
          if (!recoveryCommitResponseLost) {
            recoveryCommitResponseLost = true;
            throw new Error("forced named duplicate recovery commit loss");
          }
        },
        destroy() {
          recoveryCommitDestroyCalls += 1;
        }
      }
    });
    const recoveryCommitResult =
      await resolveOrganizationStrongIdentityMysql(
        recoveryCommitPool,
        namedDuplicateStore,
        recoveryCommitLoserInput
      );
    assert.equal(
      recoveryCommitResult.resolution.result,
      "exact_match"
    );
    assert.equal(recoveryCommitResult.idempotent, true);
    assert.equal(recoveryCommitDuplicateInjected, true);
    assert.equal(recoveryCommitWinnerCommitted, true);
    assert.equal(recoveryCommitResponseLost, true);
    assert.equal(recoveryCommitDestroyCalls, 1);
    const recoveryCommitState = await loadOrganizationIdentityState(
      pool,
      undefined,
      recoveryCommitLoserRaw.teamId
    );
    assert.equal(recoveryCommitState.organizations.length, 1);
    assert.equal(recoveryCommitState.organizationIdentityResolutions.length, 2);

    stage = "named duplicate recovery absent commit retries frozen command";
    const recoveryAbsentLoserRaw = createRawFixture(
      "identity-duplicate-recovery-absent-team",
      "owner-loser"
    );
    const recoveryAbsentWinnerRaw = createRawFixture(
      "identity-duplicate-recovery-absent-team",
      "owner-winner"
    );
    await insertRawRecord(database, recoveryAbsentLoserRaw);
    await insertRawRecord(database, recoveryAbsentWinnerRaw);
    const recoveryAbsentClaims = [
      registration("DUPLICATE-RECOVERY-ABSENT-100")
    ];
    const recoveryAbsentLoserInput = persistedInput(
      recoveryAbsentLoserRaw,
      recoveryAbsentClaims
    );
    const recoveryAbsentWinnerInput = persistedInput(
      recoveryAbsentWinnerRaw,
      recoveryAbsentClaims
    );
    let recoveryAbsentDuplicateInjected = false;
    let recoveryAbsentWinnerCommitted = false;
    let recoveryAbsentCommitFailed = false;
    let recoveryAbsentCommitCalls = 0;
    let recoveryAbsentDestroyCalls = 0;
    const recoveryAbsentPool = instrumentPool(pool, {
      connection: {
        query(sql, proceed) {
          if (!recoveryAbsentDuplicateInjected
            && isInsertInto(
              sql,
              "organization_accepted_identifiers"
            )) {
            recoveryAbsentDuplicateInjected = true;
            throw mysqlDuplicateError(
              "organization_accepted_identifiers"
              + ".uk_oi_identifier_lookup"
            );
          }
          return proceed();
        },
        async rollback(proceed) {
          await proceed();
          if (recoveryAbsentDuplicateInjected
            && !recoveryAbsentWinnerCommitted) {
            await resolveOrganizationStrongIdentityMysql(
              pool,
              namedDuplicateStore,
              recoveryAbsentWinnerInput
            );
            recoveryAbsentWinnerCommitted = true;
          }
        },
        async commit(proceed) {
          recoveryAbsentCommitCalls += 1;
          if (!recoveryAbsentCommitFailed) {
            recoveryAbsentCommitFailed = true;
            recoveryAbsentLoserInput.claims[0]!.value =
              "DUPLICATE-RECOVERY-ABSENT-MUTATED-100";
            recoveryAbsentLoserInput.claims[0]!.normalizedValue =
              "DUPLICATE-RECOVERY-ABSENT-MUTATED-100";
            throw new Error(
              "forced named duplicate recovery commit before persistence"
            );
          }
          await proceed();
        },
        destroy() {
          recoveryAbsentDestroyCalls += 1;
        }
      }
    });
    const recoveryAbsentResult =
      await resolveOrganizationStrongIdentityMysql(
        recoveryAbsentPool,
        namedDuplicateStore,
        recoveryAbsentLoserInput
      );
    assert.equal(recoveryAbsentResult.resolution.result, "exact_match");
    assert.equal(recoveryAbsentResult.idempotent, false);
    assert.equal(recoveryAbsentDuplicateInjected, true);
    assert.equal(recoveryAbsentWinnerCommitted, true);
    assert.equal(recoveryAbsentCommitFailed, true);
    assert.equal(recoveryAbsentCommitCalls >= 3, true);
    assert.equal(recoveryAbsentDestroyCalls, 1);
    const recoveryAbsentState = await loadOrganizationIdentityState(
      pool,
      undefined,
      recoveryAbsentLoserRaw.teamId
    );
    assert.equal(recoveryAbsentState.organizations.length, 1);
    assert.equal(
      recoveryAbsentState.organizationAcceptedIdentifiers[0]?.normalizedValue,
      "DUPLICATE-RECOVERY-ABSENT-100"
    );
    assert.equal(
      recoveryAbsentState.organizationIdentityResolutions.length,
      2
    );
    assert.equal(
      recoveryAbsentState.organizationIdentityResolutions.filter((item) =>
        item.rawRecordId === recoveryAbsentLoserRaw.record.id
      ).length,
      1
    );

    stage = "named duplicate cross team non leakage";
    const crossTeamDuplicateLoserRaw = createRawFixture(
      "identity-duplicate-isolated-loser-team",
      "owner-a"
    );
    const crossTeamDuplicateWinnerRaw = createRawFixture(
      "identity-duplicate-isolated-winner-team",
      "owner-a"
    );
    await insertRawRecord(database, crossTeamDuplicateLoserRaw);
    await insertRawRecord(database, crossTeamDuplicateWinnerRaw);
    const crossTeamDuplicateClaims = [
      registration("DUPLICATE-CROSS-TEAM-100")
    ];
    const crossTeamDuplicateLoserInput = persistedInput(
      crossTeamDuplicateLoserRaw,
      crossTeamDuplicateClaims
    );
    const crossTeamDuplicateWinnerInput = persistedInput(
      crossTeamDuplicateWinnerRaw,
      crossTeamDuplicateClaims
    );
    let crossTeamDuplicateWinnerSnapshot:
      Awaited<ReturnType<typeof databaseIdentityFactSnapshot>> | null = null;
    const crossTeamDuplicateRace = namedDuplicateRacePool(pool, {
      table: "organization_accepted_identifiers",
      key: "organization_accepted_identifiers.uk_oi_identifier_lookup",
      async afterRollback() {
        await resolveOrganizationStrongIdentityMysql(
          pool,
          namedDuplicateStore,
          crossTeamDuplicateWinnerInput
        );
        crossTeamDuplicateWinnerSnapshot =
          await databaseIdentityFactSnapshot(database);
      }
    });
    await assert.rejects(
      resolveOrganizationStrongIdentityMysql(
        crossTeamDuplicateRace.pool,
        namedDuplicateStore,
        crossTeamDuplicateLoserInput
      ),
      isIdentityError("IDENTITY_DATA_INTEGRITY_VIOLATION")
    );
    assert.equal(crossTeamDuplicateRace.state.duplicateInjected, true);
    assert.equal(crossTeamDuplicateRace.state.winnerCommitted, true);
    assert.ok(crossTeamDuplicateWinnerSnapshot);
    assert.deepEqual(
      await databaseIdentityFactSnapshot(database),
      crossTeamDuplicateWinnerSnapshot
    );
    assert.equal(
      namedDuplicateStore.organizations.some((item) =>
        item.teamId === crossTeamDuplicateLoserRaw.teamId
      ),
      false
    );
    assert.equal(
      namedDuplicateStore.organizations.some((item) =>
        item.teamId === crossTeamDuplicateWinnerRaw.teamId
      ),
      true
    );

    stage = "unknown commit before persistence retries frozen command";
    const absentCommitRaw = createRawFixture(
      "identity-absent-commit-team",
      "owner-a"
    );
    await insertRawRecord(database, absentCommitRaw);
    const absentCommitInput = persistedInput(
      absentCommitRaw,
      [registration("ABSENT-COMMIT-100")]
    );
    let absentCommitFaultInjected = false;
    let absentCommitDestroyCalls = 0;
    const absentCommitPool = instrumentPool(pool, {
      connection: {
        async commit(proceed) {
          if (!absentCommitFaultInjected) {
            absentCommitFaultInjected = true;
            absentCommitInput.claims[0]!.value =
              "ABSENT-COMMIT-MUTATED-100";
            absentCommitInput.claims[0]!.normalizedValue =
              "ABSENT-COMMIT-MUTATED-100";
            throw new Error("forced commit failure before persistence");
          }
          await proceed();
        },
        destroy() {
          absentCommitDestroyCalls += 1;
        }
      }
    });
    const absentCommitResult =
      await resolveOrganizationStrongIdentityMysql(
        absentCommitPool,
        concurrentColdStore,
        absentCommitInput
      );
    assert.equal(absentCommitFaultInjected, true);
    assert.equal(absentCommitDestroyCalls, 1);
    assert.equal(absentCommitResult.idempotent, false);
    assert.equal(absentCommitResult.resolution.result, "new_entity");
    const absentCommitState = await loadOrganizationIdentityState(
      pool,
      undefined,
      absentCommitRaw.teamId
    );
    assert.equal(
      absentCommitState.organizationAcceptedIdentifiers[0]?.normalizedValue,
      "ABSENT-COMMIT-100"
    );
    assert.equal(
      absentCommitState.organizationIdentityResolutions.length,
      1
    );

    stage = "unknown commit after persistence recovers frozen command";
    const unknownCommitRaw = createRawFixture(
      "identity-unknown-commit-team",
      "owner-a"
    );
    await insertRawRecord(database, unknownCommitRaw);
    const unknownCommitInput = persistedInput(
      unknownCommitRaw,
      [registration("UNKNOWN-COMMIT-100")]
    );
    let commitFaultInjected = false;
    let unknownCommitDestroyCalls = 0;
    const unknownCommitPool = instrumentPool(pool, {
      connection: {
        async commit(proceed) {
          await proceed();
          if (!commitFaultInjected) {
            commitFaultInjected = true;
            unknownCommitInput.claims[0]!.value =
              "UNKNOWN-COMMIT-MUTATED-100";
            unknownCommitInput.claims[0]!.normalizedValue =
              "UNKNOWN-COMMIT-MUTATED-100";
            throw new Error("forced unknown commit outcome");
          }
        },
        destroy() {
          unknownCommitDestroyCalls += 1;
        }
      }
    });
    const recovered = await resolveOrganizationStrongIdentityMysql(
      unknownCommitPool,
      concurrentColdStore,
      unknownCommitInput
    );
    assert.equal(commitFaultInjected, true);
    assert.equal(unknownCommitDestroyCalls, 1);
    assert.equal(recovered.idempotent, true);
    assert.equal(recovered.resolution.result, "new_entity");
    const recoveredState = await loadOrganizationIdentityState(
      pool,
      undefined,
      unknownCommitRaw.teamId
    );
    assert.equal(
      recoveredState.organizationAcceptedIdentifiers[0]?.normalizedValue,
      "UNKNOWN-COMMIT-100"
    );

    stage = "guard version rejects stale cache refresh";
    const cacheVersionRawA = createRawFixture(
      "identity-cache-version-team",
      "owner-a"
    );
    const cacheVersionRawB = createRawFixture(
      "identity-cache-version-team",
      "owner-b"
    );
    await insertRawRecord(database, cacheVersionRawA);
    await insertRawRecord(database, cacheVersionRawB);
    const cacheVersionStore = await createMysqlStore();
    let cacheCommitOrdinal = 0;
    let newerRefreshCompleted = false;
    const cacheVersionPool = instrumentPool(pool, {
      connection: {
        async commit(proceed) {
          cacheCommitOrdinal += 1;
          await proceed();
          if (cacheCommitOrdinal === 2) {
            const newer = await resolveOrganizationStrongIdentityMysql(
              pool,
              cacheVersionStore,
              persistedInput(
                cacheVersionRawB,
                [registration("CACHE-VERSION-B-100")]
              )
            );
            assert.equal(newer.resolution.result, "new_entity");
            newerRefreshCompleted = true;
          }
        }
      }
    });
    const older = await resolveOrganizationStrongIdentityMysql(
      cacheVersionPool,
      cacheVersionStore,
      persistedInput(
        cacheVersionRawA,
        [registration("CACHE-VERSION-A-100")]
      )
    );
    assert.equal(older.resolution.result, "new_entity");
    assert.equal(newerRefreshCompleted, true);
    assert.equal(
      cacheVersionStore.organizations.filter(
        (item) => item.teamId === cacheVersionRawA.teamId
      ).length,
      2
    );
    assert.equal(
      cacheVersionStore.organizationIdentityResolutions.filter(
        (item) => item.teamId === cacheVersionRawA.teamId
      ).length,
      2
    );

    stage = "cache refresh transient failure retries before success";
    const refreshRaw = createRawFixture(
      "identity-refresh-failure-team",
      "owner-a"
    );
    await insertRawRecord(database, refreshRaw);
    let committed = false;
    let refreshFaultInjected = false;
    const refreshFailurePool = instrumentPool(pool, {
      connection: {
        beforeQuery(sql) {
          if (committed
            && !refreshFaultInjected
            && sql.includes("prospect_source_raw_records")) {
            refreshFaultInjected = true;
            throw new Error("forced cache refresh failure");
          }
        },
        async commit(proceed) {
          await proceed();
          committed = true;
        }
      }
    });
    const refreshResult = await resolveOrganizationStrongIdentityMysql(
      refreshFailurePool,
      concurrentColdStore,
      persistedInput(refreshRaw, [registration("REFRESH-100")])
    );
    assert.equal(refreshResult.resolution.result, "new_entity");
    assert.equal(refreshFaultInjected, true);
    assert.equal(
      concurrentColdStore.organizations.some(
        (item) => item.teamId === refreshRaw.teamId
      ),
      true
    );
    assert.equal(
      concurrentColdStore.organizationIdentityResolutions.filter(
        (item) => item.teamId === refreshRaw.teamId
      ).length,
      1
    );

    stage = "cache unavailable preserves snapshot and idempotent retry";
    const persistentRefreshStore = await createMysqlStore();
    const persistentRefreshRawA = createRawFixture(
      "identity-refresh-persistent-team",
      "owner-a"
    );
    const persistentRefreshRawB = createRawFixture(
      "identity-refresh-persistent-team",
      "owner-b"
    );
    await insertRawRecord(database, persistentRefreshRawA);
    await insertRawRecord(database, persistentRefreshRawB);
    await resolveOrganizationStrongIdentityMysql(
      pool,
      persistentRefreshStore,
      persistedInput(
        persistentRefreshRawA,
        [registration("REFRESH-PERSISTENT-100")]
      )
    );
    assert.equal(
      persistentRefreshStore.organizations.filter(
        (item) => item.teamId === persistentRefreshRawA.teamId
      ).length,
      1
    );
    let persistentRefreshCommitted = false;
    let persistentRefreshFailures = 0;
    const persistentRefreshPool = instrumentPool(pool, {
      connection: {
        beforeQuery(sql) {
          if (persistentRefreshCommitted
            && sql.includes("prospect_source_raw_records")) {
            persistentRefreshFailures += 1;
            throw new Error("forced persistent cache refresh failure");
          }
        },
        async commit(proceed) {
          await proceed();
          persistentRefreshCommitted = true;
        }
      }
    });
    const persistentRefreshInput = persistedInput(
      persistentRefreshRawB,
      [registration("REFRESH-PERSISTENT-200")]
    );
    await assert.rejects(
      resolveOrganizationStrongIdentityMysql(
        persistentRefreshPool,
        persistentRefreshStore,
        persistentRefreshInput
      ),
      isIdentityError("IDENTITY_CACHE_UNAVAILABLE")
    );
    assert.equal(persistentRefreshFailures, 2);
    assert.equal(
      persistentRefreshStore.organizations.filter(
        (item) => item.teamId === persistentRefreshRawA.teamId
      ).length,
      1
    );
    const persistentDatabaseState = await loadOrganizationIdentityState(
      pool,
      undefined,
      persistentRefreshRawA.teamId
    );
    assert.equal(persistentDatabaseState.organizations.length, 2);
    assert.deepEqual(
      new Set(
        persistentDatabaseState.organizationIdentityClaims.map(
          (item) => item.ownerId
        )
      ),
      new Set(["owner-a", "owner-b"])
    );
    const persistentRefreshRetry =
      await resolveOrganizationStrongIdentityMysql(
        pool,
        persistentRefreshStore,
        persistentRefreshInput
      );
    assert.equal(persistentRefreshRetry.idempotent, true);
    assert.equal(
      persistentRefreshStore.organizations.filter(
        (item) => item.teamId === persistentRefreshRawA.teamId
      ).length,
      2
    );
    assert.equal(
      (await loadOrganizationIdentityState(
        pool,
        undefined,
        persistentRefreshRawA.teamId
      )).organizations.length,
      2
    );

    stage = "persistAll identity zero write";
    const identityBeforePersist = await databaseIdentitySnapshot(database);
    const persistStore = await createMysqlStore();
    persistStore.organizations.splice(0);
    persistStore.organizationIdentityClaims.splice(0);
    persistStore.organizationAcceptedIdentifiers.splice(0);
    persistStore.organizationIdentityResolutions.splice(0);
    persistStore.organizationSourceBindings.splice(0);
    persistStore.organizationIdentityConflicts.splice(0);
    persistStore.organizationIdentityEvents.splice(0);
    await persistStore.persist();
    assert.deepEqual(
      await databaseIdentitySnapshot(database),
      identityBeforePersist
    );

    stage = "business arrays remain unchanged";
    assert.deepEqual(
      snapshotBusinessArrays(primaryStore),
      businessBefore
    );

    await database.end();
    await pool.end();
    console.log(
      "Organization Identity MySQL schema, persistence, isolation, "
      + "replay, conflict, tamper, retry and cache tests passed"
    );
    exitCode = 0;
  } catch (error) {
    console.error(`Organization Identity MySQL test failed at: ${stage}`);
    console.error(error);
  } finally {
    if (databaseCreated) {
      if (grantedAccount) {
        const separator = grantedAccount.lastIndexOf("@");
        const accountUser = grantedAccount.slice(0, separator);
        const accountHost = grantedAccount.slice(separator + 1);
        await admin.query(
          `REVOKE ALL PRIVILEGES ON \`${databaseName}\`.* FROM ${
            sqlString(accountUser)
          }@${sqlString(accountHost)}`
        ).catch(() => undefined);
      }
      await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    }
    await admin.end();
    process.exit(exitCode);
  }
}

await main();
