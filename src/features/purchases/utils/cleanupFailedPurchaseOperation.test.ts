import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { IdempotencyRegistry } from '@/core/integrity/idempotencyRegistry';
import { cleanupFailedPurchaseOperation } from './cleanupFailedPurchaseOperation';

const setTenantSession = (tenantId: string) => {
  TokenProvider.setSession({
    id: 'user-' + tenantId,
    tenantId,
    branchId: 'branch-' + tenantId
  } as any, 'access-' + tenantId, 'refresh-' + tenantId);
};

const uniqueOperationId = (prefix: string) => prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);

describe('cleanupFailedPurchaseOperation', () => {
  beforeEach(async () => {
    await db.open();
    setTenantSession('tenant-a');
    IdempotencyRegistry.clearInMemory();
  });

  afterEach(() => {
    IdempotencyRegistry.clearInMemory();
    TokenProvider.clearSession();
  });

  it('removes only the failed operation queue, outbox and tenant-scoped idempotency records', async () => {
    const operationId = uniqueOperationId('op-failed');
    const unrelatedOperationId = uniqueOperationId('op-other');
    await db.syncQueue.add({ idempotencyKey: operationId, mutationId: 'mutation-' + operationId, tenantId: 'tenant-a' });
    await db.syncQueue.add({ idempotencyKey: unrelatedOperationId, mutationId: 'mutation-' + unrelatedOperationId, tenantId: 'tenant-a' });
    await db.outbox.add({ idempotencyKey: operationId, mutationId: 'outbox-' + operationId, tenantId: 'tenant-a' });
    await db.outbox.add({ idempotencyKey: unrelatedOperationId, mutationId: 'outbox-' + unrelatedOperationId, tenantId: 'tenant-a' });
    await IdempotencyRegistry.save({
      key: operationId, status: 'FAILED', tenantId: 'tenant-a', branchId: 'branch-tenant-a',
      operationType: 'PURCHASE', entityType: 'PURCHASE', fingerprint: 'payload', createdAt: new Date().toISOString()
    });

    await cleanupFailedPurchaseOperation(operationId, 'tenant-a');

    expect(await db.syncQueue.where('idempotencyKey').equals(operationId).count()).toBe(0);
    expect(await db.outbox.where('idempotencyKey').equals(operationId).count()).toBe(0);
    expect(await db.syncQueue.where('idempotencyKey').equals(unrelatedOperationId).count()).toBe(1);
    expect(await db.outbox.where('idempotencyKey').equals(unrelatedOperationId).count()).toBe(1);
    await expect(IdempotencyRegistry.get(operationId, 'tenant-a')).resolves.toBeNull();

    await db.syncQueue.where('idempotencyKey').equals(unrelatedOperationId).delete();
    await db.outbox.where('idempotencyKey').equals(unrelatedOperationId).delete();
  });

  it('cannot see or delete a matching operation owned by another tenant', async () => {
    const operationId = uniqueOperationId('op-cross-tenant');
    setTenantSession('tenant-b');
    await db.syncQueue.add({ idempotencyKey: operationId, mutationId: 'mutation-' + operationId, tenantId: 'tenant-b' });

    setTenantSession('tenant-a');
    await expect(cleanupFailedPurchaseOperation(operationId, 'tenant-a')).resolves.toBeUndefined();
    expect(await db.syncQueue.where('idempotencyKey').equals(operationId).count()).toBe(0);

    setTenantSession('tenant-b');
    expect(await db.syncQueue.where('idempotencyKey').equals(operationId).count()).toBe(1);
    await db.syncQueue.where('idempotencyKey').equals(operationId).delete();
  });

  it('requires a trusted tenant before deleting any operation artifacts', async () => {
    const operationId = uniqueOperationId('op-no-tenant');
    await db.syncQueue.add({ idempotencyKey: operationId, mutationId: 'mutation-' + operationId, tenantId: 'tenant-a' });

    TokenProvider.clearSession();
    await expect(cleanupFailedPurchaseOperation(operationId)).rejects.toThrow('PURCHASE_OPERATION_CLEANUP_REQUIRES_OPERATION_AND_TENANT');

    setTenantSession('tenant-a');
    expect(await db.syncQueue.where('idempotencyKey').equals(operationId).count()).toBe(1);
    await db.syncQueue.where('idempotencyKey').equals(operationId).delete();
  });
});
