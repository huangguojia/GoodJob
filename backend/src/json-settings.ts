import { getAppSetting, setAppSetting } from "./app-settings.js";

/**
 * 结构化设置（JSON）读写：MySQL 档位存 app_settings；内存档位（开发 / 测试）存进程内。
 * 敏感字段由调用方先用 encryptSecretValue 加密再放进来，这里只负责序列化。
 */
const memory = new Map<string, string>();

function usesMemory() {
  return process.env.CRM_STORE === "memory" || !process.env.DATABASE_URL && !process.env.MYSQL_URL;
}

export async function readJsonSetting<T>(key: string, fallback: T): Promise<T> {
  let raw = "";
  if (usesMemory()) raw = memory.get(key) || "";
  else {
    raw = await getAppSetting(key);
    if (!raw) raw = memory.get(key) || "";
  }
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonSetting(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  if (usesMemory()) {
    memory.set(key, raw);
    return;
  }
  try {
    await setAppSetting(key, raw);
  } catch {
    // 应用设置表还没初始化（极早期启动）时先放内存，不丢本次写入
    memory.set(key, raw);
  }
}
