/**
 * 社媒 · Meta（Facebook）官方接入。
 *
 * 全部走 Meta 官方接口与官方流程，不抓取、不模拟登录：
 *  - 授权：Facebook Login（OAuth 2.0 授权码）→ 服务端用 App Secret 换令牌 → 换长效用户令牌；
 *    主页令牌由长效用户令牌派生（不过期，用户改密 / 撤销授权时失效）。
 *  - 每次调用都带 appsecret_proof（Meta 推荐的服务端调用防盗用措施）。
 *  - 令牌、App Secret 全部加密落库，接口永不回显明文。
 *  - 用户在 CRM 里断开 = 调 DELETE /{user-id}/permissions 撤销授权 + 删除本地令牌。
 *  - Meta 的「取消授权回调」「数据删除请求回调」都已实现（应用后台必填项）。
 *  - 表单线索：Webhook（leadgen）签名用 X-Hub-Signature-256 校验，收到后用主页令牌按 leadgen_id 拉字段。
 *
 * 每个公司（team）配置自己的 Meta 应用，Webhook / 回调地址带各自的 hookId，互不串号。
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { decryptSecretValue, encryptSecretValue } from "./credential-security.js";
import { readJsonSetting, writeJsonSetting } from "./json-settings.js";

export const META_DEFAULT_GRAPH_VERSION = "v23.0";

/** 申请的权限：只要读主页 / 广告 / 表单线索与订阅表单 Webhook 所需的最小集合 */
export const META_SCOPES = [
  "public_profile",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "leads_retrieval",
  "ads_read",
  "business_management"
];

export interface MetaAppSettings {
  appId: string;
  appSecretEnc: string;
  graphVersion: string;
  /** Webhook / 回调地址里的团队标识（随机，不暴露 teamId） */
  hookId: string;
  verifyTokenEnc: string;
  /** 新线索归属的 CRM 账号；空 = 授权这个主页的人 */
  leadOwnerId: string;
  updatedAt: string;
  updatedBy: string;
}

export interface MetaPage {
  id: string;
  name: string;
  category: string;
  pictureUrl: string;
  tokenEnc: string;
  tasks: string[];
  leadgenSubscribed: boolean;
}

export interface MetaAdAccount {
  id: string;
  accountId: string;
  name: string;
  currency: string;
  status: number;
  business: string;
}

export interface MetaConnection {
  id: string;
  platform: "facebook";
  fbUserId: string;
  name: string;
  pictureUrl: string;
  connectedBy: string;
  connectedByName: string;
  connectedAt: string;
  refreshedAt: string;
  userTokenEnc: string;
  tokenExpiresAt: string;
  grantedScopes: string[];
  declinedScopes: string[];
  pages: MetaPage[];
  adAccounts: MetaAdAccount[];
}

export interface MetaLeadgenLogEntry {
  id: string;
  at: string;
  via: "webhook" | "backfill";
  pageId: string;
  formId: string;
  leadgenId: string;
  leadId: string;
  status: "created" | "duplicate" | "failed";
  message: string;
}

const appKey = (teamId: string) => `social.meta.app:${teamId}`;
const connectionsKey = (teamId: string) => `social.meta.connections:${teamId}`;
const leadgenLogKey = (teamId: string) => `social.meta.leadgen:${teamId}`;
const hookIndexKey = (hookId: string) => `social.meta.hook:${hookId}`;
const deletionKey = (code: string) => `social.meta.deletion:${code}`;

export function metaGraphBase() {
  return (process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com").replace(/\/+$/u, "");
}

export function metaDialogBase() {
  return (process.env.META_DIALOG_BASE_URL || "https://www.facebook.com").replace(/\/+$/u, "");
}

// ---------- 加密 ----------
export const encryptMetaSecret = (teamId: string, kind: string, value: string) => encryptSecretValue("meta-social", `${teamId}|${kind}`, value);
export function decryptMetaSecret(teamId: string, kind: string, value: string) {
  try {
    return decryptSecretValue("meta-social", `${teamId}|${kind}`, value);
  } catch {
    return "";
  }
}

// ---------- 存储 ----------
export async function readMetaApp(teamId: string): Promise<MetaAppSettings | null> {
  const value = await readJsonSetting<MetaAppSettings | null>(appKey(teamId), null);
  return value && value.appId ? value : null;
}

export async function writeMetaApp(teamId: string, settings: MetaAppSettings) {
  await writeJsonSetting(appKey(teamId), settings);
  await writeJsonSetting(hookIndexKey(settings.hookId), { teamId });
}

export async function teamOfHook(hookId: string) {
  if (!/^[A-Za-z0-9_-]{8,64}$/u.test(hookId)) return "";
  const value = await readJsonSetting<{ teamId?: string }>(hookIndexKey(hookId), {});
  return String(value.teamId || "");
}

export async function readMetaConnections(teamId: string) {
  return readJsonSetting<MetaConnection[]>(connectionsKey(teamId), []);
}

export async function writeMetaConnections(teamId: string, connections: MetaConnection[]) {
  await writeJsonSetting(connectionsKey(teamId), connections);
}

export async function readLeadgenLog(teamId: string) {
  return readJsonSetting<MetaLeadgenLogEntry[]>(leadgenLogKey(teamId), []);
}

export async function appendLeadgenLog(teamId: string, entry: Omit<MetaLeadgenLogEntry, "id" | "at">) {
  const log = await readLeadgenLog(teamId);
  log.unshift({ id: `mlg_${randomUUID()}`, at: new Date().toISOString(), ...entry });
  await writeJsonSetting(leadgenLogKey(teamId), log.slice(0, 300));
}

export async function recordDeletionRequest(code: string, value: { teamId: string; fbUserId: string; removed: number; at: string }) {
  await writeJsonSetting(deletionKey(code), value);
}

export async function readDeletionRequest(code: string) {
  if (!/^[A-Za-z0-9]{8,64}$/u.test(code)) return null;
  return readJsonSetting<{ teamId: string; fbUserId: string; removed: number; at: string } | null>(deletionKey(code), null);
}

export function newHookId() {
  return randomBytes(12).toString("base64url");
}

export function newVerifyToken() {
  return randomBytes(24).toString("base64url");
}

// ---------- OAuth state（10 分钟、一次性） ----------
const oauthStates = new Map<string, { teamId: string; userId: string; returnTo: string; expiresAt: number }>();

export function createOAuthState(teamId: string, userId: string, returnTo: string) {
  const now = Date.now();
  for (const [key, value] of oauthStates) if (value.expiresAt < now) oauthStates.delete(key);
  const state = randomBytes(24).toString("base64url");
  oauthStates.set(state, { teamId, userId, returnTo, expiresAt: now + 10 * 60_000 });
  return state;
}

export function consumeOAuthState(state: string) {
  const value = oauthStates.get(state);
  oauthStates.delete(state);
  if (!value || value.expiresAt < Date.now()) return null;
  return value;
}

// ---------- Graph API ----------
export class MetaGraphError extends Error {
  constructor(message: string, readonly code: number, readonly subcode: number, readonly status: number) {
    super(message);
  }
}

/** Graph 常见错误翻成人话（附处理办法） */
export function metaErrorText(code: number, subcode: number, message: string) {
  if (code === 190) return "Facebook 授权已失效（可能改了密码、撤销了授权或令牌过期），请重新连接这个账号";
  if (code === 10 || code === 200 || (code >= 200 && code <= 299)) {
    return `Facebook 没有授予这项权限：${message}。请重新连接并在授权页勾选全部权限；对外开放前需要在 Meta 应用后台提交权限审核`;
  }
  if ([4, 17, 32, 613, 80000, 80004].includes(code)) return "Facebook 接口调用太频繁，稍后再试";
  if (code === 100 && subcode === 33) return "找不到这个对象，或当前账号无权访问";
  if (code === 368) return "Facebook 暂时限制了这个账号的操作";
  return message || "Facebook 接口返回错误";
}

export function appSecretProof(accessToken: string, appSecret: string) {
  return createHmac("sha256", appSecret).update(accessToken).digest("hex");
}

export async function metaGraph<T = Record<string, unknown>>(
  version: string,
  path: string,
  options: { token?: string; appSecret?: string; params?: Record<string, string | number | undefined>; method?: "GET" | "POST" | "DELETE" } = {}
): Promise<T> {
  const url = new URL(`${metaGraphBase()}/${version}/${path.replace(/^\/+/u, "")}`);
  for (const [key, value] of Object.entries(options.params || {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  if (options.token) {
    url.searchParams.set("access_token", options.token);
    if (options.appSecret) url.searchParams.set("appsecret_proof", appSecretProof(options.token, options.appSecret));
  }
  const response = await fetch(url, { method: options.method || "GET", signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  const error = body.error as { message?: string; code?: number; error_subcode?: number } | undefined;
  if (!response.ok || error) {
    const code = Number(error?.code || 0);
    const subcode = Number(error?.error_subcode || 0);
    throw new MetaGraphError(metaErrorText(code, subcode, String(error?.message || `HTTP ${response.status}`)), code, subcode, response.status);
  }
  return body as T;
}

/** 翻页读取（最多 maxPages 页），用于主页 / 广告账户 / 表单 / 线索列表 */
export async function metaGraphAll<T>(version: string, path: string, options: Parameters<typeof metaGraph>[2], maxPages = 5): Promise<T[]> {
  const items: T[] = [];
  let after = "";
  for (let page = 0; page < maxPages; page += 1) {
    const body = await metaGraph<{ data?: T[]; paging?: { cursors?: { after?: string }; next?: string } }>(version, path, {
      ...options,
      params: { ...(options?.params || {}), ...(after ? { after } : {}) }
    });
    items.push(...(body.data || []));
    after = body.paging?.next ? String(body.paging?.cursors?.after || "") : "";
    if (!after) break;
  }
  return items;
}

// ---------- Webhook 签名 / signed_request ----------
export function verifyMetaSignature(rawBody: Buffer | undefined, header: string, appSecret: string) {
  if (!rawBody || !appSecret) return false;
  const match = /^sha256=([a-f0-9]{64})$/iu.exec(String(header || "").trim());
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const supplied = Buffer.from(match[1]!, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** 解析 Meta 的 signed_request（取消授权 / 数据删除回调都用它） */
export function parseSignedRequest(signedRequest: string, appSecret: string): { user_id?: string; algorithm?: string } | null {
  const [signature, payload] = String(signedRequest || "").split(".", 2);
  if (!signature || !payload || !appSecret) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  const supplied = Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as { user_id?: string; algorithm?: string };
    return String(data.algorithm || "").toUpperCase() === "HMAC-SHA256" ? data : null;
  } catch {
    return null;
  }
}

// ---------- 连接资料 ----------
export interface MetaGraphPageRow {
  id: string;
  name: string;
  category?: string;
  access_token?: string;
  tasks?: string[];
  picture?: { data?: { url?: string } };
}

export interface MetaGraphAdAccountRow {
  id: string;
  account_id?: string;
  name?: string;
  currency?: string;
  account_status?: number;
  business?: { name?: string };
}

/** 用用户令牌拉一遍：本人资料、授权情况、能管理的主页（含主页令牌）、广告账户 */
export async function fetchMetaProfile(teamId: string, version: string, appSecret: string, userToken: string) {
  const me = await metaGraph<{ id: string; name?: string; picture?: { data?: { url?: string } } }>(version, "me", {
    token: userToken, appSecret, params: { fields: "id,name,picture.type(small)" }
  });
  const permissions = await metaGraph<{ data?: Array<{ permission: string; status: string }> }>(version, "me/permissions", { token: userToken, appSecret });
  const pages = await metaGraphAll<MetaGraphPageRow>(version, "me/accounts", {
    token: userToken, appSecret, params: { fields: "id,name,category,access_token,tasks,picture.type(small)", limit: 100 }
  });
  let adAccounts: MetaGraphAdAccountRow[] = [];
  try {
    adAccounts = await metaGraphAll<MetaGraphAdAccountRow>(version, "me/adaccounts", {
      token: userToken, appSecret, params: { fields: "id,account_id,name,currency,account_status,business{name}", limit: 100 }
    });
  } catch {
    // 没授权 ads_read 时主页照样能用，广告区显示提示
    adAccounts = [];
  }
  return {
    me,
    granted: (permissions.data || []).filter((item) => item.status === "granted").map((item) => item.permission),
    declined: (permissions.data || []).filter((item) => item.status !== "granted").map((item) => item.permission),
    pages: pages.map((page): MetaPage => ({
      id: page.id,
      name: page.name,
      category: page.category || "",
      pictureUrl: page.picture?.data?.url || "",
      tokenEnc: page.access_token ? encryptMetaSecret(teamId, `page:${page.id}`, page.access_token) : "",
      tasks: page.tasks || [],
      leadgenSubscribed: false
    })),
    adAccounts: adAccounts.map((account): MetaAdAccount => ({
      id: account.id,
      accountId: account.account_id || account.id.replace(/^act_/u, ""),
      name: account.name || account.id,
      currency: account.currency || "",
      status: Number(account.account_status || 0),
      business: account.business?.name || ""
    }))
  };
}

export function pageToken(teamId: string, page: MetaPage) {
  return decryptMetaSecret(teamId, `page:${page.id}`, page.tokenEnc);
}

export function findPage(connections: MetaConnection[], pageId: string) {
  for (const connection of connections) {
    const page = connection.pages.find((item) => item.id === pageId);
    if (page) return { connection, page };
  }
  return null;
}

export function findAdAccount(connections: MetaConnection[], accountId: string) {
  const normalized = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
  for (const connection of connections) {
    const account = connection.adAccounts.find((item) => item.id === normalized);
    if (account) return { connection, account };
  }
  return null;
}
