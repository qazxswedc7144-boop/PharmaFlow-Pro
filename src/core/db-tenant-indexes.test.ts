import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenProvider } from '@/services/auth/tokenProvider';
import { PharmaFlowDB } from './db';

describe('Tenant-scoped Dexie indexes', () => {
  const databaseName = 'PharmaFlowTenantIndexSchemaTest';
  const database = new PharmaFlowDB(databaseName);

  afterAll(async () => {
    database.close();
    await database.delete();
  });

  const indexNames = (tableName: string): string[] =>
    database.table(tableName).schema.indexes.map(index => index.name);

  beforeAll(async () => {
    await database.open();
  });

  it('indexes staff and permission records by tenant ownership', () => {
    expect(indexNames('users')).toContain('tenantId');
    expect(indexNames('userPermissions')).toContain('tenantId');
    expect(indexNames('userPermissions')).toContain('[tenantId+userId]');
  });

  it('requires tenant-admin authorization for staff mutations and blocks cross-tenant changes', async () => {
    TokenProvider.setSession({
      id: 'admin-a',
      Role: 'Admin',
      tenant_id: 'tenant-a'
    } as any, 'token-a');

    await database.users.add({ id: 'staff-a', username: 'staff-a' });
    await database.userPermissions.add({
      id: 'permissions-a',
      userId: 'staff-a',
      permissions: {}
    });

    TokenProvider.setSession({
      id: 'cashier-a',
      Role: 'CASHIER',
      tenant_id: 'tenant-a'
    } as any, 'cashier-token');

    await expect(database.users.add({ id: 'staff-denied', username: 'denied' }))
      .rejects.toThrow(/Tenant administrator authorization required/);
    await expect(database.userPermissions.update('permissions-a', { permissions: { Admin: true } }))
      .rejects.toThrow(/Tenant administrator authorization required/);
    await expect(database.users.bulkAdd([{ id: 'staff-bulk-denied', username: 'denied-bulk' }]))
      .rejects.toThrow(/Tenant administrator authorization required/);

    TokenProvider.setSession({
      id: 'admin-b',
      Role: 'Admin',
      tenant_id: 'tenant-b'
    } as any, 'token-b');

    await expect(database.users.update('staff-a', { name: 'Cross tenant' }))
      .rejects.toThrow(/Cross-tenant or Orphaned/);
    await expect(database.users.delete('staff-a'))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);
    await expect(database.userPermissions.delete('permissions-a'))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);
    await expect(database.users.bulkDelete(['staff-a']))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);
    await expect(database.userPermissions.bulkDelete(['permissions-a']))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);
  });

  it('blocks unscoped clear operations on staff and permission tables', async () => {
    await expect(database.users.clear()).rejects.toThrow(/Bulk clear is forbidden/);
    await expect(database.userPermissions.clear()).rejects.toThrow(/Bulk clear is forbidden/);
  });

  it('indexes cashboxes and cash movements by tenant ownership', () => {
    expect(indexNames('cashboxes')).toContain('tenantId');
    expect(indexNames('cashFlow')).toContain('[tenantId+cashboxId]');
    expect(indexNames('cashFlow')).toContain('[tenantId+userId]');
  });

  const seedOrphanRecord = async (tableName: 'cashboxes' | 'cashFlow', id: string) => {
    const nativeDb = (database as any).idbdb;
    if (!nativeDb) throw new Error('Expected the native IndexedDB connection to be open.');
    await new Promise<void>((resolve, reject) => {
      const transaction = nativeDb.transaction(tableName, 'readwrite');
      transaction.objectStore(tableName).put({ id, legacy: true });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Failed to seed legacy record.'));
      transaction.onabort = () => reject(transaction.error || new Error('Legacy record seed transaction aborted.'));
    });
  };

  it('blocks cross-tenant, orphaned, unauthenticated, and bulk cash deletions while allowing own-tenant deletion', async () => {
    TokenProvider.setSession({
      id: 'admin-a',
      Role: 'Admin',
      tenant_id: 'tenant-a'
    } as any, 'token-a');

    await database.cashboxes.add({ id: 'cashbox-a', name: 'Tenant A cashbox' });
    await database.cashFlow.add({ id: 'cashflow-a', cashboxId: 'cashbox-a', amount: 10 });

    TokenProvider.setSession({
      id: 'admin-b',
      Role: 'Admin',
      tenant_id: 'tenant-b'
    } as any, 'token-b');

    await database.cashboxes.add({ id: 'cashbox-b', name: 'Tenant B cashbox' });
    await database.cashFlow.add({ id: 'cashflow-b', cashboxId: 'cashbox-b', amount: 20 });

    await seedOrphanRecord('cashboxes', 'cashbox-orphan');
    await seedOrphanRecord('cashFlow', 'cashflow-orphan');

    TokenProvider.setSession({
      id: 'admin-a',
      Role: 'Admin',
      tenant_id: 'tenant-a'
    } as any, 'token-a');

    await expect(database.cashboxes.delete('cashbox-b'))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);
    await expect(database.cashFlow.delete('cashflow-b'))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);
    await expect(database.cashboxes.bulkDelete(['cashbox-b']))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);
    await expect(database.cashFlow.bulkDelete(['cashflow-b']))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);
    await expect(database.cashboxes.delete('cashbox-orphan'))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);
    await expect(database.cashFlow.delete('cashflow-orphan'))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);

    TokenProvider.clearSession();
    await expect(database.cashboxes.delete('cashbox-a'))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);
    await expect(database.cashFlow.delete('cashflow-a'))
      .rejects.toThrow(/Cross-tenant or orphaned delete/);

    TokenProvider.setSession({
      id: 'admin-a',
      Role: 'Admin',
      tenant_id: 'tenant-a'
    } as any, 'token-a');

    await expect(database.cashboxes.delete('cashbox-a')).resolves.toBeUndefined();
    await expect(database.cashFlow.delete('cashflow-a')).resolves.toBeUndefined();

    expect(await database.cashboxes.get('cashbox-b')).toBeDefined();
    expect(await database.cashFlow.get('cashflow-b')).toBeDefined();
    expect(await database.cashboxes.get('cashbox-orphan')).toBeDefined();
    expect(await database.cashFlow.get('cashflow-orphan')).toBeDefined();
  });

  it('blocks unscoped clear operations on cashboxes and cashFlow', async () => {
    await expect(database.cashboxes.clear()).rejects.toThrow(/Bulk clear is forbidden/);
    await expect(database.cashFlow.clear()).rejects.toThrow(/Bulk clear is forbidden/);
  });
});
