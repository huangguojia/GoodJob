/**
 * 社媒中心路由：Facebook（Meta 官方接口）。
 *
 * 读：integration.read；改应用配置 / 订阅表单：integration.manage；连接 / 断开自己的账号：integration.connect。
 * 公开端点（Meta 服务器调用）：OAuth 回调、Webhook 校验与推送、取消授权回调、数据删除回调与状态查询。
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { hasIamPermission, publicUser, requireAuth } from "../auth.js";
import { emitCrmEvent } from "../crm-events.js";
import { normalizeLeadAdsPayload } from "../lead-ads-ingress.js";
import { getStore } from "../store.js";
import { asyncRoute, createLeadFromSource } from "../server-core.js";
import { resolveLeadAdsOwner } from "./lead-ads.js";
import {
  META_DEFAULT_GRAPH_VERSION,
  META_SCOPES,
  MetaGraphError,
  appendLeadgenLog,
  consumeOAuthState,
  createOAuthState,
  decryptMetaSecret,
  encryptMetaSecret,
  fetchMetaProfile,
  findAdAccount,
  findPage,
  metaDialogBase,
  metaGraph,
  metaGraphAll,
  newHookId,
  newVerifyToken,
  pageToken,
  parseSignedRequest,
  readDeletionRequest,
  readLeadgenLog,
  readMetaApp,
  readMetaConnections,
  recordDeletionRequest,
  teamOfHook,
  verifyMetaSignature,
  writeMetaApp,
  writeMetaConnections,
  type MetaAppSettings,
  type MetaConnection,
  type MetaPage
} from "../social-meta.js";

const webhookLimiter = rateLimit({
  windowMs: 60_000,
  limit: ["test", "e2e"].includes(process.env.NODE_ENV || "") ? 10_000 : 600,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

/** 对外地址：部署时用环境变量固定；没配就按当前请求推导（本地调试） */
function publicBase(req: Request) {
  const configured = String(process.env.SOCIAL_PUBLIC_BASE_URL || process.env.GOODJOB_PUBLIC_BASE_URL || "").trim();
  if (configured) return configured.replace(/\/+$/u, "");
  const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0]!.trim();
  const host = String(req.headers["x-forwarded-host"] || req.get("host") || "").split(",")[0]!.trim();
  return `${proto}://${host}`;
}

function callbackUrls(req: Request, hookId: string) {
  const base = publicBase(req);
  return {
    redirectUri: `${base}/api/social/meta/oauth/callback`,
    webhookUrl: `${base}/api/social/meta/webhook/${hookId}`,
    deauthorizeUrl: `${base}/api/social/meta/deauthorize/${hookId}`,
    dataDeletionUrl: `${base}/api/social/meta/data-deletion/${hookId}`
  };
}

function appSecretOf(teamId: string, app: MetaAppSettings) {
  return decryptMetaSecret(teamId, "app-secret", app.appSecretEnc);
}

function deny(res: Response, message: string) {
  res.status(403).json({ message });
}

function graphFailure(res: Response, error: unknown) {
  if (error instanceof MetaGraphError) {
    res.status(error.code === 190 ? 409 : 502).json({ message: error.message, code: error.code });
    return;
  }
  res.status(502).json({ message: error instanceof Error ? error.message : "Facebook 接口调用失败" });
}

/** 连接资料对前端的样子：不带任何令牌 */
function publicConnection(connection: MetaConnection) {
  return {
    id: connection.id,
    platform: connection.platform,
    fbUserId: connection.fbUserId,
    name: connection.name,
    pictureUrl: connection.pictureUrl,
    connectedBy: connection.connectedBy,
    connectedByName: connection.connectedByName,
    connectedAt: connection.connectedAt,
    refreshedAt: connection.refreshedAt,
    tokenExpiresAt: connection.tokenExpiresAt,
    grantedScopes: connection.grantedScopes,
    declinedScopes: connection.declinedScopes,
    pages: connection.pages.map((page) => ({ id: page.id, name: page.name, category: page.category, pictureUrl: page.pictureUrl, tasks: page.tasks, leadgenSubscribed: page.leadgenSubscribed, hasToken: Boolean(page.tokenEnc) })),
    adAccounts: connection.adAccounts
  };
}

/** 把一条 Graph 线索写进 CRM 线索池（幂等：同一个 leadgen_id 只建一次） */
async function ingestMetaLead(teamId: string, app: MetaAppSettings, connection: MetaConnection, page: MetaPage, leadgenId: string, via: "webhook" | "backfill", prefetched?: Record<string, unknown>) {
  const secret = appSecretOf(teamId, app);
  const token = pageToken(teamId, page);
  try {
    const lead = prefetched || await metaGraph<Record<string, unknown>>(app.graphVersion, leadgenId, {
      token, appSecret: secret,
      params: { fields: "id,created_time,field_data,ad_id,ad_name,adset_name,campaign_name,form_id,platform" }
    });
    const normalized = normalizeLeadAdsPayload({ field_data: lead.field_data, form_name: "", campaign_name: lead.campaign_name || lead.ad_name || "" });
    const ownerUser = getStore().users.find((user) => user.id === (app.leadOwnerId || connection.connectedBy) && user.status === "active");
    const owner = ownerUser && hasIamPermission(publicUser(ownerUser), "lead.create") ? publicUser(ownerUser) : resolveLeadAdsOwner("");
    if (!owner) throw new Error("没有可用的线索归属账号（需要有新建线索权限的启用账号）");
    const campaign = [lead.campaign_name, lead.adset_name, lead.ad_name].filter(Boolean).map(String).join(" / ");
    const result = createLeadFromSource(owner, {
      ...normalized,
      externalId: `meta:${String(lead.id || leadgenId)}`,
      sourceCampaign: campaign.slice(0, 160) || normalized.sourceCampaign,
      source: `Facebook 表单 · ${page.name}`.slice(0, 80),
      wechat: "",
      intent: "中",
      stage: "新线索",
      estimatedAmount: 0,
      nextFollowAt: "",
      sourceType: "inbound",
      sourceChannel: "facebook_lead_ads",
      sourceUrl: "",
      occurredAt: String(lead.created_time || new Date().toISOString())
    });
    await getStore().persist();
    await appendLeadgenLog(teamId, { via, pageId: page.id, formId: String(lead.form_id || ""), leadgenId, leadId: result.lead.id, status: result.duplicate ? "duplicate" : "created", message: result.duplicate ? "这条线索已经在线索池里" : `已建线索：${result.lead.company}` });
    if (!result.duplicate) {
      emitCrmEvent({ type: "lead.ads", teamId: result.lead.teamId, ownerId: result.lead.ownerId, leadId: result.lead.id, company: result.lead.company, contact: result.lead.contact, email: result.lead.email, phone: result.lead.phone, campaign, channel: "Meta 直连", occurredAt: new Date().toISOString() });
    }
    return { ok: true, duplicate: result.duplicate, leadId: result.lead.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "拉取线索失败";
    await appendLeadgenLog(teamId, { via, pageId: page.id, formId: "", leadgenId, leadId: "", status: "failed", message });
    return { ok: false, duplicate: false, leadId: "", message };
  }
}

const appSchema = z.object({
  appId: z.string().trim().regex(/^\d{6,20}$/u, "App ID 是一串数字"),
  appSecret: z.string().trim().max(120).optional(),
  graphVersion: z.string().trim().regex(/^v\d{1,2}\.\d$/u, "Graph API 版本格式如 v23.0").default(META_DEFAULT_GRAPH_VERSION),
  leadOwnerId: z.string().trim().max(100).default("")
});

export function registerSocialRoutes(app: Express) {
  // ---------- 总览 ----------
  app.get("/api/social/overview", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.read")) return deny(res, "没有查看社媒账号的权限");
    const teamId = req.user!.teamId;
    const metaApp = await readMetaApp(teamId);
    const connections = await readMetaConnections(teamId);
    const log = await readLeadgenLog(teamId);
    const canManage = hasIamPermission(req.user, "integration.manage");
    const urls = metaApp ? callbackUrls(req, metaApp.hookId) : { ...callbackUrls(req, "（保存应用后生成）"), webhookUrl: "", deauthorizeUrl: "", dataDeletionUrl: "" };
    res.json({
      meta: {
        configured: Boolean(metaApp),
        appId: metaApp?.appId || "",
        graphVersion: metaApp?.graphVersion || META_DEFAULT_GRAPH_VERSION,
        leadOwnerId: metaApp?.leadOwnerId || "",
        secretSet: Boolean(metaApp?.appSecretEnc),
        verifyToken: metaApp && canManage ? decryptMetaSecret(teamId, "verify-token", metaApp.verifyTokenEnc) : "",
        scopes: META_SCOPES,
        ...urls
      },
      connections: connections.map(publicConnection),
      leadgen: {
        recent: log.slice(0, 30),
        today: log.filter((item) => item.status === "created" && item.at.slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
        total: log.filter((item) => item.status === "created").length
      },
      owners: getStore().users
        .filter((user) => user.teamId === teamId && user.status === "active" && hasIamPermission(publicUser(user), "lead.create"))
        .map((user) => ({ id: user.id, name: user.name, email: user.email })),
      canManage,
      canConnect: hasIamPermission(req.user, "integration.connect") || canManage
    });
  }));

  // ---------- Meta 应用配置 ----------
  app.put("/api/social/meta/app", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.manage")) return deny(res, "只有管理员可以配置 Meta 应用");
    const body = appSchema.parse(req.body);
    const teamId = req.user!.teamId;
    const current = await readMetaApp(teamId);
    if (!current && !body.appSecret) {
      res.status(400).json({ message: "第一次配置需要填写 App Secret" });
      return;
    }
    const next: MetaAppSettings = {
      appId: body.appId,
      appSecretEnc: body.appSecret ? encryptMetaSecret(teamId, "app-secret", body.appSecret) : current!.appSecretEnc,
      graphVersion: body.graphVersion,
      hookId: current?.hookId || newHookId(),
      verifyTokenEnc: current?.verifyTokenEnc || encryptMetaSecret(teamId, "verify-token", newVerifyToken()),
      leadOwnerId: body.leadOwnerId,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user!.id
    };
    // 换了应用：旧应用签发的令牌对新应用无效，连接必须重新授权
    if (current && current.appId !== next.appId) await writeMetaConnections(teamId, []);
    await writeMetaApp(teamId, next);
    res.json({ ok: true });
  }));

  // ---------- 授权 ----------
  app.post("/api/social/meta/oauth/start", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.connect") && !hasIamPermission(req.user, "integration.manage")) return deny(res, "没有连接社媒账号的权限");
    const teamId = req.user!.teamId;
    const metaApp = await readMetaApp(teamId);
    if (!metaApp) {
      res.status(400).json({ message: "请先由管理员填写 Meta 应用的 App ID 和 App Secret" });
      return;
    }
    const origin = String(req.headers.origin || "").trim();
    const returnTo = /^https?:\/\/[^/\s]+$/u.test(origin) ? origin : publicBase(req);
    const state = createOAuthState(teamId, req.user!.id, returnTo);
    const url = new URL(`${metaDialogBase()}/${metaApp.graphVersion}/dialog/oauth`);
    url.searchParams.set("client_id", metaApp.appId);
    url.searchParams.set("redirect_uri", callbackUrls(req, metaApp.hookId).redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", META_SCOPES.join(","));
    // 用户上次没勾的权限，再次授权时重新询问
    url.searchParams.set("auth_type", "rerequest");
    res.json({ url: url.toString() });
  }));

  app.get("/api/social/meta/oauth/callback", asyncRoute(async (req, res) => {
    const state = consumeOAuthState(String(req.query.state || ""));
    const back = (returnTo: string, status: "ok" | "error", message: string) => {
      const target = new URL(returnTo || "/", publicBase(req));
      target.searchParams.set("social_oauth", status);
      if (message) target.searchParams.set("social_message", message.slice(0, 200));
      res.redirect(302, target.toString());
    };
    if (!state) {
      res.status(400).type("text/plain; charset=utf-8").send("授权链接已过期或无效，请回到 CRM 重新点「连接 Facebook」。");
      return;
    }
    if (req.query.error) {
      back(state.returnTo, "error", String(req.query.error_description || "你取消了 Facebook 授权"));
      return;
    }
    const code = String(req.query.code || "");
    const metaApp = await readMetaApp(state.teamId);
    if (!code || !metaApp) {
      back(state.returnTo, "error", "授权回调缺少参数");
      return;
    }
    const secret = appSecretOf(state.teamId, metaApp);
    try {
      const short = await metaGraph<{ access_token: string }>(metaApp.graphVersion, "oauth/access_token", {
        params: { client_id: metaApp.appId, client_secret: secret, redirect_uri: callbackUrls(req, metaApp.hookId).redirectUri, code }
      });
      const long = await metaGraph<{ access_token: string; expires_in?: number }>(metaApp.graphVersion, "oauth/access_token", {
        params: { grant_type: "fb_exchange_token", client_id: metaApp.appId, client_secret: secret, fb_exchange_token: short.access_token }
      });
      const profile = await fetchMetaProfile(state.teamId, metaApp.graphVersion, secret, long.access_token);
      const user = getStore().users.find((item) => item.id === state.userId);
      const connections = await readMetaConnections(state.teamId);
      const existing = connections.find((item) => item.fbUserId === profile.me.id);
      const now = new Date().toISOString();
      const connection: MetaConnection = {
        id: existing?.id || `metac_${randomBytes(8).toString("hex")}`,
        platform: "facebook",
        fbUserId: profile.me.id,
        name: profile.me.name || profile.me.id,
        pictureUrl: profile.me.picture?.data?.url || "",
        connectedBy: state.userId,
        connectedByName: user?.name || "",
        connectedAt: existing?.connectedAt || now,
        refreshedAt: now,
        userTokenEnc: encryptMetaSecret(state.teamId, `user:${profile.me.id}`, long.access_token),
        tokenExpiresAt: long.expires_in ? new Date(Date.now() + long.expires_in * 1000).toISOString() : "",
        grantedScopes: profile.granted,
        declinedScopes: profile.declined,
        pages: profile.pages.map((page) => ({ ...page, leadgenSubscribed: existing?.pages.find((old) => old.id === page.id)?.leadgenSubscribed || false })),
        adAccounts: profile.adAccounts
      };
      await writeMetaConnections(state.teamId, [connection, ...connections.filter((item) => item.id !== connection.id)]);
      back(state.returnTo, "ok", `已连接 ${connection.name}：${connection.pages.length} 个主页、${connection.adAccounts.length} 个广告账户`);
    } catch (error) {
      back(state.returnTo, "error", error instanceof Error ? error.message : "授权失败");
    }
  }));

  app.post("/api/social/meta/connections/:id/refresh", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.read")) return deny(res, "没有查看社媒账号的权限");
    const teamId = req.user!.teamId;
    const metaApp = await readMetaApp(teamId);
    const connections = await readMetaConnections(teamId);
    const connection = connections.find((item) => item.id === req.params.id);
    if (!metaApp || !connection) {
      res.status(404).json({ message: "找不到这个连接" });
      return;
    }
    try {
      const token = decryptMetaSecret(teamId, `user:${connection.fbUserId}`, connection.userTokenEnc);
      const profile = await fetchMetaProfile(teamId, metaApp.graphVersion, appSecretOf(teamId, metaApp), token);
      connection.name = profile.me.name || connection.name;
      connection.pictureUrl = profile.me.picture?.data?.url || connection.pictureUrl;
      connection.grantedScopes = profile.granted;
      connection.declinedScopes = profile.declined;
      connection.pages = profile.pages.map((page) => ({ ...page, leadgenSubscribed: connection.pages.find((old) => old.id === page.id)?.leadgenSubscribed || false }));
      connection.adAccounts = profile.adAccounts;
      connection.refreshedAt = new Date().toISOString();
      await writeMetaConnections(teamId, connections);
      res.json({ connection: publicConnection(connection) });
    } catch (error) {
      graphFailure(res, error);
    }
  }));

  /** 断开：先在 Meta 那边撤销授权，再删本地令牌（撤销失败也删本地，并如实告知） */
  app.delete("/api/social/meta/connections/:id", requireAuth, asyncRoute(async (req, res) => {
    const teamId = req.user!.teamId;
    const connections = await readMetaConnections(teamId);
    const connection = connections.find((item) => item.id === req.params.id);
    if (!connection) {
      res.status(404).json({ message: "找不到这个连接" });
      return;
    }
    const canManage = hasIamPermission(req.user, "integration.manage");
    if (!canManage && connection.connectedBy !== req.user!.id) return deny(res, "只能断开自己连接的账号");
    const metaApp = await readMetaApp(teamId);
    let revoked = false;
    let revokeError = "";
    if (metaApp) {
      try {
        const token = decryptMetaSecret(teamId, `user:${connection.fbUserId}`, connection.userTokenEnc);
        await metaGraph(metaApp.graphVersion, `${connection.fbUserId}/permissions`, { token, appSecret: appSecretOf(teamId, metaApp), method: "DELETE" });
        revoked = true;
      } catch (error) {
        revokeError = error instanceof Error ? error.message : "撤销失败";
      }
    }
    await writeMetaConnections(teamId, connections.filter((item) => item.id !== connection.id));
    res.json({ ok: true, revoked, message: revoked ? "已在 Facebook 撤销授权并删除本地令牌" : `本地令牌已删除；Facebook 端撤销没成功（${revokeError || "应用未配置"}），可在 Facebook 设置 → 应用和网站里手动移除` });
  }));

  // ---------- 主页 ----------
  app.get("/api/social/meta/pages/:pageId", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.read")) return deny(res, "没有查看社媒账号的权限");
    const teamId = req.user!.teamId;
    const metaApp = await readMetaApp(teamId);
    const found = findPage(await readMetaConnections(teamId), String(req.params.pageId));
    if (!metaApp || !found) {
      res.status(404).json({ message: "找不到这个主页，请先连接拥有它的 Facebook 账号" });
      return;
    }
    const token = pageToken(teamId, found.page);
    const secret = appSecretOf(teamId, metaApp);
    try {
      const page = await metaGraph<Record<string, unknown>>(metaApp.graphVersion, found.page.id, {
        token, appSecret: secret,
        params: { fields: "id,name,category,about,link,fan_count,followers_count,picture.type(large){url},cover{source},verification_status" }
      });
      const posts = await metaGraph<{ data?: Array<Record<string, unknown>> }>(metaApp.graphVersion, `${found.page.id}/posts`, {
        token, appSecret: secret,
        params: { fields: "id,message,created_time,permalink_url,full_picture,status_type,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)", limit: 12 }
      });
      res.json({
        page: {
          id: String(page.id || found.page.id),
          name: String(page.name || found.page.name),
          category: String(page.category || ""),
          about: String(page.about || ""),
          link: String(page.link || ""),
          fans: Number(page.fan_count || 0),
          followers: Number(page.followers_count || 0),
          pictureUrl: String(((page.picture as Record<string, unknown> | undefined)?.data as Record<string, unknown> | undefined)?.url || found.page.pictureUrl),
          coverUrl: String((page.cover as Record<string, unknown> | undefined)?.source || ""),
          leadgenSubscribed: found.page.leadgenSubscribed
        },
        posts: (posts.data || []).map((post) => ({
          id: String(post.id),
          message: String(post.message || ""),
          createdAt: String(post.created_time || ""),
          permalink: String(post.permalink_url || ""),
          picture: String(post.full_picture || ""),
          reactions: Number(((post.reactions as Record<string, unknown> | undefined)?.summary as Record<string, unknown> | undefined)?.total_count || 0),
          comments: Number(((post.comments as Record<string, unknown> | undefined)?.summary as Record<string, unknown> | undefined)?.total_count || 0),
          shares: Number((post.shares as Record<string, unknown> | undefined)?.count || 0)
        }))
      });
    } catch (error) {
      graphFailure(res, error);
    }
  }));

  // ---------- 广告 ----------
  app.get("/api/social/meta/adaccounts/:accountId/campaigns", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.read")) return deny(res, "没有查看广告数据的权限");
    const teamId = req.user!.teamId;
    const metaApp = await readMetaApp(teamId);
    const connections = await readMetaConnections(teamId);
    const found = findAdAccount(connections, String(req.params.accountId));
    if (!metaApp || !found) {
      res.status(404).json({ message: "找不到这个广告账户" });
      return;
    }
    const preset = ["today", "yesterday", "last_7d", "last_30d", "this_month", "last_month", "maximum"].includes(String(req.query.range))
      ? String(req.query.range) : "last_30d";
    const token = decryptMetaSecret(teamId, `user:${found.connection.fbUserId}`, found.connection.userTokenEnc);
    const secret = appSecretOf(teamId, metaApp);
    const leadsOf = (actions: unknown) => (Array.isArray(actions) ? actions : [])
      .filter((item: { action_type?: string }) => ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"].includes(String(item.action_type)))
      .reduce((max: number, item: { value?: string }) => Math.max(max, Number(item.value || 0)), 0);
    try {
      const [campaigns, insights, summary] = await Promise.all([
        metaGraphAll<Record<string, unknown>>(metaApp.graphVersion, `${found.account.id}/campaigns`, {
          token, appSecret: secret,
          params: { fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,start_time,stop_time", limit: 100 }
        }, 3),
        metaGraphAll<Record<string, unknown>>(metaApp.graphVersion, `${found.account.id}/insights`, {
          token, appSecret: secret,
          params: { level: "campaign", date_preset: preset, fields: "campaign_id,spend,impressions,reach,clicks,ctr,cpc,cpm,actions", limit: 200 }
        }, 3),
        metaGraph<{ data?: Array<Record<string, unknown>> }>(metaApp.graphVersion, `${found.account.id}/insights`, {
          token, appSecret: secret,
          params: { date_preset: preset, fields: "spend,impressions,reach,clicks,ctr,cpc,actions" }
        })
      ]);
      const byCampaign = new Map(insights.map((row) => [String(row.campaign_id), row]));
      const total = summary.data?.[0] || {};
      res.json({
        account: found.account,
        range: preset,
        summary: {
          spend: Number(total.spend || 0),
          impressions: Number(total.impressions || 0),
          reach: Number(total.reach || 0),
          clicks: Number(total.clicks || 0),
          ctr: Number(total.ctr || 0),
          cpc: Number(total.cpc || 0),
          leads: leadsOf(total.actions)
        },
        campaigns: campaigns.map((campaign) => {
          const row = byCampaign.get(String(campaign.id)) || {};
          return {
            id: String(campaign.id),
            name: String(campaign.name || ""),
            status: String(campaign.effective_status || campaign.status || ""),
            objective: String(campaign.objective || ""),
            dailyBudget: Number(campaign.daily_budget || 0) / 100,
            lifetimeBudget: Number(campaign.lifetime_budget || 0) / 100,
            startTime: String(campaign.start_time || ""),
            stopTime: String(campaign.stop_time || ""),
            spend: Number(row.spend || 0),
            impressions: Number(row.impressions || 0),
            clicks: Number(row.clicks || 0),
            ctr: Number(row.ctr || 0),
            cpc: Number(row.cpc || 0),
            leads: leadsOf(row.actions)
          };
        })
      });
    } catch (error) {
      graphFailure(res, error);
    }
  }));

  // ---------- 表单线索 ----------
  app.get("/api/social/meta/pages/:pageId/leadforms", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.read")) return deny(res, "没有查看表单的权限");
    const teamId = req.user!.teamId;
    const metaApp = await readMetaApp(teamId);
    const connections = await readMetaConnections(teamId);
    const found = findPage(connections, String(req.params.pageId));
    if (!metaApp || !found) {
      res.status(404).json({ message: "找不到这个主页" });
      return;
    }
    const token = pageToken(teamId, found.page);
    const secret = appSecretOf(teamId, metaApp);
    try {
      const forms = await metaGraphAll<Record<string, unknown>>(metaApp.graphVersion, `${found.page.id}/leadgen_forms`, {
        token, appSecret: secret, params: { fields: "id,name,status,leads_count,created_time,locale", limit: 100 }
      }, 3);
      // 顺便核对一次 Webhook 订阅状态，以 Meta 为准
      try {
        const subscribed = await metaGraph<{ data?: Array<{ id?: string; subscribed_fields?: string[] }> }>(metaApp.graphVersion, `${found.page.id}/subscribed_apps`, { token, appSecret: secret });
        const actual = (subscribed.data || []).some((item) => String(item.id) === metaApp.appId && (item.subscribed_fields || []).includes("leadgen"));
        if (actual !== found.page.leadgenSubscribed) {
          found.page.leadgenSubscribed = actual;
          await writeMetaConnections(teamId, connections);
        }
      } catch {
        // 订阅状态读不到不影响看表单
      }
      res.json({
        leadgenSubscribed: found.page.leadgenSubscribed,
        forms: forms.map((form) => ({
          id: String(form.id),
          name: String(form.name || ""),
          status: String(form.status || ""),
          leadsCount: Number(form.leads_count || 0),
          createdAt: String(form.created_time || ""),
          locale: String(form.locale || "")
        }))
      });
    } catch (error) {
      graphFailure(res, error);
    }
  }));

  app.post("/api/social/meta/pages/:pageId/leadgen/subscribe", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.manage")) return deny(res, "只有管理员可以开启表单线索直连");
    const teamId = req.user!.teamId;
    const metaApp = await readMetaApp(teamId);
    const connections = await readMetaConnections(teamId);
    const found = findPage(connections, String(req.params.pageId));
    if (!metaApp || !found) {
      res.status(404).json({ message: "找不到这个主页" });
      return;
    }
    const subscribe = req.body?.subscribe !== false;
    try {
      await metaGraph(metaApp.graphVersion, `${found.page.id}/subscribed_apps`, {
        token: pageToken(teamId, found.page),
        appSecret: appSecretOf(teamId, metaApp),
        method: subscribe ? "POST" : "DELETE",
        params: subscribe ? { subscribed_fields: "leadgen" } : {}
      });
      found.page.leadgenSubscribed = subscribe;
      await writeMetaConnections(teamId, connections);
      res.json({ ok: true, leadgenSubscribed: subscribe });
    } catch (error) {
      graphFailure(res, error);
    }
  }));

  /** 手动回填：把某张表单最近的线索拉进来（已存在的跳过） */
  app.post("/api/social/meta/forms/:formId/backfill", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "lead.create") || !hasIamPermission(req.user, "integration.read")) return deny(res, "没有导入线索的权限");
    const teamId = req.user!.teamId;
    const metaApp = await readMetaApp(teamId);
    const connections = await readMetaConnections(teamId);
    const found = findPage(connections, String(req.body?.pageId || ""));
    if (!metaApp || !found) {
      res.status(404).json({ message: "找不到这张表单所在的主页" });
      return;
    }
    try {
      const leads = await metaGraphAll<Record<string, unknown>>(metaApp.graphVersion, `${String(req.params.formId)}/leads`, {
        token: pageToken(teamId, found.page),
        appSecret: appSecretOf(teamId, metaApp),
        params: { fields: "id,created_time,field_data,ad_id,ad_name,adset_name,campaign_name,form_id", limit: 50 }
      }, 4);
      let created = 0;
      let duplicate = 0;
      let failed = 0;
      for (const lead of leads) {
        const result = await ingestMetaLead(teamId, metaApp, found.connection, found.page, String(lead.id), "backfill", lead);
        if (!result.ok) failed += 1;
        else if (result.duplicate) duplicate += 1;
        else created += 1;
      }
      res.json({ total: leads.length, created, duplicate, failed });
    } catch (error) {
      graphFailure(res, error);
    }
  }));

  // ---------- Meta 回调（公开） ----------
  /** Webhook 订阅校验：Meta 后台点「验证并保存」时调 */
  app.get("/api/social/meta/webhook/:hookId", webhookLimiter, asyncRoute(async (req, res) => {
    const teamId = await teamOfHook(String(req.params.hookId));
    const metaApp = teamId ? await readMetaApp(teamId) : null;
    const expected = metaApp ? decryptMetaSecret(teamId, "verify-token", metaApp.verifyTokenEnc) : "";
    if (req.query["hub.mode"] === "subscribe" && expected && req.query["hub.verify_token"] === expected) {
      res.type("text/plain").send(String(req.query["hub.challenge"] || ""));
      return;
    }
    res.sendStatus(403);
  }));

  /** Webhook 推送：签名不对直接 401；处理失败也回 200（避免 Meta 反复重试），失败写进接收记录 */
  app.post("/api/social/meta/webhook/:hookId", webhookLimiter, asyncRoute(async (req, res) => {
    const teamId = await teamOfHook(String(req.params.hookId));
    const metaApp = teamId ? await readMetaApp(teamId) : null;
    if (!metaApp) {
      res.sendStatus(404);
      return;
    }
    const raw = (req as Request & { socialRawBody?: Buffer }).socialRawBody;
    if (!verifyMetaSignature(raw, String(req.headers["x-hub-signature-256"] || ""), appSecretOf(teamId, metaApp))) {
      res.sendStatus(401);
      return;
    }
    const body = req.body as { object?: string; entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: Record<string, unknown> }> }> };
    const connections = await readMetaConnections(teamId);
    let handled = 0;
    if (body.object === "page") {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          if (change.field !== "leadgen" || !change.value) continue;
          const pageId = String(change.value.page_id || entry.id || "");
          const leadgenId = String(change.value.leadgen_id || "");
          const found = findPage(connections, pageId);
          if (!found || !leadgenId) {
            await appendLeadgenLog(teamId, { via: "webhook", pageId, formId: String(change.value.form_id || ""), leadgenId, leadId: "", status: "failed", message: "收到了线索通知，但这个主页没有在 CRM 里连接" });
            continue;
          }
          await ingestMetaLead(teamId, metaApp, found.connection, found.page, leadgenId, "webhook");
          handled += 1;
        }
      }
    }
    res.json({ received: true, handled });
  }));

  /** 取消授权回调：用户在 Facebook 里移除了这个应用 → 删掉对应连接 */
  app.post("/api/social/meta/deauthorize/:hookId", webhookLimiter, asyncRoute(async (req, res) => {
    const teamId = await teamOfHook(String(req.params.hookId));
    const metaApp = teamId ? await readMetaApp(teamId) : null;
    const data = metaApp ? parseSignedRequest(String(req.body?.signed_request || ""), appSecretOf(teamId, metaApp)) : null;
    if (!data?.user_id) {
      res.sendStatus(400);
      return;
    }
    const connections = await readMetaConnections(teamId);
    await writeMetaConnections(teamId, connections.filter((item) => item.fbUserId !== String(data.user_id)));
    res.json({ ok: true });
  }));

  /** 数据删除请求回调：删除该用户在 CRM 里的 Facebook 连接数据，返回查询地址与确认码（Meta 平台规定格式） */
  app.post("/api/social/meta/data-deletion/:hookId", webhookLimiter, asyncRoute(async (req, res) => {
    const teamId = await teamOfHook(String(req.params.hookId));
    const metaApp = teamId ? await readMetaApp(teamId) : null;
    const data = metaApp ? parseSignedRequest(String(req.body?.signed_request || ""), appSecretOf(teamId, metaApp)) : null;
    if (!data?.user_id) {
      res.sendStatus(400);
      return;
    }
    const connections = await readMetaConnections(teamId);
    const kept = connections.filter((item) => item.fbUserId !== String(data.user_id));
    await writeMetaConnections(teamId, kept);
    const code = randomBytes(12).toString("hex");
    await recordDeletionRequest(code, { teamId, fbUserId: String(data.user_id), removed: connections.length - kept.length, at: new Date().toISOString() });
    res.json({ url: `${publicBase(req)}/api/social/meta/data-deletion-status/${code}`, confirmation_code: code });
  }));

  app.get("/api/social/meta/data-deletion-status/:code", webhookLimiter, asyncRoute(async (req, res) => {
    const record = await readDeletionRequest(String(req.params.code));
    res.type("text/plain; charset=utf-8").send(record
      ? `删除请求 ${req.params.code} 已于 ${record.at} 处理完成：该 Facebook 账号在 GoodJob CRM 中的授权令牌与连接资料已全部删除。`
      : "找不到这个删除请求编号。");
  }));
}
