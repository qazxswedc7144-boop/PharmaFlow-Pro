// server/services/rbac/authorization.service.ts
import { UserIdentityContext, AuthorizationEvaluationContext } from './types.js';
import { PermissionService } from './permission.service.js';
import { RoleService } from './role.service.js';
import { PolicyEngine } from './policy.engine.js';

export interface AuthorizationDecision {
  allowed: boolean;
  reason: string;
}

export class AuthorizationService {
  /**
   * Resolves the full set of effective permissions for a user within a tenant.
   * Order of evaluation:
   * 1. Cache hit (TTL 10m)
   * 2. Direct system role permissions
   * 3. Custom assigned role permissions (aggregated)
   * 4. User permission overrides (ALLOW / DENY - DENY takes precedence)
   */
  static async getUserEffectivePermissions(
    tenantId: string,
    userId: string,
    baseRole?: string | null
  ): Promise<Set<string>> {
    // 1. Check cache
    const cached = PermissionService.getCachedPermissions(tenantId, userId);
    if (cached) {
      return cached.permissions;
    }

    const effectivePermissions = new Set<string>();
    const rolesCollected: string[] = [];

    // 2. Base role from JWT or user record
    if (baseRole) {
      rolesCollected.push(baseRole);
      const systemPerms = PermissionService.getSystemRolePermissions(baseRole);
      for (const p of systemPerms) {
        effectivePermissions.add(p);
      }
    }

    // 3. User assigned custom roles
    try {
      const userRoles = await RoleService.getUserRoles(tenantId, userId);
      for (const ur of userRoles) {
        if (ur.roleName) rolesCollected.push(ur.roleName);
        const role = await RoleService.getRoleById(ur.roleId, tenantId);
        if (role && role.permissions) {
          for (const p of role.permissions) {
            effectivePermissions.add(p);
          }
        }
      }
    } catch (err) {
      console.warn('[AuthService] Error loading user roles:', (err as Error).message);
    }

    // 4. User permission overrides (ALLOW / DENY)
    try {
      const overrides = await RoleService.getUserPermissionOverrides(tenantId, userId);
      for (const ov of overrides) {
        if (ov.effect === 'ALLOW') {
          effectivePermissions.add(ov.permissionKey);
        } else if (ov.effect === 'DENY') {
          effectivePermissions.delete(ov.permissionKey);
        }
      }
    } catch (err) {
      console.warn('[AuthService] Error loading user overrides:', (err as Error).message);
    }

    // Cache the result
    PermissionService.setCachedPermissions(tenantId, userId, effectivePermissions, rolesCollected, []);

    return effectivePermissions;
  }

  /**
   * Detailed evaluation of authorization decision with reasoning.
   */
  static async evaluate(
    user: UserIdentityContext | undefined | null,
    permissionKey: string,
    context?: AuthorizationEvaluationContext
  ): Promise<AuthorizationDecision> {
    if (!user) {
      return { allowed: false, reason: "Unauthenticated context (No user provided)" };
    }
    if (user.isActive === false) {
      return { allowed: false, reason: "User account is deactivated" };
    }

    const roleUpper = (user.role || '').toUpperCase().trim();

    // 1. Platform Owner Wildcard Access
    if (roleUpper === 'PLATFORM_OWNER' || roleUpper === 'SUPER_ADMIN') {
      return { allowed: true, reason: "Platform Owner Wildcard Access (*)" };
    }

    // 2. Strict Platform Domain Protection: Any platform.* permission requires PLATFORM_OWNER or explicit override
    if (permissionKey.startsWith('platform.')) {
      // Check if user has explicit override or explicit permission in claims
      if (user.permissions && Array.isArray(user.permissions)) {
        if (user.permissions.includes('*') || user.permissions.includes(permissionKey)) {
          return { allowed: true, reason: "Platform permission present in user claims token" };
        }
      }
      return { allowed: false, reason: "Access Denied: Platform control plane operations are reserved exclusively for Platform Owners" };
    }

    // 3. Tenant Boundary & Membership Verification
    const tenantId = context?.tenantId || user.tenantId || 'default-tenant';
    if (!context?.tenantId && !user.tenantId) {
      return { allowed: false, reason: "TENANT_REQUIRED: Tenant context is required for tenant operations" };
    }
    if (context?.tenantId && user.tenantId && context.tenantId !== user.tenantId) {
      return { allowed: false, reason: "Cross-tenant access forbidden" };
    }
    if (!user.tenantId && roleUpper !== 'PLATFORM_OWNER' && roleUpper !== 'SUPER_ADMIN') {
      return { allowed: false, reason: "User has no verified tenant membership" };
    }

    // 4. Branch Level Security Check
    if (context?.branchId && !PolicyEngine.canAccessBranch(user, context.branchId)) {
      return { allowed: false, reason: `Branch access violation for branch ${context.branchId}` };
    }

    // 5. Check user-level overrides first
    const overrides = await RoleService.getUserPermissionOverrides(tenantId, user.userId);
    const specificOverride = overrides.find(o => o.permissionKey === permissionKey);
    if (specificOverride) {
      if (specificOverride.effect === 'DENY') {
        return { allowed: false, reason: `Explicit DENY override for ${permissionKey}` };
      }
      if (specificOverride.effect === 'ALLOW') {
        return { allowed: true, reason: `Explicit User Override (ALLOW) for ${permissionKey}` };
      }
    }

    // 6. Explicit user permissions array if already attached
    if (user.permissions && Array.isArray(user.permissions)) {
      if (user.permissions.includes('*') || user.permissions.includes(permissionKey)) {
        return { allowed: true, reason: "Permission present in user claims token" };
      }
    }

    // 7. Compute effective permissions from roles
    const effective = await this.getUserEffectivePermissions(tenantId, user.userId, user.role);
    if (effective.has('*') || effective.has(permissionKey)) {
      return { allowed: true, reason: `Permission granted via role matrix for ${permissionKey}` };
    }

    return { allowed: false, reason: `Insufficient permissions: missing ${permissionKey}` };
  }

  /**
   * Main authorization check returning boolean.
   */
  static async can(
    user: UserIdentityContext | undefined | null,
    permissionKey: string,
    context?: AuthorizationEvaluationContext
  ): Promise<boolean> {
    const decision = await this.evaluate(user, permissionKey, context);
    return decision.allowed;
  }

  /**
   * Evaluates if user has ANY of the specified permissions.
   */
  static async canAny(
    user: UserIdentityContext | undefined | null,
    permissionKeys: string[],
    context?: AuthorizationEvaluationContext
  ): Promise<boolean> {
    if (!user) return false;
    for (const key of permissionKeys) {
      if (await this.can(user, key, context)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Evaluates if user has ALL of the specified permissions.
   */
  static async canAll(
    user: UserIdentityContext | undefined | null,
    permissionKeys: string[],
    context?: AuthorizationEvaluationContext
  ): Promise<boolean> {
    if (!user) return false;
    for (const key of permissionKeys) {
      if (!(await this.can(user, key, context))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Check user role membership.
   */
  static hasRole(user: UserIdentityContext | undefined | null, roleName: string): boolean {
    if (!user) return false;
    const target = roleName.toUpperCase();
    if ((user.role || '').toUpperCase() === target) return true;
    if (user.roles && user.roles.some(r => r.toUpperCase() === target)) return true;
    return false;
  }

  /**
   * Branch access helper.
   */
  static canAccessBranch(user: UserIdentityContext, branchId?: string | null): boolean {
    return PolicyEngine.canAccessBranch(user, branchId);
  }

  /**
   * Administrative management helper.
   */
  static canManageUser(actor: UserIdentityContext, targetRole?: string | null): boolean {
    return PolicyEngine.canManageUser(actor, targetRole);
  }
}
