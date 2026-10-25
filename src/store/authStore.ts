// src/store/authStore.ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '@/types';
import { can, canAny, normalizeRole } from '@/utils/permissions';

export interface TenantAuthContext {
  tenantId?: string | null;
  branchId?: string | null;
  roles?: string[];
  permissions?: string[];
  subscriptionPlan?: string | null;
}

interface AuthState {
  user: User | null;
  token: string | null;
  refreshToken: string | null;
  tenantId: string | null;
  branchId: string | null;
  roles: string[];
  permissions: string[];
  subscriptionPlan: string | null;
  isAuthenticated: boolean;
  setUser: (user: User | null) => void;
  setTenantContext: (context: TenantAuthContext) => void;
  login: (user: User, token: string, context?: TenantAuthContext, refreshToken?: string | null) => void;
  setTokens: (accessToken: string | null, refreshToken?: string | null) => void;
  logout: () => void;
  hasPermission: (permission: string) => boolean;
  hasAnyPermission: (permissions: string[]) => boolean;
  canAccessBranch: (targetBranchId?: string | null) => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      refreshToken: null,
      tenantId: null,
      branchId: null,
      roles: [],
      permissions: [],
      subscriptionPlan: null,
      isAuthenticated: false,
      
      setUser: (user) => set((state) => ({
        user,
        tenantId: user?.tenantId || user?.tenant_id || state.tenantId,
        branchId: user?.branchId || user?.branch_id || state.branchId,
        roles: (user as any)?.roles || (user?.role ? [user.role] : state.roles),
        permissions: user?.permissions || state.permissions,
        subscriptionPlan: user?.subscriptionPlan || state.subscriptionPlan
      })),

      setTenantContext: (ctx) => set((state) => ({
        tenantId: ctx.tenantId !== undefined ? ctx.tenantId : state.tenantId,
        branchId: ctx.branchId !== undefined ? ctx.branchId : state.branchId,
        roles: ctx.roles !== undefined ? ctx.roles : state.roles,
        permissions: ctx.permissions !== undefined ? ctx.permissions : state.permissions,
        subscriptionPlan: ctx.subscriptionPlan !== undefined ? ctx.subscriptionPlan : state.subscriptionPlan
      })),

      login: (user, token, context, refreshToken) => set((state) => ({
        user,
        token,
        refreshToken: refreshToken !== undefined ? refreshToken : state.refreshToken,
        tenantId: context?.tenantId || user?.tenantId || user?.tenant_id || null,
        branchId: context?.branchId || user?.branchId || user?.branch_id || null,
        roles: context?.roles || (user as any)?.roles || (user?.role ? [user.role] : ['CASHIER']),
        permissions: context?.permissions || user?.permissions || [],
        subscriptionPlan: context?.subscriptionPlan || user?.subscriptionPlan || 'ENTERPRISE',
        isAuthenticated: true
      })),

      setTokens: (accessToken, refreshToken) => set((state) => ({
        token: accessToken,
        refreshToken: refreshToken !== undefined ? refreshToken : state.refreshToken,
        isAuthenticated: !!accessToken
      })),

      logout: () => set({
        user: null,
        token: null,
        refreshToken: null,
        tenantId: null,
        branchId: null,
        roles: [],
        permissions: [],
        subscriptionPlan: null,
        isAuthenticated: false
      }),

      hasPermission: (perm: string) => {
        const state = get();
        const role = state.user?.role;
        return can(role, perm, state.permissions);
      },

      hasAnyPermission: (perms: string[]) => {
        const state = get();
        const role = state.user?.role;
        return canAny(role, perms, state.permissions);
      },

      canAccessBranch: (targetBranchId?: string | null) => {
        const state = get();
        if (!targetBranchId) return true;
        const role = normalizeRole(state.user?.role);
        if (['admin', 'owner', 'platform_owner', 'tenant_admin'].includes(role)) {
          return true;
        }
        if (!state.branchId) return true;
        return state.branchId === targetBranchId;
      }
    }),
    { name: 'pharma-auth-storage' }
  )
);

