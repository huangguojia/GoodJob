import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "../config.js";

export interface QueryResult<Row> {
  rows: Row[];
}

export interface DatabaseTransaction {
  readonly kind: "pglite" | "postgres";
  query<Row>(text: string, params?: unknown[]): Promise<QueryResult<Row>>;
  exec(text: string): Promise<void>;
}

export interface Database extends DatabaseTransaction {
  transaction<Result>(callback: (transaction: DatabaseTransaction) => Promise<Result>): Promise<Result>;
  close(): Promise<void>;
}

class PgliteDatabase implements Database {
  readonly kind = "pglite" as const;

  constructor(private readonly client: PGlite) {}

  async ready(): Promise<void> {
    await this.client.waitReady;
  }

  async query<Row>(text: string, params: unknown[] = []): Promise<QueryResult<Row>> {
    const result = await this.client.query<Row>(text, params);
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
          const result = await client.query<Row>(text, params);
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

  constructor(private readonly pool: pg.Pool) {}

  async query<Row>(text: string, params: unknown[] = []): Promise<QueryResult<Row>> {
    const result = await this.pool.query(text, params);
    return { rows: result.rows as Row[] };
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
          const queryResult = await client.query(text, params);
          return { rows: queryResult.rows as Row[] };
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

export async function createDatabase(config: AppConfig): Promise<Database> {
  if (config.databaseClient === "postgres") {
    return new PostgresDatabase(new pg.Pool({ connectionString: config.databaseUrl }));
  }

  await mkdir(path.dirname(config.pglitePath), { recursive: true });
  const database = new PgliteDatabase(new PGlite(config.pglitePath));
  await database.ready();
  return database;
}
