import { afterAll, describe, expect, it } from 'vitest';
import { PharmaFlowDB } from './core/db';

describe('Tenant-scoped Dexie indexes', () => {
  const databaseName = 'PharmaFlowTenantIndexSchemaTest';
  const database = new PharmaFlowDB(databaseName);

  afterAll(async () => {
    database.close();
    await database.delete();
  });

  const indexNames = (tableName: string): string[] =>
    database.table(tableName).schema.indexes.map(index => index.name);

  it('indexes staff and permission records by tenant ownership', () => {
    expect(indexNames('users')).toContain('tenantId');
    expect(indexNames('userPermissions')).toContain('tenantId');
    expect(indexNames('userPermissions')).toContain('[tenantId+userId]');
  });

  it('indexes cashboxes and cash movements by tenant ownership', () => {
    expect(indexNames('cashboxes')).toContain('tenantId');
    expect(indexNames('cashFlow')).toContain('[tenantId+cashboxId]');
    expect(indexNames('cashFlow')).toContain('[tenantId+userId]');
  });
});
