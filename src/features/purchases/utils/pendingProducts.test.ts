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
    const firstPendingProduct = firstAttempt.pendingProducts[0]!;
    const firstFinalizedItem = firstAttempt.items[0]!;
    expect(firstFinalizedItem.productId).toBe(firstPendingProduct.id);

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
    const retainedPendingProduct = retryAttempt.pendingProducts[0]!;
    const newlyCollectedPendingProduct = retryAttempt.pendingProducts[1]!;
    const retainedItem = retryAttempt.items[0]!;
    const newlyAddedItem = retryAttempt.items[1]!;
    expect(retainedItem.productId).toBe(retainedPendingProduct.id);
    expect(newlyAddedItem.productId).toBe(newlyCollectedPendingProduct.id);
    expect(retryAttempt.pendingProducts.map(product => product.name)).toEqual([
      'First manual item',
      'Second manual item'
    ]);
  });
  it('keeps recovered pending products available to the autocomplete before posting', async () => {
    const { mergePendingProductSuggestions } = await import('./pendingProducts');
    const persisted = [
      { id: 'PROD-2', Name: 'Panadol Advance', name: 'Panadol Advance' }
    ];
    const recoveredPending = [
      { id: 'PROD-1', Name: 'Panadol Extra', name: 'Panadol Extra' }
    ];

    expect(mergePendingProductSuggestions(persisted, recoveredPending, 'Panadol'))
      .toEqual([recoveredPending[0], persisted[0]]);
  });

});
