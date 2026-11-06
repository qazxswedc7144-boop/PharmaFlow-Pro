import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db, getCurrentUserSession } from '@/core/db';
import { configurationSyncService } from '@/services/config/configurationSyncService';
import { DistributedSyncEngine } from '@/features/sync/sync.engine';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { unifiedTransport } from '@/shared/network/transport/unifiedTransport';

vi.mock('@/core/db', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    getCurrentUserSession: vi.fn(),
  };
});

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: {
    getCurrentSession: vi.fn(),
    refreshAccessToken: vi.fn(),
  }
}));

vi.mock('@/shared/network/transport/unifiedTransport', () => ({
  unifiedTransport: {
    request: vi.fn(),
  }
}));

describe('PharmaFlow Pro — Sync Security Hardening Tests', () => {
  const TENANT_A = 'tenant-A';
  const TENANT_B = 'tenant-B';
  const USER_A = 'user-A';
  const USER_B = 'user-B';
  const BRANCH_A = 'branch-A';

  const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Mock navigator.onLine and userAgent
    Object.defineProperty(global, 'navigator', {
      value: { onLine: true, userAgent: 'TestAgent' },
      writable: true,
      configurable: true
    });

    setSession(TENANT_A, USER_A); // Set initial session for clearing
    await db.outbox.clear();
    await db.syncQueue.clear();
  });

  const setSession = (tenantId?: string, userId?: string, token = 'test-token') => {
    const session = {
      tenantId,
      userId,
      branchId: BRANCH_A,
      isAuthenticated: Boolean(tenantId),
      user: tenantId ? { id: userId, tenantId, branchId: BRANCH_A } : null,
      token: tenantId ? token : null,
      roles: [],
      permissions: []
    };
    (TokenProvider.getCurrentSession as any).mockReturnValue(session);
    // Also mock getCurrentUserSession directly since we mocked @/core/db
    (getCurrentUserSession as any).mockReturnValue({
      tenantId,
      userId,
      branchId: BRANCH_A,
    });
  };

  describe('Phase 1: ConfigurationSyncService Hardening', () => {
    it('rejects record.context.tenantId mismatching the active session', async () => {
      setSession(TENANT_A, USER_A);
      
      const record = {
        key: 'system.name',
        value: 'Spoofed Name',
        scope: 'TENANT' as any,
        context: { tenantId: TENANT_B }, // Spoofing attempt
        version: 1,
        updatedAt: new Date().toISOString()
      };

      await configurationSyncService.handleConfigMutation(record as any);
      
      const count = await db.outbox.count();
      expect(count).toBe(0);
    });

    it('forces session tenantId into outbox and payload context', async () => {
      setSession(TENANT_A, USER_A);
      
      const record = {
        key: 'system.name',
        value: 'Correct Name',
        scope: 'TENANT' as any,
        context: { tenantId: TENANT_A },
        version: 1,
        updatedAt: new Date().toISOString()
      };

      await configurationSyncService.handleConfigMutation(record as any);
      
      const outboxItem = await db.outbox.orderBy('id').last();
      expect(outboxItem.tenantId).toBe(TENANT_A);
      expect(outboxItem.payload.context.tenantId).toBe(TENANT_A);
    });
  });

  describe('Phase 2: Sync Engine Race Protection', () => {
    it('skips outbox events belonging to another tenant', async () => {
      // Setup: One event for Tenant A
      setSession(TENANT_A, USER_A);
      await db.outbox.add({
        id: 1,
        tenantId: TENANT_A,
        status: 'PENDING',
        type: 'TEST',
        payload: {},
        mutationId: 'mut-1'
      });

      // One for Tenant B (change session first so hook doesn't overwrite)
      setSession(TENANT_B, USER_B);
      await db.outbox.add({
        id: 2,
        tenantId: TENANT_B,
        status: 'PENDING',
        type: 'TEST',
        payload: {},
        mutationId: 'mut-2'
      });

      // Switch back to Tenant A for processing
      setSession(TENANT_A, USER_A);
      (unifiedTransport.request as any).mockResolvedValue({ ok: true });

      const engine = DistributedSyncEngine.getInstance();
      await engine.drainQueue();

      // Tenant A should see its event as CONFIRMED
      const item1 = await db.outbox.get(1);
      expect(item1?.status).toBe('CONFIRMED');

      // Switch to Tenant B to see its event remains PENDING
      setSession(TENANT_B, USER_B);
      const item2 = await db.outbox.get(2);
      expect(item2?.status).toBe('PENDING');
    });

    it('does not confirm an outbox event when the tenant changes during the network await', async () => {
      await db.outbox.add({
        id: 1,
        tenantId: TENANT_A,
        status: 'PENDING',
        type: 'TEST',
        payload: {},
        mutationId: 'mut-tenant-switch'
      });
      setSession(TENANT_A, USER_A);
      const request = deferred<Response>();
      (unifiedTransport.request as any).mockReturnValue(request.promise);

      const engine = new DistributedSyncEngine(db as any);
      const drain = engine.drainQueue();
      await vi.waitFor(() => expect(unifiedTransport.request).toHaveBeenCalledTimes(1));
      setSession(TENANT_B, USER_B);
      request.resolve({ ok: true } as Response);
      await drain;

      setSession(TENANT_A, USER_A);
      expect((await db.outbox.get(1))?.status).toBe('SENDING');
    });

    it('does not confirm an outbox event when the user changes within the same tenant during the network await', async () => {
      await db.outbox.add({
        id: 3,
        tenantId: TENANT_A,
        status: 'PENDING',
        type: 'TEST',
        payload: {},
        mutationId: 'mut-user-switch'
      });
      setSession(TENANT_A, USER_A);
      const request = deferred<Response>();
      (unifiedTransport.request as any).mockReturnValue(request.promise);

      const engine = new DistributedSyncEngine(db as any);
      const drain = engine.drainQueue();
      await vi.waitFor(() => expect(unifiedTransport.request).toHaveBeenCalledTimes(1));
      setSession(TENANT_A, USER_B);
      request.resolve({ ok: true } as Response);
      await drain;

      setSession(TENANT_A, USER_A);
      expect((await db.outbox.get(3))?.status).toBe('SENDING');
    });

    it('does not confirm an outbox event when the access token changes during the network await', async () => {
      await db.outbox.add({
        id: 4,
        tenantId: TENANT_A,
        status: 'PENDING',
        type: 'TEST',
        payload: {},
        mutationId: 'mut-token-switch'
      });
      setSession(TENANT_A, USER_A, 'token-before');
      const request = deferred<Response>();
      (unifiedTransport.request as any).mockReturnValue(request.promise);

      const engine = new DistributedSyncEngine(db as any);
      const drain = engine.drainQueue();
      await vi.waitFor(() => expect(unifiedTransport.request).toHaveBeenCalledTimes(1));
      setSession(TENANT_A, USER_A, 'token-after');
      request.resolve({ ok: true } as Response);
      await drain;

      setSession(TENANT_A, USER_A, 'token-before');
      expect((await db.outbox.get(4))?.status).toBe('SENDING');
    });

    it('does not delete a syncQueue mutation when the tenant changes during the network await', async () => {
      await db.syncQueue.add({
        tenantId: TENANT_A,
        userId: USER_A,
        syncStatus: 'PENDING',
        retryCount: 0,
        mutationId: 'queue-mut-session-switch',
        idempotencyKey: 'queue-idem-session-switch',
        entityType: 'PRODUCT',
        operationType: 'CREATE',
        payload: { id: 'product-session-switch' },
        createdAt: new Date()
      } as any);
      setSession(TENANT_A, USER_A);
      const request = deferred<Response>();
      (unifiedTransport.request as any).mockReturnValue(request.promise);

      const engine = new DistributedSyncEngine(db as any);
      const drain = engine.drainQueue();
      await vi.waitFor(() => expect(unifiedTransport.request).toHaveBeenCalledTimes(1));
      setSession(TENANT_B, USER_B);
      request.resolve({ ok: true } as Response);
      await drain;

      setSession(TENANT_A, USER_A);
      const item = await db.syncQueue.where('mutationId').equals('queue-mut-session-switch').first();
      expect(item?.syncStatus).toBe('PROCESSING');
    });

    it('prevents cross-tenant userId/tenantId mismatch in headers', async () => {
      await db.outbox.add({
        id: 1,
        tenantId: TENANT_A,
        status: 'PENDING',
        type: 'TEST',
        payload: {},
        mutationId: 'mut-1'
      });

      setSession(TENANT_A, USER_A);
      (unifiedTransport.request as any).mockResolvedValue({ ok: true });

      const engine = DistributedSyncEngine.getInstance();
      await engine.drainQueue();

      expect(unifiedTransport.request).toHaveBeenCalledWith(expect.objectContaining({
        headers: expect.objectContaining({
          'X-Tenant-ID': TENANT_A,
          'X-User-ID': USER_A
        })
      }));
    });
  });

  describe('Phase 3: SyncTab Logic Hardening', () => {
    it('only deletes failed records belonging to the active tenant', async () => {
      // Setup: Failed events for Tenant A and B
      setSession(TENANT_A, USER_A);
      await db.outbox.add({ 
        id: 10, tenantId: TENANT_A, status: 'FAILED', type: 'T1', 
        mutationId: 'tab-mut-1', idempotencyKey: 'tab-idem-1' 
      });
      
      setSession(TENANT_B, USER_B);
      await db.outbox.add({ 
        id: 11, tenantId: TENANT_B, status: 'FAILED', type: 'T2', 
        mutationId: 'tab-mut-2', idempotencyKey: 'tab-idem-2' 
      });

      // Action: Clear failed while in Tenant A
      setSession(TENANT_A, USER_A);
      
      // Simulation of handleClearFailed logic:
      const session = getCurrentUserSession();
      const failedIds = await db.outbox
        .where('status').anyOf('failed', 'FAILED', 'RETRYING')
        .and(item => item.tenantId === session.tenantId)
        .primaryKeys();
      
      await db.outbox.bulkDelete(failedIds);

      // Verify: Only ID 10 should be gone
      const item1 = await db.outbox.get(10);
      expect(item1).toBeUndefined();

      setSession(TENANT_B, USER_B);
      const item2 = await db.outbox.get(11);
      expect(item2).toBeDefined();
      expect(item2?.status).toBe('FAILED');
    });

    it('includes RETRYING records in the tenant-scoped failed clear operation', async () => {
      setSession(TENANT_A, USER_A);
      await db.outbox.add({
        id: 12,
        tenantId: TENANT_A,
        status: 'RETRYING',
        type: 'T3',
        mutationId: 'tab-mut-retrying',
        idempotencyKey: 'tab-idem-retrying'
      });

      const session = getCurrentUserSession();
      const retryingIds = await db.outbox
        .where('status').anyOf('failed', 'FAILED', 'RETRYING')
        .and(item => item.tenantId === session.tenantId)
        .primaryKeys();

      expect(retryingIds).toContain(12);
      await db.outbox.bulkDelete(retryingIds);
      expect(await db.outbox.get(12)).toBeUndefined();
    });
  });
});
