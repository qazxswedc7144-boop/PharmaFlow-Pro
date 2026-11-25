import { afterEach, describe, expect, it } from 'vitest';
import { PharmaFlowDB } from './db';

describe('Production cleanup inventoryTransactions Dexie schema', () => {
  let testDb: PharmaFlowDB | undefined;

  afterEach(async () => {
    if (!testDb) return;
    testDb.close();
    await testDb.delete();
    testDb = undefined;
  });

  it('keeps all fields used by the Dry Run indexed and queryable in the real schema', async () => {
    testDb = new PharmaFlowDB(`pharmaflow-cleanup-schema-${Math.random().toString(36).slice(2)}`);
    await testDb.open();

    const table = testDb.inventoryTransactions;
    const indexedFields = new Set(
      table.schema.indexes.map(index => String(index.keyPath))
    );

    expect(indexedFields.has('source_doc_id')).toBe(true);
    expect(indexedFields.has('productId')).toBe(true);
    expect(indexedFields.has('product_id')).toBe(true);

    await table.bulkAdd([
      { id: 'movement-source', source_doc_id: 'sale-demo', tenantId: 'tenant-a' },
      { id: 'movement-camel', productId: 'product-camel', tenantId: 'tenant-a' },
      { id: 'movement-snake', product_id: 'product-snake', tenantId: 'tenant-a' },
      { id: 'movement-foreign', source_doc_id: 'sale-demo', tenantId: 'tenant-b' }
    ]);

    await expect(
      table.where('source_doc_id').anyOf(['sale-demo']).toArray()
    ).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'movement-source' }),
      expect.objectContaining({ id: 'movement-foreign' })
    ]));

    await expect(
      table.where('productId').anyOf(['product-camel']).toArray()
    ).resolves.toEqual([expect.objectContaining({ id: 'movement-camel' })]);

    await expect(
      table.where('product_id').anyOf(['product-snake']).toArray()
    ).resolves.toEqual([expect.objectContaining({ id: 'movement-snake' })]);
  });
});
