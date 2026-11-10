import { describe, expect, it } from 'vitest';
import { collectPendingProductsForInvoice } from './pendingProducts';

describe('pending products retry handling', () => {
  it('retains pending products after a failed attempt and collects newly added manual items on retry', () => {
    const firstAttempt = collectPendingProductsForInvoice(
      [{
        id: 'line-1',
        productId: 'manual-first',
        product_id: 'manual-first',
        name: 'First manual item',
        price: 10,
        category: 'General'
      }],
      []
    );

    expect(firstAttempt.pendingProducts).toHaveLength(1);
    expect(firstAttempt.items[0].productId).toBe(firstAttempt.pendingProducts[0].id);

    // Simulate a failed save: the caller retains the pending list and current invoice items.
    const retryAttempt = collectPendingProductsForInvoice(
      [
        ...firstAttempt.items,
        {
          id: 'line-2',
          productId: 'manual-second',
          product_id: 'manual-second',
          name: 'Second manual item',
          price: 20,
          category: 'General'
        }
      ],
      firstAttempt.pendingProducts
    );

    expect(retryAttempt.pendingProducts).toHaveLength(2);
    expect(retryAttempt.items).toHaveLength(2);
    expect(retryAttempt.items[0].productId).toBe(firstAttempt.pendingProducts[0].id);
    expect(retryAttempt.items[1].productId).toBe(retryAttempt.pendingProducts[1].id);
    expect(retryAttempt.pendingProducts.map(product => product.name)).toEqual([
      'First manual item',
      'Second manual item'
    ]);
  });
});
