import {
  canonicalManifestJson,
  connectorManifestHash,
  validateConnectorManifest
} from "@goodjob/integration-connector-sdk";
import type { MysqlIntegrationControlRepository } from "./integration-control-repository.js";
import type { ConnectorDefinition, ConnectorStatus, ConnectorType } from "./integration-types.js";

interface CatalogSeed {
  code: string;
  name: string;
  type: ConnectorType;
  status: ConnectorStatus;
  description: string;
  manifest: Record<string, unknown>;
}

function planned(code: string, name: string, type: ConnectorType, description: string): CatalogSeed {
  return { code, name, type, status: "draft", description, manifest: { schemaVersion: "1.0", stage: "planned", approvedHosts: [], allowedPorts: [443] } };
}

function configuredEndpoint(raw: string, env: NodeJS.ProcessEnv) {
  try {
    const url = new URL(raw.trim());
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/gu, ""));
    if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(env.NODE_ENV === "test" && loopback && url.protocol === "http:"))) return null;
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    return {
      endpoint: url.toString(),
      host: url.hostname.toLowerCase().replace(/^\[|\]$/gu, ""),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      allowInsecureLoopback: url.protocol === "http:" && loopback
    };
  } catch {
    return null;
  }
}

export function systemConnectorCatalog(env: NodeJS.ProcessEnv = process.env): CatalogSeed[] {
  const microsoftClientId = String(env.INTEGRATION_MICROSOFT_CLIENT_ID || "").trim();
  const microsoftTenant = /^(?:common|organizations|consumers|[0-9a-f-]{36})$/iu.test(String(env.INTEGRATION_MICROSOFT_TENANT_ID || "organizations").trim())
    ? String(env.INTEGRATION_MICROSOFT_TENANT_ID || "organizations").trim()
    : "organizations";
  const microsoftAuthorizationServer = `https://login.microsoftonline.com/${microsoftTenant}/v2.0`;
  const microsoftManifest = microsoftClientId ? {
    schemaVersion: "1.0",
    stage: "available",
    driver: "microsoft_graph",
    endpoint: "https://graph.microsoft.com/v1.0/",
    approvedHosts: ["graph.microsoft.com", "login.microsoftonline.com"],
    allowedPorts: [443],
    authentication: "oauth2",
    oauth: {
      profile: "fixed_oidc",
      clientId: microsoftClientId,
      ...(env.INTEGRATION_OAUTH_MICROSOFT_CLIENT_SECRET
        ? { clientSecretEnv: "INTEGRATION_OAUTH_MICROSOFT_CLIENT_SECRET" }
        : {}),
      authorizationServerUrl: microsoftAuthorizationServer,
      metadataUrl: `https://login.microsoftonline.com/${microsoftTenant}/v2.0/.well-known/openid-configuration`,
      acceptedAudiences: ["00000003-0000-0000-c000-000000000000", "https://graph.microsoft.com"],
      useResourceParameter: false,
      scopes: [
        "openid", "profile", "email", "offline_access", "User.Read",
        "Mail.Read", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"
      ]
    },
    maxTools: 9
  } : { schemaVersion: "1.0", stage: "planned", approvedHosts: [], allowedPorts: [443] };
  const googleClientId = String(env.INTEGRATION_GOOGLE_CLIENT_ID || "").trim();
  const googleClientSecret = String(env.INTEGRATION_OAUTH_GOOGLE_CLIENT_SECRET || "").trim();
  const googleConfigured = Boolean(googleClientId && googleClientSecret);
  const googleManifest = googleConfigured ? {
    schemaVersion: "1.0",
    stage: "available",
    driver: "google_workspace",
    endpoint: "https://www.googleapis.com/",
    approvedHosts: ["www.googleapis.com", "accounts.google.com", "oauth2.googleapis.com", "openidconnect.googleapis.com"],
    allowedPorts: [443],
    authentication: "oauth2",
    oauth: {
      profile: "fixed_oidc",
      clientId: googleClientId,
      clientSecretEnv: "INTEGRATION_OAUTH_GOOGLE_CLIENT_SECRET",
      authorizationServerUrl: "https://accounts.google.com/",
      metadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
      acceptedAudiences: [googleClientId],
      useResourceParameter: false,
      scopes: [
        "openid", "profile", "email",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.compose",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/calendar.events",
        "https://www.googleapis.com/auth/calendar.freebusy"
      ]
    },
    maxTools: 9
  } : { schemaVersion: "1.0", stage: "planned", approvedHosts: [], allowedPorts: [443] };
  const googleDriveManifest = googleConfigured ? {
    schemaVersion: "1.0",
    stage: "available",
    driver: "google_drive",
    endpoint: "https://www.googleapis.com/",
    approvedHosts: ["www.googleapis.com", "accounts.google.com", "oauth2.googleapis.com", "openidconnect.googleapis.com"],
    allowedPorts: [443],
    authentication: "oauth2",
    oauth: {
      profile: "fixed_oidc",
      clientId: googleClientId,
      clientSecretEnv: "INTEGRATION_OAUTH_GOOGLE_CLIENT_SECRET",
      authorizationServerUrl: "https://accounts.google.com/",
      metadataUrl: "https://accounts.google.com/.well-known/openid-configuration",
      acceptedAudiences: [googleClientId],
      useResourceParameter: false,
      scopes: ["openid", "profile", "email", "https://www.googleapis.com/auth/drive.file"]
    },
    maxTools: 5
  } : { schemaVersion: "1.0", stage: "planned", approvedHosts: [], allowedPorts: [443] };
  const erpnextEndpoint = configuredEndpoint(String(env.INTEGRATION_ERPNEXT_BASE_URL || ""), env);
  const erpnextManifest = erpnextEndpoint ? {
    schemaVersion: "1.0",
    stage: "available",
    driver: "erpnext",
    endpoint: erpnextEndpoint.endpoint,
    approvedHosts: [erpnextEndpoint.host],
    allowedPorts: [erpnextEndpoint.port],
    ...(erpnextEndpoint.allowInsecureLoopback ? { allowInsecureLoopback: true } : {}),
    authentication: "api_token",
    credentialFields: [
      { key: "apiKey", label: "ERPNext API Key", secret: true, minLength: 8, maxLength: 500, help: "ERPNext 用户的 API Key" },
      { key: "apiSecret", label: "ERPNext API Secret", secret: true, minLength: 8, maxLength: 500, help: "只保存在当前连接的加密凭据中" }
    ],
    maxTools: 9
  } : { schemaVersion: "1.0", stage: "planned", approvedHosts: [], allowedPorts: [443] };
  const easyPostManifest = {
    schemaVersion: "1.0",
    stage: "available",
    driver: "easypost",
    endpoint: "https://api.easypost.com/v2/",
    approvedHosts: ["api.easypost.com"],
    allowedPorts: [443],
    authentication: "api_token",
    credentialFields: [
      { key: "apiKey", label: "EasyPost API Key", secret: true, minLength: 8, maxLength: 500, help: "使用 EasyPost 官方账户生成的 API Key" }
    ],
    maxTools: 3
  };
  const weComManifest = {
    schemaVersion: "1.0",
    stage: "available",
    driver: "wecom",
    endpoint: "https://qyapi.weixin.qq.com/",
    approvedHosts: ["qyapi.weixin.qq.com"],
    allowedPorts: [443],
    authentication: "api_token",
    credentialFields: [
      { key: "corpId", label: "企业 ID (CorpID)", secret: true, minLength: 3, maxLength: 128, help: "在企业微信管理后台的企业信息中获取" },
      { key: "appSecret", label: "自建应用 Secret", secret: true, minLength: 8, maxLength: 256, help: "仅授予通讯录读取和应用消息所需权限" },
      { key: "agentId", label: "自建应用 AgentId", secret: true, minLength: 1, maxLength: 32, help: "用于发送企业微信应用通知" },
      { key: "customerContactSecret", label: "客户联系 Secret", secret: true, minLength: 8, maxLength: 256, help: "在客户联系 API 页面获取，仅用于读取外部联系人" }
    ],
    maxTools: 5
  };
  const seeds: CatalogSeed[] = [
    {
      code: "microsoft-365",
      name: "Microsoft 365",
      type: "official_api",
      status: microsoftClientId ? "active" : "draft",
      description: "Outlook 邮箱与日历官方连接器",
      manifest: microsoftManifest
    },
    {
      code: "google-workspace",
      name: "Google Workspace",
      type: "official_api",
      status: googleConfigured ? "active" : "draft",
      description: "Gmail 与 Google Calendar 官方连接器",
      manifest: googleManifest
    },
    {
      code: "odoo",
      name: "Odoo",
      type: "official_api",
      status: "deprecated",
      description: "已从当前开发范围移除",
      manifest: { schemaVersion: "1.0", stage: "planned", approvedHosts: [], allowedPorts: [443] }
    },
    {
      code: "erpnext",
      name: "ERPNext",
      type: "official_api",
      status: erpnextEndpoint ? "active" : "draft",
      description: "客户、报价、订单、库存与应收官方 REST API",
      manifest: erpnextManifest
    },
    {
      code: "international-logistics",
      name: "EasyPost 国际物流",
      type: "official_api",
      status: "active",
      description: "官方聚合 API 查询和创建国际运单轨迹",
      manifest: easyPostManifest
    },
    {
      code: "google-drive-trade-docs",
      name: "Google Drive 贸易单据",
      type: "official_api",
      status: googleConfigured ? "active" : "draft",
      description: "将 PI、合同、箱单等贸易文件安全归档到 Google Drive",
      manifest: googleDriveManifest
    },
    {
      code: "wecom",
      name: "企业微信",
      type: "official_api",
      status: "active",
      description: "官方 API 同步组织成员与外部联系人，并发送受审批的应用通知",
      manifest: weComManifest
    },
    planned("public-data", "公共数据源", "internal", "企业、采购与实体校验内部 Provider"),
  ];
  const fakeEndpoint = String(env.INTEGRATION_FAKE_MCP_URL || "").trim();
  if (env.NODE_ENV !== "production" && fakeEndpoint) {
    const url = new URL(fakeEndpoint);
    seeds.push({
      code: "fake-mcp",
      name: "Fake MCP 测试连接",
      type: "native_mcp",
      status: "active",
      description: "仅用于开发环境验证工具发现、审核、授权和只读调用闭环",
      manifest: {
        schemaVersion: "1.0",
        stage: "available",
        driver: "native_mcp",
        endpoint: fakeEndpoint,
        approvedHosts: [url.hostname.toLowerCase()],
        allowedPorts: [Number(url.port || (url.protocol === "https:" ? 443 : 80))],
        allowInsecureLoopback: url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname),
        authentication: "none",
        maxTools: 200
      }
    });
  }
  const fakeOAuthEndpoint = String(env.INTEGRATION_FAKE_OAUTH_MCP_URL || "").trim();
  const fakeOAuthClientId = String(env.INTEGRATION_FAKE_OAUTH_CLIENT_ID || "").trim();
  if (env.NODE_ENV !== "production" && fakeOAuthEndpoint && fakeOAuthClientId) {
    const url = new URL(fakeOAuthEndpoint);
    const extraHosts = String(env.INTEGRATION_FAKE_OAUTH_APPROVED_HOSTS || "")
      .split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    seeds.push({
      code: "fake-oauth-mcp",
      name: "Fake OAuth MCP 测试连接",
      type: "native_mcp",
      status: "active",
      description: "仅用于开发环境验证 OAuth、凭据刷新与 MCP 授权调用闭环",
      manifest: {
        schemaVersion: "1.0",
        stage: "available",
        driver: "native_mcp",
        endpoint: fakeOAuthEndpoint,
        approvedHosts: [...new Set([url.hostname.toLowerCase(), ...extraHosts])],
        allowedPorts: [Number(url.port || (url.protocol === "https:" ? 443 : 80))],
        allowInsecureLoopback: url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname),
        authentication: "oauth2",
        oauth: {
          clientId: fakeOAuthClientId,
          scopes: String(env.INTEGRATION_FAKE_OAUTH_SCOPES || "mcp.tools.read").split(/\s+/u).filter(Boolean)
        },
        maxTools: 200
      }
    });
  }
  return seeds;
}

export async function syncSystemConnectorCatalog(
  repository: MysqlIntegrationControlRepository,
  env: NodeJS.ProcessEnv = process.env
) {
  const now = new Date().toISOString();
  for (const seed of systemConnectorCatalog(env)) {
    const environment = env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development";
    const manifest = validateConnectorManifest(seed.manifest, { environment, requireSchemaVersion: true });
    const manifestJson = canonicalManifestJson(manifest, { environment, requireSchemaVersion: true });
    const connector: ConnectorDefinition = {
      id: `icn_system_${seed.code}`,
      code: seed.code,
      version: "1.0.0",
      type: seed.type,
      trust: "system",
      status: seed.status,
      teamId: "",
      name: seed.name,
      description: seed.description,
      manifestJson,
      manifestHash: connectorManifestHash(manifest, { environment, requireSchemaVersion: true }),
      createdBy: "system",
      createdAt: now,
      updatedAt: now
    };
    await repository.upsertConnector(connector);
  }
}
