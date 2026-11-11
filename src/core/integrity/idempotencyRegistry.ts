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
      // A storage read failure is not equivalent to "no prior operation".
      // Fail closed so a caller cannot execute a duplicate workflow.
      throw err;
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

    if (typeof indexedDB === 'undefined' || !db?.idempotency_records || !db?.idempotencyKeys) {
      throw new Error('IDEMPOTENCY_PERSISTENCE_UNAVAILABLE: durable IndexedDB tables are required before executing a workflow.');
    }

    // Do not publish the new state to the in-memory cache until both durable
    // representations have committed successfully.
    await db.transaction('rw', db.idempotency_records, db.idempotencyKeys, async () => {
      await db.idempotency_records.put(tenantScopedRecord);
      await db.idempotencyKeys.put({
        id: effectiveKey,
        status: record.status,
        createdAt: record.createdAt,
        completedAt: record.completedAt,
        tenantId: record.tenantId,
        branchId: record.branchId
      });

      const persisted = await db.idempotency_records.get(effectiveKey);
      const legacyPersisted = await db.idempotencyKeys.get(effectiveKey);
      if (
        !persisted ||
        persisted.tenantId !== record.tenantId ||
        persisted.status !== record.status ||
        !legacyPersisted ||
        legacyPersisted.tenantId !== record.tenantId ||
        legacyPersisted.status !== record.status
      ) {
        throw new Error('IDEMPOTENCY_PERSISTENCE_VERIFY_FAILED: durable PROCESSING/COMMITTED state could not be verified.');
      }
    });

    this.inMemoryStore.set(effectiveKey, tenantScopedRecord);
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
      const updated: IdempotencyRecord = {
        ...existing,
        status,
        ...(status === 'COMMITTED' ? { completedAt: now } : {}),
        ...(result !== undefined ? { result, responseData: result } : {}),
        ...(effectiveFailureReason !== undefined ? { failureReason: effectiveFailureReason } : {})
      };
      await this.save(updated);
    } else {
      if (!effectiveTenantId || effectiveTenantId === 'default' || effectiveTenantId === 'default-tenant' || effectiveTenantId === 'main') {
        throw new Error("FAIL_CLOSED: لا يمكن تحديث حالة Idempotency بدون سياق مؤسسة موثوق (Trusted Tenant Context Required).");
      }
      await this.save({
        key,
        status,
        tenantId: effectiveTenantId,
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
    if (!tenantId || tenantId === 'default' || tenantId === 'default-tenant' || tenantId === 'main') {
      throw new Error('FAIL_CLOSED: tenantId is required to delete an idempotency record.');
    }
    if (typeof indexedDB === 'undefined' || !db?.idempotency_records || !db?.idempotencyKeys) {
      throw new Error('IDEMPOTENCY_PERSISTENCE_UNAVAILABLE: cannot confirm durable idempotency cleanup.');
    }

    const effectiveKey = this.scopedKey(key, tenantId);
    await db.transaction('rw', db.idempotency_records, db.idempotencyKeys, async () => {
      const scopedRecord = await db.idempotency_records.get(effectiveKey);
      if (scopedRecord && scopedRecord.tenantId !== tenantId) {
        throw new Error('IDEMPOTENCY_TENANT_MISMATCH: refusing to delete another tenant record.');
      }
      const scopedLegacy = await db.idempotencyKeys.get(effectiveKey);
      if (scopedLegacy && scopedLegacy.tenantId !== tenantId) {
        throw new Error('IDEMPOTENCY_TENANT_MISMATCH: refusing to delete another tenant legacy record.');
      }

      await db.idempotency_records.delete(effectiveKey);
      await db.idempotencyKeys.delete(effectiveKey);

      // Remove unscoped legacy keys only when their persisted owner is explicit
      // and matches this tenant. Ownerless historical rows remain quarantined.
      const legacyRecord = await db.idempotency_records.get(key);
      if (legacyRecord?.tenantId === tenantId) await db.idempotency_records.delete(key);
      const legacyKey = await db.idempotencyKeys.get(key);
      if (legacyKey?.tenantId === tenantId) await db.idempotencyKeys.delete(key);
    });

    this.inMemoryStore.delete(effectiveKey);
    const memoryLegacy = this.inMemoryStore.get(key);
    if (memoryLegacy?.tenantId === tenantId) this.inMemoryStore.delete(key);
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
