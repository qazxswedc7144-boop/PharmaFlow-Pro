// server/middleware/auth.middleware.ts
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { Role } from "@prisma/client";

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    username: string;
    role: Role;
    tenantId?: string | null;
  };
}

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: JWT_SECRET environment variable is missing in production.');
    }
    return 'pharmaflow-local-development-jwt-secure-secret-2026';
  }
  return secret;
};

const isDevLocalTokenAllowed = () => {
  return process.env.NODE_ENV === 'development' && process.env.DEV_ALLOW_LOCAL_TOKEN === 'true';
};

/**
 * Validates the JWT Bearer Token in authorization headers
 */
export function authenticateToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Access token is missing in request headers."
    });
  }

  if (isDevLocalTokenAllowed() && (token === "local-admin-token" || token.startsWith("local-"))) {
    (req as AuthenticatedRequest).user = {
      userId: "local-admin",
      username: "Administrator",
      role: (Role.ADMIN || "ADMIN") as Role,
      tenantId: "local-tenant-01"
    };
    next();
    return;
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ["HS256"] }) as any;
    if (!decoded || !decoded.userId) {
      return res.status(401).json({
        error: "INVALID_TOKEN",
        message: "Token payload structure is invalid."
      });
    }
    (req as AuthenticatedRequest).user = {
      userId: decoded.userId,
      username: decoded.username || "user",
      role: decoded.role as Role,
      tenantId: decoded.tenantId || null
    };
    next();
    return;
  } catch (err) {
    if (isDevLocalTokenAllowed() && (token === "local-admin-token" || token.startsWith("local-"))) {
      (req as AuthenticatedRequest).user = {
        userId: "local-admin",
        username: "Administrator",
        role: (Role.ADMIN || "ADMIN") as Role,
        tenantId: "local-tenant-01"
      };
      next();
      return;
    }
    return res.status(403).json({
      error: "INVALID_TOKEN",
      message: "Provided access token is expired, revoked, or malformed."
    });
  }
}

/**
 * Validates if the authenticated user possesses the correct Role from the RBAC hierarchy
 */
export function requireRoles(allowedRoles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authenticatedReq = req as AuthenticatedRequest;
    if (!authenticatedReq.user) {
      return res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Authentication is required to perform this action."
      });
    }

    const userRoleStr = (authenticatedReq.user.role || "").toString().toUpperCase();
    const allowedRolesUpper = allowedRoles.map(r => (r || "").toString().toUpperCase());

    const isAllowed = 
      allowedRolesUpper.includes(userRoleStr) ||
      userRoleStr === "ADMIN" ||
      userRoleStr === "PLATFORM_OWNER" ||
      userRoleStr === "TENANT_ADMIN";

    if (!isAllowed) {
      return res.status(403).json({
        error: "ACCESS_DENIED",
        message: `Your role (${authenticatedReq.user.role}) is unauthorized to access this resource.`
      });
    }

    next();
    return;
  };
}
