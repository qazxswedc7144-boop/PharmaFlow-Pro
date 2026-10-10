// server/routes/auth.routes.ts
import { Router, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { prisma, OfflineDatabaseError } from "../database/prisma.js";
import { Role } from "@prisma/client";
import { LoginSchema } from "../../src/shared/validation/auth.schema.js";
import { validateRequestBody } from "../middleware/validate.js";
import { authenticateToken, requireRoles, AuthenticatedRequest } from "../middleware/auth.middleware.js";
import { AuthorizationService } from "../services/rbac/authorization.service.js";
import { PermissionService } from "../services/rbac/permission.service.js";

import rateLimit from "express-rate-limit";

export const authRouter = Router();

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

const getJwtRefreshSecret = () => {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FATAL: JWT_REFRESH_SECRET environment variable is missing in production.');
    }
    return 'pharmaflow-local-development-jwt-refresh-secure-secret-2026';
  }
  return secret;
};

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: "RATE_LIMIT_EXCEEDED",
    message: "تم تقييد محاولات تسجيل الدخول حماية للحسابات من هجمات القوة الغاشمة. يرجى الانتظار 15 دقيقة."
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: { default: false }
});

/**
 * GET /api/auth/bootstrap-status
 * Checks if the system has no users and requires bootstrapping
 */
authRouter.get("/bootstrap-status", async (_req: Request, res: Response) => {
  try {
    const userCount = await prisma.user.count();
    return res.status(200).json({
      requiresBootstrap: userCount === 0
    });
  } catch (err: any) {
    if (err instanceof OfflineDatabaseError) return res.status(503).json({ success: false, offline: true, message: "Database unavailable." });
    return res.status(505).json({
      error: "INTERNAL_ERROR",
      message: err.message
    });
  }
});

/**
 * POST /api/auth/bootstrap
 * Bootstrap the first admin user, tenant, and mark system initialized if no users exist.
 */
authRouter.post("/bootstrap", async (req: Request, res: Response) => {
  try {
    const userCount = await prisma.user.count();

    if (userCount > 0) {
      return res.status(403).json({
        error: "SYSTEM_ALREADY_INITIALIZED"
      });
    }

    const { username, password, tenantName } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: "INVALID_INPUT",
        message: "Username and password are required to bootstrap the system."
      });
    }

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(String(password || ''), saltRounds);

    await prisma.$transaction(async (tx) => {
      // Create first ADMIN user
      const adminUser = await tx.user.create({
        data: {
          username,
          passwordHash,
          role: Role.ADMIN
        }
      });

      // Create tenant owner
      const tenant = await tx.tenant.create({
        data: {
          name: tenantName || "Default Tenant",
          domain: `${username}-tenant.pharmaflow.local`
        }
      });

      await tx.tenantUser.create({
        data: {
          tenantId: tenant.id,
          userId: adminUser.id,
          role: "TENANT_ADMIN"
        }
      });

      // Log action in auditLog
      await tx.auditLog.create({
        data: {
          userId: adminUser.id,
          action: "SYSTEM_BOOTSTRAP",
          entity: "System",
          entityId: "SYSTEM_BOOTSTRAP",
          before: null,
          after: JSON.stringify({
            userId: adminUser.id,
            username: adminUser.username,
            tenantId: tenant.id,
            tenantName: tenant.name,
            systemInitialized: true
          }),
          ipAddress: req.ip
        }
      });
    });

    return res.status(200).json({
      success: true,
      requiresBootstrap: false
    });
  } catch (err: any) {
    if (err instanceof OfflineDatabaseError) return res.status(503).json({ success: false, offline: true, message: "Database unavailable." });
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: err.message
    });
  }
});

/**
 * POST /api/auth/register
 * Only log-certified ADMIN can construct and register new users
 */
authRouter.post("/register", authenticateToken, requireRoles([Role.ADMIN]), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { username, password, role, branchId, tenantId } = req.body;

    // 1. Validate inputs
    if (!username || typeof username !== "string" || username.trim().length < 3) {
      return res.status(400).json({
        error: "INVALID_INPUT",
        message: "Username is required and must be at least 3 characters."
      });
    }

    if (!password || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({
        error: "INVALID_INPUT",
        message: "Password is required and must be at least 6 characters."
      });
    }

    const validRoles = Object.values(Role);
    if (!role || !validRoles.includes(role as Role)) {
      return res.status(400).json({
        error: "INVALID_INPUT",
        message: `Role is required and must be one of: ${validRoles.join(", ")}.`
      });
    }

    if (!branchId || typeof branchId !== "string" || branchId.trim() === "") {
      return res.status(400).json({
        error: "INVALID_INPUT",
        message: "Branch ID is required and must be a non-empty string."
      });
    }

    if (!tenantId || typeof tenantId !== "string" || tenantId.trim() === "") {
      return res.status(400).json({
        error: "INVALID_INPUT",
        message: "Tenant ID is required and must be a non-empty string."
      });
    }

    // 2. Database validation: verify unique user, existing tenant and existing branch
    const existingUser = await prisma.user.findUnique({
      where: { username: username.trim() }
    });
    if (existingUser) {
      return res.status(400).json({
        error: "USER_ALREADY_EXISTS",
        message: `Username "${username}" already exists.`
      });
    }

    const tenantExists = await prisma.tenant.findUnique({
      where: { id: tenantId }
    });
    if (!tenantExists) {
      return res.status(400).json({
        error: "TENANT_NOT_FOUND",
        message: "The specified Tenant ID does not exist."
      });
    }

    const branchExists = await prisma.branch.findUnique({
      where: { id: branchId }
    });
    if (!branchExists) {
      return res.status(400).json({
        error: "BRANCH_NOT_FOUND",
        message: "The specified Branch ID does not exist."
      });
    }

    // 3. Hash the password
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(String(password || ''), saltRounds);

    // 4. Create everything atomically
    const user = await prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          username: username.trim(),
          passwordHash,
          role: role as Role
        },
        select: {
          id: true,
          username: true,
          role: true,
          createdAt: true
        }
      });

      // Link User with the Tenant
      await tx.tenantUser.create({
        data: {
          tenantId,
          userId: newUser.id,
          role: "STAFF"
        }
      });

      // Link User with the default Branch
      await tx.branchUser.create({
        data: {
          tenantId,
          branchId,
          userId: newUser.id,
          isDefault: true
        }
      });

      return newUser;
    });

    // 5. Audit log All User Creations
    await prisma.auditLog.create({
      data: {
        userId: req.user?.userId || user.id,
        action: "USER_CREATE",
        entity: "User",
        entityId: user.id,
        before: null,
        after: JSON.stringify({
          id: user.id,
          username: user.username,
          role: user.role,
          tenantId,
          branchId,
          createdBy: req.user?.username || "SYSTEM"
        }),
        ipAddress: req.ip
      }
    });

    return res.status(201).json({
      success: true,
      user
    });
  } catch (err: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
  }
});

/**
 * POST /api/auth/login
 * Standard user authenticate credentials with audit tracking
 */
authRouter.post("/login", loginRateLimiter, validateRequestBody(LoginSchema), async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    // 1. Find user by username
    const user = await prisma.user.findUnique({
      where: { username }
    });

    if (!user) {
      return res.status(401).json({
        error: "INVALID_CREDENTIALS",
        message: "اسم المستخدم أو كلمة المرور غير صحيحة."
      });
    }

    // 2. Verify bcrypt password
    if (!user.passwordHash) {
      return res.status(401).json({
        error: "INVALID_CREDENTIALS",
        message: "اسم المستخدم أو كلمة المرور غير صحيحة."
      });
    }
    const isPasswordValid = await bcrypt.compare(String(password || ''), String(user.passwordHash));
    if (!isPasswordValid) {
      return res.status(401).json({
        error: "INVALID_CREDENTIALS",
        message: "اسم المستخدم أو كلمة المرور غير صحيحة."
      });
    }

    // 3. Reject inactive users
    if (!user.isActive) {
      return res.status(403).json({
        error: "ACCOUNT_DISABLED",
        message: "Account is disabled."
      });
    }

    // Look up tenant registration link for isolation support (with dynamic self-healing)
    let tUser = await prisma.tenantUser.findFirst({
      where: { userId: user.id }
    });
    let tenantId = tUser?.tenantId || null;

    if (!tenantId) {
      console.warn(`⚠️ User "${username}" lacks tenant association. Securing default tenant...`);
      let tenant = await prisma.tenant.findFirst();
      if (!tenant) {
        tenant = await prisma.tenant.create({
          data: {
            name: "المؤسسة الدوائية المركزية",
            isActive: true,
          }
        });
      }
      tenantId = tenant.id;
      await prisma.tenantUser.create({
        data: {
          tenantId: tenant.id,
          userId: user.id,
          role: user.role === Role.ADMIN ? "TENANT_ADMIN" : "STAFF",
        }
      }).catch((err) => console.error(`⚠️ Tenant link create error: ${err.message}`));
    }

    // Look up branch registration link for isolation support (with dynamic self-healing)
    let bUser = await prisma.branchUser.findFirst({
      where: { userId: user.id, tenantId }
    });
    if (!bUser) {
      console.warn(`⚠️ User "${username}" lacks branch association. Securing default branch...`);
      let branch = await prisma.branch.findFirst({
        where: { tenantId }
      });
      if (!branch) {
        const branchCode = `BRH-${tenantId.slice(0, 4).toUpperCase()}-101`;
        branch = await prisma.branch.create({
          data: {
            code: branchCode,
            name: "الفرع الرئيسي",
            isActive: true,
            tenantId,
          }
        });
        await prisma.branchSettings.create({
          data: {
            branchId: branch.id,
            enableAutoMatching: true,
            strictFifo: true,
            ledgerSyncEnabled: true,
            dualAuthLimit: 10000.00,
            allowedIpRanges: "*",
          }
        }).catch(() => {});
      }
      await prisma.branchUser.create({
        data: {
          tenantId,
          branchId: branch.id,
          userId: user.id,
          isDefault: true,
        }
      }).catch((err) => console.error(`⚠️ Branch link create error: ${err.message}`));
    }

    const branchId = bUser?.branchId || null;
    let subscriptionPlan = "ENTERPRISE";
    try {
      const sub = await prisma.tenantSubscription.findFirst({
        where: { tenantId, isActive: true },
        include: { plan: true },
        orderBy: { endDate: "desc" }
      }).catch(() => null);
      if (sub?.plan?.code) {
        subscriptionPlan = sub.plan.code;
      }
    } catch {}

    // 4. Generate: accessToken and refreshToken with full tenant & RBAC context
    const accessToken = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, tenantId, branchId, subscriptionPlan },
      getJwtSecret(),
      { expiresIn: "4h" }
    );

    const refreshToken = jwt.sign(
      { userId: user.id, tenantId, branchId },
      getJwtRefreshSecret(),
      { expiresIn: "7d" }
    );

    // 5. Store refresh token hash
    const refreshTokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days expiration

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: refreshTokenHash,
        expiresAt
      }
    });

    // 6. Update lastLoginAt
    const now = new Date();
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: now }
    });

    // 7. Create audit log
    await prisma.auditLog.create({
      data: {
        userId: user.id,
        action: "USER_LOGIN",
        entity: "User",
        entityId: user.id,
        before: null,
        after: JSON.stringify({
          username: user.username,
          tenantId,
          branchId,
          subscriptionPlan,
          lastLoginAt: now
        }),
        ipAddress: req.ip
      }
    });

    // Fetch user permissions using AuthorizationService and PermissionService
    const permissionCodesSet = await AuthorizationService.getUserEffectivePermissions(tenantId, user.id, user.role).catch(() => new Set<string>());
    let permissionCodes = Array.from(permissionCodesSet);
    if (permissionCodes.length === 0) {
      const fallbackPerms = PermissionService.getSystemRolePermissions(user.role);
      for (const p of fallbackPerms) permissionCodes.push(p);
    }
    const allPerms = PermissionService.getAllPermissions();
    const permissions = allPerms.filter(p => permissionCodes.includes(p.key) || permissionCodes.includes('*'));

    // Response structure
    return res.json({
      accessToken,
      refreshToken,
      tenantId,
      branchId,
      subscriptionPlan,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        tenantId,
        branchId,
        subscriptionPlan,
        permissions: permissionCodes,
        isActive: user.isActive,
        lastLoginAt: now
      },
      permissions
    });
  } catch (err: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
  }
});

/**
 * POST /api/auth/refresh
 * Refreshes an access token using a valid, stored refresh token with rotation.
 */
authRouter.post("/refresh", async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: "REFRESH_TOKEN_REQUIRED", message: "Refresh token is required." });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(refreshToken, getJwtRefreshSecret());
    } catch (err) {
      return res.status(401).json({ error: "INVALID_REFRESH_TOKEN", message: "Invalid or expired refresh token." });
    }

    const refreshTokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const record = await prisma.refreshToken.findUnique({
      where: { token: refreshTokenHash }
    });

    if (!record || record.revoked || record.expiresAt < new Date()) {
      return res.status(401).json({ error: "INVALID_REFRESH_TOKEN", message: "Refresh token is invalid, revoked, or expired." });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      return res.status(401).json({ error: "USER_NOT_FOUND", message: "User not found." });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: "ACCOUNT_SUSPENDED", message: "Account is suspended." });
    }

    const tUser = await prisma.tenantUser.findFirst({
      where: { userId: user.id }
    });
    const tenantId = tUser?.tenantId || null;

    // Generate fresh access token
    const accessToken = jwt.sign(
      { userId: user.id, username: user.username, role: user.role, tenantId },
      getJwtSecret(),
      { expiresIn: "4h" }
    );

    // Rotate refresh token
    const newRefreshToken = jwt.sign(
      { userId: user.id, tenantId },
      getJwtRefreshSecret(),
      { expiresIn: "7d" }
    );
    const newRefreshTokenHash = crypto.createHash("sha256").update(newRefreshToken).digest("hex");
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    // Delete old refresh token record and insert new rotated token
    await prisma.refreshToken.delete({
      where: { id: record.id }
    }).catch(() => {});

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        token: newRefreshTokenHash,
        expiresAt
      }
    });

    return res.json({
      accessToken,
      refreshToken: newRefreshToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        tenantId,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt
      }
    });
  } catch (err: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
  }
});

/**
 * POST /api/auth/logout
 * Destroys session / refresh token
 */
authRouter.post("/logout", async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const refreshTokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
      await prisma.refreshToken.delete({
        where: { token: refreshTokenHash }
      }).catch(() => {});
    }
    return res.json({ success: true, message: "Logged out successfully." });
  } catch (err: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
  }
});

/**
 * TEMPORARY ENDPOINT: POST /api/auth/admin-reset
 * Reset stale admin user for Phase 13 migration.
 * Will be removed in a follow-up commit.
 */
authRouter.post("/admin-reset", async (req: Request, res: Response) => {
  try {
    const resetKey = req.headers["x-reset-key"];
    const expectedKey = process.env.ADMIN_RESET_KEY || "pharmaflow-admin-reset-2026";

    if (!resetKey || resetKey !== expectedKey) {
      return res.status(403).json({ error: "FORBIDDEN", message: "Invalid or missing reset key." });
    }

    const targetUsername = req.body?.username || "admin";

    // Find users with username
    const users = await prisma.user.findMany({
      where: { username: targetUsername }
    });

    for (const u of users) {
      // Delete refresh tokens associated with user
      await prisma.refreshToken.deleteMany({
        where: { userId: u.id }
      }).catch(() => {});

      // Delete user
      await prisma.user.delete({
        where: { id: u.id }
      }).catch(() => {});
    }

    return res.json({ success: true, message: `Successfully reset user ${targetUsername}.` });
  } catch (err: any) {
    return res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
  }
});


