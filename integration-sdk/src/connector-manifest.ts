import { createHash } from "node:crypto";

export type ConnectorDriverType =
  | "native_mcp"
  | "microsoft_graph"
  | "google_workspace"
  | "google_drive"
  | "erpnext"
  | "easypost"
  | "wecom";
export type ConnectorManifestStage = "planned" | "available";
export type ConnectorAuthentication = "none" | "oauth2" | "api_token";

export interface ConnectorCredentialField {
  key: string;
  label: string;
  secret: true;
  minLength: number;
  maxLength: number;
  help?: string;
}

export interface ConnectorOAuthManifest {
  clientId: string;
  clientSecretEnv?: string;
  scopes: string[];
  profile?: "mcp" | "fixed_oidc";
  authorizationServerUrl?: string;
  metadataUrl?: string;
  acceptedAudiences?: string[];
  useResourceParameter?: boolean;
}

export interface ConnectorManifest {
  schemaVersion: "1.0";
  stage: ConnectorManifestStage;
  driver?: ConnectorDriverType;
  endpoint?: string;
  approvedHosts: string[];
  allowedPorts: number[];
  allowInsecureLoopback?: boolean;
  authentication?: ConnectorAuthentication;
  oauth?: ConnectorOAuthManifest;
  credentialFields?: ConnectorCredentialField[];
  maxTools?: number;
}

export interface ActiveConnectorManifest extends ConnectorManifest {
  stage: "available";
  driver: ConnectorDriverType;
  endpoint: string;
  authentication: ConnectorAuthentication;
}

export interface ManifestValidationOptions {
  environment?: "production" | "development" | "test";
  requireSchemaVersion?: boolean;
  allowedDrivers?: readonly ConnectorDriverType[];
}

export interface DriverHealthResult<TDiscovery = unknown> {
  ok: true;
  latencyMs: number;
  checkedAt: string;
  discovery?: TDiscovery;
  details?: Record<string, unknown>;
}

export interface ConnectorDriverContract<TContext, TDiscovery, TResult> {
  readonly type: ConnectorDriverType;
  validateConfiguration(manifest: ConnectorManifest): Promise<void> | void;
  discoverTools(context: TContext): Promise<TDiscovery>;
  invokeTool(context: TContext, remoteName: string, input: Record<string, unknown>): Promise<TResult>;
  healthCheck(context: TContext): Promise<DriverHealthResult<TDiscovery>>;
  closeConnection(connectionId: string): Promise<void> | void;
}

const manifestKeys = new Set([
  "schemaVersion", "stage", "driver", "endpoint", "approvedHosts", "allowedPorts",
  "allowInsecureLoopback", "authentication", "oauth", "credentialFields", "maxTools"
]);
const oauthKeys = new Set([
  "clientId", "clientSecretEnv", "scopes", "profile", "authorizationServerUrl",
  "metadataUrl", "acceptedAudiences", "useResourceParameter"
]);
const credentialFieldKeys = new Set(["key", "label", "secret", "minLength", "maxLength", "help"]);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "INTEGRATION_CONNECTOR_MANIFEST_INVALID", status: 400 });
}

function record(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${name} 必须是对象`);
  return value as Record<string, unknown>;
}

function strictKeys(value: Record<string, unknown>, allowed: Set<string>, name: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) invalid(`${name} 包含未支持字段：${unknown.join("、")}`);
}

function requiredString(value: unknown, name: string, max: number) {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result || result.length > max || /[\u0000-\u001f\u007f]/u.test(result)) invalid(`${name} 无效`);
  return result;
}

function stringArray(value: unknown, name: string, maxItems: number, maxLength: number, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && !value.length)) invalid(`${name} 无效`);
  const values = value.map((item) => requiredString(item, name, maxLength));
  if (new Set(values).size !== values.length) invalid(`${name} 不能包含重复项`);
  return values;
}

function approvedUrl(value: unknown, name: string, hosts: string[], allowInsecureLoopback: boolean) {
  let url: URL;
  try { url = new URL(requiredString(value, name, 2_000)); } catch { invalid(`${name} URL 无效`); }
  if (url.username || url.password || url.hash) invalid(`${name} 不能包含账号、密码或 fragment`);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const insecureLoopback = allowInsecureLoopback && url.protocol === "http:" && loopbackHosts.has(hostname);
  if (url.protocol !== "https:" && !insecureLoopback) invalid(`${name} 必须使用 HTTPS`);
  if (!hosts.includes(hostname)) invalid(`${name} 主机必须包含在 approvedHosts 中`);
  return url.toString();
}

export function validateConnectorManifest(input: unknown, options: ManifestValidationOptions = {}): ConnectorManifest {
  const source = record(input, "Connector Manifest");
  strictKeys(source, manifestKeys, "Connector Manifest");
  const environment = options.environment || "production";
  const schemaVersion = String(source.schemaVersion || "1.0");
  if (schemaVersion !== "1.0" || (options.requireSchemaVersion && source.schemaVersion !== "1.0")) {
    invalid("Connector Manifest schemaVersion 必须为 1.0");
  }
  const stage = String(source.stage || (source.endpoint ? "available" : "planned"));
  if (!new Set(["planned", "available"]).has(stage)) invalid("Connector Manifest stage 无效");
  const approvedHosts = stringArray(source.approvedHosts || [], "approvedHosts", 20, 253, stage === "planned")
    .map((host) => host.toLowerCase().replace(/^\[|\]$/gu, ""));
  if (approvedHosts.some((host) => host.includes("*") || !/^[a-z0-9.:-]+$/u.test(host))) {
    invalid("approvedHosts 不允许通配符或非法主机名");
  }
  const rawPorts = source.allowedPorts === undefined ? [443] : source.allowedPorts;
  if (!Array.isArray(rawPorts) || !rawPorts.length || rawPorts.length > 10) invalid("allowedPorts 无效");
  const allowedPorts = rawPorts.map(Number);
  if (allowedPorts.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
    || new Set(allowedPorts).size !== allowedPorts.length) invalid("allowedPorts 包含非法或重复端口");
  const allowInsecureLoopback = source.allowInsecureLoopback === true;
  if (allowInsecureLoopback && environment === "production") invalid("生产环境禁止 HTTP loopback 连接器");
  if (stage === "planned") {
    if (source.endpoint || source.driver || source.oauth) invalid("planned Manifest 不能包含运行配置");
    return { schemaVersion: "1.0", stage: "planned", approvedHosts, allowedPorts };
  }
  if (options.requireSchemaVersion && !source.driver) invalid("available Manifest 必须显式声明 driver");
  const driver = requiredString(source.driver || "native_mcp", "driver", 40) as ConnectorDriverType;
  const allowedDrivers = options.allowedDrivers || [
    "native_mcp", "microsoft_graph", "google_workspace", "google_drive", "erpnext", "easypost", "wecom"
  ];
  if (!allowedDrivers.includes(driver)) invalid(`driver ${driver} 未获准使用`);
  const endpoint = approvedUrl(source.endpoint, "endpoint", approvedHosts, allowInsecureLoopback);
  const endpointUrl = new URL(endpoint);
  const endpointPort = Number(endpointUrl.port || (endpointUrl.protocol === "https:" ? 443 : 80));
  if (!allowedPorts.includes(endpointPort)) invalid("endpoint 端口必须包含在 allowedPorts 中");
  const authentication = String(source.authentication || "none") as ConnectorAuthentication;
  if (!new Set(["none", "oauth2", "api_token"]).has(authentication)) invalid("authentication 无效");
  let oauth: ConnectorOAuthManifest | undefined;
  let credentialFields: ConnectorCredentialField[] | undefined;
  if (authentication === "oauth2") {
    const rawOauth = record(source.oauth, "oauth");
    strictKeys(rawOauth, oauthKeys, "oauth");
    const profile = String(rawOauth.profile || "mcp");
    if (!new Set(["mcp", "fixed_oidc"]).has(profile)) invalid("oauth.profile 无效");
    const clientSecretEnv = rawOauth.clientSecretEnv === undefined ? undefined
      : requiredString(rawOauth.clientSecretEnv, "oauth.clientSecretEnv", 120);
    if (clientSecretEnv && !/^INTEGRATION_[A-Z0-9_]+$/u.test(clientSecretEnv)) {
      invalid("oauth.clientSecretEnv 只能引用 INTEGRATION_ 前缀环境变量");
    }
    oauth = {
      clientId: requiredString(rawOauth.clientId, "oauth.clientId", 300),
      ...(clientSecretEnv ? { clientSecretEnv } : {}),
      scopes: stringArray(rawOauth.scopes, "oauth.scopes", 50, 200),
      profile: profile as ConnectorOAuthManifest["profile"],
      ...(rawOauth.useResourceParameter === undefined ? {} : { useResourceParameter: rawOauth.useResourceParameter === true })
    };
    if (profile === "fixed_oidc") {
      oauth.authorizationServerUrl = approvedUrl(rawOauth.authorizationServerUrl, "oauth.authorizationServerUrl", approvedHosts, false);
      oauth.metadataUrl = approvedUrl(rawOauth.metadataUrl, "oauth.metadataUrl", approvedHosts, false);
      oauth.acceptedAudiences = stringArray(rawOauth.acceptedAudiences, "oauth.acceptedAudiences", 20, 500);
    } else if (rawOauth.authorizationServerUrl || rawOauth.metadataUrl || rawOauth.acceptedAudiences) {
      invalid("mcp OAuth profile 不接受固定 OIDC 配置");
    }
  } else if (source.oauth !== undefined) {
    invalid("authentication=none 时不能提供 oauth 配置");
  }
  if (authentication === "api_token") {
    if (!Array.isArray(source.credentialFields) || source.credentialFields.length < 1 || source.credentialFields.length > 8) {
      invalid("api_token 认证必须声明 1-8 个凭据字段");
    }
    credentialFields = source.credentialFields.map((item, index) => {
      const field = record(item, `credentialFields[${index}]`);
      strictKeys(field, credentialFieldKeys, `credentialFields[${index}]`);
      const key = requiredString(field.key, `credentialFields[${index}].key`, 64);
      if (!/^[a-z][A-Za-z0-9_]{1,63}$/u.test(key)) invalid(`credentialFields[${index}].key 格式无效`);
      if (field.secret !== true) invalid(`credentialFields[${index}] 必须是敏感字段`);
      const minLength = Number(field.minLength ?? 8);
      const maxLength = Number(field.maxLength ?? 500);
      if (!Number.isInteger(minLength) || !Number.isInteger(maxLength)
        || minLength < 1 || maxLength > 2_000 || minLength > maxLength) {
        invalid(`credentialFields[${index}] 长度限制无效`);
      }
      const help = field.help === undefined ? "" : requiredString(field.help, `credentialFields[${index}].help`, 300);
      return {
        key,
        label: requiredString(field.label, `credentialFields[${index}].label`, 100),
        secret: true as const,
        minLength,
        maxLength,
        ...(help ? { help } : {})
      };
    });
    if (new Set(credentialFields.map((field) => field.key)).size !== credentialFields.length) {
      invalid("credentialFields.key 不能重复");
    }
  } else if (source.credentialFields !== undefined) {
    invalid("只有 api_token 认证可以声明 credentialFields");
  }
  const maxTools = source.maxTools === undefined ? 200 : Number(source.maxTools);
  if (!Number.isInteger(maxTools) || maxTools < 1 || maxTools > 200) invalid("maxTools 必须在 1-200 之间");
  return {
    schemaVersion: "1.0", stage: "available", driver, endpoint, approvedHosts,
    allowedPorts, ...(allowInsecureLoopback ? { allowInsecureLoopback } : {}),
    authentication, ...(oauth ? { oauth } : {}), ...(credentialFields ? { credentialFields } : {}), maxTools
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const recordValue = value as Record<string, unknown>;
  return `{${Object.keys(recordValue).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(recordValue[key])}`).join(",")}}`;
}

export function canonicalManifestJson(input: unknown, options: ManifestValidationOptions = {}) {
  return canonicalJson(validateConnectorManifest(input, options));
}

export function connectorManifestHash(input: unknown, options: ManifestValidationOptions = {}) {
  return createHash("sha256").update(canonicalManifestJson(input, options)).digest("hex");
}

export function assertConnectorDriverContract(value: unknown): asserts value is ConnectorDriverContract<unknown, unknown, unknown> {
  const driver = record(value, "Connector Driver");
  requiredString(driver.type, "Connector Driver type", 40);
  for (const method of ["validateConfiguration", "discoverTools", "invokeTool", "healthCheck", "closeConnection"]) {
    if (typeof driver[method] !== "function") invalid(`Connector Driver 缺少 ${method}()`);
  }
}
