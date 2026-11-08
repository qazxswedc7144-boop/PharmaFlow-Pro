import { describe, expect, it, vi } from 'vitest';
import { restoreSalesDraftItems } from './salesDraftRecovery.service';
import { LocalSalesPricingService } from './localSalesPricing.service';

describe('Sales draft recovery safety', () => {
  const currentPolicy = {
    tenantId: 'TENANT-DRAFT-001',
    maxDiscountPercent: '10',
    taxRatePercent: '15',
    taxMode: 'EXCLUSIVE' as const,
    updatedAt: '2026-11-08T00:00:00.000Z'
  };

  it('ignores legacy 20% adjustment and recalculates from current catalog price and policy', async () => {
    const getProduct = vi.fn().mockResolvedValue({
      id: 'PRODUCT-DRAFT-001',
      price: '100.00'
    });
    const legacyDraft = {
      items: [{
        id: 'LINE-001',
        product_id: 'PRODUCT-DRAFT-001',
        qty: 1,
        price: 80,
        sum: 80
      }],
      adjData: { discountPercent: 20, otherFees: 7, tax: 3 },
      totals: { discountPercent: 20, discountAmount: 20, total: 70 }
    };

    const restoredItems = await restoreSalesDraftItems(legacyDraft, getProduct);
    const pricing = LocalSalesPricingService.calculate(
      restoredItems.map(item => ({ price: String(item.price), qty: Number(item.qty) })),
      currentPolicy,
      0
    );

    expect(getProduct).toHaveBeenCalledWith('PRODUCT-DRAFT-001');
    expect(restoredItems[0]).toMatchObject({
      product_id: 'PRODUCT-DRAFT-001',
      price: 100,
      unitPrice: 100,
      qty: 1,
      sum: 100
    });
    expect(pricing.discountPercent).toBe('0');
    expect(pricing.discountAmount).toBe('0');
    expect(pricing.taxRatePercent).toBe('15');
    expect(pricing.taxAmount).toBe('15');
    expect(pricing.totalAmount).toBe('115');
    expect(currentPolicy.maxDiscountPercent).toBe('10');
  });

  it('rejects a legacy draft with a missing product reference or missing catalog price', async () => {
    await expect(
      restoreSalesDraftItems({
        items: [{ id: 'LINE-NO-ID', qty: 1, price: 100 }]
      }, vi.fn())
    ).rejects.toThrow('DRAFT_ITEM_PRODUCT_REFERENCE_MISSING');

    await expect(
      restoreSalesDraftItems({
        items: [{ id: 'LINE-NO-PRICE', product_id: 'PRODUCT-NO-PRICE', qty: 1, price: 100 }]
      }, vi.fn().mockResolvedValue({ id: 'PRODUCT-NO-PRICE' }))
    ).rejects.toThrow('DRAFT_ITEM_PRODUCT_PRICE_UNAVAILABLE');
  });
});
