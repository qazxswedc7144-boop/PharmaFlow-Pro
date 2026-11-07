import { describe, expect, it } from 'vitest';
import { isLegacySyncRecordRemovable } from '@/features/sync/legacySyncCleanup';

describe('Legacy local sync cleanup eligibility', () => {
  const owner = { tenantId: 'tenant-A', userId: 'user-A' };
  const now = Date.parse('2026-11-06T00:00:00.000Z');
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const old = new Date(cutoff - 1000).toISOString();
  const recent = new Date(now - 1000).toISOString();

  it('removes ownerless legacy records only inside the active tenant', () => {
    expect(isLegacySyncRecordRemovable({ tenantId: 'tenant-A', createdAt: recent, status: 'PENDING' }, owner, cutoff, 'status')).toBe(true);
    expect(isLegacySyncRecordRemovable({ tenantId: 'tenant-B', createdAt: old, status: 'FAILED' }, owner, cutoff, 'status')).toBe(false);
  });
  it('preserves another user records even when old and failed', () => {
    expect(isLegacySyncRecordRemovable({ tenantId: 'tenant-A', userId: 'user-B', createdAt: old, status: 'FAILED' }, owner, cutoff, 'status')).toBe(false);
  });
  it('preserves current-user pending work regardless of age', () => {
    expect(isLegacySyncRecordRemovable({ tenantId: 'tenant-A', userId: 'user-A', createdAt: old, status: 'PENDING' }, owner, cutoff, 'status')).toBe(false);
    expect(isLegacySyncRecordRemovable({ tenantId: 'tenant-A', userId: 'user-A', createdAt: old, syncStatus: 'PENDING' }, owner, cutoff, 'syncStatus')).toBe(false);
  });
  it('removes current-user FAILED records only after 30 days', () => {
    expect(isLegacySyncRecordRemovable({ tenantId: 'tenant-A', userId: 'user-A', createdAt: old, status: 'FAILED' }, owner, cutoff, 'status')).toBe(true);
    expect(isLegacySyncRecordRemovable({ tenantId: 'tenant-A', userId: 'user-A', createdAt: recent, syncStatus: 'FAILED' }, owner, cutoff, 'syncStatus')).toBe(false);
  });
  it('preserves malformed timestamps and retrying states', () => {
    expect(isLegacySyncRecordRemovable({ tenantId: 'tenant-A', userId: 'user-A', createdAt: 'invalid', status: 'FAILED' }, owner, cutoff, 'status')).toBe(false);
    expect(isLegacySyncRecordRemovable({ tenantId: 'tenant-A', userId: 'user-A', createdAt: old, status: 'RETRYING' }, owner, cutoff, 'status')).toBe(false);
  });
});
