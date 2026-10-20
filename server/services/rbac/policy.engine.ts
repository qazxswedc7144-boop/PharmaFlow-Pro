// server/services/rbac/policy.engine.ts
import { UserIdentityContext } from './types.js';

/**
 * الأدوار التي تملك صلاحية الوصول لكل فروع مؤسستها (وليس غيرها).
 */
const TENANT_WIDE_ADMIN_ROLES = new Set<string>([
  'TENANT_ADMIN',
  'OWNER',
  'PLATFORM_OWNER',
]);

/**
 * الأدوار الوحيدة التي يُسمح لها بعبور حدود المؤسسات (tenants).
 * ⚠️ لا تضف أي دور آخر هنا إلا بمراجعة أمنية صريحة.
 */
const PLATFORM_WIDE_ROLES = new Set<string>(['PLATFORM_OWNER']);

export class PolicyEngine {
  /**
   * تقييم صلاحية المستخدم للوصول إلى فرع محدد.
   *
   * ⚠️ ملاحظة أمنية بخصوص عزل المؤسسات:
   * هذه الدالة لا تعرف مؤسسة الفرع الهدف (targetBranchId)، لذلك لا تستطيع
   * التحقق من أن الفرع ينتمي لمؤسسة المستخدم. عند التعامل مع موارد
   * عابرة للفروع، استخدم الدالة الأكثر أمانًا: canAccessBranchInTenant(...).
   */
  static canAccessBranch(user: UserIdentityContext, targetBranchId?: string | null): boolean {
    // مورد لا يخص فرعًا معينًا (مثل كتالوج أدوية عام) — مسموح.
    if (!targetBranchId) return true;

    const roleUpper = (user.role || '').toUpperCase();
    const rolesUpper = (user.roles || []).map((r) => r.toUpperCase());

    const isPlatformWide =
      PLATFORM_WIDE_ROLES.has(roleUpper) ||
      rolesUpper.some((r) => PLATFORM_WIDE_ROLES.has(r));

    const isTenantWideAdmin =
      isPlatformWide ||
      TENANT_WIDE_ADMIN_ROLES.has(roleUpper) ||
      rolesUpper.some((r) => TENANT_WIDE_ADMIN_ROLES.has(r));

    // المشرفون على مستوى المؤسسة: مسموح داخل مؤسستهم.
    // (المستدعي مسؤول عن التحقق من حدود المؤسسة، أو استخدام النسخة الآمنة أدناه).
    if (isTenantWideAdmin) return true;

    // مستخدم عادي معيّن على فرع محدد: يجب أن يطابق الفرع.
    if (user.branchId) {
      return user.branchId === targetBranchId;
    }

    // 🔴 إصلاح الثغرة الحرجة:
    // كان سابقًا "return true" — أي مستخدم بلا فرع (بسبب خطأ بيانات أو JWT ناقص)
    // كان يستطيع الوصول لكل الفروع. الآن نرفض افتراضيًا (deny by default).
    return false;
  }

  /**
   * النسخة الآمنة متعددة المؤسسات: تتحقق من حدود المؤسسة والفرع معًا.
   * استخدمها دائمًا عند التعامل مع مورد ينتمي إلى مؤسسة معروفة.
   */
  static canAccessBranchInTenant(
    user: UserIdentityContext,
    targetBranchId: string | null | undefined,
    targetBranchTenantId: string | null | undefined,
  ): boolean {
    // مورد بلا فرع — مسموح (سيُفحص على مستوى آخر إن لزم).
    if (!targetBranchId) return true;

    const roleUpper = (user.role || '').toUpperCase();

    // 1. عزل المؤسسات: لا يمكن لأي مستخدم (عدا PLATFORM_OWNER) عبور حدودها.
    if (!PLATFORM_WIDE_ROLES.has(roleUpper)) {
      if (!user.tenantId || !targetBranchTenantId) return false;
      if (user.tenantId !== targetBranchTenantId) return false;
    }

    // 2. بعد ضمان حدود المؤسسة، نتحقق من صلاحية الفرع نفسها.
    return this.canAccessBranch(user, targetBranchId);
  }

  /**
   * النسخة الثابتة للاستخدام السريع من الطبقات المنخفضة.
   *
   * ⚠️ لا تتحقق من حدود المؤسسة — استخدم canAccessBranchInTenant بدلاً منها
   * عند التعامل مع موارد قد تنتمي لمؤسسة أخرى.
   */
  static evaluateBranchAccess(
    userBranchId?: string | null,
    targetBranchId?: string | null,
    role?: string,
  ): boolean {
    const roleUpper = (role || '').toUpperCase();

    if (PLATFORM_WIDE_ROLES.has(roleUpper)) return true;
    if (TENANT_WIDE_ADMIN_ROLES.has(roleUpper)) return true;

    // مورد بلا فرع — مسموح.
    if (!targetBranchId) return true;

    // 🔴 إصلاح الثغرة الثانية:
    // كان سابقًا "if (!targetBranchId || !userBranchId) return true" —
    // أي مستخدم بلا فرع كان يستطيع الوصول لأي فرع. الآن نرفض افتراضيًا.
    if (!userBranchId) return false;

    return userBranchId === targetBranchId;
  }

  /**
   * تقييم ساعات العمل التشغيلية.
   */
  static evaluateOperationalHours(isActive: boolean = true): boolean {
    return isActive;
  }

  /**
   * تقييم صلاحية الفاعل لإدارة/تعديل دور أو حالة مستخدم هدف.
   *
   * ⚠️ لا تتحقق من حدود المؤسسة — استخدم canManageUserInTenant للتحقق الكامل.
   */
  static canManageUser(actor: UserIdentityContext, targetRole?: string | null): boolean {
    const actorRole = (actor.role || '').toUpperCase();
    const target = (targetRole || '').toUpperCase();

    if (actorRole === 'PLATFORM_OWNER') return true;

    if (actorRole === 'TENANT_ADMIN' || actorRole === 'OWNER') {
      return target !== 'PLATFORM_OWNER';
    }

    if (actorRole === 'ADMIN') {
      return (
        target !== 'PLATFORM_OWNER' &&
        target !== 'TENANT_ADMIN' &&
        target !== 'OWNER'
      );
    }

    return false;
  }

  /**
   * النسخة الآمنة متعددة المؤسسات لإدارة المستخدمين:
   * تتحقق من انتماء المستخدم الهدف لنفس مؤسسة الفاعل قبل تطبيق قواعد الأدوار.
   */
  static canManageUserInTenant(
    actor: UserIdentityContext,
    targetRole: string | null | undefined,
    targetTenantId: string | null | undefined,
  ): boolean {
    const actorRole = (actor.role || '').toUpperCase();

    // PLATFORM_OWNER يعبر حدود المؤسسات.
    if (actorRole === 'PLATFORM_OWNER') {
      return this.canManageUser(actor, targetRole);
    }

    // غير ذلك: يجب أن يكون المستخدم الهدف في نفس المؤسسة.
    if (!actor.tenantId || !targetTenantId) return false;
    if (actor.tenantId !== targetTenantId) return false;

    return this.canManageUser(actor, targetRole);
  }

  /**
   * تقييم تطابق حدود المؤسسة بين المستخدم والمورد الهدف.
   */
  static isTenantMatching(user: UserIdentityContext, targetTenantId?: string | null): boolean {
    // مورد بلا مؤسسة (مثل أدوار النظام العامة) — مسموح.
    if (!targetTenantId) return true;
    if ((user.role || '').toUpperCase() === 'PLATFORM_OWNER') return true;
    if (!user.tenantId) return false;
    return user.tenantId === targetTenantId;
  }
}
