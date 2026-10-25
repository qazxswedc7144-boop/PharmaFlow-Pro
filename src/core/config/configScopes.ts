// src/core/config/configScopes.ts
import { ConfigScope, ConfigurationContext } from './types';
import { TokenProvider } from '@/services/auth/tokenProvider';

/**
 * Precedence Order (Highest to Lowest):
 * RUNTIME > DEVICE > USER > BRANCH > TENANT > SYSTEM
 */
export const SCOPE_PRECEDENCE: ConfigScope[] = [
  'RUNTIME',
  'DEVICE',
  'USER',
  'BRANCH',
  'TENANT',
  'SYSTEM'
];

/**
 * Returns higher priority score for a scope (higher number = higher priority).
 */
export function getScopePriority(scope: ConfigScope): number {
  const index = SCOPE_PRECEDENCE.indexOf(scope);
  if (index === -1) return 0;
  return SCOPE_PRECEDENCE.length - index;
}

/**
 * Returns true if scopeA has higher priority than scopeB.
 */
export function isHigherScope(scopeA: ConfigScope, scopeB: ConfigScope): boolean {
  return getScopePriority(scopeA) > getScopePriority(scopeB);
}

/**
 * Resolves current execution context from TokenProvider / session.
 */
export function getCurrentContext(overrideContext?: ConfigurationContext): ConfigurationContext {
  const session = TokenProvider.getCurrentSession();
  const user = session.user;

  let deviceId = session.deviceId || 'default-device';

  const defaultContext: ConfigurationContext = {
    tenantId: session.tenantId || user?.tenant_id || user?.tenantId,
    branchId: user?.branch_id || user?.branchId || undefined,
    userId: user?.id || user?.user_id,
    deviceId
  };

  return {
    tenantId: overrideContext?.tenantId || defaultContext.tenantId,
    branchId: overrideContext?.branchId || defaultContext.branchId,
    userId: overrideContext?.userId || defaultContext.userId,
    deviceId: overrideContext?.deviceId || defaultContext.deviceId
  };
}

/**
 * Builds a deterministic storage key prefix for scoped config records in Dexie.
 * Format: scope:tenantId:branchId:userId:deviceId:canonicalKey
 */
export function buildScopedStorageKey(
  key: string,
  scope: ConfigScope,
  context: ConfigurationContext
): string {
  const t = context.tenantId || 'global';
  const b = context.branchId || 'global';
  const u = context.userId || 'global';
  const d = context.deviceId || 'global';

  switch (scope) {
    case 'SYSTEM':
      return `sys:${key}`;
    case 'TENANT':
      return `tenant:${t}:${key}`;
    case 'BRANCH':
      return `branch:${t}:${b}:${key}`;
    case 'USER':
      return `user:${t}:${u}:${key}`;
    case 'DEVICE':
      return `device:${t}:${b}:${u}:${d}:${key}`;
    case 'RUNTIME':
      return `runtime:${key}`;
    default:
      return key;
  }
}
