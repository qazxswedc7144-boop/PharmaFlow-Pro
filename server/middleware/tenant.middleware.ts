// server/middleware/tenant.middleware.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../database/prisma.js";
import { runWithTenantContext, TenantContext } from "../context/tenantContext.js";
import { AuthenticatedRequest } from "./auth.middleware.js";
import { getJwtSecret, isProductionRuntime } from "../security/jwtSecrets.js";

export interface TenantScopedRequest extends AuthenticatedRequest {
  tenantContext?: TenantContext;
  tenantId?: string;
}

const isDevLocalTokenAllowed = () => {
  return !isProductionRuntime() &&
    process.env.NODE_ENV === 'development' &&
    process.env.DEV_ALLOW_LOCAL_TOKEN === 'true';
};

/**
 * Extracts and sets tenant context for request lifecycle.
 * Enforces tenant validation and active subscription checks where appropriate.
 */
export async function tenantContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const scopedReq = req as TenantScopedRequest;
  
  // 1. Extract tenantId from multiple possible sources
  let extractedTenantId: string | null = null;
  let extractedBranchId: string | null = null;
  let extractedUserId: string | null = null;
  let extractedUsername: string | null = null;
  let extractedRole: string | null = null;

  // Check authenticated user object first (if authenticateToken has already run)
  if (scopedReq.user) {
    extractedTenantId = scopedReq.user.tenantId || null;
    extractedUserId = scopedReq.user.userId || null;
    extractedUsername = scopedReq.user.username || null;
    extractedRole = scopedReq.user.role || null;
  }

  // Check request headers
  const headerTenantId = req.headers["x-tenant-id"] || req.headers["tenant-id"];
  if (typeof headerTenantId === "string" && headerTenantId.trim()) {
    extractedTenantId = extractedTenantId || headerTenantId.trim();
  }

  const headerBranchId = req.headers["x-branch-id"] || req.headers["branch-id"];
  if (typeof headerBranchId === "string" && headerBranchId.trim()) {
    extractedBranchId = headerBranchId.trim();
  }

  // Check body for sync or post envelopes
  if (req.body && typeof req.body === "object") {
    if (typeof req.body.tenantId === "string" && req.body.tenantId.trim()) {
      extractedTenantId = extractedTenantId || req.body.tenantId.trim();
    }
    if (typeof req.body.branchId === "string" && req.body.branchId.trim()) {
      extractedBranchId = extractedBranchId || req.body.branchId.trim();
    }
  }

  // Fallback: peek at Authorization header if not decoded yet
  if (!extractedTenantId) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (token) {
      if (isDevLocalTokenAllowed() && (token === "local-admin-token" || token.startsWith("local-"))) {
        extractedTenantId = "local-tenant-01";
        extractedUserId = "local-admin";
        extractedUsername = "Administrator";
        extractedRole = "ADMIN";
      } else {
        try {
          const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as any;
          if (decoded) {
            extractedTenantId = decoded.tenantId || null;
            extractedUserId = decoded.userId || null;
            extractedUsername = decoded.username || null;
            extractedRole = decoded.role || null;
          }
        } catch {
          // Token verification failure handled by auth middleware when required
        }
      }
    }
  }

  // Fail closed: a tenant context must be present and verified against the database.
  const finalTenantId = extractedTenantId;
  if (!finalTenantId) {
    res.status(503).json({ error: "TENANT_UNAVAILABLE" });
    return;
  }

  let tenantRecord: any;
  try {
    if (!prisma.isConnected || !prisma.isConnected()) {
      throw new Error("TENANT_DATABASE_DISCONNECTED");
    }

    tenantRecord = await prisma.tenant.findUnique({
      where: { id: finalTenantId },
      include: {
        subscriptions: {
          where: { isActive: true },
          include: { plan: true },
          orderBy: { endDate: "desc" }
        }
      }
    });
  } catch {
    res.status(503).json({ error: "TENANT_UNAVAILABLE" });
    return;
  }

  if (!tenantRecord) {
    res.status(503).json({ error: "TENANT_UNAVAILABLE" });
    return;
  }

  let tenantName = tenantRecord.name;
  let isActive = tenantRecord.isActive;
  let subscriptionPlan = "ENTERPRISE";

  if (tenantRecord.subscriptions && tenantRecord.subscriptions.length > 0) {
    const activeSub = tenantRecord.subscriptions[0];
    subscriptionPlan = activeSub.plan?.code || "ENTERPRISE";

    // Check if subscription has expired, preserving the existing 3-day grace period.
    if (activeSub.endDate && new Date(activeSub.endDate).getTime() < Date.now()) {
      const graceExpiry = new Date(activeSub.endDate).getTime() + (3 * 24 * 60 * 60 * 1000);
      if (Date.now() > graceExpiry) {
        isActive = false;
      }
    }
  }

  const safeTenantId = finalTenantId;

  const context: TenantContext = {
    tenantId: safeTenantId,
    tenantName,
    branchId: extractedBranchId,
    userId: extractedUserId,
    username: extractedUsername,
    role: extractedRole,
    subscriptionPlan,
    isActive
  };

  // Attach context to request
  scopedReq.tenantContext = context;
  scopedReq.tenantId = safeTenantId;

  // Run downstream handlers inside AsyncLocalStorage context
  runWithTenantContext(context, () => {
    next();
  });
}

/**
 * Guard middleware requiring an active, valid tenant subscription for sensitive routes.
 */
export function requireActiveTenant(req: Request, res: Response, next: NextFunction): void {
  const scopedReq = req as TenantScopedRequest;
  const context = scopedReq.tenantContext;

  if (!context || !context.tenantId) {
    res.status(401).json({
      error: "TENANT_REQUIRED",
      message: "A valid tenant context is required for this operation."
    });
    return;
  }

  if (context.isActive === false) {
    res.status(403).json({
      error: "TENANT_INACTIVE",
      message: "The tenant account is currently inactive or subscription has expired."
    });
    return;
  }

  next();
}
