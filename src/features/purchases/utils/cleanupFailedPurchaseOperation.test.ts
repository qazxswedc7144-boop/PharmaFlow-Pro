import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/core/db';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';
import { cleanupFailedPurchaseOperation } from './cleanupFailedPurchaseOperation';

describe('cleanupFailedPurchaseOperation', () => {
  beforeEach(async () => {
    await db.open();
    await Promise.all([db.syncQueue.clear(), db.outbox.clear(), db.idempotencyKeys.clear(), db.idempotency_records.clear()]);
    IdempotencyRegistry.clearInMemory();
  });
  afterEach(async () => {
    await Promise.all([db.syncQueue.clear(), db.outbox.clear(), db.idempotencyKeys.clear(), db.idempotency_records.clear()]);
    IdempotencyRegistry.clearInMemory();
  });

  it('removes only the failed operation queue, outbox and tenant-scoped idempotency records', async () => {
    await db.syncQueue.add({ idempotencyKey: 'op-failed', mutationId: 'mutation-failed', tenantId: 'tenant-a' });
    await db.syncQueue.add({ idempotencyKey: 'op-other', mutationId: 'mutation-other', tenantId: 'tenant-a' });
    await db.outbox.add({ idempotencyKey: 'op-failed', mutationId: 'mutation-failed', tenantId: 'tenant-a' });
    await db.outbox.add({ idempotencyKey: 'op-other', mutationId: 'mutation-other', tenantId: 'tenant-a' });
    await IdempotencyRegistry.save({ key: 'op-failed', status: 'FAILED', tenantId: 'tenant-a', branchId: 'branch-a', operationType: 'PURCHASE', entityType: 'PURCHASE', fingerprint: 'payload', createdAt: new Date().toISOString() });

    await cleanupFailedPurchaseOperation('op-failed', 'tenant-a');

    expect(await db.syncQueue.where('idempotencyKey').equals('op-failed').count()).toBe(0);
    expect(await db.outbox.where('idempotencyKey').equals('op-failed').count()).toBe(0);
    expect(await db.syncQueue.where('idempotencyKey').equals('op-other').count()).toBe(1);
    expect(await db.outbox.where('idempotencyKey').equals('op-other').count()).toBe(1);
    await expect(IdempotencyRegistry.get('op-failed', 'tenant-a')).resolves.toBeNull();
  });

  it('fails closed and preserves records when a matching operation belongs to another tenant', async () => {
    await db.syncQueue.add({ idempotencyKey: 'op-cross-tenant', mutationId: 'mutation-cross-tenant', tenantId: 'tenant-b' });
    await expect(cleanupFailedPurchaseOperation('op-cross-tenant', 'tenant-a')).rejects.toThrow('PURCHASE_OPERATION_CLEANUP_TENANT_MISMATCH');
    expect(await db.syncQueue.where('idempotencyKey').equals('op-cross-tenant').count()).toBe(1);
  });

  it('requires a trusted tenant before deleting any operation artifacts', async () => {
    await db.syncQueue.add({ idempotencyKey: 'op-no-tenant', mutationId: 'mutation-no-tenant', tenantId: 'tenant-a' });
    await expect(cleanupFailedPurchaseOperation('op-no-tenant')).rejects.toThrow('PURCHASE_OPERATION_CLEANUP_REQUIRES_OPERATION_AND_TENANT');
    expect(await db.syncQueue.where('idempotencyKey').equals('op-no-tenant').count()).toBe(1);
  });
});
