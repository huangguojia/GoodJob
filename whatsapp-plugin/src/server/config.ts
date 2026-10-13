import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

export type NodeEnvironment = "development" | "test" | "production";

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  host?: string;
  port: number;
  webOrigin: string;
  databaseClient: "pglite" | "postgres" | "mysql";
  pglitePath: string;
  databaseUrl?: string;
  sessionMasterKey?: string;
  seedDemo: boolean;
  enableDemoProvider?: boolean;
  autoMigrate?: boolean;
  officialOnly?: boolean;
  allowPrivateAiEndpoints: boolean;
  baileysProxyUrl?: string;
  metaProxyUrl?: string;
  mediaStoragePath?: string;
  metaGraphBaseUrl?: string;
  crmJwtSecret?: string;
  crmBaseUrl?: string;
  /**
   * 读 CRM 的单次请求上限（毫秒）。
   * 自动回复要等它：CRM 卡住时不该把整条回复链一起拖死，所以这里比 CRM 的常规超时短得多。
   */
  crmTimeoutMs?: number;
  /**
   * 自动回复的本机 CLI 引擎（WorkBuddy CLI / CodeBuddy）。
   * CLI 二进制路径，默认自动解析（独立版优先，桌面内置版兜底）。
   */
  cliBinary?: string;
  /** 单次 CLI 生成的超时秒数。 */
  cliTimeoutSeconds?: number;
  /** CLI 的工作目录（刻意用一个空目录，别让它去探索仓库）。 */
  cliWorkspacePath?: string;
  /** CLI 技能扫描目录；空/未设时按 cli-engine 的规则解析（插件自带 skills/ 优先）。 */
  cliSkillsDirs?: string;
  /**
   * 自动聊兜底扫描（每分钟补扫漏掉的入站消息）。
   * 测试环境默认关闭，否则定时器会在用例中途插入草稿，让断言变得不确定。
   */
  autoChatSweep?: boolean;
}

function parseEnum<const Values extends readonly string[]>(
  name: string,
  value: string | undefined,
  values: Values,
  fallback: Values[number]
): Values[number] {
  const candidate = value?.trim() || fallback;
  if (!values.includes(candidate)) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
  return candidate as Values[number];
}

export function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const candidate = value.trim().toLowerCase();
  if (candidate === "true") return true;
  if (candidate === "false") return false;
  throw new Error(`${name} must be either true or false`);
}

/** 有界的整型环境变量；空值或用例外的值一律回落默认，不让一个手滑的 env 让服务起不来。 */
export function parseInteger(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value?.trim();
  if (!candidate) return fallback;
  if (!/^-?\d+$/u.test(candidate)) throw new Error(`${name} must be an integer`);
  const parsed = Number(candidate);
  if (parsed < minimum || parsed > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  return parsed;
}

export function parsePort(value: string | undefined): number {
  const candidate = value?.trim() || "3100";
  if (!/^\d+$/u.test(candidate)) throw new Error("PORT must be an integer between 1 and 65535");
  const port = Number(candidate);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function parseWebOrigin(value: string | undefined): string {
  const candidate = value?.trim() || "http://127.0.0.1:5173";
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("WEB_ORIGIN must be a valid HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("WEB_ORIGIN must contain only an HTTP(S) scheme, host, and optional port");
  }
  return url.origin;
}

function parseSessionMasterKey(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(candidate)) {
    throw new Error("SESSION_MASTER_KEY must be valid base64 encoding exactly 32 bytes");
  }
  const decoded = Buffer.from(candidate, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/u, "");
  if (decoded.length !== 32 || canonical !== candidate.replace(/=+$/u, "")) {
    throw new Error("SESSION_MASTER_KEY must be valid base64 encoding exactly 32 bytes");
  }
  return candidate;
}

function parseMetaGraphBaseUrl(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("META_GRAPH_BASE_URL must be a valid HTTP(S) URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("META_GRAPH_BASE_URL must be a valid HTTP(S) URL without credentials, query, or fragment");
  }
  return url.toString().replace(/\/+$/u, "");
}

export function parseProxyUrl(name: string, value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use the http or https protocol`);
  }
  return url.toString();
}

export function parseBaileysProxyUrl(value: string | undefined): string | undefined {
  return parseProxyUrl("BAILEYS_PROXY_URL", value);
}

export function parseMetaProxyUrl(value: string | undefined): string | undefined {
  return parseProxyUrl("META_PROXY_URL", value);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = parseEnum("NODE_ENV", environment.NODE_ENV, ["development", "test", "production"] as const, "development");
  const databaseClient = parseEnum(
    "DATABASE_CLIENT",
    environment.DATABASE_CLIENT,
    ["pglite", "postgres", "mysql"] as const,
    "pglite"
  );
  const databaseUrl = environment.DATABASE_URL?.trim() || undefined;
  const sessionMasterKey = parseSessionMasterKey(environment.SESSION_MASTER_KEY);
  const seedDemo = parseBoolean("SEED_DEMO", environment.SEED_DEMO, false);
  const enableDemoProvider = parseBoolean("ALLOW_DEMO_PROVIDER", environment.ALLOW_DEMO_PROVIDER, false);
  const autoMigrate = parseBoolean("AUTO_MIGRATE", environment.AUTO_MIGRATE, nodeEnv !== "production");
  const officialOnly = parseBoolean(
    "WHATSAPP_OFFICIAL_ONLY",
    environment.WHATSAPP_OFFICIAL_ONLY,
    nodeEnv === "production"
  );
  const metaGraphBaseUrl = parseMetaGraphBaseUrl(environment.META_GRAPH_BASE_URL);

  if ((databaseClient === "postgres" || databaseClient === "mysql") && !databaseUrl) {
    throw new Error(`DATABASE_URL is required when DATABASE_CLIENT=${databaseClient}`);
  }
  if (seedDemo && !enableDemoProvider) {
    throw new Error("SEED_DEMO requires ALLOW_DEMO_PROVIDER=true");
  }
  if (nodeEnv === "production") {
    if (databaseClient !== "mysql") throw new Error("DATABASE_CLIENT must be mysql in production");
    if (!sessionMasterKey) throw new Error("SESSION_MASTER_KEY is required in production");
    if (seedDemo) throw new Error("SEED_DEMO must be false in production");
    if (enableDemoProvider) throw new Error("ALLOW_DEMO_PROVIDER must be false in production");
    if (autoMigrate) throw new Error("AUTO_MIGRATE must be false in production");
    if (!officialOnly) throw new Error("WHATSAPP_OFFICIAL_ONLY must be true in production");
    if (metaGraphBaseUrl && metaGraphBaseUrl !== "https://graph.facebook.com") {
      throw new Error("META_GRAPH_BASE_URL must use https://graph.facebook.com in production");
    }
  }

  const host = environment.HOST?.trim() || "127.0.0.1";
  if (/\s/u.test(host)) throw new Error("HOST must not contain whitespace");

  return {
    nodeEnv,
    host,
    port: parsePort(environment.PORT),
    webOrigin: parseWebOrigin(environment.WEB_ORIGIN),
    databaseClient,
    pglitePath: path.resolve(process.cwd(), environment.PGLITE_PATH?.trim() || ".data/pgdata"),
    databaseUrl,
    sessionMasterKey,
    seedDemo,
    enableDemoProvider,
    autoMigrate,
    officialOnly,
    allowPrivateAiEndpoints: parseBoolean(
      "ALLOW_PRIVATE_AI_ENDPOINTS",
      environment.ALLOW_PRIVATE_AI_ENDPOINTS,
      false
    ),
    baileysProxyUrl: parseBaileysProxyUrl(environment.BAILEYS_PROXY_URL),
    metaProxyUrl: parseMetaProxyUrl(environment.META_PROXY_URL),
    mediaStoragePath: path.resolve(process.cwd(), environment.MEDIA_STORAGE_PATH?.trim() || ".data/media"),
    metaGraphBaseUrl,
    crmJwtSecret: environment.CRM_JWT_SECRET?.trim() || environment.JWT_SECRET?.trim(),
    crmBaseUrl: (environment.CRM_BASE_URL?.trim() || "http://127.0.0.1:4188").replace(/\/+$/u, ""),
    crmTimeoutMs: parseInteger("CRM_TIMEOUT_MS", environment.CRM_TIMEOUT_MS, 6_000, 500, 60_000),
    cliBinary: environment.GOODJOB_WORKBUDDY_BIN?.trim() || undefined,
    cliTimeoutSeconds: parseInteger("GOODJOB_CLI_TIMEOUT_SECONDS", environment.GOODJOB_CLI_TIMEOUT_SECONDS, 90, 5, 600),
    cliWorkspacePath: path.resolve(process.cwd(), environment.GOODJOB_CLI_WORKSPACE?.trim() || ".data/cli-workspace"),
    // 与 Runner 侧同名：一处配置就能同时管住「CRM 任务用的技能目录」和「插件自动回复用的技能目录」。
    cliSkillsDirs: environment.GOODJOB_SKILLS_DIRS?.trim() || undefined,
    autoChatSweep: parseBoolean("AUTO_CHAT_SWEEP", environment.AUTO_CHAT_SWEEP, nodeEnv !== "test")
  };
}
