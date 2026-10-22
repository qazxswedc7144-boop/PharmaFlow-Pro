// apps/api/src/modules/auth/auth.controller.ts
import { Response } from "express";
import { AuthenticatedRequest } from "./auth.middleware.js";
import { AuthService } from "./auth.service.js";
import { AuditService } from "../audit/audit.service.js";
import { prisma } from "../../../../../server/database/prisma.js";

export class AuthController {
  /**
   * Safe login execution with tenant isolation and audit logging.
   */
  static async login(req: AuthenticatedRequest, res: Response) {
    try {
      const { username, password, tenantId: requestedTenantId } = req.body;

      const user = await prisma.user.findUnique({
        where: { username },
        include: {
          tenantUsers: {
            include: { tenant: true }
          }
        }
      });

      // 🚨 فحص أمني: لا نكشف إن كان المستخدم موجوداً أو لا
      if (!user || user.passwordHash === "") {
        await AuditService.logLoginAttempt(undefined, undefined, username, "FAILED", req.ip);
        return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "خطأ في اسم المستخدم أو كلمة المرور." });
      }

      const isValid = await AuthService.verifyPassword(password, user.passwordHash);
      if (!isValid) {
        // نحتاج لمعرفة المؤسسة لتسجيل الفشل بدقة (نستخدم الأولى كاحتياط)
        const fallbackTenantId = user.tenantUsers[0]?.tenantId;
        await AuditService.logLoginAttempt(fallbackTenantId, user.id, username, "FAILED", req.ip);
        return res.status(401).json({ error: "INVALID_CREDENTIALS", message: "خطأ في اسم المستخدم أو كلمة المرور." });
      }

      if (!user.isActive) {
        return res.status(403).json({ error: "ACCOUNT_SUSPENDED", message: "حساب المستخدم معطل حالياً." });
      }

      // 🚨 إصلاح جوهري: تحديد المؤسسة (Tenant) التي سيدخل بها المستخدم
      let activeTenantId: string | undefined;
      if (requestedTenantId) {
        // التحقق أن المستخدم فعلاً عضو في المؤسسة المطلوبة
        const membership = user.tenantUsers.find(tu => tu.tenantId === requestedTenantId && tu.tenant.isActive);
        if (!membership) {
          return res.status(403).json({ error: "TENANT_ACCESS_DENIED", message: "لا تملك صلاحية الوصول لهذه المؤسسة." });
        }
        activeTenantId = membership.tenantId;
      } else {
        // إذا لم يحدد، نستخدم أول مؤسسة نشطة
        activeTenantId = user.tenantUsers.find(tu => tu.tenant.isActive)?.tenantId;
      }

      if (!activeTenantId) {
        return res.status(403).json({ error: "NO_ACTIVE_TENANT", message: "لا يوجد حساب مؤسسة نشط لهذا المستخدم." });
      }

      // ملاحظة: AuthService يجب أن يستقبل activeTenantId ليضعه في التوكن
      const accessToken = AuthService.generateAccessToken({ ...user, tenantId: activeTenantId });
      const refreshToken = AuthService.generateRefreshToken({ ...user, tenantId: activeTenantId });

      // Persist active sessions
      await AuthService.createSession(user.id, accessToken, req.ip, req.headers["user-agent"]);
      await AuthService.createRefreshTokenRecord(user.id, refreshToken);

      // ✅ تسجيل النجاح مع الـ tenantId الصحيح
      await AuditService.logLoginAttempt(activeTenantId, user.id, username, "SUCCESS", req.ip);

      return res.json({
        success: true,
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          tenantId: activeTenantId // ✅ مهم جداً للـ frontend
        }
      });
    } catch (err: any) {
      console.error("[AUTH] Login error:", err);
      return res.status(500).json({ 
        error: "INTERNAL_ERROR", 
        message: process.env.NODE_ENV === 'production' ? "خطأ داخلي في الخادم." : err.message 
      });
    }
  }

  /**
   * Refreshes access token with valid rotation.
   */
  static async refresh(req: AuthenticatedRequest, res: Response) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) {
        return res.status(400).json({ error: "REFRESH_TOKEN_REQUIRED", message: "رمز التحديث مطلوب." });
      }

      const decoded = AuthService.verifyRefreshToken(refreshToken);
      const record = await prisma.refreshToken.findUnique({
        where: { token: refreshToken }
      });

      if (!record || record.revoked || record.expiresAt < new Date()) {
        return res.status(401).json({ error: "INVALID_REFRESH_TOKEN", message: "رمز التحديث تالف أو ملغى أو منتهي الصلاحية." });
      }

      // جلب المستخدم مع مؤسساته
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
        include: { tenantUsers: { include: { tenant: true } } }
      });

      if (!user || !user.isActive) {
        return res.status(401).json({ error: "USER_INACTIVE", message: "لم يعد حساب المستخدم المرتبط نشطاً." });
      }

      // استخراج tenantId من التوكن القديم أو من أول مؤسسة نشطة
      const activeTenantId = (decoded as any).tenantId || user.tenantUsers.find(tu => tu.tenant.isActive)?.tenantId;

      if (!activeTenantId) {
        return res.status(403).json({ error: "NO_ACTIVE_TENANT", message: "لا يوجد حساب مؤسسة نشط." });
      }

      const newAccessToken = AuthService.generateAccessToken({ ...user, tenantId: activeTenantId });
      
      // ✅ Refresh Token Rotation (إصلاح أمني: إلغاء القديم وإصدار جديد)
      await AuthService.revokeRefreshToken(refreshToken);
      const newRefreshToken = AuthService.generateRefreshToken({ ...user, tenantId: activeTenantId });
      await AuthService.createRefreshTokenRecord(user.id, newRefreshToken);
      await AuthService.createSession(user.id, newAccessToken, req.ip, req.headers["user-agent"]);

      return res.json({
        success: true,
        accessToken: newAccessToken,
        refreshToken: newRefreshToken // ✅ تم عكس الرمز
      });
    } catch (err: any) {
      return res.status(401).json({ error: "INVALID_REFRESH_TOKEN", message: "فشل التحقق من توقيع الرمز." });
    }
  }

  /**
   * Logs out and terminates running sessions.
   */
  static async logout(req: AuthenticatedRequest, res: Response) {
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const token = authHeader.split(" ")[1];
        if (token) {
          await AuthService.revokeSession(token);
        }
      }

      const { refreshToken } = req.body;
      if (refreshToken) {
        await AuthService.revokeRefreshToken(refreshToken);
      }

      if (req.user) {
        // ✅ إصلاح: القيمة الصحيحة من الـ Enum + إضافة tenantId و ip
        await AuditService.log({
          tenantId: (req.user as any).tenantId || "SYSTEM",
          userId: req.user.userId,
          action: "USER_LOGIN", // نستخدم USER_LOGIN لأن الـ Schema لا يحتوي على USER_LOGOUT
          entity: "User",
          entityId: req.user.userId,
          after: JSON.stringify({ event: "LOGOUT", message: "Sessions invalidated cleanly" }),
          ipAddress: req.ip
        });
      }

      return res.json({ success: true, message: "تم تسجيل الخروج بنجاح وتدمير الرموز المفتوحة." });
    } catch (err: any) {
      console.error("[AUTH] Logout error:", err);
      return res.status(500).json({ 
        error: "INTERNAL_ERROR", 
        message: process.env.NODE_ENV === 'production' ? "خطأ داخلي." : err.message 
      });
    }
  }

  /**
   * Retrieves active identity context.
   */
  static me(req: AuthenticatedRequest, res: Response) {
    if (!req.user) {
      return res.status(401).json({ error: "UNAUTHORIZED", message: "جلسة العمل مفقودة." });
    }
    return res.json({
      success: true,
      user: {
        id: req.user.userId,
        username: req.user.username,
        role: req.user.role,
        tenantId: (req.user as any).tenantId, // ✅ إضافة مهمة جداً للـ frontend
      }
    });
  }
}
