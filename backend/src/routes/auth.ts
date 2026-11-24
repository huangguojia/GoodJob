/**
 * 登录、MFA、个人资料、改密、主题路由。
 *
 * 由 server.ts 拆分而来：代码逐字迁移，注册顺序与拆分前一致。
 * 共享逻辑与全局中间件在 ../server-core.ts。
 */
import type { Express } from "express";
import { type Request, type Response } from "express";
import QRCode from "qrcode";
import { z } from "zod";
import { AUTH_COOKIE_NAME, createCsrfToken, CSRF_COOKIE_NAME, csrfCookieOptions, hashPassword, PLUGIN_TOKEN_TTL_SECONDS, publicUser, requireAuth, sessionCookieOptions, signMfaSetupToken, signToken, userExpired, verifyMfaSetupToken, verifyPassword } from "../auth.js";
import { type SessionUser } from "../types.js";
import { getStore } from "../store.js";
import { accountUser, asyncRoute, loginLimiter } from "../server-core.js";

/**
 * 手机号归一化：只保留 E.164 里用得到的部分（`+` 与国家码/号码），中国大陆号码统一成 11 位。
 * 登录允许「邮箱或手机号」，比对前先过这一层。
 */
function normalizePhone(raw: string): string {
  const digits = String(raw || "").replace(/[^\d+]/gu, "");
  if (digits.startsWith("+")) {
    const body = digits.slice(1).replace(/\D/gu, "");
    if (body.startsWith("86") && body.length === 13) return body.slice(2);
    return `+${body}`;
  }
  if (digits.startsWith("0086")) return digits.slice(4);
  if (digits.length === 13 && digits.startsWith("86")) return digits.slice(2);
  return digits;
}

const loginSchema = z.object({
  /**
   * 登录标识：邮箱或手机号。部分账号只用手机号登记（`users.email` 是占位值），
   * 所以这里不能再用 `.email()` 卡死；格式在下面按「含 @ 就校验邮箱」分流。
   */
  email: z.string().trim().min(3).max(180),
  password: z.string().min(1).max(128),
  /**
   * 谁在登录。`plugin` = WhatsApp 扩展 / 本机插件控制台（跨源、无 cookie、只读 body 里的 token）。
   * 不传或传 `web` = 网页端，仍是 8 小时。
   */
  client: z.enum(["web", "plugin"]).optional()
});

export function sendLoginSession(
  res: Response,
  sessionUser: SessionUser,
  mfaVerified = false,
  options: { client?: "web" | "plugin"; extra?: Record<string, unknown> } = {}
) {
  const pluginClient = options.client === "plugin";
  const token = pluginClient
    ? signToken(sessionUser, { mfaVerified, ttlSeconds: PLUGIN_TOKEN_TTL_SECONDS })
    : signToken(sessionUser, { mfaVerified });
  res.setHeader("Cache-Control", "no-store");
  const extra = options.extra || {};
  if (pluginClient) {
    // 不种 cookie：扩展从 web.whatsapp.com 调 CRM，跨源 cookie 本来也带不过去、拿不到，
    // 种下去只会让「网页登录态」和「插件登录态」隐式共用一个 8 小时的开关。
    res.json({ token, user: sessionUser, client: "plugin", ...extra });
    return;
  }
  const csrfToken = createCsrfToken();
  res.cookie(AUTH_COOKIE_NAME, token, sessionCookieOptions());
  res.cookie(CSRF_COOKIE_NAME, csrfToken, csrfCookieOptions());
  res.json({ token, csrfToken, user: sessionUser, ...extra });
}

/** 登录标识解析：先按邮箱（忽略大小写），再按手机号（归一化后比对） */
function findLoginUser(account: string) {
  const store = getStore();
  const value = String(account || "").trim().toLowerCase();
  if (!value) return undefined;
  const byEmail = store.users.find((item) => item.status === "active" && item.email.toLowerCase() === value);
  if (byEmail) return byEmail;
  if (value.includes("@")) return undefined;
  const phone = normalizePhone(value);
  if (phone.length < 7) return undefined;
  return store.users.find((item) => item.status === "active" && Boolean(item.phone) && normalizePhone(String(item.phone)) === phone);
}

function mfaSetupActor(token: string) {
  const claims = verifyMfaSetupToken(token);
  if (!claims) return null;
  const user = getStore().users.find((item) => item.id === claims.userId && item.status === "active" && Number(item.authVersion || 1) === claims.authVersion);
  return user ? publicUser(user) : null;
}

type StoreUser = NonNullable<ReturnType<typeof findLoginUser>>;

/**
 * 凭据校验通过后的统一收尾：账号有效期 → 运维 MFA → 下发会话。
 * 密码登录与本机一键登录共用，避免两条链路在这些校验上分叉。
 */
async function finishCredentialLogin(res: Response, user: StoreUser, client?: "web" | "plugin") {
  if (userExpired(user)) {
    res.status(403).json({ message: "账号已过有效期，请联系管理员续期", code: "TEAM_EXPIRED" });
    return;
  }
  const sessionUser = publicUser(user);
  // 运维 MFA（扫码/6 位码）默认关闭：只有显式设置 PLATFORM_MFA_ENFORCED=true 才启用。
  // 平台运维双重验证代码保留，需要时配置环境变量即可恢复强制。
  const platformMfa = getStore().platformMfa;
  if (process.env.PLATFORM_MFA_ENFORCED === "true" && user.role === "super_admin" && platformMfa) {
    const mfa = await platformMfa.status(sessionUser);
    if (mfa.required && !mfa.configured) {
      res.status(202).json({ mfaRequired: true, mfaSetupRequired: true, setupToken: signMfaSetupToken(sessionUser) });
      return;
    }
    if (mfa.required) {
      const challenge = await platformMfa.createChallenge(sessionUser);
      res.status(202).json({ mfaRequired: true, challengeId: challenge.challengeId, expiresAt: challenge.expiresAt, email: sessionUser.email });
      return;
    }
  }
  sendLoginSession(res, sessionUser, false, { client });
}

/**
 * 本机一键登录的账号口径。
 *
 * 只服务「单机自用」：账号密码由服务端内置（可用 GOODJOB_LOCAL_LOGIN_EMAIL /
 * GOODJOB_LOCAL_LOGIN_PASSWORD 覆盖），浏览器不需要、也拿不到明文密码。
 */
const LOCAL_LOGIN_DEFAULT_EMAIL = "admin@goodjob.com";
const LOCAL_LOGIN_DEFAULT_PASSWORD = "goodjob123";

function requestFromLoopback(req: Request) {
  const address = String(req.socket?.remoteAddress || req.ip || "").replace(/^::ffff:/u, "").trim().toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "localhost";
}

/** 本机一键登录上下文；不满足条件返回 null（生产档位永远关闭）。 */
function localLoginContext(req: Request) {
  if (process.env.GOODJOB_LOCAL_ONE_CLICK_LOGIN === "false") return null;
  const profile = String(process.env.APP_DATABASE_PROFILE || "").trim();
  // 生产档位一律关闭：这套能力只给本机个人版/开发版用，不能跟着代码发到公网部署上。
  if (!["personal", "development"].includes(profile)) return null;
  if (!requestFromLoopback(req)) return null;
  const email = process.env.GOODJOB_LOCAL_LOGIN_EMAIL?.trim().toLowerCase() || LOCAL_LOGIN_DEFAULT_EMAIL;
  const password = process.env.GOODJOB_LOCAL_LOGIN_PASSWORD || LOCAL_LOGIN_DEFAULT_PASSWORD;
  const user = findLoginUser(email);
  if (!user) return null;
  return { email, password, user };
}

export function registerAuthRoutes(app: Express) {
  app.post("/api/auth/login", loginLimiter, asyncRoute(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const store = getStore();
    const user = findLoginUser(body.email);
    const passwordCheck = user ? await verifyPassword(user.password, body.password) : { valid: false, needsUpgrade: false };
    if (!user || !passwordCheck.valid) {
      res.status(401).json({ message: "账号或密码错误", code: "INVALID_CREDENTIALS" });
      return;
    }
    if (passwordCheck.needsUpgrade) {
      user.password = await hashPassword(body.password);
      user.authVersion = user.authVersion || 1;
      await store.persist();
    }
    await finishCredentialLogin(res, user, body.client);
  }));

  /**
   * 本机一键登录（个人版 / 开发版，仅本机回环请求）。
   * GET 只回答「能不能用、用哪个账号」，不返回密码；密码始终留在服务端。
   */
  app.get("/api/auth/local-login", asyncRoute(async (req, res) => {
    const context = localLoginContext(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(context
      ? { enabled: true, email: context.email, autoLogin: process.env.GOODJOB_LOCAL_AUTOLOGIN === "true" }
      : { enabled: false });
  }));

  app.post("/api/auth/local-login", loginLimiter, asyncRoute(async (req, res) => {
    const context = localLoginContext(req);
    if (!context) {
      res.status(403).json({ message: "本机一键登录未启用", code: "LOCAL_LOGIN_DISABLED" });
      return;
    }
    const check = await verifyPassword(context.user.password, context.password);
    if (!check.valid) {
      res.status(401).json({
        message: "内置管理员密码已变更，请用密码登录；如需恢复一键登录，请设置 GOODJOB_LOCAL_LOGIN_PASSWORD 为当前密码",
        code: "LOCAL_LOGIN_STALE"
      });
      return;
    }
    if (check.needsUpgrade) {
      context.user.password = await hashPassword(context.password);
      context.user.authVersion = context.user.authVersion || 1;
      await getStore().persist();
    }
    await finishCredentialLogin(res, context.user);
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
