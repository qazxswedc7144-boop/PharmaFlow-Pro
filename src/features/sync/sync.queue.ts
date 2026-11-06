// ==========================================
// FILE: src/modules/sync/sync.queue.ts
// ==========================================

import Dexie, { Table } from 'dexie';
import { LocalSyncQueueItem, LocalSyncEvent, FailedMutationLog } from './sync.types';
import { db, getCurrentUserSession } from '@/core/db';

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
    const session = getCurrentUserSession();
    if (!session.tenantId || !session.userId) {
      throw new Error('TRUSTED_USER_CONTEXT_REQUIRED: An authenticated user is required for sync queue enqueue.');
    }
    if (item.tenantId && item.tenantId !== session.tenantId) {
      throw new Error('TRUSTED_TENANT_CONTEXT_MISMATCH: Sync queue item tenant does not match the active session.');
    }
    if (item.userId && item.userId !== session.userId) {
      throw new Error('TRUSTED_USER_CONTEXT_MISMATCH: Sync queue item user does not match the active session.');
    }
    return { tenantId: session.tenantId, userId: session.userId };
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
    // استخدام الفهرس المركب لمنع التصفح الكامل للجدول ومقاومة البطء
    return await this.db.syncQueue
      .where('[syncStatus+createdAt]')
      .between(['PENDING', Dexie.minKey], ['PENDING', Dexie.maxKey])
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
    const all = await this.db.syncQueue.toArray().catch(() => []);
    const stats = {
      pending: 0,
      processing: 0,
      conflict: 0,
      rejected: 0,
      failed: 0,
      total: all.length
    };

    for (const item of all) {
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
    return await this.db.syncQueue
      .where('syncStatus')
      .anyOf('FAILED', 'REJECTED', 'CONFLICT')
      .limit(limit)
      .toArray()
      .catch(() => []);
  }

  /**
   * Safely purges resolved / confirmed sync items older than the retention threshold
   */
  async purgeObsoleteEvents(olderThanDays: number = 7): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
    const oldEvents = await this.db.syncEvents
      .where('createdAt')
      .below(cutoff)
      .toArray()
      .catch(() => []);
    
    if (oldEvents.length > 0) {
      const ids = oldEvents.map(e => e.id!).filter(Boolean);
      await this.db.syncEvents.bulkDelete(ids).catch(() => null);
    }
    return oldEvents.length;
  }
}

export const syncQueueRepository = new SyncQueueRepository(db);

