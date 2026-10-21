// apps/api/src/modules/audit/audit.repository.ts
// يفضل استخدام مسار مطلق أو Alias بدلاً من المسارات النسبية الطويلة
import { prisma } from "@server/database/prisma.js"; 
import { AuditLogPayload } from "./audit.types.js";
import { Prisma } from "@prisma/client";

export class AuditRepository {
  /**
   * Append-only database insertion of audit traces.
   * Modifying existing audit logs is strictly impossible due to lack of update/delete actions.
   */
  static async create(payload: AuditLogPayload) {
    try {
      // 🚨 إصلاح أمني: يجب إرسال tenantId و branchId دائماً
      if (!payload.tenantId) {
        throw new Error("AUDIT_LOG_REJECTED: tenantId is mandatory for security reasons.");
      }

      return await prisma.auditLog.create({
        data: {
          tenantId: payload.tenantId,         // ✅ إجباري للعزل
          branchId: payload.branchId || null, // ✅ مهم للفروع
          userId: payload.userId || null,
          action: payload.action,
          entity: payload.entity,
          entityId: payload.entityId,
          before: payload.before || null,
          after: payload.after || null,
          ipAddress: payload.ipAddress || "system",
          requestId: payload.requestId || null
        }
      });
    } catch (error: any) {
      // لا نريد أن يفشل حفظ الفاتورة الأساسية بسبب سجل التدقيق
      console.error("[AuditRepository] Failed to write audit log:", error.message);
      
      // إذا كان الخطأ هو Foreign Key (مثلاً userId غير موجود)، لا نرمي خطأ، بل نسجل تحذيراً
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
         console.warn(`[AuditRepository] Invalid userId or tenantId for audit log.`);
         return null; 
      }
      throw error;
    }
  }

  static async findMany(tenantId: string, filters: { userId?: string; entity?: string; action?: string; branchId?: string }) {
    if (!tenantId) {
      throw new Error("ACCESS_DENIED: tenantId is required to query audit logs.");
    }

    return prisma.auditLog.findMany({
      where: {
        tenantId: tenantId, // 🚨 إصلاح أمني: عزل السجلات بحسب المؤسسة
        branchId: filters.branchId || undefined,
        userId: filters.userId || undefined,
        entity: filters.entity || undefined,
        action: filters.action || undefined
      },
      orderBy: {
        timestamp: "desc"
      },
      // يفضل تحديد الحد الأقصى للسجلات لمنع استهلاك الذاكرة في حال وجود ملايين السجلات
      take: 1000 
    });
  }
}
