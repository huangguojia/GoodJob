/**
 * 广告表单入站路由（Facebook Lead Ads → 中转服务 → CRM）。
 *
 * 为什么不是 Meta 直连：读真实 Lead Ads 数据需要 App Review + 企业验证。
 * 没有企业主体时，走已过审的第三方中转（Make / Zapier / LeadSync），
 * 它们把表单字段 POST 到这里，本接口只做「验 token → 归一化 → 幂等写入线索」。
 *
 * 安全边界（与官网询盘入口同级）：
 *  - 不接受 cookie / 登录态 / ownerId，token 唯一凭据，常数时间比较；
 *  - 只创建线索，不提供任何其它 CRM 操作；
 *  - 归属账号由服务端解析，请求体改不了；
 *  - 独立限流；响应不回显任何客户数据。
 */
import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { canSeeOwner, hasIamPermission, publicUser, requireAuth } from "../auth.js";
import { getStore } from "../store.js";
import { asyncRoute, createLeadFromSource, enforceIamTenantPermission } from "../server-core.js";
import { hasLeadAdsContent, normalizeLeadAdsPayload } from "../lead-ads-ingress.js";
import {
  generateLeadAdsIngressToken,
  leadAdsTokenMatches,
  readLeadAdsIngressSettings,
  writeLeadAdsIngressSettings
} from "../lead-ads-ingress-settings.js";

export const LEAD_ADS_SOURCE_CHANNEL = "facebook_lead_ads";

/** 中转平台要填的公网地址；部署域名固定，环境变量只用来覆盖调试。 */
function leadAdsPublicBaseUrl() {
  const configured = String(process.env.LEAD_ADS_PUBLIC_BASE_URL || process.env.GOODJOB_PUBLIC_BASE_URL || "").trim();
  return (configured || "https://www.goodjobcrm.com").replace(/\/+$/u, "");
}

const leadAdsLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: process.env.NODE_ENV === "test" ? 10_000 : 240,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "广告表单请求过于频繁" }
});

function suppliedToken(req: Request) {
  // Node 会把头名统一小写：X-GoodJob-LeadAds-Token → x-goodjob-leadads-token。
  // 带连字符的变体一并接受，避免中转平台改写头名后失效。
  const direct = String(
    req.headers["x-goodjob-leadads-token"]
    || req.headers["x-goodjob-lead-ads-token"]
    || ""
  ).trim();
  if (direct) return direct;
  const authorization = String(req.headers.authorization || "").trim();
  const match = authorization.match(/^Bearer\s+(.+)$/iu);
  return match ? match[1].trim() : "";
}

/**
 * 归属账号：配置里指定优先；未指定时按创建时间取第一个有 lead.create 权限的启用账号。
 * 单用户个人版通常只有一个候选，这里不做额外猜测。
 */
function resolveLeadAdsOwner(ownerId: string) {
  const active = getStore().users.filter((user) => user.status === "active");
  const preferred = ownerId ? active.find((user) => user.id === ownerId) : undefined;
  if (preferred) {
    const sessionUser = publicUser(preferred);
    return hasIamPermission(sessionUser, "lead.create") ? sessionUser : null;
  }
  // 未指定归属时优先管理员，避免表单线索落到某个普通业务员名下。
  const permitted = active
    .filter((user) => hasIamPermission(publicUser(user), "lead.create"))
    .sort((left, right) => String(left.id || "").localeCompare(String(right.id || "")));
  const admin = permitted.find((user) => user.role === "admin" || user.role === "super_admin");
  const chosen = admin || permitted[0];
  return chosen ? publicUser(chosen) : null;
}

export function registerLeadAdsRoutes(app: Express) {
  /**
   * ⚠️ 必须挂这道闸：canSeeOwner 在 IAM 账号下只认 iamDataScope，
   * 而 iamDataScope 只有 enforceIamTenantPermission 会填。漏了它可见范围恒为 0 且不报错
   * （`/api/leads` 靠 server-core 里的全局中间件填，本前缀不在那份名单里）。
   */
  const leadReadScope = [
    requireAuth,
    asyncRoute(async (req, res, next) => {
      await enforceIamTenantPermission(req, res, next, "lead.read");
    })
  ];

  app.post("/api/lead-ads/webhook", leadAdsLimiter, asyncRoute(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const settings = readLeadAdsIngressSettings();
    if (!settings.enabled) {
      res.status(503).json({ message: "广告表单接收尚未启用" });
      return;
    }
    if (!leadAdsTokenMatches(settings.token, suppliedToken(req))) {
      res.status(401).json({ message: "广告表单令牌无效" });
      return;
    }

    let normalized: ReturnType<typeof normalizeLeadAdsPayload>;
    try {
      normalized = normalizeLeadAdsPayload(req.body);
    } catch {
      res.status(400).json({ message: "广告表单载荷无法解析" });
      return;
    }
    // company 有兜底文案，不能用它判断载荷是否有效（否则 {} 会造出空线索）。
    if (!hasLeadAdsContent(req.body)) {
      res.status(400).json({ message: "广告表单载荷没有可用的联系人信息（至少需要邮箱、电话、姓名或公司之一）" });
      return;
    }
    if (!normalized.company) {
      res.status(400).json({ message: "广告表单载荷缺少公司或表单信息" });
      return;
    }

    const owner = resolveLeadAdsOwner(settings.ownerId);
    if (!owner) {
      res.status(503).json({ message: "广告表单接收尚未配置可用的线索归属账号" });
      return;
    }

    const result = createLeadFromSource(owner, {
      ...normalized,
      wechat: "",
      intent: "中",
      stage: "新线索",
      estimatedAmount: 0,
      nextFollowAt: "",
      sourceType: "inbound",
      sourceChannel: "facebook_lead_ads",
      sourceUrl: "",
      occurredAt: new Date().toISOString()
    });
    if (result.lead.ownerId !== owner.id) {
      res.status(500).json({ message: "线索归属校验失败" });
      return;
    }
    await getStore().persist();

    res.status(result.duplicate ? 200 : 201).json({
      received: true,
      duplicate: result.duplicate,
      leadId: result.lead.id,
      externalId: normalized.externalId
    });
  }));

  /**
   * 控制台读配置。令牌只对持有 integration.manage 的人回显全文，
   * 其他有读权限的人只看到尾部四位——避免一个只读账号就能拿走写入凭据。
   */
  app.get("/api/lead-ads/settings", leadReadScope, (req: Request, res: Response) => {
    if (!hasIamPermission(req.user, "integration.read")) {
      res.status(403).json({ message: "没有查看广告表单接入配置的权限" });
      return;
    }
    const settings = readLeadAdsIngressSettings();
    const canReveal = hasIamPermission(req.user, "integration.manage");
    const leads = getStore().leads.filter((lead) => lead.sourceChannel === LEAD_ADS_SOURCE_CHANNEL && !lead.deletedAt);
    const visible = leads.filter((lead) => canSeeOwner(req.user!, lead.ownerId, lead.teamId));
    const today = new Date().toISOString().slice(0, 10);
    const owners = getStore().users
      .filter((user) => user.status === "active")
      .map((user) => ({ id: user.id, name: user.name || user.email, email: user.email }));
    res.setHeader("Cache-Control", "no-store");
    res.json({
      settings: {
        enabled: settings.enabled,
        ownerId: settings.ownerId,
        token: canReveal ? settings.token : "",
        tokenMasked: settings.token ? `••••••••••••${settings.token.slice(-4)}` : "",
        canReveal
      },
      webhook: {
        path: "/api/lead-ads/webhook",
        publicUrl: `${leadAdsPublicBaseUrl()}/api/lead-ads/webhook`,
        localUrl: "http://127.0.0.1:4188/api/lead-ads/webhook"
      },
      owners,
      stats: {
        today: visible.filter((lead) => String(lead.createdAt || "").slice(0, 10) === today).length,
        total: visible.length,
        lastReceivedAt: visible.reduce((latest, lead) => (String(lead.createdAt || "") > latest ? String(lead.createdAt) : latest), "")
      }
    });
  });

  /** 开关 / 归属账号 / 换令牌。换令牌后旧令牌立即失效，需要在 Make 那边同步更新。 */
  app.post("/api/lead-ads/settings", requireAuth, asyncRoute(async (req, res) => {
    if (!hasIamPermission(req.user, "integration.manage")) {
      res.status(403).json({ message: "没有修改广告表单接入配置的权限" });
      return;
    }
    const parsed = z.object({
      enabled: z.boolean(),
      ownerId: z.string().trim().max(100).default(""),
      rotateToken: z.boolean().default(false)
    }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: "广告表单接入配置格式不正确" });
      return;
    }
    const current = readLeadAdsIngressSettings();
    const token = parsed.data.rotateToken || !current.token
      ? generateLeadAdsIngressToken()
      : current.token;
    try {
      const saved = writeLeadAdsIngressSettings({
        schemaVersion: 1,
        enabled: parsed.data.enabled,
        ownerId: parsed.data.ownerId,
        token
      });
      res.json({ settings: { enabled: saved.enabled, ownerId: saved.ownerId, token: saved.token } });
    } catch (error) {
      res.status(400).json({ message: error instanceof Error ? error.message : "广告表单接入配置保存失败" });
    }
  }));

  /** 已接收的表单线索（按归属可见范围过滤，最近 200 条）。 */
  app.get("/api/lead-ads/leads", leadReadScope, (req: Request, res: Response) => {
    if (!hasIamPermission(req.user, "lead.read")) {
      res.status(403).json({ message: "没有查看线索的权限" });
      return;
    }
    const rows = getStore().leads
      .filter((lead) => lead.sourceChannel === LEAD_ADS_SOURCE_CHANNEL && !lead.deletedAt)
      .filter((lead) => canSeeOwner(req.user!, lead.ownerId, lead.teamId))
      .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")))
      .slice(0, 200)
      .map((lead) => ({
        id: lead.id,
        company: lead.company,
        contact: lead.contact,
        email: lead.email,
        phone: lead.phone,
        country: lead.country,
        stage: lead.stage,
        status: lead.status,
        sourceCampaign: lead.sourceCampaign,
        externalId: lead.externalId,
        inquiryContent: lead.inquiryContent || "",
        createdAt: lead.createdAt
      }));
    res.setHeader("Cache-Control", "no-store");
    res.json({ leads: rows });
  });
}
