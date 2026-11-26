import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { db, getCurrentUserSession } from '@/core/db';
import { DistributedSyncEngine } from '@/features/sync/sync.engine';
import { SYNC_CONFIG } from '@/features/sync/sync.constants';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { unifiedTransport } from '@/shared/network/transport/unifiedTransport';

vi.mock('@/core/db', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, getCurrentUserSession: vi.fn() };
});

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: {
    getCurrentSession: vi.fn(),
    refreshAccessToken: vi.fn(),
  },
}));

vi.mock('@/shared/network/transport/unifiedTransport', () => ({
  unifiedTransport: {
    request: vi.fn(),
  },
}));

describe('Phase 1.1 — Sync Queue / Outbox Atomicity & Failure Injection', () => {
  const tenantA = 'tenant-p11-A';
  const tenantB = 'tenant-p11-B';
  const userA = 'user-p11-A';
  const userB = 'user-p11-B';
  const branchA = 'branch-p11-A';
  let engine: DistributedSyncEngine;

  const setSession = (tenantId = tenantA, userId = userA, token = 'p11-token-A') => {
    const session = {
      tenantId,
      userId,
      branchId: branchA,
      isAuthenticated: true,
      token,
      user: { id: userId, tenantId, branchId: branchA },
      roles: ['ADMIN'],
      permissions: ['ALL'],
    };
    (TokenProvider.getCurrentSession as any).mockReturnValue(session);
    (getCurrentUserSession as any).mockReturnValue({ tenantId, userId, branchId: branchA });
  };

  const setOnline = (online: boolean) => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: online, userAgent: 'Vitest Phase1.1' },
    });
  };

  const makeResponse = (
    status: string,
    mutationId: string,
    httpStatus = 200,
    extra: Record<string, unknown> = {}
  ) =>
    ({
      ok: httpStatus >= 200 && httpStatus < 300,
      status: httpStatus,
      json: vi.fn().mockResolvedValue({
        success: status === 'SUCCESS' || status === 'DUPLICATE',
        results: [
          {
            id: mutationId,
            mutationId,
            status,
            success: status === 'SUCCESS' || status === 'DUPLICATE',
            ...extra,
          },
        ],
        ...extra,
      }),
    }) as any;

  const clearSyncStores = async () => {
    if (!db.isOpen()) await db.open();
    const nativeDb = (db as any).backendDB();
    const stores = ['outbox', 'syncQueue', 'sync_queue', 'syncEvents', 'failedMutations', 'invoices', 'products']
      .filter((name) => nativeDb.objectStoreNames.contains(name));
    await new Promise<void>((resolve, reject) => {
      const tx = nativeDb.transaction(stores, 'readwrite');
      stores.forEach((name) => tx.objectStore(name).clear());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    setOnline(false);
    setSession();
    await clearSyncStores();
    engine = new DistributedSyncEngine(db as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. atomically updates syncQueue and outbox on SUCCESS, REJECTED, CONFLICT, terminal FAILED, and resubmitFailed', async () => {
    // 1a. SUCCESS
    const mSuccess = await engine.enqueue('POST', { id: 'inv-ok-1' }, 'SALE', 'idem-ok-1');
    setOnline(true);
    (unifiedTransport.request as any).mockResolvedValueOnce(makeResponse('SUCCESS', mSuccess.mutationId, 200));
    await engine.drainQueue();

    expect(await db.syncQueue.where('mutationId').equals(mSuccess.mutationId).count()).toBe(0);
    expect(await db.outbox.where('mutationId').equals(mSuccess.mutationId).first()).toMatchObject({
      mutationId: mSuccess.mutationId,
      idempotencyKey: 'idem-ok-1',
      tenantId: tenantA,
      userId: userA,
      status: 'CONFIRMED',
    });

    // 1b. Permanent rejection -> resubmitFailed -> SUCCESS
    setOnline(false);
    const mReject = await engine.enqueue('POST', { id: 'inv-rej-1' }, 'SALE', 'idem-rej-1');
    setOnline(true);
    (unifiedTransport.request as any).mockResolvedValueOnce(
      makeResponse('FAILED', mReject.mutationId, 400, {
        errorCode: 'ACCOUNTING_PERIOD_LOCKED',
        message: 'Period closed',
      })
    );
    await engine.drainQueue();

    expect(await db.syncQueue.where('mutationId').equals(mReject.mutationId).first()).toMatchObject({
      syncStatus: 'REJECTED',
      errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      idempotencyKey: 'idem-rej-1',
    });
    expect(await db.outbox.where('mutationId').equals(mReject.mutationId).first()).toMatchObject({
      status: 'FAILED',
      errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      idempotencyKey: 'idem-rej-1',
    });

    setOnline(false);
    await engine.resubmitFailed(mReject.mutationId);

    const resubmittedQueue = await db.syncQueue.where('mutationId').equals(mReject.mutationId).first();
    expect(resubmittedQueue).toMatchObject({
      syncStatus: 'PENDING',
      retryCount: 0,
      idempotencyKey: 'idem-rej-1',
      tenantId: tenantA,
      userId: userA,
    });
    expect(resubmittedQueue?.errorCode).toBeUndefined();

    const resubmittedOutbox = await db.outbox.where('mutationId').equals(mReject.mutationId).first();
    expect(resubmittedOutbox).toMatchObject({
      status: 'PENDING',
      retries: 0,
      idempotencyKey: 'idem-rej-1',
      tenantId: tenantA,
      userId: userA,
    });
    expect(resubmittedOutbox?.errorCode).toBeUndefined();

    // 1c. CONFLICT updates syncQueue, outbox, and failedMutations together
    const mConflict = await engine.enqueue('UPDATE', { id: 'prod-conf-1', version: 2 }, 'PRODUCT', 'idem-conf-1');
    setOnline(true);
    (unifiedTransport.request as any).mockResolvedValueOnce(
      makeResponse('CONFLICT', mConflict.mutationId, 409, { message: 'Version mismatch' })
    );
    await (engine as any).processMutationWithRetry(
      await db.syncQueue.where('mutationId').equals(mConflict.mutationId).first()
    );

    expect(await db.syncQueue.where('mutationId').equals(mConflict.mutationId).first()).toMatchObject({
      syncStatus: 'CONFLICT',
      lastError: 'Version mismatch',
    });
    expect(await db.outbox.where('mutationId').equals(mConflict.mutationId).first()).toMatchObject({
      status: 'CONFLICT',
      error: 'Version mismatch',
    });
    expect(await db.failedMutations.where('mutationId').equals(mConflict.mutationId).count()).toBe(1);
  });

  it('2. rolls back cleanly when syncQueue.update fails inside resubmitFailed without touching outbox', async () => {
    const queued = await engine.enqueue('POST', { id: 'inv-qfail-1' }, 'SALE', 'idem-qfail-1');
    const qBefore = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    const oBefore = await db.outbox.where('mutationId').equals(queued.mutationId).first();

    await db.syncQueue.update(qBefore!.id!, {
      syncStatus: 'REJECTED',
      retryCount: 2,
      errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      lastError: 'Locked',
    });
    await db.outbox.update(oBefore!.id!, {
      status: 'FAILED',
      retries: 2,
      errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      error: 'Locked',
    });

    const queueUpdateSpy = vi
      .spyOn(db.syncQueue, 'update')
      .mockRejectedValueOnce(new Error('INJECTED_SYNC_QUEUE_WRITE_ERROR'));
    const outboxUpdateSpy = vi.spyOn(db.outbox, 'update');

    await expect(engine.resubmitFailed(queued.mutationId)).rejects.toThrow('INJECTED_SYNC_QUEUE_WRITE_ERROR');

    expect(queueUpdateSpy).toHaveBeenCalledTimes(1);
    expect(outboxUpdateSpy).not.toHaveBeenCalled();

    const qAfter = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    const oAfter = await db.outbox.where('mutationId').equals(queued.mutationId).first();
    expect(qAfter).toMatchObject({
      syncStatus: 'REJECTED',
      retryCount: 2,
      errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      lastError: 'Locked',
    });
    expect(oAfter).toMatchObject({
      status: 'FAILED',
      retries: 2,
      errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      error: 'Locked',
    });
  });

  it('3a. proves real Dexie rollback when syncQueue.update succeeds and outbox.update fails inside resubmitFailed', async () => {
    const queued = await engine.enqueue('POST', { id: 'inv-ofail-1' }, 'SALE', 'idem-ofail-1');
    const qRow = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    const oRow = await db.outbox.where('mutationId').equals(queued.mutationId).first();

    await db.syncQueue.update(qRow!.id!, {
      syncStatus: 'REJECTED',
      retryCount: 3,
      errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      lastError: 'Closed period',
    });
    await db.outbox.update(oRow!.id!, {
      status: 'FAILED',
      retries: 3,
      errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      error: 'Closed period',
    });

    const tableProtoUpdate = Object.getPrototypeOf(db.syncQueue).update;
    let queueUpdatedInsideTx = false;
    vi.spyOn(db.syncQueue, 'update').mockImplementation(function (this: any, key: any, changes: any) {
      return tableProtoUpdate.call(this, key, changes).then((count: number) => {
        queueUpdatedInsideTx = count === 1;
        return count;
      });
    } as any);
    vi.spyOn(db.outbox, 'update').mockImplementationOnce((() =>
      Dexie.Promise.reject(new Error('INJECTED_OUTBOX_WRITE_FAILURE'))) as any);

    await expect(engine.resubmitFailed(queued.mutationId)).rejects.toThrow('INJECTED_OUTBOX_WRITE_FAILURE');

    // syncQueue.update genuinely executed inside the transaction, yet Dexie rolled it back completely!
    expect(queueUpdatedInsideTx).toBe(true);
    const qAfter = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    const oAfter = await db.outbox.where('mutationId').equals(queued.mutationId).first();
    expect(qAfter).toMatchObject({
      syncStatus: 'REJECTED',
      retryCount: 3,
      errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      lastError: 'Closed period',
    });
    expect(oAfter).toMatchObject({
      status: 'FAILED',
      retries: 3,
      errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      error: 'Closed period',
    });
  });

  it('3b. proves real Dexie rollback on SUCCESS if syncQueue.delete fails after outbox.update(CONFIRMED)', async () => {
    const queued = await engine.enqueue('POST', { id: 'inv-del-fail-1' }, 'SALE', 'idem-del-fail-1');
    setOnline(true);
    (unifiedTransport.request as any).mockResolvedValueOnce(makeResponse('SUCCESS', queued.mutationId, 200));

    const tableProtoUpdate = Object.getPrototypeOf(db.outbox).update;
    let outboxUpdatedInsideTx = false;
    vi.spyOn(db.outbox, 'update').mockImplementation(function (this: any, key: any, changes: any) {
      return tableProtoUpdate.call(this, key, changes).then((count: number) => {
        outboxUpdatedInsideTx = count === 1;
        return count;
      });
    } as any);
    vi.spyOn(db.syncQueue, 'delete').mockImplementationOnce((() =>
      Dexie.Promise.reject(new Error('INJECTED_QUEUE_DELETE_FAILURE'))) as any);

    const mutation = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    await expect((engine as any).processMutationWithRetry(mutation)).rejects.toThrow('INJECTED_QUEUE_DELETE_FAILURE');

    expect(outboxUpdatedInsideTx).toBe(true);
    // Outbox must NOT remain CONFIRMED because syncQueue.delete failed and aborted the Dexie transaction.
    const qAfter = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    const oAfter = await db.outbox.where('mutationId').equals(queued.mutationId).first();
    expect(qAfter?.syncStatus).toBe('PROCESSING');
    expect(oAfter?.status).toBe('PENDING');
  });

  it('3c. proves real Dexie rollback on CONFLICT if outbox.update fails after syncQueue.update and never leaves orphaned failedMutations', async () => {
    const queued = await engine.enqueue('UPDATE', { id: 'prod-conf-rb' }, 'PRODUCT', 'idem-conf-rb');
    setOnline(true);
    (unifiedTransport.request as any).mockResolvedValueOnce(
      makeResponse('CONFLICT', queued.mutationId, 409, { message: 'Conflict detected' })
    );

    vi.spyOn(db.outbox, 'update').mockImplementationOnce((() =>
      Dexie.Promise.reject(new Error('INJECTED_CONFLICT_OUTBOX_FAIL'))) as any);

    const mutation = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    await expect((engine as any).processMutationWithRetry(mutation)).rejects.toThrow('INJECTED_CONFLICT_OUTBOX_FAIL');

    const qAfter = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    const oAfter = await db.outbox.where('mutationId').equals(queued.mutationId).first();
    expect(qAfter?.syncStatus).toBe('PROCESSING');
    expect(oAfter?.status).toBe('PENDING');
    expect(await db.failedMutations.where('mutationId').equals(queued.mutationId).count()).toBe(0);
  });

  it('4. simulates mid-transaction crash/interruption via Dexie transaction abort and preserves prior state intact', async () => {
    const queued = await engine.enqueue('POST', { id: 'inv-abort-1' }, 'SALE', 'idem-abort-1');
    setOnline(true);
    (unifiedTransport.request as any).mockResolvedValueOnce(
      makeResponse('FAILED', queued.mutationId, 423, {
        errorCode: 'ACCOUNTING_PERIOD_LOCKED',
        message: 'Locked period',
      })
    );

    const tableProtoUpdate = Object.getPrototypeOf(db.syncQueue).update;
    vi.spyOn(db.syncQueue, 'update').mockImplementation(function (this: any, key: any, changes: any) {
      return tableProtoUpdate.call(this, key, changes).then((count: number) => {
        // Abort the active Dexie transaction right after syncQueue transitioned to REJECTED (mid-transaction crash)
        if (changes?.syncStatus === 'REJECTED' && (Dexie as any).currentTransaction) {
          (Dexie as any).currentTransaction.abort();
        }
        return count;
      });
    } as any);

    const mutation = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    await expect((engine as any).processMutationWithRetry(mutation)).rejects.toThrow();

    // Entire rejection transaction rolled back cleanly; neither table has partial REJECTED/FAILED state
    const qAfter = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    const oAfter = await db.outbox.where('mutationId').equals(queued.mutationId).first();
    expect(qAfter?.syncStatus).toBe('PROCESSING');
    expect(qAfter?.errorCode).toBeUndefined();
    expect(oAfter?.status).toBe('PENDING');
    expect(oAfter?.errorCode).toBeUndefined();
  });

  it('5. recovers stale PROCESSING mutation after simulated app restart and reconciles cleanly via DUPLICATE with exact mutationId & idempotencyKey', async () => {
    const queued = await engine.enqueue('POST', { id: 'inv-restart-1' }, 'SALE', 'idem-restart-1');
    const qRow = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    const oRow = await db.outbox.where('mutationId').equals(queued.mutationId).first();

    // Simulate process crash while mutation was in PROCESSING/SENDING 10 minutes ago
    const staleDate = new Date(Date.now() - 10 * 60 * 1000);
    await db.syncQueue.update(qRow!.id!, { syncStatus: 'PROCESSING', updatedAt: staleDate });
    await db.outbox.update(oRow!.id!, { status: 'SENDING', updatedAt: staleDate.toISOString() });

    // Instantiate a fresh engine instance (simulating full restart with clean in-memory state)
    const restartedEngine = new DistributedSyncEngine(db as any);
    setOnline(true);
    (unifiedTransport.request as any).mockResolvedValueOnce(makeResponse('DUPLICATE', queued.mutationId, 200));

    await restartedEngine.drainQueue();

    expect(unifiedTransport.request).toHaveBeenCalledTimes(1);
    const sent = (unifiedTransport.request as any).mock.calls[0][0];
    expect(sent.body.mutations[0]).toMatchObject({
      id: queued.mutationId,
      idempotencyKey: 'idem-restart-1',
    });

    expect(await db.syncQueue.where('mutationId').equals(queued.mutationId).count()).toBe(0);
    expect(await db.outbox.where('mutationId').equals(queued.mutationId).first()).toMatchObject({
      mutationId: queued.mutationId,
      idempotencyKey: 'idem-restart-1',
      status: 'CONFIRMED',
    });
  });

  it('6. propagates errors in resubmitFailed without fake success and blocks missing, cross-owner, and idempotencyKey mismatch cases', async () => {
    // 6a. Missing mutation never auto-creates and never succeeds silently
    await expect(engine.resubmitFailed('non-existent-mutation-id')).rejects.toThrow('SYNC_MUTATION_NOT_FOUND');
    expect(await db.syncQueue.count()).toBe(0);
    expect(await db.outbox.count()).toBe(0);

    // 6b. Cross-tenant and cross-user access both fail closed without modifying Tenant A / User A records
    const queued = await engine.enqueue('POST', { id: 'inv-owner-1' }, 'SALE', 'idem-owner-1');
    const qInitial = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    const oInitial = await db.outbox.where('mutationId').equals(queued.mutationId).first();
    await db.syncQueue.update(qInitial!.id!, { syncStatus: 'REJECTED' });
    await db.outbox.update(oInitial!.id!, { status: 'FAILED' });

    setSession(tenantB, userB, 'p11-token-B');
    await expect(engine.resubmitFailed(queued.mutationId)).rejects.toThrow(
      /SYNC_MUTATION_NOT_FOUND|SYNC_PAIR_OWNER_MISMATCH/
    );

    // Same tenant, different user must also fail closed
    setSession(tenantA, userB, 'p11-token-A-userB');
    await expect(engine.resubmitFailed(queued.mutationId)).rejects.toThrow(
      /SYNC_MUTATION_NOT_FOUND|SYNC_PAIR_OWNER_MISMATCH/
    );

    // Verify Tenant A / User A records were untouched
    setSession(tenantA, userA, 'p11-token-A');
    expect((await db.syncQueue.get(qInitial!.id!))?.syncStatus).toBe('REJECTED');
    expect((await db.outbox.get(oInitial!.id!))?.status).toBe('FAILED');

    // 6c. Idempotency key mismatch between syncQueue and outbox is blocked with zero partial write
    const qRow = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    const oRow = await db.outbox.where('mutationId').equals(queued.mutationId).first();
    await db.outbox.update(oRow!.id!, { status: 'FAILED', idempotencyKey: 'tampered-idem-key' });

    await expect(engine.resubmitFailed(queued.mutationId)).rejects.toThrow('SYNC_PAIR_IDEMPOTENCY_MISMATCH');
    expect((await db.syncQueue.get(qRow!.id!))?.syncStatus).toBe('REJECTED');
    expect((await db.outbox.get(oRow!.id!))?.status).toBe('FAILED');
  });

  it('7. preserves exact mutationId and idempotencyKey across transient retry and dead-letter recovery', async () => {
    const queued = await engine.enqueue('POST', { id: 'inv-retry-key-1' }, 'SALE', 'idem-retry-exact-1');
    setOnline(true);

    const originalSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) => {
      return originalSetTimeout(fn, typeof ms === 'number' && ms >= 500 ? 0 : ms, ...args);
    }) as any);

    try {
      (unifiedTransport.request as any)
        .mockRejectedValueOnce(new TypeError('Transient socket drop'))
        .mockResolvedValueOnce(makeResponse('SUCCESS', queued.mutationId, 200));

      await engine.drainQueue();

      expect(unifiedTransport.request).toHaveBeenCalledTimes(2);
      const firstSent = (unifiedTransport.request as any).mock.calls[0][0].body.mutations[0];
      const secondSent = (unifiedTransport.request as any).mock.calls[1][0].body.mutations[0];
      expect(firstSent.id).toBe(queued.mutationId);
      expect(firstSent.idempotencyKey).toBe('idem-retry-exact-1');
      expect(secondSent.id).toBe(queued.mutationId);
      expect(secondSent.idempotencyKey).toBe('idem-retry-exact-1');

      expect(await db.syncQueue.where('mutationId').equals(queued.mutationId).count()).toBe(0);
      expect((await db.outbox.where('mutationId').equals(queued.mutationId).first())?.status).toBe('CONFIRMED');
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('8. NEVER sends a duplicate HTTP request after server returns SUCCESS and local Dexie commit fails', async () => {
    const queued = await engine.enqueue('POST', { id: 'inv-no-dup-1' }, 'SALE', 'idem-no-dup-1');
    setOnline(true);

    (unifiedTransport.request as any).mockResolvedValue(makeResponse('SUCCESS', queued.mutationId, 200));

    // Inject a local IndexedDB write failure on outbox confirmation AFTER server returned 200 SUCCESS
    const outboxUpdateSpy = vi
      .spyOn(db.outbox, 'update')
      .mockRejectedValueOnce(new Error('INJECTED_LOCAL_COMMIT_CRASH'));

    await expect(engine.drainQueue()).rejects.toThrow('INJECTED_LOCAL_COMMIT_CRASH');

    // CRITICAL: Must have sent ONLY ONCE — no HTTP retry inside processMutationWithRetry
    // and no double-dispatch from outbox step in drainQueue.
    expect(unifiedTransport.request).toHaveBeenCalledTimes(1);

    // Local state rolled back cleanly (queue was NOT deleted while outbox failed to confirm)
    const qAfterFail = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    const oAfterFail = await db.outbox.where('mutationId').equals(queued.mutationId).first();
    expect(qAfterFail?.syncStatus).toBe('PROCESSING');
    expect(qAfterFail?.retryCount).toBe(0);
    expect(oAfterFail?.status).toBe('PENDING');

    // Restore local DB health and run drainQueue again -> reconciles locally with ZERO duplicate HTTP send!
    outboxUpdateSpy.mockRestore();
    await engine.drainQueue();

    expect(unifiedTransport.request).toHaveBeenCalledTimes(1);
    expect(await db.syncQueue.where('mutationId').equals(queued.mutationId).count()).toBe(0);
    expect(await db.outbox.where('mutationId').equals(queued.mutationId).first()).toMatchObject({
      mutationId: queued.mutationId,
      idempotencyKey: 'idem-no-dup-1',
      status: 'CONFIRMED',
    });
  });

  it('8b. processOutboxEvent also refuses duplicate HTTP send and does not flip status to RETRYING when local commit fails after server SUCCESS', async () => {
    const outboxId = await db.outbox.add({
      mutationId: 'outbox-only-no-dup-1',
      tenantId: tenantA,
      userId: userA,
      branchId: branchA,
      type: 'CREATE',
      operation: 'CREATE',
      entityType: 'PRODUCT',
      payload: { id: 'prod-nodup-1' },
      status: 'PENDING',
      retries: 0,
      idempotencyKey: 'idem-outbox-nodup-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    setOnline(true);
    (unifiedTransport.request as any).mockResolvedValue(makeResponse('SUCCESS', 'outbox-only-no-dup-1', 200));

    const tableProtoUpdate = Object.getPrototypeOf(db.outbox).update;
    const outboxSpy = vi.spyOn(db.outbox, 'update').mockImplementation(function (this: any, key: any, changes: any) {
      if (changes?.status === 'CONFIRMED') {
        return Dexie.Promise.reject(new Error('INJECTED_OUTBOX_CONFIRM_CRASH'));
      }
      return tableProtoUpdate.call(this, key, changes);
    } as any);

    await expect((engine as any).processOutboxEvent(await db.outbox.get(outboxId))).rejects.toThrow(
      'INJECTED_OUTBOX_CONFIRM_CRASH'
    );

    expect(unifiedTransport.request).toHaveBeenCalledTimes(1);
    // Must stay SENDING, NEVER overwritten to RETRYING
    expect((await db.outbox.get(outboxId))?.status).toBe('SENDING');
    expect((await db.outbox.get(outboxId))?.retries).toBe(0);

    // Next attempt reconciles locally with ZERO duplicate network call
    outboxSpy.mockRestore();
    await (engine as any).processOutboxEvent(await db.outbox.get(outboxId));
    expect(unifiedTransport.request).toHaveBeenCalledTimes(1);
    expect((await db.outbox.get(outboxId))?.status).toBe('CONFIRMED');
  });

  it('9. dead-letter exhaustion updates syncQueue, outbox, and failedMutations atomically (and rolls back all 3 on failure)', async () => {
    const queued = await engine.enqueue('POST', { id: 'inv-dead-1' }, 'SALE', 'idem-dead-1');
    const qRow = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    // Pre-set retryCount to MAX_RETRY_ATTEMPTS so the next failure exhausts retries immediately
    await db.syncQueue.update(qRow!.id!, { retryCount: SYNC_CONFIG.MAX_RETRY_ATTEMPTS });

    setOnline(true);
    (unifiedTransport.request as any).mockRejectedValueOnce(new TypeError('Persistent outage'));
    vi.spyOn(db.outbox, 'update').mockRejectedValueOnce(new Error('INJECTED_DEAD_LETTER_OUTBOX_FAIL'));

    await expect(
      (engine as any).processMutationWithRetry(await db.syncQueue.get(qRow!.id!))
    ).rejects.toThrow('INJECTED_DEAD_LETTER_OUTBOX_FAIL');

    // SyncQueue must NOT be FAILED and failedMutations must have 0 rows because outbox failed
    expect((await db.syncQueue.get(qRow!.id!))?.syncStatus).toBe('PROCESSING');
    expect(await db.failedMutations.where('mutationId').equals(queued.mutationId).count()).toBe(0);
    expect((await db.outbox.where('mutationId').equals(queued.mutationId).first())?.status).toBe('PENDING');
  });

  describe('Phase 1.1 Closure — Task 2: Atomic stale SENDING outbox recovery', () => {
    it('10a. recovers paired stale SENDING outbox and PROCESSING syncQueue atomically inside a single Dexie transaction', async () => {
      const queued = await engine.enqueue('POST', { id: 'inv-stale-send-1' }, 'SALE', 'idem-stale-send-1');
      const qRow = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
      const oRow = await db.outbox.where('mutationId').equals(queued.mutationId).first();

      // Make outbox stale SENDING while syncQueue is PROCESSING with a recent timestamp
      // so Step 1 does not touch syncQueue and Step 2 stale SENDING recovery owns the pair transition.
      const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await db.syncQueue.update(qRow!.id!, { syncStatus: 'PROCESSING', updatedAt: new Date() });
      await db.outbox.update(oRow!.id!, { status: 'SENDING', updatedAt: staleIso });

      setOnline(true);
      await (engine as any).recoverStaleSendingOutboxEvent(oRow!.id!, {
        tenantId: tenantA,
        userId: userA,
        branchId: branchA,
        token: 'p11-token-A',
      });

      expect((await db.syncQueue.get(qRow!.id!))?.syncStatus).toBe('PENDING');
      expect((await db.outbox.get(oRow!.id!))?.status).toBe('PENDING');
    });

    it('10b. proves full Dexie rollback when outbox.update fails after syncQueue.update during paired stale SENDING recovery', async () => {
      const queued = await engine.enqueue('POST', { id: 'inv-stale-send-rb' }, 'SALE', 'idem-stale-send-rb');
      const qRow = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
      const oRow = await db.outbox.where('mutationId').equals(queued.mutationId).first();

      const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      await db.syncQueue.update(qRow!.id!, { syncStatus: 'PROCESSING', updatedAt: new Date() });
      await db.outbox.update(oRow!.id!, { status: 'SENDING', updatedAt: staleIso });

      const tableProtoUpdate = Object.getPrototypeOf(db.syncQueue).update;
      let queueRecoveredInsideTx = false;
      vi.spyOn(db.syncQueue, 'update').mockImplementation(function (this: any, key: any, changes: any) {
        return tableProtoUpdate.call(this, key, changes).then((count: number) => {
          queueRecoveredInsideTx = count === 1;
          return count;
        });
      } as any);
      vi.spyOn(db.outbox, 'update').mockImplementationOnce((() =>
        Dexie.Promise.reject(new Error('INJECTED_STALE_SENDING_OUTBOX_FAIL'))) as any);

      setOnline(true);
      await expect(engine.drainQueue()).rejects.toThrow('INJECTED_STALE_SENDING_OUTBOX_FAIL');

      expect(queueRecoveredInsideTx).toBe(true);
      // Both sides rolled back completely — no partial PENDING/SENDING mismatch
      expect((await db.syncQueue.get(qRow!.id!))?.syncStatus).toBe('PROCESSING');
      expect((await db.outbox.get(oRow!.id!))?.status).toBe('SENDING');
    });

    it('10c. fails closed (SYNC_PAIR_STATE_CONFLICT) when stale SENDING outbox is paired with terminal syncQueue (REJECTED/FAILED/CONFLICT) and vice versa', async () => {
      for (const terminalQueueStatus of ['REJECTED', 'FAILED', 'CONFLICT'] as const) {
        const queued = await engine.enqueue(
          'POST',
          { id: `inv-conflict-${terminalQueueStatus}` },
          'SALE',
          `idem-conflict-${terminalQueueStatus}`
        );
        const qRow = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
        const oRow = await db.outbox.where('mutationId').equals(queued.mutationId).first();

        const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        await db.syncQueue.update(qRow!.id!, { syncStatus: terminalQueueStatus, updatedAt: new Date() });
        await db.outbox.update(oRow!.id!, { status: 'SENDING', updatedAt: staleIso });

        await expect(
          (engine as any).recoverStaleSendingOutboxEvent(oRow!.id!, {
            tenantId: tenantA,
            userId: userA,
            branchId: branchA,
            token: 'p11-token-A',
          })
        ).rejects.toThrow('SYNC_PAIR_STATE_CONFLICT');

        // Neither side was mutated
        expect((await db.syncQueue.get(qRow!.id!))?.syncStatus).toBe(terminalQueueStatus);
        expect((await db.outbox.get(oRow!.id!))?.status).toBe('SENDING');
      }

      // Symmetric check: stale PROCESSING syncQueue paired with terminal CONFIRMED outbox must fail closed
      const queuedConfirmed = await engine.enqueue('POST', { id: 'inv-sym-conf' }, 'SALE', 'idem-sym-conf');
      const qSym = await db.syncQueue.where('mutationId').equals(queuedConfirmed.mutationId).first();
      const oSym = await db.outbox.where('mutationId').equals(queuedConfirmed.mutationId).first();
      await db.syncQueue.update(qSym!.id!, {
        syncStatus: 'PROCESSING',
        updatedAt: new Date(Date.now() - 10 * 60 * 1000),
      });
      await db.outbox.update(oSym!.id!, { status: 'CONFIRMED', updatedAt: new Date().toISOString() });

      await expect(
        (engine as any).recoverStaleProcessingQueueItem(qSym!.id!, {
          tenantId: tenantA,
          userId: userA,
          branchId: branchA,
          token: 'p11-token-A',
        })
      ).rejects.toThrow('SYNC_PAIR_STATE_CONFLICT');

      expect((await db.syncQueue.get(qSym!.id!))?.syncStatus).toBe('PROCESSING');
      expect((await db.outbox.get(oSym!.id!))?.status).toBe('CONFIRMED');
    });

    it('10d. recovers standalone stale SENDING outbox event cleanly without auto-creating a fake syncQueue row, and rolls back on write failure', async () => {
      const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const outboxId = await db.outbox.add({
        mutationId: 'standalone-sending-1',
        tenantId: tenantA,
        userId: userA,
        branchId: branchA,
        type: 'CREATE',
        operation: 'CREATE',
        entityType: 'PRODUCT',
        payload: { id: 'prod-standalone-1' },
        status: 'SENDING',
        retries: 0,
        idempotencyKey: 'idem-standalone-sending-1',
        createdAt: staleIso,
        updatedAt: staleIso,
      } as any);

      // Write failure rolls back and leaves status SENDING
      vi.spyOn(db.outbox, 'update').mockImplementationOnce((() =>
        Dexie.Promise.reject(new Error('INJECTED_STANDALONE_RECOVER_FAIL'))) as any);

      await expect(
        (engine as any).recoverStaleSendingOutboxEvent(outboxId, {
          tenantId: tenantA,
          userId: userA,
          branchId: branchA,
          token: 'p11-token-A',
        })
      ).rejects.toThrow('INJECTED_STANDALONE_RECOVER_FAIL');
      expect((await db.outbox.get(outboxId))?.status).toBe('SENDING');
      expect(await db.syncQueue.count()).toBe(0);

      // Recovery succeeds without creating any synthetic syncQueue row
      await (engine as any).recoverStaleSendingOutboxEvent(outboxId, {
        tenantId: tenantA,
        userId: userA,
        branchId: branchA,
        token: 'p11-token-A',
      });
      expect((await db.outbox.get(outboxId))?.status).toBe('PENDING');
      expect(await db.syncQueue.count()).toBe(0);
    });
  });

  describe('Phase 1.1 Closure — Task 3: Unpaired & Mismatched Records Fail-Closed Matrix', () => {
    const rawPut = async (storeName: 'syncQueue' | 'outbox', record: Record<string, unknown>) => {
      if (!db.isOpen()) await db.open();
      const nativeDb = (db as any).backendDB();
      await new Promise<void>((resolve, reject) => {
        const tx = nativeDb.transaction([storeName], 'readwrite');
        tx.objectStore(storeName).put(record);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    };

    const rawGet = async (storeName: 'syncQueue' | 'outbox', key: number): Promise<any> => {
      if (!db.isOpen()) await db.open();
      const nativeDb = (db as any).backendDB();
      return await new Promise<any>((resolve, reject) => {
        const tx = nativeDb.transaction([storeName], 'readonly');
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    };

    it('11a. syncQueue without outbox fails closed when pair is required (resubmitFailed & requirePair delete) and NEVER auto-creates outbox', async () => {
      const qId = await db.syncQueue.add({
        mutationId: 'queue-only-mut-1',
        tenantId: tenantA,
        userId: userA,
        branchId: branchA,
        deviceId: 'DEV-1',
        entityType: 'SALE',
        operationType: 'POST',
        payload: { id: 'inv-q-only' },
        syncStatus: 'REJECTED',
        retryCount: 1,
        idempotencyKey: 'idem-q-only-1',
        version: 1,
        logicalTimestamp: Date.now(),
        actorId: userA,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);

      // resubmitFailed requires pair -> fails closed, does NOT touch syncQueue, does NOT create outbox
      await expect(engine.resubmitFailed('queue-only-mut-1')).rejects.toThrow('SYNC_PAIR_RECONCILIATION_REQUIRED');
      expect((await db.syncQueue.get(qId))?.syncStatus).toBe('REJECTED');
      expect(await db.outbox.count()).toBe(0);

      // requirePair delete transition must refuse to delete syncQueue when outbox is missing
      await expect(
        (engine as any).applyAtomicPairTransition({
          snapshot: { tenantId: tenantA, userId: userA, branchId: branchA, token: 'p11-token-A' },
          mutationId: 'queue-only-mut-1',
          idempotencyKey: 'idem-q-only-1',
          queueId: qId,
          requirePair: true,
          queueAction: { type: 'delete' },
          outboxAction: { type: 'update', patch: { status: 'CONFIRMED' } },
        })
      ).rejects.toThrow('SYNC_PAIR_RECONCILIATION_REQUIRED');

      expect(await db.syncQueue.get(qId)).toBeDefined();
      expect(await db.outbox.count()).toBe(0);
    });

    it('11b. outbox without syncQueue fails closed in resubmitFailed (requirePair) without creating fake syncQueue, while standalone processOutboxEvent stays intact', async () => {
      const outboxId = await db.outbox.add({
        mutationId: 'outbox-only-mut-1',
        tenantId: tenantA,
        userId: userA,
        branchId: branchA,
        type: 'CREATE',
        operation: 'CREATE',
        entityType: 'PRODUCT',
        payload: { id: 'prod-o-only' },
        status: 'FAILED',
        retries: 1,
        idempotencyKey: 'idem-o-only-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);

      // resubmitFailed requires pair -> fails closed, leaves outbox FAILED, never creates fake syncQueue
      await expect(engine.resubmitFailed('outbox-only-mut-1')).rejects.toThrow('SYNC_PAIR_RECONCILIATION_REQUIRED');
      expect((await db.outbox.get(outboxId))?.status).toBe('FAILED');
      expect(await db.syncQueue.count()).toBe(0);

      // Standalone outbox event dispatched via processOutboxEvent confirms cleanly without creating syncQueue
      await db.outbox.update(outboxId, { status: 'PENDING' });
      setOnline(true);
      (unifiedTransport.request as any).mockResolvedValueOnce(makeResponse('SUCCESS', 'outbox-only-mut-1', 200));
      await (engine as any).processOutboxEvent(await db.outbox.get(outboxId));
      expect((await db.outbox.get(outboxId))?.status).toBe('CONFIRMED');
      expect(await db.syncQueue.count()).toBe(0);
    });

    it('11c. detects mutationId mismatch across syncQueue and outbox sharing the same idempotencyKey and fails closed without deleting syncQueue or leaving an orphan', async () => {
      const sharedIdemKey = 'idem-mut-mismatch-1';
      const qId = await db.syncQueue.add({
        mutationId: 'mut-queue-side-A',
        tenantId: tenantA,
        userId: userA,
        branchId: branchA,
        deviceId: 'DEV-1',
        entityType: 'SALE',
        operationType: 'POST',
        payload: { id: 'inv-mm-1' },
        syncStatus: 'PENDING',
        retryCount: 0,
        idempotencyKey: sharedIdemKey,
        version: 1,
        logicalTimestamp: Date.now(),
        actorId: userA,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);
      const oId = await db.outbox.add({
        mutationId: 'mut-outbox-side-B',
        tenantId: tenantA,
        userId: userA,
        branchId: branchA,
        type: 'POST',
        operation: 'POST',
        entityType: 'SALE',
        payload: { id: 'inv-mm-1' },
        status: 'PENDING',
        retries: 0,
        idempotencyKey: sharedIdemKey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);

      setOnline(true);
      (unifiedTransport.request as any).mockResolvedValueOnce(makeResponse('SUCCESS', 'mut-queue-side-A', 200));

      await expect(
        (engine as any).processMutationWithRetry(await db.syncQueue.get(qId))
      ).rejects.toThrow('SYNC_PAIR_MUTATION_MISMATCH');

      // Neither side deleted or confirmed — zero orphaned outbox left behind
      expect((await db.syncQueue.get(qId))?.syncStatus).toBe('PROCESSING');
      expect((await db.outbox.get(oId))?.status).toBe('PENDING');

      // resubmitFailed also fails closed on mutationId mismatch
      await expect(engine.resubmitFailed('mut-queue-side-A')).rejects.toThrow('SYNC_PAIR_MUTATION_MISMATCH');
      expect((await db.syncQueue.get(qId))?.syncStatus).toBe('PROCESSING');
      expect((await db.outbox.get(oId))?.status).toBe('PENDING');
    });

    it('11d. detects idempotencyKey mismatch on terminal SUCCESS transition and refuses to delete syncQueue or confirm outbox', async () => {
      const queued = await engine.enqueue('POST', { id: 'inv-idem-mm-1' }, 'SALE', 'idem-original-1');
      const qRow = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
      const oRow = await db.outbox.where('mutationId').equals(queued.mutationId).first();

      // Corrupt outbox idempotencyKey while keeping same mutationId
      await db.outbox.update(oRow!.id!, { idempotencyKey: 'idem-divergent-2' });

      setOnline(true);
      (unifiedTransport.request as any).mockResolvedValueOnce(makeResponse('SUCCESS', queued.mutationId, 200));

      await expect(
        (engine as any).processMutationWithRetry(await db.syncQueue.get(qRow!.id!))
      ).rejects.toThrow('SYNC_PAIR_IDEMPOTENCY_MISMATCH');

      // syncQueue was NOT deleted and outbox was NOT confirmed
      expect((await db.syncQueue.get(qRow!.id!))?.syncStatus).toBe('PROCESSING');
      expect((await db.outbox.get(oRow!.id!))?.status).toBe('PENDING');
    });

    it('11e. detects tenantId and userId mismatch directly inside pair consistency checks and fails closed without mutating either record', async () => {
      const queued = await engine.enqueue('POST', { id: 'inv-owner-mm-1' }, 'SALE', 'idem-owner-mm-1');
      const qRow = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
      const oRow = await db.outbox.where('mutationId').equals(queued.mutationId).first();

      // Case 1: Same tenant, mismatched userId on outbox (written directly to native store)
      await rawPut('outbox', { ...oRow, userId: userB });

      setOnline(true);
      (unifiedTransport.request as any).mockResolvedValueOnce(makeResponse('SUCCESS', queued.mutationId, 200));
      await expect(
        (engine as any).processMutationWithRetry(await db.syncQueue.get(qRow!.id!))
      ).rejects.toThrow('SYNC_PAIR_OWNER_MISMATCH');

      expect((await db.syncQueue.get(qRow!.id!))?.syncStatus).toBe('PROCESSING');
      expect((await rawGet('outbox', oRow!.id!))?.status).toBe('PENDING');

      // Case 2: Mismatched tenantId checked directly in assertPairConsistency
      expect(() =>
        (engine as any).assertPairConsistency(
          qRow,
          { ...oRow, tenantId: tenantB },
          { tenantId: tenantA, userId: userA, branchId: branchA, token: 'p11-token-A' },
          { mutationId: queued.mutationId, idempotencyKey: queued.idempotencyKey }
        )
      ).toThrow('SYNC_PAIR_OWNER_MISMATCH');
    });

    it('11f. fails closed and rolls back completely on silent no-op syncQueue.delete or zero-row outbox/syncQueue updates', async () => {
      // Case 1: Silent no-op delete on syncQueue after outbox.update('CONFIRMED') ran -> rolls back outbox!
      const queued1 = await engine.enqueue('POST', { id: 'inv-noop-del-1' }, 'SALE', 'idem-noop-del-1');
      const q1 = await db.syncQueue.where('mutationId').equals(queued1.mutationId).first();
      const o1 = await db.outbox.where('mutationId').equals(queued1.mutationId).first();

      vi.spyOn(db.syncQueue, 'delete').mockImplementationOnce((() => Dexie.Promise.resolve(undefined)) as any);
      setOnline(true);
      (unifiedTransport.request as any).mockResolvedValueOnce(makeResponse('SUCCESS', queued1.mutationId, 200));

      await expect(
        (engine as any).processMutationWithRetry(await db.syncQueue.get(q1!.id!))
      ).rejects.toThrow('SYNC_QUEUE_DELETE_FAILED');

      expect(await db.syncQueue.get(q1!.id!)).toBeDefined();
      expect((await db.outbox.get(o1!.id!))?.status).toBe('PENDING');

      // Case 2: outbox.update returns 0 affected rows -> aborts transaction and rolls back syncQueue!
      setOnline(false);
      const queued2 = await engine.enqueue('POST', { id: 'inv-zero-upd-1' }, 'SALE', 'idem-zero-upd-1');
      const q2 = await db.syncQueue.where('mutationId').equals(queued2.mutationId).first();
      const o2 = await db.outbox.where('mutationId').equals(queued2.mutationId).first();
      await db.syncQueue.update(q2!.id!, { syncStatus: 'REJECTED' });
      await db.outbox.update(o2!.id!, { status: 'FAILED' });

      vi.spyOn(db.outbox, 'update').mockImplementationOnce((() => Dexie.Promise.resolve(0)) as any);
      await expect(engine.resubmitFailed(queued2.mutationId)).rejects.toThrow('SYNC_OUTBOX_UPDATE_FAILED');
      expect((await db.syncQueue.get(q2!.id!))?.syncStatus).toBe('REJECTED');
      expect((await db.outbox.get(o2!.id!))?.status).toBe('FAILED');

      // Case 3: syncQueue.update returns 0 affected rows -> aborts transaction before touching outbox!
      vi.spyOn(db.syncQueue, 'update').mockImplementationOnce((() => Dexie.Promise.resolve(0)) as any);
      await expect(engine.resubmitFailed(queued2.mutationId)).rejects.toThrow('SYNC_QUEUE_UPDATE_FAILED');
      expect((await db.syncQueue.get(q2!.id!))?.syncStatus).toBe('REJECTED');
      expect((await db.outbox.get(o2!.id!))?.status).toBe('FAILED');
    });
  });
});
