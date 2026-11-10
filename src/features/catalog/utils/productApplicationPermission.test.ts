import { describe, expect, it } from 'vitest';
import { getProductApplicationPermission } from './productApplicationPermission';

describe('getProductApplicationPermission', () => {
  it('requires product management permission for a new product', () => {
    expect(getProductApplicationPermission(true)).toBe('products.manage');
  });

  it('requires product edit permission for an existing product', () => {
    expect(getProductApplicationPermission(false)).toBe('products.edit');
  });

  it('defaults to creation permission when the operation type is omitted', () => {
    expect(getProductApplicationPermission()).toBe('products.manage');
  });
});
