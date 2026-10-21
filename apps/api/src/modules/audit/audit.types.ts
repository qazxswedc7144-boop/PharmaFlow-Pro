// apps/api/src/modules/audit/audit.types.ts
import { AuditActionType } from '@prisma/client';

export interface AuditLogPayload {
  /** 
   * 🚨 إجباري: معرف المؤسسة (للعزل التام بين بيانات المؤسسات)
   */
  tenantId: string;

  /** 
   * معرف الفرع (اختياري، ولكن مهم لتتبع العمليات في الفروع المتعددة)
   */
  branchId?: string;

  /** 
   * معرف المستخدم الذي قام بالعملية (قد يكون غير موجود في حالة الفشل)
   */
  userId?: string;

  /** 
   * نوع العملية (CREATE, UPDATE, DELETE, USER_LOGIN, إلخ)
   * استخدمنا Enum الخاص بـ Prisma لضمان عدم تمرير قيم غير صحيحة
   */
  action: AuditActionType;

  /** 
   * اسم الجدول أو الكيان (Invoice, Product, User, إلخ)
   */
  entity: string;

  /** 
   * معرف السجل المتأثر (رقم الفاتورة، معرف المنتج...)
   */
  entityId: string;

  /** 
   * الحالة قبل التعديل (JSON String)
   */
  before?: string | null;

  /** 
   * الحالة بعد التعديل (JSON String)
   */
  after?: string | null;

  /** 
   * عنوان IP الخاص بالجهاز
   */
  ipAddress?: string;

  /** 
   * معرف الطلب (Request ID) لتتبع الأخطاء وربط السجل بالعملية
   */
  requestId?: string;
}
