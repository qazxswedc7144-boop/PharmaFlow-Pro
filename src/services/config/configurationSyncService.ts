// src/services/config/configurationSyncService.ts
import { db, getCurrentUserSession } from '@/core/db';
import { ConfigurationRecord, ConfigSyncPolicy } from '@/core/config/types';
import { CONFIG_REGISTRY, normalizeConfigKey } from '@/core/config/configKeys';

export class ConfigurationSyncService {
  /**
   * Determines sync policy for a given key.
   */
  public getSyncPolicy(key: string): ConfigSyncPolicy {
    const canonicalKey = normalizeConfigKey(key);
    const def = CONFIG_REGISTRY[canonicalKey];
    if (def) return def.syncPolicy;

    // Local, device, runtime, auth, tokens, and diagnostics are strictly LOCAL_ONLY
    if (
      canonicalKey.startsWith('device.') ||
      canonicalKey.startsWith('runtime.') ||
      canonicalKey.startsWith('system.') ||
      canonicalKey.startsWith('gdrive.') ||
      canonicalKey.includes('auth') ||
      canonicalKey.includes('token') ||
      canonicalKey.includes('lock') ||
      canonicalKey.includes('crash') ||
      canonicalKey.includes('error') ||
      canonicalKey.includes('refresh') ||
      canonicalKey.includes('bypass')
    ) {
      return 'LOCAL_ONLY';
    }

    // Defensive default: unconfigured ad-hoc keys must not sync to tenant cloud outbox
    return 'LOCAL_ONLY';
  }

  /**
   * Evaluates and queues configuration changes for synchronization if syncable.
   */
  public async handleConfigMutation(record: ConfigurationRecord<any>): Promise<void> {
    // 1. Device, Runtime, and System scoped configurations never sync to tenant cloud outbox
    if (record.scope === 'DEVICE' || record.scope === 'RUNTIME' || record.scope === 'SYSTEM') {
      return;
    }

    // 2. Check sync policy
    const policy = this.getSyncPolicy(record.key);
    if (policy === 'LOCAL_ONLY' || policy === 'SERVER_AUTHORITATIVE') {
      return;
    }

    // 3. Ensure an active tenant session exists before writing to tenant-scoped outbox
    // 🚨 SECURITY HARDENING: Use active session as the ONLY trusted source of truth
    const session = getCurrentUserSession();
    const activeTenantId = session?.tenantId;

    if (!activeTenantId || !session?.userId) {
      // Cannot queue cloud outbox sync events without an active tenant session
      return;
    }

    // 🚨 SECURITY HARDENING: Reject if record context attempts to spoof another tenant
    if (record.context?.tenantId && record.context.tenantId !== activeTenantId) {
      console.error('[SECURITY] Mismatched tenant context in config mutation rejected:', {
        expected: activeTenantId,
        received: record.context.tenantId,
        key: record.key
      });
      return;
    }

    const trustedTenantId = activeTenantId;

    // 4. SYNCABLE: Create mutation entry in outbox queue
    try {
      const mutationId = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `cfg-mut-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

      const idempotencyKey = typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `cfg-idempotent-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

      await db.outbox.add({
        mutationId,
        idempotencyKey,
        tenantId: trustedTenantId, // Force trusted tenant ID
        userId: session.userId,
        branchId: session.branchId,
        type: 'UPDATE_SETTING',
        payload: {
          key: record.key,
          value: record.value,
          scope: record.scope,
          context: { ...record.context, tenantId: trustedTenantId }, // Force trusted tenant ID in payload
          version: record.version,
          updatedAt: record.updatedAt
        },
        status: 'PENDING',
        createdAt: new Date(),
        retryCount: 0
      });

      // Dispatch sync wakeup
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent('SYNC_WAKEUP'));
      }
    } catch (err) {
      console.warn('[ConfigurationSyncService] Failed to queue config mutation:', err);
    }
  }
}

export const configurationSyncService = new ConfigurationSyncService();
