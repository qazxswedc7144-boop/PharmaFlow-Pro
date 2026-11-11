import { describe, expect, it } from 'vitest';
import { getProductApplicationPermission } from './productApplicationPermission';

describe('getProductApplicationPermission', () => {
  it('requires product management permission for a new product', () => {
    expect(getProductApplicationPermission(true)).toBe('inventory.product.create');
  });

  it('requires product edit permission for an existing product', () => {
    expect(getProductApplicationPermission(false)).toBe('inventory.product.update');
  });

  it('defaults to creation permission when the operation type is omitted', () => {
    expect(getProductApplicationPermission()).toBe('inventory.product.create');
  });
});
