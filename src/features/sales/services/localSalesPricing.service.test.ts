import { describe, expect, it } from 'vitest';
import { LocalSalesPricingService } from './localSalesPricing.service';

const basePolicy = {
  tenantId: 'TENANT-PRICING-UNIT',
  maxDiscountPercent: '10',
  taxRatePercent: '15',
  updatedAt: '2026-11-08T00:00:00.000Z'
};

describe('LocalSalesPricingService', () => {
  it('extracts tax from an inclusive total without increasing the payable amount', () => {
    const result = LocalSalesPricingService.calculate(
      [{ price: '115', qty: 1 }],
      { ...basePolicy, taxMode: 'INCLUSIVE' }
    );

    expect(result.totalAmount).toBe('115');
    expect(result.revenueAmount).toBe('100');
    expect(result.taxAmount).toBe('15');
  });

  it('adds exclusive tax on top of net revenue', () => {
    const result = LocalSalesPricingService.calculate(
      [{ price: '100', qty: 1 }],
      { ...basePolicy, taxMode: 'EXCLUSIVE' }
    );

    expect(result.revenueAmount).toBe('100');
    expect(result.taxAmount).toBe('15');
    expect(result.totalAmount).toBe('115');
  });

  it('rejects a discount greater than the tenant policy maximum', () => {
    expect(() => LocalSalesPricingService.calculate(
      [{ price: '100', qty: 1 }],
      { ...basePolicy, taxMode: 'NONE' },
      '10.01'
    )).toThrow('DISCOUNT_LIMIT_EXCEEDED');
  });
});
