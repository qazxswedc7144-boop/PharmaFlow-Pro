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

  it('caps FIFO stock to non-expired tenant batch quantity', () => {
    expect(getSellableLayerQuantity(
      [{ item_id: 'p-1', quantity_remaining: 10 }],
      [
        { quantity: 7, expiryDate: '2000-01-01' },
        { quantity: 3, expiryDate: '2099-12-31' }
      ],
      true
    )).toBe(3);
  });

  it('fails closed when batch records exist but none belong to the active tenant', () => {
    expect(getSellableLayerQuantity(
      [{ item_id: 'p-1', quantity_remaining: 10 }],
      [],
      true
    )).toBe(0);
  });

  it('uses FIFO layers for non-batched products when no batch records exist', () => {
    expect(getSellableLayerQuantity(
      [{ item_id: 'p-1', quantity_remaining: 6 }],
      [],
      false
    )).toBe(6);
  });

  it('rejects expired product-level stock when no batch records exist', () => {
    expect(getSellableLayerQuantity(
      [{ item_id: 'p-1', quantity_remaining: 5 }],
      [],
      false,
      '2000-01-01'
    )).toBe(0);
  });

  it('ignores non-finite and negative quantities', () => {
    expect(getSellableLayerQuantity([
      { quantity_remaining: -3 },
      { quantity_remaining: Number.NaN },
      { quantity_remaining: 2 }
    ])).toBe(2);
  });
});
