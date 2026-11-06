// ==========================================
// FILE: src/modules/sync/sync.queue.ts
// ==========================================

import Dexie, { Table } from 'dexie';
import { LocalSyncQueueItem, LocalSyncEvent, FailedMutationLog } from './sync.types';
import { db, getTrustedSyncOwner } from '@/core/db';

export interface PharmaFlowDexieExtension {
  syncQueue: Table<LocalSyncQueueItem, number>;
  syncEvents: Table<LocalSyncEvent, number>;
  failedMutations: Table<FailedMutationLog, number>;
}

export const syncSchemaExtensions = {
  syncQueue: '++id,&idempotencyKey,mutationId,[syncStatus+createdAt],[entityType+createdAt]',
  syncEvents: '++id, eventId, sequence, createdAt',
  failedMutations: '++id, mutationId, createdAt',
};

export class SyncQueueRepository {
  private db: Dexie & PharmaFlowDexieExtension;

  constructor(dexieInstance: unknown) {
    this.db = dexieInstance as Dexie & PharmaFlowDexieExtension;
  }

  private requireTrustedOwner(item: { tenantId?: string; userId?: string }): { tenantId: string; userId: string } {
    const owner = getTrustedSyncOwner();
    if (!owner) {
      throw new Error('TRUSTED_USER_CONTEXT_REQUIRED: An authenticated user/token identity is required for sync queue access.');
    }
    if (item.tenantId && item.tenantId !== owner.tenantId) {
      throw new Error('TRUSTED_TENANT_CONTEXT_MISMATCH: Sync queue item tenant does not match the active session.');
    }
    if (item.userId && item.userId !== owner.userId) {
      throw new Error('TRUSTED_USER_CONTEXT_MISMATCH: Sync queue item user does not match the active session.');
    }
    return { tenantId: owner.tenantId, userId: owner.userId };
  }

  async enqueue(item: Omit<LocalSyncQueueItem, 'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'retryCount'>): Promise<number> {
    const owner = this.requireTrustedOwner(item);
    const now = new Date();
    const queueItem: LocalSyncQueueItem = {
      ...item,
      tenantId: owner.tenantId,
      userId: owner.userId,
      syncStatus: 'PENDING',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    
    try {
      return await this.db.transaction('rw', this.db.syncQueue, async () => {
        return await this.db.syncQueue.add(queueItem);
      });
    } catch (error: any) {
      if (error && (error.name === 'ConstraintError' || error instanceof Dexie.ConstraintError)) {
        // Return deterministic result on uniqueness conflict by returning the existing item's ID
        const existing = await this.db.syncQueue.where('idempotencyKey').equals(item.idempotencyKey).first();
        if (
          existing &&
          existing.id !== undefined &&
          existing.tenantId === owner.tenantId &&
          existing.userId === owner.userId
        ) {
          return existing.id;
        }
      }
      throw error;
    }
  }

  /**
   * Enqueues an item within an existing active Dexie transaction.
   * Ensures the caller's business mutation and sync outbox record are committed atomically.
   */
  async enqueueWithinTransaction(item: Omit<LocalSyncQueueItem, 'id' | 'createdAt' | 'updatedAt' | 'syncStatus' | 'retryCount'>): Promise<number> {
    const owner = this.requireTrustedOwner(item);
    const now = new Date();
    const queueItem: LocalSyncQueueItem = {
      ...item,
      tenantId: owner.tenantId,
      userId: owner.userId,
      syncStatus: 'PENDING',
      retryCount: 0,
      createdAt: now,
      updatedAt: now,
    };

    try {
      return await this.db.syncQueue.add(queueItem);
    } catch (error: any) {
      if (error && (error.name === 'ConstraintError' || error instanceof Dexie.ConstraintError)) {
        const existing = await this.db.syncQueue.where('idempotencyKey').equals(item.idempotencyKey).first();
        if (
          existing &&
          existing.id !== undefined &&
          existing.tenantId === owner.tenantId &&
          existing.userId === owner.userId
        ) {
          return existing.id;
        }
      }
      throw error;
    }
  }

  async getNextPendingBatch(limit: number): Promise<LocalSyncQueueItem[]> {
    const owner = this.requireTrustedOwner({});
    // Use the compound status/date index, then enforce exact user ownership.
    return await this.db.syncQueue
      .where('[syncStatus+createdAt]')
      .between(['PENDING', Dexie.minKey], ['PENDING', Dexie.maxKey])
      .and(item => item.tenantId === owner.tenantId && item.userId === owner.userId)
      .limit(limit)
      .toArray();
  }

  /**
   * Returns aggregated count statistics of the queue by status
   */
  async getQueueStats(): Promise<{
    pending: number;
    processing: number;
    conflict: number;
    rejected: number;
    failed: number;
    total: number;
  }> {
    const owner = this.requireTrustedOwner({});
    const all = await this.db.syncQueue.toArray().catch(() => []);
    const ownedItems = all.filter(item =>
      item.tenantId === owner.tenantId && item.userId === owner.userId
    );
    const stats = {
      pending: 0,
      processing: 0,
      conflict: 0,
      rejected: 0,
      failed: 0,
      total: ownedItems.length
    };

    for (const item of ownedItems) {
      const status = item.syncStatus?.toUpperCase();
      if (status === 'PENDING') stats.pending++;
      else if (status === 'PROCESSING') stats.processing++;
      else if (status === 'CONFLICT') stats.conflict++;
      else if (status === 'REJECTED') stats.rejected++;
      else if (status === 'FAILED') stats.failed++;
    }

    return stats;
  }

  /**
   * Retrieves dead-letter mutations (FAILED or REJECTED)
   */
  async getDeadLetterMutations(limit: number = 50): Promise<LocalSyncQueueItem[]> {
    const owner = this.requireTrustedOwner({});
    return await this.db.syncQueue
      .where('syncStatus')
      .anyOf('FAILED', 'REJECTED', 'CONFLICT')
      .and(item => item.tenantId === owner.tenantId && item.userId === owner.userId)
      .limit(limit)
      .toArray()
      .catch(() => []);
  }

  /**
   * Safely purges resolved / confirmed sync items older than the retention threshold
   */
  async purgeObsoleteEvents(olderThanDays: number = 7): Promise<number> {
    // LocalSyncEvent/schema currently carry no tenantId or userId. Deleting
    // by age alone could purge another user's events, so fail closed.
    console.warn(
      `[SyncQueueRepository] Skipped ${olderThanDays}-day sync event purge: ownership metadata is unavailable.`
    );
    return 0;
  }
}

export const syncQueueRepository = new SyncQueueRepository(db);

