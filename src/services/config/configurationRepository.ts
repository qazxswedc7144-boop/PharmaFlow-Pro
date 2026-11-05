// src/services/config/configurationRepository.ts
import { db } from '@/core/db';
import { ConfigurationRecord, ConfigurationContext, ConfigScope } from '@/core/config/types';
import { assertScopedContext, buildScopedStorageKey } from '@/core/config/configScopes';
import { normalizeConfigKey } from '@/core/config/configKeys';

export class ConfigurationRepository {
  /**
   * Retrieves all configuration records stored in Dexie.
   */
  async getAllRecords(): Promise<ConfigurationRecord<any>[]> {
    try {
      const rawRecords = await db.settings.toArray();
      const result: ConfigurationRecord<any>[] = [];

      for (const item of rawRecords) {
        if (!item || !item.key) continue;
        if (item.key.startsWith('__')) continue; // Skip internal system flags

        if (item.value && typeof item.value === 'object' && 'scope' in item.value && 'context' in item.value) {
          const record = item.value as ConfigurationRecord<any>;
          try {
            // Only records stored under their exact scope-derived key are active.
            // Historical canonical-key copies remain preserved but quarantined.
            const expectedStorageKey = buildScopedStorageKey(
              normalizeConfigKey(record.key),
              record.scope,
              record.context || {}
            );
            if (item.key === expectedStorageKey) {
              result.push(record);
            }
          } catch {
            // Invalid or incomplete legacy context: preserve, but never resolve.
          }
        }
        // Unscoped legacy values are intentionally left untouched and excluded from
        // resolution until an explicit, ownership-verified migration is available.
      }

      return result;
    } catch (error) {
      console.warn('[ConfigurationRepository] Failed to read records from Dexie:', error);
      return [];
    }
  }

  /**
   * Retrieves a specific configuration record by key, scope, and context.
   */
  async getRecord(
    key: string,
    scope: ConfigScope,
    context: ConfigurationContext
  ): Promise<ConfigurationRecord<any> | null> {
    const canonicalKey = normalizeConfigKey(key);
    assertScopedContext(scope, context);
    const storageKey = buildScopedStorageKey(canonicalKey, scope, context);

    try {
      const item = await db.settings.get(storageKey);
      if (!item || item.value === undefined || item.value === null) return null;

      if (item.value && typeof item.value === 'object' && 'scope' in item.value) {
        const record = item.value as ConfigurationRecord<any>;
        if (normalizeConfigKey(record.key) !== canonicalKey || record.scope !== scope) return null;
        if (scope !== 'SYSTEM' && scope !== 'RUNTIME') {
          const expectedFields: Array<keyof ConfigurationContext> =
            scope === 'TENANT' ? ['tenantId'] :
            scope === 'BRANCH' ? ['tenantId', 'branchId'] :
            scope === 'USER' ? ['tenantId', 'userId'] :
            ['tenantId', 'deviceId'];
          if (expectedFields.some(field => record.context?.[field] !== context[field])) return null;
        }
        return record;
      }

      return {
        key: canonicalKey,
        value: item.value,
        scope,
        context,
        version: 1,
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.warn(`[ConfigurationRepository] Error getting record for ${key}:`, error);
      return null;
    }
  }

  /**
   * Saves a configuration record atomically to Dexie.
   */
  async saveRecord(record: ConfigurationRecord<any>): Promise<void> {
    const canonicalKey = normalizeConfigKey(record.key);
    assertScopedContext(record.scope, record.context);
    const storageKey = buildScopedStorageKey(canonicalKey, record.scope, record.context);

    const recordToSave: ConfigurationRecord<any> = {
      ...record,
      key: canonicalKey,
      version: (record.version || 0) + 1,
      updatedAt: new Date().toISOString()
    };

    await db.transaction('rw', 'settings', async () => {
      // 1. Save scoped record
      await db.settings.put({
        key: storageKey,
        value: recordToSave
      });

    });
  }

  /**
   * Deletes a configuration record by key, scope, and context.
   */
  async deleteRecord(
    key: string,
    scope: ConfigScope,
    context: ConfigurationContext
  ): Promise<void> {
    const canonicalKey = normalizeConfigKey(key);
    assertScopedContext(scope, context);
    const storageKey = buildScopedStorageKey(canonicalKey, scope, context);

    await db.transaction('rw', 'settings', async () => {
      await db.settings.delete(storageKey);
    });
  }
}

export const configurationRepository = new ConfigurationRepository();
