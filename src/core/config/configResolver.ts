// src/core/config/configResolver.ts
import { ConfigScope, ConfigurationContext, ConfigurationRecord } from './types';
import { CONFIG_REGISTRY, normalizeConfigKey } from './configKeys';
import { getDefaultValue } from './configDefaults';

/**
 * Precedence Order (Highest priority first):
 * RUNTIME > DEVICE > USER > BRANCH > TENANT > SYSTEM DEFAULTS
 */
const RESOLUTION_PRECEDENCE: ConfigScope[] = [
  'RUNTIME',
  'DEVICE',
  'USER',
  'BRANCH',
  'TENANT',
  'SYSTEM'
];

/**
 * Resolves the active value for a setting from a list of available records,
 * respecting scope precedence and context matching.
 */
export function resolveConfigValue<T = unknown>(
  key: string,
  records: ConfigurationRecord<any>[],
  context: ConfigurationContext
): T {
  const canonicalKey = normalizeConfigKey(key);
  const keyRecords = records.filter(r => normalizeConfigKey(r.key) === canonicalKey);

  // Evaluate precedence from highest to lowest
  for (const scope of RESOLUTION_PRECEDENCE) {
    const candidate = keyRecords.find(r => {
      if (r.scope !== scope) return false;

      // Context matching per scope
      switch (scope) {
        case 'RUNTIME':
          return true;
        case 'DEVICE':
          return Boolean(
            r.context?.tenantId &&
            context.tenantId &&
            r.context.tenantId === context.tenantId &&
            r.context.deviceId &&
            context.deviceId &&
            r.context.deviceId === context.deviceId &&
            (!r.context.branchId || r.context.branchId === context.branchId) &&
            (!r.context.userId || r.context.userId === context.userId)
          );
        case 'USER':
          return Boolean(
            r.context?.tenantId &&
            context.tenantId &&
            r.context.tenantId === context.tenantId &&
            r.context.userId &&
            context.userId &&
            r.context.userId === context.userId
          );
        case 'BRANCH':
          return Boolean(
            r.context?.tenantId &&
            context.tenantId &&
            r.context.tenantId === context.tenantId &&
            r.context.branchId &&
            context.branchId &&
            r.context.branchId === context.branchId
          );
        case 'TENANT':
          return Boolean(
            r.context?.tenantId &&
            context.tenantId &&
            r.context.tenantId === context.tenantId
          );
        case 'SYSTEM':
          return true;
        default:
          return false;
      }
    });

    if (candidate && candidate.value !== undefined && candidate.value !== null) {
      return candidate.value as T;
    }
  }

  // Fallback to default value from registry
  const def = CONFIG_REGISTRY[canonicalKey];
  if (def !== undefined && def.defaultValue !== undefined) {
    return def.defaultValue as T;
  }

  return getDefaultValue<T>(canonicalKey) as T;
}
