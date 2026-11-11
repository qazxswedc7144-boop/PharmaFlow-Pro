import { LockService } from '@features/locking/lock.service';

export interface GuardOptions {
  tenantId?: string;
  branchId?: string;
  operation?: string;
  entityId?: string;
  ttlMs?: number;
}

/**
 * Execution Guard
 * Prevents double clicks, concurrent requests, rapid retries, parallel posting,
 * and duplicate sync replays by enforcing scoped, TTL-protected locks.
 */
export class ExecutionGuard {
  private static activeInMemoryLocks = new Set<string>();

  /**
   * Executes callback within a scoped lock boundary.
   * Lock format: tenantId:branchId:operation:entityId
   */
  public static async executeWithGuard<T>(
    options: GuardOptions,
    callback: () => Promise<T>
  ): Promise<T> {
    const tenant = options.tenantId || 'default';
    const branch = options.branchId || 'main';
    const op = options.operation || 'op';
    const entity = options.entityId || 'new';
    const ttl = options.ttlMs || 15000;

    const lockKey = `${tenant}:${branch}:${op}:${entity}`;

    // Fast local memory guard check
    if (this.activeInMemoryLocks.has(lockKey)) {
      throw new Error(`⚠️ العملية [${op}] للمورد [${entity}] قيد التنفيذ حالياً. يرجى الانتظار... ⏳`);
    }

    this.activeInMemoryLocks.add(lockKey);

    try {
      // Delegate to Distributed LockService if available
      return await LockService.withLock(
        lockKey,
        {
          branchId: branch,
          lockType: op as any,
          ownerId: 'ExecutionGuard',
          ttl
        },
        async () => {
          return await callback();
        }
      );
    } catch (err: any) {
      // If LockService fails to acquire lock, throw clean business error
      if (err.message && err.message.includes('Conflict detected')) {
        throw new Error(`⚠️ تم رفض الطلب المكرر: العملية [${op}] قيد المعالجة بالفعل.`);
      }
      throw err;
    } finally {
      this.activeInMemoryLocks.delete(lockKey);
    }
  }

  /**
   * Executes a local-first catalog operation with an in-tab guard only.
   * It intentionally avoids the remote Redis lock round-trip; the caller must
   * still persist its idempotency/outbox records atomically in IndexedDB.
   */
  public static async executeWithLocalGuard<T>(
    options: GuardOptions,
    callback: () => Promise<T>
  ): Promise<T> {
    const tenant = options.tenantId || 'default';
    const branch = options.branchId || 'main';
    const op = options.operation || 'op';
    const entity = options.entityId || 'new';
    const lockKey = `${tenant}:${branch}:${op}:${entity}`;

    if (this.activeInMemoryLocks.has(lockKey)) {
      throw new Error(`⚠️ العملية [${op}] للمورد [${entity}] قيد التنفيذ حالياً. يرجى الانتظار... ⏳`);
    }

    this.activeInMemoryLocks.add(lockKey);
    try {
      return await callback();
    } finally {
      this.activeInMemoryLocks.delete(lockKey);
    }
  }

  /**
   * Directly checks if a resource is currently locked
   */
  public static isLocked(options: GuardOptions): boolean {
    const tenant = options.tenantId || 'default';
    const branch = options.branchId || 'main';
    const op = options.operation || 'op';
    const entity = options.entityId || 'new';

    const lockKey = `${tenant}:${branch}:${op}:${entity}`;
    return this.activeInMemoryLocks.has(lockKey);
  }
}
