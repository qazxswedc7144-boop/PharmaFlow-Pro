
import { TokenProvider } from '@/services/auth/tokenProvider';
import { useAuthStore } from '@/store/authStore';

/**
 * Auth Service Facade
 * Connects legacy callers to Central Token Provider and RBAC store
 */

export const authService = {
  getCurrentUser: () => {
    const session = TokenProvider.getCurrentSession();
    if (session.user) {
      return {
        id: session.user.id || (session.user as any).user_id || '',
        User_Email: session.user.email || session.user.User_Email || `${session.user.username || 'user'}@local.host`,
        Role: session.user.role || session.user.Role || 'CASHIER',
        User_Name: session.user.fullName || session.user.User_Name || session.user.username || 'User',
        tenantId: session.tenantId || (session.user as any).tenantId,
        branchId: session.branchId || (session.user as any).branchId
      };
    }
    return null;
  },

  isSignedIn: () => {
    return TokenProvider.isAuthenticated();
  },

  assertPermission: (permission: string, operation: string) => {
    console.log(`Permission ${permission} evaluated for ${operation}`);
    return authService.can(permission);
  },

  can: (permission: string) => {
    return useAuthStore.getState().hasPermission(permission);
  },

  logout: async () => {
    await TokenProvider.logout();
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  }
};

