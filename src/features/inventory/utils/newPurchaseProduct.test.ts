import { describe, expect, it } from 'vitest';
import { createNewPurchaseProductRecord } from './newPurchaseProduct';

describe('new purchase product draft', () => {
  it('starts with zero master stock because draft quantities are posted only by the purchase workflow', () => {
    const product = createNewPurchaseProductRecord({
      id: 'PROD-NEW-1',
      name: 'Test medicine',
      price: 12,
      category: 'Medicines',
      createdAt: '2026-11-10T00:00:00.000Z'
    });

    expect(product.StockQuantity).toBe(0);
    expect(product.stock).toBe(0);
    expect(product.price).toBe(12);
    expect(product.id).toBe('PROD-NEW-1');
  });
});
