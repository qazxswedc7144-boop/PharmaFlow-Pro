import { describe, expect, it } from 'vitest';
import { getProjectedAutocompleteStock } from './projectedAutocompleteStock';

describe('purchase and sales autocomplete stock projection', () => {
  const product = { id: 'product-a', stock: 10, StockQuantity: 10 };
  const invoiceItems = [
    { productId: 'product-a', qty: 2 },
    { product_id: 'product-a', quantity: 3 },
    { productId: 'product-b', qty: 50 }
  ];

  it('adds unsaved purchase quantities to the current stock without mutating the product', () => {
    expect(getProjectedAutocompleteStock(product, 'purchase', invoiceItems)).toBe(15);
    expect(product.StockQuantity).toBe(10);
    expect(product.stock).toBe(10);
  });

  it('subtracts unsaved sales quantities from the current stock', () => {
    expect(getProjectedAutocompleteStock(product, 'sale', invoiceItems)).toBe(5);
  });

  it('returns the live stock when the product is not in the current invoice', () => {
    expect(getProjectedAutocompleteStock({ id: 'product-c', stock: 7 }, 'purchase', invoiceItems)).toBe(7);
  });

  it('supports legacy product and invoice quantity field names', () => {
    expect(getProjectedAutocompleteStock(
      { id: 'product-a', StockQuantity: 4 },
      'purchase',
      [{ product_id: 'product-a', qty: 3 }]
    )).toBe(7);
  });
});
