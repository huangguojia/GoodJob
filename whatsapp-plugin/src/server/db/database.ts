import type { PGlite as PGliteClient } from "@electric-sql/pglite";
import mysql, { type Pool as MysqlPool, type PoolConnection, type ResultSetHeader } from "mysql2/promise";
import type { Pool as PostgresPool } from "pg";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";

export interface QueryResult<Row> {
  rows: Row[];
  affectedRows?: number;
}

interface DatabaseTimestampParameter {
  readonly kind: "database-timestamp";
  readonly iso: string;
}

export function databaseTimestamp(value: string | Date): DatabaseTimestampParameter {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid database timestamp: ${String(value)}`);
  return { kind: "database-timestamp", iso: date.toISOString() };
}

function isDatabaseTimestamp(value: unknown): value is DatabaseTimestampParameter {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as Partial<DatabaseTimestampParameter>).kind === "database-timestamp" &&
    typeof (value as Partial<DatabaseTimestampParameter>).iso === "string"
  );
}

function postgresParams(params: unknown[]): unknown[] {
  return params.map((value) => isDatabaseTimestamp(value) ? value.iso : value);
}

function mysqlParam(value: unknown): unknown {
  return isDatabaseTimestamp(value) ? value.iso.replace("T", " ").replace(/Z$/u, "") : value;
}

export interface DatabaseTransaction {
  readonly kind: "pglite" | "postgres" | "mysql";
  query<Row>(text: string, params?: unknown[]): Promise<QueryResult<Row>>;
  exec(text: string): Promise<void>;
}

export interface Database extends DatabaseTransaction {
  transaction<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}

class PgliteDatabase implements Database {
  readonly kind = "pglite" as const;

  constructor(private readonly client: PGliteClient) {}

  async ready(): Promise<void> {
    await this.client.waitReady;
  }

  async query<Row>(text: string, params: unknown[] = []): Promise<QueryResult<Row>> {
    const result = await this.client.query<Row>(text, postgresParams(params));
    return { rows: result.rows };
  }

  async exec(text: string): Promise<void> {
    await this.client.exec(text);
  }

  async transaction<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result> {
    return this.client.transaction(async (client) =>
      callback({
        kind: this.kind,
        query: async <Row>(text: string, params: unknown[] = []): Promise<QueryResult<Row>> => {
          const result = await client.query<Row>(text, postgresParams(params));
          return { rows: result.rows };
        },
        exec: async (text: string): Promise<void> => {
          await client.exec(text);
        }
      })
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

class PostgresDatabase implements Database {
  readonly kind = "postgres" as const;

  constructor(private readonly pool: PostgresPool) {}

  async query<Row>(text: string, params: unknown[] = []): Promise<QueryResult<Row>> {
    const result = await this.pool.query(text, postgresParams(params));
    return { rows: result.rows as Row[], affectedRows: result.rowCount ?? undefined };
  }

  async exec(text: string): Promise<void> {
    await this.pool.query(text);
  }

  async transaction<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback({
        kind: this.kind,
        query: async <Row>(text: string, params: unknown[] = []): Promise<QueryResult<Row>> => {
          const queryResult = await client.query(text, postgresParams(params));
          return { rows: queryResult.rows as Row[], affectedRows: queryResult.rowCount ?? undefined };
        },
        exec: async (text: string): Promise<void> => {
          await client.query(text);
        }
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

interface MysqlQuery {
  text: string;
  params: unknown[];
}

export function compileMysqlQuery(text: string, params: unknown[] = []): MysqlQuery {
  const compiledParams: unknown[] = [];
  const compiledText = text
    .replace(/\$(\d+)(?:::[A-Za-z_][A-Za-z0-9_]*)?/gu, (_match, rawIndex: string) => {
      const index = Number(rawIndex) - 1;
      if (index < 0 || index >= params.length) {
        throw new Error(`Missing SQL parameter $${rawIndex}`);
      }
      compiledParams.push(mysqlParam(params[index]));
      return "?";
    })
    .replace(/::(?:text|integer|int|bigint)\b/giu, "")
    .replace(/\s+NULLS\s+LAST\b/giu, "");
  return { text: compiledText, params: compiledParams };
}

function mysqlRows<Row>(result: unknown): QueryResult<Row> {
  if (Array.isArray(result)) return { rows: result as Row[] };
  const header = result as ResultSetHeader;
  return { rows: [], affectedRows: header.affectedRows };
}

async function mysqlQuery<Row>(client: MysqlPool | PoolConnection, text: string, params: unknown[]): Promise<QueryResult<Row>> {
  const compiled = compileMysqlQuery(text, params);
  const [result] = await client.query(compiled.text, compiled.params);
  return mysqlRows<Row>(result);
}

class MysqlDatabase implements Database {
  readonly kind = "mysql" as const;

  constructor(private readonly pool: MysqlPool) {}

  async query<Row>(text: string, params: unknown[] = []): Promise<QueryResult<Row>> {
    return mysqlQuery<Row>(this.pool, text, params);
  }

  async exec(text: string): Promise<void> {
    await this.pool.query(text);
  }

  async transaction<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback({
        kind: this.kind,
        query: <Row>(text: string, params: unknown[] = []) => mysqlQuery<Row>(connection, text, params),
        exec: async (text: string): Promise<void> => {
          await connection.query(text);
        }
      });
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function createMysqlPool(databaseUrl: string): MysqlPool {
  const url = new URL(databaseUrl);
  if (url.protocol !== "mysql:") throw new Error("DATABASE_URL must use the mysql protocol");
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!database) throw new Error("DATABASE_URL must include a MySQL database name");
  const sslMode = url.searchParams.get("ssl-mode")?.toUpperCase();
  return mysql.createPool({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: "utf8mb4",
    timezone: "Z",
    dateStrings: true,
    typeCast: (field, next) => {
      if (field.type === "DATETIME" || field.type === "TIMESTAMP") {
        const value = field.string();
        return value ? new Date(`${value.replace(" ", "T")}Z`).toISOString() : null;
      }
      return next();
    },
    supportBigNumbers: true,
    bigNumberStrings: true,
    ssl: sslMode && sslMode !== "DISABLED" ? {} : undefined
  });
}

export async function createDatabase(config: AppConfig): Promise<Database> {
  if (config.databaseClient === "mysql") {
    return new MysqlDatabase(createMysqlPool(config.databaseUrl!));
  }
  if (config.databaseClient === "postgres") {
    const pg = (await import("pg")).default;
    return new PostgresDatabase(new pg.Pool({ connectionString: config.databaseUrl }));
  }

  await mkdir(path.dirname(config.pglitePath), { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const database = new PgliteDatabase(new PGlite(config.pglitePath));
  await database.ready();
  return database;
}
