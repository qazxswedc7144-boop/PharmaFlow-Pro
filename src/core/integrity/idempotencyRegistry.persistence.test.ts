import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '@/core/db';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { IdempotencyRegistry } from './idempotencyRegistry';

const setTenantSession = (tenantId: string, branchId = 'branch-a') => {
  TokenProvider.setSession(
    { id: 'user-' + tenantId, tenantId, branchId } as any,
    'access-' + tenantId,
    'refresh-' + tenantId
  );
};

const uniqueKey = () => 'idempotency-test-' + Date.now() + '-' + Math.random().toString(36).slice(2);

const recordFor = (key: string) => ({
  key,
  status: 'PROCESSING' as const,
  tenantId: 'tenant-a',
  branchId: 'branch-a',
  operationType: 'PURCHASE',
  entityType: 'PURCHASE',
  fingerprint: 'test-payload',
  createdAt: new Date().toISOString()
});

describe('IdempotencyRegistry durable persistence', () => {
  beforeEach(async () => {
    await db.open();
    setTenantSession('tenant-a');
    IdempotencyRegistry.clearInMemory();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    IdempotencyRegistry.clearInMemory();
    TokenProvider.clearSession();
  });

  it('persists PROCESSING to both durable tables before caching it in memory', async () => {
    const key = uniqueKey();
    await IdempotencyRegistry.save(recordFor(key));

    const scopedKey = IdempotencyRegistry.scopedKey(key, 'tenant-a');
    await expect(db.idempotency_records.get(scopedKey)).resolves.toMatchObject({
      key: scopedKey,
      tenantId: 'tenant-a',
      status: 'PROCESSING'
    });
    await expect(db.idempotencyKeys.get(scopedKey)).resolves.toMatchObject({
      id: scopedKey,
      tenantId: 'tenant-a',
      status: 'PROCESSING'
    });

    await IdempotencyRegistry.delete(key, 'tenant-a');
  });

  it('rejects save and does not report a memory-only success when durable storage fails', async () => {
    const key = uniqueKey();
    vi.spyOn(db.idempotency_records, 'put').mockRejectedValueOnce(new Error('disk full'));

    await expect(IdempotencyRegistry.save(recordFor(key))).rejects.toThrow('disk full');
    IdempotencyRegistry.clearInMemory();
    await expect(IdempotencyRegistry.get(key, 'tenant-a')).resolves.toBeNull();
  });

  it('keeps the durable PROCESSING state when COMMITTED persistence fails', async () => {
    const key = uniqueKey();
    await IdempotencyRegistry.save(recordFor(key));
    vi.spyOn(db.idempotency_records, 'put').mockRejectedValueOnce(new Error('disk full'));

    await expect(
      IdempotencyRegistry.updateStatus(key, 'COMMITTED', { invoiceId: 'PUR-1' }, undefined, 'tenant-a')
    ).rejects.toThrow('disk full');

    IdempotencyRegistry.clearInMemory();
    const persisted = await db.idempotency_records.get(IdempotencyRegistry.scopedKey(key, 'tenant-a'));
    expect(persisted?.status).toBe('PROCESSING');

    await IdempotencyRegistry.delete(key, 'tenant-a');
  });

  it('propagates delete failures so callers cannot assume cleanup succeeded', async () => {
    const key = uniqueKey();
    await IdempotencyRegistry.save(recordFor(key));
    vi.spyOn(db.idempotency_records, 'delete').mockRejectedValueOnce(new Error('delete blocked'));

    await expect(IdempotencyRegistry.delete(key, 'tenant-a')).rejects.toThrow('delete blocked');
    vi.restoreAllMocks();
    await IdempotencyRegistry.delete(key, 'tenant-a');
  });
});
