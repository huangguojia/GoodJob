/**
 * 登录、MFA、个人资料、改密、主题路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Response } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { AUTH_COOKIE_NAME, createCsrfToken, CSRF_COOKIE_NAME, csrfCookieOptions, hashPassword, PLUGIN_TOKEN_TTL_SECONDS, publicUser, requireAuth, sessionCookieOptions, signMfaSetupToken, signToken, userExpired, verifyMfaSetupToken, verifyPassword } from "../auth.js";
import { type SessionUser } from "../types.js";
import { getStore } from "../store.js";
import { accountUser, asyncRoute, loginLimiter } from "../server-core.js";

const loginSchema = z.object({
  email: z.string().trim().email().max(180).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
  /**
   * 谁在登录。`plugin` = WhatsApp 扩展 / 本机插件控制台（跨源、无 cookie、只读 body 里的 token）。
   * 不传或传 `web` = 网页端，仍是 8 小时。
   */
  client: z.enum(["web", "plugin"]).optional()
});

function sendLoginSession(res: Response, sessionUser: SessionUser, mfaVerified = false, options: { client?: "web" | "plugin" } = {}) {
  const pluginClient = options.client === "plugin";
  const token = pluginClient
    ? signToken(sessionUser, { mfaVerified, ttlSeconds: PLUGIN_TOKEN_TTL_SECONDS })
    : signToken(sessionUser, { mfaVerified });
  res.setHeader("Cache-Control", "no-store");
  if (pluginClient) {
    // 不种 cookie：扩展从 web.whatsapp.com 调 CRM，跨源 cookie 本来也带不过去、拿不到，
    // 种下去只会让「网页登录态」和「插件登录态」隐式共用一个 8 小时的开关。
    res.json({ token, user: sessionUser, client: "plugin" });
    return;
  }
  const csrfToken = createCsrfToken();
  res.cookie(AUTH_COOKIE_NAME, token, sessionCookieOptions());
  res.cookie(CSRF_COOKIE_NAME, csrfToken, csrfCookieOptions());
  res.json({ token, csrfToken, user: sessionUser });
}

function mfaSetupActor(token: string) {
  const claims = verifyMfaSetupToken(token);
  if (!claims) return null;
  const user = getStore().users.find((item) => item.id === claims.userId && item.status === "active" && Number(item.authVersion || 1) === claims.authVersion);
  return user ? publicUser(user) : null;
}

export function registerAuthRoutes(app: Express) {
  app.post("/api/auth/login", loginLimiter, asyncRoute(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const store = getStore();
    const user = store.users.find((item) => item.email.toLowerCase() === body.email && item.status === "active");
    const passwordCheck = user ? await verifyPassword(user.password, body.password) : { valid: false, needsUpgrade: false };
    if (!user || !passwordCheck.valid) {
      res.status(401).json({ message: "账号或密码错误" });
      return;
    }
    if (passwordCheck.needsUpgrade) {
      user.password = await hashPassword(body.password);
      user.authVersion = user.authVersion || 1;
      await store.persist();
    }
    if (userExpired(user)) {
      res.status(403).json({ message: "账号已过有效期，请联系管理员续期" });
      return;
    }
    const sessionUser = publicUser(user);
    // 运维 MFA（扫码/6 位码）默认关闭：只有显式设置 PLATFORM_MFA_ENFORCED=true 才启用。
    // 平台运维双重验证代码保留，需要时配置环境变量即可恢复强制。
    if (process.env.PLATFORM_MFA_ENFORCED === "true" && user.role === "super_admin" && store.platformMfa) {
      const mfa = await store.platformMfa.status(sessionUser);
      if (mfa.required && !mfa.configured) {
        res.status(202).json({ mfaRequired: true, mfaSetupRequired: true, setupToken: signMfaSetupToken(sessionUser) });
        return;
      }
      if (mfa.required) {
        const challenge = await store.platformMfa.createChallenge(sessionUser);
        res.status(202).json({ mfaRequired: true, challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, email: sessionUser.email });
        return;
      }
    }
    sendLoginSession(res, sessionUser, false, { client: body.client });
  }));

  app.post("/api/auth/mfa/enroll", loginLimiter, asyncRoute(async (req, res) => {
    const body = z.object({ setupToken: z.string().min(20).max(4000) }).parse(req.body);
    const actor = mfaSetupActor(body.setupToken);
    const service = getStore().platformMfa;
    if (!actor || !service) { res.status(401).json({ message: "MFA 注册凭证无效或已过期" }); return; }
    const enrollment = await service.enroll(actor);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...enrollment, qrCode: await QRCode.toDataURL(enrollment.otpauthUrl, { margin: 1, width: 220 }) });
  }));

  app.post("/api/auth/mfa/confirm", loginLimiter, asyncRoute(async (req, res) => {
    const body = z.object({ setupToken: z.string().min(20).max(4000), code: z.string().trim().min(6).max(64) }).parse(req.body);
    const actor = mfaSetupActor(body.setupToken);
    const service = getStore().platformMfa;
    if (!actor || !service) { res.status(401).json({ message: "MFA 注册凭证无效或已过期" }); return; }
    await service.confirmEnrollment(actor, body.code);
    res.json({ configured: true, message: "MFA 已启用，请重新登录" });
  }));

  app.post("/api/auth/mfa/verify", loginLimiter, asyncRoute(async (req, res) => {
    const body = z.object({ email: z.string().trim().email().max(180).transform((value) => value.toLowerCase()), challengeId: z.string().min(20).max(120), code: z.string().trim().min(6).max(64) }).parse(req.body);
    const user = getStore().users.find((item) => item.email.toLowerCase() === body.email && item.status === "active");
    const service = getStore().platformMfa;
    if (!user || !service) { res.status(401).json({ message: "MFA 登录挑战无效" }); return; }
    const actor = publicUser(user);
    await service.verifyChallenge(actor, body.challengeId, body.code);
    sendLoginSession(res, actor, true);
  }));

  app.post("/api/auth/logout", (req, res) => {
    res.clearCookie(AUTH_COOKIE_NAME, { ...sessionCookieOptions(), maxAge: undefined });
    res.clearCookie(CSRF_COOKIE_NAME, { ...csrfCookieOptions(), maxAge: undefined });
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  app.get("/api/auth/me", requireAuth, (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ user: req.user });
  });

  app.get("/api/profile", requireAuth, (req, res) => {
    const user = getStore().users.find((item) => item.id === req.user!.id);
    if (!user) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    res.json({ user: accountUser(user) });
  });

  app.patch("/api/profile/password", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({
      currentPassword: z.string().min(1).max(128),
      newPassword: z.string().min(8).max(128),
      confirmPassword: z.string().min(8).max(128)
    });
    const body = schema.parse(req.body);
    if (body.newPassword !== body.confirmPassword) {
      res.status(400).json({ message: "两次输入的新密码不一致" });
      return;
    }
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    const currentPasswordCheck = await verifyPassword(user.password, body.currentPassword);
    if (!currentPasswordCheck.valid) {
      res.status(400).json({ message: "当前密码错误" });
      return;
    }
    const samePasswordCheck = await verifyPassword(user.password, body.newPassword);
    if (samePasswordCheck.valid) {
      res.status(400).json({ message: "新密码不能与当前密码相同" });
      return;
    }
    user.password = await hashPassword(body.newPassword);
    user.authVersion = (user.authVersion || 1) + 1;
    await store.persist();
    res.setHeader("Cache-Control", "no-store");
    res.json({ requiresRelogin: true, message: "密码已修改，请重新登录" });
  }));

  app.patch("/api/profile/theme", requireAuth, asyncRoute(async (req, res) => {
    const schema = z.object({ theme: z.string().max(48).default("rose") });
    const { theme } = schema.parse(req.body);
    const store = getStore();
    const user = store.users.find((item) => item.id === req.user!.id);
    if (!user) {
      res.status(404).json({ message: "账号不存在" });
      return;
    }
    user.theme = theme;
    await store.persist();
    res.json({ theme: user.theme });
  }));
}
