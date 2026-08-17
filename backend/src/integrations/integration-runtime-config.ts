export interface IntegrationControlPlaneConfig {
  enabled: boolean;
  workerEnabled: boolean;
  oauthCallbackBaseUrl: string;
  oauthSuccessRedirectUrl: string;
}

function enabled(value: string | undefined) {
  return value?.trim().toLowerCase() === "true";
}

function assertRedisUrl(rawValue: string) {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error("REDIS_URL 格式无效");
  }
  if (!new Set(["redis:", "rediss:"]).has(url.protocol) || !url.hostname) {
    throw new Error("REDIS_URL 必须使用 redis:// 或 rediss://");
  }
}

export function validateIntegrationControlPlaneConfig(
  env: NodeJS.ProcessEnv,
  mysqlRequested: boolean
): IntegrationControlPlaneConfig {
  const integrationEnabled = enabled(env.INTEGRATION_ENABLED);
  const workerEnabled = enabled(env.INTEGRATION_WORKER_ENABLED);
  if (!integrationEnabled) {
    if (workerEnabled) throw new Error("控制面关闭时不能单独启用 Integration Worker");
    return { enabled: false, workerEnabled: false, oauthCallbackBaseUrl: "", oauthSuccessRedirectUrl: "" };
  }
  if (!mysqlRequested || env.CRM_STORE === "memory") {
    throw new Error("集成平台启用时必须使用 MySQL 持久化");
  }
  if (!workerEnabled) throw new Error("集成平台启用时必须启用 Integration Worker");
  const redisUrl = String(env.REDIS_URL || "").trim();
  if (!redisUrl) throw new Error("集成平台启用时必须配置 REDIS_URL");
  assertRedisUrl(redisUrl);
  if (String(env.INTEGRATION_CREDENTIAL_KEY || "").trim().length < 32) {
    throw new Error("INTEGRATION_CREDENTIAL_KEY 必须至少包含 32 个字符");
  }
  const oauthCallbackBaseUrl = String(env.INTEGRATION_OAUTH_CALLBACK_BASE_URL || "").trim();
  const oauthSuccessRedirectUrl = String(env.INTEGRATION_OAUTH_SUCCESS_REDIRECT_URL || "").trim();
  for (const [name, value] of [["INTEGRATION_OAUTH_CALLBACK_BASE_URL", oauthCallbackBaseUrl], ["INTEGRATION_OAUTH_SUCCESS_REDIRECT_URL", oauthSuccessRedirectUrl]] as const) {
    if (!value) continue;
    const url = new URL(value);
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(env.NODE_ENV !== "production" && url.protocol === "http:" && loopback)) {
      throw new Error(`${name} 必须使用 HTTPS`);
    }
  }
  return { enabled: true, workerEnabled: true, oauthCallbackBaseUrl, oauthSuccessRedirectUrl };
}
