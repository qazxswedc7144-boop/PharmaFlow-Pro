// ==========================================
// FILE: src/features/sync/SyncEngine.ts
// Phase 3.4.3 Compatibility Facade Adapter for Legacy Callers
// Delegates all sync operations to the master DistributedSyncEngine
// ==========================================

import { DistributedSyncEngine } from "./sync.engine";
import { db } from "@/core/db";

export type SyncStatus = 'PENDING' | 'SENDING' | 'FAILED' | 'CONFIRMED' | 'RETRYING';

export interface OutboxEvent {
  id?: number;
  mutationId: string;
  type: string;
  payload: Record<string, unknown>;
  status: SyncStatus;
  retries: number;
  createdAt: string;
  updatedAt: string;
  idempotencyKey: string;
  entityType?: string;
  errorCode?: string;
  error?: string;
}

export interface SyncLog {
  id?: number;
  action: 'SYNC_START' | 'SYNC_SUCCESS' | 'SYNC_FAIL' | 'DUPLICATE_DETECTED' | 'CONFLICT_RESOLVED' | 'RETRY_DELAYED';
  entity?: string;
  user?: string;
  branch?: string;
  version?: number;
  mutationId?: string;
  details: string;
  timestamp: string;
  result?: string;
}

/**
 * Legacy Compatibility Facade for SyncEngine.
 * Directs all operations to DistributedSyncEngine without spawning separate loops.
 */
export class SyncEngine {
  /**
   * Delegates initialization to master DistributedSyncEngine
   */
  static init() {
    DistributedSyncEngine.getInstance().start();
  }

  /**
   * Delegated idempotency key helper
   */
  static generateIdempotencyKey(entityType: string, entityId: string, mutationType: string, version: number, branchId: string): string {
    return DistributedSyncEngine.getInstance().generateIdempotencyKey(entityType, entityId, mutationType, version, branchId);
  }

  /**
   * Delegates mutation enqueueing to master DistributedSyncEngine
   */
  static async enqueue(type: string, payload: Record<string, unknown>, entityType: string = 'generic', customIdempotencyKey?: string) {
    const res = await DistributedSyncEngine.getInstance().enqueue(type, payload, entityType, customIdempotencyKey);
    this.log('SYNC_START', `Enqueued mutation ${res.mutationId} (${type})`, res.mutationId, 'SUCCESS', entityType);
    return res;
  }

  /**
   * Delegates resubmission of failed mutations to master DistributedSyncEngine
   */
  static async resubmitFailed(mutationId: string) {
    await DistributedSyncEngine.getInstance().resubmitFailed(mutationId);
  }

  /**
   * Delegates queue draining / sync cycle execution to master DistributedSyncEngine
   */
  static async drainQueue() {
    await DistributedSyncEngine.getInstance().requestSync();
  }

  /**
   * Delegates manual sync trigger to master DistributedSyncEngine
   */
  static async syncNow() {
    await DistributedSyncEngine.getInstance().syncNow();
  }

  /**
   * Diagnostic log recording helper
   */
  static async log(
    action: SyncLog['action'], 
    details: string, 
    mutationId?: string, 
    result?: string,
    entity?: string,
    version?: number
  ) {
    try {
      if (db.syncLogs) {
        await db.syncLogs.add({
          action,
          details,
          mutationId,
          result,
          entity,
          version,
          timestamp: new Date().toISOString()
        });
      }
    } catch {
      // Non-blocking log helper
    }
  }
}
