import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getCurrentSession } = vi.hoisted(() => ({
  getCurrentSession: vi.fn(() => ({
    isAuthenticated: true,
    token: 'test-token',
    tenantId: 'tenant-test',
    branchId: 'branch-test',
    user: { id: 'user-test', tenantId: 'tenant-test' },
  })),
}));

vi.mock('@/services/auth/tokenProvider', () => ({
  TokenProvider: { getCurrentSession },
}));

vi.mock('./device.manager', () => ({
  DeviceManager: {
    getDeviceIdentity: () => ({ deviceId: 'device-test' }),
  },
}));

vi.mock('@/core/db', () => ({
  db: {},
  getCurrentUserSession: () => ({
    userId: 'user-test',
    tenantId: 'tenant-test',
    branchId: 'branch-test',
  }),
}));

import { DistributedSyncEngine } from './sync.engine';

describe('DistributedSyncEngine transactional sale enqueue', () => {
  let localDb: Dexie;
  let engine: DistributedSyncEngine;

  beforeEach(async () => {
    localDb = new Dexie(`sale-sync-atomicity-${Math.random()}`);
    localDb.version(1).stores({
      invoices: '&id',
      inventoryTransactions: '&id',
      journalEntries: '&id',
      syncQueue: '++id, &idempotencyKey, mutationId, tenantId, userId',
      outbox: '++id, &mutationId, &idempotencyKey, status, type, operation, tenantId, userId',
    });
    await localDb.open();
    engine = new DistributedSyncEngine(localDb);
  });

  it.each(['syncQueue', 'outbox'])('rolls back invoice and all sync writes when %s.add fails', async (failingStore) => {
    const table = (localDb as any)[failingStore];
    const addSpy = vi.spyOn(table, 'add').mockRejectedValueOnce(new Error(`${failingStore.toUpperCase()}_WRITE_FAILED`));

    await expect(localDb.transaction('rw', [
      localDb.table('invoices'),
      localDb.table('inventoryTransactions'),
      localDb.table('journalEntries'),
      localDb.table('syncQueue'),
      localDb.table('outbox'),
    ], async () => {
      await localDb.table('invoices').add({ id: 'invoice-atomic-1' });
      await localDb.table('inventoryTransactions').add({ id: 'inventory-atomic-1', invoiceId: 'invoice-atomic-1' });
      await localDb.table('journalEntries').add({ id: 'journal-atomic-1', sourceId: 'invoice-atomic-1' });
      await engine.enqueueWithinTransaction(
        'POST',
        {
          invoiceNumber: 'INV-ATOMIC-1',
          type: 'SALE',
          totalAmount: 100,
          items: [{ productId: '11111111-1111-4111-8111-111111111111', qty: 1, price: 100 }],
        },
        'SALE',
        'sale-idempotency-atomic-1',
        { tenantId: 'tenant-test', branchId: 'branch-test' },
      );
    })).rejects.toThrow(`${failingStore.toUpperCase()}_WRITE_FAILED`);

    expect(await localDb.table('invoices').count()).toBe(0);
    expect(await localDb.table('inventoryTransactions').count()).toBe(0);
    expect(await localDb.table('journalEntries').count()).toBe(0);
    expect(await localDb.table('syncQueue').count()).toBe(0);
    expect(await localDb.table('outbox').count()).toBe(0);
    addSpy.mockRestore();
  });

  it('commits invoice, queue, and outbox together and preserves POST operation parity', async () => {
    await localDb.transaction('rw', [
      localDb.table('invoices'),
      localDb.table('syncQueue'),
      localDb.table('outbox'),
    ], async () => {
      await localDb.table('invoices').add({ id: 'invoice-atomic-2' });
      await engine.enqueueWithinTransaction(
        'POST',
        {
          invoiceNumber: 'INV-ATOMIC-2',
          type: 'SALE',
          totalAmount: 100,
          items: [{ productId: '11111111-1111-4111-8111-111111111111', qty: 1, price: 100 }],
        },
        'SALE',
        'sale-idempotency-atomic-2',
        { tenantId: 'tenant-test', branchId: 'branch-test' },
      );
    });

    expect(await localDb.table('invoices').count()).toBe(1);
    expect(await localDb.table('syncQueue').count()).toBe(1);
    const outboxRows = await localDb.table('outbox').toArray();
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].operation).toBe('POST');
    expect(outboxRows[0].type).toBe('POST');
  });

  it('fails closed when called without an active transaction containing both sync stores', async () => {
    await expect(engine.enqueueWithinTransaction(
      'POST',
      { invoiceNumber: 'INV-ATOMIC-3', type: 'SALE', totalAmount: 100, items: [] },
      'SALE',
      'sale-idempotency-atomic-3',
      { tenantId: 'tenant-test', branchId: 'branch-test' },
    )).rejects.toThrow('SYNC_TRANSACTION_SCOPE_MISSING');
  });
});
