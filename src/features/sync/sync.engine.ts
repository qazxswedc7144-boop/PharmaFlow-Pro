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

type SyncSessionSnapshot = {
  tenantId: string;
  userId: string;
  branchId: string | null;
  token: string | null;
};

function readSyncSessionSnapshot(): SyncSessionSnapshot | null {
  const session = TokenProvider.getCurrentSession() as any;
  const user = session?.user;
  const tenantId = session?.tenantId || user?.tenantId || user?.tenant_id;
  const userId = user?.id || user?.user_id;
  const branchId = session?.branchId || user?.branchId || user?.branch_id || null;
  if (!session?.isAuthenticated || !session?.token || !tenantId || !userId) return null;
  return { tenantId, userId, branchId, token: session.token };
}

function isSyncSessionCurrent(snapshot: SyncSessionSnapshot, includeToken = true): boolean {
  const current = readSyncSessionSnapshot();
  return Boolean(current && current.tenantId === snapshot.tenantId &&
    current.userId === snapshot.userId && current.branchId === snapshot.branchId &&
    (!includeToken || current.token === snapshot.token));
}

function assertSyncSessionCurrent(snapshot: SyncSessionSnapshot): void {
  if (!isSyncSessionCurrent(snapshot)) {
    throw new Error('SESSION_SWITCH_DETECTED: Sync session changed while a request was in flight.');
  }
}

function acceptRefreshedSyncToken(snapshot: SyncSessionSnapshot): void {
  const current = readSyncSessionSnapshot();
  if (!current || current.tenantId !== snapshot.tenantId ||
      current.userId !== snapshot.userId || current.branchId !== snapshot.branchId) {
    throw new Error('SESSION_SWITCH_DETECTED: Session identity changed during token refresh.');
  }
  snapshot.token = current.token;
}

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
      userId: session.userId,
      branchId,
      deviceId: DeviceManager.getDeviceIdentity().deviceId,
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
            'X-Tenant-ID': session.tenantId || '',
            'X-Branch-ID': session.branchId || '',
            'X-User-ID': session.userId || '',
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
    const snapshot = readSyncSessionSnapshot();
    if (!snapshot) return;
    this.isProcessing = true;
    const staleBefore = Date.now() - 5 * 60 * 1000;
    try {
      if (this.db.syncQueue) {
        const processing = await this.db.syncQueue.where('syncStatus').equals('PROCESSING').toArray().catch(() => []);
        assertSyncSessionCurrent(snapshot);
        for (const item of processing) {
          const updatedAt = new Date(item.updatedAt || item.createdAt || 0).getTime();
          if (item.tenantId === snapshot.tenantId && item.userId === snapshot.userId &&
              Number.isFinite(updatedAt) && updatedAt < staleBefore) {
            assertSyncSessionCurrent(snapshot);
            await this.db.syncQueue.update(item.id!, { syncStatus: 'PENDING', updatedAt: new Date() });
            assertSyncSessionCurrent(snapshot);
          }
        }
        const batch = await this.db.syncQueue.where('syncStatus').anyOf('PENDING', 'RETRY_PENDING').toArray().catch(() => []);
        assertSyncSessionCurrent(snapshot);
        const eligible = batch.filter(item => item.tenantId === snapshot.tenantId &&
          (!item.userId || item.userId === snapshot.userId))
          .sort((a,b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
          .slice(0, SYNC_CONFIG.BATCH_CHUNK_SIZE);
        for (const mutation of eligible) {
          assertSyncSessionCurrent(snapshot);
          await this.processMutationWithRetry(mutation);
          if (!isSyncSessionCurrent(snapshot)) break;
        }
      }

      assertSyncSessionCurrent(snapshot);
      if ((this.db as any).outbox) {
        const sending = await (this.db as any).outbox.where('status').equals('SENDING').toArray().catch(() => []);
        assertSyncSessionCurrent(snapshot);
        for (const event of sending) {
          const updatedAt = new Date(event.updatedAt || event.createdAt || 0).getTime();
          if (event.tenantId === snapshot.tenantId && event.userId === snapshot.userId &&
              Number.isFinite(updatedAt) && updatedAt < staleBefore) {
            assertSyncSessionCurrent(snapshot);
            await (this.db as any).outbox.update(event.id, { status: 'PENDING', updatedAt: new Date().toISOString() });
            assertSyncSessionCurrent(snapshot);
          }
        }
        const events = await (this.db as any).outbox.where('status').anyOf('PENDING','pending','RETRYING').toArray().catch(() => []);
        assertSyncSessionCurrent(snapshot);
        for (const event of events) {
          if (event.tenantId !== snapshot.tenantId || event.userId !== snapshot.userId) continue;
          assertSyncSessionCurrent(snapshot);
          await this.processOutboxEvent(event);
          if (!isSyncSessionCurrent(snapshot)) break;
        }
      }
    } catch (error: any) {
      // Session changes are expected cancellation boundaries for a queue drain.
      // Do not let a stale session's cancellation surface as an unhandled failure.
      if (error?.message?.includes('SESSION_SWITCH_DETECTED') || !isSyncSessionCurrent(snapshot)) return;
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  private async processOutboxEvent(event: any): Promise<void> {
    const snapshot = readSyncSessionSnapshot();
    if (!snapshot || !event?.id || event.tenantId !== snapshot.tenantId ||
        (event.userId && event.userId !== snapshot.userId)) return;
    try {
      assertSyncSessionCurrent(snapshot);
      const device = DeviceManager.getDeviceIdentity();
      await (this.db as any).outbox.update(event.id, { status: 'SENDING', updatedAt: new Date().toISOString() });
      assertSyncSessionCurrent(snapshot);
      const send = async (): Promise<Response> => {
        assertSyncSessionCurrent(snapshot);
        const response = await unifiedTransport.request<Response>({
          url: this.getApiUrl('/api/v1/sync/push'), method: 'POST', profile: 'SYNC', raw: true,
          headers: {
            'X-Tenant-ID': snapshot.tenantId,
            'X-Branch-ID': event.branchId || snapshot.branchId || '',
            'X-User-ID': snapshot.userId,
            'X-Device-ID': device.deviceId
          },
          body: {
            tenantId: snapshot.tenantId, branchId: event.branchId || snapshot.branchId,
            userId: snapshot.userId, deviceId: device.deviceId,
            schemaVersion: SYNC_PROTOCOL_VERSION, clientVersion: CLIENT_VERSION,
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
        assertSyncSessionCurrent(snapshot);
        return response;
      };
      let response = await send();
      if (response.status === 401 && typeof navigator !== 'undefined' && navigator.onLine) {
        await TokenProvider.refreshAccessToken();
        acceptRefreshedSyncToken(snapshot);
        response = await send();
      }
      assertSyncSessionCurrent(snapshot);
      const body = typeof response.json === 'function' ? await response.json().catch(() => ({})) : {};
      assertSyncSessionCurrent(snapshot);
      const result = Array.isArray(body.results)
        ? body.results.find((item: any) => item?.mutationId === event.mutationId || item?.id === event.mutationId) || body.results[0]
        : undefined;
      const resultStatus = String(result?.status || '').toUpperCase();

      if (response.ok && (resultStatus === 'SUCCESS' || resultStatus === 'DUPLICATE')) {
        await (this.db as any).outbox.update(event.id, { status: 'CONFIRMED', error: undefined, updatedAt: new Date().toISOString() });
        assertSyncSessionCurrent(snapshot);
        return;
      }

      const conflict = response.status === 409 || resultStatus === 'CONFLICT' || body.errorType === 'CONFLICT';
      const rejected = [400,401,403].includes(response.status) ||
        ['REJECTED','UNAUTHORIZED','INVALID','FAILED'].includes(resultStatus) ||
        ['SCHEMA_VERSION_MISMATCH','DEVICE_REVOKED'].includes(body.errorCode);
      await (this.db as any).outbox.update(event.id, {
        status: conflict ? 'CONFLICT' : rejected ? 'FAILED' : 'RETRYING',
        error: result?.message || result?.conflict?.message || body.message || body.error || `Unexpected sync response (HTTP ${response.status}, result ${resultStatus || 'missing'})`,
        updatedAt: new Date().toISOString()
      });
      assertSyncSessionCurrent(snapshot);
    } catch (error: any) {
      if (!isSyncSessionCurrent(snapshot)) return;
      await (this.db as any).outbox.update(event.id, {
        status: 'RETRYING', error: error?.message || 'Network Error', updatedAt: new Date().toISOString()
      });
    }
  }

  private async processMutationWithRetry(mutation: LocalSyncQueueItem): Promise<void> {
    const snapshot = readSyncSessionSnapshot();
    if (!snapshot || !mutation.id || mutation.tenantId !== snapshot.tenantId ||
        ((mutation as any).userId && (mutation as any).userId !== snapshot.userId)) return;
    assertSyncSessionCurrent(snapshot);
    await this.db.syncQueue.update(mutation.id, { syncStatus: 'PROCESSING', updatedAt: new Date() });
    assertSyncSessionCurrent(snapshot);
    let delay: number = SYNC_CONFIG.BACKOFF_INITIAL_DELAY_MS;
    const device = DeviceManager.getDeviceIdentity();
    const send = async (): Promise<Response> => {
      assertSyncSessionCurrent(snapshot);
      const response = await unifiedTransport.request<Response>({
        url: this.getApiUrl('/api/v1/sync/push'), method: 'POST', profile: 'SYNC', raw: true,
        headers: {
          'X-Tenant-ID': snapshot.tenantId, 'X-Branch-ID': mutation.branchId || snapshot.branchId || '',
          'X-User-ID': snapshot.userId, 'X-Device-ID': device.deviceId,
          'X-Session-ID': (mutation as any).sessionId || 'local-session',
          'X-Correlation-ID': mutation.correlationId || 'local-correlation'
        },
        body: {
          tenantId: snapshot.tenantId, branchId: mutation.branchId || snapshot.branchId,
          userId: snapshot.userId, deviceId: device.deviceId,
          schemaVersion: SYNC_PROTOCOL_VERSION, clientVersion: CLIENT_VERSION,
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
      assertSyncSessionCurrent(snapshot);
      return response;
    };

    while (mutation.retryCount <= SYNC_CONFIG.MAX_RETRY_ATTEMPTS) {
      try {
        let response = await send();
        if (response.status === 401 && typeof navigator !== 'undefined' && navigator.onLine) {
          await TokenProvider.refreshAccessToken();
          acceptRefreshedSyncToken(snapshot);
          response = await send();
        }
        assertSyncSessionCurrent(snapshot);
        const body = typeof response.json === 'function' ? await response.json().catch(() => ({})) : {};
        assertSyncSessionCurrent(snapshot);
        const result = Array.isArray(body.results)
          ? body.results.find((item: any) => item?.mutationId === mutation.mutationId || item?.id === mutation.mutationId) || body.results[0]
          : undefined;
        const resultStatus = String(result?.status || '').toUpperCase();

        if (response.ok && (resultStatus === 'SUCCESS' || resultStatus === 'DUPLICATE')) {
          await this.db.syncQueue.delete(mutation.id);
          assertSyncSessionCurrent(snapshot);
          if ((this.db as any).outbox) {
            const matching = await (this.db as any).outbox.where('mutationId').equals(mutation.mutationId)
              .and((item: any) => item.tenantId === snapshot.tenantId && (!item.userId || item.userId === snapshot.userId))
              .first().catch(() => null);
            assertSyncSessionCurrent(snapshot);
            if (matching) await (this.db as any).outbox.update(matching.id, { status: 'CONFIRMED', error: undefined, updatedAt: new Date().toISOString() });
            assertSyncSessionCurrent(snapshot);
          }
          const entityId = (mutation.payload as any)?.id;
          if (entityId) {
            const table = String(mutation.entityType).toUpperCase() === 'PRODUCT' ? (this.db as any).products :
              ['SALE','INVOICE'].includes(String(mutation.entityType).toUpperCase()) ? (this.db as any).invoices : null;
            if (table) {
              assertSyncSessionCurrent(snapshot);
              await table.update(entityId, { is_synced: 1, isSynced: true, syncStatus: 'SYNCED', updatedAt: new Date().toISOString() }).catch(() => null);
              assertSyncSessionCurrent(snapshot);
            }
          }
          return;
        }
        if (response.status === 409 || resultStatus === 'CONFLICT' || body.errorType === 'CONFLICT') {
          const conflict = result?.conflict || body;
          await this.handleConflict(mutation, conflict.message || result?.message || 'تعارض في مزامنة السجل مع الخادم', snapshot);
          return;
        }
        if ([400,401,403].includes(response.status) ||
            ['REJECTED','UNAUTHORIZED','INVALID','FAILED'].includes(resultStatus) ||
            body.errorCode === 'SCHEMA_VERSION_MISMATCH' || body.errorCode === 'DEVICE_REVOKED') {
          await this.db.syncQueue.update(mutation.id, {
            syncStatus: 'REJECTED',
            lastError: body.message || `Rejected by server with code ${body.errorCode || response.status}`,
            updatedAt: new Date()
          });
          assertSyncSessionCurrent(snapshot);
          return;
        }
        throw new Error(`Server returned status: ${response.status}`);
      } catch (error: any) {
        if (!isSyncSessionCurrent(snapshot)) return;
        mutation.retryCount++;
        const dead = mutation.retryCount > SYNC_CONFIG.MAX_RETRY_ATTEMPTS;
        assertSyncSessionCurrent(snapshot);
        await this.db.syncQueue.update(mutation.id, {
          retryCount: mutation.retryCount, syncStatus: dead ? 'FAILED' : 'RETRY_PENDING',
          lastError: error?.message || 'Sync network/processing failure', updatedAt: new Date()
        });
        assertSyncSessionCurrent(snapshot);
        if (dead) {
          await this.db.failedMutations.add({
            mutationId: mutation.mutationId,
            reason: `DEAD_LETTER_MAX_RETRIES_EXCEEDED: ${error?.message || 'Network error'}`,
            payload: mutation.payload, tenantId: mutation.tenantId,
            branchId: mutation.branchId, createdAt: new Date()
          }).catch(() => undefined);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, delay + Math.random() * 200));
        if (!isSyncSessionCurrent(snapshot)) return;
        delay = Math.min(delay * 2, SYNC_CONFIG.BACKOFF_MAX_DELAY_MS);
      }
    }
  }

  private async handleConflict(mutation: LocalSyncQueueItem, reason: string, snapshot: SyncSessionSnapshot): Promise<void> {
    assertSyncSessionCurrent(snapshot);
    await this.db.transaction('rw', [this.db.syncQueue, this.db.failedMutations], async () => {
      assertSyncSessionCurrent(snapshot);
      await this.db.failedMutations.add({
        mutationId: mutation.mutationId, reason, payload: mutation.payload,
        tenantId: mutation.tenantId, branchId: mutation.branchId, createdAt: new Date()
      });
      assertSyncSessionCurrent(snapshot);
      await this.db.syncQueue.update(mutation.id!, { syncStatus: 'CONFLICT', updatedAt: new Date() });
      assertSyncSessionCurrent(snapshot);
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
