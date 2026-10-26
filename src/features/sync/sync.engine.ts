// ==========================================
// FILE: src/features/sync/sync.engine.ts
// Phase 3.4.3 Unified Distributed Sync Engine (Source of Truth)
// ==========================================

import Dexie from 'dexie';
import { LocalSyncQueueItem, SYNC_PROTOCOL_VERSION, CLIENT_VERSION } from './sync.types';
import { SYNC_CONFIG } from './sync.constants';
import { PharmaFlowDexieExtension } from './sync.queue';
import { getSyncActions } from './sync.events';
import { getCurrentUserSession, db as defaultDb } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { SyncLockManager } from './sync.lock';
import { DeviceManager } from './device.manager';
import { unifiedTransport } from '@/shared/network/transport/unifiedTransport';

export type SyncEngineState = 
  | 'IDLE' 
  | 'STARTING' 
  | 'SYNCING' 
  | 'OFFLINE' 
  | 'RETRYING' 
  | 'CONFLICT' 
  | 'ERROR' 
  | 'STOPPED';

export class DistributedSyncEngine {
  private static instance: DistributedSyncEngine | null = null;

  private db: Dexie & PharmaFlowDexieExtension;
  private isProcessing = false;
  private timerId: any = null;
  private recoveryDebounceTimer: any = null;
  private activeSyncPromise: Promise<void> | null = null;
  
  private lastPulledCursor: number = 0;
  private lastSyncTimestamp: number = 0;
  private currentState: SyncEngineState = 'IDLE';

  constructor(dexieInstance?: unknown) {
    this.db = (dexieInstance || defaultDb) as Dexie & PharmaFlowDexieExtension;
  }

  /**
   * Access the central DistributedSyncEngine singleton.
   */
  public static getInstance(dexieInstance?: unknown): DistributedSyncEngine {
    if (!DistributedSyncEngine.instance) {
      DistributedSyncEngine.instance = new DistributedSyncEngine(dexieInstance || defaultDb);
    } else if (dexieInstance && (!DistributedSyncEngine.instance.db || DistributedSyncEngine.instance.db !== dexieInstance)) {
      DistributedSyncEngine.instance.db = dexieInstance as Dexie & PharmaFlowDexieExtension;
    }
    return DistributedSyncEngine.instance;
  }

  /**
   * Returns current sync engine state.
   */
  public getState(): SyncEngineState {
    return this.currentState;
  }

  private updateState(newState: SyncEngineState): void {
    this.currentState = newState;
    const actions = getSyncActions();

    if (newState === 'OFFLINE') {
      actions.setNetworkStatus('OFFLINE');
      actions.setQueueDraining(false);
    } else if (newState === 'SYNCING') {
      actions.setNetworkStatus('ONLINE');
      actions.setQueueDraining(true);
    } else if (newState === 'IDLE' || newState === 'STOPPED') {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        actions.setNetworkStatus('OFFLINE');
      } else {
        actions.setNetworkStatus('ONLINE');
      }
      actions.setQueueDraining(false);
    }
  }

  /**
   * Starts periodic polling worker and registers network/visibility listeners.
   */
  public start(): void {
    if (this.timerId) return;

    this.updateState('STARTING');

    // Register device identity in background
    DeviceManager.registerWithServer().catch(() => {});

    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleNetworkChange);
      window.addEventListener('offline', this.handleNetworkChange);
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.timerId = setInterval(() => {
      this.requestSync().catch(() => {});
    }, SYNC_CONFIG.POLLING_INTERVAL_MS);

    // Initial sync run on boot
    this.requestSync().catch(() => {});
  }

  /**
   * Stops periodic sync checks and cleans up listeners.
   */
  public stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.recoveryDebounceTimer) {
      clearTimeout(this.recoveryDebounceTimer);
      this.recoveryDebounceTimer = null;
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleNetworkChange);
      window.removeEventListener('offline', this.handleNetworkChange);
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }

    this.updateState('STOPPED');
  }

  /**
   * Debounced handler for network state changes (online/offline).
   */
  private handleNetworkChange = (): void => {
    if (typeof navigator !== 'undefined' && navigator.onLine) {
      if (this.recoveryDebounceTimer) clearTimeout(this.recoveryDebounceTimer);
      this.recoveryDebounceTimer = setTimeout(() => {
        this.requestSync().catch(() => {});
      }, 300);
    } else {
      this.updateState('OFFLINE');
    }
  };

  /**
   * Coalesced handler for tab visibility changes.
   */
  private handleVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && typeof navigator !== 'undefined' && navigator.onLine) {
      if (this.recoveryDebounceTimer) clearTimeout(this.recoveryDebounceTimer);
      this.recoveryDebounceTimer = setTimeout(() => {
        this.requestSync().catch(() => {});
      }, 300);
    }
  };

  /**
   * Single-Flight Entry Point: Coalesces concurrent sync requests into 1 active cycle.
   */
  public requestSync(): Promise<void> {
    return this.syncNow();
  }

  /**
   * Single-Flight Sync Execution
   */
  public async syncNow(): Promise<void> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.updateState('OFFLINE');
      return Promise.resolve();
    }

    // Coalesce into existing active sync promise if present
    if (this.activeSyncPromise) {
      return this.activeSyncPromise;
    }

    this.activeSyncPromise = this.executeSyncCycle().finally(() => {
      this.activeSyncPromise = null;
    });

    return this.activeSyncPromise;
  }

  /**
   * Executes a full synchronization cycle wrapped in safe lock.
   */
  private async executeSyncCycle(): Promise<void> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.updateState('OFFLINE');
      return;
    }

    this.updateState('SYNCING');

    try {
      await SyncLockManager.withSyncLock(async () => {
        try {
          await this.drainQueue();
        } catch (drainErr) {
          console.warn('[DistributedSyncEngine] Queue drain step warning:', drainErr);
        }
        try {
          await this.pullSync();
        } catch (pullErr) {
          console.warn('[DistributedSyncEngine] Pull sync step warning:', pullErr);
        }
      });
      this.updateState('IDLE');
    } catch (error) {
      console.warn('[DistributedSyncEngine] Sync cycle encountered warning:', error);
      this.updateState(typeof navigator !== 'undefined' && !navigator.onLine ? 'OFFLINE' : 'IDLE');
    }
  }

  /**
   * Generates a deterministic Idempotency Key based on entity context
   */
  public generateIdempotencyKey(entityType: string, entityId: string, mutationType: string, version: number, branchId: string): string {
    return `${entityType}:${entityId}:${mutationType}:${version}:${branchId}`;
  }

  /**
   * Atomic Outbox / Queue Enqueue (Primary Entry Point for Mutations)
   */
  public async enqueue(
    type: string, 
    payload: Record<string, unknown>, 
    entityType: string = 'generic', 
    customIdempotencyKey?: string,
    options?: { tenantId?: string; branchId?: string }
  ): Promise<{ mutationId: string; idempotencyKey: string; queueItemId?: number }> {
    const mutationId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
    const timestamp = new Date().toISOString();
    const session = getCurrentUserSession();
    
    const tenantId = options?.tenantId || session.tenantId;
    const branchId = options?.branchId || session.branchId;

    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    const forbiddenBranches = ['BR-MAIN', 'branch_default', 'default'];

    if (!tenantId || forbiddenTenants.includes(tenantId)) {
      throw new Error('TRUSTED_TENANT_CONTEXT_REQUIRED: No valid trusted tenant context available for sync enqueue.');
    }
    if (!branchId || forbiddenBranches.includes(branchId)) {
      throw new Error('TRUSTED_BRANCH_CONTEXT_REQUIRED: No valid trusted branch context available for sync enqueue.');
    }
    const version = (payload?.version as number) || 1;
    const entityId = (payload?.id as string) || 'unknown';
    
    const idempotencyKey = customIdempotencyKey || this.generateIdempotencyKey(entityType, entityId, type, version, branchId);
    const sanitizedPayload = this.sanitizePayload(payload) || {};

    const queueItem: LocalSyncQueueItem = {
      mutationId,
      tenantId,
      branchId,
      deviceId: DeviceManager.getDeviceIdentity().deviceId,
      userId: session.userId,
      entityType,
      operationType: type as any,
      payload: sanitizedPayload,
      syncStatus: 'PENDING',
      retryCount: 0,
      idempotencyKey,
      version,
      logicalTimestamp: Date.now(),
      actorId: session.userId || 'system',
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const outboxEvent = {
      mutationId,
      tenantId,
      type,
      payload: sanitizedPayload,
      status: 'PENDING',
      retries: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      idempotencyKey,
      entityType
    };

    let addedId: number | undefined = undefined;

    try {
      const txTables = [this.db.syncQueue];
      if ((this.db as any).outbox && (this.db as any).outbox.schema) {
        txTables.push((this.db as any).outbox);
      }
      await (this.db as any).transaction('rw', txTables, async () => {
        if (this.db.syncQueue) {
          try {
            addedId = await this.db.syncQueue.add(queueItem);
          } catch (err: any) {
            if (err && (err.name === 'ConstraintError' || err instanceof Dexie.ConstraintError)) {
              const existing = await this.db.syncQueue.where('idempotencyKey').equals(idempotencyKey).first();
              if (existing) {
                addedId = existing.id;
              }
            }
          }
        }
        if ((this.db as any).outbox && (this.db as any).outbox.schema) {
          try {
            await (this.db as any).outbox.add(outboxEvent);
          } catch (err: any) {
            // Ignore duplicate constraint for outbox
          }
        }
      });

      if (typeof navigator !== 'undefined' && navigator.onLine) {
        this.requestSync().catch(() => {});
      }

      return { mutationId, idempotencyKey, queueItemId: addedId };
    } catch (error) {
      console.error("[DistributedSyncEngine] Atomic Enqueue Failed:", error);
      throw error;
    }
  }

  /**
   * Transactional Outbox Enqueue:
   * Writes the mutation directly to syncQueue and outbox within an already active caller transaction.
   * Ensures business writes and outbox records commit or roll back together atomically.
   */
  public async enqueueWithinTransaction(
    type: string, 
    payload: Record<string, unknown>, 
    entityType: string = 'generic', 
    customIdempotencyKey?: string,
    options?: { tenantId?: string; branchId?: string }
  ): Promise<{ mutationId: string; idempotencyKey: string; queueItemId?: number }> {
    const mutationId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
    const timestamp = new Date().toISOString();
    const session = getCurrentUserSession();
    
    const tenantId = options?.tenantId || session.tenantId;
    const branchId = options?.branchId || session.branchId;

    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    const forbiddenBranches = ['BR-MAIN', 'branch_default', 'default'];

    if (!tenantId || forbiddenTenants.includes(tenantId)) {
      throw new Error('TRUSTED_TENANT_CONTEXT_REQUIRED: No valid trusted tenant context available for transactional sync enqueue.');
    }
    if (!branchId || forbiddenBranches.includes(branchId)) {
      throw new Error('TRUSTED_BRANCH_CONTEXT_REQUIRED: No valid trusted branch context available for transactional sync enqueue.');
    }
    const version = (payload?.version as number) || 1;
    const entityId = (payload?.id as string) || 'unknown';
    
    const idempotencyKey = customIdempotencyKey || this.generateIdempotencyKey(entityType, entityId, type, version, branchId);
    const sanitizedPayload = this.sanitizePayload(payload) || {};

    const queueItem: LocalSyncQueueItem = {
      mutationId,
      tenantId,
      branchId,
      deviceId: DeviceManager.getDeviceIdentity().deviceId,
      userId: session.userId,
      entityType,
      operationType: type as any,
      payload: sanitizedPayload,
      syncStatus: 'PENDING',
      retryCount: 0,
      idempotencyKey,
      version,
      logicalTimestamp: Date.now(),
      actorId: session.userId || 'system',
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const outboxEvent = {
      mutationId,
      tenantId,
      type,
      payload: sanitizedPayload,
      status: 'PENDING',
      retries: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      idempotencyKey,
      entityType
    };

    let addedId: number | undefined = undefined;

    if (this.db.syncQueue) {
      const existing = await this.db.syncQueue.where('idempotencyKey').equals(idempotencyKey).first();
      if (existing) {
        addedId = existing.id;
      } else {
        try {
          addedId = await this.db.syncQueue.add(queueItem);
        } catch (err: any) {
          if (err && (err.name === 'ConstraintError' || err instanceof Dexie.ConstraintError)) {
            const recheck = await this.db.syncQueue.where('idempotencyKey').equals(idempotencyKey).first();
            if (recheck) {
              addedId = recheck.id;
            }
          }
        }
      }
    }

    const currentTx = (Dexie as any).currentTransaction;
    const canWriteOutbox = (this.db as any).outbox && (this.db as any).outbox.schema && 
      (!currentTx || (currentTx.tables && (currentTx.tables['outbox'] || (Array.isArray(currentTx.tables) && currentTx.tables.some((t: any) => t.name === 'outbox')))));
    if (canWriteOutbox) {
      try {
        await (this.db as any).outbox.add(outboxEvent);
      } catch (err: any) {
        // Ignore duplicate constraint for outbox
      }
    }

    return { mutationId, idempotencyKey, queueItemId: addedId };
  }

  /**
   * Returns complete queue statistics and health overview
   */
  public async getSyncMetrics(): Promise<{
    pendingCount: number;
    processingCount: number;
    failedCount: number;
    conflictCount: number;
    rejectedCount: number;
    isOnline: boolean;
    isProcessing: boolean;
    lastSyncTimestamp?: string;
  }> {
    let pendingCount = 0;
    let processingCount = 0;
    let failedCount = 0;
    let conflictCount = 0;
    let rejectedCount = 0;

    if (this.db.syncQueue) {
      const items = await this.db.syncQueue.toArray().catch(() => []);
      for (const it of items) {
        const s = it.syncStatus?.toUpperCase();
        if (s === 'PENDING') pendingCount++;
        else if (s === 'PROCESSING') processingCount++;
        else if (s === 'FAILED') failedCount++;
        else if (s === 'CONFLICT') conflictCount++;
        else if (s === 'REJECTED') rejectedCount++;
      }
    }

    return {
      pendingCount,
      processingCount,
      failedCount,
      conflictCount,
      rejectedCount,
      isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
      isProcessing: this.isProcessing,
      lastSyncTimestamp: this.lastSyncTimestamp ? new Date(this.lastSyncTimestamp).toISOString() : undefined
    };
  }

  /**
   * Resubmits a failed mutation manually from the dead letter log.
   */
  public async resubmitFailed(mutationId: string): Promise<void> {
    try {
      const now = new Date().toISOString();
      if (this.db.syncQueue) {
        const queueItem = await this.db.syncQueue.where('mutationId').equals(mutationId).first();
        if (queueItem) {
          await this.db.syncQueue.update(queueItem.id!, {
            syncStatus: 'PENDING',
            retryCount: 0,
            lastError: undefined,
            updatedAt: now
          });
        }
      }

      if ((this.db as any).outbox) {
        const outboxItem = await (this.db as any).outbox.where('mutationId').equals(mutationId).first();
        if (outboxItem) {
          await (this.db as any).outbox.update(outboxItem.id!, {
            status: 'PENDING',
            retries: 0,
            error: undefined,
            updatedAt: now
          });
        }
      }

      if (typeof navigator !== 'undefined' && navigator.onLine) {
        this.requestSync().catch(() => {});
      }
    } catch (e) {
      console.error("[DistributedSyncEngine] Failed to resubmit mutation:", e);
    }
  }

  private getApiUrl(endpoint: string): string {
    if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) return endpoint;
    const origin = (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') 
      ? window.location.origin 
      : 'http://localhost:3000';
    return `${origin}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  }

  /**
   * Pull server updates using cursor-based delta synchronization.
   */
  public async pullSync(): Promise<void> {
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;

    try {
      const session = getCurrentUserSession();
      const device = DeviceManager.getDeviceIdentity();

      const executePullFetch = async (): Promise<Response> => {
        return await unifiedTransport.request<Response>({
          url: this.getApiUrl('/api/v1/sync/pull'),
          method: 'POST',
          profile: 'SYNC',
          raw: true,
          headers: { 
            'X-Tenant-ID': session.tenantId || 'unknown',
            'X-Branch-ID': session.branchId || '',
            'X-User-ID': session.userId || 'unknown',
            'X-Device-ID': device.deviceId
          },
          body: { 
            tenantId: session.tenantId,
            branchId: session.branchId,
            userId: session.userId,
            deviceId: device.deviceId,
            cursor: this.lastPulledCursor,
            lastSyncTimestamp: this.lastSyncTimestamp,
            schemaVersion: SYNC_PROTOCOL_VERSION
          }
        });
      };

      let response = await executePullFetch();

      // Single-Flight 401 Refresh Handling
      if (response.status === 401 && typeof navigator !== 'undefined' && navigator.onLine) {
        try {
          await TokenProvider.refreshAccessToken();
          response = await executePullFetch();
        } catch {
          // Token refresh failed or session expired
          return;
        }
      }

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          if (data.nextCursor) {
            this.lastPulledCursor = data.nextCursor;
          }
          if (data.serverTimestamp) {
            this.lastSyncTimestamp = data.serverTimestamp;
          }

          if (Array.isArray(data.changes) && data.changes.length > 0) {
            // Sort changes by cursor to guarantee monotonic sequence
            const sortedChanges = [...data.changes].sort((a, b) => (Number(a.cursor) || 0) - (Number(b.cursor) || 0));

            for (const change of sortedChanges) {
              await this.applyServerChange(change);
            }

            // Update persistent device sequence tracking
            DeviceManager.updateSequence(this.lastPulledCursor, this.lastPulledCursor);
          }

          if (data.delta) {
  const { products, invoices } = data.delta;
  
  // 🚨 SECURITY FIX: Filter delta by Tenant ID before writing to DB
  const validProducts = Array.isArray(products) ? products.filter(p => p.tenantId === session.tenantId) : [];
  const validInvoices = Array.isArray(invoices) ? invoices.filter(inv => inv.tenantId === session.tenantId) : [];

  if (validProducts.length > 0 && (this.db as any).products) {
    await (this.db as any).products.bulkPut(validProducts.map((p: any) => ({
      ...p,
      tenantId: session.tenantId,
      is_synced: 1,
      isSynced: true,
      syncStatus: 'SYNCED',
      updatedAt: p.updatedAt || new Date().toISOString()
    }))).catch((err: any) => console.warn('[DistributedSyncEngine] Product pull update warning:', err));
  }

  if (validInvoices.length > 0 && (this.db as any).invoices) {
    await (this.db as any).invoices.bulkPut(validInvoices.map((inv: any) => ({
      ...inv,
      tenantId: session.tenantId,
      branchId: inv.branchId || session.branchId,
      is_synced: 1,
      isSynced: true,
      syncStatus: 'SYNCED',
      updatedAt: inv.updatedAt || new Date().toISOString()
    }))).catch((err: any) => console.warn('[DistributedSyncEngine] Invoice pull update warning:', err));
  }
          }
        }
      }
    } catch (error) {
      console.warn('[DistributedSyncEngine] Downstream pull sync skipped:', error);
    }
  }

  /**
   * Applies an individual downstream change record to the local Dexie database.
   */
  private async applyServerChange(change: any): Promise<void> {
  try {
    // 🚨 SECURITY FIX: Strict Tenant Isolation for downstream changes
    const session = getCurrentUserSession();
    if (!session || !session.tenantId) {
      console.warn("[DistributedSyncEngine] Aborting applyServerChange: No active session.");
      return;
    }

    if (!change.tenantId || change.tenantId !== session.tenantId) {
      console.warn(`[DistributedSyncEngine] Security Block: Ignored cross-tenant change. Expected: ${session.tenantId}, Got: ${change.tenantId}`);
      return;
    }

    const entity = change.entity?.toUpperCase();
    const payload = change.payload || {};
    const entityId = change.entityId;

    if (!entityId) return;

    if (entity === "PRODUCT" && (this.db as any).products) {
      if (change.operation === "DELETE") {
        // 🚨 SECURITY FIX: Check if local record exists and belongs to same tenant
        const existing = await (this.db as any).products.get(entityId).catch(() => null);
        if (existing && existing.tenantId === session.tenantId) {
          await (this.db as any).products.delete(entityId).catch(() => {});
        }
      } else {
        await (this.db as any).products.put({
          ...payload,
          id: entityId,
          tenantId: session.tenantId, // Force current tenant
          is_synced: 1,
          isSynced: true,
          syncStatus: "SYNCED",
          updatedAt: change.createdAt
        }).catch(() => {});
      }
    } else if ((entity === "INVOICE" || entity === "SALE") && (this.db as any).invoices) {
      if (change.operation === "DELETE") {
        // 🚨 SECURITY FIX: Check if local record exists and belongs to same tenant
        const existing = await (this.db as any).invoices.get(entityId).catch(() => null);
        if (existing && existing.tenantId === session.tenantId) {
          await (this.db as any).invoices.delete(entityId).catch(() => {});
        }
      } else {
        await (this.db as any).invoices.put({
          ...payload,
          id: entityId,
          tenantId: session.tenantId, // Force current tenant
          branchId: change.branchId || session.branchId,
          is_synced: 1,
          isSynced: true,
          syncStatus: "SYNCED",
          updatedAt: change.createdAt
        }).catch(() => {});
      }
    }
  } catch (err) {
    console.warn("[DistributedSyncEngine] Failed applying downstream server change:", err);
  }
  }

  /**
   * Processes Outbox and SyncQueue tables sequentially.
   */
  public async drainQueue(): Promise<void> {
    if (this.isProcessing || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
    this.isProcessing = true;

    try {
      // 1. Drain syncQueue table
      if (this.db.syncQueue) {
        let hasMore = true;
        while (hasMore) {
          const batch = await this.db.syncQueue
            .where('[syncStatus+createdAt]')
            .between(['PENDING', Dexie.minKey], ['PENDING', Dexie.maxKey])
            .limit(SYNC_CONFIG.BATCH_CHUNK_SIZE)
            .toArray()
            .catch(() => []);

          if (batch.length === 0) {
            hasMore = false;
            break;
          }

          for (const mutation of batch) {
            await this.processMutationWithRetry(mutation);
          }
        }
      }

      // 2. Drain outbox table
      if ((this.db as any).outbox) {
        const outboxEvents = await (this.db as any).outbox
          .where('status')
          .anyOf('PENDING', 'pending', 'RETRYING')
          .toArray()
          .catch(() => []);

        for (const event of outboxEvents) {
          await this.processOutboxEvent(event);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private async processOutboxEvent(event: any): Promise<void> {
    try {
      const session = getCurrentUserSession();
      const device = DeviceManager.getDeviceIdentity();

      await (this.db as any).outbox.update(event.id, { status: 'SENDING', updatedAt: new Date().toISOString() });
      
      const sendPushRequest = async (): Promise<Response> => {
        return await unifiedTransport.request<Response>({
          url: this.getApiUrl('/api/v1/sync/push'),
          method: 'POST',
          profile: 'SYNC',
          raw: true,
          headers: { 
            'X-Tenant-ID': event.tenantId || session.tenantId,
            'X-Branch-ID': event.branchId || session.branchId || '',
            'X-User-ID': session.userId,
            'X-Device-ID': device.deviceId
          },
          body: {
            tenantId: event.tenantId || session.tenantId,
            branchId: event.branchId || session.branchId,
            userId: session.userId,
            deviceId: device.deviceId,
            schemaVersion: SYNC_PROTOCOL_VERSION,
            clientVersion: CLIENT_VERSION,
            mutations: [{
              id: event.mutationId || String(event.id),
              entity: event.entityType || event.type || 'MUTATION',
              operation: event.operation || 'CREATE',
              payload: event.payload || {},
              idempotencyKey: event.idempotencyKey || event.mutationId || String(event.id),
              timestamp: event.createdAt || Date.now()
            }]
          }
        });
      };

      let response = await sendPushRequest();

      // Single-Flight 401 Refresh Handling
      if (response.status === 401 && typeof navigator !== 'undefined' && navigator.onLine) {
        try {
          await TokenProvider.refreshAccessToken();
          response = await sendPushRequest();
        } catch {
          await (this.db as any).outbox.update(event.id, {
            status: 'FAILED',
            error: 'Session expired / Unauthorized',
            updatedAt: new Date().toISOString()
          });
          return;
        }
      }

      if (response.ok) {
        await (this.db as any).outbox.update(event.id, { status: 'CONFIRMED', updatedAt: new Date().toISOString() });
      } else {
        const errorBody = await response.json().catch(() => ({}));
        const isFatal = [400, 401, 403].includes(response.status) || errorBody.errorCode === "SCHEMA_VERSION_MISMATCH";
        await (this.db as any).outbox.update(event.id, { 
          status: isFatal ? 'FAILED' : 'RETRYING', 
          error: errorBody.message || `HTTP ${response.status}`,
          updatedAt: new Date().toISOString() 
        });
      }
    } catch (err: any) {
      await (this.db as any).outbox.update(event.id, { 
        status: 'RETRYING', 
        error: err.message || "Network Error",
        updatedAt: new Date().toISOString() 
      });
    }
  }

  private async processMutationWithRetry(mutation: LocalSyncQueueItem): Promise<void> {
    await this.db.syncQueue.update(mutation.id!, { syncStatus: 'PROCESSING', updatedAt: new Date() });

    let delay: number = SYNC_CONFIG.BACKOFF_INITIAL_DELAY_MS;
    const session = getCurrentUserSession();
    const device = DeviceManager.getDeviceIdentity();

    const sendPushMutation = async (): Promise<Response> => {
      return await unifiedTransport.request<Response>({
        url: this.getApiUrl('/api/v1/sync/push'),
        method: 'POST',
        profile: 'SYNC',
        raw: true,
        headers: {
          'X-Tenant-ID': mutation.tenantId || session.tenantId || 'unknown',
          'X-Branch-ID': mutation.branchId || session.branchId || '',
          'X-User-ID': session.userId || 'unknown',
          'X-Device-ID': device.deviceId,
          'X-Session-ID': (mutation as any).sessionId || 'local-session',
          'X-Correlation-ID': mutation.correlationId || 'local-correlation',
        },
        body: {
          tenantId: mutation.tenantId || session.tenantId,
          branchId: mutation.branchId || session.branchId,
          userId: session.userId,
          deviceId: device.deviceId,
          schemaVersion: SYNC_PROTOCOL_VERSION,
          clientVersion: CLIENT_VERSION,
          mutations: [{
            id: mutation.mutationId,
            entity: mutation.entityType || 'MUTATION',
            operation: mutation.operationType || 'CREATE',
            payload: mutation.payload,
            idempotencyKey: mutation.idempotencyKey || mutation.mutationId,
            version: mutation.version || 1,
            timestamp: mutation.createdAt
          }]
        }
      });
    };
    
    while (mutation.retryCount <= SYNC_CONFIG.MAX_RETRY_ATTEMPTS) {
      try {
        let response = await sendPushMutation();

        // Single-Flight 401 Refresh Handling
        if (response.status === 401 && typeof navigator !== 'undefined' && navigator.onLine) {
          try {
            await TokenProvider.refreshAccessToken();
            response = await sendPushMutation();
          } catch {
            await this.db.syncQueue.update(mutation.id!, {
              syncStatus: 'REJECTED',
              lastError: 'Session expired / Unauthorized',
              updatedAt: new Date()
            });
            return;
          }
        }

        if (response.ok) {
          await this.db.syncQueue.delete(mutation.id!);

          if ((this.db as any).outbox) {
            try {
              const matchingOutbox = await (this.db as any).outbox.where('mutationId').equals(mutation.mutationId).first();
              if (matchingOutbox) {
                await (this.db as any).outbox.update(matchingOutbox.id, { status: 'CONFIRMED', updatedAt: new Date().toISOString() });
              }
            } catch {
              // Non-blocking outbox sync
            }
          }

          // Mark local record as synced
          if (mutation.payload && (mutation.payload as any).id) {
            const entityId = (mutation.payload as any).id;
            const eType = String(mutation.entityType).toUpperCase();
            if (eType === 'SALE' || eType === 'INVOICE') {
              if ((this.db as any).invoices) {
                await (this.db as any).invoices.update(entityId, {
                  is_synced: 1,
                  isSynced: true,
                  syncStatus: 'SYNCED',
                  updatedAt: new Date().toISOString()
                }).catch(() => null);
              }
            } else if (eType === 'PRODUCT') {
              if ((this.db as any).products) {
                await (this.db as any).products.update(entityId, {
                  is_synced: 1,
                  isSynced: true,
                  syncStatus: 'SYNCED',
                  updatedAt: new Date().toISOString()
                }).catch(() => null);
              }
            }
          }
          return;
        }

        const errPayload = await response.json().catch(() => ({}));
        
        // Handle explicit conflicts
        if (response.status === 409 || errPayload.errorType === 'CONFLICT' || errPayload.results?.[0]?.status === 'CONFLICT') {
          const conflictData = errPayload.results?.[0]?.conflict || errPayload;
          await this.handleConflict(mutation, conflictData.message || 'تعارض في مزامنة السجل مع الخادم');
          return;
        }

        // Non-retryable fatal errors
        if ([400, 401, 403].includes(response.status) || errPayload.errorCode === "SCHEMA_VERSION_MISMATCH" || errPayload.errorCode === "DEVICE_REVOKED") {
          await this.db.syncQueue.update(mutation.id!, {
            syncStatus: 'REJECTED',
            lastError: errPayload.message || `Rejected by server with code ${errPayload.errorCode || response.status}`,
            updatedAt: new Date()
          });
          return;
        }

        throw new Error(`Server returned status: ${response.status}`);

      } catch (error: any) {
        mutation.retryCount++;
        const isDeadLetter = mutation.retryCount > SYNC_CONFIG.MAX_RETRY_ATTEMPTS;
        await this.db.syncQueue.update(mutation.id!, { 
          retryCount: mutation.retryCount, 
          syncStatus: isDeadLetter ? 'FAILED' : 'RETRY_PENDING',
          lastError: error.message || 'Sync network/processing failure',
          updatedAt: new Date() 
        });

        if (isDeadLetter) {
          try {
            await this.db.failedMutations.add({
              mutationId: mutation.mutationId,
              reason: `DEAD_LETTER_MAX_RETRIES_EXCEEDED: ${error.message || 'Network error'}`,
              payload: mutation.payload,
              tenantId: mutation.tenantId,
              branchId: mutation.branchId,
              createdAt: new Date(),
            });
          } catch {
            // Non-blocking DLQ logging
          }
          return;
        }

        // Add random jitter to exponential backoff (e.g. 10-20% variance)
        const jitter = Math.random() * 200;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        delay = Math.min(delay * 2, SYNC_CONFIG.BACKOFF_MAX_DELAY_MS);
      }
    }
  }

  private async handleConflict(mutation: LocalSyncQueueItem, reason: string): Promise<void> {
    await this.db.transaction('rw', [this.db.syncQueue, this.db.failedMutations], async () => {
      await this.db.failedMutations.add({
        mutationId: mutation.mutationId,
        reason: reason,
        payload: mutation.payload,
        createdAt: new Date(),
      });
      await this.db.syncQueue.update(mutation.id!, {
        syncStatus: 'CONFLICT',
        updatedAt: new Date(),
      });
    });
  }

  private sanitizePayload(payload: Record<string, unknown> | null | undefined): Record<string, unknown> | null | undefined {
    if (!payload || typeof payload !== 'object') return payload;
    const sanitized: Record<string, unknown> = { ...payload };
    
    const forbiddenKeys = ['password', 'token', 'apiKey', 'secret', 'credentials'];
    for (const key of Object.keys(sanitized)) {
      if (forbiddenKeys.some(fk => key.toLowerCase().includes(fk))) {
        delete sanitized[key];
      } else if (typeof sanitized[key] === 'function') {
        delete sanitized[key];
      } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = this.sanitizePayload(sanitized[key] as Record<string, unknown>);
      }
    }
    return sanitized;
  }
}
