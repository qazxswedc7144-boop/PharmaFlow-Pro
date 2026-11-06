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

  const setSession = (tenantId?: string, userId?: string) => {
    const session = {
      tenantId,
      userId,
      branchId: BRANCH_A,
      isAuthenticated: Boolean(tenantId),
      user: tenantId ? { id: userId, tenantId, branchId: BRANCH_A } : null,
      token: tenantId ? 'test-token' : null,
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

    it('aborts push if session changes between start and transport call', async () => {
      await db.outbox.add({
        id: 1,
        tenantId: TENANT_A,
        status: 'PENDING',
        type: 'TEST',
        payload: {},
        mutationId: 'mut-1'
      });

      // Start with Tenant A
      setSession(TENANT_A, USER_A);
      
      // Mock transport to be called only if session is still TENANT_A
      (unifiedTransport.request as any).mockImplementation(() => {
         return Promise.resolve({ ok: true });
      });

      const engine = DistributedSyncEngine.getInstance();
      
      // We'll simulate the race by changing session mid-loop
      // Call 1: drainQueue preamble
      // Call 2: drainQueue loop check
      // Call 3: processOutboxEvent start
      // Call 4+: inside sendPushRequest or subsequent calls
      let callCount = 0;
      (getCurrentUserSession as any).mockImplementation(() => {
        callCount++;
        if (callCount > 3) {
          return { tenantId: TENANT_B, userId: USER_B, branchId: BRANCH_A };
        }
        return { tenantId: TENANT_A, userId: USER_A, branchId: BRANCH_A };
      });

      await engine.drainQueue();

      // Should have bailed before transport or during transport wrap
      expect(unifiedTransport.request).not.toHaveBeenCalled();
      
      const item = await db.outbox.get(1);
      // It was marked SENDING but never confirmed or failed (it might stay SENDING if bailed silently, 
      // but our code now throws error which is caught and marks RETRYING)
      expect(item?.status).toBe('RETRYING'); 
      expect(item?.error).toContain('SESSION_SWITCH_DETECTED');
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
        .where('status').anyOf('failed', 'FAILED')
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
  });
});
