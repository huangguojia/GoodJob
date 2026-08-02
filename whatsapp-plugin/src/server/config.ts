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
  allowPrivateAiEndpoints: boolean;
  baileysProxyUrl?: string;
  mediaStoragePath?: string;
  metaGraphBaseUrl?: string;
  crmJwtSecret?: string;
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

export function parseBaileysProxyUrl(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("BAILEYS_PROXY_URL must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("BAILEYS_PROXY_URL must use the http or https protocol");
  }
  return url.toString();
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
    allowPrivateAiEndpoints: parseBoolean(
      "ALLOW_PRIVATE_AI_ENDPOINTS",
      environment.ALLOW_PRIVATE_AI_ENDPOINTS,
      false
    ),
    baileysProxyUrl: parseBaileysProxyUrl(environment.BAILEYS_PROXY_URL),
    mediaStoragePath: path.resolve(process.cwd(), environment.MEDIA_STORAGE_PATH?.trim() || ".data/media"),
    metaGraphBaseUrl,
    crmJwtSecret: environment.CRM_JWT_SECRET?.trim() || environment.JWT_SECRET?.trim()
  };
}
