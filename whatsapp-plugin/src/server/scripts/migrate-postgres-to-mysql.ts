import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import type { AppConfig } from "../config.js";
import { communicationTables, type CommunicationTable } from "../db/communication-tables.js";
import { createDatabase, databaseTimestamp, type Database, type DatabaseTransaction } from "../db/database.js";
import { migrate } from "../db/migrate.js";

type Row = Record<string, unknown>;

interface TableSummary {
  table: string;
  rows: number;
  primaryKeyHash: string;
  contentHash: string;
}

interface MigrationOptions {
  sourceUrl: string;
  targetUrl: string;
  apply: boolean;
  resumeCompleted?: boolean;
  batchSize?: number;
  onProgress?: (message: string) => void;
}

export interface CommunicationSourceReader {
  query<ResultRow extends Row>(text: string, params?: unknown[]): Promise<{ rows: ResultRow[] }>;
}

interface SnapshotOptions {
  apply: boolean;
  resumeCompleted?: boolean;
  batchSize?: number;
  onProgress?: (message: string) => void;
}

const migrationId = "postgres-to-mysql-v1";

function quote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
  return `\`${identifier}\``;
}

function sourceQuote(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) throw new Error(`Unsafe SQL identifier: ${identifier}`);
  return `"${identifier}"`;
}

function normalizeTemporal(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const isoLike = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const parsed = new Date(isoLike);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid temporal database value: ${text}`);
  return parsed.toISOString();
}

function canonicalValue(value: unknown, temporal: boolean): unknown {
  if (value === null || value === undefined) return null;
  if (temporal) return normalizeTemporal(value);
  if (Buffer.isBuffer(value)) return { base64: value.toString("base64") };
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return String(value);
}

function mysqlValue(value: unknown, temporal: boolean): unknown {
  const normalized = temporal ? normalizeTemporal(value) : value;
  if (typeof normalized === "string" && temporal) return normalized.replace("T", " ").replace(/Z$/u, "");
  return normalized ?? null;
}

function updateHashes(
  row: Row,
  table: CommunicationTable,
  primaryKeyHash: ReturnType<typeof createHash>,
  contentHash: ReturnType<typeof createHash>
): void {
  const temporal = new Set(table.temporalColumns);
  const primaryKey = table.primaryKey.map((column) => canonicalValue(row[column], temporal.has(column)));
  const content = table.columns.map((column) => canonicalValue(row[column], temporal.has(column)));
  primaryKeyHash.update(`${JSON.stringify(primaryKey)}\n`);
  contentHash.update(`${JSON.stringify(content)}\n`);
}

function pageSql(table: CommunicationTable, mysql: boolean, hasCursor: boolean): string {
  const q = mysql ? quote : sourceQuote;
  const columns = table.columns.map(q).join(",");
  const keys = table.primaryKey
    .map((column) => mysql ? q(column) : `${q(column)} COLLATE "C"`)
    .join(",");
  const cursor = hasCursor
    ? ` WHERE (${keys}) > (${table.primaryKey.map((_, index) => `$${index + 1}`).join(",")})`
    : "";
  return `SELECT ${columns} FROM ${q(table.name)}${cursor} ORDER BY ${keys} LIMIT ${hasCursor ? `$${table.primaryKey.length + 1}` : "$1"}`;
}

async function sourcePage(
  client: CommunicationSourceReader,
  table: CommunicationTable,
  cursor: unknown[] | null,
  batchSize: number
): Promise<Row[]> {
  const params = cursor ? [...cursor, batchSize] : [batchSize];
  return (await client.query<Row>(pageSql(table, false, Boolean(cursor)), params)).rows;
}

async function targetPage(
  database: DatabaseTransaction,
  table: CommunicationTable,
  cursor: unknown[] | null,
  batchSize: number
): Promise<Row[]> {
  const params = cursor ? [...cursor, batchSize] : [batchSize];
  return (await database.query<Row>(pageSql(table, true, Boolean(cursor)), params)).rows;
}

async function summarize(
  table: CommunicationTable,
  nextPage: (cursor: unknown[] | null) => Promise<Row[]>
): Promise<TableSummary> {
  const primaryKeyHash = createHash("sha256");
  const contentHash = createHash("sha256");
  let rows = 0;
  let cursor: unknown[] | null = null;
  while (true) {
    const page = await nextPage(cursor);
    if (page.length === 0) break;
    for (const row of page) updateHashes(row, table, primaryKeyHash, contentHash);
    rows += page.length;
    const last = page.at(-1)!;
    cursor = table.primaryKey.map((column) => last[column]);
  }
  return { table: table.name, rows, primaryKeyHash: primaryKeyHash.digest("hex"), contentHash: contentHash.digest("hex") };
}

async function upsertPage(database: DatabaseTransaction, table: CommunicationTable, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = table.columns.map(quote);
  const params: unknown[] = [];
  const temporal = new Set(table.temporalColumns);
  const valuesSql = rows.map((row) => {
    const placeholders = table.columns.map((column) => {
      params.push(mysqlValue(row[column], temporal.has(column)));
      return `$${params.length}`;
    });
    return `(${placeholders.join(",")})`;
  });
  const primaryKeys = new Set(table.primaryKey);
  const updates = table.columns
    .filter((column) => !primaryKeys.has(column))
    .map((column) => `${quote(column)}=VALUES(${quote(column)})`)
    .join(",");
  await database.query(
    `INSERT INTO ${quote(table.name)} (${columns.join(",")}) VALUES ${valuesSql.join(",")}
     ON DUPLICATE KEY UPDATE ${updates}`,
    params
  );
}

function assertMatching(source: TableSummary, target: TableSummary): void {
  if (
    source.rows !== target.rows ||
    source.primaryKeyHash !== target.primaryKeyHash ||
    source.contentHash !== target.contentHash
  ) {
    throw new Error(
      `Verification failed for ${source.table}: source=${source.rows}/${source.primaryKeyHash}/${source.contentHash}, ` +
      `target=${target.rows}/${target.primaryKeyHash}/${target.contentHash}`
    );
  }
}

const orphanChecks = [
  ["provider_session_keys.account_id", "SELECT COUNT(*) AS count FROM provider_session_keys c LEFT JOIN channel_accounts p ON p.id=c.account_id WHERE p.id IS NULL"],
  ["contacts.account_id", "SELECT COUNT(*) AS count FROM contacts c LEFT JOIN channel_accounts p ON p.id=c.account_id WHERE p.id IS NULL"],
  ["conversations.account_id", "SELECT COUNT(*) AS count FROM conversations c LEFT JOIN channel_accounts p ON p.id=c.account_id WHERE p.id IS NULL"],
  ["conversations.contact_id", "SELECT COUNT(*) AS count FROM conversations c LEFT JOIN contacts p ON p.id=c.contact_id WHERE p.id IS NULL"],
  ["messages.account_id", "SELECT COUNT(*) AS count FROM messages c LEFT JOIN channel_accounts p ON p.id=c.account_id WHERE p.id IS NULL"],
  ["messages.conversation_id", "SELECT COUNT(*) AS count FROM messages c LEFT JOIN conversations p ON p.id=c.conversation_id WHERE p.id IS NULL"],
  ["translations.message_id", "SELECT COUNT(*) AS count FROM translations c LEFT JOIN messages p ON p.id=c.message_id WHERE p.id IS NULL"],
  ["translations.profile_id", "SELECT COUNT(*) AS count FROM translations c LEFT JOIN ai_provider_profiles p ON p.id=c.profile_id WHERE p.id IS NULL"],
  ["meta_account_credentials.account_id", "SELECT COUNT(*) AS count FROM meta_account_credentials c LEFT JOIN channel_accounts p ON p.id=c.account_id WHERE p.id IS NULL"],
  ["meta_account_credentials.app_config_id", "SELECT COUNT(*) AS count FROM meta_account_credentials c LEFT JOIN meta_app_configs p ON p.id=c.app_config_id WHERE p.id IS NULL"]
] as const;

async function verifyRelationships(database: DatabaseTransaction): Promise<void> {
  for (const [relation, sql] of orphanChecks) {
    const result = await database.query<{ count: number | string }>(sql);
    if (Number(result.rows[0]?.count ?? 0) !== 0) throw new Error(`Orphaned relation detected: ${relation}`);
  }
}

function targetConfig(targetUrl: string): AppConfig {
  return {
    nodeEnv: "test",
    port: 0,
    webOrigin: "http://127.0.0.1",
    databaseClient: "mysql",
    databaseUrl: targetUrl,
    pglitePath: ".data/migration-unused",
    seedDemo: false,
    allowPrivateAiEndpoints: false
  };
}

export async function prepareMysqlCommunicationTarget(target: Database): Promise<void> {
  await migrate(target);
  await target.exec(`CREATE TABLE IF NOT EXISTS communication_data_migrations (
    id VARCHAR(191) PRIMARY KEY,
    source_fingerprint VARCHAR(64) NOT NULL,
    completed_at DATETIME(3) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
}

export async function migrateCommunicationSnapshot(
  source: CommunicationSourceReader,
  target: Database,
  options: SnapshotOptions
): Promise<TableSummary[]> {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 2_000) {
    throw new Error("batchSize must be an integer between 1 and 2000");
  }

  return target.transaction(async (transaction) => {
    const completed = await transaction.query<{ source_fingerprint: string }>(
      "SELECT source_fingerprint FROM communication_data_migrations WHERE id=$1 FOR UPDATE",
      [migrationId]
    );
    if (options.apply && completed.rows[0] && !options.resumeCompleted) {
      throw new Error("PostgreSQL to MySQL migration is already complete; use verify-only mode after cutover");
    }
    const shouldWrite = options.apply && !completed.rows[0];

    const sourceSummaries: TableSummary[] = [];
    for (const table of communicationTables) {
      const primaryKeyHash = createHash("sha256");
      const contentHash = createHash("sha256");
      let rows = 0;
      let cursor: unknown[] | null = null;
      while (true) {
        const page = await sourcePage(source, table, cursor, batchSize);
        if (page.length === 0) break;
        for (const row of page) updateHashes(row, table, primaryKeyHash, contentHash);
        if (shouldWrite) await upsertPage(transaction, table, page);
        rows += page.length;
        const last = page.at(-1)!;
        cursor = table.primaryKey.map((column) => last[column]);
      }
      const summary = {
        table: table.name,
        rows,
        primaryKeyHash: primaryKeyHash.digest("hex"),
        contentHash: contentHash.digest("hex")
      };
      sourceSummaries.push(summary);
      options.onProgress?.(`${options.apply ? "migrated" : "read"} ${table.name}: ${rows}`);
    }

    for (const table of communicationTables) {
      const summary = await summarize(table, (cursor) => targetPage(transaction, table, cursor, batchSize));
      assertMatching(sourceSummaries.find((item) => item.table === table.name)!, summary);
      options.onProgress?.(`verified ${table.name}: ${summary.rows}`);
    }
    await verifyRelationships(transaction);

    const fingerprint = createHash("sha256").update(JSON.stringify(sourceSummaries)).digest("hex");
    if (completed.rows[0]) {
      if (completed.rows[0].source_fingerprint !== fingerprint) {
        throw new Error("Current PostgreSQL snapshot does not match the fingerprint recorded at cutover");
      }
      if (options.apply) options.onProgress?.("completed cutover re-verified; no data was rewritten");
    } else if (options.apply) {
      await transaction.query(
        "INSERT INTO communication_data_migrations(id,source_fingerprint,completed_at) VALUES($1,$2,$3)",
        [migrationId, fingerprint, databaseTimestamp(new Date())]
      );
    }
    options.onProgress?.(`relationship checks passed; source fingerprint ${fingerprint}`);
    return sourceSummaries;
  });
}

export async function migratePostgresToMysql(options: MigrationOptions): Promise<TableSummary[]> {
  const batchSize = options.batchSize ?? 500;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 2_000) {
    throw new Error("batchSize must be an integer between 1 and 2000");
  }
  if (!options.sourceUrl.startsWith("postgresql://") && !options.sourceUrl.startsWith("postgres://")) {
    throw new Error("SOURCE_DATABASE_URL must be a PostgreSQL URL");
  }
  if (!options.targetUrl.startsWith("mysql://")) throw new Error("DATABASE_URL must be a MySQL URL");

  const sourcePool = new pg.Pool({ connectionString: options.sourceUrl, max: 1 });
  const source = await sourcePool.connect();
  const target: Database = await createDatabase(targetConfig(options.targetUrl));
  try {
    await prepareMysqlCommunicationTarget(target);
    await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const sourceVersions = await source.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");
    if (sourceVersions.rows.map((row) => Number(row.version)).join(",") !== "1,2,3,4,5,6,7") {
      throw new Error("PostgreSQL source is not on Communication schema versions 1 through 7");
    }

    const sourceReader: CommunicationSourceReader = {
      query: async <ResultRow extends Row>(text: string, params: unknown[] = []) => {
        const result = await source.query(text, params);
        return { rows: result.rows as ResultRow[] };
      }
    };
    const result = await migrateCommunicationSnapshot(sourceReader, target, { ...options, batchSize });
    await source.query("COMMIT");
    return result;
  } catch (error) {
    await source.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    source.release();
    await sourcePool.end();
    await target.close();
  }
}

async function main(): Promise<void> {
  const sourceUrl = process.env.SOURCE_DATABASE_URL?.trim();
  const targetUrl = process.env.DATABASE_URL?.trim();
  if (!sourceUrl || !targetUrl) {
    throw new Error("SOURCE_DATABASE_URL and DATABASE_URL are required");
  }
  const apply = process.argv.includes("--apply");
  const resumeCompleted = process.argv.includes("--resume-completed");
  const unknown = process.argv.slice(2).filter(
    (argument) => argument !== "--apply" && argument !== "--verify-only" && argument !== "--resume-completed"
  );
  if (
    unknown.length > 0 ||
    (process.argv.includes("--apply") && process.argv.includes("--verify-only")) ||
    (resumeCompleted && !apply)
  ) {
    throw new Error("Usage: migrate-postgres-to-mysql [--apply [--resume-completed]|--verify-only]");
  }
  await migratePostgresToMysql({
    sourceUrl,
    targetUrl,
    apply,
    resumeCompleted,
    onProgress: (message) => process.stdout.write(`${message}\n`)
  });
  process.stdout.write(`${apply ? "Migration and verification" : "Verification"} completed successfully\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
