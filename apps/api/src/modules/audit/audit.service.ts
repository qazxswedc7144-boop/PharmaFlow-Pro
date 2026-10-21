// apps/api/src/modules/audit/audit.service.ts
import { AuditRepository } from "./audit.repository.js";
import { AuditLogPayload } from "./audit.types.js";

export class AuditService {
  /**
   * Safe, append-only logger of core mutations.
   */
  static async log(payload: AuditLogPayload) {
    try {
      // 🚨 إصلاح: التحقق من وجود tenantId قبل الحفظ
      if (!payload.tenantId) {
        console.warn("⚠️ Audit log rejected: Missing tenantId.");
        return { success: false, error: "Missing tenantId" };
      }

      const doc = await AuditRepository.create(payload);
      return { success: true, docId: doc?.id };
    } catch (err: any) {
      console.warn("⚠️ Immutable audit record injection failed:", err.message);
      return { success: false, error: err.message };
    }
  }

  // 🚨 إصلاح: أضفنا tenantId (إجباري) و branchId (اختياري) لكل الدوال

  static async logInvoiceCreated(tenantId: string, userId: string, invoiceId: string, payload: any, ip?: string, branchId?: string) {
    return this.log({
      tenantId,
      branchId,
      userId,
      action: "CREATE", // ✅ القيمة الصحيحة من الـ Schema
      entity: "Invoice",
      entityId: invoiceId,
      after: JSON.stringify(payload),
      ipAddress: ip
    });
  }

  static async logInvoiceApproved(tenantId: string, userId: string, invoiceId: string, payload: any, ip?: string, branchId?: string) {
    return this.log({
      tenantId,
      branchId,
      userId,
      action: "UPDATE", // ✅ القيمة الصحيحة من الـ Schema
      entity: "Invoice",
      entityId: invoiceId,
      after: JSON.stringify(payload),
      ipAddress: ip
    });
  }

  static async logStockAdjusted(tenantId: string, userId: string, productId: string, payload: any, ip?: string, branchId?: string) {
    return this.log({
      tenantId,
      branchId,
      userId,
      action: "UPDATE", // ✅ القيمة الصحيحة من الـ Schema
      entity: "Product",
      entityId: productId,
      after: JSON.stringify(payload),
      ipAddress: ip
    });
  }

  static async logLoginAttempt(tenantId: string | undefined, userId: string | undefined, username: string, status: "SUCCESS" | "FAILED", ip?: string) {
    return this.log({
      tenantId: tenantId || "SYSTEM", // يمكن استخدام SYSTEM للفشل قبل معرفة المؤسسة
      userId,
      action: "USER_LOGIN", // ✅ القيمة الصحيحة من الـ Schema
      entity: "User",
      entityId: username,
      after: JSON.stringify({ status, username }), // خزنا الحالة في الـ after
      ipAddress: ip
    });
  }

  static async logFailedAuth(ip: string, details: string) {
    return this.log({
      tenantId: "SYSTEM", // لم نتمكن من تحديد المؤسسة بسبب فشل المصادقة
      action: "USER_LOGIN", // استخدمنا نفس الـ enum، والتفاصيل في after
      entity: "GlobalGuard",
      entityId: ip,
      after: JSON.stringify({ error: details, type: "UNAUTHORIZED_ATTEMPT" }),
      ipAddress: ip
    });
  }

  static async logJournalPosted(tenantId: string, userId: string, entryId: string, payload: any, ip?: string, branchId?: string) {
    return this.log({
      tenantId,
      branchId,
      userId,
      action: "POST_JOURNAL", // ✅ القيمة الصحيحة من الـ Schema
      entity: "JournalEntry",
      entityId: entryId,
      after: JSON.stringify(payload),
      ipAddress: ip
    });
  }
}
