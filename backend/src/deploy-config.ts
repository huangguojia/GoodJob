import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 部署密钥文件加载器。
 *
 * 目的：部署时不想在服务器上配环境变量，把密钥直接写在项目里的 deploy-secrets.json，
 * 启动最早期读取，把「未设置」的环境变量补上（已设置的环境变量始终优先）。
 *
 * 支持 key：
 * - JWT_SECRET              登录态签名 + 追踪链接签名兜底（≥32 字符）
 * - EMAIL_TRACKING_SECRET   开发信追踪链接签名（≥16 字符，缺省复用 JWT_SECRET）
 * - EMAIL_TRACKING_BASE_URL 已读追踪回传域名（如 https://crm.example.com）
 *
 * 文件查找顺序（相对进程启动目录 cwd）：
 * 1. 显式传入的路径（测试用）
 * 2. <cwd>/deploy-secrets.json
 * 3. <cwd>/backend/deploy-secrets.json
 *
 * ⚠️ 填了真实密钥后不要把这个文件提交到公开仓库。
 */

const SUPPORTED_KEYS = [
  "JWT_SECRET",
  "EMAIL_TRACKING_SECRET",
  "EMAIL_TRACKING_BASE_URL"
] as const;

export type DeploySecretsResult = {
  loaded: boolean;
  path: string;
  appliedKeys: string[];
  skippedKeys: string[];
};

export function loadDeploySecrets(options: { file?: string } = {}): DeploySecretsResult {
  const empty: DeploySecretsResult = { loaded: false, path: "", appliedKeys: [], skippedKeys: [] };
  const candidates = options.file
    ? [resolve(options.file)]
    : [
        resolve(process.cwd(), "deploy-secrets.json"),
        resolve(process.cwd(), "backend", "deploy-secrets.json")
      ];
  const filePath = candidates.find((item) => existsSync(item));
  if (!filePath) return empty;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    // 文件存在但解析失败：不阻断启动（env 兜底），只报一句
    console.error(`deploy-secrets.json 解析失败，已忽略：${filePath}`);
    return { ...empty, path: filePath };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`deploy-secrets.json 内容必须是 JSON 对象，已忽略：${filePath}`);
    return { ...empty, path: filePath };
  }

  const appliedKeys: string[] = [];
  const skippedKeys: string[] = [];
  for (const key of SUPPORTED_KEYS) {
    const value = typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "";
    if (!value) continue;
    if (process.env[key]?.trim()) {
      skippedKeys.push(key);
      continue;
    }
    process.env[key] = value;
    appliedKeys.push(key);
  }
  return { loaded: appliedKeys.length > 0, path: filePath, appliedKeys, skippedKeys };
}
