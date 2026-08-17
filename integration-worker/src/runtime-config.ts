export interface IntegrationWorkerConfig {
  enabled: boolean;
  workerEnabled: boolean;
  host: "127.0.0.1";
  port: number;
  databaseUrl: string;
  redisUrl: string;
  credentialKeyConfigured: boolean;
  credentialKey: string;
  queueName: "goodjob:integration:tool-calls";
  controlQueueName: "goodjob:integration:control";
  eventQueueName: "goodjob:integration:events";
  globalConcurrency: number;
  connectionConcurrency: number;
  httpTimeoutMs: number;
  writeTimeoutMs: number;
  maxResponseBytes: number;
  artifactRetentionDays: number;
  webhookBaseUrl: string;
}

function flag(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

function boundedNumber(value: string | undefined, fallback: number, min: number, max: number, name: string) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 的整数`);
  }
  return parsed;
}

export function validateIntegrationRedisUrl(rawValue: string) {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("REDIS_URL 格式无效");
  }
  if (!new Set(["redis:", "rediss:"]).has(url.protocol)) {
    throw new Error("REDIS_URL 只允许 redis:// 或 rediss://");
  }
  if (!url.hostname) throw new Error("REDIS_URL 缺少主机名");
  if (url.search || url.hash) throw new Error("REDIS_URL 不能包含查询参数或片段");
  if (url.pathname && !/^\/(?:\d+)?$/u.test(url.pathname)) {
    throw new Error("REDIS_URL 路径只能指定 Redis 数据库编号");
  }
  const database = Number(url.pathname.slice(1) || 0);
  if (!Number.isInteger(database) || database < 0 || database > 15) {
    throw new Error("REDIS_URL 数据库编号必须在 0-15 之间");
  }
  return url;
}

export function loadIntegrationWorkerConfig(
  env: NodeJS.ProcessEnv = process.env
): IntegrationWorkerConfig {
  const enabled = flag(env.INTEGRATION_ENABLED);
  const workerEnabled = flag(env.INTEGRATION_WORKER_ENABLED);
  const databaseUrl = String(env.DATABASE_URL || env.MYSQL_URL || "").trim();
  const redisUrl = String(env.REDIS_URL || "").trim();
  const credentialKey = String(env.INTEGRATION_CREDENTIAL_KEY || "").trim();
  const webhookBaseUrl = String(env.INTEGRATION_WEBHOOK_BASE_URL || env.INTEGRATION_OAUTH_CALLBACK_BASE_URL || "").trim();

  if (enabled) {
    if (!workerEnabled) throw new Error("INTEGRATION_ENABLED=true 时必须启用 INTEGRATION_WORKER_ENABLED");
    if (!databaseUrl) throw new Error("集成平台启用时必须配置 DATABASE_URL 或 MYSQL_URL");
    if (!/^mysql:\/\//u.test(databaseUrl)) throw new Error("集成平台只允许 MySQL 持久化");
    if (!redisUrl) throw new Error("集成平台启用时必须配置 REDIS_URL");
    validateIntegrationRedisUrl(redisUrl);
    if (credentialKey.length < 32) throw new Error("INTEGRATION_CREDENTIAL_KEY 必须至少包含 32 个字符");
    if (env.INTEGRATION_MICROSOFT_CLIENT_ID && !webhookBaseUrl) {
      throw new Error("启用 Microsoft 365 时必须配置 INTEGRATION_WEBHOOK_BASE_URL");
    }
    if (webhookBaseUrl) {
      const webhookUrl = new URL(webhookBaseUrl);
      const loopback = ["127.0.0.1", "localhost", "::1"].includes(webhookUrl.hostname);
      if (webhookUrl.protocol !== "https:" && !(env.NODE_ENV !== "production" && webhookUrl.protocol === "http:" && loopback)) {
        throw new Error("INTEGRATION_WEBHOOK_BASE_URL 必须使用 HTTPS");
      }
    }
  } else if (workerEnabled) {
    throw new Error("不能在控制面关闭时单独启动 Integration Worker");
  }

  return {
    enabled,
    workerEnabled,
    host: "127.0.0.1",
    port: boundedNumber(env.INTEGRATION_WORKER_PORT, 4190, 1024, 65535, "INTEGRATION_WORKER_PORT"),
    databaseUrl,
    redisUrl,
    credentialKeyConfigured: credentialKey.length >= 32,
    credentialKey,
    queueName: "goodjob:integration:tool-calls",
    controlQueueName: "goodjob:integration:control",
    eventQueueName: "goodjob:integration:events",
    globalConcurrency: boundedNumber(env.INTEGRATION_GLOBAL_CONCURRENCY, 10, 1, 100, "INTEGRATION_GLOBAL_CONCURRENCY"),
    connectionConcurrency: boundedNumber(env.INTEGRATION_CONNECTION_CONCURRENCY, 2, 1, 20, "INTEGRATION_CONNECTION_CONCURRENCY"),
    httpTimeoutMs: boundedNumber(env.INTEGRATION_HTTP_TIMEOUT_MS, 15_000, 1_000, 120_000, "INTEGRATION_HTTP_TIMEOUT_MS"),
    writeTimeoutMs: boundedNumber(env.INTEGRATION_WRITE_TIMEOUT_MS, 30_000, 1_000, 180_000, "INTEGRATION_WRITE_TIMEOUT_MS"),
    maxResponseBytes: boundedNumber(env.INTEGRATION_MAX_RESPONSE_BYTES, 2_097_152, 1024, 10_485_760, "INTEGRATION_MAX_RESPONSE_BYTES"),
    artifactRetentionDays: boundedNumber(env.INTEGRATION_ARTIFACT_RETENTION_DAYS, 7, 1, 30, "INTEGRATION_ARTIFACT_RETENTION_DAYS"),
    webhookBaseUrl
  };
}

export function redisConnectionOptions(redisUrl: string) {
  const url = validateIntegrationRedisUrl(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === "rediss:" ? 6380 : 6379)),
    username: decodeURIComponent(url.username || "default"),
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: Number(url.pathname.slice(1) || 0),
    tls: url.protocol === "rediss:" ? {} : undefined,
    maxRetriesPerRequest: null as null
  };
}
