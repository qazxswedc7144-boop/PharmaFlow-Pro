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
  const offlineOnly = Boolean(user?.offlineOnly);
  if (!session?.isAuthenticated || !session?.token || offlineOnly || session.token === 'local-admin-token' || !tenantId || !userId) {
    return null;
  }
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

function createMutationId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('SYNC_CRYPTO_UNAVAILABLE: Secure mutation ID generation is required.');
  }
  return crypto.randomUUID();
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
  private serverConfirmedPendingLocalCommit = new Map<string, {
    tenantId: string;
    userId: string;
    mutationId: string;
    idempotencyKey?: string;
    queueId?: number;
    outboxId?: number;
    entityType?: string;
    payload?: Record<string, unknown>;
  }>();

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

    // Register device identity in background only when an authenticated online session is active
    if (readSyncSessionSnapshot()) {
      DeviceManager.registerWithServer().catch(() => {});
    }

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

    if (!readSyncSessionSnapshot()) {
      this.updateState('IDLE');
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

  private resolveExistingIdempotency(
    queueRecord: any,
    outboxRecord: any,
    tenantId: string,
    userId: string,
    idempotencyKey: string,
    requireOutbox: boolean
  ): { mutationId: string; idempotencyKey: string; queueItemId?: number } | undefined {
    if (!queueRecord && !outboxRecord) return undefined;

    for (const [source, record] of [['syncQueue', queueRecord], ['outbox', outboxRecord]] as const) {
      if (!record) continue;
      if (record.tenantId !== tenantId || record.userId !== userId) {
        throw new Error('SYNC_IDEMPOTENCY_OWNER_MISMATCH: Existing ' + source + ' record is not owned by the active tenant/user.');
      }
    }

    if (requireOutbox && queueRecord && !outboxRecord) {
      throw new Error('SYNC_IDEMPOTENCY_RECONCILIATION_REQUIRED: Queue record has no matching outbox event; automatic repair is blocked.');
    }
    if (requireOutbox && outboxRecord && !queueRecord) {
      const terminalOutboxStatuses = new Set(['CONFIRMED', 'COMPLETED', 'SUCCESS', 'DUPLICATE']);
      if (!terminalOutboxStatuses.has(String(outboxRecord.status || '').toUpperCase())) {
        throw new Error('SYNC_IDEMPOTENCY_RECONCILIATION_REQUIRED: Active outbox event has no matching queue record; automatic repair is blocked.');
      }
    }
    if (queueRecord && outboxRecord && queueRecord.mutationId !== outboxRecord.mutationId) {
      throw new Error('SYNC_IDEMPOTENCY_RECONCILIATION_REQUIRED: Queue/outbox mutation IDs do not match.');
    }

    const existingMutationId = queueRecord?.mutationId || outboxRecord?.mutationId;
    if (!existingMutationId) {
      throw new Error('SYNC_IDEMPOTENCY_RECONCILIATION_REQUIRED: Existing idempotency record has no mutation ID.');
    }

    return {
      mutationId: existingMutationId,
      idempotencyKey,
      queueItemId: queueRecord?.id
    };
  }

  /**
   * Atomic Outbox / Queue Enqueue (Primary Entry Point for Mutations)
   */
  public async enqueue(
    type: string, 
    payload: Record<string, unknown>, 
    entityType: string = 'generic', 
    customIdempotencyKey?: string,
    options?: { tenantId?: string; branchId?: string; requireOutbox?: boolean }
  ): Promise<{ mutationId: string; idempotencyKey: string; queueItemId?: number }> {
    const mutationId = createMutationId();
    const timestamp = new Date().toISOString();
    const session = readSyncSessionSnapshot();
    if (!session) {
      throw new Error('TRUSTED_USER_CONTEXT_REQUIRED: An authenticated user/token identity is required for sync enqueue.');
    }

    const tenantId = options?.tenantId || session.tenantId;
    const branchId = options?.branchId || session.branchId;

    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    const forbiddenBranches = ['BR-MAIN', 'branch_default', 'default'];

    if (tenantId !== session.tenantId) {
      throw new Error('TRUSTED_TENANT_CONTEXT_MISMATCH: Sync enqueue tenant must match the active authenticated session.');
    }
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
      operation: type,
      payload: sanitizedPayload,
      status: 'PENDING',
      retries: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      idempotencyKey,
      entityType
    };

    const outboxTable = (this.db as any).outbox;
    const hasOutbox = Boolean(outboxTable && outboxTable.schema);
    if (options?.requireOutbox && !hasOutbox) {
      throw new Error('SYNC_OUTBOX_REQUIRED: This operation requires a durable outbox table.');
    }
    const txTables = [this.db.syncQueue];
    if (hasOutbox) txTables.push(outboxTable);

    let result: { mutationId: string; idempotencyKey: string; queueItemId?: number } | undefined;
    try {
      await (this.db as any).transaction('rw', txTables, async () => {
        const existingQueue = await this.db.syncQueue
          .where('idempotencyKey')
          .equals(idempotencyKey)
          .first();
        const existingOutbox = hasOutbox
          ? await outboxTable.where('idempotencyKey').equals(idempotencyKey).first()
          : undefined;

        result = this.resolveExistingIdempotency(
          existingQueue,
          existingOutbox,
          tenantId,
          session.userId!,
          idempotencyKey,
          hasOutbox
        );
        if (result) return;

        const queueItemId = await this.db.syncQueue.add(queueItem);
        if (hasOutbox) await outboxTable.add(outboxEvent);
        result = { mutationId, idempotencyKey, queueItemId };
      });
    } catch (error: any) {
      const isConstraintError = error?.name === 'ConstraintError' || error instanceof Dexie.ConstraintError;
      if (!isConstraintError) throw error;

      const existingQueue = await this.db.syncQueue
        .where('idempotencyKey')
        .equals(idempotencyKey)
        .first();
      const existingOutbox = hasOutbox
        ? await outboxTable.where('idempotencyKey').equals(idempotencyKey).first()
        : undefined;
      result = this.resolveExistingIdempotency(
        existingQueue,
        existingOutbox,
        tenantId,
        session.userId!,
        idempotencyKey,
        hasOutbox
      );
      if (!result) throw error;
    }

    if (!result) {
      throw new Error('SYNC_ENQUEUE_FAILED: No queue record was created or safely reused.');
    }

    if (typeof navigator !== 'undefined' && navigator.onLine) {
      this.requestSync().catch(() => {});
    }

    return result;
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
    const mutationId = createMutationId();
    const timestamp = new Date().toISOString();
    const session = readSyncSessionSnapshot();
    if (!session) {
      throw new Error('TRUSTED_USER_CONTEXT_REQUIRED: An authenticated user/token identity is required for transactional sync enqueue.');
    }

    const tenantId = options?.tenantId || session.tenantId;
    const branchId = options?.branchId || session.branchId;

    const forbiddenTenants = ['TEN-DEV-001', 'tenant_default', 'default', 'default-tenant'];
    const forbiddenBranches = ['BR-MAIN', 'branch_default', 'default'];

    if (tenantId !== session.tenantId) {
      throw new Error('TRUSTED_TENANT_CONTEXT_MISMATCH: Sync enqueue tenant must match the active authenticated session.');
    }
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
      userId: session.userId,
      branchId,
      deviceId: DeviceManager.getDeviceIdentity().deviceId,
      type,
      operation: type,
      payload: sanitizedPayload,
      status: 'PENDING',
      retries: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      idempotencyKey,
      entityType
    };

    const currentTx = (Dexie as any).currentTransaction;
    const outboxTable = (this.db as any).outbox;
    const transactionHasTable = (tableName: string): boolean => Boolean(
      currentTx?.tables?.[tableName] ||
      (currentTx?.tables instanceof Map && currentTx.tables.has(tableName)) ||
      (Array.isArray(currentTx?.tables) && currentTx.tables.some((table: any) => table === tableName || table?.name === tableName)) ||
      (Array.isArray(currentTx?.storeNames) && currentTx.storeNames.includes(tableName))
    );
    if (
      !currentTx ||
      !transactionHasTable('syncQueue') ||
      !transactionHasTable('outbox') ||
      !outboxTable?.schema
    ) {
      const diagnostic = {
        hasTransaction: Boolean(currentTx),
        tablesType: typeof currentTx?.tables,
        tablesIsArray: Array.isArray(currentTx?.tables),
        tableKeys: currentTx?.tables ? Object.keys(currentTx.tables) : [],
        tableNames: Array.isArray(currentTx?.tables) ? currentTx.tables.map((table: any) => table?.name ?? table) : [],
        storeNames: currentTx?.storeNames || []
      };
      console.warn('[DistributedSyncEngine] Transaction scope diagnostic:', diagnostic);
      throw new Error(`SYNC_TRANSACTION_SCOPE_MISSING: enqueueWithinTransaction requires an active Dexie transaction containing syncQueue and outbox. ${JSON.stringify(diagnostic)}`);
    }

    const existingQueue = await this.db.syncQueue
      .where('idempotencyKey')
      .equals(idempotencyKey)
      .first();
    const existingOutbox = await outboxTable.where('idempotencyKey').equals(idempotencyKey).first();
    const existingResult = this.resolveExistingIdempotency(
      existingQueue,
      existingOutbox,
      tenantId,
      session.userId!,
      idempotencyKey,
      true
    );
    if (existingResult) return existingResult;

    const addedId = await this.db.syncQueue.add(queueItem);
    await outboxTable.add(outboxEvent);

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

  private getOutboxTable(): any | null {
    const outboxTable = (this.db as any).outbox;
    return outboxTable && outboxTable.schema ? outboxTable : null;
  }

  private getQueueOutboxTxTables(includeFailedMutations = false): any[] {
    const tables: any[] = [];
    if (this.db.syncQueue) tables.push(this.db.syncQueue);
    const outboxTable = this.getOutboxTable();
    if (outboxTable) tables.push(outboxTable);
    if (includeFailedMutations && this.db.failedMutations) tables.push(this.db.failedMutations);
    return tables;
  }

  private getServerConfirmedKey(snapshot: SyncSessionSnapshot, mutationId: string): string {
    return `${snapshot.tenantId}:${snapshot.userId}:${mutationId}`;
  }

  private async findRecordByMutationIdWithOwnerCheck(
    table: any,
    tableName: 'syncQueue' | 'outbox',
    mutationId: string,
    snapshot: SyncSessionSnapshot
  ): Promise<any | undefined> {
    if (!table || !mutationId) return undefined;
    const matches = await table.where('mutationId').equals(mutationId).toArray();
    assertSyncSessionCurrent(snapshot);
    if (!matches.length) return undefined;

    for (const record of matches) {
      if (record.tenantId !== snapshot.tenantId || record.userId !== snapshot.userId) {
        throw new Error(
          `SYNC_PAIR_OWNER_MISMATCH: Existing ${tableName} record for mutation ${mutationId} is not owned by the active tenant/user.`
        );
      }
    }

    if (matches.length > 1) {
      throw new Error(
        `SYNC_PAIR_DUPLICATE_MUTATION: Multiple ${tableName} records found for mutation ${mutationId}.`
      );
    }

    return matches[0];
  }

  private assertPairConsistency(
    queueRecord: LocalSyncQueueItem | undefined,
    outboxRecord: any | undefined,
    snapshot: SyncSessionSnapshot,
    expected?: { mutationId?: string; idempotencyKey?: string }
  ): void {
    for (const [source, record] of [['syncQueue', queueRecord], ['outbox', outboxRecord]] as const) {
      if (!record) continue;
      if (record.tenantId !== snapshot.tenantId || record.userId !== snapshot.userId) {
        throw new Error(
          `SYNC_PAIR_OWNER_MISMATCH: ${source} record is not owned by the active tenant/user.`
        );
      }
      if (expected?.mutationId && record.mutationId !== expected.mutationId) {
        throw new Error(
          `SYNC_PAIR_MUTATION_MISMATCH: ${source} mutationId does not match expected mutation ${expected.mutationId}.`
        );
      }
      if (expected?.idempotencyKey && record.idempotencyKey && record.idempotencyKey !== expected.idempotencyKey) {
        throw new Error(
          `SYNC_PAIR_IDEMPOTENCY_MISMATCH: ${source} idempotencyKey does not match expected key.`
        );
      }
    }

    if (queueRecord && outboxRecord) {
      if (queueRecord.mutationId !== outboxRecord.mutationId) {
        throw new Error('SYNC_PAIR_MUTATION_MISMATCH: syncQueue and outbox mutationId values do not match.');
      }
      if (queueRecord.tenantId !== outboxRecord.tenantId || queueRecord.userId !== outboxRecord.userId) {
        throw new Error('SYNC_PAIR_OWNER_MISMATCH: syncQueue and outbox owner fields do not match.');
      }
      if (
        (queueRecord.idempotencyKey || outboxRecord.idempotencyKey) &&
        queueRecord.idempotencyKey !== outboxRecord.idempotencyKey
      ) {
        throw new Error('SYNC_PAIR_IDEMPOTENCY_MISMATCH: syncQueue and outbox idempotencyKey values do not match.');
      }
    }
  }

  private async applyAtomicPairTransition(options: {
    snapshot: SyncSessionSnapshot;
    mutationId?: string;
    idempotencyKey?: string;
    queueId?: number;
    outboxId?: number;
    queueAction?: { type: 'delete' } | { type: 'update'; patch: Record<string, unknown> };
    outboxAction?: { type: 'update'; patch: Record<string, unknown> };
    failedMutationRecord?: {
      mutationId: string;
      reason: string;
      payload: any;
      tenantId?: string;
      branchId?: string | null;
      createdAt: Date;
    };
    requireAtLeastOne?: boolean;
  }): Promise<{ queueAffected: boolean; outboxAffected: boolean }> {
    const outboxTable = this.getOutboxTable();
    const txTables = this.getQueueOutboxTxTables(Boolean(options.failedMutationRecord));
    if (!txTables.length) {
      throw new Error('SYNC_STORAGE_UNAVAILABLE: No syncQueue or outbox table available for atomic transition.');
    }

    let queueAffected = false;
    let outboxAffected = false;

    await (this.db as any).transaction('rw', txTables, async () => {
      assertSyncSessionCurrent(options.snapshot);

      let queueRecord: LocalSyncQueueItem | undefined;
      if (this.db.syncQueue) {
        if (options.queueId !== undefined) {
          queueRecord = await this.db.syncQueue.get(options.queueId);
          assertSyncSessionCurrent(options.snapshot);
          if (!queueRecord) {
            throw new Error(`SYNC_QUEUE_RECORD_NOT_FOUND: syncQueue record ${options.queueId} no longer exists.`);
          }
        } else if (options.mutationId) {
          queueRecord = await this.findRecordByMutationIdWithOwnerCheck(
            this.db.syncQueue,
            'syncQueue',
            options.mutationId,
            options.snapshot
          );
        }
      }

      let outboxRecord: any | undefined;
      if (outboxTable) {
        if (options.outboxId !== undefined) {
          outboxRecord = await outboxTable.get(options.outboxId);
          assertSyncSessionCurrent(options.snapshot);
          if (!outboxRecord) {
            throw new Error(`SYNC_OUTBOX_RECORD_NOT_FOUND: outbox record ${options.outboxId} no longer exists.`);
          }
        } else if (options.mutationId) {
          outboxRecord = await this.findRecordByMutationIdWithOwnerCheck(
            outboxTable,
            'outbox',
            options.mutationId,
            options.snapshot
          );
        }
      }

      if (options.requireAtLeastOne && !queueRecord && !outboxRecord) {
        throw new Error(
          `SYNC_MUTATION_NOT_FOUND: No matching syncQueue or outbox record found for mutation ${options.mutationId || 'unknown'}.`
        );
      }

      this.assertPairConsistency(queueRecord, outboxRecord, options.snapshot, {
        mutationId: options.mutationId,
        idempotencyKey: options.idempotencyKey
      });

      const applyOutboxAction = async () => {
        if (!options.outboxAction || !outboxRecord || !outboxTable) return;
        if (options.outboxId === undefined && options.mutationId) {
          await this.updateMatchingOutbox(
            options.mutationId,
            options.snapshot,
            options.outboxAction.patch,
            options.idempotencyKey || queueRecord?.idempotencyKey
          );
          outboxAffected = true;
          return;
        }
        const updatedCount = await outboxTable.update(outboxRecord.id!, options.outboxAction.patch);
        assertSyncSessionCurrent(options.snapshot);
        if (updatedCount !== 1) {
          throw new Error(`SYNC_OUTBOX_UPDATE_FAILED: Expected 1 outbox row updated, got ${updatedCount}.`);
        }
        outboxAffected = true;
      };

      const applyQueueAction = async () => {
        if (!options.queueAction || !queueRecord || !this.db.syncQueue) return;
        if (options.queueAction.type === 'delete') {
          await this.db.syncQueue.delete(queueRecord.id!);
          assertSyncSessionCurrent(options.snapshot);
          queueAffected = true;
          return;
        }
        if (options.queueId === undefined && options.mutationId) {
          await this.updateMatchingSyncQueue(
            options.mutationId,
            options.snapshot,
            options.queueAction.patch,
            options.idempotencyKey || outboxRecord?.idempotencyKey
          );
          queueAffected = true;
          return;
        }
        const updatedCount = await this.db.syncQueue.update(queueRecord.id!, options.queueAction.patch);
        assertSyncSessionCurrent(options.snapshot);
        if (updatedCount !== 1) {
          throw new Error(`SYNC_QUEUE_UPDATE_FAILED: Expected 1 syncQueue row updated, got ${updatedCount}.`);
        }
        queueAffected = true;
      };

      // Never delete a syncQueue item before the paired outbox confirmation update succeeds inside the transaction.
      if (options.queueAction?.type === 'delete') {
        await applyOutboxAction();
        await applyQueueAction();
      } else {
        await applyQueueAction();
        await applyOutboxAction();
      }

      if (options.failedMutationRecord && this.db.failedMutations) {
        await this.db.failedMutations.add({
          ...options.failedMutationRecord,
          tenantId: options.failedMutationRecord.tenantId || options.snapshot.tenantId,
          branchId: options.failedMutationRecord.branchId || options.snapshot.branchId || ''
        });
        assertSyncSessionCurrent(options.snapshot);
      }
    });

    return { queueAffected, outboxAffected };
  }

  private async commitServerConfirmedLocalState(params: {
    snapshot: SyncSessionSnapshot;
    mutationId?: string;
    idempotencyKey?: string;
    queueId?: number;
    outboxId?: number;
    entityType?: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    const confirmedKey = params.mutationId
      ? this.getServerConfirmedKey(params.snapshot, params.mutationId)
      : null;

    if (confirmedKey && params.mutationId) {
      this.serverConfirmedPendingLocalCommit.set(confirmedKey, {
        tenantId: params.snapshot.tenantId,
        userId: params.snapshot.userId,
        mutationId: params.mutationId,
        idempotencyKey: params.idempotencyKey,
        queueId: params.queueId,
        outboxId: params.outboxId,
        entityType: params.entityType,
        payload: params.payload
      });
    }

    await this.applyAtomicPairTransition({
      snapshot: params.snapshot,
      mutationId: params.mutationId,
      idempotencyKey: params.idempotencyKey,
      queueId: params.queueId,
      outboxId: params.outboxId,
      queueAction: { type: 'delete' },
      outboxAction: {
        type: 'update',
        patch: {
          status: 'CONFIRMED',
          error: undefined,
          errorCode: undefined,
          updatedAt: new Date().toISOString()
        }
      }
    });

    if (confirmedKey) {
      this.serverConfirmedPendingLocalCommit.delete(confirmedKey);
    }

    const entityId = (params.payload as any)?.id;
    if (entityId && params.entityType) {
      const table = String(params.entityType).toUpperCase() === 'PRODUCT' ? (this.db as any).products :
        ['SALE', 'INVOICE'].includes(String(params.entityType).toUpperCase()) ? (this.db as any).invoices : null;
      if (table) {
        assertSyncSessionCurrent(params.snapshot);
        await table.update(entityId, {
          is_synced: 1,
          isSynced: true,
          syncStatus: 'SYNCED',
          updatedAt: new Date().toISOString()
        }).catch(() => null);
        assertSyncSessionCurrent(params.snapshot);
      }
    }
  }

  /**
   * Resubmits a failed mutation manually from the dead letter log.
   * Updates paired syncQueue and outbox records atomically in a single Dexie transaction
   * and propagates any failure to the caller instead of swallowing errors.
   */
  public async resubmitFailed(mutationId: string): Promise<void> {
    if (!mutationId || typeof mutationId !== 'string' || !mutationId.trim()) {
      throw new Error('SYNC_RESUBMIT_INVALID_MUTATION_ID: A valid mutationId is required.');
    }

    const snapshot = readSyncSessionSnapshot();
    if (!snapshot) {
      throw new Error('TRUSTED_USER_CONTEXT_REQUIRED: An authenticated user/token identity is required to resubmit a failed mutation.');
    }

    const now = new Date().toISOString();

    try {
      await this.applyAtomicPairTransition({
        snapshot,
        mutationId,
        requireAtLeastOne: true,
        queueAction: {
          type: 'update',
          patch: {
            syncStatus: 'PENDING',
            retryCount: 0,
            errorCode: undefined,
            lastError: undefined,
            updatedAt: now
          }
        },
        outboxAction: {
          type: 'update',
          patch: {
            status: 'PENDING',
            retries: 0,
            errorCode: undefined,
            error: undefined,
            updatedAt: now
          }
        }
      });

      if (typeof navigator !== 'undefined' && navigator.onLine) {
        this.requestSync().catch(() => {});
      }
    } catch (e) {
      console.error('[DistributedSyncEngine] Failed to resubmit mutation:', e);
      throw e;
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

    const snapshot = readSyncSessionSnapshot();
    if (!snapshot) return;

    try {
      const session = getCurrentUserSession();
      const tenantId = snapshot.tenantId || session.tenantId;
      const branchId = snapshot.branchId || session.branchId;
      const userId = snapshot.userId || session.userId;
      const device = DeviceManager.getDeviceIdentity();

      const executePullFetch = async (): Promise<Response> => {
        return await unifiedTransport.request<Response>({
          url: this.getApiUrl('/api/v1/sync/pull'),
          method: 'POST',
          profile: 'SYNC',
          raw: true,
          headers: { 
            'X-Tenant-ID': tenantId || '',
            'X-Branch-ID': branchId || '',
            'X-User-ID': userId || '',
            'X-Device-ID': device.deviceId
          },
          body: { 
            tenantId,
            branchId,
            userId,
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
      // Reconcile any mutations already confirmed by the server whose local Dexie commit previously failed
      // without issuing duplicate HTTP push requests.
      for (const [, pending] of Array.from(this.serverConfirmedPendingLocalCommit.entries())) {
        if (pending.tenantId !== snapshot.tenantId || pending.userId !== snapshot.userId) continue;
        assertSyncSessionCurrent(snapshot);
        await this.commitServerConfirmedLocalState({
          snapshot,
          mutationId: pending.mutationId,
          idempotencyKey: pending.idempotencyKey,
          queueId: pending.queueId,
          outboxId: pending.outboxId,
          entityType: pending.entityType,
          payload: pending.payload
        });
      }

      const outboxTable = this.getOutboxTable();

      if (this.db.syncQueue) {
        const processing = await this.db.syncQueue.where('syncStatus').equals('PROCESSING').toArray();
        assertSyncSessionCurrent(snapshot);
        for (const item of processing) {
          const updatedAt = new Date(item.updatedAt || item.createdAt || 0).getTime();
          if (item.tenantId === snapshot.tenantId && item.userId === snapshot.userId &&
              Number.isFinite(updatedAt) && updatedAt < staleBefore) {
            assertSyncSessionCurrent(snapshot);
            const nowIso = new Date().toISOString();
            const txTables = this.getQueueOutboxTxTables(false);
            await (this.db as any).transaction('rw', txTables, async () => {
              assertSyncSessionCurrent(snapshot);
              const queueRow = await this.db.syncQueue.get(item.id!);
              if (!queueRow || queueRow.syncStatus !== 'PROCESSING') return;
              const outboxRow = outboxTable && queueRow.mutationId
                ? await this.findRecordByMutationIdWithOwnerCheck(outboxTable, 'outbox', queueRow.mutationId, snapshot)
                : undefined;
              this.assertPairConsistency(queueRow, outboxRow, snapshot, {
                mutationId: queueRow.mutationId,
                idempotencyKey: queueRow.idempotencyKey
              });
              await this.db.syncQueue.update(queueRow.id!, { syncStatus: 'PENDING', updatedAt: new Date() });
              if (outboxRow && String(outboxRow.status || '').toUpperCase() === 'SENDING') {
                await outboxTable.update(outboxRow.id!, { status: 'PENDING', updatedAt: nowIso });
              }
              assertSyncSessionCurrent(snapshot);
            });
          }
        }
        const batch = await this.db.syncQueue.where('syncStatus').anyOf('PENDING', 'RETRY_PENDING').toArray();
        assertSyncSessionCurrent(snapshot);
        const eligible = batch.filter(item => item.tenantId === snapshot.tenantId &&
          item.userId === snapshot.userId)
          .sort((a,b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime())
          .slice(0, SYNC_CONFIG.BATCH_CHUNK_SIZE);
        for (const mutation of eligible) {
          assertSyncSessionCurrent(snapshot);
          await this.processMutationWithRetry(mutation);
          if (!isSyncSessionCurrent(snapshot)) break;
        }
      }

      assertSyncSessionCurrent(snapshot);
      if (outboxTable) {
        const sending = await outboxTable.where('status').equals('SENDING').toArray();
        assertSyncSessionCurrent(snapshot);
        for (const event of sending) {
          const updatedAt = new Date(event.updatedAt || event.createdAt || 0).getTime();
          if (event.tenantId === snapshot.tenantId && event.userId === snapshot.userId &&
              Number.isFinite(updatedAt) && updatedAt < staleBefore) {
            assertSyncSessionCurrent(snapshot);
            await outboxTable.update(event.id, { status: 'PENDING', updatedAt: new Date().toISOString() });
            assertSyncSessionCurrent(snapshot);
          }
        }
        const events = await outboxTable.where('status').anyOf('PENDING', 'pending', 'RETRYING').toArray();
        assertSyncSessionCurrent(snapshot);
        for (const event of events) {
          if (event.tenantId !== snapshot.tenantId || event.userId !== snapshot.userId) continue;
          assertSyncSessionCurrent(snapshot);
          // Do not double-dispatch an outbox event that is already owned by an active/terminal syncQueue row.
          if (event.mutationId && this.db.syncQueue) {
            const existingQueue = await this.findRecordByMutationIdWithOwnerCheck(
              this.db.syncQueue,
              'syncQueue',
              event.mutationId,
              snapshot
            );
            if (existingQueue) continue;
          }
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

  private isPermanentRejectionResponse(
    httpStatus: number,
    resultStatus: string,
    errorCode?: string,
    bodyErrorCode?: string
  ): boolean {
    const permanentHttpStatuses = [400, 401, 403, 404, 422, 423];
    const permanentResultStatuses = ['REJECTED', 'UNAUTHORIZED', 'INVALID', 'FAILED'];
    const permanentErrorCodes = [
      'ACCOUNTING_PERIOD_LOCKED',
      'ACCOUNTING_PERIOD_NOT_CONFIGURED',
      'ACCOUNTING_PERIOD_AMBIGUOUS',
      'SCHEMA_VERSION_MISMATCH',
      'DEVICE_REVOKED'
    ];
    return permanentHttpStatuses.includes(httpStatus) ||
      permanentResultStatuses.includes(resultStatus) ||
      (Boolean(errorCode) && permanentErrorCodes.includes(errorCode!)) ||
      (Boolean(bodyErrorCode) && permanentErrorCodes.includes(bodyErrorCode!));
  }

  private isNonRetryableHttpError(error: any): boolean {
    return error?.retryable === false &&
      typeof error?.status === 'number' &&
      [400, 401, 403, 404, 422, 423].includes(error.status);
  }

  private extractRejectionDetails(
    response: Response,
    body: any,
    result: any,
    resultStatus: string
  ): { errorCode?: string; message: string } {
    const rawCode = result?.errorCode || body?.errorCode || body?.error;
    const errorCode = typeof rawCode === 'string' && rawCode.trim()
      ? rawCode.trim()
      : undefined;
    const message = result?.message ||
      result?.conflict?.message ||
      body?.message ||
      body?.error ||
      `Rejected by server with code ${errorCode || response.status || resultStatus || 'UNKNOWN'}`;
    return { errorCode, message };
  }

  private async updateMatchingOutbox(
    mutationId: string | undefined,
    snapshot: SyncSessionSnapshot,
    patch: Record<string, unknown>,
    expectedIdempotencyKey?: string
  ): Promise<void> {
    const outboxTable = this.getOutboxTable();
    if (!mutationId || !outboxTable) return;
    const execute = async () => {
      const matching = await this.findRecordByMutationIdWithOwnerCheck(outboxTable, 'outbox', mutationId, snapshot);
      if (!matching || matching.id === undefined) return;
      this.assertPairConsistency(undefined, matching, snapshot, {
        mutationId,
        idempotencyKey: expectedIdempotencyKey
      });
      const updatedCount = await outboxTable.update(matching.id, patch);
      assertSyncSessionCurrent(snapshot);
      if (updatedCount !== 1) {
        throw new Error(`SYNC_OUTBOX_UPDATE_FAILED: Expected 1 outbox row updated, got ${updatedCount}.`);
      }
    };

    if ((Dexie as any).currentTransaction) {
      await execute();
      return;
    }
    await (this.db as any).transaction('rw', [outboxTable], execute);
  }

  private async updateMatchingSyncQueue(
    mutationId: string | undefined,
    snapshot: SyncSessionSnapshot,
    patch: Record<string, unknown>,
    expectedIdempotencyKey?: string
  ): Promise<void> {
    if (!mutationId || !this.db.syncQueue) return;
    const execute = async () => {
      const matching = await this.findRecordByMutationIdWithOwnerCheck(this.db.syncQueue, 'syncQueue', mutationId, snapshot);
      if (!matching || matching.id === undefined) return;
      this.assertPairConsistency(matching, undefined, snapshot, {
        mutationId,
        idempotencyKey: expectedIdempotencyKey
      });
      const updatedCount = await this.db.syncQueue.update(matching.id, patch);
      assertSyncSessionCurrent(snapshot);
      if (updatedCount !== 1) {
        throw new Error(`SYNC_QUEUE_UPDATE_FAILED: Expected 1 syncQueue row updated, got ${updatedCount}.`);
      }
    };

    if ((Dexie as any).currentTransaction) {
      await execute();
      return;
    }
    await (this.db as any).transaction('rw', [this.db.syncQueue], execute);
  }

  private async processOutboxEvent(event: any): Promise<void> {
    const snapshot = readSyncSessionSnapshot();
    if (!snapshot || !event?.id || event.tenantId !== snapshot.tenantId ||
        event.userId !== snapshot.userId) return;

    const outboxTable = this.getOutboxTable();
    if (!outboxTable) return;

    const confirmedKey = event.mutationId
      ? this.getServerConfirmedKey(snapshot, event.mutationId)
      : null;

    // Never re-send if this mutation was already confirmed by the server and only awaits local commit.
    if (confirmedKey && this.serverConfirmedPendingLocalCommit.has(confirmedKey)) {
      await this.commitServerConfirmedLocalState({
        snapshot,
        mutationId: event.mutationId,
        idempotencyKey: event.idempotencyKey,
        outboxId: event.id
      });
      return;
    }

    let response: Response;
    let body: any;
    let result: any;
    let resultStatus: string;

    try {
      assertSyncSessionCurrent(snapshot);
      const device = DeviceManager.getDeviceIdentity();
      await outboxTable.update(event.id, { status: 'SENDING', updatedAt: new Date().toISOString() });
      assertSyncSessionCurrent(snapshot);
      const send = async (): Promise<Response> => {
        assertSyncSessionCurrent(snapshot);
        const res = await unifiedTransport.request<Response>({
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
              operation: event.operation || event.type || 'CREATE',
              payload: event.payload || {},
              idempotencyKey: event.idempotencyKey || event.mutationId || String(event.id),
              timestamp: event.createdAt || Date.now()
            }]
          }
        });
        assertSyncSessionCurrent(snapshot);
        return res;
      };
      response = await send();
      if (response.status === 401 && typeof navigator !== 'undefined' && navigator.onLine) {
        await TokenProvider.refreshAccessToken();
        acceptRefreshedSyncToken(snapshot);
        response = await send();
      }
      assertSyncSessionCurrent(snapshot);
      body = typeof response.json === 'function' ? await response.json().catch(() => ({})) : {};
      assertSyncSessionCurrent(snapshot);
      result = Array.isArray(body.results)
        ? body.results.find((item: any) => item?.mutationId === event.mutationId || item?.id === event.mutationId) || body.results[0]
        : undefined;
      resultStatus = String(result?.status || '').toUpperCase();
    } catch (error: any) {
      if (!isSyncSessionCurrent(snapshot)) return;
      if (this.isNonRetryableHttpError(error)) {
        const errorCode = typeof error?.code === 'string' ? error.code : undefined;
        const message = error?.message || `Rejected by server (HTTP ${error.status})`;
        await this.applyAtomicPairTransition({
          snapshot,
          mutationId: event.mutationId,
          idempotencyKey: event.idempotencyKey,
          outboxId: event.id,
          outboxAction: {
            type: 'update',
            patch: {
              status: 'FAILED',
              errorCode,
              error: message,
              updatedAt: new Date().toISOString()
            }
          },
          queueAction: {
            type: 'update',
            patch: {
              syncStatus: 'REJECTED',
              errorCode,
              lastError: message,
              updatedAt: new Date()
            }
          }
        });
        return;
      }

      const nextRetries = (Number(event.retries) || 0) + 1;
      const exhausted = nextRetries > SYNC_CONFIG.MAX_RETRY_ATTEMPTS;
      const errMessage = error?.message || 'Network Error';
      await this.applyAtomicPairTransition({
        snapshot,
        mutationId: event.mutationId,
        idempotencyKey: event.idempotencyKey,
        outboxId: event.id,
        outboxAction: {
          type: 'update',
          patch: {
            status: exhausted ? 'FAILED' : 'RETRYING',
            retries: nextRetries,
            error: errMessage,
            updatedAt: new Date().toISOString()
          }
        },
        queueAction: {
          type: 'update',
          patch: {
            syncStatus: exhausted ? 'FAILED' : 'RETRY_PENDING',
            retryCount: nextRetries,
            lastError: errMessage,
            updatedAt: new Date()
          }
        }
      });
      return;
    }

    // Handle server response outside the transport catch block so a local Dexie commit failure
    // after server confirmation never degrades into a retry state or triggers a duplicate send.
    if (response.ok && (resultStatus === 'SUCCESS' || resultStatus === 'DUPLICATE')) {
      try {
        await this.commitServerConfirmedLocalState({
          snapshot,
          mutationId: event.mutationId,
          idempotencyKey: event.idempotencyKey,
          outboxId: event.id
        });
      } catch (commitError: any) {
        if (commitError?.message?.includes('SESSION_SWITCH_DETECTED') || !isSyncSessionCurrent(snapshot)) return;
        throw commitError;
      }
      return;
    }

    const { errorCode, message } = this.extractRejectionDetails(response, body, result, resultStatus);
    const conflict = response.status === 409 || resultStatus === 'CONFLICT' || body.errorType === 'CONFLICT';
    if (conflict) {
      await this.applyAtomicPairTransition({
        snapshot,
        mutationId: event.mutationId,
        idempotencyKey: event.idempotencyKey,
        outboxId: event.id,
        outboxAction: {
          type: 'update',
          patch: {
            status: 'CONFLICT',
            errorCode,
            error: message,
            updatedAt: new Date().toISOString()
          }
        },
        queueAction: {
          type: 'update',
          patch: {
            syncStatus: 'CONFLICT',
            errorCode,
            lastError: message,
            updatedAt: new Date()
          }
        }
      });
      return;
    }

    const rejected = this.isPermanentRejectionResponse(response.status, resultStatus, errorCode, body?.errorCode);
    if (rejected) {
      await this.applyAtomicPairTransition({
        snapshot,
        mutationId: event.mutationId,
        idempotencyKey: event.idempotencyKey,
        outboxId: event.id,
        outboxAction: {
          type: 'update',
          patch: {
            status: 'FAILED',
            errorCode,
            error: message,
            updatedAt: new Date().toISOString()
          }
        },
        queueAction: {
          type: 'update',
          patch: {
            syncStatus: 'REJECTED',
            errorCode,
            lastError: message,
            updatedAt: new Date()
          }
        }
      });
      return;
    }

    // Transient server response (e.g. 5xx / 429): bound retries via MAX_RETRY_ATTEMPTS
    const nextRetries = (Number(event.retries) || 0) + 1;
    const exhausted = nextRetries > SYNC_CONFIG.MAX_RETRY_ATTEMPTS;
    await this.applyAtomicPairTransition({
      snapshot,
      mutationId: event.mutationId,
      idempotencyKey: event.idempotencyKey,
      outboxId: event.id,
      outboxAction: {
        type: 'update',
        patch: {
          status: exhausted ? 'FAILED' : 'RETRYING',
          retries: nextRetries,
          errorCode,
          error: message,
          updatedAt: new Date().toISOString()
        }
      },
      queueAction: {
        type: 'update',
        patch: {
          syncStatus: exhausted ? 'FAILED' : 'RETRY_PENDING',
          retryCount: nextRetries,
          errorCode,
          lastError: message,
          updatedAt: new Date()
        }
      }
    });
  }

  private async processMutationWithRetry(mutation: LocalSyncQueueItem): Promise<void> {
    const snapshot = readSyncSessionSnapshot();
    if (!snapshot || !mutation.id || mutation.tenantId !== snapshot.tenantId ||
        mutation.userId !== snapshot.userId) return;

    const confirmedKey = mutation.mutationId
      ? this.getServerConfirmedKey(snapshot, mutation.mutationId)
      : null;

    // Never re-send if this mutation was already confirmed by the server and only awaits local commit.
    if (confirmedKey && this.serverConfirmedPendingLocalCommit.has(confirmedKey)) {
      await this.commitServerConfirmedLocalState({
        snapshot,
        mutationId: mutation.mutationId,
        idempotencyKey: mutation.idempotencyKey,
        queueId: mutation.id,
        entityType: mutation.entityType,
        payload: mutation.payload
      });
      return;
    }

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

    const recordTransientFailureAndWait = async (errorMessage: string): Promise<boolean> => {
      mutation.retryCount++;
      const dead = mutation.retryCount > SYNC_CONFIG.MAX_RETRY_ATTEMPTS;
      assertSyncSessionCurrent(snapshot);
      await this.applyAtomicPairTransition({
        snapshot,
        mutationId: mutation.mutationId,
        idempotencyKey: mutation.idempotencyKey,
        queueId: mutation.id,
        queueAction: {
          type: 'update',
          patch: {
            retryCount: mutation.retryCount,
            syncStatus: dead ? 'FAILED' : 'RETRY_PENDING',
            lastError: errorMessage,
            updatedAt: new Date()
          }
        },
        outboxAction: {
          type: 'update',
          patch: {
            status: dead ? 'FAILED' : 'RETRYING',
            retries: mutation.retryCount,
            error: errorMessage,
            updatedAt: new Date().toISOString()
          }
        },
        failedMutationRecord: dead
          ? {
              mutationId: mutation.mutationId,
              reason: `DEAD_LETTER_MAX_RETRIES_EXCEEDED: ${errorMessage}`,
              payload: mutation.payload,
              tenantId: mutation.tenantId,
              branchId: mutation.branchId,
              createdAt: new Date()
            }
          : undefined
      });
      if (dead) return false;
      await new Promise(resolve => setTimeout(resolve, delay + Math.random() * 200));
      if (!isSyncSessionCurrent(snapshot)) return false;
      delay = Math.min(delay * 2, SYNC_CONFIG.BACKOFF_MAX_DELAY_MS);
      return true;
    };

    while (mutation.retryCount <= SYNC_CONFIG.MAX_RETRY_ATTEMPTS) {
      let response: Response;
      let body: any;
      let result: any;
      let resultStatus: string;

      try {
        response = await send();
        if (response.status === 401 && typeof navigator !== 'undefined' && navigator.onLine) {
          await TokenProvider.refreshAccessToken();
          acceptRefreshedSyncToken(snapshot);
          response = await send();
        }
        assertSyncSessionCurrent(snapshot);
        body = typeof response.json === 'function' ? await response.json().catch(() => ({})) : {};
        assertSyncSessionCurrent(snapshot);
        result = Array.isArray(body.results)
          ? body.results.find((item: any) => item?.mutationId === mutation.mutationId || item?.id === mutation.mutationId) || body.results[0]
          : undefined;
        resultStatus = String(result?.status || '').toUpperCase();
      } catch (error: any) {
        if (!isSyncSessionCurrent(snapshot)) return;
        if (this.isNonRetryableHttpError(error)) {
          const errorCode = typeof error?.code === 'string' ? error.code : undefined;
          const message = error?.message || `Rejected by server (HTTP ${error.status})`;
          await this.applyAtomicPairTransition({
            snapshot,
            mutationId: mutation.mutationId,
            idempotencyKey: mutation.idempotencyKey,
            queueId: mutation.id,
            queueAction: {
              type: 'update',
              patch: {
                syncStatus: 'REJECTED',
                errorCode,
                lastError: message,
                updatedAt: new Date()
              }
            },
            outboxAction: {
              type: 'update',
              patch: {
                status: 'FAILED',
                errorCode,
                error: message,
                updatedAt: new Date().toISOString()
              }
            }
          });
          return;
        }

        const shouldContinue = await recordTransientFailureAndWait(
          error?.message || 'Sync network/processing failure'
        );
        if (!shouldContinue) return;
        continue;
      }

      // Local Dexie commit runs OUTSIDE the transport retry try/catch so a local write failure
      // after server confirmation NEVER triggers a duplicate HTTP retry.
      if (response.ok && (resultStatus === 'SUCCESS' || resultStatus === 'DUPLICATE')) {
        try {
          await this.commitServerConfirmedLocalState({
            snapshot,
            mutationId: mutation.mutationId,
            idempotencyKey: mutation.idempotencyKey,
            queueId: mutation.id,
            entityType: mutation.entityType,
            payload: mutation.payload
          });
        } catch (commitError: any) {
          if (commitError?.message?.includes('SESSION_SWITCH_DETECTED') || !isSyncSessionCurrent(snapshot)) return;
          throw commitError;
        }
        return;
      }

      const { errorCode, message } = this.extractRejectionDetails(response, body, result, resultStatus);

      if (response.status === 409 || resultStatus === 'CONFLICT' || body.errorType === 'CONFLICT') {
        const conflict = result?.conflict || body;
        const conflictReason = conflict.message || result?.message || 'تعارض في مزامنة السجل مع الخادم';
        await this.handleConflict(mutation, conflictReason, snapshot, errorCode);
        return;
      }

      if (this.isPermanentRejectionResponse(response.status, resultStatus, errorCode, body?.errorCode)) {
        await this.applyAtomicPairTransition({
          snapshot,
          mutationId: mutation.mutationId,
          idempotencyKey: mutation.idempotencyKey,
          queueId: mutation.id,
          queueAction: {
            type: 'update',
            patch: {
              syncStatus: 'REJECTED',
              errorCode,
              lastError: message,
              updatedAt: new Date()
            }
          },
          outboxAction: {
            type: 'update',
            patch: {
              status: 'FAILED',
              errorCode,
              error: message,
              updatedAt: new Date().toISOString()
            }
          }
        });
        return;
      }

      const shouldContinue = await recordTransientFailureAndWait(`Server returned status: ${response.status}`);
      if (!shouldContinue) return;
    }
  }

  private async handleConflict(mutation: LocalSyncQueueItem, reason: string, snapshot: SyncSessionSnapshot, errorCode?: string): Promise<void> {
    assertSyncSessionCurrent(snapshot);
    await this.applyAtomicPairTransition({
      snapshot,
      mutationId: mutation.mutationId,
      idempotencyKey: mutation.idempotencyKey,
      queueId: mutation.id,
      queueAction: {
        type: 'update',
        patch: {
          syncStatus: 'CONFLICT',
          errorCode,
          lastError: reason,
          updatedAt: new Date()
        }
      },
      outboxAction: {
        type: 'update',
        patch: {
          status: 'CONFLICT',
          errorCode,
          error: reason,
          updatedAt: new Date().toISOString()
        }
      },
      failedMutationRecord: {
        mutationId: mutation.mutationId,
        reason,
        payload: mutation.payload,
        tenantId: mutation.tenantId,
        branchId: mutation.branchId,
        createdAt: new Date()
      }
    });
  }

  private sanitizePayload(payload: Record<string, unknown> | unknown[] | null | undefined): any {
    if (!payload || typeof payload !== 'object') return payload;

    // Preserve array identity and ordering. Treating an array as an object via
    // spread converts it to {"0": ...}, which silently drops server-side
    // allocation arrays after JSON serialization.
    if (Array.isArray(payload)) {
      return payload
        .filter((value) => typeof value !== 'function')
        .map((value) => value && typeof value === 'object'
          ? this.sanitizePayload(value as Record<string, unknown> | unknown[])
          : value);
    }

    const sanitized: Record<string, unknown> = { ...payload };
    const forbiddenKeys = ['password', 'token', 'apiKey', 'secret', 'credentials'];
    for (const key of Object.keys(sanitized)) {
      if (forbiddenKeys.some(fk => key.toLowerCase().includes(fk))) {
        delete sanitized[key];
      } else if (typeof sanitized[key] === 'function') {
        delete sanitized[key];
      } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
        sanitized[key] = this.sanitizePayload(sanitized[key] as Record<string, unknown> | unknown[]);
      }
    }
    return sanitized;
  }
}
