import { afterEach, describe, expect, it } from 'vitest';
import type { InventoryTransaction } from '@/types';
import { PharmaFlowDB } from './db';

// The Dexie schema intentionally retains legacy snake_case indexes that are
// not part of the canonical InventoryTransaction domain type.
type IndexedInventoryTransaction = InventoryTransaction & {
  source_doc_id?: string;
  product_id?: string;
};

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

    const movement = (
      id: string,
      productId: string,
      tenantId: string,
      sourceDocId?: string,
      legacyProductId?: string
    ): IndexedInventoryTransaction => ({
      id,
      TransactionID: id,
      productId,
      warehouseId: 'warehouse-test',
      SourceDocumentType: 'SALE',
      SourceDocumentID: sourceDocId ?? '',
      QuantityChange: 1,
      before_qty: 0,
      after_qty: 1,
      TransactionType: 'SALE',
      TransactionDate: '2026-11-25T00:00:00.000Z',
      UserID: 'user-test',
      tenantId,
      ...(sourceDocId ? { source_doc_id: sourceDocId } : {}),
      ...(legacyProductId ? { product_id: legacyProductId } : {})
    });

    await table.bulkAdd([
      movement('movement-source', 'product-source', 'tenant-a', 'sale-demo'),
      movement('movement-camel', 'product-camel', 'tenant-a'),
      movement('movement-snake', 'product-snake-base', 'tenant-a', undefined, 'product-snake'),
      movement('movement-foreign', 'product-foreign', 'tenant-b', 'sale-demo')
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
