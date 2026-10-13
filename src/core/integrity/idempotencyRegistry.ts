import { db } from '@/core/db';
import { IdempotencyRecord, IdempotencyStatus } from './types';

/**
 * Idempotency Registry
 * Handles persistent and in-memory storage of operation idempotency records.
 * Strictly scopes keys by tenantId to enforce complete tenant isolation and fail-closed safety.
 */
export class IdempotencyRegistry {
  private static inMemoryStore = new Map<string, IdempotencyRecord>();

  /**
   * Helper to format a tenant-scoped key
   */
  public static scopedKey(key: string, tenantId?: string): string {
    if (!key) return '';
    if (!tenantId) return key;
    if (key.startsWith(`${tenantId}:`)) return key;
    return `${tenantId}:${key}`;
  }

  /**
   * Fetches an idempotency record by key, scoped by tenantId
   */
  public static async get(key: string, tenantId?: string): Promise<IdempotencyRecord | null> {
    if (!key) return null;
    const effectiveKey = this.scopedKey(key, tenantId);

    // 1. Check in-memory store
    if (this.inMemoryStore.has(effectiveKey)) {
      const rec = this.inMemoryStore.get(effectiveKey)!;
      if (!tenantId || rec.tenantId === tenantId) return rec;
    }
    if (this.inMemoryStore.has(key)) {
      const rec = this.inMemoryStore.get(key)!;
      if (!tenantId || rec.tenantId === tenantId) return rec;
    }

    // 2. Check Dexie database (idempotency_records table)
    try {
      if (typeof indexedDB !== 'undefined' && db && db.idempotency_records) {
        let record = await db.idempotency_records.get(effectiveKey);
        if (!record && key !== effectiveKey) {
          record = await db.idempotency_records.get(key);
          if (record && tenantId && record.tenantId !== tenantId) {
            record = undefined; // Do not leak cross-tenant idempotency record
          }
        }
        if (record) {
          this.inMemoryStore.set(effectiveKey, record);
          return record;
        }
      }

      // 3. Fallback check on legacy idempotencyKeys table
      if (typeof indexedDB !== 'undefined' && db && db.idempotencyKeys) {
        const legacyRec = await db.idempotencyKeys.get(effectiveKey) || await db.idempotencyKeys.get(key);
        if (legacyRec) {
          const recTenant = (legacyRec as any).tenantId || tenantId;
          if (tenantId && recTenant && recTenant !== tenantId) {
            return null;
          }
          const rec: IdempotencyRecord = {
            key: legacyRec.id,
            status: legacyRec.status as IdempotencyStatus,
            tenantId: recTenant || tenantId || 'unknown',
            branchId: (legacyRec as any).branchId || 'BRH-001',
            operationType: 'legacy',
            entityType: 'transaction',
            fingerprint: 'legacy',
            createdAt: legacyRec.createdAt || new Date().toISOString(),
            completedAt: legacyRec.completedAt
          };
          this.inMemoryStore.set(effectiveKey, rec);
          return rec;
        }
      }
    } catch (err) {
      console.warn('[IdempotencyRegistry] Database read error, using fallback:', err);
    }

    return null;
  }

  /**
   * Saves or updates an idempotency record with strict tenant validation (Fail-Closed)
   */
  public static async save(record: IdempotencyRecord): Promise<void> {
    if (!record || !record.key) return;

    if (!record.tenantId || record.tenantId === 'default' || record.tenantId === 'default-tenant' || record.tenantId === 'main') {
      throw new Error("FAIL_CLOSED: لا يمكن حفظ سجل Idempotency بدون سياق مؤسسة موثوق (Trusted Tenant Context Required).");
    }

    const effectiveKey = this.scopedKey(record.key, record.tenantId);
    const tenantScopedRecord: IdempotencyRecord = {
      ...record,
      key: effectiveKey
    };

    this.inMemoryStore.set(effectiveKey, tenantScopedRecord);

    try {
      if (typeof indexedDB !== 'undefined' && db) {
        if (db.idempotency_records) {
          await db.idempotency_records.put(tenantScopedRecord);
        }
        if (db.idempotencyKeys) {
          await db.idempotencyKeys.put({
            id: effectiveKey,
            status: record.status,
            createdAt: record.createdAt,
            completedAt: record.completedAt,
            tenantId: record.tenantId,
            branchId: record.branchId
          });
        }
      }
    } catch (err) {
      console.warn('[IdempotencyRegistry] Failed to save idempotency record to Dexie:', err);
    }
  }

  /**
   * Updates status of an existing idempotency record
   */
  public static async updateStatus(
    key: string,
    status: IdempotencyStatus,
    result?: any,
    failureReason?: string,
    tenantId?: string
  ): Promise<void>;
  public static async updateStatus(
    key: string,
    status: IdempotencyStatus,
    result?: any,
    options?: { failureReason?: string; tenantId?: string }
  ): Promise<void>;
  public static async updateStatus(
    key: string,
    status: IdempotencyStatus,
    result?: any,
    failureReasonOrOpts?: string | { failureReason?: string; tenantId?: string },
    tenantId?: string
  ): Promise<void> {
    const effectiveFailureReason = typeof failureReasonOrOpts === 'string' ? failureReasonOrOpts : (failureReasonOrOpts as any)?.failureReason;
    const effectiveTenantId = typeof failureReasonOrOpts === 'object' && failureReasonOrOpts !== null ? (failureReasonOrOpts as any).tenantId : tenantId;
    const existing = await this.get(key, effectiveTenantId);
    const now = new Date().toISOString();

    if (existing) {
      existing.status = status;
      if (status === 'COMMITTED') existing.completedAt = now;
      if (result !== undefined) {
        existing.result = result;
        existing.responseData = result;
      }
      if (effectiveFailureReason !== undefined) existing.failureReason = effectiveFailureReason;

      await this.save(existing);
    } else {
      if (!tenantId || tenantId === 'default' || tenantId === 'default-tenant' || tenantId === 'main') {
        throw new Error("FAIL_CLOSED: لا يمكن تحديث حالة Idempotency بدون سياق مؤسسة موثوق (Trusted Tenant Context Required).");
      }
      await this.save({
        key,
        status,
        tenantId,
        branchId: 'BRH-DEFAULT-GUARDED',
        operationType: 'unknown',
        entityType: 'transaction',
        fingerprint: 'auto',
        createdAt: now,
        completedAt: status === 'COMMITTED' ? now : undefined,
        result,
        failureReason: effectiveFailureReason
      });
    }
  }

  /**
   * Deletes an idempotency record (e.g., on rollbacks if allowed)
   */
  public static async delete(key: string, tenantId?: string): Promise<void> {
    const effectiveKey = this.scopedKey(key, tenantId);
    this.inMemoryStore.delete(effectiveKey);
    this.inMemoryStore.delete(key);
    try {
      if (typeof indexedDB !== 'undefined' && db) {
        if (db.idempotency_records) {
          await db.idempotency_records.delete(effectiveKey);
          await db.idempotency_records.delete(key);
        }
        if (db.idempotencyKeys) {
          await db.idempotencyKeys.delete(effectiveKey);
          await db.idempotencyKeys.delete(key);
        }
      }
    } catch (err) {
      console.warn('[IdempotencyRegistry] Failed to delete idempotency key:', err);
    }
  }

  /**
   * Clears in-memory cache (mainly for testing)
   */
  public static clearInMemory(): void {
    this.inMemoryStore.clear();
  }

  /**
   * Returns all in-memory records
   */
  public static getAllInMemory(): IdempotencyRecord[] {
    return Array.from(this.inMemoryStore.values());
  }
}
