import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getCurrentUserSession } from '@/core/db';
import { DistributedSyncEngine } from '@/features/sync/sync.engine';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { unifiedTransport } from '@/shared/network/transport/unifiedTransport';
import { crashRecoveryManager } from '@/core/observability/crashRecoveryManager';

vi.mock('@/core/db', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, getCurrentUserSession: vi.fn() };
});
vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: { getCurrentSession: vi.fn(), refreshAccessToken: vi.fn() }
}));
vi.mock('@/shared/network/transport/unifiedTransport', () => ({
  unifiedTransport: { request: vi.fn() }
}));

describe('Sync Engine Phase 6 — client lifecycle E2E', () => {
  const tenantA = 'tenant-phase6-A';
  const tenantB = 'tenant-phase6-B';
  const userA = 'user-phase6-A';
  const userB = 'user-phase6-B';
  const branchA = 'branch-phase6-A';
  let engine: DistributedSyncEngine;

  const setSession = (tenantId = tenantA, userId = userA, token = 'phase6-token-A') => {
    const session = {
      tenantId, userId, branchId: branchA, isAuthenticated: true, token,
      user: { id: userId, tenantId, branchId: branchA }, roles: [], permissions: []
    };
    (TokenProvider.getCurrentSession as any).mockReturnValue(session);
    (getCurrentUserSession as any).mockReturnValue({ tenantId, userId, branchId: branchA });
  };

  const response = (status: string, mutationId: string, httpStatus = 200) => ({
    ok: httpStatus >= 200 && httpStatus < 300,
    status: httpStatus,
    json: vi.fn().mockResolvedValue({
      success: status === 'SUCCESS' || status === 'DUPLICATE',
      results: [{ id: mutationId, mutationId, status, success: status === 'SUCCESS' || status === 'DUPLICATE' }]
    })
  } as any);

  const clearSyncStores = async () => {
    if (!db.isOpen()) await db.open();
    const nativeDb = (db as any).backendDB();
    const stores = ['outbox', 'syncQueue', 'sync_queue', 'syncEvents', 'failedMutations']
      .filter(name => nativeDb.objectStoreNames.contains(name));
    await new Promise<void>((resolve, reject) => {
      const tx = nativeDb.transaction(stores, 'readwrite');
      stores.forEach(name => tx.objectStore(name).clear());
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true, value: { onLine: false, userAgent: 'Vitest Phase6' }
    });
    setSession();
    await clearSyncStores();
    engine = new DistributedSyncEngine(db as any);
  });

  it('creates one tenant/user-owned queue+outbox mutation and safely reuses its idempotency key', async () => {
    const first = await engine.enqueue('CREATE', { id: 'product-phase6-1', name: 'Test' }, 'PRODUCT', 'phase6-idem-1');
    const second = await engine.enqueue('CREATE', { id: 'product-phase6-1', name: 'Test' }, 'PRODUCT', 'phase6-idem-1');

    expect(second.mutationId).toBe(first.mutationId);
    const queue = await db.syncQueue.where('idempotencyKey').equals('phase6-idem-1').toArray();
    const outbox = await db.outbox.where('idempotencyKey').equals('phase6-idem-1').toArray();
    expect(queue).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(queue[0]).toMatchObject({ tenantId: tenantA, userId: userA, syncStatus: 'PENDING' });
    expect(outbox[0]).toMatchObject({ tenantId: tenantA, userId: userA, mutationId: first.mutationId });
  });

  it.each(['SUCCESS', 'DUPLICATE'])('acknowledges %s only after the server returns a matching result', async (status) => {
    const queued = await engine.enqueue('CREATE', { id: 'product-' + status }, 'PRODUCT', 'idem-' + status);
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    (unifiedTransport.request as any).mockResolvedValue(response(status, queued.mutationId));

    await (engine as any).processMutationWithRetry(
      await db.syncQueue.where('mutationId').equals(queued.mutationId).first()
    );

    expect(unifiedTransport.request).toHaveBeenCalledTimes(1);
    expect(await db.syncQueue.where('mutationId').equals(queued.mutationId).count()).toBe(0);
    expect((await db.outbox.where('mutationId').equals(queued.mutationId).first())?.status).toBe('CONFIRMED');
    const sent = (unifiedTransport.request as any).mock.calls[0][0];
    expect(sent.body.mutations[0]).toMatchObject({
      id: queued.mutationId, idempotencyKey: queued.idempotencyKey
    });
  });

  it('keeps CONFLICT local and never marks it confirmed', async () => {
    const queued = await engine.enqueue('UPDATE', { id: 'product-conflict', version: 2 }, 'PRODUCT', 'idem-conflict');
    (unifiedTransport.request as any).mockResolvedValue(response('CONFLICT', queued.mutationId));
    const mutation = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();

    await (engine as any).processMutationWithRetry(mutation);

    expect((await db.syncQueue.get(mutation.id))?.syncStatus).toBe('CONFLICT');
    expect((await db.outbox.where('mutationId').equals(queued.mutationId).first())?.status).not.toBe('CONFIRMED');
    expect(await db.failedMutations.where('mutationId').equals(queued.mutationId).count()).toBe(1);
  });

  it('preserves the outbox event for retry after a network interruption', async () => {
    const queued = await engine.enqueue('CREATE', { id: 'product-offline' }, 'PRODUCT', 'idem-offline');
    (unifiedTransport.request as any).mockRejectedValue(new TypeError('Network disconnected'));
    await (engine as any).processOutboxEvent(await db.outbox.where('mutationId').equals(queued.mutationId).first());

    const saved = await db.outbox.where('mutationId').equals(queued.mutationId).first();
    expect(saved?.status).toBe('RETRYING');
    expect(saved?.mutationId).toBe(queued.mutationId);
    expect(saved?.idempotencyKey).toBe(queued.idempotencyKey);
  });

  it('does not acknowledge a mutation when the authenticated user changes during the request', async () => {
    const queued = await engine.enqueue('CREATE', { id: 'product-session-switch' }, 'PRODUCT', 'idem-session-switch');
    const mutation = await db.syncQueue.where('mutationId').equals(queued.mutationId).first();
    let resolveRequest!: (value: any) => void;
    (unifiedTransport.request as any).mockReturnValue(new Promise(resolve => { resolveRequest = resolve; }));

    const processing = (engine as any).processMutationWithRetry(mutation);
    await vi.waitFor(() => expect(unifiedTransport.request).toHaveBeenCalledTimes(1));
    setSession(tenantA, userB, 'phase6-token-B');
    resolveRequest(response('SUCCESS', queued.mutationId));
    await processing;

    setSession();
    expect((await db.syncQueue.get(mutation.id))?.syncStatus).toBe('PROCESSING');
    expect((await db.outbox.where('mutationId').equals(queued.mutationId).first())?.status).toBe('PENDING');
  });

  it('recovers only this owner\'s stale PROCESSING outbox event after a simulated restart', async () => {
    const queued = await engine.enqueue('CREATE', { id: 'product-recovery' }, 'PRODUCT', 'idem-recovery');
    const outbox = await db.outbox.where('mutationId').equals(queued.mutationId).first();
    await db.outbox.update(outbox.id, {
      status: 'processing',
      createdAt: new Date(Date.now() - 10 * 60 * 1000),
      updatedAt: new Date(Date.now() - 10 * 60 * 1000)
    });
    setSession(tenantA, userB, 'phase6-token-B');
    const otherOwner = await crashRecoveryManager.bootstrapAppRecovery();
    expect(otherOwner.recoveredCount).toBe(0);
    expect((await db.outbox.get(outbox.id))?.status).toBe('PROCESSING');

    setSession();
    const ownerRecovery = await crashRecoveryManager.bootstrapAppRecovery();
    expect(ownerRecovery.recoveredCount).toBeGreaterThanOrEqual(1);
    expect((await db.outbox.get(outbox.id))?.status).toBe('pending');
  });

  it('coalesces overlapping syncNow calls into a single active cycle', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    let finishCycle!: () => void;
    const cycle = new Promise<void>(resolve => { finishCycle = resolve; });
    const executeCycle = vi.spyOn(engine as any, 'executeSyncCycle').mockReturnValue(cycle);

    const one = engine.syncNow();
    const two = engine.syncNow();

    expect(executeCycle).toHaveBeenCalledTimes(1);
    expect(two).toBe(one);

    finishCycle();
    await Promise.all([one, two]);
  });
});
