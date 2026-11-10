// server/services/rbac/permission.service.ts
import { StandardPermission, PermissionCacheEntry } from './types.js';

export const ENTERPRISE_PERMISSIONS: StandardPermission[] = [
  // 1. Sales Module
  { key: 'sales.invoice.view', module: 'sales', action: 'view', description: 'عرض فواتير المبيعات' },
  { key: 'sales.invoice.create', module: 'sales', action: 'create', description: 'إنشاء فاتورة مبيعات جديدة' },
  { key: 'sales.invoice.update', module: 'sales', action: 'edit', description: 'تعديل مسودات فواتير المبيعات' },
  { key: 'sales.invoice.delete', module: 'sales', action: 'delete', description: 'إلغاء وحذف فواتير المبيعات' },
  { key: 'sales.invoice.approve', module: 'sales', action: 'approve', description: 'اعتماد وترحيل فواتير المبيعات' },
  { key: 'sales.invoice.export', module: 'sales', action: 'export', description: 'تصدير وطباعة فواتير المبيعات' },
  { key: 'sales.refund', module: 'sales', action: 'manage', description: 'معالجة مرتجعات المبيعات' },
  { key: 'sales.pos.access', module: 'sales', action: 'view', description: 'الوصول إلى شاشة نقطة البيع السريعة' },
  { key: 'sales.price.override', module: 'sales', action: 'manage', description: 'السماح بتعديل سعر بيع الصنف ضمن حدود سياسة خصم المؤسسة' },

  // 2. Purchases Module
  { key: 'purchases.invoice.view', module: 'purchases', action: 'view', description: 'عرض فواتير المشتريات' },
  { key: 'purchases.invoice.create', module: 'purchases', action: 'create', description: 'إنشاء واستلام فاتورة مشتريات' },
  { key: 'purchases.invoice.update', module: 'purchases', action: 'edit', description: 'تعديل فواتير المشتريات' },
  { key: 'purchases.invoice.delete', module: 'purchases', action: 'delete', description: 'حذف وإلغاء فواتير المشتريات' },
  { key: 'purchases.invoice.approve', module: 'purchases', action: 'approve', description: 'اعتماد فواتير الموردين' },
  { key: 'purchases.invoice.export', module: 'purchases', action: 'export', description: 'تصدير تقارير المشتريات' },

  // 3. Inventory Module
  { key: 'inventory.product.view', module: 'inventory', action: 'view', description: 'عرض دليل المنتجات والأدوية' },
  { key: 'inventory.product.create', module: 'inventory', action: 'create', description: 'إضافة أصناف دوائية جديدة' },
  { key: 'inventory.product.update', module: 'inventory', action: 'edit', description: 'تعديل بيانات المنتجات والأسعار' },
  { key: 'inventory.product.delete', module: 'inventory', action: 'delete', description: 'أرشفة وحذف الأصناف' },
  { key: 'inventory.adjust', module: 'inventory', action: 'adjust', description: 'إجراء تسويات مخزنية وجردية' },
  { key: 'inventory.batch.view', module: 'inventory', action: 'view', description: 'متابعة التشغيلات وتواريخ الصلاحية' },
  { key: 'inventory.batch.manage', module: 'inventory', action: 'manage', description: 'إدارة أرقام التشغيلات واللوت' },
  { key: 'inventory.audit.view', module: 'inventory', action: 'view', description: 'عرض سجلات الجرد الدوري' },
  { key: 'inventory.audit.perform', module: 'inventory', action: 'approve', description: 'تنفيذ وتأكيد عمليات الجرد' },
  { key: 'inventory.transfer.create', module: 'inventory', action: 'create', description: 'إنشاء طلب تحويل بين الفروع' },
  { key: 'inventory.transfer.approve', module: 'inventory', action: 'approve', description: 'اعتماد واستلام التحويلات' },

  // 4. Accounting Module
  { key: 'accounting.journal.view', module: 'accounting', action: 'view', description: 'استعراض قيود اليومية العامة' },
  { key: 'accounting.journal.create', module: 'accounting', action: 'create', description: 'تسجيل قيود يومية يدوية' },
  { key: 'accounting.journal.post', module: 'accounting', action: 'post', description: 'ترحيل وإقفال القيود المحاسبية' },
  { key: 'accounting.account.view', module: 'accounting', action: 'view', description: 'عرض شجرة الحسابات وموازين المراجعة' },
  { key: 'accounting.account.manage', module: 'accounting', action: 'manage', description: 'إدارة وتعديل دليل الحسابات' },
  { key: 'accounting.voucher.create', module: 'accounting', action: 'create', description: 'إصدار سندات القبض والصرف' },
  { key: 'accounting.voucher.view', module: 'accounting', action: 'view', description: 'استعراض سجل السندات المالية' },
  { key: 'accounting.reconcile', module: 'accounting', action: 'reconcile', description: 'إجراء التسويات البنكية والمطابقات' },

  // 5. Reports Module
  { key: 'reports.view', module: 'reports', action: 'view', description: 'استعراض التقارير العامة والإحصائية' },
  { key: 'reports.export', module: 'reports', action: 'export', description: 'تصدير التقارير إلى Excel و PDF' },
  { key: 'reports.export.pdf', module: 'reports', action: 'export', description: 'تصدير التقارير إلى مستندات PDF المعتمدة' },
  { key: 'reports.export.excel', module: 'reports', action: 'export', description: 'تصدير التقارير إلى جداول Excel المحاسبية' },
  { key: 'reports.financial.view', module: 'reports', action: 'view', description: 'عرض القوائم المالية والأرباح' },
  { key: 'reports.financial.export', module: 'reports', action: 'export', description: 'تصدير المركز المالي والأرباح' },
  { key: 'reports.balance_sheet.view', module: 'reports', action: 'view', description: 'استعراض الميزانية العمومية والمركز المالي' },
  { key: 'reports.profit_loss.view', module: 'reports', action: 'view', description: 'استعراض قائمة الأرباح والخسائر والدخل' },
  { key: 'reports.trial_balance.view', module: 'reports', action: 'view', description: 'استعراض ميزان المراجعة الشامل' },
  { key: 'reports.general_ledger.view', module: 'reports', action: 'view', description: 'استعراض دفتر الأستاذ العام وحركات الحسابات' },
  { key: 'reports.inventory.view', module: 'reports', action: 'view', description: 'استعراض تقييم المخزون وصلاحيات الأدوية' },
  { key: 'reports.customer.view', module: 'reports', action: 'view', description: 'استعراض تقارير وذمم العملاء' },
  { key: 'reports.supplier.view', module: 'reports', action: 'view', description: 'استعراض تقارير ومستحقات الموردين' },
  { key: 'reports.tax.view', module: 'reports', action: 'view', description: 'استعراض الإقرارات الضريبية وضريبة القيمة المضافة' },
  { key: 'reports.cash_flow.view', module: 'reports', action: 'view', description: 'استعراض قائمة التدفقات النقدية' },
  { key: 'reports.branch.view', module: 'reports', action: 'view', description: 'استعراض مؤشرات أداء الفروع' },
  { key: 'reports.aging.view', module: 'reports', action: 'view', description: 'متابعة تقرير أعمار الديون' },

  // 6. Settings Module
  { key: 'settings.view', module: 'settings', action: 'view', description: 'عرض إعدادات النظام' },
  { key: 'settings.update', module: 'settings', action: 'edit', description: 'تعديل وضبط إعدادات الصيدلية' },
  { key: 'settings.backup.manage', module: 'settings', action: 'manage', description: 'إدارة النسخ الاحتياطي واستعادة البيانات' },
  { key: 'settings.security.view', module: 'settings', action: 'view', description: 'مراقبة التهديدات والوضع الأمني' },
  { key: 'settings.audit.view', module: 'settings', action: 'view', description: 'استعراض سجلات التدقيق والرقابة' },

  // 7. User & Organization Management Module
  { key: 'users.view', module: 'users', action: 'view', description: 'عرض قائمة المستخدمين وصلاحياتهم' },
  { key: 'users.create', module: 'users', action: 'create', description: 'إضافة مستخدم جديد للنظام' },
  { key: 'users.update', module: 'users', action: 'edit', description: 'تعديل بيانات المستخدمين وتفعيلهم' },
  { key: 'users.delete', module: 'users', action: 'delete', description: 'تعطيل وإلغاء حسابات المستخدمين' },
  { key: 'users.roles.manage', module: 'users', action: 'manage', description: 'تعيين وتعديل أدوار المستخدمين' },
  { key: 'users.permissions.override', module: 'users', action: 'manage', description: 'تخصيص استثناءات الصلاحيات الفردية' },
  { key: 'organization.view', module: 'organization', action: 'view', description: 'عرض بيانات المؤسسة والفروع' },
  { key: 'organization.manage', module: 'organization', action: 'manage', description: 'إدارة هيكل المؤسسة والاشتراكات' },
  { key: 'branches.view', module: 'branches', action: 'view', description: 'استعراض الفروع التابعة' },
  { key: 'branches.manage', module: 'branches', action: 'manage', description: 'إنشاء وتهيئة فروع جديدة' },

  // 8. Synchronization & API Modules
  { key: 'sync.view', module: 'sync', action: 'view', description: 'مراقبة حالة المزامنة اللامركزية' },
  { key: 'sync.trigger', module: 'sync', action: 'manage', description: 'بدء مزامنة فورية قسرية' },
  { key: 'sync.configure', module: 'sync', action: 'edit', description: 'ضبط معلمات المزامنة والتكرار' },
  { key: 'api.access', module: 'api', action: 'view', description: 'استخدام واجهات التكامل البرمجية والذكاء الاصطناعي' },
  { key: 'api.keys.manage', module: 'api', action: 'manage', description: 'توليد وإلغاء مفاتيح الربط البرمجي' },

  // 9. Platform Owner Control Plane (Phase 8.6)
  { key: 'platform.dashboard.view', module: 'platform', action: 'view', description: 'عرض لوحة تحكم مالك المنصة المركزية' },
  { key: 'platform.tenants.read', module: 'platform', action: 'view', description: 'استعراض بيانات المستأجرين والشركات السحابية' },
  { key: 'platform.tenants.create', module: 'platform', action: 'create', description: 'إنشاء وتهيئة مستأجر سحابي جديد مع الفروع' },
  { key: 'platform.tenants.update', module: 'platform', action: 'edit', description: 'تحديث وتعديل بيانات وإعدادات المستأجرين' },
  { key: 'platform.tenants.suspend', module: 'platform', action: 'manage', description: 'تعليق حساب المستأجر مؤقتاً' },
  { key: 'platform.tenants.activate', module: 'platform', action: 'manage', description: 'إعادة تفعيل المستأجرين المعلقين' },
  { key: 'platform.tenants.delete', module: 'platform', action: 'delete', description: 'إلغاء وأرشفة حسابات المستأجرين' },
  { key: 'platform.users.read', module: 'platform', action: 'view', description: 'استعراض المستخدمين عبر كافة المستأجرين' },
  { key: 'platform.users.manage', module: 'platform', action: 'manage', description: 'إدارة المستخدمين والجلسات المركزية' },
  { key: 'platform.branches.read', module: 'platform', action: 'view', description: 'استعراض الفروع عبر كافة المستأجرين' },
  { key: 'platform.branches.manage', module: 'platform', action: 'manage', description: 'إدارة وتفقد الفروع المركزية' },
  { key: 'platform.subscriptions.read', module: 'platform', action: 'view', description: 'استعراض اشتراكات المنصة وتواريخ الانتهاء' },
  { key: 'platform.subscriptions.manage', module: 'platform', action: 'manage', description: 'ترقية وتمديد وتعديل خطط الاشتراكات' },
  { key: 'platform.plans.read', module: 'platform', action: 'view', description: 'استعراض خطط الأسعار والحدود التشغيلية' },
  { key: 'platform.plans.manage', module: 'platform', action: 'manage', description: 'تعديل وإدارة خطط الأسعار السحابية' },
  { key: 'platform.licenses.read', module: 'platform', action: 'view', description: 'استعراض تراخيص المؤسسات والمفاتيح الرقمية' },
  { key: 'platform.licenses.create', module: 'platform', action: 'create', description: 'إصدار وتوقيع تراخيص برمجية جديدة' },
  { key: 'platform.licenses.revoke', module: 'platform', action: 'manage', description: 'إلغاء وإيقاف التراخيص البرمجية' },
  { key: 'platform.devices.read', module: 'platform', action: 'view', description: 'استعراض أجهزة نقاط البيع عبر المنصة' },
  { key: 'platform.devices.manage', module: 'platform', action: 'manage', description: 'إدارة وتعليق وتفعيل أجهزة المزامنة' },
  { key: 'platform.devices.revoke', module: 'platform', action: 'delete', description: 'إلغاء اعتماد وحظر الأجهزة غير المصرح بها' },
  { key: 'platform.sync.read', module: 'platform', action: 'view', description: 'مراقبة أداء المزامنة والنزاعات المركزية' },
  { key: 'platform.sync.manage', module: 'platform', action: 'manage', description: 'تشخيص ومعالجة أعطال المزامنة وإعادة المحاولة' },
  { key: 'platform.audit.read', module: 'platform', action: 'view', description: 'استعراض سجل التدقيق والعمليات الشامل للمنصة' },
  { key: 'platform.security.read', module: 'platform', action: 'view', description: 'مراقبة مركز الأمان والتهديدات ومحاولات الاختراق' },
  { key: 'platform.system.health', module: 'platform', action: 'view', description: 'مراقبة صحة الخوادم وقواعد البيانات وRedis' },
  { key: 'platform.system.diagnostics', module: 'platform', action: 'manage', description: 'تشغيل الاختبارات التشخيصية ومعاينة التخزين' },
  { key: 'platform.backup.read', module: 'platform', action: 'view', description: 'معاينة حالة النسخ الاحتياطي للمنصة والمستأجرين' },
  { key: 'platform.backup.manage', module: 'platform', action: 'manage', description: 'إدارة وتفقد جاهزية الاستعادة والنسخ الاحتياطي' },
  { key: 'platform.api.read', module: 'platform', action: 'view', description: 'استعراض مفاتيح الربط البرمجي ومتابعة Webhooks' },
  { key: 'platform.api.manage', module: 'platform', action: 'manage', description: 'إدارة وتدوير مفاتيح API وإعدادات Webhooks' }
];

export const SYSTEM_ROLE_PERMISSIONS: Record<string, string[]> = {
  PLATFORM_OWNER: ['*'],
  TENANT_ADMIN: [
    'sales.invoice.view', 'sales.invoice.create', 'sales.invoice.update', 'sales.invoice.delete', 'sales.invoice.approve', 'sales.invoice.export', 'sales.refund', 'sales.pos.access', 'sales.price.override',
    'purchases.invoice.view', 'purchases.invoice.create', 'purchases.invoice.update', 'purchases.invoice.delete', 'purchases.invoice.approve', 'purchases.invoice.export',
    'inventory.product.view', 'inventory.product.create', 'inventory.product.update', 'inventory.product.delete', 'inventory.adjust', 'inventory.batch.view', 'inventory.batch.manage', 'inventory.audit.view', 'inventory.audit.perform', 'inventory.transfer.create', 'inventory.transfer.approve',
    'accounting.journal.view', 'accounting.journal.create', 'accounting.journal.post', 'accounting.account.view', 'accounting.account.manage', 'accounting.voucher.create', 'accounting.voucher.view', 'accounting.reconcile',
    'reports.view', 'reports.export', 'reports.financial.view', 'reports.financial.export', 'reports.branch.view', 'reports.aging.view',
    'settings.view', 'settings.update', 'settings.backup.manage', 'settings.security.view', 'settings.audit.view',
    'users.view', 'users.create', 'users.update', 'users.delete', 'users.roles.manage', 'users.permissions.override',
    'organization.view', 'organization.manage', 'branches.view', 'branches.manage',
    'sync.view', 'sync.trigger', 'sync.configure', 'api.access', 'api.keys.manage'
  ],
  ADMIN: [
    'sales.invoice.view', 'sales.invoice.create', 'sales.invoice.update', 'sales.invoice.delete', 'sales.invoice.approve', 'sales.invoice.export', 'sales.refund', 'sales.pos.access', 'sales.price.override',
    'purchases.invoice.view', 'purchases.invoice.create', 'purchases.invoice.update', 'purchases.invoice.delete', 'purchases.invoice.approve', 'purchases.invoice.export',
    'inventory.product.view', 'inventory.product.create', 'inventory.product.update', 'inventory.product.delete', 'inventory.adjust', 'inventory.batch.view', 'inventory.batch.manage', 'inventory.audit.view', 'inventory.audit.perform', 'inventory.transfer.create', 'inventory.transfer.approve',
    'accounting.journal.view', 'accounting.journal.create', 'accounting.account.view', 'accounting.voucher.create', 'accounting.voucher.view', 'accounting.reconcile',
    'reports.view', 'reports.export', 'reports.financial.view', 'reports.branch.view', 'reports.aging.view',
    'settings.view', 'settings.update', 'settings.backup.manage', 'settings.security.view', 'settings.audit.view',
    'users.view', 'users.create', 'users.update', 'branches.view', 'sync.view', 'sync.trigger', 'api.access'
  ],
  ACCOUNTANT: [
    'sales.invoice.view', 'sales.invoice.export',
    'purchases.invoice.view', 'purchases.invoice.export',
    'accounting.journal.view', 'accounting.journal.create', 'accounting.journal.post', 'accounting.account.view', 'accounting.account.manage', 'accounting.voucher.create', 'accounting.voucher.view', 'accounting.reconcile',
    'reports.view', 'reports.export', 'reports.financial.view', 'reports.financial.export', 'reports.aging.view', 'reports.branch.view'
  ],
  INVENTORY_MANAGER: [
    'inventory.product.view', 'inventory.product.create', 'inventory.product.update', 'inventory.product.delete', 'inventory.adjust', 'inventory.batch.view', 'inventory.batch.manage', 'inventory.audit.view', 'inventory.audit.perform', 'inventory.transfer.create', 'inventory.transfer.approve',
    'purchases.invoice.view', 'purchases.invoice.create', 'purchases.invoice.update',
    'reports.view', 'reports.export'
  ],
  PHARMACIST: [
    'sales.invoice.view', 'sales.invoice.create', 'sales.invoice.update', 'sales.invoice.export', 'sales.refund', 'sales.pos.access',
    'purchases.invoice.view', 'purchases.invoice.create',
    'inventory.product.view', 'inventory.batch.view', 'inventory.transfer.create',
    'reports.view'
  ],
  CASHIER: [
    'sales.pos.access', 'sales.invoice.create', 'sales.invoice.view', 'inventory.product.view'
  ],
  AUDITOR: [
    'sales.invoice.view', 'sales.invoice.export',
    'purchases.invoice.view', 'purchases.invoice.export',
    'inventory.product.view', 'inventory.batch.view', 'inventory.audit.view',
    'accounting.journal.view', 'accounting.account.view', 'accounting.voucher.view',
    'reports.view', 'reports.export', 'reports.financial.view', 'reports.financial.export', 'reports.branch.view', 'reports.aging.view',
    'settings.audit.view', 'settings.security.view'
  ]
};

export class PermissionService {
  private static cache = new Map<string, PermissionCacheEntry>();
  private static CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

  static getAllPermissions(): StandardPermission[] {
    return ENTERPRISE_PERMISSIONS;
  }

  static getPermissionsByModule(): Record<string, StandardPermission[]> {
    const grouped: Record<string, StandardPermission[]> = {};
    for (const perm of ENTERPRISE_PERMISSIONS) {
      if (!grouped[perm.module]) {
        grouped[perm.module] = [];
      }
      grouped[perm.module]!.push(perm);
    }
    return grouped;
  }

  static getSystemRolePermissions(roleName: string): string[] {
    const normalized = roleName.toUpperCase().trim();
    return SYSTEM_ROLE_PERMISSIONS[normalized] || [];
  }

  static getCacheKey(tenantId: string, userId: string): string {
    return `${tenantId}:${userId}`;
  }

  static getCachedPermissions(tenantId: string, userId: string): PermissionCacheEntry | null {
    const key = this.getCacheKey(tenantId, userId);
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry;
  }

  static setCachedPermissions(
    tenantId: string,
    userId: string,
    permissions: Set<string>,
    roles: string[],
    branchAssignments: string[]
  ): void {
    const key = this.getCacheKey(tenantId, userId);
    this.cache.set(key, {
      permissions,
      roles,
      branchAssignments,
      cachedAt: Date.now(),
      expiresAt: Date.now() + this.CACHE_TTL_MS
    });
  }

  static invalidateUser(userId: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${userId}`)) {
        this.cache.delete(key);
      }
    }
  }

  static invalidateUserCache(tenantId: string, userId: string): void {
    const key = this.getCacheKey(tenantId, userId);
    this.cache.delete(key);
    console.log(`[RBAC CACHE] Invalidated cache for user ${userId} in tenant ${tenantId}`);
  }

  static getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }

  static invalidateTenantCache(tenantId: string): void {
    const prefix = `${tenantId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
    console.log(`[RBAC CACHE] Invalidated all cache entries for tenant ${tenantId}`);
  }

  static clearAllCache(): void {
    this.cache.clear();
  }
}
