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

  const defaultContext: ConfigurationContext = {
    tenantId: session.tenantId || user?.tenant_id || user?.tenantId || undefined,
    branchId: session.branchId || user?.branch_id || user?.branchId || undefined,
    userId: user?.id || user?.user_id || undefined,
    deviceId: session.deviceId || 'default-device'
  };

  if (overrideContext) {
    const fields: Array<keyof ConfigurationContext> = [
      'tenantId',
      'branchId',
      'userId',
      'deviceId'
    ];

    for (const field of fields) {
      const requestedValue = overrideContext[field];
      if (requestedValue !== undefined && requestedValue !== defaultContext[field]) {
        throw new Error(
          `[ConfigurationContext] Untrusted ${field} override does not match the authenticated session.`
        );
      }
    }
  }

  return defaultContext;
}

/**
 * Ensures that a persisted scope has the identifiers required to isolate it.
 * Legacy records without these identifiers remain stored but are not addressable.
 */
export function assertScopedContext(scope: ConfigScope, context: ConfigurationContext): void {
  const requiredFields: Array<keyof ConfigurationContext> = [];

  switch (scope) {
    case 'TENANT':
      requiredFields.push('tenantId');
      break;
    case 'BRANCH':
      requiredFields.push('tenantId', 'branchId');
      break;
    case 'USER':
      requiredFields.push('tenantId', 'userId');
      break;
    case 'DEVICE':
      requiredFields.push('tenantId', 'deviceId');
      break;
    case 'SYSTEM':
    case 'RUNTIME':
      return;
    default:
      throw new Error(`[ConfigurationContext] Unsupported configuration scope: ${scope}`);
  }

  for (const field of requiredFields) {
    if (typeof context[field] !== 'string' || !context[field]!.trim()) {
      throw new Error(
        `[ConfigurationContext] Missing required ${field} for ${scope} configuration.`
      );
    }
  }
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
  assertScopedContext(scope, context);
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
