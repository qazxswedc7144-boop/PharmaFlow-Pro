// src/services/auth/tokenProvider.ts
import { useAuthStore } from '@/store/authStore';
import { User, AuthSession, AuthHeaders, TenantAuthContext } from '@/types/auth.types';

export class TokenProvider {
  private static refreshPromise: Promise<string> | null = null;

  /**
   * Retrieves active access token from the canonical authStore (with storage fallback)
   */
  public static getAccessToken(): string | null {
    const storeToken = useAuthStore.getState().token;
    if (storeToken) return storeToken;
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('pharmaflow_token');
    }
    return null;
  }

  /**
   * Retrieves active refresh token
   */
  public static getRefreshToken(): string | null {
    const storeRefresh = useAuthStore.getState().refreshToken;
    if (storeRefresh) return storeRefresh;
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('pharmaflow_refresh_token');
    }
    return null;
  }

  /**
   * Checks whether auth is explicitly enabled or in local bypass mode
   */
  public static isAuthEnabled(): boolean {
    if (typeof localStorage === 'undefined') return true;
    const stored = localStorage.getItem('pharmaflow_auth_enabled');
    return stored === 'true';
  }

  /**
   * Returns current consolidated authentication session
   */
  public static getCurrentSession(): AuthSession {
    const state = useAuthStore.getState();
    return {
      user: state.user,
      token: state.token || this.getAccessToken(),
      refreshToken: state.refreshToken || this.getRefreshToken(),
      tenantId: state.tenantId,
      branchId: state.branchId,
      roles: state.roles,
      permissions: state.permissions,
      subscriptionPlan: state.subscriptionPlan,
      isAuthenticated: state.isAuthenticated,
      isOfflineSession: typeof navigator !== 'undefined' ? !navigator.onLine : false
    };
  }

  /**
   * Generates authorization headers for network transports
   */
  public static getAuthHeaders(): AuthHeaders {
    const session = this.getCurrentSession();
    const headers: AuthHeaders = {};

    if (session.token) {
      headers.Authorization = `Bearer ${session.token}`;
    }
    if (session.tenantId) {
      headers['x-tenant-id'] = session.tenantId;
    }
    if (session.branchId) {
      headers['x-branch-id'] = session.branchId;
    }

    return headers;
  }

  /**
   * Evaluates authentication state
   */
  public static isAuthenticated(): boolean {
    const session = this.getCurrentSession();
    return session.isAuthenticated && !!session.token;
  }

  /**
   * Synchronizes legacy storage keys for backward compatibility
   */
  public static syncLegacyStorageKeys(user: User | null, token: string | null, refreshToken?: string | null): void {
    if (typeof localStorage === 'undefined') return;

    try {
      if (token) {
        localStorage.setItem('pharmaflow_token', token);
      } else {
        localStorage.removeItem('pharmaflow_token');
      }

      if (refreshToken) {
        localStorage.setItem('pharmaflow_refresh_token', refreshToken);
      } else if (refreshToken === null) {
        localStorage.removeItem('pharmaflow_refresh_token');
      }

      if (user) {
        localStorage.setItem('pharmaflow_user', JSON.stringify(user));
        // Sync pf_enterprise_auth for packages/shared/auth-client compatibility
        localStorage.setItem('pf_enterprise_auth', JSON.stringify({
          accessToken: token,
          refreshToken: refreshToken || null,
          user: {
            id: user.id || (user as any).user_id || '',
            username: user.username || (user as any).User_Name || '',
            role: user.role || (user as any).Role || 'CASHIER'
          }
        }));
      } else {
        localStorage.removeItem('pharmaflow_user');
        localStorage.removeItem('pf_enterprise_auth');
      }
    } catch (e) {
      console.warn('[TokenProvider] Failed syncing legacy storage keys:', e);
    }
  }

  /**
   * Atomically updates session in authStore & legacy storage
   */
  public static setSession(
    user: User | null, 
    accessToken: string | null, 
    refreshTokenOrContext?: string | TenantAuthContext | null, 
    context?: TenantAuthContext
  ): void {
    let refreshToken: string | null = null;
    let tenantContext: TenantAuthContext | undefined = context;

    if (typeof refreshTokenOrContext === 'string') {
      refreshToken = refreshTokenOrContext;
    } else if (refreshTokenOrContext && typeof refreshTokenOrContext === 'object') {
      tenantContext = refreshTokenOrContext;
    }

    if (user && accessToken) {
      useAuthStore.getState().login(user, accessToken, tenantContext, refreshToken);
      this.syncLegacyStorageKeys(user, accessToken, refreshToken);
    } else {
      this.clearSession();
    }
  }

  /**
   * Single-Flight Token Refresh
   * Coalesces concurrent 401s into a single refresh HTTP request
   */
  public static async refreshAccessToken(): Promise<string> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      const currentRefresh = this.getRefreshToken();
      if (!currentRefresh) {
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        if (isOffline) {
          return this.getAccessToken() || '';
        }
        await this.logout({ revokeOnServer: false });
        throw new Error('NO_REFRESH_TOKEN');
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: currentRefresh }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        const data = (await response.json().catch(() => ({}))) || {};
        const newAccess = data.accessToken || data.token;
        const newRefresh = data.refreshToken || currentRefresh;
        const newUser = data.user || useAuthStore.getState().user;

        if (!response.ok || !newAccess) {
          throw new Error('INVALID_REFRESH_PAYLOAD');
        }

        this.setSession(newUser, newAccess, newRefresh);
        return newAccess;
      } catch (err: any) {
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        const isNetworkErr = err.name === 'AbortError' ||
          err.message?.includes('Network Error') || 
          err.message?.includes('Failed to fetch');

        if (isOffline || isNetworkErr) {
          console.warn('📶 [TokenProvider] Network unavailable during refresh. Preserving offline session.');
          return this.getAccessToken() || '';
        }

        import('@/core/observability/observabilityService').then(({ observabilityService }) => {
          observabilityService.recordError(err, { feature: 'AUTH' }, 'AUTH', 'WARNING').catch(() => {});
        });

        console.error('🔒 [TokenProvider] Refresh token rejected by server:', err.message || err);
        await this.logout({ revokeOnServer: false });
        throw new Error('AUTH_EXPIRED');
      } finally {
        this.refreshPromise = null;
      }
    })();

    return this.refreshPromise;
  }

  /**
   * Central Logout
   * Terminates active server session if online, clears authStore & token storage.
   * DOES NOT clear or delete local Dexie business data (Invoices, Customers, Stock).
   */
  public static async logout(options?: { revokeOnServer?: boolean }): Promise<void> {
    const revokeOnServer = options?.revokeOnServer !== false;
    const currentRefresh = this.getRefreshToken();

    if (revokeOnServer && currentRefresh && typeof navigator !== 'undefined' && navigator.onLine) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.getAuthHeaders()
          },
          body: JSON.stringify({ refreshToken: currentRefresh }),
          signal: controller.signal
        }).catch(() => {});
        clearTimeout(timeoutId);
      } catch {
        // Safe ignore
      }
    }

    this.clearSession();
  }

  /**
   * Clears in-memory and persisted tokens and session state
   */
  public static clearSession(): void {
    useAuthStore.getState().logout();
    this.syncLegacyStorageKeys(null, null, null);
  }
}
