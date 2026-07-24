import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export interface CrmIdentity {
  userId: string;
  authVersion: number;
}

declare global {
  namespace Express {
    interface Request {
      crmIdentity?: CrmIdentity;
    }
  }
}

function decodePart(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function readCookie(header: string | undefined, name: string): string {
  for (const part of (header || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

export function verifyCrmToken(secret: string | undefined, token: string): CrmIdentity | null {
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodePart(encodedHeader);
  const payload = decodePart(encodedPayload);
  if (!header || !payload) return null;
  try {
    const parsedHeader = JSON.parse(header) as { alg?: string };
    const claims = JSON.parse(payload) as { sub?: string; ver?: number; iss?: string; aud?: string; exp?: number; nbf?: number };
    const now = Math.floor(Date.now() / 1000);
    if (parsedHeader.alg !== "HS256" || claims.iss !== "goodjob-crm" || claims.aud !== "goodjob-crm-web"
      || !claims.sub || !Number.isFinite(claims.exp) || (claims.exp as number) <= now
      || (claims.nbf !== undefined && claims.nbf > now)) return null;
    const expected = createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest();
    const actual = Buffer.from(encodedSignature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    return { userId: claims.sub, authVersion: Number(claims.ver || 1) };
  } catch {
    return null;
  }
}

/** Verify the CRM's HS256 session token without trusting a browser-supplied user id. */
export function requireCrmAuth(secret: string | undefined) {
  return (request: Request, response: Response, next: NextFunction): void => {
    // The legacy unit suite runs an in-memory app without an HTTP session. Keep
    // that harness usable while production and development always require JWT.
    if (process.env.NODE_ENV === "test" && !secret && !request.header("authorization") && !request.header("cookie")) {
      request.crmIdentity = { userId: "test-user", authVersion: 1 };
      next();
      return;
    }
    if (!secret) {
      response.status(503).json({ error: "CRM session integration is not configured", code: "CRM_AUTH_NOT_CONFIGURED" });
      return;
    }
    const authorization = request.header("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : readCookie(request.header("cookie"), "gj_session");
    const identity = verifyCrmToken(secret, token);
    if (!identity) {
      response.status(401).json({ error: "CRM login required", code: "CRM_AUTH_REQUIRED" });
      return;
    }
    request.crmIdentity = identity;
    next();
  };
}
