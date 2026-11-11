import { describe, expect, it } from 'vitest';
import { getSellableLayerQuantity } from './saleStockAvailability';

describe('sale inventory-layer availability', () => {
  it('uses quantity_remaining from FIFO layers rather than product master stock', () => {
    expect(getSellableLayerQuantity([
      { item_id: 'p-1', quantity_remaining: 4 },
      { item_id: 'p-1', quantity_remaining: 6 }
    ])).toBe(10);
  });

  it('supports legacy remaining quantity aliases', () => {
    expect(getSellableLayerQuantity([
      { remaining_qty: 2 },
      { remainingQty: 3 },
      { quantity_remaining: 5 },
      { quantityRemaining: 7 }
    ])).toBe(17);
  });

  it('excludes expired layers from sale availability', () => {
    expect(getSellableLayerQuantity([
      { quantity_remaining: 8, expiry_date: '2000-01-01' },
      { quantity_remaining: 3, expiry_date: '2099-12-31' }
    ])).toBe(3);
  });

  it('returns zero when no valid positive layer exists', () => {
    expect(getSellableLayerQuantity([
      { quantity_remaining: 0, expiry_date: '2099-12-31' },
      { quantity_remaining: 9, expiry_date: '2000-01-01' }
    ])).toBe(0);
    expect(getSellableLayerQuantity([])).toBe(0);
  });

  it('ignores non-finite and negative quantities', () => {
    expect(getSellableLayerQuantity([
      { quantity_remaining: -3 },
      { quantity_remaining: Number.NaN },
      { quantity_remaining: 2 }
    ])).toBe(2);
  });
});
