import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getCurrentUserSession } from '@/core/db';
import { DistributedSyncEngine } from '@/features/sync/sync.engine';
import { SYNC_CONFIG } from '@/features/sync/sync.constants';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { UnifiedTransport } from '@/shared/network/transport/unifiedTransport';
import { observabilityService } from '@/core/observability/observabilityService';

vi.mock('@/core/db', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return { ...actual, getCurrentUserSession: vi.fn() };
});

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: {
    getCurrentSession: vi.fn(),
    getAuthHeaders: vi.fn(),
    refreshAccessToken: vi.fn(),
  }
}));

describe('P0 Phase 1 — UnifiedTransport & SyncEngine Period Rejection Hardening', () => {
  const tenantId = 'tenant-phase1-A';
  const userId = 'user-phase1-A';
  const branchId = 'branch-phase1-A';
  const originalFetch = globalThis.fetch;

  const setActiveSession = () => {
    const session = {
      tenantId,
      userId,
      branchId,
      deviceId: 'PF-DEV-PHASE1',
      isAuthenticated: true,
      token: 'phase1-token-A',
      user: { id: userId, tenantId, branchId },
      roles: ['ADMIN'],
      permissions: ['ALL'],
    };
    (TokenProvider.getCurrentSession as any).mockReturnValue(session);
    (TokenProvider.getAuthHeaders as any).mockReturnValue({
      Authorization: 'Bearer phase1-token-A',
      'x-tenant-id': tenantId,
      'x-branch-id': branchId,
    });
    (getCurrentUserSession as any).mockReturnValue({ tenantId, userId, branchId });
  };

  const clearStores = async () => {
    if (!db.isOpen()) await db.open();
    const nativeDb = (db as any).backendDB();
    const stores = ['outbox', 'syncQueue', 'sync_queue', 'syncEvents', 'failedMutations', 'invoices']
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
    vi.spyOn(observabilityService, 'recordError').mockResolvedValue(undefined as any);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { onLine: true, userAgent: 'Vitest Phase1' },
    });
    setActiveSession();
    await clearStores();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('UnifiedTransport raw:true and non-retryable HTTP contract', () => {
    it.each([400, 423])('returns raw Response with readable body for HTTP %i when raw: true without retrying', async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: false,
            error: 'ACCOUNTING_PERIOD_LOCKED',
            errorCode: 'ACCOUNTING_PERIOD_LOCKED',
            message: 'Accounting period is locked',
          }),
          { status, headers: { 'Content-Type': 'application/json' } }
        )
      );
      globalThis.fetch = fetchMock as any;

      const transport = new UnifiedTransport();
      const response = await transport.request<Response>({
        url: 'http://localhost:3000/api/v1/sync/push',
        method: 'POST',
        profile: 'SYNC',
        raw: true,
        body: { mutations: [] },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(status);
      expect(response.ok).toBe(false);
      const parsed = await response.json();
      expect(parsed.errorCode).toBe('ACCOUNTING_PERIOD_LOCKED');
    });

    it.each([400, 403, 423])('never retries permanent HTTP %i errors in non-raw mode (1 fetch call, not 3)', async (status) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: 'ACCOUNTING_PERIOD_LOCKED', message: 'Locked' }),
          { status, headers: { 'Content-Type': 'application/json' } }
        )
      );
      globalThis.fetch = fetchMock as any;

      const transport = new UnifiedTransport();
      await expect(
        transport.request({
          url: 'http://localhost:3000/api/invoices/post',
          method: 'POST',
          profile: 'SYNC',
          retries: 2,
          body: { invoiceId: 'inv-1' },
        })
      ).rejects.toMatchObject({ status, retryable: false });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('still retries transient network failures up to maxRetries', async () => {
      vi.useFakeTimers();
      try {
        const fetchMock = vi.fn()
          .mockRejectedValueOnce(new TypeError('Failed to fetch'))
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ success: true }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
          );
        globalThis.fetch = fetchMock as any;

        const transport = new UnifiedTransport();
        const promise = transport.request<{ success: boolean }>({
          url: 'http://localhost:3000/api/v1/sync/push',
          method: 'POST',
          profile: 'SYNC',
          retries: 2,
          body: { mutations: [] },
        });

        await vi.advanceTimersByTimeAsync(5000);
        const result = await promise;
        expect(result).toEqual({ success: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('DistributedSyncEngine + real UnifiedTransport end-to-end rejection lifecycle', () => {
    it('classifies HTTP 400 ACCOUNTING_PERIOD_LOCKED as terminal across syncQueue and outbox with 1 single request, zero retries, and no double-dispatch in drainQueue', async () => {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: false, userAgent: 'Vitest Phase1' },
      });

      const engine = new DistributedSyncEngine(db as any);
      const localInvoiceId = 'INV-LOCAL-LOCKED-1';
      await db.invoices.put({
        id: localInvoiceId,
        invoiceNumber: 'SALE-LOCKED-001',
        tenantId,
        branchId,
        totalAmount: 100,
        status: 'CONFIRMED',
      } as any);

      const enqueued = await engine.enqueue(
        'POST',
        { id: localInvoiceId, invoiceNumber: 'SALE-LOCKED-001', totalAmount: 100 },
        'SALE',
        'idem-sale-locked-001'
      );

      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: true, userAgent: 'Vitest Phase1' },
      });

      const fetchMock = vi.fn().mockImplementation(async () =>
        new Response(
          JSON.stringify({
            success: false,
            results: [{
              id: enqueued.mutationId,
              mutationId: enqueued.mutationId,
              status: 'FAILED',
              success: false,
              errorCode: 'ACCOUNTING_PERIOD_LOCKED',
              message: 'الفترة المحاسبية مغلقة',
            }],
            summary: { rejected: [enqueued.mutationId] },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      );
      globalThis.fetch = fetchMock as any;

      await engine.drainQueue();

      // Sent exactly once: not 3x by transport, not 18x by retry loop, and NOT dispatched again by outbox in the same cycle
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const queueRow = await db.syncQueue.where('mutationId').equals(enqueued.mutationId).first();
      const outboxRow = await db.outbox.where('mutationId').equals(enqueued.mutationId).first();

      expect(queueRow).toMatchObject({
        mutationId: enqueued.mutationId,
        idempotencyKey: 'idem-sale-locked-001',
        syncStatus: 'REJECTED',
        retryCount: 0,
        errorCode: 'ACCOUNTING_PERIOD_LOCKED',
        lastError: 'الفترة المحاسبية مغلقة',
      });
      expect(outboxRow).toMatchObject({
        mutationId: enqueued.mutationId,
        idempotencyKey: 'idem-sale-locked-001',
        status: 'FAILED',
        retries: 0,
        errorCode: 'ACCOUNTING_PERIOD_LOCKED',
        error: 'الفترة المحاسبية مغلقة',
      });

      // Local invoice must remain intact (not deleted or reverted)
      const localInvoice = await db.invoices.get(localInvoiceId);
      expect(localInvoice?.invoiceNumber).toBe('SALE-LOCKED-001');

      // Subsequent drainQueue cycles must NOT resend the permanently rejected mutation
      await engine.drainQueue();
      await engine.drainQueue();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // Reopen period -> resubmitFailed preserves original mutationId & idempotencyKey and confirms cleanly
      fetchMock.mockImplementationOnce(async () =>
        new Response(
          JSON.stringify({
            success: true,
            results: [{
              id: enqueued.mutationId,
              mutationId: enqueued.mutationId,
              status: 'SUCCESS',
              success: true,
            }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: false, userAgent: 'Vitest Phase1' },
      });
      await engine.resubmitFailed(enqueued.mutationId);
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: true, userAgent: 'Vitest Phase1' },
      });

      await engine.drainQueue();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const secondCallBody = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
      expect(secondCallBody.mutations[0]).toMatchObject({
        id: enqueued.mutationId,
        idempotencyKey: 'idem-sale-locked-001',
      });

      expect(await db.syncQueue.where('mutationId').equals(enqueued.mutationId).count()).toBe(0);
      const confirmedOutbox = await db.outbox.where('mutationId').equals(enqueued.mutationId).first();
      expect(confirmedOutbox?.status).toBe('CONFIRMED');
      expect(confirmedOutbox?.errorCode).toBeUndefined();
    });

    it('stops retrying HTTP 423 ACCOUNTING_PERIOD_LOCKED immediately across syncQueue and outbox', async () => {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: false, userAgent: 'Vitest Phase1' },
      });
      const engine = new DistributedSyncEngine(db as any);
      const enqueued = await engine.enqueue('POST', { id: 'INV-423' }, 'SALE', 'idem-sale-423');

      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: true, userAgent: 'Vitest Phase1' },
      });

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'ACCOUNTING_PERIOD_LOCKED',
            message: 'Period locked',
          }),
          { status: 423, headers: { 'Content-Type': 'application/json' } }
        )
      );
      globalThis.fetch = fetchMock as any;

      await engine.drainQueue();
      await engine.drainQueue();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await db.syncQueue.where('mutationId').equals(enqueued.mutationId).first()).toMatchObject({
        syncStatus: 'REJECTED',
        retryCount: 0,
        errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      });
      expect(await db.outbox.where('mutationId').equals(enqueued.mutationId).first()).toMatchObject({
        status: 'FAILED',
        retries: 0,
        errorCode: 'ACCOUNTING_PERIOD_LOCKED',
      });
    });

    it('bounds transient network retries on outbox events to SYNC_CONFIG.MAX_RETRY_ATTEMPTS', async () => {
      const engine = new DistributedSyncEngine(db as any);
      const outboxId = await db.outbox.add({
        mutationId: 'outbox-transient-1',
        tenantId,
        userId,
        branchId,
        type: 'CREATE',
        operation: 'CREATE',
        entityType: 'PRODUCT',
        payload: { id: 'prod-1' },
        status: 'PENDING',
        retries: 0,
        idempotencyKey: 'idem-outbox-transient-1',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);

      const fetchMock = vi.fn().mockRejectedValue(new TypeError('Network down'));
      globalThis.fetch = fetchMock as any;

      const originalSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number, ...args: any[]) => {
        return originalSetTimeout(fn, typeof ms === 'number' && ms >= 500 ? 0 : ms, ...args);
      }) as any);

      try {
        // First MAX_RETRY_ATTEMPTS failures keep status RETRYING with incremented retries
        for (let attempt = 1; attempt <= SYNC_CONFIG.MAX_RETRY_ATTEMPTS; attempt++) {
          const eventRecord = await db.outbox.get(outboxId);
          await (engine as any).processOutboxEvent(eventRecord);

          const row = await db.outbox.get(outboxId);
          expect(row?.status).toBe('RETRYING');
          expect(row?.retries).toBe(attempt);
          expect(row?.mutationId).toBe('outbox-transient-1');
          expect(row?.idempotencyKey).toBe('idem-outbox-transient-1');
        }

        // Next failure exceeds MAX_RETRY_ATTEMPTS and transitions to terminal FAILED
        const lastEvent = await db.outbox.get(outboxId);
        await (engine as any).processOutboxEvent(lastEvent);

        const deadRow = await db.outbox.get(outboxId);
        expect(deadRow?.status).toBe('FAILED');
        expect(deadRow?.retries).toBe(SYNC_CONFIG.MAX_RETRY_ATTEMPTS + 1);

        const callsBeforeDrain = fetchMock.mock.calls.length;
        await engine.drainQueue();
        expect(fetchMock.mock.calls.length).toBe(callsBeforeDrain);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });
});
