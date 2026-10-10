// server/middleware/permission.middleware.ts
import { Request, Response, NextFunction } from "express";
import { AuthenticatedRequest } from "./auth.middleware.js";
import { AuthorizationService } from "../services/rbac/authorization.service.js";
import { UserIdentityContext } from "../services/rbac/types.js";

export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "يتطلب هذا الإجراء تسجيل الدخول أولاً."
      });
      return;
    }

    const userRoleStr = String(authReq.user.role);
    const isPlatformOwner = userRoleStr === 'PLATFORM_OWNER' || userRoleStr === 'SUPER_ADMIN';
    const headerTenant = typeof req.headers["x-tenant-id"] === "string" ? req.headers["x-tenant-id"].trim() : undefined;
    const tenantId = authReq.user.tenantId || (isPlatformOwner ? headerTenant : undefined);

    if (!tenantId && !isPlatformOwner) {
      res.status(401).json({
        error: "TENANT_REQUIRED",
        message: "يتطلب هذا الإجراء تحديد مؤسسة صالحة وموثوقة."
      });
      return;
    }

    if (tenantId === "default-tenant" && process.env.NODE_ENV === "production") {
      res.status(401).json({
        error: "INVALID_TENANT",
        message: "default-tenant غير مسموح به في بيئة التشغيل الفعلية."
      });
      return;
    }

    const branchId = (req.headers["x-branch-id"] as string) || (req.body && req.body.branchId) || undefined;

    const userContext: UserIdentityContext = {
      userId: authReq.user.userId,
      username: authReq.user.username,
      role: authReq.user.role,
      tenantId: authReq.user.tenantId,
      branchId: branchId || undefined
    };

    const hasAccess = await AuthorizationService.can(userContext, permission, {
      tenantId: tenantId || authReq.user.tenantId || undefined,
      branchId
    });

    if (!hasAccess) {
      res.status(403).json({
        error: "PERMISSION_DENIED",
        message: `ليس لديك الصلاحية الكافية لتنفيذ هذا الإجراء (${permission}).`,
        requiredPermission: permission
      });
      return;
    }

    next();
  };
}

export function requireAnyPermission(permissions: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "يتطلب هذا الإجراء تسجيل الدخول أولاً."
      });
      return;
    }

    const userRoleStr = String(authReq.user.role);
    const isPlatformOwner = userRoleStr === 'PLATFORM_OWNER' || userRoleStr === 'SUPER_ADMIN';
    const headerTenant = typeof req.headers["x-tenant-id"] === "string" ? req.headers["x-tenant-id"].trim() : undefined;
    const tenantId = authReq.user.tenantId || (isPlatformOwner ? headerTenant : undefined);

    if (!tenantId && !isPlatformOwner) {
      res.status(401).json({
        error: "TENANT_REQUIRED",
        message: "يتطلب هذا الإجراء تحديد مؤسسة صالحة وموثوقة."
      });
      return;
    }

    if (tenantId === "default-tenant" && process.env.NODE_ENV === "production") {
      res.status(401).json({
        error: "INVALID_TENANT",
        message: "default-tenant غير مسموح به في بيئة التشغيل الفعلية."
      });
      return;
    }

    const branchId = (req.headers["x-branch-id"] as string) || (req.body && req.body.branchId) || undefined;

    const userContext: UserIdentityContext = {
      userId: authReq.user.userId,
      username: authReq.user.username,
      role: authReq.user.role,
      tenantId: authReq.user.tenantId,
      branchId: branchId || undefined
    };

    const hasAccess = await AuthorizationService.canAny(userContext, permissions, {
      tenantId,
      branchId
    });

    if (!hasAccess) {
      res.status(403).json({
        error: "PERMISSION_DENIED",
        message: "ليس لديك أي من الصلاحيات المطلوبة لتنفيذ هذا الإجراء.",
        requiredPermissions: permissions
      });
      return;
    }

    next();
  };
}

export function requireBranchAccess(branchIdExtractor?: (req: Request) => string | undefined) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "يتطلب هذا الإجراء تسجيل الدخول أولاً."
      });
      return;
    }

    const targetBranchId = branchIdExtractor 
      ? branchIdExtractor(req) 
      : (req.headers["x-branch-id"] as string) || (req.params && req.params.branchId) || (req.body && req.body.branchId);

    const userContext: UserIdentityContext = {
      userId: authReq.user.userId,
      username: authReq.user.username,
      role: authReq.user.role,
      tenantId: authReq.user.tenantId
    };

    const allowed = AuthorizationService.canAccessBranch(userContext, targetBranchId);
    if (!allowed) {
      res.status(403).json({
        error: "BRANCH_ACCESS_DENIED",
        message: `تم رفض الوصول: المستخدم غير مصرح له بالعمل على الفرع (${targetBranchId}).`,
        targetBranchId
      });
      return;
    }

    next();
  };
}

export function requireRole(roleName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authReq = req as AuthenticatedRequest;
    if (!authReq.user) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "يتطلب هذا الإجراء تسجيل الدخول أولاً."
      });
      return;
    }

    const userContext: UserIdentityContext = {
      userId: authReq.user.userId,
      username: authReq.user.username,
      role: authReq.user.role,
      tenantId: authReq.user.tenantId
    };

    if (!AuthorizationService.hasRole(userContext, roleName)) {
      res.status(403).json({
        error: "ROLE_DENIED",
        message: `يتطلب هذا الإجراء دور (${roleName}).`,
        requiredRole: roleName
      });
      return;
    }

    next();
  };
}
