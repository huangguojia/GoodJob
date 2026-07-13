import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getStore } from "./store.js";
import type { SessionUser } from "./types.js";

const scrypt = promisify(scryptCallback);
const TOKEN_ISSUER = "goodjob-crm";
const TOKEN_AUDIENCE = "goodjob-crm-web";
const TOKEN_TTL_SECONDS = 8 * 60 * 60;
const EPHEMERAL_DEVELOPMENT_SECRET = randomBytes(48).toString("base64url");
export const AUTH_COOKIE_NAME = "gj_session";
export const CSRF_COOKIE_NAME = "gj_csrf";

function jwtSecret() {
  const configured = process.env.JWT_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (configured) {
    throw new Error("JWT_SECRET 必须至少包含 32 个字符");
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("生产环境必须配置至少 32 个字符的 JWT_SECRET");
  }
  return EPHEMERAL_DEVELOPMENT_SECRET;
}

function secureCookies() {
  if (process.env.SESSION_COOKIE_SECURE === "false") return false;
  if (process.env.SESSION_COOKIE_SECURE === "true") return true;
  return process.env.NODE_ENV === "production";
}

interface TokenClaims {
  sub: string;
  ver: number;
  jti?: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export function publicUser(user: ReturnType<typeof getStore>["users"][number]): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    teamId: user.teamId,
    avatar: user.avatar,
    authVersion: user.authVersion || 1,
    outboundEmail: user.outboundEmail || "",
    emailSenderName: user.emailSenderName ?? "",
    emailSignature: user.emailSignature || "",
    smtpHost: user.smtpHost || "",
    smtpPort: user.smtpPort || 465,
    smtpSecure: user.smtpSecure ?? true,
    smtpUser: user.smtpUser || "",
    hasSmtpPassword: Boolean(user.smtpPassword),
    lastDevelopmentEmailAt: user.lastDevelopmentEmailAt || "",
    lastDevelopmentEmailTo: user.lastDevelopmentEmailTo || "",
    lastDevelopmentEmailSubject: user.lastDevelopmentEmailSubject || ""
  };
}

export function signToken(user: SessionUser): string {
  return jwt.sign(
    { ver: user.authVersion },
    jwtSecret(),
    {
      subject: user.id,
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      expiresIn: TOKEN_TTL_SECONDS,
      jwtid: randomBytes(16).toString("hex"),
      algorithm: "HS256"
    }
  );
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index < 0) return ["", ""];
    const key = part.slice(0, index).trim();
    const rawValue = part.slice(index + 1).trim();
    try {
      return [key, decodeURIComponent(rawValue)];
    } catch {
      return [key, ""];
    }
  }).filter(([key]) => key));
}

function requestToken(req: Request) {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return { token: header.slice(7), source: "bearer" as const };
  const token = parseCookies(req.headers.cookie)[AUTH_COOKIE_NAME];
  return { token, source: "cookie" as const };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const { token, source } = requestToken(req);
  if (!token) {
    res.status(401).json({ message: "未登录" });
    return;
  }
  try {
    const claims = jwt.verify(token, jwtSecret(), {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      algorithms: ["HS256"]
    }) as TokenClaims;
    const user = getStore().users.find((item) => item.id === claims.sub);
    if (!user || user.status !== "active" || Number(user.authVersion || 1) !== Number(claims.ver || 1)) {
      res.status(401).json({ message: "登录状态已失效，请重新登录" });
      return;
    }
    req.user = publicUser(user);
    if (source === "cookie" && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const cookies = parseCookies(req.headers.cookie);
      const csrfCookie = cookies[CSRF_COOKIE_NAME] || "";
      const csrfHeader = String(req.headers["x-csrf-token"] || "");
      if (!csrfCookie || !csrfHeader || csrfCookie.length !== csrfHeader.length
        || !timingSafeEqual(Buffer.from(csrfCookie), Buffer.from(csrfHeader))) {
        res.status(403).json({ message: "安全校验失败，请刷新页面后重试" });
        return;
      }
    }
    next();
  } catch {
    res.status(401).json({ message: "登录已过期" });
  }
}

export function createCsrfToken() {
  return randomBytes(32).toString("base64url");
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPassword(stored: string, supplied: string) {
  if (!stored.startsWith("scrypt$")) {
    const left = createHash("sha256").update(stored).digest();
    const right = createHash("sha256").update(supplied).digest();
    return { valid: timingSafeEqual(left, right), needsUpgrade: true };
  }
  const [, saltValue, hashValue] = stored.split("$");
  if (!saltValue || !hashValue) return { valid: false, needsUpgrade: false };
  const expected = Buffer.from(hashValue, "base64url");
  const actual = await scrypt(supplied, Buffer.from(saltValue, "base64url"), expected.length) as Buffer;
  return {
    valid: actual.length === expected.length && timingSafeEqual(actual, expected),
    needsUpgrade: false
  };
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: "strict" as const,
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: "/"
  };
}

export function csrfCookieOptions() {
  return {
    httpOnly: false,
    secure: secureCookies(),
    sameSite: "strict" as const,
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: "/"
  };
}

export function canSeeOwner(user: SessionUser, ownerId: string, teamId: string) {
  if (user.role === "super_admin") return true;
  if (user.role === "admin" || user.role === "manager") return user.teamId === teamId;
  return user.id === ownerId;
}

export function canSeeTeam(user: SessionUser, teamId: string) {
  return user.role === "super_admin" || user.teamId === teamId;
}

export function canSeePersonalData(user: SessionUser, ownerId: string) {
  return user.id === ownerId;
}

export function canManageAccounts(user?: SessionUser) {
  return user?.role === "admin" || user?.role === "super_admin";
}

export function canManageRole(operator: SessionUser, targetRole: string) {
  if (operator.role === "super_admin") return true;
  if (operator.role !== "admin") return false;
  return targetRole === "sales" || targetRole === "manager";
}

export function canManageAccount(operator: SessionUser, target: SessionUser) {
  if (operator.role === "super_admin") return true;
  if (operator.role !== "admin") return false;
  return target.teamId === operator.teamId && (target.role === "sales" || target.role === "manager");
}
