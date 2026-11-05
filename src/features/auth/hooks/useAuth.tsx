import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { unifiedTransport } from '@/shared/network/transport/unifiedTransport';
import { configurationService } from '@/services/config/configurationService';
import { useAuthStore } from '@/store/authStore';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { User } from '@/types/auth.types';
import { db } from '@/core/db';
import { hashLocalPassword, verifyLocalPassword } from '@features/auth/services/localPasswordService';

interface AuthContextType {
  user: User | null;
  profile: {
    id: string;
    name: string;
    role: string;
    email: string;
    tenantId: string | null;
  } | null;
  accessToken: string | null;
  refreshTokenState: string | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<{ user: User; accessToken: string }>;
  logout: () => Promise<void>;
  refreshToken: () => Promise<string>;
  signInWithEmail: () => Promise<{ data: { user: null }; error: null }>;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
  authenticationEnabled: boolean;
  setAuthenticationEnabled: (enabled: boolean) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const BYPASS_USER: User = {
  id: "local-admin",
  user_id: "local-admin",
  Role: "Admin",
  User_Name: "Administrator",
  User_Email: "admin@admin.com",
  tenant_id: "local-tenant-01",
  Is_Active: true
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [authenticationEnabled, setAuthenticationEnabledState] = useState<boolean>(() => {
    return TokenProvider.isAuthEnabled();
  });

  const [user, setUser] = useState<User | null>(() => {
    if (!TokenProvider.isAuthEnabled()) {
      return BYPASS_USER;
    }
    return useAuthStore.getState().user || TokenProvider.getCurrentSession().user;
  });

  const [accessToken, setAccessToken] = useState<string | null>(() => {
    if (!TokenProvider.isAuthEnabled()) {
      return 'local-admin-token';
    }
    return TokenProvider.getAccessToken();
  });

  const [refreshTokenState, setRefreshTokenState] = useState<string | null>(() => {
    if (!TokenProvider.isAuthEnabled()) {
      return 'local-admin-refresh-token';
    }
    return TokenProvider.getRefreshToken();
  });

  const [loading, setLoading] = useState(false);

  // Sync state when authStore changes
  useEffect(() => {
    const unsubscribe = useAuthStore.subscribe((state) => {
      if (TokenProvider.isAuthEnabled()) {
        setUser(state.user);
        setAccessToken(state.token);
        setRefreshTokenState(state.refreshToken);
      }
    });
    return () => unsubscribe();
  }, []);

  // Load and sync authenticationEnabled status from configurationService on mount
  useEffect(() => {
    const syncConfig = async () => {
      try {
        const isEnabled = await configurationService.get<boolean>('system.authenticationEnabled');
        if (isEnabled !== undefined && isEnabled !== null) {
          setAuthenticationEnabledState(isEnabled);
          configurationService.set('pharmaflow_auth_enabled', isEnabled ? 'true' : 'false').catch(() => {});
          
          if (!isEnabled) {
            setUser(BYPASS_USER);
            setAccessToken('local-admin-token');
            setRefreshTokenState('local-admin-refresh-token');
            TokenProvider.setSession(BYPASS_USER, 'local-admin-token', 'local-admin-refresh-token');
          }
        }
      } catch (e) {
        console.error("Failed to load authenticationEnabled from configurationService:", e);
      }
    };
    syncConfig();
  }, []);

  const logout = useCallback(async () => {
    if (!TokenProvider.isAuthEnabled()) {
      return;
    }
    setLoading(true);
    try {
      await TokenProvider.logout();
    } finally {
      setAccessToken(null);
      setRefreshTokenState(null);
      setUser(null);
      setLoading(false);
    }
  }, []);

  const refreshToken = useCallback(async (): Promise<string> => {
    try {
      const newAccess = await TokenProvider.refreshAccessToken();
      const session = TokenProvider.getCurrentSession();
      setAccessToken(newAccess);
      setRefreshTokenState(session.refreshToken);
      setUser(session.user);
      return newAccess;
    } catch (err) {
      await logout();
      throw err;
    }
  }, [logout]);

  const login = useCallback(async (username: string, password: string) => {
    setLoading(true);
    try {
      const response: any = await unifiedTransport.post('/api/auth/login', { username, password });
      const data = response?.data || response || {};
      const access = data.accessToken || data.token || 'auth-token';
      const refresh = data.refreshToken || null;
      const rawUser = data.user || { id: username, username, role: 'CASHIER' };
      const u = rawUser as any;
      const activeStatus = u.Is_Active ?? u.isActive ?? u.active ?? true;
      const authenticatedUser = {
        ...rawUser,
        Is_Active: activeStatus,
        isActive: activeStatus,
      };

      TokenProvider.setSession(authenticatedUser, access, refresh);

      configurationService.set('pharmaflow_auth_enabled', 'true').catch(() => {});
      setAuthenticationEnabledState(true);

      setAccessToken(access);
      setRefreshTokenState(refresh);
      setUser(authenticatedUser);

      return { user: authenticatedUser, accessToken: access };
    } catch (err: any) {
      const networkMessage = String(err?.message || '');
      const isNetworkFailure = !err?.response && !err?.status && (
        (typeof navigator !== 'undefined' && !navigator.onLine) ||
        /network error|failed to fetch|fetch failed|econn|etimedout|timeout/i.test(networkMessage)
      );

      if (isNetworkFailure) {
        try {
          // Local PBKDF2 credentials are an offline-only fallback. They are never
          // sent to the API and cannot be used as an online bearer credential.
          const currentTenantId = TokenProvider.getCurrentSession().tenantId || useAuthStore.getState().tenantId;
          if (!currentTenantId) {
            throw new Error('OFFLINE_LOGIN_REQUIRES_TENANT: لا توجد مؤسسة محفوظة وآمنة لتسجيل الدخول دون اتصال.');
          }
          const candidates = await db.users
            .where('tenantId').equals(currentTenantId)
            .filter((candidate: any) =>
              candidate?.username === username.trim() &&
              candidate.status !== 'inactive' && candidate.isActive !== false
            )
            .toArray();

          // The lookup is scoped to the previously selected tenant; duplicate
          // usernames within that tenant still fail closed.
          if (candidates.length === 1) {
            const localUser = candidates[0] as any;
            const verified = await verifyLocalPassword(password, localUser.passwordHash, localUser.password);
            if (verified.valid) {
              const {
                password: _legacyPassword,
                passwordHash: _passwordHash,
                ...safeUser
              } = localUser;
              const offlineUser = {
                ...safeUser,
                id: String(localUser.id),
                user_id: String(localUser.id),
                username: localUser.username,
                role: localUser.role || 'CASHIER',
                Role: localUser.role || 'CASHIER',
                tenantId: localUser.tenantId,
                tenant_id: localUser.tenantId,
                branchId: localUser.branchId || localUser.branch || null,
                offlineOnly: true
              } as User;
              const randomBytes = crypto.getRandomValues(new Uint8Array(18));
              const offlineToken = `offline-local-${Array.from(randomBytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
              TokenProvider.setSession(offlineUser, offlineToken, null, {
                tenantId: String(localUser.tenantId),
                branchId: localUser.branchId || localUser.branch || null
              });
              if (verified.needsUpgrade) {
                try {
                  const upgradedHash = await hashLocalPassword(password);
                  await db.users.update(localUser.id, { passwordHash: upgradedHash, password: undefined });
                } catch (upgradeError) {
                  TokenProvider.clearSession();
                  throw upgradeError;
                }
              }
              setAccessToken(offlineToken);
              setRefreshTokenState(null);
              setUser(offlineUser);
              setAuthenticationEnabledState(true);
              configurationService.set('pharmaflow_auth_enabled', 'true').catch(() => {});
              return { user: offlineUser, accessToken: offlineToken };
            }
          }
        } catch (offlineError) {
          console.warn('[Auth] Offline credential verification failed:', offlineError);
        }
      }

      const msg = err.response?.data?.message || err.message || 'Login failed';
      throw new Error(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  const signInWithEmail = useCallback(async () => {
    return { data: { user: null }, error: null };
  }, []);

  const refreshProfile = useCallback(async () => {}, []);

  const setAuthenticationEnabled = useCallback(async (enabled: boolean) => {
    configurationService.set('pharmaflow_auth_enabled', enabled ? 'true' : 'false').catch(() => {});
    setAuthenticationEnabledState(enabled);
    
    try {
      await configurationService.set('system.authenticationEnabled', enabled);
    } catch (e) {
      console.error("Failed to persist authenticationEnabled in configurationService:", e);
    }

    if (!enabled) {
      setUser(BYPASS_USER);
      setAccessToken('local-admin-token');
      setRefreshTokenState('local-admin-refresh-token');
      TokenProvider.setSession(BYPASS_USER, 'local-admin-token', 'local-admin-refresh-token');
    } else {
      setUser(null);
      setAccessToken(null);
      setRefreshTokenState(null);
      TokenProvider.clearSession();
    }
  }, []);

  // Derived profile structure for backward compatibility
  const profile = user ? {
    id: user.id || (user as any).user_id || '',
    name: user.User_Name || user.fullName || user.username || (user as any).name || '',
    role: user.Role || user.role || (user as any).Role_Type || 'USER',
    email: user.User_Email || user.email || '',
    tenantId: user.tenant_id || user.tenantId || null
  } : null;

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        accessToken,
        refreshTokenState,
        loading,
        login,
        logout,
        refreshToken,
        signInWithEmail,
        refreshProfile,
        signOut: logout,
        authenticationEnabled,
        setAuthenticationEnabled
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}


