import type { Pool } from "mysql2/promise";

// ---------------------------------------------------------------------------
// 服务器级 KV 设置（app_settings）：存放「运行时可调」的部署配置，
// 当前用于邮件已读追踪的公网地址（EMAIL_TRACKING_BASE_URL 的运行时覆盖）。
// 独立小表 + 模块级仓库（不进 persistAll 全表重写体系）。
// ---------------------------------------------------------------------------

let poolRef: Pool | null = null;

export function ensureAppSettingsSchema(pool: Pool) {
  return pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    setting_key VARCHAR(120) PRIMARY KEY,
    setting_value TEXT NOT NULL,
    updated_at DATETIME(3) NOT NULL
  )`);
}

export function setAppSettingsPool(pool: Pool | null) {
  poolRef = pool;
}

export async function getAppSetting(key: string): Promise<string> {
  if (!poolRef) return "";
  try {
    const [rows] = await poolRef.query(
      "SELECT setting_value FROM app_settings WHERE setting_key = ?",
      [key]
    );
    const row = (rows as Record<string, unknown>[])[0];
    return row ? String(row.setting_value || "") : "";
  } catch {
    // 表不存在或读库失败：按未设置处理，调用方回落 env
    return "";
  }
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  if (!poolRef) throw new Error("应用设置仓库未初始化");
  await poolRef.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at) VALUES (?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW(3)`,
    [key, value]
  );
}

export const EMAIL_TRACKING_BASE_URL_KEY = "email_tracking_base_url";
