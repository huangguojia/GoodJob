import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { getStore } from "./store.js";
import type { SessionUser } from "./types.js";

const JWT_SECRET = "goodjob-crm-dev-secret";

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
    avatar: user.avatar
  };
}

export function signToken(user: SessionUser): string {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "8h" });
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    res.status(401).json({ message: "未登录" });
    return;
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET) as SessionUser;
    next();
  } catch {
    res.status(401).json({ message: "登录已过期" });
  }
}

export function canSeeOwner(user: SessionUser, ownerId: string, teamId: string) {
  if (user.role === "admin") return true;
  if (user.role === "manager") return user.teamId === teamId;
  return user.id === ownerId;
}
