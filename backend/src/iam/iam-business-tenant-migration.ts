import type mysql from "mysql2/promise";

const CORE_TENANT_TABLES = ["customers", "leads", "deals"] as const;

async function columnExists(pool: mysql.Pool, table: string, column: string) {
  const [rows] = await pool.query(`SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  return Number((rows as Array<{ count: number }>)[0]?.count || 0) > 0;
}

async function indexExists(pool: mysql.Pool, table: string, index: string) {
  const [rows] = await pool.query(`SELECT COUNT(*) AS count FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`, [table, index]);
  return Number((rows as Array<{ count: number }>)[0]?.count || 0) > 0;
}

export async function ensureIamBusinessTenantProjection(pool: mysql.Pool) {
  for (const table of CORE_TENANT_TABLES) {
    if (!await columnExists(pool, table, "tenant_id")) {
      await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN tenant_id VARCHAR(64) GENERATED ALWAYS AS (team_id) STORED AFTER team_id`);
    } else {
      const [columnRows] = await pool.query(`SELECT EXTRA FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'tenant_id'`, [table]);
      if (!String((columnRows as Array<{ EXTRA: string }>)[0]?.EXTRA || "").includes("STORED GENERATED")) {
        await pool.query(`ALTER TABLE \`${table}\` MODIFY COLUMN tenant_id VARCHAR(64) GENERATED ALWAYS AS (team_id) STORED`);
      }
    }
    if (!await indexExists(pool, table, `idx_${table}_tenant`)) {
      await pool.query(`ALTER TABLE \`${table}\` ADD INDEX \`idx_${table}_tenant\` (tenant_id)`);
    }
    // A generated column keeps the legacy team_id dual-write compatible without
    // requiring SUPER/TRIGGER privileges on managed MySQL services.
    const [invalidRows] = await pool.query(`SELECT COUNT(*) AS count FROM \`${table}\` b LEFT JOIN tenants t ON t.id = b.tenant_id WHERE b.tenant_id IS NULL OR b.tenant_id = '' OR t.id IS NULL`);
    const invalid = Number((invalidRows as Array<{ count: number }>)[0]?.count || 0);
    if (invalid) throw new Error(`${table} 存在 ${invalid} 条无效租户归属，已停止 IAM 数据边界迁移`);
  }
}
