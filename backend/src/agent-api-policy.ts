import { z } from "zod";
import type { AgentRisk } from "./ai-agent.js";

export const agentApiRequestSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().trim().min(5).max(300),
  query: z.record(z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional().default({}),
  headers: z.record(z.string().trim().min(1).max(2048)).optional().default({}).superRefine((headers, context) => {
    const unsupported = Object.keys(headers).find((key) => !["if-match", "idempotency-key"].includes(key.toLowerCase()));
    if (unsupported) context.addIssue({ code: z.ZodIssueCode.custom, message: `Agent 不允许设置请求头 ${unsupported}` });
  }),
  body: z.unknown().optional()
});

const deniedPatterns: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\/api\/auth(?:\/|$)/u, reason: "登录与会话接口不向 Agent 开放" },
  { pattern: /^\/api\/accounts(?:\/|$)/u, reason: "用户账号管理接口不向 Agent 开放" },
  { pattern: /^\/api\/system\/database-import(?:\/|$)/u, reason: "数据库迁移只允许人工管理员使用服务器授权码执行" },
  { pattern: /^\/api\/system\/database-maintenance(?:\/|$)/u, reason: "数据库维护控制面不向 Agent 开放" },
  { pattern: /^\/api\/system\/database-backups(?:\/|$)/u, reason: "数据库备份只允许人工管理员使用服务器授权码执行" },
  { pattern: /^\/api\/profile(?:\/|$)/u, reason: "个人账号资料与邮箱凭据接口不向 Agent 开放" },
  { pattern: /^\/api\/tools\/ai-config(?:\/|$)/u, reason: "个人模型密钥配置不向 Agent 开放" },
  { pattern: /^\/api\/lead-finder\/source-config(?:\/|$)/u, reason: "个人数据源密钥配置不向 Agent 开放" },
  { pattern: /^\/api\/internal-messages\/recipients$/u, reason: "账号收件人目录不向 Agent 开放" },
  { pattern: /^\/api\/prospect-list\/assignees$/u, reason: "账号分配目录不向 Agent 开放" },
  { pattern: /^\/api\/whatsapp\/binding(?:\/|$)/u, reason: "个人 Communication 账号绑定配置不向 Agent 开放" },
  { pattern: /^\/api\/whatsapp\/webhook(?:\/|$)/u, reason: "外部 webhook 接收接口不向 Agent 开放" },
  { pattern: /^\/api\/docs(?:\/|$)/u, reason: "部署调试文档不属于业务接口" },
  { pattern: /^\/api\/agent\/(?:plan|execute|runs|conversations|missions)(?:\/|$)/u, reason: "Agent 不能递归调用自身控制面" },
  { pattern: /^\/api\/agent\/api(?:\/|$)/u, reason: "Agent 不能递归调用通用 API 网关" }
];

const externalPatterns = [
  /^\/api\/internal-messages$/u,
  /^\/api\/prospect-list\/[^/]+\/send-development-email$/u,
  /^\/api\/development-email\/send$/u,
  /^\/api\/leads\/[^/]+\/send-email$/u,
  /^\/api\/whatsapp\/customers\/[^/]+\/messages$/u,
  /^\/api\/trade-documents\/[^/]+\/send$/u,
  /^\/api\/ai-background-research$/u,
  /^\/api\/lead-finder\/(?:free-search|search)$/u,
  /^\/api\/lead-finder\/source-config\/test$/u,
  /^\/api\/tools\/website-scrape\/preview$/u,
  /^\/api\/prospect-list\/[^/]+\/identity-bootstrap$/u,
  /^\/api\/prospect-strategies\/[^/]+\/runs$/u,
  /^\/api\/prospect-campaigns\/[^/]+\/market-analysis-runs$/u
];

const readOnlyPostPatterns = [
  /^\/api\/agent\/tuning\/inspect$/u
];

export function normalizeAgentApiPath(rawPath: string) {
  const path = rawPath.trim();
  if (!path.startsWith("/api/")) throw new Error("Agent 只能调用 /api/ 下的站内接口");
  if (path.includes("..") || path.includes("://") || path.includes("?") || path.includes("#") || /[\u0000-\u001f]/u.test(path)) {
    throw new Error("API 路径格式无效；查询参数必须放在 query 字段");
  }
  return path.replace(/\/{2,}/gu, "/").replace(/\/$/u, "") || "/";
}

export function deniedAgentApiReason(path: string) {
  return deniedPatterns.find((item) => item.pattern.test(path))?.reason || "";
}

export function classifyAgentApiRequest(method: string, rawPath: string): AgentRisk {
  const path = normalizeAgentApiPath(rawPath);
  const denied = deniedAgentApiReason(path);
  if (denied) throw new Error(denied);
  if (method.toUpperCase() === "GET") return "read";
  if (readOnlyPostPatterns.some((pattern) => pattern.test(path))) return "read";
  if (externalPatterns.some((pattern) => pattern.test(path))) return "external";
  return "write";
}

export function assertAgentApiToolRisk(tool: string, method: string, path: string) {
  const actual = classifyAgentApiRequest(method, path);
  const expected: AgentRisk | undefined = tool === "api.read" ? "read" : tool === "api.write" ? "write" : tool === "api.external" ? "external" : undefined;
  if (!expected || actual !== expected) {
    throw new Error(`接口风险等级为 ${actual}，必须使用 ${actual === "read" ? "api.read" : actual === "write" ? "api.write" : "api.external"}`);
  }
  return actual;
}

export function routeTemplateMatches(template: string, actualPath: string) {
  const templateParts = normalizeAgentApiPath(template).split("/").filter(Boolean);
  const actualParts = normalizeAgentApiPath(actualPath).split("/").filter(Boolean);
  if (templateParts.length !== actualParts.length) return false;
  return templateParts.every((part, index) => part.startsWith(":") || /^\{[^{}]+\}$/u.test(part) || part === actualParts[index]);
}

export function redactAgentApiData(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[内容过深，已省略]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactAgentApiData(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" && value.length > 20_000 ? `${value.slice(0, 20_000)}…` : value;
  const blockedKeys = /^(password|passwordHash|authVersion|apiKey|token|accessToken|refreshToken|smtpPassword|sessionData|credential|credentialRef|configurationEncrypted|secret|privateKey|users|accounts|assignees|recipients)$/iu;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, blockedKeys.test(key) ? "[已保护]" : redactAgentApiData(item, depth + 1)]));
}
