// server/modules/idempotency/idempotency.middleware.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { IdempotencyService } from "./idempotency.service.js";

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    username: string;
    role: any;
    tenantId?: string;
  };
  tenantId?: string;
}

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('FATAL: JWT_SECRET environment variable is missing in production.');
  }
  return secret || 'pharmaflow-local-development-jwt-secure-secret-2026';
};

export async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
  const keyHeader = req.headers["idempotency-key"];
    
  if (!keyHeader) {
    return next();
  }

  const rawKey = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader;
  const key = rawKey || "";

  if (!key.trim()) {
    return res.status(400).json({
      error: "BAD_REQUEST",
      message: "Idempotency-Key header is supplied but cannot be empty."
    });
  }

  const authReq = req as AuthenticatedRequest;
  let userId = authReq.user?.userId || null;
  let tenantId = authReq.tenantId || authReq.user?.tenantId || (req.headers["x-tenant-id"] as string) || "default-tenant";

  if (!userId && req.headers["authorization"]) {
    try {
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
      if (token) {
        const decoded = jwt.verify(token, getJwtSecret()) as any;
        userId = decoded?.userId || null;
        tenantId = decoded?.tenantId || tenantId;
      }
    } catch {
      // safe fallback
    }
  }

  const endpoint = req.originalUrl || req.path;
  const method = req.method;

  try {
    const result = await IdempotencyService.handlePreRequest(
      tenantId,
      key,
      endpoint,
      method,
      req.body,
      userId
    );

    if (result.status === "REPLAY") {
      res.setHeader("X-Cache-Lookup", "HIT - Idempotent Replay");
      return res.status(result.code).json(result.body);
    }

    const originalSend = res.send;
    let answered = false;

    res.send = function (chunk: any) {
      if (answered) {
        return originalSend.apply(this, arguments as any);
      }
      answered = true;

      const responseStatus = res.statusCode;
      let parsedBody = chunk;
      if (typeof chunk === "string") {
        try {
          parsedBody = JSON.parse(chunk);
        } catch {
          // Keep raw string if not JSON format
        }
      }

      if (responseStatus < 500) {
        IdempotencyService.resolveRequest(tenantId, key, responseStatus, parsedBody).catch((err) => {
          console.error(`[Idempotency] Failed to resolve key cache for: ${key}`, err);
        });
      } else {
        IdempotencyService.releaseLock(tenantId, key).catch((err) => {
          console.error(`[Idempotency] Failed to release lock on server error for: ${key}`, err);
        });
      }

      return originalSend.apply(this, arguments as any);
    };

    res.on("close", () => {
      if (!answered) {
        IdempotencyService.releaseLock(tenantId, key).catch(() => {});
      }
    });

    next();
  } catch (error: any) {
    if (error.message === "CONCURRENT_LOCK") {
      return res.status(409).json({
        error: "CONFLICT",
        message: "A parallel request with this Idempotency-Key is already in progress, or locked in transaction."
      });
    }
    if (error.message === "HASH_MISMATCH") {
      return res.status(409).json({
        error: "CONFLICT",
        message: "Idempotency key reuse detected with different payload"
      });
    }
    console.error(`[Idempotency] Middleware fatal error for key ${key}:`, error);
    return res.status(500).json({
      error: "INTERNAL_SERVER_ERROR",
      message: error.message || String(error),
      stack: error.stack
    });
  }
}
