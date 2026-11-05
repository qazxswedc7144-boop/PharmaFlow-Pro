import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationRecord } from '@/core/config/types';

const mockDb = vi.hoisted(() => {
  const rows = new Map<string, { key: string; value: any }>();
  const settings = {
    toArray: vi.fn(async () => Array.from(rows.values())),
    get: vi.fn(async (key: string) => rows.get(key)),
    put: vi.fn(async (item: { key: string; value: any }) => {
      rows.set(item.key, item);
    }),
    delete: vi.fn(async (key: string) => {
      rows.delete(key);
    })
  };
  const transaction = vi.fn(async (_mode: string, _table: string, operation: () => Promise<void>) => operation());
  return { rows, settings, transaction };
});

vi.mock('@/core/db', () => ({
  db: {
    settings: mockDb.settings,
    transaction: mockDb.transaction
  }
}));

import { ConfigurationRepository } from './configurationRepository';

const tenantRecord: ConfigurationRecord<string> = {
  key: 'system.name',
  value: 'Tenant A',
  scope: 'TENANT',
  context: { tenantId: 'tenant-a' },
  version: 1,
  updatedAt: '2026-11-05T00:00:00.000Z'
};

describe('ConfigurationRepository legacy preservation', () => {
  beforeEach(() => {
    mockDb.rows.clear();
    vi.clearAllMocks();
  });

  it('propagates Dexie read failures instead of treating them as an empty settings store', async () => {
    mockDb.settings.toArray.mockRejectedValueOnce(new Error('storage unavailable'));

    const repository = new ConfigurationRepository();
    await expect(repository.getAllRecords()).rejects.toThrow('storage unavailable');
  });

  it('propagates scoped record read failures instead of treating them as missing settings', async () => {
    mockDb.settings.get.mockRejectedValueOnce(new Error('scoped read unavailable'));

    const repository = new ConfigurationRepository();
    await expect(repository.getRecord('system.name', 'TENANT', {
      tenantId: 'tenant-a'
    })).rejects.toThrow('scoped read unavailable');
  });

  it('loads only correctly scoped records and preserves unscoped legacy values', async () => {
    mockDb.rows.set('tenant:tenant-a:system.name', {
      key: 'tenant:tenant-a:system.name',
      value: tenantRecord
    });
    mockDb.rows.set('system.name', {
      key: 'system.name',
      value: 'legacy-raw-value'
    });
    mockDb.rows.set('system.name:legacy-copy', {
      key: 'system.name:legacy-copy',
      value: {
        ...tenantRecord,
        context: {}
      }
    });

    const repository = new ConfigurationRepository();
    const records = await repository.getAllRecords();

    expect(records).toEqual([tenantRecord]);
    expect(mockDb.rows.has('system.name')).toBe(true);
    expect(mockDb.rows.has('system.name:legacy-copy')).toBe(true);
  });

  it('rejects a DEVICE record whose embedded branch/user context does not match its storage key', async () => {
    const storedKey = 'device:tenant-a:branch-a:user-a:device-a:system.name';
    mockDb.rows.set(storedKey, {
      key: storedKey,
      value: {
        ...tenantRecord,
        scope: 'DEVICE',
        context: {
          tenantId: 'tenant-a',
          branchId: 'branch-b',
          userId: 'user-a',
          deviceId: 'device-a'
        }
      }
    });

    const repository = new ConfigurationRepository();
    await expect(repository.getRecord('system.name', 'DEVICE', {
      tenantId: 'tenant-a',
      branchId: 'branch-a',
      userId: 'user-a',
      deviceId: 'device-a'
    })).resolves.toBeNull();
  });

  it('writes only the tenant-scoped key and does not create a global canonical copy', async () => {
    const repository = new ConfigurationRepository();
    await repository.saveRecord(tenantRecord);

    expect(mockDb.settings.put).toHaveBeenCalledTimes(1);
    expect(mockDb.rows.has('tenant:tenant-a:system.name')).toBe(true);
    expect(mockDb.rows.has('system.name')).toBe(false);
  });

  it('deletes only the selected scoped record and leaves legacy values untouched', async () => {
    mockDb.rows.set('tenant:tenant-a:system.name', {
      key: 'tenant:tenant-a:system.name',
      value: tenantRecord
    });
    mockDb.rows.set('system.name', {
      key: 'system.name',
      value: 'legacy-raw-value'
    });

    const repository = new ConfigurationRepository();
    await repository.deleteRecord('system.name', 'TENANT', { tenantId: 'tenant-a' });

    expect(mockDb.rows.has('tenant:tenant-a:system.name')).toBe(false);
    expect(mockDb.rows.has('system.name')).toBe(true);
  });
});
