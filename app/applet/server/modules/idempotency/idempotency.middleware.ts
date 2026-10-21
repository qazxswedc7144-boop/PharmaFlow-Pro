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
  let tenantId = authReq.tenantId || authReq.user?.tenantId || (req.headers["x-tenant-id"] as string);

  // استخراج البيانات من التوكن إذا لم تكن موجودة
  if ((!userId || !tenantId) && req.headers["authorization"]) {
    try {
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
      if (token) {
        const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as any;
        userId = userId || decoded?.userId || null;
        tenantId = tenantId || decoded?.tenantId || null;
      }
    } catch {
      // safe fallback
    }
  }

  // 🚨 إصلاح أمني: لا نسمح بمرور طلب بدون tenantId في نظام متعدد المؤسسات
  if (!tenantId) {
    return res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Tenant ID is missing. Cannot process Idempotency key safely."
    });
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

    // ✅ إصلاح برمجي: استخدام حدث finish لالتقاط الاستجابة بشكل أكثر أماناً من تغليف res.send
    let answered = false;

    res.on("finish", () => {
      if (answered) return;
      answered = true;

      const responseStatus = res.statusCode;
      
      // في حالة النجاح، نحفظ الاستجابة في الكاش
      if (responseStatus < 500) {
        // ملاحظة: res.locals يمكن استخدامها لتمرير جسم الاستجابة إذا لزم الأمر
        IdempotencyService.resolveRequest(tenantId, key, responseStatus, res.locals.responseBody || null).catch((err) => {
          console.error(`[Idempotency] Failed to resolve key cache for: ${key}`, err);
        });
      } else {
        // في حالة فشل الخادم، نحرر القفل لنتمكن من إعادة المحاولة
        IdempotencyService.releaseLock(tenantId, key).catch((err) => {
          console.error(`[Idempotency] Failed to release lock on server error for: ${key}`, err);
        });
      }
    });

    // إذا تم إغلاق الاتصال قبل إرسال الرد، نحرر القفل
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
    
    // 🚨 إصلاح أمني: عدم إرسال تفاصيل الخطأ أو الـ Stack Trace للمستخدم في الإنتاج
    const isProduction = process.env.NODE_ENV === 'production';
    return res.status(500).json({
      error: "INTERNAL_SERVER_ERROR",
      message: isProduction ? "An internal error occurred." : (error.message || String(error)),
      ...(isProduction ? {} : { stack: error.stack }) 
    });
  }
}
