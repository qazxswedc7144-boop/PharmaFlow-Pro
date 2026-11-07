import type { NextFunction, Request, Response } from "express";
import { prisma } from "../database/prisma.js";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS_PER_USERNAME = 20;
const MAX_FAILED_ATTEMPTS_PER_IP = 50;

export class LoginAttemptAuditError extends Error {
  constructor() {
    super("LOGIN_ATTEMPT_AUDIT_UNAVAILABLE");
    this.name = "LoginAttemptAuditError";
  }
}

export async function loginAttemptGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  if (!username) {
    next();
    return;
  }

  const ipAddress = req.ip || req.socket.remoteAddress || "unknown";
  const since = new Date(Date.now() - WINDOW_MS);
  const failedLoginFilter = {
    action: "USER_LOGIN" as const,
    entity: "User",
    after: { contains: '"status":"FAILED"' },
    createdAt: { gte: since }
  };

  try {
    const [usernameAttempts, ipAttempts] = await Promise.all([
      prisma.auditLog.count({
        where: { ...failedLoginFilter, entityId: username }
      }),
      prisma.auditLog.count({
        where: { ...failedLoginFilter, ipAddress }
      })
    ]);

    if (usernameAttempts >= MAX_FAILED_ATTEMPTS_PER_USERNAME || ipAttempts >= MAX_FAILED_ATTEMPTS_PER_IP) {
      res.setHeader("Retry-After", String(Math.ceil(WINDOW_MS / 1000)));
      res.status(429).json({
        error: "RATE_LIMIT_EXCEEDED",
        message: "تم تقييد محاولات تسجيل الدخول مؤقتاً لحماية الحساب. يرجى المحاولة بعد 15 دقيقة."
      });
      return;
    }

    next();
  } catch (error) {
    console.error("[AUTH] Persistent login throttle unavailable:", error);
    res.status(503).json({
      error: "AUTH_TEMPORARILY_UNAVAILABLE",
      message: "تعذر التحقق من حماية تسجيل الدخول حالياً. يرجى المحاولة لاحقاً."
    });
  }
}

export async function recordFailedLoginAttempt(
  username: string,
  ipAddress?: string,
  userId?: string,
  tenantId?: string
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: "USER_LOGIN",
        entity: "User",
        entityId: username,
        userId: userId || null,
        tenantId: tenantId || "SYSTEM",
        after: JSON.stringify({ status: "FAILED" }),
        ipAddress: ipAddress || null
      }
    });
  } catch (error) {
    console.error("[AUTH] Failed to persist login attempt:", error);
    throw new LoginAttemptAuditError();
  }
}
