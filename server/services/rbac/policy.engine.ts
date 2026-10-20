// server/services/rbac/policy.engine.ts
import { UserIdentityContext } from './types.js';

export class PolicyEngine {
  /**
   * Evaluates whether a user is allowed to access a specific branch.
   */
  static canAccessBranch(user: UserIdentityContext, targetBranchId?: string | null): boolean {
    if (!targetBranchId) return true; // Branch agnostic resource

    // 1. Super users can access all branches within their tenant
    const roleUpper = (user.role || '').toUpperCase();
    const rolesUpper = (user.roles || []).map(r => r.toUpperCase());
    const isTenantWideAdmin = 
      roleUpper === 'PLATFORM_OWNER' || 
      roleUpper === 'TENANT_ADMIN' ||
      roleUpper === 'OWNER' ||
      rolesUpper.includes('PLATFORM_OWNER') || 
      rolesUpper.includes('TENANT_ADMIN');

    if (isTenantWideAdmin) {
      return true;
    }

    // 2. User has a specific branch assigned
    if (user.branchId) {
      return user.branchId === targetBranchId;
    }

    // 3. User with no assigned branch defaults to tenant-level view or allowed
    return true;
  }

  /**
   * Static helper for policy-based branch access evaluation
   */
  static evaluateBranchAccess(userBranchId?: string | null, targetBranchId?: string | null, role?: string): boolean {
    const roleUpper = (role || '').toUpperCase();
    if (roleUpper === 'PLATFORM_OWNER' || roleUpper === 'TENANT_ADMIN' || roleUpper === 'OWNER') {
      return true;
    }
    if (!targetBranchId || !userBranchId) return true;
    return userBranchId === targetBranchId;
  }

  /**
   * Evaluates operational status
   */
  static evaluateOperationalHours(isActive: boolean = true): boolean {
    return isActive;
  }

  /**
   * Evaluates whether an actor has authority to manage/modify target user's role or status.
   */
  static canManageUser(actor: UserIdentityContext, targetRole?: string | null): boolean {
    const actorRole = (actor.role || '').toUpperCase();
    const target = (targetRole || '').toUpperCase();

    if (actorRole === 'PLATFORM_OWNER') return true;

    if (actorRole === 'TENANT_ADMIN' || actorRole === 'OWNER') {
      return target !== 'PLATFORM_OWNER';
    }

    if (actorRole === 'ADMIN') {
      return target !== 'PLATFORM_OWNER' && target !== 'TENANT_ADMIN' && target !== 'OWNER';
    }

    return false;
  }

  /**
   * Evaluates tenant boundary consistency.
   */
  static isTenantMatching(user: UserIdentityContext, targetTenantId?: string | null): boolean {
    if (!targetTenantId) return true;
    if ((user.role || '').toUpperCase() === 'PLATFORM_OWNER') return true;
    if (!user.tenantId) return false;
    return user.tenantId === targetTenantId;
  }
}
